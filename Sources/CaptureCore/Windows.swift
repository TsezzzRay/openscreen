import CoreGraphics
import Foundation

public struct WindowInfo: Equatable, Sendable {
    public let id: CGWindowID
    public let frame: CGRect
    public let title: String?
}

public struct WindowRules: Equatable, Sendable {
    public static let standard = WindowRules(
        minimumWidth: 160,
        minimumHeight: 120,
        maximumAspectRatio: 4
    )

    public let minimumWidth: CGFloat
    public let minimumHeight: CGFloat
    public let maximumAspectRatio: CGFloat

    public init(
        minimumWidth: CGFloat,
        minimumHeight: CGFloat,
        maximumAspectRatio: CGFloat
    ) {
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.maximumAspectRatio = maximumAspectRatio
    }
}

public enum Windows {
    public static func onScreen() -> [[String: Any]]? {
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
    }

    public static func candidates(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> [WindowInfo] {
        windows.compactMap { window -> WindowInfo? in
            guard
                window[kCGWindowOwnerPID as String] as? pid_t == processIdentifier,
                window[kCGWindowLayer as String] as? Int == 0,
                let id = window[kCGWindowNumber as String] as? CGWindowID,
                let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                let width = bounds["Width"],
                let height = bounds["Height"],
                width > 1,
                height > 1
            else {
                return nil
            }
            return WindowInfo(
                id: id,
                frame: CGRect(
                    x: bounds["X"] ?? 0,
                    y: bounds["Y"] ?? 0,
                    width: width,
                    height: height
                ),
                title: normalize(window[kCGWindowName as String] as? String)
            )
        }
    }

    public static func pick(
        for processIdentifier: pid_t,
        from windows: [[String: Any]],
        rules: WindowRules = .standard
    ) -> WindowInfo? {
        let candidates = candidates(
            for: processIdentifier,
            from: windows
        )
        return candidates.first(where: {
            $0.frame.width >= rules.minimumWidth
                && $0.frame.height >= rules.minimumHeight
                && aspectRatio(of: $0.frame) <= rules.maximumAspectRatio
        }) ?? candidates.first
    }

    public static func shouldGroup(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> Bool {
        let candidates = candidates(
            for: processIdentifier,
            from: windows
        )
        guard
            let first = candidates.first,
            aspectRatio(of: first.frame) > WindowRules.standard.maximumAspectRatio
        else {
            return false
        }
        return candidates.dropFirst().contains {
            $0.frame.width >= first.frame.width * 0.8
                && $0.frame.height >= first.frame.height * 2
        }
    }

    private static func aspectRatio(of frame: CGRect) -> CGFloat {
        max(
            frame.width / frame.height,
            frame.height / frame.width
        )
    }

    private static func normalize(_ value: String?) -> String? {
        guard
            let value,
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return value
    }
}
