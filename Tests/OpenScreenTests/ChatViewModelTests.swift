import AppKit
import XCTest
@testable import OpenScreen

@MainActor
final class ChatViewModelTests: XCTestCase {
    func testAppliesLinearSessionTranscriptWithoutMixingToolOutputIntoAnswer() {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        let view = sessionView(
            id: "session-1",
            messages: [
                .init(id: "user-1", role: .user, timestamp: "1", text: "Question", imageCount: 2),
                .init(id: "tool-1", role: .tool, timestamp: "2", text: "tool output", toolName: "read", isError: false),
                .init(id: "assistant-1", role: .assistant, timestamp: "3", text: "Answer", reasoning: "Checked screen"),
            ]
        )

        viewModel.apply(view)

        XCTAssertEqual(viewModel.currentSessionID, "session-1")
        XCTAssertEqual(viewModel.currentTitle, "Session session-1")
        XCTAssertEqual(viewModel.turns.count, 1)
        XCTAssertEqual(viewModel.turns[0].question, "Question")
        XCTAssertEqual(viewModel.turns[0].answer, "Answer")
        XCTAssertFalse(viewModel.turns[0].answer.contains("tool output"))
        XCTAssertEqual(viewModel.turns[0].reasoning, "Checked screen")
        XCTAssertEqual(viewModel.turns[0].historicalImageCount, 2)
        XCTAssertEqual(viewModel.turns[0].toolActivities.first?.text, "tool output")
        XCTAssertEqual(viewModel.thinking, .medium)
    }

    func testRestoredAssistantErrorRemainsVisibleAsFailedTurn() {
        let viewModel = makeViewModel(MockAgentProductClient())
        viewModel.apply(sessionView(id: "s", messages: [
            .init(id: "u", role: .user, timestamp: "1", text: "Question"),
            .init(
                id: "a",
                role: .assistant,
                timestamp: "2",
                text: "Partial answer",
                isError: true
            ),
        ]))

        XCTAssertEqual(viewModel.turns.first?.status, .failed)
        XCTAssertNotNil(viewModel.turns.first?.error)
    }

    func testRenameUpdatesCachedSessionTitle() {
        let viewModel = makeViewModel(MockAgentProductClient())
        viewModel.apply(sessionView(id: "first"))
        viewModel.applyRenamedSession(.init(id: "first", createdAt: "1", name: "Renamed"))

        XCTAssertEqual(viewModel.currentTitle, "Renamed")
        XCTAssertEqual(viewModel.cachedSessionTitle(for: "first"), "Renamed")
    }

    func testStreamingDeltasAndAnswerCompletionUpdateOnlyTargetTurn() {
        let viewModel = makeViewModel(MockAgentProductClient())
        viewModel.apply(sessionView(id: "first"))
        viewModel.startTurn(sessionID: "first", id: "request-1", question: "Question")
        viewModel.apply(.init(requestId: "request-1", type: .runStarted, sessionId: "first"), sessionID: "first", turnID: "request-1")
        viewModel.apply(.init(requestId: "request-1", type: .reasoningDelta, sessionId: "first", delta: "Checking "), sessionID: "first", turnID: "request-1")
        viewModel.apply(.init(requestId: "request-1", type: .reasoningDelta, sessionId: "first", delta: "screen"), sessionID: "first", turnID: "request-1")
        viewModel.apply(.init(requestId: "request-1", type: .answerDelta, sessionId: "first", delta: "Partial"), sessionID: "first", turnID: "request-1")
        viewModel.apply(.init(
            requestId: "request-1",
            type: .answerCompleted,
            sessionId: "first",
            answer: "Final answer",
            contextUsage: .init(contextTokens: 42, contextWindow: 100)
        ), sessionID: "first", turnID: "request-1")

        XCTAssertEqual(viewModel.turns[0].reasoning, "Checking screen")
        XCTAssertEqual(viewModel.turns[0].answer, "Final answer")
        XCTAssertEqual(viewModel.turns[0].status, .completed)
        XCTAssertEqual(viewModel.turns[0].contextUsage, .init(contextTokens: 42, contextWindow: 100))
    }

