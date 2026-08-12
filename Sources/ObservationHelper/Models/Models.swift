import CoreGraphics
import Foundation

// MARK: - Activity

enum NativeActivityKind: String, Codable, Hashable, Sendable {
    case applicationActivated
    case focusedWindowChanged
    case focusedElementChanged
    case mouseClick
    case keyActivity
    case accessibilityChanged
    case visualChanged
    case spaceChanged
    case wake
}

struct NativeObservationConfiguration: Codable, Equatable, Sendable {
    struct ActivityMonitoring: Codable, Equatable, Sendable {
        let coalescingIntervalMilliseconds: Int
    }

    struct Accessibility: Codable, Equatable, Sendable {
        let maxDepth: Int
        let maxNodes: Int
        let timeoutMilliseconds: Int
        let maxTextLength: Int
    }

    struct Screenshot: Codable, Equatable, Sendable {
        let maxWidth: Int
        let jpegQuality: Double
    }

    struct VisualMonitoring: Codable, Equatable, Sendable {
        let maxWidth: Int
        let sampleIntervalMilliseconds: Int
        let queueDepth: Int
        let changeThreshold: Double
        let signatureWidth: Int
        let signatureHeight: Int
    }

    struct WindowSelection: Codable, Equatable, Sendable {
        let minimumWidth: Int
        let minimumHeight: Int
        let maximumAspectRatio: Double
    }

    let activityMonitoring: ActivityMonitoring
    let accessibility: Accessibility
    let screenshot: Screenshot
    let visualMonitoring: VisualMonitoring
    let windowSelection: WindowSelection
}

struct WindowFrame: Codable, Equatable, Sendable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

struct WindowMetadata: Codable, Equatable, Sendable {
    let processIdentifier: pid_t
    let bundleIdentifier: String?
    let applicationName: String
    let windowIdentifier: CGWindowID?
    let title: String?
    let frame: WindowFrame?
}

struct FrozenWindowGroup: Equatable, Sendable {
    let root: WindowMetadata
    let memberWindowIdentifiers: [CGWindowID]

    var windowIdentifiers: [CGWindowID] {
        memberWindowIdentifiers + [root.windowIdentifier].compactMap { $0 }
    }

    func restricting(
        to includedWindowIdentifiers: [CGWindowID]
    ) -> FrozenWindowGroup? {
        guard
            let rootWindowIdentifier = root.windowIdentifier,
            includedWindowIdentifiers.contains(rootWindowIdentifier)
        else {
            return nil
        }
        let included = Set(includedWindowIdentifiers)
        return FrozenWindowGroup(
            root: root,
            memberWindowIdentifiers: memberWindowIdentifiers.filter(
                included.contains
            )
        )
    }
}

struct NativeActivitySignal: Codable, Equatable, Sendable {
    let kind: NativeActivityKind
    let occurredAt: String
    let window: WindowMetadata
    let visualSignature: [UInt8]?

    init(
        kind: NativeActivityKind,
        occurredAt: String,
        window: WindowMetadata,
        visualSignature: [UInt8]? = nil
    ) {
        self.kind = kind
        self.occurredAt = occurredAt
        self.window = window
        self.visualSignature = visualSignature
    }
}

enum CaptureStatus: String, Codable, Sendable {
    case complete
    case partial
    case permissionDenied
    case timedOut
    case unsupported
    case failed
}

enum AccessibilityFailureReason: String, Codable, Sendable {
    case permissionDenied = "permission_denied"
    case focusedWindowUnavailable = "focused_window_unavailable"
    case targetMismatch = "target_mismatch"
    case traversalTimedOut = "traversal_timed_out"
    case snapshotUnavailable = "snapshot_unavailable"
}

enum ScreenshotFailureReason: String, Codable, Equatable, Sendable {
    case permissionDenied = "permission_denied"
    case noWindow = "no_window"
    case noDisplay = "no_display"
    case targetResolutionFailed = "target_resolution_failed"
    case captureFailed = "capture_failed"
    case jpegEncodingFailed = "jpeg_encoding_failed"
}

enum AXRendererActivationStatus: String, Codable, Sendable {
    case enabled
    case cached
    case unsupported
    case failed
}

enum AXRendererActivationMethod: String, Codable, CaseIterable, Hashable, Sendable {
    case enhancedUserInterface = "enhanced_ui"
    case manualAccessibility = "manual_accessibility"

    var attributeName: String {
        switch self {
        case .enhancedUserInterface:
            "AXEnhancedUserInterface"
        case .manualAccessibility:
            "AXManualAccessibility"
        }
    }
}

enum AccessibilityQuality: String, Codable, Sendable {
    case useful
    case shellOnly = "shell_only"
    case empty
    case unavailable
}

struct AXRendererActivationAttempt: Codable, Equatable, Sendable {
    let method: AXRendererActivationMethod
    let status: AXRendererActivationStatus
}

struct AXRendererActivationOutcome: Equatable, Sendable {
    let status: AXRendererActivationStatus
    let attempts: [AXRendererActivationAttempt]
    let becameUseful: Bool
}

struct AccessibilityAssessment: Equatable, Sendable {
    let quality: AccessibilityQuality
    let contentRootFound: Bool
    let semanticNodeCount: Int
    let usefulTextCharacters: Int
}

