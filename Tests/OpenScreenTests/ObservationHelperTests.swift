import XCTest
@testable import ObservationHelper

final class ObservationHelperTests: XCTestCase {
    func testCaptureAdmissionAllowsOnlyOneActiveRequest() {
        var admission = CaptureGate()

        XCTAssertTrue(admission.begin(requestIdentifier: "capture-1"))
        XCTAssertFalse(admission.begin(requestIdentifier: "capture-2"))
        admission.end(requestIdentifier: "capture-2")
        XCTAssertFalse(admission.begin(requestIdentifier: "capture-3"))
        admission.end(requestIdentifier: "capture-1")
        XCTAssertTrue(admission.begin(requestIdentifier: "capture-4"))
    }

    func testActivitySignalCoalescingThrottlesAndFlushesTrailingActivity() {
        var state = Coalescer(intervalMilliseconds: 250)

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

    @MainActor
    func testMonitorDoesNotDependOnProtocolTransport() {
        let monitor = Monitor(
            onSignal: { _ in },
            onStatus: { _ in }
        )

        monitor.stop()
    }

    @MainActor
    func testNativeSourcesExposeTypedCallbacks() {
        _ = AXSource(onEvent: { _ in }, onStatus: { _ in })
        _ = InputSource(onEvent: { _ in }, onStatus: { _ in })
    }

    func testHelperCommandDecodesConfiguration() throws {
        let line = """
        {"requestId":"configure-1","type":"configure","excludedProcessIdentifiers":[10,20],"excludedBundleIdentifiers":["com.openscreen.app"],"configuration":{"activityMonitoring":{"coalescingIntervalMilliseconds":250},"accessibility":{"maxDepth":40,"maxNodes":5000,"timeoutMilliseconds":2000,"maxTextLength":8192},"screenshot":{"maxWidth":1920,"jpegQuality":0.85},"visualMonitoring":{"maxWidth":320,"sampleIntervalMilliseconds":500,"queueDepth":2,"changeThreshold":0.015,"signatureWidth":32,"signatureHeight":18},"windowSelection":{"minimumWidth":160,"minimumHeight":120,"maximumAspectRatio":4}}}
        """

        let command = try Wire.Command.decode(line)

        guard case .configure(let request) = command else {
            return XCTFail("Expected configure command")
        }
        XCTAssertEqual(request.requestId, "configure-1")
        XCTAssertEqual(request.excludedProcessIdentifiers, [10, 20])
        XCTAssertEqual(request.excludedBundleIdentifiers, ["com.openscreen.app"])
        XCTAssertEqual(request.configuration, testObservationConfiguration)
    }

    func testHelperCommandDecodesExplicitCaptureTarget() throws {
        let line = """
        {"requestId":"capture-1","type":"capture","target":{"processIdentifier":100,"bundleIdentifier":"com.example.Editor","applicationName":"Editor","windowIdentifier":7,"title":"Document","frame":{"x":0,"y":0,"width":1200,"height":800}}}
        """

        let command = try Wire.Command.decode(line)

        guard case .capture(let request) = command else {
            return XCTFail("Expected capture command")
        }
        XCTAssertEqual(request.target.processIdentifier, 100)
        XCTAssertEqual(request.target.windowIdentifier, 7)
        XCTAssertEqual(request.target.frame?.width, 1200)
    }

    func testWindowResolverPreflightRequiresTheFrozenWindowIdentity() {
        let frozen = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Document",
            frame: WindowFrame(x: 100, y: 80, width: 1_200, height: 800)
        )
        let windows: [[String: Any]] = [[
            kCGWindowOwnerPID as String: pid_t(42),
            kCGWindowLayer as String: 0,
            kCGWindowNumber as String: CGWindowID(7),
            kCGWindowName as String: "Document",
            kCGWindowBounds as String: [
                "X": CGFloat(100),
                "Y": CGFloat(80),
                "Width": CGFloat(1_200),
                "Height": CGFloat(800),
            ],
        ]]

        XCTAssertEqual(
            WindowResolver.resolveFrozenTarget(frozen, from: windows)?.windowIdentifier,
            7
        )
        XCTAssertNil(WindowResolver.resolveFrozenTarget(
            WindowMetadata(
                processIdentifier: 43,
                bundleIdentifier: frozen.bundleIdentifier,
                applicationName: frozen.applicationName,
                windowIdentifier: frozen.windowIdentifier,
                title: frozen.title,
                frame: frozen.frame
            ),
            from: windows
        ))
        XCTAssertNil(WindowResolver.resolveFrozenTarget(
            WindowMetadata(
                processIdentifier: frozen.processIdentifier,
                bundleIdentifier: frozen.bundleIdentifier,
                applicationName: frozen.applicationName,
                windowIdentifier: 8,
                title: frozen.title,
                frame: frozen.frame
            ),
            from: windows
        ))
    }

