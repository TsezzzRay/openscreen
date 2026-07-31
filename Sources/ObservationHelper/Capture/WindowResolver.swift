import AppKit
import CaptureCore
import CoreGraphics

struct SelfFilter: Sendable {
    private let processIdentifiers: Set<pid_t>
    private let bundleIdentifiers: Set<String>

    init(processIdentifiers: Set<pid_t>, bundleIdentifiers: Set<String>) {
        self.processIdentifiers = processIdentifiers
        self.bundleIdentifiers = Set(bundleIdentifiers.map { $0.lowercased() })
    }

    func contains(processIdentifier: pid_t, bundleIdentifier: String?) -> Bool {
        if processIdentifiers.contains(processIdentifier) {
            return true
        }
        guard let bundleIdentifier else {
            return false
        }
        return bundleIdentifiers.contains(bundleIdentifier.lowercased())
    }
}

enum WindowResolver {
    static func currentWindow(
        excluding filter: SelfFilter,
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
        guard let windows = Windows.onScreen() else {
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
        guard let window = Windows.pick(
            for: processIdentifier,
            from: windows,
            rules: WindowRules(
                minimumWidth: CGFloat(configuration.minimumWidth),
                minimumHeight: CGFloat(configuration.minimumHeight),
                maximumAspectRatio: CGFloat(configuration.maximumAspectRatio)
            )
        ) else {
            return nil
        }
        return WindowMetadata(
            processIdentifier: processIdentifier,
            bundleIdentifier: bundleIdentifier,
            applicationName: applicationName,
            windowIdentifier: window.id,
            title: window.title,
            frame: WindowFrame(
                x: window.frame.origin.x,
                y: window.frame.origin.y,
                width: window.frame.width,
                height: window.frame.height
            )
        )
    }
}
