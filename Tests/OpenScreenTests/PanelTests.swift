import AppKit
import SwiftUI
import XCTest
@testable import OpenScreen

@MainActor
final class PanelTests: XCTestCase {
    func testAgentRequestEncoding() throws {
        let requestID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let data = try AgentRequest.chat(
            requestID: requestID,
            sessionID: sessionID,
            text: "What is on screen?",
            imagePath: "/tmp/window.png"
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let input = try XCTUnwrap(object["input"] as? [String: String])

        XCTAssertEqual(object["requestId"] as? String, requestID.uuidString)
        XCTAssertEqual(object["type"] as? String, "chat")
        XCTAssertEqual(object["sessionId"] as? String, sessionID.uuidString)
        XCTAssertEqual(input["text"], "What is on screen?")
        XCTAssertEqual(input["image"], "/tmp/window.png")
        XCTAssertEqual(data.last, Character("\n").asciiValue)
    }

    func testRenameSessionRequestEncoding() throws {
        let requestID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let data = try AgentRequest.renameSession(
            requestID: requestID,
            sessionID: sessionID,
            title: "Project notes"
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "rename_session")
        XCTAssertEqual(object["sessionId"] as? String, sessionID.uuidString)
        XCTAssertEqual(object["title"] as? String, "Project notes")
    }

    func testAgentEventDecoding() throws {
        let data = Data(
            #"{"requestId":"00000000-0000-0000-0000-000000000001","sessionId":"00000000-0000-0000-0000-000000000002","type":"answer_delta","delta":"Hello"}"#.utf8
        )

        let event = try JSONDecoder().decode(AgentEvent.self, from: data)

        XCTAssertEqual(event.type, .answerDelta)
        XCTAssertEqual(event.delta, "Hello")
        XCTAssertEqual(
            event.sessionId,
            UUID(uuidString: "00000000-0000-0000-0000-000000000002")
        )
    }

    func testSessionSnapshotEventDecoding() throws {
        let data = Data(
            #"{"requestId":"00000000-0000-0000-0000-000000000001","type":"session","session":{"id":"00000000-0000-0000-0000-000000000002","title":"Project notes","createdAt":"2026-07-19T00:00:00.000Z","updatedAt":"2026-07-19T01:00:00.000Z","turns":[{"id":"00000000-0000-0000-0000-000000000003","user":"Question","assistant":"Partial answer","reasoning":"Checked screen","status":"interrupted"}]}}"#.utf8
        )

        let event = try JSONDecoder().decode(AgentEvent.self, from: data)

        XCTAssertEqual(event.type, .session)
        XCTAssertEqual(event.session?.title, "Project notes")
        XCTAssertEqual(event.session?.turns.first?.assistant, "Partial answer")
        XCTAssertEqual(event.session?.turns.first?.status, .interrupted)
    }

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

        let first = viewModel.startTurn(question: "First question")
        viewModel.finishTurn(at: first, answer: "First answer")
        let second = viewModel.startTurn(question: "Second question")
        viewModel.finishTurn(at: second, answer: "Second answer")

        XCTAssertEqual(viewModel.turns.map(\.question), ["First question", "Second question"])
        XCTAssertEqual(viewModel.turns.map(\.answer), ["First answer", "Second answer"])
    }

    func testChatViewModelAppliesStreamingDeltas() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let turn = viewModel.startTurn(question: "Question")

        viewModel.apply(.init(type: .reasoningDelta, delta: "Checking "), at: turn)
        viewModel.apply(.init(type: .reasoningDelta, delta: "screen"), at: turn)
        viewModel.apply(.init(type: .answerDelta, delta: "The answer"), at: turn)

        XCTAssertEqual(viewModel.turns[turn].reasoning, "Checking screen")
        XCTAssertEqual(viewModel.turns[turn].answer, "The answer")
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

        XCTAssertEqual(viewModel.currentSessionID, secondSessionID)
        XCTAssertTrue(viewModel.turns.isEmpty)
        XCTAssertEqual(viewModel.cachedTurns(for: firstSessionID).first?.answer, "Background answer")
    }

    func testWindowSelectionSkipsFullscreenToolbar() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(1),
                kCGWindowBounds as String: ["Width": CGFloat(1920), "Height": CGFloat(41)],
            ],
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(2),
                kCGWindowBounds as String: ["Width": CGFloat(1920), "Height": CGFloat(1080)],
            ],
        ]

        XCTAssertEqual(
            WindowCapture.selectWindowID(for: processIdentifier, from: windows),
            CGWindowID(2)
        )
    }

    func testWindowSelectionFallsBackToOnlySmallWindow() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(7),
                kCGWindowBounds as String: ["Width": CGFloat(150), "Height": CGFloat(100)],
            ],
        ]

        XCTAssertEqual(
            WindowCapture.selectWindowID(for: processIdentifier, from: windows),
            CGWindowID(7)
        )
    }

    func testWindowSelectionDetectsSplitFullscreenApplication() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(10),
                kCGWindowBounds as String: ["X": CGFloat(0), "Y": CGFloat(24), "Width": CGFloat(1920), "Height": CGFloat(166)],
            ],
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(11),
                kCGWindowBounds as String: ["X": CGFloat(0), "Y": CGFloat(146), "Width": CGFloat(1920), "Height": CGFloat(934)],
            ],
        ]

        XCTAssertTrue(
            WindowCapture.shouldCaptureWindowGroup(for: processIdentifier, from: windows)
        )
        XCTAssertEqual(
            WindowCapture.selectWindowID(for: processIdentifier, from: windows),
            CGWindowID(11)
        )
    }

    func testWindowSelectionKeepsNormalWindowIndependent() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(12),
                kCGWindowBounds as String: ["X": CGFloat(100), "Y": CGFloat(50), "Width": CGFloat(1200), "Height": CGFloat(800)],
            ],
        ]

        XCTAssertFalse(
            WindowCapture.shouldCaptureWindowGroup(for: processIdentifier, from: windows)
        )
    }

    func testPanelConfiguration() {
        let panel = makePanel(contentView: NSView())

        XCTAssertTrue(panel is OpenScreenPanel)
        XCTAssertEqual(panel.level, .floating)
        XCTAssertTrue(panel.isFloatingPanel)
        XCTAssertFalse(panel.hidesOnDeactivate)
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.backgroundColor, .clear)
        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel))
        XCTAssertTrue(panel.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertTrue(panel.canBecomeKey)
        XCTAssertFalse(panel.canBecomeMain)
        XCTAssertTrue(panel.isMovableByWindowBackground)
        XCTAssertEqual(panel.frame.width, 420, accuracy: 0.1)
        XCTAssertLessThanOrEqual(panel.frame.height, 720)
    }

    func testPanelHostsOnlySwiftUIContent() {
        let content = NSView()
        let panel = makePanel(contentView: content)

        XCTAssertIdentical(panel.contentView, content)
        XCTAssertEqual(content.alphaValue, 1, accuracy: 0.01)
    }

    func testChatViewDoesNotEmbedVisualEffectView() {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let hostingView = NSHostingView(rootView: ChatView(viewModel: viewModel))
        hostingView.frame = NSRect(x: 0, y: 0, width: 420, height: 720)
        hostingView.layoutSubtreeIfNeeded()

        XCTAssertNil(firstDescendant(of: NSVisualEffectView.self, in: hostingView))
    }

    private func firstDescendant<T: NSView>(of type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        return view.subviews.lazy.compactMap { self.firstDescendant(of: type, in: $0) }.first
    }
}