    func testAccessibilityWindowSelectionUsesTheExactCGWindowIdentifier() {
        XCTAssertEqual(
            AXSnapshot.matchingWindowIndex(
                targetWindowIdentifier: 7,
                candidateWindowIdentifiers: [9, 7, 11]
            ),
            1
        )
        XCTAssertNil(AXSnapshot.matchingWindowIndex(
            targetWindowIdentifier: 7,
            candidateWindowIdentifiers: [9, nil, 11]
        ))
        XCTAssertNil(AXSnapshot.matchingWindowIndex(
            targetWindowIdentifier: 7,
            candidateWindowIdentifiers: [7, 7]
        ))
    }

    func testAccessibilityWindowGroupMatchesEachExactCGWindowIdentifier() {
        XCTAssertEqual(
            AXSnapshot.matchingWindowIndices(
                targetWindowIdentifiers: [3, 7, 11],
                candidateWindowIdentifiers: [7, 3, 9]
            ),
            [1, 0, nil]
        )
    }

    func testAccessibilityWindowGroupPreservesFrontToBackWindowOrder() throws {
        let dialog = AccessibilityNode(
            role: "AXWindow",
            subrole: "AXDialog",
            title: "Confirm",
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: true,
            enabled: true,
            selected: nil,
            children: nil
        )
        let document = AccessibilityNode(
            role: "AXWindow",
            subrole: "AXStandardWindow",
            title: "Document",
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: false,
            enabled: true,
            selected: nil,
            children: nil
        )

        let root = AXSnapshot.groupedRoot([dialog, document])

        XCTAssertEqual(root.role, "AXApplication")
        XCTAssertEqual(root.children?.map(\.title), ["Confirm", "Document"])
    }

    func testAccessibilityBatchAttributesKeepNameValueAlignment() throws {
        let mapped = try XCTUnwrap(AXSnapshot.mapBatchValues(
            names: ["AXRole", "AXFocused"],
            values: ["AXButton", true]
        ))

        XCTAssertEqual(mapped["AXRole"] as? String, "AXButton")
        XCTAssertEqual(mapped["AXFocused"] as? Bool, true)
        XCTAssertNil(AXSnapshot.mapBatchValues(
            names: ["AXRole", "AXFocused"],
            values: ["AXButton"]
        ))
    }

