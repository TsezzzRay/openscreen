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

struct NativeActivitySignal: Codable, Equatable, Sendable {
    let kind: NativeActivityKind
    let occurredAt: String
    let window: WindowMetadata
}

enum CaptureStatus: String, Codable, Sendable {
    case complete
    case permissionDenied
    case timedOut
    case unsupported
    case failed
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
    let durationMilliseconds: Double
    let snapshot: AccessibilitySnapshot?
}

struct ScreenshotCapture: Codable, Sendable {
    let status: CaptureStatus
    let durationMilliseconds: Double
    let mimeType: String?
    let dataBase64: String?
    let width: Int?
    let height: Int?
}

struct NativeCaptureResult: Codable, Sendable {
    let capturedAt: String
    let window: WindowMetadata
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
