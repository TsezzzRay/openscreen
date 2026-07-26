import AppKit
import CoreGraphics
import ScreenCaptureKit

enum ObservationCaptureError: LocalizedError {
    case noExternalFrontmostWindow

    var errorDescription: String? {
        switch self {
        case .noExternalFrontmostWindow:
            "No external frontmost window is available"
        }
    }
}

enum ObservationCaptureEngine {
    @MainActor
    static func capture(
        signal: NativeActivitySignal,
        excluding filter: SelfCaptureFilter
    ) async throws -> NativeCaptureResult {
        guard let window = WindowResolver.currentWindow(excluding: filter) else {
            throw ObservationCaptureError.noExternalFrontmostWindow
        }

        async let screenshotResult = captureScreenshot(window: window)
        async let accessibilityResult = Task.detached(priority: .utility) {
            AccessibilitySnapshotter.capture(window: window)
        }.value
        let (screenshot, visualSignature) = await screenshotResult
        let accessibility = await accessibilityResult

        return NativeCaptureResult(
            capturedAt: iso8601Timestamp(),
            window: window,
            screenshot: screenshot,
            accessibility: accessibility,
            visualSignature: visualSignature
        )
    }

    private static func captureScreenshot(
        window: WindowMetadata
    ) async -> (ScreenshotCapture, [UInt8]?) {
        let startedAt = Date()
        guard CGPreflightScreenCaptureAccess() else {
            return (
                ScreenshotCapture(
                    status: .permissionDenied,
                    durationMilliseconds: milliseconds(since: startedAt),
                    mimeType: nil,
                    dataBase64: nil,
                    width: nil,
                    height: nil
                ),
                nil
            )
        }
        guard let windowIdentifier = window.windowIdentifier else {
            return (
                ScreenshotCapture(
                    status: .unsupported,
                    durationMilliseconds: milliseconds(since: startedAt),
                    mimeType: nil,
                    dataBase64: nil,
                    width: nil,
                    height: nil
                ),
                nil
            )
        }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: true
            )
            guard let captureWindow = content.windows.first(where: {
                $0.windowID == windowIdentifier
            }) else {
                return (
                    ScreenshotCapture(
                        status: .unsupported,
                        durationMilliseconds: milliseconds(since: startedAt),
                        mimeType: nil,
                        dataBase64: nil,
                        width: nil,
                        height: nil
                    ),
                    nil
                )
            }
            let configuration = SCStreamConfiguration()
            let scale = min(1, 1_920 / max(1, captureWindow.frame.width))
            configuration.width = max(
                1,
                Int((captureWindow.frame.width * scale).rounded())
            )
            configuration.height = max(
                1,
                Int((captureWindow.frame.height * scale).rounded())
            )
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: captureWindow),
                configuration: configuration
            )
            guard let jpeg = NSBitmapImageRep(cgImage: image).representation(
                using: .jpeg,
                properties: [.compressionFactor: 0.85]
            ) else {
                throw CocoaError(.fileWriteUnknown)
            }
            return (
                ScreenshotCapture(
                    status: .complete,
                    durationMilliseconds: milliseconds(since: startedAt),
                    mimeType: "image/jpeg",
                    dataBase64: jpeg.base64EncodedString(),
                    width: image.width,
                    height: image.height
                ),
                VisualSignature.make(from: image)
            )
        } catch {
            FileHandle.standardError.write(
                Data("OpenScreen screenshot capture failed: \(error)\n".utf8)
            )
            return (
                ScreenshotCapture(
                    status: .failed,
                    durationMilliseconds: milliseconds(since: startedAt),
                    mimeType: nil,
                    dataBase64: nil,
                    width: nil,
                    height: nil
                ),
                nil
            )
        }
    }

    private static func milliseconds(since date: Date) -> Double {
        Date().timeIntervalSince(date) * 1_000
    }
}
