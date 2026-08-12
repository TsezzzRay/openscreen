import AppKit
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
    static func resolveFrozenCaptureGroup(
        _ target: WindowMetadata,
        excluding filter: SelfFilter,
        configuration: NativeObservationConfiguration.WindowSelection
    ) -> FrozenWindowGroup? {
        guard !filter.contains(
            processIdentifier: target.processIdentifier,
            bundleIdentifier: target.bundleIdentifier
        ), let windows = Windows.onScreen() else {
            return nil
        }
        return resolveFrozenCaptureGroup(
            target,
            from: windows,
            configuration: configuration
        )
    }

    static func resolveFrozenCaptureGroup(
        _ target: WindowMetadata,
        from windows: [[String: Any]],
        configuration: NativeObservationConfiguration.WindowSelection
    ) -> FrozenWindowGroup? {
        guard
            let targetWindowIdentifier = target.windowIdentifier,
            let rootInfo = Windows.captureRoot(
                containing: targetWindowIdentifier,
                for: target.processIdentifier,
                from: windows,
                rules: WindowRules(
                    minimumWidth: CGFloat(configuration.minimumWidth),
                    minimumHeight: CGFloat(configuration.minimumHeight),
                    maximumAspectRatio: CGFloat(configuration.maximumAspectRatio)
                )
            )
        else {
            return nil
        }
        let root = WindowMetadata(
            processIdentifier: target.processIdentifier,
            bundleIdentifier: target.bundleIdentifier,
            applicationName: target.applicationName,
            windowIdentifier: rootInfo.id,
            title: rootInfo.title ?? (
                rootInfo.id == targetWindowIdentifier ? target.title : nil
            ),
            frame: WindowFrame(
                x: rootInfo.frame.origin.x,
                y: rootInfo.frame.origin.y,
                width: rootInfo.frame.width,
                height: rootInfo.frame.height
            )
        )
        return FrozenWindowGroup(
            root: root,
            memberWindowIdentifiers: Windows.members(
                of: rootInfo,
                for: target.processIdentifier,
                from: windows
            ).map(\.id)
        )
    }

    static func resolveFrozenTarget(
        _ target: WindowMetadata,
        excluding filter: SelfFilter,
        configuration: NativeObservationConfiguration.WindowSelection
    ) -> WindowMetadata? {
        guard !filter.contains(
            processIdentifier: target.processIdentifier,
            bundleIdentifier: target.bundleIdentifier
        ), let windows = Windows.onScreen() else {
            return nil
        }
        return resolveFrozenTarget(
            target,
            from: windows,
            configuration: configuration
        )
    }

    static func resolveFrozenTarget(
        _ target: WindowMetadata,
        from windows: [[String: Any]]
    ) -> WindowMetadata? {
        resolveFrozenTarget(target, from: windows, rules: .standard)
    }

    static func resolveFrozenTarget(
        _ target: WindowMetadata,
        from windows: [[String: Any]],
        configuration: NativeObservationConfiguration.WindowSelection
    ) -> WindowMetadata? {
        resolveFrozenTarget(
            target,
            from: windows,
            rules: WindowRules(
                minimumWidth: CGFloat(configuration.minimumWidth),
                minimumHeight: CGFloat(configuration.minimumHeight),
                maximumAspectRatio: CGFloat(configuration.maximumAspectRatio)
            )
        )
    }

    private static func resolveFrozenTarget(
        _ target: WindowMetadata,
        from windows: [[String: Any]],
        rules: WindowRules
    ) -> WindowMetadata? {
        guard
            let windowIdentifier = target.windowIdentifier,
            let window = Windows.candidates(
                for: target.processIdentifier,
                from: windows
            ).first(where: {
                $0.id == windowIdentifier && Windows.qualifies($0, rules: rules)
            })
        else {
            return nil
        }
        return WindowMetadata(
            processIdentifier: target.processIdentifier,
            bundleIdentifier: target.bundleIdentifier,
            applicationName: target.applicationName,
            windowIdentifier: window.id,
            title: window.title ?? target.title,
            frame: WindowFrame(
                x: window.frame.origin.x,
                y: window.frame.origin.y,
                width: window.frame.width,
                height: window.frame.height
            )
        )
    }

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
