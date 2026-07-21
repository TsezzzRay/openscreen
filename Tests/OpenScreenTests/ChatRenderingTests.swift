import AppKit
import SwiftUI
import XCTest
@testable import OpenScreen

@MainActor
final class ChatRenderingTests: XCTestCase {
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

    func testMarkdownCodeCopyWritesPlainText() {
        let pasteboard = NSPasteboard(name: .init("OpenScreenTests.CodeCopy"))
        pasteboard.clearContents()

        MarkdownCodeActions.copy("let value = 1", to: pasteboard)

        XCTAssertEqual(pasteboard.string(forType: .string), "let value = 1")
    }

    func testCompletedStatusIsQuietWhileActionableStatusesRemainVisible() {
        XCTAssertFalse(ChatTurnStatus.completed.showsInTranscript)
        XCTAssertTrue(ChatTurnStatus.generating.showsInTranscript)
        XCTAssertTrue(ChatTurnStatus.failed.showsInTranscript)
        XCTAssertTrue(ChatTurnStatus.cancelled.showsInTranscript)
        XCTAssertTrue(ChatTurnStatus.interrupted.showsInTranscript)
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
        let scrollView = try await waitForChatScrollView(in: hostingView)
        try await waitUntilAtBottom(scrollView, layoutRoot: hostingView)

        viewModel.apply(
            .init(sessionID: firstSessionID, type: .answerDelta, delta: "\nStreaming tail"),
            sessionID: firstSessionID,
            turnID: firstTurnID
        )
        try await waitUntilAtBottom(scrollView, layoutRoot: hostingView)

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
        try await waitUntilAtBottom(scrollView, layoutRoot: hostingView)

        viewModel.retry(turnID: failedTurnID)
        XCTAssertEqual(viewModel.draft, "Retry this")
        viewModel.startTurn(
            sessionID: secondSessionID,
            id: UUID(),
            question: viewModel.draft
        )
        try await waitUntilAtBottom(scrollView, layoutRoot: hostingView)
    }

    func testChatViewUsesNativeMaterial() {
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
        let materialView = firstDescendant(of: NSVisualEffectView.self, in: hostingView)
        XCTAssertNotNil(materialView)
        XCTAssertEqual(materialView?.alphaValue ?? 0, 0.68, accuracy: 0.01)
    }

    func testChatViewUsesTracklessNativeScroller() async throws {
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

        let scrollView = try await waitForChatScrollView(in: hostingView)
        for _ in 0..<50 where !(scrollView.verticalScroller is ChatScroller) {
            hostingView.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(scrollView.hasVerticalScroller)
        XCTAssertFalse(scrollView.autohidesScrollers)
        XCTAssertTrue(scrollView.verticalScroller is ChatScroller)
        XCTAssertEqual(scrollView.verticalScroller?.alphaValue, 0)

        NotificationCenter.default.post(
            name: NSScrollView.willStartLiveScrollNotification,
            object: scrollView
        )
        XCTAssertEqual(scrollView.verticalScroller?.alphaValue, 1)

        NotificationCenter.default.post(
            name: NSScrollView.didEndLiveScrollNotification,
            object: scrollView
        )
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(scrollView.verticalScroller?.alphaValue ?? 1, 0, accuracy: 0.01)
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

    private func waitForChatScrollView(in view: NSView) async throws -> NSScrollView {
        for _ in 0..<50 {
            view.layoutSubtreeIfNeeded()
            if let scrollView = chatScrollView(in: view) {
                return scrollView
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        return try XCTUnwrap(chatScrollView(in: view))
    }

    private func waitUntilAtBottom(
        _ scrollView: NSScrollView,
        layoutRoot: NSView
    ) async throws {
        for _ in 0..<50 {
            layoutRoot.layoutSubtreeIfNeeded()
            if let documentView = scrollView.documentView,
               documentView.bounds.maxY - scrollView.documentVisibleRect.maxY <= 2 {
                return
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        assertAtBottom(scrollView)
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
