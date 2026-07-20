import AppKit
import XCTest
@testable import OpenScreen

@MainActor
final class WindowCaptureTests: XCTestCase {
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
}
