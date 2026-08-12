import CoreGraphics
import Foundation

struct WindowInfo: Equatable, Sendable {
    let id: CGWindowID
    let frame: CGRect
    let title: String?
    let layer: Int
}

struct WindowRules: Equatable, Sendable {
    static let standard = WindowRules(
        minimumWidth: 160,
        minimumHeight: 120,
        maximumAspectRatio: 4
    )

    let minimumWidth: CGFloat
    let minimumHeight: CGFloat
    let maximumAspectRatio: CGFloat
}

enum Windows {
    static func onScreen() -> [[String: Any]]? {
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]]
    }

    static func candidates(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> [WindowInfo] {
        allWindows(for: processIdentifier, from: windows).filter { $0.layer == 0 }
    }

    static func allWindows(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> [WindowInfo] {
        windows.compactMap { window -> WindowInfo? in
            guard
                window[kCGWindowOwnerPID as String] as? pid_t == processIdentifier,
                let layer = window[kCGWindowLayer as String] as? Int,
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
                title: normalize(window[kCGWindowName as String] as? String),
                layer: layer
            )
        }
    }

    static func pick(
        for processIdentifier: pid_t,
        from windows: [[String: Any]],
        rules: WindowRules = .standard
    ) -> WindowInfo? {
        let candidates = candidates(
            for: processIdentifier,
            from: windows
        )
        return candidates
            .filter { qualifies($0, rules: rules) }
            .reduce(nil) { selected, candidate in
                guard let selected else {
                    return candidate
                }
                return area(of: candidate.frame) > area(of: selected.frame)
                    ? candidate
                    : selected
            }
    }

    static func captureRoot(
        containing targetWindowIdentifier: CGWindowID,
        for processIdentifier: pid_t,
        from windows: [[String: Any]],
        rules: WindowRules = .standard
    ) -> WindowInfo? {
        let ordered = allWindows(for: processIdentifier, from: windows)
        guard let targetIndex = ordered.firstIndex(where: {
            $0.id == targetWindowIdentifier
        }) else {
            return nil
        }
        let target = ordered[targetIndex]
        if target.layer == 0 && qualifies(target, rules: rules) {
            return target
        }
        return ordered[targetIndex...]
            .filter {
                $0.layer == 0
                    && qualifies($0, rules: rules)
                    && $0.frame.contains(target.frame)
            }
            .reduce(nil) { selected, candidate in
                guard let selected else {
                    return candidate
                }
                return area(of: candidate.frame) > area(of: selected.frame)
                    ? candidate
                    : selected
            }
    }

    static func members(
        of root: WindowInfo,
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> [WindowInfo] {
        let ordered = allWindows(for: processIdentifier, from: windows)
        guard let rootIndex = ordered.firstIndex(where: { $0.id == root.id }) else {
            return []
        }
        return ordered[..<rootIndex].filter {
            $0.id != root.id && root.frame.contains($0.frame)
        }
    }

    static func qualifies(_ window: WindowInfo, rules: WindowRules) -> Bool {
        window.frame.width >= rules.minimumWidth
            && window.frame.height >= rules.minimumHeight
            && aspectRatio(of: window.frame) <= rules.maximumAspectRatio
    }

    static func shouldGroup(
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

    private static func area(of frame: CGRect) -> CGFloat {
        frame.width * frame.height
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