struct AccessibilityActivation: Codable, Sendable {
    let status: AXRendererActivationStatus
    let attempts: [AXRendererActivationAttempt]
    let waitMilliseconds: Double
    let nodeCountBefore: Int?
    let nodeCountAfter: Int?
}

struct SourceStatus: Sendable {
    enum Component: String, Sendable {
        case accessibility
        case eventTap
        case visualStream
    }

    enum State: String, Sendable {
        case ready
        case degraded
        case stopped
    }

    let component: Component
    let state: State
    let message: String?
}

struct NativeDiagnosticEvent: Sendable {
    enum Name: String, Sendable {
        case cachedTargetRejected = "cached_target_rejected"
        case visualStreamStopped = "visual.stream_stopped"
        case visualRestarting = "visual.restarting"
        case visualRecovered = "visual.recovered"
    }

    let event: Name
    let reason: String?
    let generation: Int?
    let windowIdentifier: CGWindowID?
    let delayMilliseconds: Int?

    init(
        event: Name,
        reason: String? = nil,
        generation: Int? = nil,
        windowIdentifier: CGWindowID? = nil,
        delayMilliseconds: Int? = nil
    ) {
        self.event = event
        self.reason = reason
        self.generation = generation
        self.windowIdentifier = windowIdentifier
        self.delayMilliseconds = delayMilliseconds
    }
}

struct AccessibilityNode: Codable, Sendable {
    let role: String
    let subrole: String?
    let title: String?
    let value: String?
    let identifier: String?
    let elementDescription: String?
    let frame: WindowFrame?
    let focused: Bool?
    let enabled: Bool?
    let selected: Bool?
    let children: [AccessibilityNode]?

    enum CodingKeys: String, CodingKey {
        case role
        case subrole
        case title
        case value
        case identifier
        case elementDescription = "description"
        case frame
        case focused
        case enabled
        case selected
        case children
    }
}

struct AccessibilitySnapshot: Codable, Sendable {
    let root: AccessibilityNode
    let nodeCount: Int
    let truncated: Bool
}

struct AccessibilityCapture: Codable, Sendable {
    let status: CaptureStatus
    let quality: AccessibilityQuality
    let durationMilliseconds: Double
    let snapshot: AccessibilitySnapshot?
    let failureReason: AccessibilityFailureReason?
    let activation: AccessibilityActivation?
    let windowIdentifiers: [CGWindowID]?
    let missingWindowIdentifiers: [CGWindowID]?
    let contentRootFound: Bool
    let semanticNodeCount: Int
    let usefulTextCharacters: Int
    let completedAt: String

    init(
        status: CaptureStatus,
        quality: AccessibilityQuality = .unavailable,
        durationMilliseconds: Double,
        snapshot: AccessibilitySnapshot?,
        failureReason: AccessibilityFailureReason? = nil,
        activation: AccessibilityActivation? = nil,
        windowIdentifiers: [CGWindowID]? = nil,
        missingWindowIdentifiers: [CGWindowID]? = nil,
        contentRootFound: Bool = false,
        semanticNodeCount: Int = 0,
        usefulTextCharacters: Int = 0,
        completedAt: String = iso8601Timestamp()
    ) {
        self.status = status
        self.quality = quality
        self.durationMilliseconds = durationMilliseconds
        self.snapshot = snapshot
        self.failureReason = failureReason
        self.activation = activation
        self.windowIdentifiers = windowIdentifiers
        self.missingWindowIdentifiers = missingWindowIdentifiers
        self.contentRootFound = contentRootFound
        self.semanticNodeCount = semanticNodeCount
        self.usefulTextCharacters = usefulTextCharacters
        self.completedAt = completedAt
    }
}

struct ScreenshotCapture: Codable, Sendable {
    let status: CaptureStatus
    let durationMilliseconds: Double
    let failureReason: ScreenshotFailureReason?
    let mimeType: String?
    let dataBase64: String?
    let width: Int?
    let height: Int?
    let completedAt: String

    init(
        status: CaptureStatus,
        durationMilliseconds: Double,
        failureReason: ScreenshotFailureReason? = nil,
        mimeType: String?,
        dataBase64: String?,
        width: Int?,
        height: Int?,
        completedAt: String = iso8601Timestamp()
    ) {
        self.status = status
        self.durationMilliseconds = durationMilliseconds
        self.failureReason = failureReason
        self.mimeType = mimeType
        self.dataBase64 = dataBase64
        self.width = width
        self.height = height
        self.completedAt = completedAt
    }
}

struct CaptureValidation: Codable, Sendable {
    let preflightDurationMilliseconds: Double
    let attestationDurationMilliseconds: Double
}

struct CaptureWindowGroup: Codable, Equatable, Sendable {
    let processIdentifier: pid_t
    let rootWindowIdentifier: CGWindowID
    let memberWindowIdentifiers: [CGWindowID]
    let frame: WindowFrame
}

struct NativeCaptureResult: Codable, Sendable {
    let startedAt: String
    let capturedAt: String
    let validation: CaptureValidation
    let window: WindowMetadata
    let windowGroup: CaptureWindowGroup
    let screenshot: ScreenshotCapture
    let accessibility: AccessibilityCapture
    let visualSignature: [UInt8]?
}

func iso8601Timestamp(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
}
