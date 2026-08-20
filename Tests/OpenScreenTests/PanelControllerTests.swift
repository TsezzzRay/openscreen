import AppKit
import XCTest
@testable import OpenScreen

@MainActor
final class PanelControllerTests: XCTestCase {
    func testPanelRoutesCommandPasteToFirstResponder() throws {
        let textView = EditingCommandTrackingTextView()
        let panel = makePanel(contentView: textView)
        XCTAssertTrue(panel.makeFirstResponder(textView))
        let event = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .command,
            timestamp: 0,
            windowNumber: panel.windowNumber,
            context: nil,
            characters: "v",
            charactersIgnoringModifiers: "v",
            isARepeat: false,
            keyCode: 9
        ))

        XCTAssertTrue(panel.performKeyEquivalent(with: event))
        XCTAssertTrue(textView.didPaste)
    }

    func testPanelRoutesCommandCopyToFirstResponder() throws {
        let textView = EditingCommandTrackingTextView()
        let panel = makePanel(contentView: textView)
        XCTAssertTrue(panel.makeFirstResponder(textView))
        let event = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .command,
            timestamp: 0,
            windowNumber: panel.windowNumber,
            context: nil,
            characters: "c",
            charactersIgnoringModifiers: "c",
            isARepeat: false,
            keyCode: 8
        ))

        XCTAssertTrue(panel.performKeyEquivalent(with: event))
        XCTAssertTrue(textView.didCopy)
    }

    func testPanelConfiguration() {
        let panel = makePanel(contentView: NSView())

        XCTAssertTrue(panel is OpenScreenPanel)
        XCTAssertEqual(panel.level, .floating)
        XCTAssertTrue(panel.isFloatingPanel)
        XCTAssertFalse(panel.hidesOnDeactivate)
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.backgroundColor, .clear)
        XCTAssertTrue(
            panel.styleMask.contains(.nonactivatingPanel),
            "The chat panel must not steal foreground-app focus from whatever the user was in — "
                + "screenpipe's accessibility capture only ever walks the frontmost app, so activating "
                + "OpenScreen on every panel summon meant the assistant could only ever see its own "
                + "chat window instead of the app behind it"
        )
        XCTAssertTrue(panel.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertTrue(panel.canBecomeKey)
        XCTAssertFalse(panel.canBecomeMain)
        XCTAssertTrue(panel.isMovableByWindowBackground)
        XCTAssertEqual(panel.frame.width, 420, accuracy: 0.1)
        XCTAssertLessThanOrEqual(panel.frame.height, 720)
    }

    func testTogglePanelNeverForcesApplicationActivation() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: repositoryRoot
                .appendingPathComponent("Sources/OpenScreen/App/PanelController.swift"),
            encoding: .utf8
        )

        // Forcing activation here previously stole focus from whatever app the
        // user was in every time the panel was summoned — see
        // testPanelConfiguration's .nonactivatingPanel assertion for why.
        XCTAssertFalse(source.contains("NSApp.activate()"))
    }

    func testPanelHostsOnlySwiftUIContent() {
        let content = NSView()
        let panel = makePanel(contentView: content)

        XCTAssertIdentical(panel.contentView, content)
        XCTAssertEqual(content.alphaValue, 1, accuracy: 0.01)
    }
}

private final class EditingCommandTrackingTextView: NSTextView {
    private(set) var didPaste = false
    private(set) var didCopy = false

    override func paste(_ sender: Any?) {
        didPaste = true
    }

    override func copy(_ sender: Any?) {
        didCopy = true
    }
}
