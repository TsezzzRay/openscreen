import XCTest
@testable import OpenScreenObservationHelper

final class ObservationHelperTests: XCTestCase {
    func testHelperProtocolVersionIncludesActivityMonitoringConfiguration() {
        XCTAssertEqual(helperProtocolVersion, 3)
    }

    func testCaptureAdmissionAllowsOnlyOneActiveRequest() {
        var admission = CaptureAdmission()

        XCTAssertTrue(admission.begin(requestIdentifier: "capture-1"))
        XCTAssertFalse(admission.begin(requestIdentifier: "capture-2"))
        admission.end(requestIdentifier: "capture-2")
        XCTAssertFalse(admission.begin(requestIdentifier: "capture-3"))
        admission.end(requestIdentifier: "capture-1")
        XCTAssertTrue(admission.begin(requestIdentifier: "capture-4"))
    }

    func testActivitySignalCoalescingThrottlesAndFlushesTrailingActivity() {
        var state = ActivitySignalCoalescingState(intervalMilliseconds: 250)

        XCTAssertTrue(state.record(atMilliseconds: 0))
        XCTAssertFalse(state.flush(atMilliseconds: 250))
        XCTAssertTrue(state.record(atMilliseconds: 300))
        XCTAssertFalse(state.record(atMilliseconds: 400))
        XCTAssertFalse(state.flush(atMilliseconds: 649))
        XCTAssertTrue(state.flush(atMilliseconds: 650))
        XCTAssertFalse(state.flush(atMilliseconds: 900))
        XCTAssertTrue(state.record(atMilliseconds: 901))
        XCTAssertFalse(state.record(atMilliseconds: 1_000))
        state.reset()
        XCTAssertFalse(state.flush(atMilliseconds: 1_250))
        XCTAssertTrue(state.record(atMilliseconds: 1_251))
    }

    func testHelperCommandDecodesConfiguration() throws {
        let line = """
        {"protocolVersion":3,"requestId":"configure-1","type":"configure","excludedProcessIdentifiers":[10,20],"excludedBundleIdentifiers":["com.openscreen.app"],"configuration":{"activityMonitoring":{"coalescingIntervalMilliseconds":250},"accessibility":{"maxDepth":40,"maxNodes":5000,"timeoutMilliseconds":2000,"maxTextLength":8192},"screenshot":{"maxWidth":1920,"jpegQuality":0.85},"visualMonitoring":{"maxWidth":320,"sampleIntervalMilliseconds":500,"queueDepth":2,"changeThreshold":0.015,"signatureWidth":32,"signatureHeight":18},"windowSelection":{"minimumWidth":160,"minimumHeight":120,"maximumAspectRatio":4}}}
        """

        let command = try HelperCommand.decode(line)

        XCTAssertEqual(command.protocolVersion, 3)
        XCTAssertEqual(command.requestId, "configure-1")
        XCTAssertEqual(command.type, .configure)
        XCTAssertEqual(command.excludedProcessIdentifiers, [10, 20])
        XCTAssertEqual(command.excludedBundleIdentifiers, ["com.openscreen.app"])
        XCTAssertEqual(command.configuration, testObservationConfiguration)
    }

    func testHelperCommandDecodesCaptureSignal() throws {
        let line = """
        {"protocolVersion":3,"requestId":"capture-1","type":"capture","signal":{"kind":"mouseClick","occurredAt":"2026-07-27T00:00:00.000Z","window":{"processIdentifier":100,"bundleIdentifier":"com.example.Editor","applicationName":"Editor","windowIdentifier":7,"title":"Document","frame":{"x":0,"y":0,"width":1200,"height":800}}}}
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

        XCTAssertEqual(object["protocolVersion"] as? Int, 3)
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
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        )

        XCTAssertEqual(window?.windowIdentifier, 2)
        XCTAssertEqual(window?.title, "Document")
        XCTAssertEqual(window?.frame?.x, 100)
        XCTAssertEqual(window?.frame?.height, 800)
    }

    func testWindowResolverUsesConfiguredNormalWindowThresholds() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(1),
                kCGWindowBounds as String: [
                    "Width": CGFloat(200),
                    "Height": CGFloat(200),
                ],
            ],
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(2),
                kCGWindowBounds as String: [
                    "Width": CGFloat(1200),
                    "Height": CGFloat(800),
                ],
            ],
        ]
        let strictSelection = NativeObservationConfiguration.WindowSelection(
            minimumWidth: 1300,
            minimumHeight: 120,
            maximumAspectRatio: 4
        )

        let window = WindowResolver.selectWindow(
            processIdentifier: processIdentifier,
            bundleIdentifier: nil,
            applicationName: "Editor",
            from: windows,
            configuration: strictSelection
        )

        XCTAssertEqual(window?.windowIdentifier, 1)
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

private let testObservationConfiguration = NativeObservationConfiguration(
    activityMonitoring: .init(coalescingIntervalMilliseconds: 250),
    accessibility: .init(
        maxDepth: 40,
        maxNodes: 5_000,
        timeoutMilliseconds: 2_000,
        maxTextLength: 8_192
    ),
    screenshot: .init(maxWidth: 1_920, jpegQuality: 0.85),
    visualMonitoring: .init(
        maxWidth: 320,
        sampleIntervalMilliseconds: 500,
        queueDepth: 2,
        changeThreshold: 0.015,
        signatureWidth: 32,
        signatureHeight: 18
    ),
    windowSelection: .init(
        minimumWidth: 160,
        minimumHeight: 120,
        maximumAspectRatio: 4
    )
)