    func testToolLifecycleUsesIndependentToolActivities() {
        let viewModel = makeViewModel(MockAgentProductClient())
        viewModel.apply(sessionView(id: "s"))
        viewModel.startTurn(sessionID: "s", id: "r", question: "Question")

        viewModel.apply(.toolEvent(requestID: "r", kind: .toolStarted, sessionID: "s", callID: "c", name: "read"), sessionID: "s", turnID: "r")
        viewModel.apply(.toolEvent(requestID: "r", kind: .toolUpdated, sessionID: "s", callID: "c", name: "read", text: "partial"), sessionID: "s", turnID: "r")
        viewModel.apply(.toolEvent(requestID: "r", kind: .toolFinished, sessionID: "s", callID: "c", name: "read", text: "done", isError: false), sessionID: "s", turnID: "r")

        XCTAssertEqual(viewModel.turns[0].answer, "")
        XCTAssertEqual(viewModel.turns[0].toolActivities, [
            .init(callID: "c", name: "read", text: "done", status: .finished, isError: false),
        ])
    }

    func testThinkingMutationAppliesReturnedState() async throws {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "s"))
        await client.setMutationState(.init(thinking: .high))

        await viewModel.selectThinking(.high)

        XCTAssertEqual(viewModel.thinking, .high)
        let calls = await client.stateMutationCalls()
        XCTAssertEqual(calls, ["thinking:high"])
    }

    func testManualCompactionPublishesResult() async {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "s"))
        await client.setCompaction(.init(summary: "Short summary", firstKeptEntryId: "m2", tokensBefore: 400))
        await client.setSessionView(sessionView(id: "s"))

        await viewModel.compact(instructions: "Keep decisions")

        XCTAssertFalse(viewModel.isCompacting)
        XCTAssertEqual(viewModel.compactionResult?.summary, "Short summary")
        XCTAssertNil(viewModel.compactionError)
        let instructions = await client.lastCompactionInstructions()
        XCTAssertEqual(instructions, "Keep decisions")
    }

    func testSuccessfulPromptStaysCompletedWhenSessionRefreshFails() async throws {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "s"))
        await client.setSessionError(TestError.failed)
        viewModel.updateDraft("Question")

        viewModel.submit()
        try await waitUntil { !viewModel.isSending }

        XCTAssertEqual(viewModel.turns.last?.status, .completed)
        XCTAssertEqual(viewModel.turns.last?.answer, "Answer")
        XCTAssertEqual(viewModel.sessionError, "Couldn't refresh the completed chat. Please try again.")
    }

    func testRetryRestoresLocalPromptAndAttachmentsWithoutBackendPersistence() {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        let attachment = ChatImageAttachment(id: "image", source: .userUpload, path: "/tmp/image.png", mimeType: .png)
        viewModel.apply(sessionView(id: "s"))
        viewModel.startTurn(sessionID: "s", id: "r", question: "Retry me", attachments: [attachment])
        viewModel.markTurnFailed(sessionID: "s", turnID: "r", message: "Failed")

        viewModel.retry(turnID: "r")

        XCTAssertEqual(viewModel.draft, "Retry me")
        XCTAssertEqual(viewModel.pendingAttachments, [attachment])
    }

    func testLocalAttachmentsBindNewestFirstForRepeatedPrompts() {
        let older = ChatImageAttachment(
            id: "older",
            source: .userUpload,
            path: "/tmp/older.png",
            mimeType: .png
        )
        let newer = ChatImageAttachment(
            id: "newer",
            source: .userUpload,
            path: "/tmp/newer.png",
            mimeType: .png
        )
        let previous = [
            ChatTurn(id: "old", question: "Same", attachments: [older], reasoning: "", answer: ""),
            ChatTurn(id: "new", question: "Same", attachments: [newer], reasoning: "", answer: ""),
        ]
        let restoredSuffix = [
            ChatTurn(id: "branch", question: "Same", reasoning: "", answer: ""),
        ]

        let rebound = ChatViewModel.restoreLocalAttachments(restoredSuffix, from: previous)
        let restoredFull = [
            ChatTurn(id: "branch-old", question: "Same", reasoning: "", answer: ""),
            ChatTurn(id: "branch-new", question: "Same", reasoning: "", answer: ""),
        ]
        let fullRebound = ChatViewModel.restoreLocalAttachments(restoredFull, from: previous)

        XCTAssertEqual(rebound.first?.attachments, [newer])
        XCTAssertEqual(fullRebound.map(\.attachments), [[older], [newer]])
    }

    func testSwitchingSessionClearsCompactionTransientState() async {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "first"))
        await client.setCompaction(.init(summary: "Summary", firstKeptEntryId: "m", tokensBefore: 100))
        await client.setSessionView(sessionView(id: "first"))
        await viewModel.compact()

        XCTAssertNotNil(viewModel.compactionResult)

        viewModel.apply(sessionView(id: "second"))

        XCTAssertNil(viewModel.compactionResult)
        XCTAssertNil(viewModel.compactionError)
    }

    func testSwitchingSessionClearsCompactionErrors() async {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "first"))
        await client.setCompactionError(TestError.failed)
        await viewModel.compact()

        XCTAssertNotNil(viewModel.compactionError)

        viewModel.apply(sessionView(id: "second"))

        XCTAssertNil(viewModel.compactionError)
    }

    func testBackgroundCompactionDoesNotRepopulateAnotherSession() async throws {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "first"))
        await client.setCompaction(.init(summary: "Summary", firstKeptEntryId: "m", tokensBefore: 100))
        await client.setSessionView(sessionView(id: "first"))
        await client.holdCompactionOpen()
        let compaction = Task { await viewModel.compact() }
        try await waitUntil { await client.isCompactionWaiting() }
        viewModel.apply(sessionView(id: "second"))
        await client.finishCompaction()
        await compaction.value

        XCTAssertEqual(viewModel.currentSessionID, "second")
        XCTAssertNil(viewModel.compactionResult)
        XCTAssertNil(viewModel.compactionError)
    }

    func testCancellationTargetsExactActivePromptRequest() async throws {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "s"))
        await client.holdPromptOpen()
        viewModel.updateDraft("Question")

        viewModel.submit()
        try await waitUntil { viewModel.isSending }
        let requestID = try XCTUnwrap(viewModel.activeRequestID(for: "s"))
        viewModel.cancelCurrentRequest()
        try await waitUntil { await client.abortCalls().contains(where: { $0.1 == requestID }) }
        await client.finishHeldPrompt()

        let calls = await client.abortCalls()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.0, "s")
        XCTAssertEqual(calls.first?.1, requestID)
    }

    func testBackgroundSessionEventsDoNotSwitchVisibleSession() {
        let viewModel = makeViewModel(MockAgentProductClient())
        viewModel.apply(sessionView(id: "first"))
        viewModel.startTurn(sessionID: "first", id: "r", question: "Question")
        viewModel.apply(sessionView(id: "second"))

        viewModel.apply(.init(requestId: "r", type: .answerDelta, sessionId: "first", delta: "Background"), sessionID: "first", turnID: "r")

        XCTAssertEqual(viewModel.currentSessionID, "second")
        XCTAssertTrue(viewModel.turns.isEmpty)
        XCTAssertEqual(viewModel.cachedTurns(for: "first").first?.answer, "Background")
    }

    func testReturningToActiveBackgroundSessionPreservesItsLocalStreamingTurn() async throws {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "first"))
        await client.holdPromptOpen()
        viewModel.updateDraft("In flight")
        viewModel.submit()
        try await waitUntil { viewModel.isSending }
        let turnID = try XCTUnwrap(viewModel.activeRequestID(for: "first"))

        viewModel.apply(sessionView(id: "second"))
        viewModel.selectSession("first")
        viewModel.apply(
            .init(requestId: turnID, type: .answerDelta, sessionId: "first", delta: "Still here"),
            sessionID: "first",
            turnID: turnID
        )

        XCTAssertEqual(viewModel.currentSessionID, "first")
        XCTAssertEqual(viewModel.turns.last?.question, "In flight")
        XCTAssertEqual(viewModel.turns.last?.answer, "Still here")
        await client.finishHeldPrompt()
    }

    func testStateMutationResultIsCachedForTargetWithoutPollutingNewCurrentSession() async throws {
        let client = MockAgentProductClient()
        let viewModel = makeViewModel(client)
        viewModel.apply(sessionView(id: "first"))
        await client.setMutationState(.init(thinking: .high))
        await client.holdStateMutationOpen()

        let mutation = Task { await viewModel.selectThinking(.high) }
        try await waitUntil { await client.isStateMutationWaiting() }
        viewModel.apply(sessionView(
            id: "second",
            state: .init(thinking: .low)
        ))
        await client.finishStateMutation()
        await mutation.value

        XCTAssertEqual(viewModel.currentSessionID, "second")
        XCTAssertEqual(viewModel.thinking, .low)
        XCTAssertEqual(viewModel.cachedSessionState(for: "first")?.thinking, .high)
    }

    func testPreferredSessionUsesSavedStringIDThenFallsBackToFirst() {
        let first = ProductSessionSummary(id: "first", createdAt: "1", name: "First")
        let second = ProductSessionSummary(id: "second", createdAt: "2", name: "Second")
        XCTAssertEqual(ChatViewModel.sessionToRestore(from: [second, first], preferredID: "first"), "first")
        XCTAssertEqual(ChatViewModel.sessionToRestore(from: [second, first], preferredID: "missing"), "second")
    }

    func testAttachmentImportReturnsToOriginatingSession() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let viewModel = ChatViewModel(
            agentClient: MockAgentProductClient(),
            attachmentStore: ChatAttachmentStore(directory: root),
            defaults: isolatedDefaults()
        )
        let image = NSImage(size: NSSize(width: 20, height: 20))
        image.lockFocus()
        NSColor.systemBlue.setFill()
        NSRect(x: 0, y: 0, width: 20, height: 20).fill()
        image.unlockFocus()
        let imageData = try XCTUnwrap(image.tiffRepresentation)

        viewModel.apply(sessionView(id: "first"))
        viewModel.addPastedImages([imageData])
        viewModel.apply(sessionView(id: "second"))
        XCTAssertTrue(viewModel.pendingAttachments.isEmpty)
        viewModel.apply(sessionView(id: "first"))
        try await waitUntil { !viewModel.isImportingAttachments }

        XCTAssertEqual(viewModel.pendingAttachments.count, 1)
        XCTAssertEqual(viewModel.pendingAttachments.first?.mimeType, .png)
    }

    private func makeViewModel(_ client: MockAgentProductClient) -> ChatViewModel {
        ChatViewModel(agentClient: client, defaults: isolatedDefaults())
    }

    private func isolatedDefaults() -> UserDefaults {
        let suite = "ChatViewModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func sessionView(
        id: String,
        messages: [ProductTranscriptMessage] = [],
        state: ProductSessionState? = nil
    ) -> ProductSessionView {
        ProductSessionView(
            session: .init(id: id, createdAt: "2026-08-13T00:00:00.000Z", name: "Session \(id)"),
            messages: messages,
            state: state ?? .init(thinking: .medium)
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        _ condition: @escaping @MainActor () async -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !(await condition()) {
            if clock.now >= deadline { throw TestError.timedOut }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

private enum TestError: Error {
    case failed
    case timedOut
}

private actor MockAgentProductClient: AgentProductClient {
    private var mutationState = ProductSessionState(thinking: .medium)
    private var compaction = ProductCompactionResult(summary: "", firstKeptEntryId: "", tokensBefore: 0)
    private var compactionError: Error?
    private var sessionView: ProductSessionView?
    private var sessionError: Error?
    private var mutations: [String] = []
    private var compactInstructions: String?
    private var abortRecords: [(String, String)] = []
    private var sessionViewCalls = 0
    private var shouldHoldPrompt = false
    private var promptContinuation: AsyncThrowingStream<AgentEvent, Error>.Continuation?
    private var shouldHoldStateMutation = false
    private var stateMutationContinuation: CheckedContinuation<Void, Never>?
    private var shouldHoldCompaction = false
    private var compactionContinuation: CheckedContinuation<Void, Never>?

    func setMutationState(_ state: ProductSessionState) { mutationState = state }
    func setCompaction(_ result: ProductCompactionResult) {
        compaction = result
        compactionError = nil
    }
    func setCompactionError(_ error: Error) { compactionError = error }
    func setSessionView(_ view: ProductSessionView) { sessionView = view; sessionError = nil }
    func setSessionError(_ error: Error) { sessionError = error }
    func stateMutationCalls() -> [String] { mutations }
    func lastCompactionInstructions() -> String? { compactInstructions }
    func abortCalls() -> [(String, String)] { abortRecords }
    func getSessionCallCount() -> Int { sessionViewCalls }
    func holdPromptOpen() { shouldHoldPrompt = true }
    func finishHeldPrompt() { promptContinuation?.finish(); promptContinuation = nil }
    func holdStateMutationOpen() { shouldHoldStateMutation = true }
    func isStateMutationWaiting() -> Bool { stateMutationContinuation != nil }
    func finishStateMutation() {
        stateMutationContinuation?.resume()
        stateMutationContinuation = nil
        shouldHoldStateMutation = false
    }
    func holdCompactionOpen() { shouldHoldCompaction = true }
    func isCompactionWaiting() -> Bool { compactionContinuation != nil }
    func finishCompaction() {
        compactionContinuation?.resume()
        compactionContinuation = nil
        shouldHoldCompaction = false
    }
    func listSessions() async throws -> [ProductSessionSummary] { [] }
    func createSession() async throws -> ProductSessionView { throw TestError.failed }
    func getSession(id: String) async throws -> ProductSessionView {
        sessionViewCalls += 1
        if let sessionError { throw sessionError }
        guard let sessionView else { throw TestError.failed }
        return sessionView
    }
    func renameSession(id: String, name: String) async throws -> ProductSessionSummary { throw TestError.failed }

    func prompt(
        requestID: String,
        sessionID: String,
        text: String,
        images: [ProductImageAttachment]
    ) async throws -> AsyncThrowingStream<AgentEvent, Error> {
        if shouldHoldPrompt {
            return AsyncThrowingStream { continuation in
                promptContinuation = continuation
            }
        }
        return AsyncThrowingStream { continuation in
            continuation.yield(.init(requestId: requestID, type: .runStarted, sessionId: sessionID))
            continuation.yield(.init(requestId: requestID, type: .answerCompleted, sessionId: sessionID, answer: "Answer"))
            continuation.finish()
        }
    }

    func abort(sessionID: String, targetRequestID: String) async throws {
        abortRecords.append((sessionID, targetRequestID))
    }

    func compact(sessionID: String, instructions: String?) async throws -> ProductCompactionResult {
        compactInstructions = instructions
        if shouldHoldCompaction {
            await withCheckedContinuation { compactionContinuation = $0 }
        }
        if let compactionError { throw compactionError }
        return compaction
    }

    func setThinking(sessionID: String, thinking: ProductThinkingLevel) async throws -> ProductSessionState {
        mutations.append("thinking:\(thinking.rawValue)")
        if shouldHoldStateMutation {
            await withCheckedContinuation { stateMutationContinuation = $0 }
        }
        return mutationState
    }

}
