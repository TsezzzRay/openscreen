import AppKit
import SwiftUI
import XCTest
@testable import OpenScreen

@MainActor
final class ChatRenderingTests: XCTestCase {
    func testComposerExtractsEveryPastedImage() throws {
        let pasteboard = NSPasteboard(name: .init("OpenScreenTests-\(UUID().uuidString)"))
        pasteboard.clearContents()
        let images = [12, 18].map { side in
            let image = NSImage(size: NSSize(width: side, height: side))
            image.lockFocus()
            NSColor.systemBlue.setFill()
            NSRect(x: 0, y: 0, width: side, height: side).fill()
            image.unlockFocus()
            return image
        }
        XCTAssertTrue(pasteboard.writeObjects(images))

        XCTAssertEqual(SubmitTextView.images(from: pasteboard).count, 2)
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

    func testMarkdownCodeCopyWritesPlainText() {
        let pasteboard = NSPasteboard(name: .init("OpenScreenTests.CodeCopy"))
        pasteboard.clearContents()

        MarkdownCodeActions.copy("let value = 1", to: pasteboard)

        XCTAssertEqual(pasteboard.string(forType: .string), "let value = 1")
    }

    func testMarkdownCodeBlockUsesRoundedFullWidthBackground() throws {
        let textView = SelectableMarkdownTextView()
        textView.setFrameSize(NSSize(width: 300, height: 200))
        textView.render(
            MarkdownDocument("```swift\nlet value = 1\n```"),
            alignment: .left,
            role: .body
        )

        let path = try XCTUnwrap(textView.codeBlockBackgroundPaths().first)
        let layoutManager = try XCTUnwrap(textView.layoutManager)
        let textContainer = try XCTUnwrap(textView.textContainer)
        let codeRange = (textView.string as NSString).range(of: "let value = 1")
        let codeBounds = layoutManager.boundingRect(
            forGlyphRange: layoutManager.glyphRange(
                forCharacterRange: codeRange,
                actualCharacterRange: nil
            ),
            in: textContainer
        )

        XCTAssertEqual(path.bounds.minX, 0, accuracy: 0.01)
        XCTAssertEqual(path.bounds.width, 300, accuracy: 0.01)
        XCTAssertGreaterThan(path.elementCount, 5)
        XCTAssertGreaterThanOrEqual(codeBounds.minX - path.bounds.minX, 8)
        XCTAssertGreaterThanOrEqual(codeBounds.minY - path.bounds.minY, 6)
        XCTAssertGreaterThanOrEqual(path.bounds.maxY - codeBounds.maxY, 6)
    }

    func testMarkdownInlineCodeUsesCustomRoundedBackground() throws {
        let textView = SelectableMarkdownTextView()
        textView.setFrameSize(NSSize(width: 300, height: 100))
        textView.render(
            MarkdownDocument("Open `session.ts` now."),
            alignment: .left,
            role: .body
        )
        let range = (textView.string as NSString).range(of: "session.ts")
        let storage = try XCTUnwrap(textView.textStorage)

        XCTAssertNotNil(storage.attribute(
            NSAttributedString.Key("OpenScreenInlineCodeBackground"),
            at: range.location,
            effectiveRange: nil
        ))
        XCTAssertNil(storage.attribute(
            .backgroundColor,
            at: range.location,
            effectiveRange: nil
        ))
    }

    func testMarkdownInlineCodeAtLeadingEdgeKeepsBackgroundInsideTextBounds() throws {
        let textView = SelectableMarkdownTextView()
        textView.setFrameSize(NSSize(width: 300, height: 100))
        textView.render(
            MarkdownDocument("`npm run` starts the command."),
            alignment: .left,
            role: .body
        )
        let layoutManager = try XCTUnwrap(
            textView.layoutManager as? GlyphOnlySelectionLayoutManager
        )
        let glyphRange = layoutManager.glyphRange(
            forCharacterRange: NSRange(location: 0, length: textView.string.utf16.count),
            actualCharacterRange: nil
        )

        let rects = layoutManager.inlineCodeBackgroundRects(
            forGlyphRange: glyphRange,
            at: textView.textContainerOrigin
        )

        XCTAssertEqual(try XCTUnwrap(rects.first).minX, 0, accuracy: 0.01)
    }

    func testMarkdownTextViewSelectsAcrossParagraphs() {
        let textView = SelectableMarkdownTextView()
        textView.setFrameSize(NSSize(width: 300, height: 200))
        textView.render(
            MarkdownDocument("First paragraph.\n\nSecond paragraph."),
            alignment: .left,
            role: .body
        )

        textView.setSelectedRange(NSRange(location: 0, length: textView.string.utf16.count))

        XCTAssertEqual(textView.string, "First paragraph.\n\nSecond paragraph.")
        XCTAssertEqual(textView.selectedRange().length, textView.string.utf16.count)
    }

    func testMarkdownSelectionHighlightsOnlyLaidOutText() throws {
        let textView = SelectableMarkdownTextView()
        textView.setFrameSize(NSSize(width: 300, height: 200))
        textView.render(
            MarkdownDocument("First paragraph.\n\nSecond paragraph."),
            alignment: .left,
            role: .body
        )

        let layoutManager = try XCTUnwrap(
            textView.layoutManager as? GlyphOnlySelectionLayoutManager
        )
        let characterRange = NSRange(location: 0, length: textView.string.utf16.count)
        let rects = layoutManager.glyphOnlySelectionRects(
            from: [NSRect(x: 0, y: 0, width: 300, height: 42)],
            forCharacterRange: characterRange
        )

        XCTAssertEqual(rects.count, 2)
        XCTAssertLessThan(rects[0].width, 300)
        XCTAssertGreaterThan(rects[1].minY, rects[0].maxY)
    }

    func testChatComposerHeightGrowsUntilMaximum() {
        XCTAssertEqual(ChatComposerLayout.height(for: 20), 36)
        XCTAssertEqual(ChatComposerLayout.height(for: 72), 72)
        XCTAssertEqual(ChatComposerLayout.height(for: 180), 120)
        XCTAssertEqual(ChatComposerLayout.transcriptBottomPadding(for: 36), 140)
        XCTAssertEqual(ChatComposerLayout.transcriptBottomPadding(for: 120), 224)
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

    func testScreenshotPreviewStatePresentsAndDismissesImage() {
        let url = URL(fileURLWithPath: "/tmp/screenshot.png")
        var state = ChatImagePreviewState()

        state.present(url)
        XCTAssertEqual(state.url, url)

        state.dismiss()
        XCTAssertNil(state.url)
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

        let composerScrollView = try XCTUnwrap(
            descendants(of: NSScrollView.self, in: hostingView)
                .first { $0 !== scrollView && $0.frame.height <= ChatComposerLayout.maximumHeight }
        )
        XCTAssertTrue(composerScrollView.verticalScroller is ChatScroller)
        XCTAssertEqual(composerScrollView.verticalScroller?.alphaValue, 0)

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
