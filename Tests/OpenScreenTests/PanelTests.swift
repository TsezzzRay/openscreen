import AppKit
import SwiftUI
import XCTest
@testable import OpenScreen

@MainActor
final class PanelTests: XCTestCase {
    func testAgentRequestEncoding() throws {
        let data = try AgentRequest(text: "What is on screen?", imagePath: "/tmp/window.png").encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: [String: String]]
        )

        XCTAssertEqual(object["input"]?["text"], "What is on screen?")
        XCTAssertEqual(object["input"]?["image"], "/tmp/window.png")
        XCTAssertEqual(data.last, Character("\n").asciiValue)
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
