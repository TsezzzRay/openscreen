import AppKit
import SwiftUI

struct ChatTurn: Identifiable {
    let id: UUID
    let question: String
    var reasoning: String
    var answer: String
    var status: ChatTurnStatus
    var error: String?

    init(
        id: UUID = UUID(),
        question: String,
        reasoning: String,
        answer: String,
        status: ChatTurnStatus = .completed,
        error: String? = nil
    ) {
        self.id = id
        self.question = question
        self.reasoning = reasoning
        self.answer = answer
        self.status = status
        self.error = error
    }
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var draft = ""
    @Published private(set) var turns: [ChatTurn] = []
    @Published private(set) var sessions: [ChatSessionSummary] = []
    @Published private(set) var currentSessionID: UUID?
    @Published private(set) var currentTitle = "New Chat"
    @Published private(set) var activeSessionIDs: Set<UUID> = []
    @Published private(set) var isManagingSession = false
    @Published private(set) var sessionError: String?
    @Published private(set) var focusRequest = 0

    private let agentClient: AgentClient
    private let windowCapture: WindowCapture
    private let defaults: UserDefaults
    private var turnCache: [UUID: [ChatTurn]] = [:]
    private var activeTurnIDs: [UUID: UUID] = [:]
    private var requestTasks: [UUID: Task<Void, Never>] = [:]
    private static let selectedSessionKey = "OpenScreenSelectedSessionID"

    var isSending: Bool {
        currentSessionID.map(activeSessionIDs.contains) ?? false
    }

    var isBusy: Bool { isManagingSession || isSending }

    init(
        agentClient: AgentClient,
        windowCapture: WindowCapture,
        defaults: UserDefaults = .standard
    ) {
        self.agentClient = agentClient
        self.windowCapture = windowCapture
        self.defaults = defaults
    }

    func requestInputFocus() {
        focusRequest += 1
    }

    func startTurn(question: String) -> Int {
        turns.append(ChatTurn(
            question: question,
            reasoning: "",
            answer: "",
            status: .capturing
        ))
        if let currentSessionID { turnCache[currentSessionID] = turns }
        return turns.index(before: turns.endIndex)
    }

    func startTurn(sessionID: UUID, id: UUID, question: String) {
        var sessionTurns = turnCache[sessionID] ?? []
        sessionTurns.append(ChatTurn(
            id: id,
            question: question,
            reasoning: "",
            answer: "",
            status: .capturing
        ))
        setTurns(sessionTurns, for: sessionID)
    }

    func apply(_ session: ChatSessionSnapshot) {
        cache(session)
        currentSessionID = session.id
        currentTitle = session.title
        turns = turnCache[session.id] ?? []
        defaults.set(session.id.uuidString, forKey: Self.selectedSessionKey)
    }

    private func cache(_ session: ChatSessionSnapshot) {
        let restoredTurns = session.turns.map {
            ChatTurn(
                id: $0.id,
                question: $0.user,
                reasoning: $0.reasoning ?? "",
                answer: $0.assistant,
                status: $0.status,
                error: $0.error
            )
        }
        turnCache[session.id] = restoredTurns
        if currentSessionID == session.id {
            currentTitle = session.title
            turns = restoredTurns
        }
    }

    func cachedTurns(for sessionID: UUID) -> [ChatTurn] {
        turnCache[sessionID] ?? []
    }

    private func setTurns(_ sessionTurns: [ChatTurn], for sessionID: UUID) {
        turnCache[sessionID] = sessionTurns
        if currentSessionID == sessionID { turns = sessionTurns }
    }

    static func sessionToRestore(
        from sessions: [ChatSessionSummary],
        preferredID: UUID?
    ) -> UUID? {
        if let preferredID, sessions.contains(where: { $0.id == preferredID }) {
            return preferredID
        }
        return sessions.first?.id
    }

