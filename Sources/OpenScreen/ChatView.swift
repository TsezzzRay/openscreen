import AppKit
import SwiftUI

struct ChatTurn: Identifiable {
    let id: UUID
    let question: String
    var reasoning: String
    var answer: String

    init(id: UUID = UUID(), question: String, reasoning: String, answer: String) {
        self.id = id
        self.question = question
        self.reasoning = reasoning
        self.answer = answer
    }
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var draft = ""
    @Published private(set) var turns: [ChatTurn] = []
    @Published private(set) var sessions: [ChatSessionSummary] = []
    @Published private(set) var currentSessionID: UUID?
    @Published private(set) var currentTitle = "New Chat"
    @Published private(set) var isSending = false
    @Published private(set) var isManagingSession = false
    @Published private(set) var sessionError: String?
    @Published private(set) var focusRequest = 0

    private let agentClient: AgentClient
    private let windowCapture: WindowCapture
    private let defaults: UserDefaults
    private static let selectedSessionKey = "OpenScreenSelectedSessionID"

    var isBusy: Bool { isSending || isManagingSession }

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
        turns.append(ChatTurn(question: question, reasoning: "", answer: ""))
        return turns.index(before: turns.endIndex)
    }

    func apply(_ session: ChatSessionSnapshot) {
        currentSessionID = session.id
        currentTitle = session.title
        turns = session.turns.map {
            ChatTurn(
                id: $0.id,
                question: $0.user,
                reasoning: $0.reasoning ?? "",
                answer: $0.assistant
            )
        }
        defaults.set(session.id.uuidString, forKey: Self.selectedSessionKey)
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
        guard !isBusy else { return }
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
            sessionError = error.localizedDescription
        }
    }

    func selectSession(_ id: UUID) {
        guard !isBusy, id != currentSessionID else { return }
        manageSession {
            self.apply(try await self.agentClient.loadSession(id: id))
        }
    }

    func createNewSession() {
        guard !isBusy else { return }
        manageSession {
            self.apply(try await self.agentClient.createSession())
        }
    }

    func renameSession(id: UUID, title: String) {
        guard !isBusy else { return }
        manageSession {
            let session = try await self.agentClient.renameSession(id: id, title: title)
            if id == self.currentSessionID { self.apply(session) }
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
                sessionError = error.localizedDescription
            }
        }
    }

    func finishTurn(at index: Int, answer: String) {
        guard turns.indices.contains(index) else { return }
        turns[index].answer = answer
    }

    func apply(_ event: AgentEvent, at index: Int) {
        guard turns.indices.contains(index), let delta = event.delta else { return }
        switch event.type {
        case .reasoningDelta:
            turns[index].reasoning += delta
        case .answerDelta:
            turns[index].answer += delta
        case .started, .sessions, .session, .completed, .failed:
            break
        }
    }

    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isBusy, let sessionID = currentSessionID else { return }

        let turnIndex = startTurn(question: text)
        draft = ""
        isSending = true

        Task {
            do {
                let imageURL = try await windowCapture.captureActiveWindow()
                let events = try await agentClient.send(
                    sessionID: sessionID,
                    text: text,
                    imageURL: imageURL
                )
                for try await event in events {
                    apply(event, at: turnIndex)
                }
                apply(try await agentClient.loadSession(id: sessionID))
                sessions = try await agentClient.listSessions()
            } catch {
                finishTurn(at: turnIndex, answer: "Unable to answer: \(error.localizedDescription)")
            }
            isSending = false
            requestInputFocus()
        }
    }
}

struct ChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var showsHistory = false
    @State private var renamedSessionID: UUID?
    @State private var renameTitle = ""

    var body: some View {
        VStack(spacing: 18) {
            HStack(spacing: 10) {
                Button {
                    showsHistory.toggle()
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isBusy)
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
                .disabled(viewModel.isBusy || viewModel.currentSessionID == nil)
                .accessibilityLabel("Rename current chat")

                Button(action: viewModel.createNewSession) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isBusy)
                .accessibilityLabel("New chat")
            }

            if let error = viewModel.sessionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ScrollView {
                VStack(spacing: 16) {
                    ForEach(viewModel.turns) { turn in
                        HStack {
                            Spacer(minLength: 48)
                            Text(turn.question)
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
                                    Text(turn.reasoning)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 48)
                            }
                        }
                        if !turn.answer.isEmpty {
                            HStack {
                                Text(turn.answer)
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 12)
                                    .background(Color.black.opacity(0.38))
                                    .clipShape(RoundedRectangle(cornerRadius: 18))
                                Spacer(minLength: 48)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }

            HStack(spacing: 12) {
                ChatTextEditor(
                    text: $viewModel.draft,
                    focusRequest: viewModel.focusRequest,
                    isEnabled: !viewModel.isBusy,
                    onSubmit: viewModel.submit
                )
                .frame(height: 54)

                Button(action: viewModel.submit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 42, height: 42)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 13))
                .disabled(viewModel.isBusy || viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
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
