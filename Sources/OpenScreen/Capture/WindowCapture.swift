import AppKit
import CoreGraphics
import ScreenCaptureKit

enum WindowCaptureError: Error {
    case noFrontmostApplication
    case noWindow
    case pngEncodingFailed
}

struct WindowCapture {
    static func requestPermission() {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
        }
    }

    func captureActiveWindow() async throws -> URL {
        guard let application = NSWorkspace.shared.frontmostApplication else {
            throw WindowCaptureError.noFrontmostApplication
        }
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]],
        let windowID = Self.selectWindowID(
            for: application.processIdentifier,
            from: windows
        ) else {
            throw WindowCaptureError.noWindow
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw WindowCaptureError.noWindow
        }

        var filter = SCContentFilter(desktopIndependentWindow: window)
        var captureSize = window.frame.size
        let configuration = SCStreamConfiguration()

        if Self.shouldCaptureWindowGroup(
            for: application.processIdentifier,
            from: windows
        ), let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) {
            let applicationWindows = content.windows.filter {
                $0.owningApplication?.processID == application.processIdentifier
                    && $0.windowLayer == 0
                    && $0.isOnScreen
                    && $0.frame.intersects(display.frame)
            }
            let union = applicationWindows.reduce(CGRect.null) { $0.union($1.frame) }
                .intersection(display.frame)
            if applicationWindows.count > 1, !union.isNull, !union.isEmpty {
                filter = SCContentFilter(display: display, including: applicationWindows)
                configuration.sourceRect = union.offsetBy(
                    dx: -display.frame.minX,
                    dy: -display.frame.minY
                )
                captureSize = union.size
            }
        }

        configuration.width = max(1, Int(captureSize.width.rounded()))
        configuration.height = max(1, Int(captureSize.height.rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw WindowCaptureError.pngEncodingFailed
        }

        let directory = try screenshotDirectory()
        let filename = "\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString).png"
        let url = directory.appendingPathComponent(filename)
        try png.write(to: url, options: .atomic)
        return url
    }

    static func selectWindowID(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> CGWindowID? {
        let candidates = windowCandidates(for: processIdentifier, from: windows)

        return candidates.first(where: {
            $0.frame.width >= 160
                && $0.frame.height >= 120
                && max(
                    $0.frame.width / $0.frame.height,
                    $0.frame.height / $0.frame.width
                ) <= 4
        })?.id ?? candidates.first?.id
    }

    static func shouldCaptureWindowGroup(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> Bool {
        let candidates = windowCandidates(for: processIdentifier, from: windows)
        guard let first = candidates.first else { return false }
        let aspectRatio = max(
            first.frame.width / first.frame.height,
            first.frame.height / first.frame.width
        )
        guard aspectRatio > 4 else { return false }

        return candidates.dropFirst().contains {
            $0.frame.width >= first.frame.width * 0.8
                && $0.frame.height >= first.frame.height * 2
        }
    }

    private struct WindowCandidate {
        let id: CGWindowID
        let frame: CGRect
    }

    private static func windowCandidates(
        for processIdentifier: pid_t,
        from windows: [[String: Any]]
    ) -> [WindowCandidate] {
        windows.compactMap { window -> WindowCandidate? in
            guard
                window[kCGWindowOwnerPID as String] as? pid_t == processIdentifier,
                window[kCGWindowLayer as String] as? Int == 0,
                let number = window[kCGWindowNumber as String] as? CGWindowID,
                let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                let width = bounds["Width"],
                let height = bounds["Height"],
                width > 1,
                height > 1
            else {
                return nil
            }
            return WindowCandidate(
                id: number,
                frame: CGRect(
                    x: bounds["X"] ?? 0,
                    y: bounds["Y"] ?? 0,
                    width: width,
                    height: height
                )
            )
        }
    }

    private func screenshotDirectory() throws -> URL {
        let applicationSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = applicationSupport
            .appendingPathComponent("OpenScreen", isDirectory: true)
            .appendingPathComponent("screenshots", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }
}