    func restoreSessions() async {
        guard !isManagingSession else { return }
        isManagingSession = true
        defer { isManagingSession = false }
        do {
            sessions = try await agentClient.listSessions()
            let preferredID = defaults.string(forKey: Self.selectedSessionKey).flatMap(UUID.init)
            if let id = Self.sessionToRestore(from: sessions, preferredID: preferredID) {
                apply(try await agentClient.loadSession(id: id))
            } else {
                apply(try await agentClient.createSession())
                sessions = try await agentClient.listSessions()
            }
            sessionError = nil
        } catch {
            sessionError = "Couldn't load chats. Please try again."
        }
    }

    func selectSession(_ id: UUID) {
        guard !isManagingSession, id != currentSessionID else { return }
        if activeSessionIDs.contains(id), let cached = turnCache[id] {
            currentSessionID = id
            currentTitle = sessions.first(where: { $0.id == id })?.title ?? "New Chat"
            turns = cached
            defaults.set(id.uuidString, forKey: Self.selectedSessionKey)
            return
        }
        manageSession {
            self.apply(try await self.agentClient.loadSession(id: id))
        }
    }

    func createNewSession() {
        guard !isManagingSession else { return }
        manageSession {
            self.apply(try await self.agentClient.createSession())
        }
    }

    func renameSession(id: UUID, title: String) {
        guard !isManagingSession, !activeSessionIDs.contains(id) else { return }
        manageSession {
            let session = try await self.agentClient.renameSession(id: id, title: title)
            if id == self.currentSessionID { self.apply(session) }
            else { self.cache(session) }
        }
    }

    private func manageSession(_ operation: @escaping @MainActor () async throws -> Void) {
        isManagingSession = true
        Task {
            defer { isManagingSession = false }
            do {
                try await operation()
                sessions = try await agentClient.listSessions()
                sessionError = nil
            } catch {
                sessionError = "Couldn't update chats. Please try again."
            }
        }
    }

    func finishTurn(at index: Int, answer: String) {
        guard turns.indices.contains(index) else { return }
        turns[index].answer = answer
        turns[index].status = .completed
        if let currentSessionID { turnCache[currentSessionID] = turns }
    }

    func apply(_ event: AgentEvent, at index: Int) {
        guard turns.indices.contains(index) else { return }
        switch event.type {
        case .reasoningDelta:
            turns[index].status = .generating
            turns[index].reasoning += event.delta ?? ""
        case .answerDelta:
            turns[index].status = .generating
            turns[index].answer += event.delta ?? ""
        case .completed:
            turns[index].status = .completed
        case .cancelled:
            turns[index].status = .cancelled
        case .started, .sessions, .session, .failed:
            break
        }
        if let currentSessionID { turnCache[currentSessionID] = turns }
    }

    func apply(_ event: AgentEvent, sessionID: UUID, turnID: UUID) {
        guard event.sessionId == nil || event.sessionId == sessionID else { return }
        var sessionTurns = turnCache[sessionID] ?? []
        guard let index = sessionTurns.firstIndex(where: { $0.id == turnID }) else { return }
        switch event.type {
        case .reasoningDelta:
            sessionTurns[index].status = .generating
            sessionTurns[index].reasoning += event.delta ?? ""
        case .answerDelta:
            sessionTurns[index].status = .generating
            sessionTurns[index].answer += event.delta ?? ""
        case .completed:
            sessionTurns[index].status = .completed
        case .cancelled:
            sessionTurns[index].status = .cancelled
        case .started, .sessions, .session, .failed:
            break
        }
        setTurns(sessionTurns, for: sessionID)
    }

    func markRequesting(sessionID: UUID, turnID: UUID) {
        updateTurn(sessionID: sessionID, turnID: turnID) { $0.status = .requesting }
    }

    func retry(turnID: UUID) {
        guard let turn = turns.first(where: { $0.id == turnID }),
              turn.status == .failed || turn.status == .cancelled else { return }
        draft = turn.question
        requestInputFocus()
    }

    private func updateTurn(
        sessionID: UUID,
        turnID: UUID,
        update: (inout ChatTurn) -> Void
    ) {
        var sessionTurns = turnCache[sessionID] ?? []
        guard let index = sessionTurns.firstIndex(where: { $0.id == turnID }) else { return }
        update(&sessionTurns[index])
        setTurns(sessionTurns, for: sessionID)
    }

