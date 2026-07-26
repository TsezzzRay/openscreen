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

    func restart(for window: WindowMetadata?) {
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
                let scale = min(1, 320 / max(1, captureWindow.frame.width))
                configuration.width = max(
                    1,
                    Int((captureWindow.frame.width * scale).rounded())
                )
                configuration.height = max(
                    1,
                    Int((captureWindow.frame.height * scale).rounded())
                )
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
                configuration.queueDepth = 2
                configuration.pixelFormat = kCVPixelFormatType_32BGRA
                configuration.showsCursor = false

                let receiver = VisualFrameReceiver(window: window) { [writer] signal in
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
    private static let changeThreshold = 0.015

    private let window: WindowMetadata
    private let emit: @Sendable (NativeActivitySignal) -> Void
    private var previousSignature: [UInt8]?

    init(
        window: WindowMetadata,
        emit: @escaping @Sendable (NativeActivitySignal) -> Void
    ) {
        self.window = window
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
        let signature = VisualSignature.make(from: pixelBuffer)
        guard !signature.isEmpty else {
            return
        }
        defer {
            previousSignature = signature
        }
        guard
            let previousSignature,
            VisualSignature.distance(previousSignature, signature) >= Self.changeThreshold
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
