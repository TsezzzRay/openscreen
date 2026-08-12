import AppKit
import CoreGraphics
import ScreenCaptureKit

enum CaptureError: LocalizedError {
    case targetUnavailable
    case targetChangedDuringCapture

    var errorDescription: String? {
        switch self {
        case .targetUnavailable:
            "The frozen capture target is unavailable"
        case .targetChangedDuringCapture:
            "The frozen capture target changed during capture"
        }
    }

    var code: String {
        switch self {
        case .targetUnavailable:
            "target_unavailable"
        case .targetChangedDuringCapture:
            "target_changed_during_capture"
        }
    }
}

enum CaptureEngine {
    private struct PreparedScreenshotTarget {
        let startedAt: Date
        let target: Target?
        let failureStatus: CaptureStatus?
        let failureReason: ScreenshotFailureReason?
    }

    @MainActor
    static func capture(
        target: WindowMetadata,
        excluding filter: SelfFilter,
        configuration: NativeObservationConfiguration
    ) async throws -> NativeCaptureResult {
        let preflightStartedAt = Date()
        guard let group = WindowResolver.resolveFrozenCaptureGroup(
            target,
            excluding: filter,
            configuration: configuration.windowSelection
        ) else {
            throw CaptureError.targetUnavailable
        }
        let window = group.root
        guard
            let rootWindowIdentifier = window.windowIdentifier,
            let rootFrame = window.frame
        else {
            throw CaptureError.targetUnavailable
        }
        let preflightDurationMilliseconds = milliseconds(
            since: preflightStartedAt
        )

        let preparedScreenshot = await prepareScreenshotTarget(
            group: group,
            configuration: configuration.screenshot
        )
        let captureGroup = preparedScreenshot.target.flatMap {
            group.restricting(to: $0.windowIdentifiers)
        } ?? group

        let preparedAccessibility = await Task.detached(priority: .utility) {
            AXSnapshot.prepare(
                group: captureGroup,
                configuration: configuration.accessibility
            )
        }.value
        async let accessibilityResult = Task.detached(priority: .utility) {
            AXSnapshot.capture(
                prepared: preparedAccessibility,
                configuration: configuration.accessibility
            )
        }.value
        let screenshotResult = await captureScreenshot(
            prepared: preparedScreenshot,
            screenshotConfiguration: configuration.screenshot,
            visualConfiguration: configuration.visualMonitoring
        )
        let (screenshot, visualSignature) = screenshotResult
        let accessibility = await accessibilityResult

        let attestationStartedAt = Date()
        guard WindowResolver.resolveFrozenTarget(
            window,
            excluding: filter,
            configuration: configuration.windowSelection
        ) != nil else {
            throw CaptureError.targetChangedDuringCapture
        }
        let attestationDurationMilliseconds = milliseconds(
            since: attestationStartedAt
        )

        return NativeCaptureResult(
            startedAt: iso8601Timestamp(preflightStartedAt),
            capturedAt: iso8601Timestamp(),
            validation: CaptureValidation(
                preflightDurationMilliseconds: preflightDurationMilliseconds,
                attestationDurationMilliseconds: attestationDurationMilliseconds
            ),
            window: window,
            windowGroup: CaptureWindowGroup(
                processIdentifier: window.processIdentifier,
                rootWindowIdentifier: rootWindowIdentifier,
                memberWindowIdentifiers: captureGroup.memberWindowIdentifiers,
                frame: rootFrame
            ),
            screenshot: screenshot,
            accessibility: accessibility,
            visualSignature: visualSignature
        )
    }

    @MainActor
    private static func captureScreenshot(
        prepared: PreparedScreenshotTarget,
        screenshotConfiguration: NativeObservationConfiguration.Screenshot,
        visualConfiguration: NativeObservationConfiguration.VisualMonitoring
    ) async -> (ScreenshotCapture, [UInt8]?) {
        let startedAt = prepared.startedAt
        if let failureStatus = prepared.failureStatus {
            return (
                ScreenshotCapture(
                    status: failureStatus,
                    durationMilliseconds: milliseconds(since: startedAt),
                    failureReason: prepared.failureReason,
                    mimeType: nil,
                    dataBase64: nil,
                    width: nil,
                    height: nil,
                    completedAt: iso8601Timestamp()
                ),
                nil
            )
        }
        guard let target = prepared.target else {
            return (
                ScreenshotCapture(
                    status: .failed,
                    durationMilliseconds: milliseconds(since: startedAt),
                    failureReason: .targetResolutionFailed,
                    mimeType: nil,
                    dataBase64: nil,
                    width: nil,
                    height: nil,
                    completedAt: iso8601Timestamp()
                ),
                nil
            )
        }

        do {
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
                return (
                    ScreenshotCapture(
                        status: .failed,
                        durationMilliseconds: milliseconds(since: startedAt),
                        failureReason: .jpegEncodingFailed,
                        mimeType: nil,
                        dataBase64: nil,
                        width: nil,
                        height: nil,
                        completedAt: iso8601Timestamp()
                    ),
                    nil
                )
            }
            return (
                ScreenshotCapture(
                    status: .complete,
                    durationMilliseconds: milliseconds(since: startedAt),
                    mimeType: "image/jpeg",
                    dataBase64: jpeg.base64EncodedString(),
                    width: image.width,
                    height: image.height,
                    completedAt: iso8601Timestamp()
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
                    failureReason: .captureFailed,
                    mimeType: nil,
                    dataBase64: nil,
                    width: nil,
                    height: nil,
                    completedAt: iso8601Timestamp()
                ),
                nil
            )
        }
    }

    @MainActor
    private static func prepareScreenshotTarget(
        group: FrozenWindowGroup,
        configuration: NativeObservationConfiguration.Screenshot
    ) async -> PreparedScreenshotTarget {
        let startedAt = Date()
        guard CGPreflightScreenCaptureAccess() else {
            return PreparedScreenshotTarget(
                startedAt: startedAt,
                target: nil,
                failureStatus: .permissionDenied,
                failureReason: .permissionDenied
            )
        }
        do {
            return PreparedScreenshotTarget(
                startedAt: startedAt,
                target: try await Target.resolve(
                    group: group,
                    maxWidth: configuration.maxWidth
                ),
                failureStatus: nil,
                failureReason: nil
            )
        } catch {
            FileHandle.standardError.write(
                Data("OpenScreen screenshot target resolution failed: \(error)\n".utf8)
            )
            return PreparedScreenshotTarget(
                startedAt: startedAt,
                target: nil,
                failureStatus: .failed,
                failureReason: (error as? TargetError)?
                    .screenshotFailureReason ?? .targetResolutionFailed
            )
        }
    }

    private static func milliseconds(since date: Date) -> Double {
        Date().timeIntervalSince(date) * 1_000
    }
}