    private func failTurn(sessionID: UUID, turnID: UUID, message: String) {
        var sessionTurns = turnCache[sessionID] ?? []
        guard let index = sessionTurns.firstIndex(where: { $0.id == turnID }) else { return }
        sessionTurns[index].status = .failed
        sessionTurns[index].error = message
        setTurns(sessionTurns, for: sessionID)
    }

    private func cancelTurn(sessionID: UUID, turnID: UUID) {
        updateTurn(sessionID: sessionID, turnID: turnID) {
            $0.status = .cancelled
            $0.error = nil
        }
    }

    func cancelCurrentRequest() {
        guard let sessionID = currentSessionID,
              let turnID = activeTurnIDs[sessionID],
              let turn = turnCache[sessionID]?.first(where: { $0.id == turnID }) else { return }
        if turn.status == .capturing {
            requestTasks[sessionID]?.cancel()
            return
        }
        Task {
            do {
                try await agentClient.cancel(requestID: turnID, sessionID: sessionID)
            } catch {
                sessionError = error.localizedDescription
            }
        }
    }

    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isManagingSession, !isSending,
              let sessionID = currentSessionID else { return }

        let turnID = UUID()
        startTurn(sessionID: sessionID, id: turnID, question: text)
        draft = ""
        activeSessionIDs.insert(sessionID)
        activeTurnIDs[sessionID] = turnID

        let task = Task {
            defer {
                if activeTurnIDs[sessionID] == turnID {
                    activeTurnIDs.removeValue(forKey: sessionID)
                    activeSessionIDs.remove(sessionID)
                    requestTasks.removeValue(forKey: sessionID)
                }
                if currentSessionID == sessionID { requestInputFocus() }
            }
            var sentToAgent = false
            do {
                let imageURL = try await windowCapture.captureActiveWindow()
                try Task.checkCancellation()
                let events = try await agentClient.send(
                    requestID: turnID,
                    sessionID: sessionID,
                    text: text,
                    imageURL: imageURL
                )
                sentToAgent = true
                markRequesting(sessionID: sessionID, turnID: turnID)
                try Task.checkCancellation()
                for try await event in events {
                    apply(event, sessionID: sessionID, turnID: turnID)
                }
                cache(try await agentClient.loadSession(id: sessionID))
                sessions = try await agentClient.listSessions()
            } catch is CancellationError {
                if sentToAgent {
                    let cancel = Task {
                        try await agentClient.cancel(requestID: turnID, sessionID: sessionID)
                    }
                    try? await cancel.value
                } else {
                    await recordLocalAttempt(
                        sessionID: sessionID,
                        turnID: turnID,
                        text: text,
                        status: .cancelled
                    )
                }
                cancelTurn(sessionID: sessionID, turnID: turnID)
            } catch {
                if !sentToAgent {
                    await recordLocalAttempt(
                        sessionID: sessionID,
                        turnID: turnID,
                        text: text,
                        status: .failed
                    )
                }
                failTurn(
                    sessionID: sessionID,
                    turnID: turnID,
                    message: sentToAgent
                        ? error.localizedDescription
                        : "Couldn't capture the active window. Check Screen Recording permission and retry."
                )
            }
        }
        requestTasks[sessionID] = task
    }

    private func recordLocalAttempt(
        sessionID: UUID,
        turnID: UUID,
        text: String,
        status: AgentRequest.AttemptStatus
    ) async {
        let record = Task {
            try await agentClient.recordAttempt(
                requestID: turnID,
                sessionID: sessionID,
                text: text,
                status: status
            )
            return try await agentClient.listSessions()
        }
        do {
            sessions = try await record.value
        } catch {
            sessionError = "Couldn't save the request. Please try again."
        }
    }
}

private extension ChatTurnStatus {
    var label: String {
        switch self {
        case .capturing: "Capturing screenshot…"
        case .requesting: "Requesting…"
        case .generating: "Generating…"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .interrupted: "Interrupted"
        }
    }
}