    func testHelperOutputUsesNewlineDelimitedJSON() throws {
        let data = try Wire.Output.ready(processIdentifier: 42).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "ready")
        XCTAssertEqual(object["processIdentifier"] as? Int, 42)
        XCTAssertEqual(data.last, 0x0A)
    }

    func testHelperDiagnosticEncodesAStableEventNameAndGeneration() throws {
        let data = try Wire.Output.diagnostic(
            NativeDiagnosticEvent(
                event: .visualStreamStopped,
                reason: "stream_stopped",
                generation: 3,
                windowIdentifier: 7,
                delayMilliseconds: 500
            )
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "diagnostic")
        XCTAssertEqual(object["event"] as? String, "visual.stream_stopped")
        XCTAssertEqual(object["reason"] as? String, "stream_stopped")
        XCTAssertEqual(object["generation"] as? Int, 3)
        XCTAssertEqual(object["windowIdentifier"] as? Int, 7)
        XCTAssertEqual(object["delayMilliseconds"] as? Int, 500)
    }

    func testCaptureResultEncodesValidationTimings() throws {
        let result = NativeCaptureResult(
            startedAt: "2026-08-07T00:00:00.000Z",
            capturedAt: "2026-08-07T00:00:00.000Z",
            validation: CaptureValidation(
                preflightDurationMilliseconds: 2,
                attestationDurationMilliseconds: 1
            ),
            window: WindowMetadata(
                processIdentifier: 42,
                bundleIdentifier: "com.example.Editor",
                applicationName: "Editor",
                windowIdentifier: 7,
                title: "Document",
                frame: nil
            ),
            windowGroup: CaptureWindowGroup(
                processIdentifier: 42,
                rootWindowIdentifier: 7,
                memberWindowIdentifiers: [3],
                frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
            ),
            screenshot: ScreenshotCapture(
                status: .failed,
                durationMilliseconds: 3,
                failureReason: .noDisplay,
                mimeType: nil,
                dataBase64: nil,
                width: nil,
                height: nil
            ),
            accessibility: AccessibilityCapture(
                status: .partial,
                durationMilliseconds: 4,
                snapshot: AccessibilitySnapshot(
                    root: AccessibilityNode(
                        role: "AXWindow",
                        subrole: nil,
                        title: "Document",
                        value: nil,
                        identifier: nil,
                        elementDescription: nil,
                        frame: nil,
                        focused: true,
                        enabled: true,
                        selected: nil,
                        children: nil
                    ),
                    nodeCount: 1,
                    truncated: false
                ),
                failureReason: .targetMismatch,
                windowIdentifiers: [7],
                missingWindowIdentifiers: [3]
            ),
            visualSignature: nil
        )

        let data = try Wire.Output.captureResult(
            requestId: "capture-1",
            result: result
        ).encodedLine()
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let encodedResult = try XCTUnwrap(object["result"] as? [String: Any])
        XCTAssertNotNil(encodedResult["startedAt"] as? String)
        let validation = try XCTUnwrap(
            encodedResult["validation"] as? [String: Any]
        )

        XCTAssertEqual(validation["preflightDurationMilliseconds"] as? Double, 2)
        XCTAssertEqual(validation["attestationDurationMilliseconds"] as? Double, 1)
        let accessibility = try XCTUnwrap(
            encodedResult["accessibility"] as? [String: Any]
        )
        let screenshot = try XCTUnwrap(
            encodedResult["screenshot"] as? [String: Any]
        )
        XCTAssertNotNil(screenshot["completedAt"] as? String)
        XCTAssertEqual(
            screenshot["failureReason"] as? String,
            "no_display"
        )
        XCTAssertNotNil(accessibility["completedAt"] as? String)
        XCTAssertEqual(
            accessibility["failureReason"] as? String,
            "target_mismatch"
        )
        XCTAssertEqual(accessibility["status"] as? String, "partial")
        XCTAssertEqual(accessibility["windowIdentifiers"] as? [Int], [7])
        XCTAssertEqual(accessibility["missingWindowIdentifiers"] as? [Int], [3])
        let windowGroup = try XCTUnwrap(
            encodedResult["windowGroup"] as? [String: Any]
        )
        XCTAssertEqual(windowGroup["rootWindowIdentifier"] as? Int, 7)
        XCTAssertEqual(windowGroup["memberWindowIdentifiers"] as? [Int], [3])
        XCTAssertEqual(CaptureError.targetUnavailable.code, "target_unavailable")
        XCTAssertEqual(
            CaptureError.targetChangedDuringCapture.code,
            "target_changed_during_capture"
        )
        XCTAssertEqual(
            TargetError.noWindow.screenshotFailureReason,
            .noWindow
        )
        XCTAssertEqual(
            TargetError.noDisplay.screenshotFailureReason,
            .noDisplay
        )
    }

    func testSelfFilterExcludesKnownProcessesAndBundleIdentifiers() {
        let filter = SelfFilter(
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
            AXSnapshot.sanitize(
                "hunter2",
                role: "AXTextField",
                subrole: "AXSecureTextField"
            ),
            "[REDACTED]"
        )
        XCTAssertEqual(
            AXSnapshot.sanitize(
                "ordinary text",
                role: "AXTextField",
                subrole: nil
            ),
            "ordinary text"
        )
        XCTAssertNil(AXSnapshot.normalize(""))
        XCTAssertNil(AXSnapshot.normalize("   \n"))
    }

    func testRendererAccessibilityActivationCachesEachSuccessfulMethodIndependently() {
        let cache = AXRendererAccessibilityActivationCache()
        let identity = AXRendererProcessIdentity(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Electron",
            launchTimestampMilliseconds: 1_000
        )
        var attempts = [AXRendererActivationMethod: Int]()

        XCTAssertEqual(cache.activate(identity: identity, method: .enhancedUserInterface) {
            attempts[.enhancedUserInterface, default: 0] += 1
            return .success
        }, .enabled)
        XCTAssertEqual(cache.activate(identity: identity, method: .enhancedUserInterface) {
            attempts[.enhancedUserInterface, default: 0] += 1
            return .success
        }, .cached)
        XCTAssertEqual(cache.activate(identity: identity, method: .manualAccessibility) {
            attempts[.manualAccessibility, default: 0] += 1
            return .attributeUnsupported
        }, .unsupported)
        XCTAssertEqual(cache.activate(identity: identity, method: .manualAccessibility) {
            attempts[.manualAccessibility, default: 0] += 1
            return .success
        }, .unsupported)
        XCTAssertEqual(attempts[.enhancedUserInterface], 1)
        XCTAssertEqual(attempts[.manualAccessibility], 1)
    }

    func testRendererAccessibilityTriesEnhancedBeforeManualAndStopsWhenReady() {
        let cache = AXRendererAccessibilityActivationCache()
        let identity = AXRendererProcessIdentity(
            processIdentifier: 42,
            bundleIdentifier: "com.openai.chat",
            launchTimestampMilliseconds: 1_000
        )
        var setMethods = [AXRendererActivationMethod]()
        var waitMethods = [AXRendererActivationMethod]()

        let outcome = AXSnapshot.activateRendererAccessibility(
            identity: identity,
            cache: cache,
            setAttribute: { method in
                setMethods.append(method)
                return method == .enhancedUserInterface
                    ? .attributeUnsupported
                    : .success
            },
            waitUntilUseful: { method, status in
                waitMethods.append(method)
                return method == .manualAccessibility && status == .enabled
            }
        )

        XCTAssertEqual(setMethods, [.enhancedUserInterface, .manualAccessibility])
        XCTAssertEqual(waitMethods, [.manualAccessibility])
        XCTAssertEqual(outcome.status, .enabled)
        XCTAssertTrue(outcome.becameUseful)
        XCTAssertEqual(outcome.attempts.map(\.method), [
            .enhancedUserInterface,
            .manualAccessibility,
        ])
        XCTAssertEqual(outcome.attempts.map(\.status), [.unsupported, .enabled])
    }

    func testRendererAccessibilityActivatesAUsefulContentRootOnlyOnce() {
        let cache = AXRendererAccessibilityActivationCache()
        let identity = AXRendererProcessIdentity(
            processIdentifier: 42,
            bundleIdentifier: "com.google.Chrome",
            launchTimestampMilliseconds: 1_000
        )
        let assessment = AccessibilityAssessment(
            quality: .useful,
            contentRootFound: true,
            semanticNodeCount: 117,
            usefulTextCharacters: 585
        )

        XCTAssertTrue(AXSnapshot.shouldActivateRendererAccessibility(
            assessment: assessment,
            activationPreviouslyAttempted: cache.hasCompletedAttempt(
                identity: identity
            )
        ))

        XCTAssertEqual(
            cache.activate(
                identity: identity,
                method: .enhancedUserInterface
            ) { .attributeUnsupported },
            .unsupported
        )

        XCTAssertFalse(cache.hasCompletedAttempt(identity: identity))
        XCTAssertEqual(
            cache.activate(
                identity: identity,
                method: .manualAccessibility
            ) { .attributeUnsupported },
            .unsupported
        )

        XCTAssertFalse(AXSnapshot.shouldActivateRendererAccessibility(
            assessment: assessment,
            activationPreviouslyAttempted: cache.hasCompletedAttempt(
                identity: identity
            )
        ))
    }

    func testRendererAccessibilityCachesUnsupportedActivationMethods() {
        let cache = AXRendererAccessibilityActivationCache()
        let identity = AXRendererProcessIdentity(
            processIdentifier: 42,
            bundleIdentifier: "com.apple.Safari",
            launchTimestampMilliseconds: 1_000
        )
        var attempts = 0

        let first = cache.activate(
            identity: identity,
            method: .enhancedUserInterface
        ) {
            attempts += 1
            return .attributeUnsupported
        }
        let second = cache.activate(
            identity: identity,
            method: .enhancedUserInterface
        ) {
            attempts += 1
            return .success
        }

        XCTAssertEqual(first, .unsupported)
        XCTAssertEqual(second, .unsupported)
        XCTAssertEqual(attempts, 1)
    }

    func testRendererReadinessRequiresMaterialContentGrowth() {
        let initial = AccessibilityAssessment(
            quality: .useful,
            contentRootFound: true,
            semanticNodeCount: 117,
            usefulTextCharacters: 585
        )
        let incidentalChange = AccessibilityAssessment(
            quality: .useful,
            contentRootFound: true,
            semanticNodeCount: 118,
            usefulTextCharacters: 590
        )
        let rendererContent = AccessibilityAssessment(
            quality: .useful,
            contentRootFound: true,
            semanticNodeCount: 180,
            usefulTextCharacters: 1_500
        )

        XCTAssertFalse(AXSnapshot.rendererReadinessImproved(
            initialAssessment: initial,
            initialNodeCount: 307,
            currentAssessment: incidentalChange,
            currentNodeCount: 310
        ))
        XCTAssertTrue(AXSnapshot.rendererReadinessImproved(
            initialAssessment: initial,
            initialNodeCount: 307,
            currentAssessment: rendererContent,
            currentNodeCount: 520
        ))
    }

    func testAccessibilityUsefulnessRejectsAWindowShellAndAcceptsContent() {
        let shell = AccessibilityNode(
            role: "AXWindow",
            subrole: "AXStandardWindow",
            title: "ChatGPT",
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: false,
            enabled: true,
            selected: nil,
            children: [
                AccessibilityNode(
                    role: "AXGroup",
                    subrole: nil,
                    title: "ChatGPT",
                    value: nil,
                    identifier: nil,
                    elementDescription: nil,
                    frame: nil,
                    focused: false,
                    enabled: true,
                    selected: nil,
                    children: nil
                ),
            ]
        )
        let content = AccessibilityNode(
            role: "AXWebArea",
            subrole: nil,
            title: nil,
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: false,
            enabled: true,
            selected: nil,
            children: nil
        )

        XCTAssertFalse(AXSnapshot.hasUsefulContent(
            shell,
            excluding: ["ChatGPT"]
        ))
        XCTAssertTrue(AXSnapshot.hasUsefulContent(content, excluding: []))
    }

    func testAccessibilityAssessmentSeparatesShellOnlyAndUsefulContent() {
        let shell = AccessibilityNode(
            role: "AXWindow",
            subrole: "AXStandardWindow",
            title: "ChatGPT",
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: false,
            enabled: true,
            selected: nil,
            children: [
                AccessibilityNode(
                    role: "AXButton",
                    subrole: nil,
                    title: "Window Sharing",
                    value: nil,
                    identifier: nil,
                    elementDescription: nil,
                    frame: nil,
                    focused: false,
                    enabled: true,
                    selected: nil,
                    children: nil
                ),
            ]
        )
        let useful = AccessibilityNode(
            role: "AXWindow",
            subrole: "AXStandardWindow",
            title: "ChatGPT",
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: false,
            enabled: true,
            selected: nil,
            children: [
                AccessibilityNode(
                    role: "AXWebArea",
                    subrole: nil,
                    title: nil,
                    value: nil,
                    identifier: nil,
                    elementDescription: nil,
                    frame: nil,
                    focused: false,
                    enabled: true,
                    selected: nil,
                    children: [
                        AccessibilityNode(
                            role: "AXStaticText",
                            subrole: nil,
                            title: nil,
                            value: "Useful conversation text",
                            identifier: nil,
                            elementDescription: nil,
                            frame: nil,
                            focused: false,
                            enabled: true,
                            selected: nil,
                            children: nil
                        ),
                    ]
                ),
            ]
        )

        let shellAssessment = AXSnapshot.assess(
            shell,
            excluding: ["ChatGPT", "Window Sharing"]
        )
        XCTAssertEqual(shellAssessment.quality, .shellOnly)
        XCTAssertFalse(shellAssessment.contentRootFound)
        XCTAssertEqual(shellAssessment.usefulTextCharacters, 0)

        let usefulAssessment = AXSnapshot.assess(useful, excluding: ["ChatGPT"])
        XCTAssertEqual(usefulAssessment.quality, .useful)
        XCTAssertTrue(usefulAssessment.contentRootFound)
        XCTAssertGreaterThan(usefulAssessment.semanticNodeCount, 0)
        XCTAssertGreaterThan(usefulAssessment.usefulTextCharacters, 0)
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

        XCTAssertNil(window)
    }

    func testWindowResolverRejectsAMicroDialogWhenNoQualifiedWindowExists() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [[
            kCGWindowOwnerPID as String: processIdentifier,
            kCGWindowLayer as String: 0,
            kCGWindowNumber as String: CGWindowID(1),
            kCGWindowName as String: "Dialog",
            kCGWindowBounds as String: [
                "Width": CGFloat(52),
                "Height": CGFloat(21),
            ],
        ]]

        XCTAssertNil(WindowResolver.selectWindow(
            processIdentifier: processIdentifier,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        ))
    }

    func testWindowResolverPrefersAQualifiedMainWindowOverAMicroDialog() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(1),
                kCGWindowName as String: "Dialog",
                kCGWindowBounds as String: [
                    "Width": CGFloat(52),
                    "Height": CGFloat(21),
                ],
            ],
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(2),
                kCGWindowName as String: "Document",
                kCGWindowBounds as String: [
                    "Width": CGFloat(1_200),
                    "Height": CGFloat(800),
                ],
            ],
        ]

        XCTAssertEqual(WindowResolver.selectWindow(
            processIdentifier: processIdentifier,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        )?.windowIdentifier, 2)
    }

    func testWindowResolverUsesTheLargestQualifiedWindowAsTheRoot() {
        let processIdentifier: pid_t = 42
        let windows: [[String: Any]] = [
            [
                kCGWindowOwnerPID as String: processIdentifier,
                kCGWindowLayer as String: 0,
                kCGWindowNumber as String: CGWindowID(1),
                kCGWindowName as String: "Dialog",
                kCGWindowBounds as String: [
                    "X": CGFloat(300),
                    "Y": CGFloat(220),
                    "Width": CGFloat(480),
                    "Height": CGFloat(320),
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
                    "Width": CGFloat(1_200),
                    "Height": CGFloat(800),
                ],
            ],
        ]

        XCTAssertEqual(WindowResolver.selectWindow(
            processIdentifier: processIdentifier,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        )?.windowIdentifier, 2)
    }

    func testFrozenCaptureGroupIncludesOnlyContainedSameProcessWindowsAboveRoot() throws {
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Document",
            frame: WindowFrame(x: 100, y: 80, width: 1_200, height: 800)
        )
        let windows: [[String: Any]] = [
            testWindow(
                processIdentifier: 99,
                identifier: 20,
                frame: CGRect(x: 400, y: 300, width: 200, height: 120)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 3,
                frame: CGRect(x: 420, y: 300, width: 240, height: 160)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 4,
                frame: CGRect(x: 1_500, y: 300, width: 240, height: 160)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 5,
                frame: CGRect(x: 1_100, y: 300, width: 300, height: 200)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 7,
                frame: CGRect(x: 100, y: 80, width: 1_200, height: 800)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 8,
                frame: CGRect(x: 200, y: 180, width: 800, height: 600)
            ),
        ]

        let group = try XCTUnwrap(WindowResolver.resolveFrozenCaptureGroup(
            target,
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        ))

        XCTAssertEqual(group.root.windowIdentifier, 7)
        XCTAssertEqual(group.memberWindowIdentifiers, [3])
        XCTAssertEqual(group.windowIdentifiers, [3, 7])
    }

    func testFrozenCaptureGroupPromotesAnOverlaidMicroWindowToItsLargeRoot() throws {
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 3,
            title: "Sharing Indicator",
            frame: WindowFrame(x: 420, y: 300, width: 52, height: 21)
        )
        let windows: [[String: Any]] = [
            testWindow(
                processIdentifier: 42,
                identifier: 3,
                frame: CGRect(x: 420, y: 300, width: 52, height: 21)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 7,
                frame: CGRect(x: 100, y: 80, width: 1_200, height: 800)
            ),
        ]

        let group = try XCTUnwrap(WindowResolver.resolveFrozenCaptureGroup(
            target,
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        ))

        XCTAssertEqual(group.root.windowIdentifier, 7)
        XCTAssertEqual(group.memberWindowIdentifiers, [3])
        XCTAssertEqual(group.windowIdentifiers, [3, 7])
    }

    func testFrozenCaptureGroupDoesNotPromoteADetachedMicroWindow() {
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 3,
            title: "Detached Control",
            frame: WindowFrame(x: 1_500, y: 300, width: 52, height: 21)
        )
        let windows: [[String: Any]] = [
            testWindow(
                processIdentifier: 42,
                identifier: 3,
                frame: CGRect(x: 1_500, y: 300, width: 52, height: 21)
            ),
            testWindow(
                processIdentifier: 42,
                identifier: 7,
                frame: CGRect(x: 100, y: 80, width: 1_200, height: 800)
            ),
        ]

        XCTAssertNil(WindowResolver.resolveFrozenCaptureGroup(
            target,
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        ))
    }

    func testWindowGroupCaptureUsesRootFrameInTheOwningDisplayCoordinates() {
        let geometry = Target.captureGeometry(
            rootFrame: CGRect(x: 1_540, y: 120, width: 1_200, height: 800),
            displayFrames: [
                CGRect(x: 0, y: 0, width: 1_440, height: 900),
                CGRect(x: 1_440, y: 0, width: 2_560, height: 1_440),
            ],
            maxWidth: 600
        )

        XCTAssertEqual(geometry?.displayIndex, 1)
        XCTAssertEqual(
            geometry?.sourceRect,
            CGRect(x: 100, y: 120, width: 1_200, height: 800)
        )
        XCTAssertEqual(geometry?.outputSize, CGSize(width: 600, height: 400))
    }

    func testWindowGroupCaptureRequiresTheRootAndKeepsAvailableMembers() {
        XCTAssertEqual(
            Target.availableWindowIdentifiers(
                requested: [3, 4, 7],
                rootWindowIdentifier: 7,
                available: [7, 3, 9]
            ),
            [3, 7]
        )
        XCTAssertNil(Target.availableWindowIdentifiers(
            requested: [3, 7],
            rootWindowIdentifier: 7,
            available: [3, 9]
        ))
    }

    func testFrozenWindowGroupRestrictsAXToTheWindowsUsedByTheScreenshot() {
        let group = FrozenWindowGroup(
            root: WindowMetadata(
                processIdentifier: 42,
                bundleIdentifier: nil,
                applicationName: "Editor",
                windowIdentifier: 7,
                title: "Document",
                frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
            ),
            memberWindowIdentifiers: [3, 4]
        )

        XCTAssertEqual(
            group.restricting(to: [3, 7])?.memberWindowIdentifiers,
            [3]
        )
        XCTAssertNil(group.restricting(to: [3, 4]))
    }

    func testFrozenTargetPreflightRejectsAWindowThatShrankBelowTheMinimumSize() {
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Document",
            frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
        )
        let windows: [[String: Any]] = [[
            kCGWindowOwnerPID as String: pid_t(42),
            kCGWindowLayer as String: 0,
            kCGWindowNumber as String: CGWindowID(7),
            kCGWindowName as String: "Document",
            kCGWindowBounds as String: [
                "Width": CGFloat(52),
                "Height": CGFloat(21),
            ],
        ]]

        XCTAssertNil(WindowResolver.resolveFrozenTarget(
            target,
            from: windows,
            configuration: testObservationConfiguration.windowSelection
        ))
    }

    func testCachedTargetValidationDistinguishesAbsentAndInvalidatedTargets() {
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Document",
            frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
        )
        var emptyCache = CachedTargetCache()
        var resolverCalls = 0

        XCTAssertEqual(emptyCache.validate { _ in
            resolverCalls += 1
            return target
        }, .absent)
        XCTAssertEqual(resolverCalls, 0)

        var staleCache = CachedTargetCache(target)

        XCTAssertEqual(staleCache.validate { _ in nil }, .invalidated)
        XCTAssertNil(staleCache.window)
        XCTAssertEqual(staleCache.validate { _ in target }, .absent)
    }

    func testCachedTargetDoesNotRetainAWindowWithoutAnIdentifier() {
        let placeholder = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: nil,
            title: nil,
            frame: nil
        )
        var cache = CachedTargetCache()

        cache.replace(with: placeholder)

        XCTAssertNil(cache.window)
    }

    func testPlaceholderAnnouncementIsEmittedOnceUntilATargetBecomesAvailable() {
        let placeholder = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: nil,
            title: nil,
            frame: nil
        )
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Document",
            frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
        )
        var gate = PlaceholderAnnouncementGate()

        XCTAssertTrue(gate.shouldEmit(window: placeholder))
        XCTAssertFalse(gate.shouldEmit(window: placeholder))
        XCTAssertTrue(gate.shouldEmit(window: target))
        XCTAssertTrue(gate.shouldEmit(window: placeholder))
        XCTAssertFalse(gate.shouldEmit(window: nil))
        XCTAssertTrue(gate.shouldEmit(window: placeholder))
    }

    func testCachedTargetValidationReturnsAndStoresTheResolvedTarget() {
        let target = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Old title",
            frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
        )
        let resolved = WindowMetadata(
            processIdentifier: 42,
            bundleIdentifier: "com.example.Editor",
            applicationName: "Editor",
            windowIdentifier: 7,
            title: "Current title",
            frame: WindowFrame(x: 0, y: 0, width: 1_200, height: 800)
        )
        var cache = CachedTargetCache(target)

        XCTAssertEqual(cache.validate { _ in resolved }, .valid(resolved))
        XCTAssertEqual(cache.window, resolved)
    }

    func testSignatureDownsamplesBGRAFramesToGrayscale() {
        let signature = Signature.make(
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
            Signature.distance([0, 0], [255, 255]),
            1,
            accuracy: 0.0001
        )
    }

    func testBudgetStopsAtDepthAndNodeLimits() {
        var budget = Budget(
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

    func testChangeGateComparesAgainstTheLastEmittedFrame() {
        var gate = ChangeGate(threshold: 0.1)

        XCTAssertFalse(gate.shouldEmit([0]))
        XCTAssertFalse(gate.shouldEmit([20]))
        XCTAssertTrue(gate.shouldEmit([30]))
        XCTAssertFalse(gate.shouldEmit([40]))
        XCTAssertTrue(gate.shouldEmit([60]))
    }

    func testVisualStreamGenerationRestartsOnlyTheCurrentGeneration() {
        var state = VisualStreamGeneration()
        let first = state.advance()
        let second = state.advance()

        XCTAssertEqual(state.disposition(for: first), .stale)
        XCTAssertEqual(state.disposition(for: second), .current)
    }

    func testVisualRecoveryBackoffIsBoundedAndResetsAfterAStableWindow() {
        var backoff = VisualRecoveryBackoff(stabilityWindowMilliseconds: 10_000)

        XCTAssertEqual(backoff.delayMilliseconds(at: 0), 0)
        XCTAssertEqual(backoff.delayMilliseconds(at: 1_000), 250)
        XCTAssertEqual(backoff.delayMilliseconds(at: 2_000), 500)
        XCTAssertEqual(backoff.delayMilliseconds(at: 3_000), 1_000)
        XCTAssertEqual(backoff.delayMilliseconds(at: 4_000), 2_000)
        XCTAssertEqual(backoff.delayMilliseconds(at: 5_000), 2_000)
        XCTAssertEqual(backoff.delayMilliseconds(at: 15_001), 0)

        backoff.reset()
        XCTAssertEqual(backoff.delayMilliseconds(at: 15_100), 0)
    }
}

private func testWindow(
    processIdentifier: pid_t,
    identifier: CGWindowID,
    frame: CGRect,
    layer: Int = 0
) -> [String: Any] {
    [
        kCGWindowOwnerPID as String: processIdentifier,
        kCGWindowLayer as String: layer,
        kCGWindowNumber as String: identifier,
        kCGWindowBounds as String: [
            "X": frame.origin.x,
            "Y": frame.origin.y,
            "Width": frame.width,
            "Height": frame.height,
        ],
    ]
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
