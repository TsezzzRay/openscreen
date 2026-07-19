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

    func testCancelRequestEncoding() throws {
        let requestID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let targetID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
        let data = try AgentRequest.cancel(
            requestID: requestID,
            sessionID: sessionID,
            targetRequestID: targetID
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "cancel")
        XCTAssertEqual(object["sessionId"] as? String, sessionID.uuidString)
        XCTAssertEqual(object["targetRequestId"] as? String, targetID.uuidString)
    }

    func testRecordCancelledAttemptEncoding() throws {
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let data = try AgentRequest.recordAttempt(
            requestID: UUID(),
            sessionID: sessionID,
            text: "Stop before capture",
            status: .cancelled
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let input = try XCTUnwrap(object["input"] as? [String: String])

        XCTAssertEqual(object["type"] as? String, "record_attempt")
        XCTAssertEqual(object["status"] as? String, "cancelled")
        XCTAssertEqual(input["text"], "Stop before capture")
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

    func testAgentErrorsUseStableUserMessages() {
        XCTAssertEqual(
            AgentClientError.requestFailed("provider secret").errorDescription,
            "Request failed. Please retry."
        )
        XCTAssertEqual(
            AgentClientError.processExited.errorDescription,
            "The agent stopped. Restart OpenScreen and try again."
        )
        XCTAssertEqual(
            AgentClientError.invalidResponse.errorDescription,
            "Request failed. Please retry."
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

    func testMarkdownDocumentPreservesRequestedBlockTypes() {
        let document = MarkdownDocument("""
        # Heading

        Intro with [safe link](https://example.com) and `inline code`.

        - First
          - Nested

        1. Ordered

        ```swift
        let first = 1
        ```

        ```json
        {"second": 2}
        ```
        """)

        XCTAssertEqual(document.blocks.map(\.kind), [
            .heading(level: 1),
            .paragraph,
            .listItem(marker: "•", depth: 0),
            .listItem(marker: "•", depth: 1),
            .listItem(marker: "1.", depth: 0),
            .codeBlock(language: "swift"),
            .codeBlock(language: "json"),
        ])
        XCTAssertEqual(
            document.blocks.map { String($0.content.characters) },
            [
                "Heading",
                "Intro with safe link and inline code.",
                "First",
                "Nested",
                "Ordered",
                "let first = 1\n",
                "{\"second\": 2}\n",
            ]
        )
        XCTAssertTrue(
            document.blocks[1].content.runs.contains {
                $0.inlinePresentationIntent?.contains(.code) == true
            }
        )
    }

    func testMarkdownDocumentKeepsOnlyWebLinks() {
        let document = MarkdownDocument(
            "[web](https://example.com) [file](file:///tmp/private) [app](custom://open)"
        )
        let links = document.blocks[0].content.runs.compactMap(\.link)

        XCTAssertEqual(links, [URL(string: "https://example.com")!])
    }

    func testMarkdownDocumentHandlesIncompleteStreamingCodeFence() {
        let document = MarkdownDocument("```swift\nlet value = 1")

        XCTAssertEqual(document.blocks.map(\.kind), [.codeBlock(language: "swift")])
        XCTAssertEqual(String(document.blocks[0].content.characters), "let value = 1\n")
    }

    func testChatScrollTriggerTracksVisibleMessageChanges() {
        let sessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let turnID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        func trigger(
            sessionID: UUID? = sessionID,
            reasoningLength: Int = 0,
            answerLength: Int = 0,
            status: ChatTurnStatus = .requesting,
            turnError: String? = nil,
            sessionError: String? = nil
        ) -> ChatScrollTrigger {
            ChatScrollTrigger(
                sessionID: sessionID,
                turnID: turnID,
                turnCount: 1,
                reasoningLength: reasoningLength,
                answerLength: answerLength,
                status: status,
                turnError: turnError,
                sessionError: sessionError
            )
        }
        let base = trigger()

        XCTAssertNotEqual(base, trigger(reasoningLength: 1))
        XCTAssertNotEqual(base, trigger(answerLength: 1))
        XCTAssertNotEqual(base, trigger(status: .completed))
        XCTAssertNotEqual(base, trigger(turnError: "Failed"))
        XCTAssertNotEqual(base, trigger(sessionError: "Couldn't load chats"))
        XCTAssertNotEqual(base, trigger(sessionID: UUID()))
    }

    func testChatScrollPositionUsesBottomThreshold() {
        XCTAssertTrue(ChatScrollPosition.isAtBottom(contentHeight: 1_000, visibleMaxY: 980))
        XCTAssertFalse(ChatScrollPosition.isAtBottom(contentHeight: 1_000, visibleMaxY: 950))
    }

    func testChatScrollPositionPausesAsSoonAsUserScrolls() {
        XCTAssertFalse(ChatScrollPosition.followsLatest(
            current: true,
            oldPhase: .idle,
            newPhase: .interacting,
            contentHeight: 1_000,
            visibleMaxY: 1_000
        ))
        XCTAssertTrue(ChatScrollPosition.followsLatest(
            current: false,
            oldPhase: .interacting,
            newPhase: .idle,
            contentHeight: 1_000,
            visibleMaxY: 980
        ))
        XCTAssertFalse(ChatScrollPosition.followsLatest(
            current: false,
            oldPhase: .interacting,
            newPhase: .idle,
            contentHeight: 1_000,
            visibleMaxY: 900
        ))
    }

    func testChatViewFollowsLongMarkdownThroughStreamingAndSessionSwitch() async throws {
        let viewModel = ChatViewModel(
            agentClient: AgentClient(),
            windowCapture: WindowCapture()
        )
        let hostingView = NSHostingView(rootView: ChatView(viewModel: viewModel))
        hostingView.frame = NSRect(x: 0, y: 0, width: 420, height: 720)
        let window = NSWindow(
            contentRect: hostingView.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = hostingView
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        hostingView.layoutSubtreeIfNeeded()

        let firstSessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let firstTurnID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let complexMarkdown = String(repeating: "Long paragraph for scrolling.\n\n", count: 80) + """
        # Details

        - First item
        - Second item with `inline code`

        ```swift
        let first = 1
        ```

        ```json
        {"second": 2}
        ```
        """
        viewModel.apply(.init(
            id: firstSessionID,
            title: "Long response",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            turns: [.init(
                id: firstTurnID,
                user: "Show details",
                assistant: complexMarkdown,
                reasoning: "Checking the current screen",
                status: .generating,
                error: nil
            )]
        ))
        try await Task.sleep(for: .milliseconds(300))
        hostingView.layoutSubtreeIfNeeded()

        let scrollView = try XCTUnwrap(chatScrollView(in: hostingView))
        assertAtBottom(scrollView)

        viewModel.apply(
            .init(sessionID: firstSessionID, type: .answerDelta, delta: "\nStreaming tail"),
            sessionID: firstSessionID,
            turnID: firstTurnID
        )
        try await Task.sleep(for: .milliseconds(100))
        hostingView.layoutSubtreeIfNeeded()
        assertAtBottom(scrollView)

        let secondSessionID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
        let failedTurnID = UUID(uuidString: "00000000-0000-0000-0000-000000000004")!
        viewModel.apply(.init(
            id: secondSessionID,
            title: "Failed retry",
            createdAt: "2026-07-20T00:00:00.000Z",
            updatedAt: "2026-07-20T00:00:00.000Z",
            turns: [.init(
                id: failedTurnID,
                user: "Retry this",
                assistant: String(repeating: "Previous output\n\n", count: 80),
                reasoning: nil,
                status: .failed,
                error: "Request failed. Please retry."
            )]
        ))
        try await Task.sleep(for: .milliseconds(300))
        hostingView.layoutSubtreeIfNeeded()
        assertAtBottom(scrollView)

        viewModel.retry(turnID: failedTurnID)
        XCTAssertEqual(viewModel.draft, "Retry this")
        viewModel.startTurn(
            sessionID: secondSessionID,
            id: UUID(),
            question: viewModel.draft
        )
        try await Task.sleep(for: .milliseconds(100))
        hostingView.layoutSubtreeIfNeeded()
        assertAtBottom(scrollView)
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

    private func chatScrollView(in view: NSView) -> NSScrollView? {
        descendants(of: NSScrollView.self, in: view)
            .filter { $0.frame.height > 100 }
            .max { $0.frame.height < $1.frame.height }
    }

    private func descendants<T: NSView>(of type: T.Type, in view: NSView) -> [T] {
        let current = (view as? T).map { [$0] } ?? []
        return current + view.subviews.flatMap { descendants(of: type, in: $0) }
    }

    private func assertAtBottom(
        _ scrollView: NSScrollView,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let documentView = scrollView.documentView else {
            return XCTFail("Missing scroll document view", file: file, line: line)
        }
        XCTAssertLessThanOrEqual(
            documentView.bounds.maxY - scrollView.documentVisibleRect.maxY,
            2,
            file: file,
            line: line
        )
    }
}