struct ChatScrollTrigger: Equatable {
    let sessionID: UUID?
    let turnID: UUID?
    let turnCount: Int
    let reasoningLength: Int
    let answerLength: Int
    let status: ChatTurnStatus?
    let turnError: String?
    let sessionError: String?
}

enum ChatScrollPosition {
    static func isAtBottom(
        contentHeight: CGFloat,
        visibleMaxY: CGFloat,
        threshold: CGFloat = 24
    ) -> Bool {
        contentHeight - visibleMaxY <= threshold
    }

    static func followsLatest(
        current: Bool,
        oldPhase: ScrollPhase,
        newPhase: ScrollPhase,
        contentHeight: CGFloat,
        visibleMaxY: CGFloat
    ) -> Bool {
        switch newPhase {
        case .tracking, .interacting:
            false
        case .idle where oldPhase != .animating:
            isAtBottom(contentHeight: contentHeight, visibleMaxY: visibleMaxY)
        default:
            current
        }
    }
}

struct ChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var showsHistory = false
    @State private var renamedSessionID: UUID?
    @State private var renameTitle = ""
    @State private var followsLatest = true

    private static let bottomID = "chat-bottom"

    private var scrollTrigger: ChatScrollTrigger {
        let turn = viewModel.turns.last
        return ChatScrollTrigger(
            sessionID: viewModel.currentSessionID,
            turnID: turn?.id,
            turnCount: viewModel.turns.count,
            reasoningLength: turn?.reasoning.utf8.count ?? 0,
            answerLength: turn?.answer.utf8.count ?? 0,
            status: turn?.status,
            turnError: turn?.error,
            sessionError: viewModel.sessionError
        )
    }

    var body: some View {
        VStack(spacing: 18) {
            HStack(spacing: 10) {
                Button {
                    showsHistory.toggle()
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession)
                .accessibilityLabel("Chat history")
                .popover(isPresented: $showsHistory) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Chats")
                            .font(.headline)
                            .padding(.horizontal, 8)
                        ForEach(viewModel.sessions) { session in
                            HStack(spacing: 8) {
                                Button {
                                    viewModel.selectSession(session.id)
                                    showsHistory = false
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(session.title)
                                            .lineLimit(1)
                                        Text(
                                            String(session.updatedAt.prefix(16))
                                                .replacingOccurrences(of: "T", with: " ")
                                        )
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                Button {
                                    renamedSessionID = session.id
                                    renameTitle = session.title
                                    showsHistory = false
                                } label: {
                                    Image(systemName: "pencil")
                                }
                                .buttonStyle(.plain)
                                .disabled(
                                    viewModel.isManagingSession ||
                                    viewModel.activeSessionIDs.contains(session.id)
                                )
                                .accessibilityLabel("Rename \(session.title)")
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                        }
                    }
                    .padding(10)
                    .frame(width: 280)
                }

                Text(viewModel.currentTitle)
                    .font(.headline)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    if let id = viewModel.currentSessionID {
                        renamedSessionID = id
                        renameTitle = viewModel.currentTitle
                    }
                } label: {
                    Image(systemName: "pencil")
                }
                .buttonStyle(.plain)
                .disabled(
                    viewModel.isManagingSession || viewModel.isSending ||
                    viewModel.currentSessionID == nil
                )
                .accessibilityLabel("Rename current chat")

                Button(action: viewModel.createNewSession) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession)
                .accessibilityLabel("New chat")
            }

            if let error = viewModel.sessionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(viewModel.turns) { turn in
                                HStack {
                                    Spacer(minLength: 48)
                                    MarkdownMessageView(turn.question)
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 12)
                                        .background(Color.accentColor.opacity(0.85))
                                        .clipShape(RoundedRectangle(cornerRadius: 18))
                                }
                                if !turn.reasoning.isEmpty {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text("Reasoning summary")
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                            MarkdownMessageView(turn.reasoning)
                                                .font(.callout)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer(minLength: 48)
                                    }
                                }
                                if !turn.answer.isEmpty {
                                    HStack {
                                        MarkdownMessageView(turn.answer)
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 16)
                                            .padding(.vertical, 12)
                                            .background(Color.black.opacity(0.38))
                                            .clipShape(RoundedRectangle(cornerRadius: 18))
                                        Spacer(minLength: 48)
                                    }
                                }
                                turnStatus(turn)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(Self.bottomID)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .onScrollPhaseChange { oldPhase, newPhase, context in
                        followsLatest = ChatScrollPosition.followsLatest(
                            current: followsLatest,
                            oldPhase: oldPhase,
                            newPhase: newPhase,
                            contentHeight: context.geometry.contentSize.height,
                            visibleMaxY: context.geometry.visibleRect.maxY
                        )
                    }
                    .onScrollGeometryChange(for: CGFloat.self) { geometry in
                        geometry.contentSize.height
                    } action: { _, _ in
                        if followsLatest {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                    }

                    if !followsLatest {
                        Button {
                            followsLatest = true
                            withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                        }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("Jump to latest message")
                        .padding(8)
                    }
                }
                .onChange(of: scrollTrigger) { oldValue, newValue in
                    let startsNewContext = oldValue.sessionID != newValue.sessionID ||
                        oldValue.turnID != newValue.turnID ||
                        oldValue.turnCount != newValue.turnCount
                    if startsNewContext { followsLatest = true }
                    if followsLatest || startsNewContext {
                        proxy.scrollTo(Self.bottomID, anchor: .bottom)
                    }
                }
            }

            HStack(spacing: 12) {
                ChatTextEditor(
                    text: $viewModel.draft,
                    focusRequest: viewModel.focusRequest,
                    isEnabled: !viewModel.isManagingSession && !viewModel.isSending,
                    onSubmit: viewModel.submit
                )
                .frame(height: 54)

                requestButton
            }
            .padding(10)
            .background(Color.black.opacity(0.28))
            .clipShape(RoundedRectangle(cornerRadius: 20))
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.70))
        .clipShape(RoundedRectangle(cornerRadius: 28))
        .alert(
            "Rename Chat",
            isPresented: Binding(
                get: { renamedSessionID != nil },
                set: { if !$0 { renamedSessionID = nil } }
            )
        ) {
            TextField("Name", text: $renameTitle)
            Button("Cancel", role: .cancel) { renamedSessionID = nil }
            Button("Rename") {
                if let id = renamedSessionID {
                    viewModel.renameSession(id: id, title: renameTitle)
                }
                renamedSessionID = nil
            }
            .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func turnStatus(_ turn: ChatTurn) -> some View {
        HStack(spacing: 8) {
            Text(
                turn.status == .failed
                    ? "Failed: \(turn.error ?? "Request failed. Please retry.")"
                    : turn.status.label
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            Spacer()
            if turn.status == .failed || turn.status == .cancelled {
                Button("Retry") {
                    viewModel.retry(turnID: turn.id)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession || viewModel.isSending)
            }
        }
    }

    private var requestButton: some View {
        Button {
            if viewModel.isSending {
                viewModel.cancelCurrentRequest()
            } else {
                viewModel.submit()
            }
        } label: {
            Image(systemName: viewModel.isSending ? "xmark" : "arrow.up")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 42, height: 42)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 13))
        .disabled(
            viewModel.isManagingSession ||
            (!viewModel.isSending &&
                viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        )
        .accessibilityLabel(viewModel.isSending ? "Cancel request" : "Send")
    }
}

private struct ChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    let focusRequest: Int
    let isEnabled: Bool
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.onSubmit = onSubmit
        textView.isRichText = false
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: 16)
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: 8, height: 9)
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? SubmitTextView else { return }
        context.coordinator.parent = self
        textView.onSubmit = onSubmit
        textView.isEditable = isEnabled
        if textView.string != text {
            textView.string = text
        }
        if context.coordinator.focusRequest != focusRequest {
            context.coordinator.focusRequest = focusRequest
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextEditor
        var focusRequest = -1

        init(parent: ChatTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

private final class SubmitTextView: NSTextView {
    var onSubmit: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36, !event.modifierFlags.contains(.shift) {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}
