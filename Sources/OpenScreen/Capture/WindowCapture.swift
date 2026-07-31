import AppKit
import CaptureCore
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
        guard let windows = Windows.onScreen(),
        let windowID = Windows.pick(
            for: application.processIdentifier,
            from: windows
        )?.id else {
            throw WindowCaptureError.noWindow
        }

        let target = try await Target.resolve(id: windowID)
        let content = target.content
        let window = target.window
        var filter = target.filter
        var captureSize = window.frame.size
        let configuration = target.configuration

        if Windows.shouldGroup(
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
