import AppKit
import Foundation
import SwiftUI

@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var turns: [ChatTurn] = []
    @Published private(set) var sessions: [ChatSessionSummary] = []
    @Published private(set) var currentSessionID: UUID?
    @Published private(set) var currentTitle = "New Chat"
    @Published private(set) var activeSessionIDs: Set<UUID> = []
    @Published private(set) var isManagingSession = false
    @Published private(set) var sessionError: String?
    @Published private(set) var focusRequest = 0
    @Published private var composerStates: [UUID: ComposerState] = [:]

    private let agentClient: AgentClient
    private let windowCapture: WindowCapture
    private let attachmentStore: ChatAttachmentStore
    private let defaults: UserDefaults
    private var turnCache: [UUID: [ChatTurn]] = [:]
    private var activeTurnIDs: [UUID: UUID] = [:]
    private var requestTasks: [UUID: Task<Void, Never>] = [:]
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

    var isSending: Bool {
        currentSessionID.map(activeSessionIDs.contains) ?? false
    }

    init(
        agentClient: AgentClient,
        windowCapture: WindowCapture,
        attachmentStore: ChatAttachmentStore = ChatAttachmentStore(),
        defaults: UserDefaults = .standard
    ) {
        self.agentClient = agentClient
        self.windowCapture = windowCapture
        self.attachmentStore = attachmentStore
        self.defaults = defaults
    }

    func requestInputFocus() {
        focusRequest += 1
    }

    func updateDraft(_ draft: String) {
        guard let sessionID = currentSessionID else { return }
        updateComposer(for: sessionID) { $0.draft = draft }
    }

    func startTurn(
        sessionID: UUID,
        id: UUID,
        question: String,
        attachments: [ChatImageAttachment] = []
    ) {
        var sessionTurns = turnCache[sessionID] ?? []
        sessionTurns.append(ChatTurn(
            id: id,
            question: question,
            attachments: attachments,
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
                attachments: $0.images ?? [],
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

    func apply(_ event: AgentEvent, sessionID: UUID, turnID: UUID) {
        guard event.sessionId == nil || event.sessionId == sessionID else { return }
        updateTurn(sessionID: sessionID, turnID: turnID) { turn in
            switch event.type {
            case .reasoningDelta:
                turn.status = .generating
                turn.reasoning += event.delta ?? ""
            case .answerDelta:
                turn.status = .generating
                turn.answer += event.delta ?? ""
            case .completed:
                turn.status = .completed
            case .cancelled:
                turn.status = .cancelled
            case .started, .sessions, .session, .failed:
                break
            }
        }
    }

    func markRequesting(sessionID: UUID, turnID: UUID) {
        updateTurn(sessionID: sessionID, turnID: turnID) { $0.status = .requesting }
    }

    func retry(turnID: UUID) {
        guard let turn = turns.first(where: { $0.id == turnID }),
              turn.status == .failed || turn.status == .cancelled,
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
            defer {
                updateComposer(for: sessionID) {
                    $0.attachmentImportsInFlight -= 1
                }
            }
            do {
                let attachments = try await attachmentStore.importImages(at: urls)
                updateComposer(for: sessionID) {
                    $0.pendingAttachments.append(contentsOf: attachments)
                }
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
            defer {
                updateComposer(for: sessionID) {
                    $0.attachmentImportsInFlight -= 1
                }
            }
            do {
                let attachments = try await attachmentStore.importImages(imageData)
                updateComposer(for: sessionID) {
                    $0.pendingAttachments.append(contentsOf: attachments)
                }
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
        var removedAttachment: ChatImageAttachment?
        updateComposer(for: sessionID) { state in
            guard let index = state.pendingAttachments.firstIndex(where: { $0.id == id }) else {
                return
            }
            removedAttachment = state.pendingAttachments.remove(at: index)
        }
        guard let attachment = removedAttachment else { return }
        let isUsedByHistory = turnCache.values
            .flatMap { $0 }
            .contains { turn in turn.attachments.contains(where: { $0.id == attachment.id }) }
        if !isUsedByHistory {
            Task { await attachmentStore.remove(attachment) }
        }
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
        guard !text.isEmpty, !isManagingSession, !isSending, !isImportingAttachments,
              let sessionID = currentSessionID else { return }

        let turnID = UUID()
        let userAttachments = pendingAttachments
        startTurn(
            sessionID: sessionID,
            id: turnID,
            question: text,
            attachments: userAttachments
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
            var sentToAgent = false
            do {
                let imageURL = try await windowCapture.captureActiveWindow()
                try Task.checkCancellation()
                let images = [ChatImageAttachment(
                    id: UUID().uuidString,
                    source: .systemCapture,
                    path: imageURL.path
                )] + userAttachments
                let events = try await agentClient.send(
                    requestID: turnID,
                    sessionID: sessionID,
                    text: text,
                    images: images
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
                        images: userAttachments,
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
                        images: userAttachments,
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

    private var currentComposerState: ComposerState {
        guard let sessionID = currentSessionID else { return ComposerState() }
        return composerStates[sessionID] ?? ComposerState()
    }

    private func updateComposer(
        for sessionID: UUID,
        update: (inout ComposerState) -> Void
    ) {
        var state = composerStates[sessionID] ?? ComposerState()
        update(&state)
        composerStates[sessionID] = state
    }

    private func recordLocalAttempt(
        sessionID: UUID,
        turnID: UUID,
        text: String,
        images: [ChatImageAttachment],
        status: AgentRequest.AttemptStatus
    ) async {
        let record = Task {
            try await agentClient.recordAttempt(
                requestID: turnID,
                sessionID: sessionID,
                text: text,
                images: images,
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
