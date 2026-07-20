import AppKit
import XCTest
@testable import OpenScreen

@MainActor
final class PanelControllerTests: XCTestCase {
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
}
