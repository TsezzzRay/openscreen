import CoreGraphics
import ScreenCaptureKit

public enum TargetError: Error {
    case noWindow
}

public struct Target {
    public let content: SCShareableContent
    public let window: SCWindow
    public let filter: SCContentFilter
    public let configuration: SCStreamConfiguration

    public static func resolve(
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
            filter: SCContentFilter(desktopIndependentWindow: window),
            configuration: configuration
        )
    }

    public static func size(
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
}
