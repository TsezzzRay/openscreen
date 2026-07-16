import AppKit
import XCTest
@testable import OpenScreen

@MainActor
final class PanelTests: XCTestCase {
    func testPanelStaysAboveOtherApplications() {
        let panel = makePanel()

        XCTAssertEqual(panel.level, .floating)
        XCTAssertTrue(panel.isFloatingPanel)
        XCTAssertFalse(panel.hidesOnDeactivate)
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.backgroundColor, .clear)
        XCTAssertTrue(panel.collectionBehavior.contains(.canJoinAllSpaces))
        XCTAssertTrue(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        XCTAssertEqual(panel.frame.width, 240, accuracy: 0.1)
        XCTAssertEqual(panel.frame.height, 120, accuracy: 0.1)
    }
}
