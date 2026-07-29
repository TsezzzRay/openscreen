import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

@MainActor
final class VisualStreamMonitor {
    private let writer: JSONLineWriter
    private let sampleQueue = DispatchQueue(
        label: "OpenScreenObservationHelper.visual",
        qos: .utility
    )
    private var stream: SCStream?
    private var receiver: VisualFrameReceiver?
    private var generation = 0

    init(writer: JSONLineWriter) {
        self.writer = writer
    }

    func restart(
        for window: WindowMetadata?,
        configuration nativeConfiguration:
            NativeObservationConfiguration.VisualMonitoring
    ) {
        stop()
        guard let window, let windowIdentifier = window.windowIdentifier else {
            return
        }
        generation += 1
        let expectedGeneration = generation
        Task { @MainActor [weak self] in
            guard let self else {
                return
            }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    true,
                    onScreenWindowsOnly: true
                )
                guard
                    expectedGeneration == generation,
                    let captureWindow = content.windows.first(where: {
                        $0.windowID == windowIdentifier
                    })
                else {
                    return
                }
                let configuration = SCStreamConfiguration()
                let scale = min(
                    1,
                    CGFloat(nativeConfiguration.maxWidth)
                        / max(1, captureWindow.frame.width)
                )
                configuration.width = max(
                    1,
                    Int((captureWindow.frame.width * scale).rounded())
                )
                configuration.height = max(
                    1,
                    Int((captureWindow.frame.height * scale).rounded())
                )
                configuration.minimumFrameInterval = CMTime(
                    value: Int64(nativeConfiguration.sampleIntervalMilliseconds),
                    timescale: 1_000
                )
                configuration.queueDepth = nativeConfiguration.queueDepth
                configuration.pixelFormat = kCVPixelFormatType_32BGRA
                configuration.showsCursor = false

                let receiver = VisualFrameReceiver(
                    window: window,
                    configuration: nativeConfiguration
                ) { [writer] signal in
                    writer.write(.activity(signal))
                }
                let stream = SCStream(
                    filter: SCContentFilter(desktopIndependentWindow: captureWindow),
                    configuration: configuration,
                    delegate: nil
                )
                try stream.addStreamOutput(
                    receiver,
                    type: .screen,
                    sampleHandlerQueue: sampleQueue
                )
                try await stream.startCapture()
                guard expectedGeneration == generation else {
                    try? await stream.stopCapture()
                    return
                }
                self.receiver = receiver
                self.stream = stream
                writer.write(.status(component: "visualStream", status: "ready"))
            } catch {
                writer.write(
                    .status(
                        component: "visualStream",
                        status: "degraded",
                        message: error.localizedDescription
                    )
                )
            }
        }
    }

    func stop() {
        generation += 1
        let oldStream = stream
        stream = nil
        receiver = nil
        if let oldStream {
            Task {
                try? await oldStream.stopCapture()
            }
        }
    }
}

private final class VisualFrameReceiver: NSObject, SCStreamOutput, @unchecked Sendable {
    private let window: WindowMetadata
    private let configuration: NativeObservationConfiguration.VisualMonitoring
    private let emit: @Sendable (NativeActivitySignal) -> Void
    private var previousSignature: [UInt8]?

    init(
        window: WindowMetadata,
        configuration: NativeObservationConfiguration.VisualMonitoring,
        emit: @escaping @Sendable (NativeActivitySignal) -> Void
    ) {
        self.window = window
        self.configuration = configuration
        self.emit = emit
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard
            outputType == .screen,
            sampleBuffer.isValid,
            let pixelBuffer = sampleBuffer.imageBuffer
        else {
            return
        }
        let signature = VisualSignature.make(
            from: pixelBuffer,
            configuration: configuration
        )
        guard !signature.isEmpty else {
            return
        }
        defer {
            previousSignature = signature
        }
        guard
            let previousSignature,
            VisualSignature.distance(previousSignature, signature)
                >= configuration.changeThreshold
        else {
            return
        }
        emit(
            NativeActivitySignal(
                kind: .visualChanged,
                occurredAt: iso8601Timestamp(),
                window: window
            )
        )
    }
}
