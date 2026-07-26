import XCTest
@testable import OpenScreenObservationHelper

final class ObservationHelperTests: XCTestCase {
    func testHelperCommandDecodesConfiguration() throws {
        let line = """
        {"protocolVersion":1,"requestId":"configure-1","type":"configure","excludedProcessIdentifiers":[10,20],"excludedBundleIdentifiers":["com.openscreen.app"]}
        """

        let command = try HelperCommand.decode(line)

        XCTAssertEqual(command.protocolVersion, 1)
        XCTAssertEqual(command.requestId, "configure-1")
        XCTAssertEqual(command.type, .configure)
        XCTAssertEqual(command.excludedProcessIdentifiers, [10, 20])
        XCTAssertEqual(command.excludedBundleIdentifiers, ["com.openscreen.app"])
    }

    func testHelperCommandDecodesCaptureSignal() throws {
        let line = """
        {"protocolVersion":1,"requestId":"capture-1","type":"capture","signal":{"kind":"mouseClick","occurredAt":"2026-07-27T00:00:00.000Z","window":{"processIdentifier":100,"bundleIdentifier":"com.example.Editor","applicationName":"Editor","windowIdentifier":7,"title":"Document","frame":{"x":0,"y":0,"width":1200,"height":800}}}}
        """

        let command = try HelperCommand.decode(line)

        XCTAssertEqual(command.type, .capture)
        XCTAssertEqual(command.signal?.kind, .mouseClick)
        XCTAssertEqual(command.signal?.window.windowIdentifier, 7)
        XCTAssertEqual(command.signal?.window.frame?.width, 1200)
    }

    func testHelperOutputUsesNewlineDelimitedJSON() throws {
        let data = try HelperOutput.ready(processIdentifier: 42).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["protocolVersion"] as? Int, 1)
        XCTAssertEqual(object["type"] as? String, "ready")
        XCTAssertEqual(object["processIdentifier"] as? Int, 42)
        XCTAssertEqual(data.last, 0x0A)
    }

    func testSelfCaptureFilterExcludesKnownProcessesAndBundleIdentifiers() {
        let filter = SelfCaptureFilter(
            processIdentifiers: [42, 84],
            bundleIdentifiers: ["com.openscreen.app"]
        )

        XCTAssertTrue(filter.contains(processIdentifier: 42, bundleIdentifier: nil))
        XCTAssertTrue(
            filter.contains(
                processIdentifier: 100,
                bundleIdentifier: "com.openscreen.app"
            )
        )
        XCTAssertFalse(
            filter.contains(
                processIdentifier: 100,
                bundleIdentifier: "com.example.Editor"
            )
        )
    }

    func testSecureAccessibilityValuesAreRedacted() {
        XCTAssertEqual(
            sanitizeAccessibilityValue(
                "hunter2",
                role: "AXTextField",
                subrole: "AXSecureTextField"
            ),
            "[REDACTED]"
        )
        XCTAssertEqual(
            sanitizeAccessibilityValue(
                "ordinary text",
                role: "AXTextField",
                subrole: nil
            ),
            "ordinary text"
        )
        XCTAssertNil(normalizeAccessibilityText(""))
        XCTAssertNil(normalizeAccessibilityText("   \n"))
    }

    func testWindowResolverSelectsTheNormalFrontWindowAndPreservesMetadata() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(1),
                kCGWindowName as String: "Toolbar",
                kCGWindowBounds as String: [
                    "X": CGFloat(0),
                    "Y": CGFloat(0),
                    "Width": CGFloat(1600),
                    "Height": CGFloat(40),
                ],
            ],
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(2),
                kCGWindowName as String: "Document",
                kCGWindowBounds as String: [
                    "X": CGFloat(100),
                    "Y": CGFloat(80),
                    "Width": CGFloat(1200),
                    "Height": CGFloat(800),
                ],
            ],
        ]

        let window = WindowResolver.selectWindow(
            processIdentifier: processIdentifier,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            from: windows
        )

        XCTAssertEqual(window?.windowIdentifier, 2)
        XCTAssertEqual(window?.title, "Document")
        XCTAssertEqual(window?.frame?.x, 100)
        XCTAssertEqual(window?.frame?.height, 800)
    }

    func testVisualSignatureDownsamplesBGRAFramesToGrayscale() {
        let signature = VisualSignature.make(
            bgraBytes: [
                0, 0, 0, 255,
                255, 255, 255, 255,
            ],
            width: 2,
            height: 1,
            bytesPerRow: 8,
            outputWidth: 2,
            outputHeight: 1
        )

        XCTAssertEqual(signature, [0, 255])
        XCTAssertEqual(
            VisualSignature.distance([0, 0], [255, 255]),
            1,
            accuracy: 0.0001
        )
    }

    func testSnapshotBudgetStopsAtDepthAndNodeLimits() {
        var budget = SnapshotBudget(
            maxDepth: 1,
            maxNodes: 2,
            deadline: Date().addingTimeInterval(10)
        )

        XCTAssertTrue(budget.consume(depth: 0))
        XCTAssertTrue(budget.consume(depth: 1))
        XCTAssertFalse(budget.consume(depth: 2))
        XCTAssertTrue(budget.truncated)
        XCTAssertEqual(budget.nodeCount, 2)
    }
}
