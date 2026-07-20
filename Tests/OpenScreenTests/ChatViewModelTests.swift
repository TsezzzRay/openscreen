import XCTest
@testable import OpenScreen

@MainActor
final class ChatViewModelTests: XCTestCase {
    func testChatViewModelRestoresSessionSnapshot() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let turnID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!

        viewModel.apply(
            ChatSessionSnapshot(
                id: sessionID,
                title: "Project notes",
                createdAt: "2026-07-19T00:00:00.000Z",
                updatedAt: "2026-07-19T01:00:00.000Z",
                turns: [
                    .init(
                        id: turnID,
                        user: "Question",
                        assistant: "Answer",
                        reasoning: "Checked screen",
                        status: .completed,
                        error: nil
                    )
                ]
            )
        )

        XCTAssertEqual(viewModel.currentSessionID, sessionID)
        XCTAssertEqual(viewModel.currentTitle, "Project notes")
        XCTAssertEqual(viewModel.turns.first?.id, turnID)
        XCTAssertEqual(viewModel.turns.first?.reasoning, "Checked screen")
        XCTAssertEqual(viewModel.turns.first?.status, .completed)
    }

    func testPreferredSessionUsesSavedIDThenFallsBackToNewest() {
        let first = ChatSessionSummary(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
            title: "First",
            createdAt: "2026-07-18T00:00:00.000Z",
            updatedAt: "2026-07-18T00:00:00.000Z"
        )
        let newest = ChatSessionSummary(
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!,
            title: "Newest",
            createdAt: "2026-07-19T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z"
        )

        XCTAssertEqual(
            ChatViewModel.sessionToRestore(from: [newest, first], preferredID: first.id),
            first.id
        )
        XCTAssertEqual(
            ChatViewModel.sessionToRestore(from: [newest, first], preferredID: UUID()),
            newest.id
        )
    }

    func testChatViewModelRetainsCompletedTurns() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let sessionID = UUID()
        let firstID = UUID()
        let secondID = UUID()
        viewModel.apply(.init(
            id: sessionID,
            title: "Test",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            turns: []
        ))
        viewModel.startTurn(sessionID: sessionID, id: firstID, question: "First question")
        viewModel.apply(
            .init(sessionID: sessionID, type: .answerDelta, delta: "First answer"),
            sessionID: sessionID,
            turnID: firstID
        )
        viewModel.startTurn(sessionID: sessionID, id: secondID, question: "Second question")
        viewModel.apply(
            .init(sessionID: sessionID, type: .answerDelta, delta: "Second answer"),
            sessionID: sessionID,
            turnID: secondID
        )

        XCTAssertEqual(viewModel.turns.map(\.question), ["First question", "Second question"])
        XCTAssertEqual(viewModel.turns.map(\.answer), ["First answer", "Second answer"])
    }

    func testChatViewModelAppliesStreamingDeltas() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let sessionID = UUID()
        let turnID = UUID()
        viewModel.apply(.init(
            id: sessionID,
            title: "Test",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            turns: []
        ))
        viewModel.startTurn(sessionID: sessionID, id: turnID, question: "Question")

        for event in [
            AgentEvent(sessionID: sessionID, type: .reasoningDelta, delta: "Checking "),
            AgentEvent(sessionID: sessionID, type: .reasoningDelta, delta: "screen"),
            AgentEvent(sessionID: sessionID, type: .answerDelta, delta: "The answer"),
        ] {
            viewModel.apply(event, sessionID: sessionID, turnID: turnID)
        }

        XCTAssertEqual(viewModel.turns[0].reasoning, "Checking screen")
        XCTAssertEqual(viewModel.turns[0].answer, "The answer")
    }

    func testChatViewModelRoutesBackgroundSessionDeltasWithoutSwitchingContext() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let firstSessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let secondSessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let firstTurnID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!

        viewModel.apply(.init(
            id: firstSessionID,
            title: "First",
            createdAt: "2026-07-19T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z",
            turns: []
        ))
        viewModel.startTurn(sessionID: firstSessionID, id: firstTurnID, question: "Question")
        viewModel.apply(.init(
            id: secondSessionID,
            title: "Second",
            createdAt: "2026-07-19T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z",
            turns: []
        ))

        viewModel.apply(
            .init(sessionID: firstSessionID, type: .answerDelta, delta: "Background answer"),
            sessionID: firstSessionID,
            turnID: firstTurnID
        )
        viewModel.apply(
            .init(sessionID: firstSessionID, type: .cancelled),
            sessionID: firstSessionID,
            turnID: firstTurnID
        )

        XCTAssertEqual(viewModel.currentSessionID, secondSessionID)
        XCTAssertTrue(viewModel.turns.isEmpty)
        XCTAssertEqual(viewModel.cachedTurns(for: firstSessionID).first?.answer, "Background answer")
        XCTAssertEqual(viewModel.cachedTurns(for: firstSessionID).first?.status, .cancelled)
    }

    func testChatViewModelTracksLifecycleAndPreparesEditableRetry() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let turnID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        viewModel.apply(.init(
            id: sessionID,
            title: "Lifecycle",
            createdAt: "2026-07-19T00:00:00.000Z",
            updatedAt: "2026-07-19T00:00:00.000Z",
            turns: []
        ))

        viewModel.startTurn(sessionID: sessionID, id: turnID, question: "Original prompt")
        XCTAssertEqual(viewModel.turns[0].status, .capturing)

        viewModel.markRequesting(sessionID: sessionID, turnID: turnID)
        XCTAssertEqual(viewModel.turns[0].status, .requesting)

        viewModel.apply(
            .init(sessionID: sessionID, type: .answerDelta, delta: "Partial"),
            sessionID: sessionID,
            turnID: turnID
        )
        XCTAssertEqual(viewModel.turns[0].status, .generating)

        viewModel.apply(
            .init(sessionID: sessionID, type: .cancelled),
            sessionID: sessionID,
            turnID: turnID
        )
        XCTAssertEqual(viewModel.turns[0].status, .cancelled)

        let previousFocusRequest = viewModel.focusRequest
        viewModel.retry(turnID: turnID)
        XCTAssertEqual(viewModel.draft, "Original prompt")
        XCTAssertEqual(viewModel.focusRequest, previousFocusRequest + 1)
    }
}
