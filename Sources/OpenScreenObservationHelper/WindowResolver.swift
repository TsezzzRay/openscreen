import AppKit
import CoreGraphics

enum WindowResolver {
    static func currentWindow(
        excluding filter: SelfCaptureFilter,
        configuration: NativeObservationConfiguration.WindowSelection
    ) -> WindowMetadata? {
        guard let application = NSWorkspace.shared.frontmostApplication else {
            return nil
        }
        let processIdentifier = application.processIdentifier
        let bundleIdentifier = application.bundleIdentifier
        guard !filter.contains(
            processIdentifier: processIdentifier,
            bundleIdentifier: bundleIdentifier
        ) else {
            return nil
        }
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return WindowMetadata(
                processIdentifier: processIdentifier,
                bundleIdentifier: bundleIdentifier,
                applicationName: application.localizedName ?? "Unknown",
                windowIdentifier: nil,
                title: nil,
                frame: nil
            )
        }
        return selectWindow(
            processIdentifier: processIdentifier,
            bundleIdentifier: bundleIdentifier,
            applicationName: application.localizedName ?? "Unknown",
            from: windows,
            configuration: configuration
        ) ?? WindowMetadata(
            processIdentifier: processIdentifier,
            bundleIdentifier: bundleIdentifier,
            applicationName: application.localizedName ?? "Unknown",
            windowIdentifier: nil,
            title: nil,
            frame: nil
        )
    }

    static func selectWindow(
        processIdentifier: pid_t,
        bundleIdentifier: String?,
        applicationName: String,
        from windows: [[String: Any]],
        configuration: NativeObservationConfiguration.WindowSelection
    ) -> WindowMetadata? {
        let candidates = windows.compactMap { window -> WindowMetadata? in
            guard
                window[kCGWindowOwnerPID as String] as? pid_t == processIdentifier,
                window[kCGWindowLayer as String] as? Int == 0,
                let identifier = window[kCGWindowNumber as String] as? CGWindowID,
                let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                let width = bounds["Width"],
                let height = bounds["Height"],
                width > 1,
                height > 1
            else {
                return nil
            }
            return WindowMetadata(
                processIdentifier: processIdentifier,
                bundleIdentifier: bundleIdentifier,
                applicationName: applicationName,
                windowIdentifier: identifier,
                title: normalizeAccessibilityText(
                    window[kCGWindowName as String] as? String
                ),
                frame: WindowFrame(
                    x: bounds["X"] ?? 0,
                    y: bounds["Y"] ?? 0,
                    width: width,
                    height: height
                )
            )
        }
        return candidates.first(where: { candidate in
            guard let frame = candidate.frame else {
                return false
            }
            return frame.width >= CGFloat(configuration.minimumWidth)
                && frame.height >= CGFloat(configuration.minimumHeight)
                && max(
                    frame.width / frame.height,
                    frame.height / frame.width
                ) <= configuration.maximumAspectRatio
        }) ?? candidates.first
    }
}
