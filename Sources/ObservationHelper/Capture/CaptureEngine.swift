import AppKit
import CaptureCore
import CoreGraphics
import ScreenCaptureKit

enum CaptureError: LocalizedError {
    case noExternalFrontmostWindow

    var errorDescription: String? {
        switch self {
        case .noExternalFrontmostWindow:
            "No external frontmost window is available"
        }
    }
}

enum CaptureEngine {
    @MainActor
    static func capture(
        signal: NativeActivitySignal,
        excluding filter: SelfFilter,
        configuration: NativeObservationConfiguration
    ) async throws -> NativeCaptureResult {
        guard let window = WindowResolver.currentWindow(
            excluding: filter,
            configuration: configuration.windowSelection
        ) else {
            throw CaptureError.noExternalFrontmostWindow
        }

        async let screenshotResult = captureScreenshot(
            window: window,
            screenshotConfiguration: configuration.screenshot,
            visualConfiguration: configuration.visualMonitoring
        )
        async let accessibilityResult = Task.detached(priority: .utility) {
            AXSnapshot.capture(
                window: window,
                configuration: configuration.accessibility
            )
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
        window: WindowMetadata,
        screenshotConfiguration: NativeObservationConfiguration.Screenshot,
        visualConfiguration: NativeObservationConfiguration.VisualMonitoring
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
            let target = try await Target.resolve(
                id: windowIdentifier,
                maxWidth: screenshotConfiguration.maxWidth
            )
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: target.filter,
                configuration: target.configuration
            )
            guard let jpeg = NSBitmapImageRep(cgImage: image).representation(
                using: .jpeg,
                properties: [
                    .compressionFactor: screenshotConfiguration.jpegQuality
                ]
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
                Signature.make(
                    from: image,
                    configuration: visualConfiguration
                )
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
