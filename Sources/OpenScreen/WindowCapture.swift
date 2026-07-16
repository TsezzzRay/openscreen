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
        guard let windowID = frontmostWindowID(for: application.processIdentifier) else {
            throw WindowCaptureError.noWindow
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        )
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw WindowCaptureError.noWindow
        }

        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(window.frame.width.rounded()))
        configuration.height = max(1, Int(window.frame.height.rounded()))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(desktopIndependentWindow: window),
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

    private func frontmostWindowID(for processIdentifier: pid_t) -> CGWindowID? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        for window in windows {
            guard
                window[kCGWindowOwnerPID as String] as? pid_t == processIdentifier,
                window[kCGWindowLayer as String] as? Int == 0,
                let number = window[kCGWindowNumber as String] as? CGWindowID,
                let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                (bounds["Width"] ?? 0) > 1,
                (bounds["Height"] ?? 0) > 1
            else {
                continue
            }
            return number
        }
        return nil
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
