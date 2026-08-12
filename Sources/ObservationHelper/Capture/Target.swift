import CoreGraphics
import ScreenCaptureKit

enum TargetError: Error {
    case noWindow
    case noDisplay

    var screenshotFailureReason: ScreenshotFailureReason {
        switch self {
        case .noWindow:
            .noWindow
        case .noDisplay:
            .noDisplay
        }
    }
}

struct Target {
    struct CaptureGeometry: Equatable {
        let displayIndex: Int
        let sourceRect: CGRect
        let outputSize: CGSize
    }

    let content: SCShareableContent
    let window: SCWindow
    let windowIdentifiers: [CGWindowID]
    let filter: SCContentFilter
    let configuration: SCStreamConfiguration

    static func resolve(
        id: CGWindowID,
        maxWidth: Int? = nil
    ) async throws -> Target {
        let content = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            throw TargetError.noWindow
        }
        let configuration = SCStreamConfiguration()
        let size = size(for: window.frame.size, maxWidth: maxWidth)
        configuration.width = max(1, Int(size.width.rounded()))
        configuration.height = max(1, Int(size.height.rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        return Target(
            content: content,
            window: window,
            windowIdentifiers: [window.windowID],
            filter: SCContentFilter(desktopIndependentWindow: window),
            configuration: configuration
        )
    }

    static func resolve(
        group: FrozenWindowGroup,
        maxWidth: Int? = nil
    ) async throws -> Target {
        guard
            let rootWindowIdentifier = group.root.windowIdentifier,
            let rootFrame = group.root.frame.map({
                CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
            })
        else {
            throw TargetError.noWindow
        }
        let content = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        )
        guard let windowIdentifiers = availableWindowIdentifiers(
            requested: group.windowIdentifiers,
            rootWindowIdentifier: rootWindowIdentifier,
            available: content.windows.map(\.windowID)
        ) else {
            throw TargetError.noWindow
        }
        let windowsByIdentifier = Dictionary(
            uniqueKeysWithValues: content.windows.map { ($0.windowID, $0) }
        )
        let includedWindows = windowIdentifiers.compactMap {
            windowsByIdentifier[$0]
        }
        guard
            let rootWindow = windowsByIdentifier[rootWindowIdentifier],
            let geometry = captureGeometry(
                rootFrame: rootFrame,
                displayFrames: content.displays.map(\.frame),
                maxWidth: maxWidth
            )
        else {
            throw TargetError.noDisplay
        }
        let display = content.displays[geometry.displayIndex]
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(geometry.outputSize.width.rounded()))
        configuration.height = max(1, Int(geometry.outputSize.height.rounded()))
        configuration.sourceRect = geometry.sourceRect
        configuration.showsCursor = false
        configuration.includeChildWindows = false
        configuration.ignoreShadowsDisplay = true
        return Target(
            content: content,
            window: rootWindow,
            windowIdentifiers: windowIdentifiers,
            filter: SCContentFilter(display: display, including: includedWindows),
            configuration: configuration
        )
    }

    static func size(
        for source: CGSize,
        maxWidth: Int?
    ) -> CGSize {
        guard let maxWidth else {
            return source
        }
        let scale = min(
            1,
            CGFloat(maxWidth) / max(1, source.width)
        )
        return CGSize(
            width: max(1, (source.width * scale).rounded()),
            height: max(1, (source.height * scale).rounded())
        )
    }

    static func captureGeometry(
        rootFrame: CGRect,
        displayFrames: [CGRect],
        maxWidth: Int?
    ) -> CaptureGeometry? {
        guard let displayIndex = displayFrames.firstIndex(where: {
            $0.contains(rootFrame)
        }) else {
            return nil
        }
        let displayFrame = displayFrames[displayIndex]
        return CaptureGeometry(
            displayIndex: displayIndex,
            sourceRect: rootFrame.offsetBy(
                dx: -displayFrame.origin.x,
                dy: -displayFrame.origin.y
            ),
            outputSize: size(for: rootFrame.size, maxWidth: maxWidth)
        )
    }

    static func availableWindowIdentifiers(
        requested: [CGWindowID],
        rootWindowIdentifier: CGWindowID,
        available: [CGWindowID]
    ) -> [CGWindowID]? {
        let availableIdentifiers = Set(available)
        guard availableIdentifiers.contains(rootWindowIdentifier) else {
            return nil
        }
        return requested.filter(availableIdentifiers.contains)
    }
}
