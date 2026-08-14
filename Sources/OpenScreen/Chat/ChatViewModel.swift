import AppKit
import Foundation
import SwiftUI

@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var turns: [ChatTurn] = []
    @Published private(set) var sessions: [ProductSessionSummary] = []
    @Published private(set) var currentSessionID: String?
    @Published private(set) var currentTitle = "New Chat"
    @Published private(set) var activeSessionIDs: Set<String> = []
    @Published private(set) var thinking: ProductThinkingLevel = .off
    @Published private(set) var isManagingSession = false
    @Published private(set) var isUpdatingAgentState = false
    @Published private(set) var isCompacting = false
    @Published private(set) var compactionResult: ProductCompactionResult?
    @Published private(set) var compactionError: String?
    @Published private(set) var sessionError: String?
    @Published private(set) var focusRequest = 0
    @Published private var composerStates: [String: ComposerState] = [:]

    private let agentClient: any AgentProductClient
    private let attachmentStore: ChatAttachmentStore
    private let defaults: UserDefaults
    private var sessionViews: [String: ProductSessionView] = [:]
    private var turnCache: [String: [ChatTurn]] = [:]
    private var activeTurnIDs: [String: String] = [:]
    private var requestTasks: [String: Task<Void, Never>] = [:]
    private static let selectedSessionKey = "OpenScreenSelectedSessionID"

    private struct ComposerState {
        var draft = ""
        var pendingAttachments: [ChatImageAttachment] = []
        var attachmentError: String?
        var attachmentImportsInFlight = 0
    }

    var draft: String { currentComposerState.draft }
    var pendingAttachments: [ChatImageAttachment] { currentComposerState.pendingAttachments }
    var attachmentError: String? { currentComposerState.attachmentError }
    var isImportingAttachments: Bool { currentComposerState.attachmentImportsInFlight > 0 }
    var isSending: Bool { currentSessionID.map(activeSessionIDs.contains) ?? false }

    init(
        agentClient: any AgentProductClient,
        attachmentStore: ChatAttachmentStore = ChatAttachmentStore(),
        defaults: UserDefaults = .standard
    ) {
        self.agentClient = agentClient
        self.attachmentStore = attachmentStore
        self.defaults = defaults
    }

    func requestInputFocus() { focusRequest += 1 }

    func updateDraft(_ draft: String) {
        guard let sessionID = currentSessionID else { return }
        updateComposer(for: sessionID) { $0.draft = draft }
    }

    func startTurn(
        sessionID: String,
        id: String,
        question: String,
        attachments: [ChatImageAttachment] = [],
        historicalImageCount: Int = 0
    ) {
        var sessionTurns = turnCache[sessionID] ?? []
        sessionTurns.append(ChatTurn(
            id: id,
            question: question,
            attachments: attachments,
            historicalImageCount: historicalImageCount,
            reasoning: "",
            answer: "",
            status: .capturing
        ))
        setTurns(sessionTurns, for: sessionID)
    }

    func apply(_ view: ProductSessionView) {
        if currentSessionID != view.session.id { clearSessionTransientState() }
        cache(view)
        currentSessionID = view.session.id
        currentTitle = view.session.displayName
        turns = turnCache[view.session.id] ?? []
        apply(view.state)
        defaults.set(view.session.id, forKey: Self.selectedSessionKey)
    }

    private func cache(_ view: ProductSessionView) {
        let previous = turnCache[view.session.id] ?? []
        let restored = Self.projectTranscript(view.messages)
        let rebound = Self.restoreLocalAttachments(restored, from: previous)
        sessionViews[view.session.id] = view
        turnCache[view.session.id] = rebound
        if currentSessionID == view.session.id {
            currentTitle = view.session.displayName
            turns = rebound
            apply(view.state)
        }
    }

    static func projectTranscript(_ messages: [ProductTranscriptMessage]) -> [ChatTurn] {
        var result: [ChatTurn] = []
        for message in messages {
            switch message.role {
            case .user:
                result.append(ChatTurn(
                    id: message.id,
                    question: message.text,
                    historicalImageCount: message.imageCount ?? 0,
                    reasoning: "",
                    answer: ""
                ))
            case .assistant:
                if result.isEmpty {
                    result.append(ChatTurn(id: message.id, question: "", reasoning: "", answer: ""))
                }
                result[result.count - 1].reasoning += message.reasoning ?? ""
                result[result.count - 1].answer += message.text
                if message.isError == true {
                    result[result.count - 1].status = .failed
                    result[result.count - 1].error = "The previous Agent run did not complete."
                }
            case .tool:
                if result.isEmpty {
                    result.append(ChatTurn(id: message.id, question: "", reasoning: "", answer: ""))
                }
                result[result.count - 1].toolActivities.append(.init(
                    callID: message.id,
                    name: message.toolName ?? "tool",
                    text: message.text,
                    status: .finished,
                    isError: message.isError ?? false
                ))
            case .context:
                continue
            }
        }
        return result
    }

    static func restoreLocalAttachments(
        _ restored: [ChatTurn],
        from previous: [ChatTurn]
    ) -> [ChatTurn] {
        var result = restored
        var availablePrevious = previous.indices.filter { !previous[$0].attachments.isEmpty }
        for restoredIndex in result.indices.reversed() where result[restoredIndex].attachments.isEmpty {
            guard let availableIndex = availablePrevious.lastIndex(where: {
                previous[$0].question == result[restoredIndex].question
            }) else {
                continue
            }
            let local = previous[availablePrevious.remove(at: availableIndex)]
            let turn = result[restoredIndex]
            result[restoredIndex] = ChatTurn(
                id: turn.id,
                question: turn.question,
                attachments: local.attachments,
                historicalImageCount: turn.historicalImageCount,
                reasoning: turn.reasoning,
                answer: turn.answer,
                toolActivities: turn.toolActivities,
                contextUsage: turn.contextUsage,
                status: turn.status,
                error: turn.error
            )
        }
        return result
    }

    func cachedTurns(for sessionID: String) -> [ChatTurn] { turnCache[sessionID] ?? [] }
    func cachedSessionState(for sessionID: String) -> ProductSessionState? {
        sessionViews[sessionID]?.state
    }
    func cachedSessionTitle(for sessionID: String) -> String? {
        sessionViews[sessionID]?.session.displayName
    }
    func activeRequestID(for sessionID: String) -> String? { activeTurnIDs[sessionID] }

    private func setTurns(_ sessionTurns: [ChatTurn], for sessionID: String) {
        turnCache[sessionID] = sessionTurns
        if currentSessionID == sessionID { turns = sessionTurns }
    }

    static func sessionToRestore(
        from sessions: [ProductSessionSummary],
        preferredID: String?
    ) -> String? {
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
            if let id = Self.sessionToRestore(
                from: sessions,
                preferredID: defaults.string(forKey: Self.selectedSessionKey)
            ) {
                apply(try await agentClient.getSession(id: id))
            } else {
                apply(try await agentClient.createSession())
                sessions = try await agentClient.listSessions()
            }
            sessionError = nil
        } catch {
            sessionError = "Couldn't load chats. Please try again."
        }
    }

    func selectSession(_ id: String) {
        guard !isManagingSession, id != currentSessionID else { return }
        if activeSessionIDs.contains(id), let view = sessionViews[id] {
            clearSessionTransientState()
            currentSessionID = id
            currentTitle = view.session.displayName
            turns = turnCache[id] ?? []
            apply(view.state)
            defaults.set(id, forKey: Self.selectedSessionKey)
            return
        }
        manageSession { self.apply(try await self.agentClient.getSession(id: id)) }
    }

    private func clearSessionTransientState() {
        compactionResult = nil
        compactionError = nil
    }

    func createNewSession() {
        guard !isManagingSession else { return }
        manageSession { self.apply(try await self.agentClient.createSession()) }
    }

    func renameSession(id: String, title: String) {
        guard !isManagingSession, !activeSessionIDs.contains(id) else { return }
        manageSession {
            let summary = try await self.agentClient.renameSession(id: id, name: title)
            self.applyRenamedSession(summary)
            if id == self.currentSessionID { self.currentTitle = summary.displayName }
        }
    }

    func applyRenamedSession(_ summary: ProductSessionSummary) {
        if let index = sessions.firstIndex(where: { $0.id == summary.id }) {
            sessions[index] = summary
        } else {
            sessions.append(summary)
        }
        if let view = sessionViews[summary.id] {
            sessionViews[summary.id] = ProductSessionView(
                session: summary,
                messages: view.messages,
                state: view.state
            )
        }
        if currentSessionID == summary.id { currentTitle = summary.displayName }
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

    func apply(_ event: AgentEvent, sessionID: String, turnID: String) {
        guard event.sessionId == nil || event.sessionId == sessionID else { return }
        updateTurn(sessionID: sessionID, turnID: turnID) { turn in
            switch event.kind {
            case .runStarted:
                turn.status = .requesting
            case .reasoningDelta:
                turn.status = .generating
                turn.reasoning += event.delta ?? ""
            case .answerDelta:
                turn.status = .generating
                turn.answer += event.delta ?? ""
            case .answerCompleted:
                turn.status = .completed
                turn.answer = event.answer ?? turn.answer
                turn.contextUsage = event.contextUsage
            case .toolStarted, .toolUpdated, .toolFinished:
                guard let tool = event.tool else { return }
                if let index = turn.toolActivities.firstIndex(where: { $0.callID == tool.callId }) {
                    turn.toolActivities[index].text = tool.text ?? turn.toolActivities[index].text
                    turn.toolActivities[index].status = event.kind == .toolFinished ? .finished : .running
                    turn.toolActivities[index].isError = tool.isError ?? false
                } else {
                    turn.toolActivities.append(.init(
                        callID: tool.callId,
                        name: tool.name,
                        text: tool.text ?? "",
                        status: event.kind == .toolFinished ? .finished : .running,
                        isError: tool.isError ?? false
                    ))
                }
            case .compactionCompleted:
                if event.automatic == true, currentSessionID == sessionID {
                    compactionResult = event.compaction
                }
            case .sessions, .sessionView, .sessionRenamed,
                 .stateUpdated, .abortCompleted, .completed, .failed:
                break
            }
        }
    }

    func retry(turnID: String) {
        guard let turn = turns.first(where: { $0.id == turnID }),
              turn.status == .failed || turn.status == .aborted,
              let sessionID = currentSessionID else { return }
        updateComposer(for: sessionID) {
            $0.draft = turn.question
            $0.pendingAttachments = turn.attachments
            $0.attachmentError = nil
        }
        requestInputFocus()
    }

    func addAttachments(from urls: [URL]) {
        guard let sessionID = currentSessionID else { return }
        updateComposer(for: sessionID) {
            $0.attachmentImportsInFlight += 1
            $0.attachmentError = nil
        }
        Task {
            defer { updateComposer(for: sessionID) { $0.attachmentImportsInFlight -= 1 } }
            do {
                let attachments = try await attachmentStore.importImages(at: urls)
                updateComposer(for: sessionID) { $0.pendingAttachments += attachments }
            } catch {
                updateComposer(for: sessionID) { $0.attachmentError = error.localizedDescription }
            }
        }
    }

    func addPastedImages(_ imageData: [Data]) {
        guard let sessionID = currentSessionID else { return }
        updateComposer(for: sessionID) {
            $0.attachmentImportsInFlight += 1
            $0.attachmentError = nil
        }
        Task {
            defer { updateComposer(for: sessionID) { $0.attachmentImportsInFlight -= 1 } }
            do {
                let attachments = try await attachmentStore.importImages(imageData)
                updateComposer(for: sessionID) { $0.pendingAttachments += attachments }
            } catch {
                updateComposer(for: sessionID) { $0.attachmentError = error.localizedDescription }
            }
        }
    }

    func reportAttachmentError(_ error: Error) {
        guard let sessionID = currentSessionID else { return }
        updateComposer(for: sessionID) { $0.attachmentError = error.localizedDescription }
    }

    func removeAttachment(id: String) {
        guard let sessionID = currentSessionID else { return }
        var removed: ChatImageAttachment?
        updateComposer(for: sessionID) { state in
            if let index = state.pendingAttachments.firstIndex(where: { $0.id == id }) {
                removed = state.pendingAttachments.remove(at: index)
            }
        }
        guard let removed else { return }
        let isUsed = turnCache.values.flatMap { $0 }.contains { turn in
            turn.attachments.contains(where: { $0.id == removed.id })
        }
        if !isUsed { Task { await attachmentStore.remove(removed) } }
    }

    func markTurnFailed(sessionID: String, turnID: String, message: String) {
        updateTurn(sessionID: sessionID, turnID: turnID) {
            $0.status = .failed
            $0.error = message
        }
    }

    func cancelCurrentRequest() {
        guard let sessionID = currentSessionID,
              let turnID = activeTurnIDs[sessionID] else { return }
        Task {
            do { try await agentClient.abort(sessionID: sessionID, targetRequestID: turnID) }
            catch { sessionError = error.localizedDescription }
        }
    }

    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isManagingSession, !isSending, !isImportingAttachments,
              let sessionID = currentSessionID else { return }
        let turnID = UUID().uuidString
        let attachments = pendingAttachments
        startTurn(
            sessionID: sessionID,
            id: turnID,
            question: text,
            attachments: attachments
        )
        updateComposer(for: sessionID) {
            $0.draft = ""
            $0.pendingAttachments = []
            $0.attachmentError = nil
        }
        activeSessionIDs.insert(sessionID)
        activeTurnIDs[sessionID] = turnID
        let task = Task {
            defer {
                if activeTurnIDs[sessionID] == turnID {
                    activeTurnIDs.removeValue(forKey: sessionID)
                    activeSessionIDs.remove(sessionID)
                    requestTasks.removeValue(forKey: sessionID)
                }
            }
            do {
                let events = try await agentClient.prompt(
                    requestID: turnID,
                    sessionID: sessionID,
                    text: text,
                    images: attachments.map(\.productAttachment)
                )
                for try await event in events { apply(event, sessionID: sessionID, turnID: turnID) }
                do {
                    cache(try await agentClient.getSession(id: sessionID))
                    sessions = try await agentClient.listSessions()
                    if currentSessionID == sessionID { sessionError = nil }
                } catch {
                    if currentSessionID == sessionID {
                        sessionError = "Couldn't refresh the completed chat. Please try again."
                    }
                }
            } catch {
                if error is CancellationError || (error as? AgentClientError)?.isAborted == true {
                    updateTurn(sessionID: sessionID, turnID: turnID) {
                        $0.status = .aborted
                        $0.error = nil
                    }
                } else {
                    markTurnFailed(sessionID: sessionID, turnID: turnID, message: error.localizedDescription)
                }
            }
        }
        requestTasks[sessionID] = task
    }

    func selectThinking(_ value: ProductThinkingLevel) async {
        await mutateState { try await agentClient.setThinking(sessionID: $0, thinking: value) }
    }

    private func mutateState(
        _ operation: (String) async throws -> ProductSessionState
    ) async {
        guard let sessionID = currentSessionID, !isUpdatingAgentState else { return }
        isUpdatingAgentState = true
        defer { isUpdatingAgentState = false }
        do {
            cache(try await operation(sessionID), for: sessionID)
            if currentSessionID == sessionID { sessionError = nil }
        } catch {
            if currentSessionID == sessionID {
                sessionError = "Couldn't update Agent settings. Please try again."
            }
        }
    }

    private func cache(_ state: ProductSessionState, for sessionID: String) {
        if let view = sessionViews[sessionID] {
            sessionViews[sessionID] = ProductSessionView(
                session: view.session,
                messages: view.messages,
                state: state
            )
        }
        if currentSessionID == sessionID { apply(state) }
    }

    private func apply(_ state: ProductSessionState) {
        thinking = state.thinking
    }

    func compact(instructions: String? = nil) async {
        guard let sessionID = currentSessionID, !isCompacting else { return }
        isCompacting = true
        compactionError = nil
        defer { isCompacting = false }
        do {
            let result = try await agentClient.compact(
                sessionID: sessionID,
                instructions: instructions
            )
            if currentSessionID == sessionID { compactionResult = result }
            do {
                let view = try await agentClient.getSession(id: sessionID)
                if currentSessionID == sessionID { apply(view) }
                else { cache(view) }
            } catch {
                if currentSessionID == sessionID {
                    sessionError = "Session compacted, but the chat couldn't be refreshed."
                }
            }
        } catch {
            if currentSessionID == sessionID {
                compactionError = "Compaction failed. Please try again."
            }
        }
    }

    private func updateTurn(
        sessionID: String,
        turnID: String,
        update: (inout ChatTurn) -> Void
    ) {
        var sessionTurns = turnCache[sessionID] ?? []
        guard let index = sessionTurns.firstIndex(where: { $0.id == turnID }) else { return }
        update(&sessionTurns[index])
        setTurns(sessionTurns, for: sessionID)
    }

    private var currentComposerState: ComposerState {
        guard let sessionID = currentSessionID else { return ComposerState() }
        return composerStates[sessionID] ?? ComposerState()
    }

    private func updateComposer(for sessionID: String, update: (inout ComposerState) -> Void) {
        var state = composerStates[sessionID] ?? ComposerState()
        update(&state)
        composerStates[sessionID] = state
    }
}

private extension AgentClientError {
    var isAborted: Bool {
        if case let .requestFailed(failure) = self { return failure.code == .aborted }
        return false
    }
}
