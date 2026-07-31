import CaptureCore
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

@MainActor
final class VisualSource {
    private let onSignal: @Sendable (NativeActivitySignal) -> Void
    private let onStatus: @Sendable (SourceStatus) -> Void
    private let sampleQueue = DispatchQueue(
        label: "ObservationHelper.visual",
        qos: .utility
    )
    private var stream: SCStream?
    private var receiver: VisualFrameReceiver?
    private var generation = 0

    init(
        onSignal: @escaping @Sendable (NativeActivitySignal) -> Void,
        onStatus: @escaping @Sendable (SourceStatus) -> Void
    ) {
        self.onSignal = onSignal
        self.onStatus = onStatus
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
                let target = try await Target.resolve(
                    id: windowIdentifier,
                    maxWidth: nativeConfiguration.maxWidth
                )
                guard expectedGeneration == generation else {
                    return
                }
                let configuration = target.configuration
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
                ) { [onSignal] signal in
                    onSignal(signal)
                }
                let stream = SCStream(
                    filter: target.filter,
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
                onStatus(
                    SourceStatus(
                        component: .visualStream,
                        state: .ready,
                        message: nil
                    )
                )
            } catch {
                onStatus(
                    SourceStatus(
                        component: .visualStream,
                        state: .degraded,
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
    private var gate: ChangeGate

    init(
        window: WindowMetadata,
        configuration: NativeObservationConfiguration.VisualMonitoring,
        emit: @escaping @Sendable (NativeActivitySignal) -> Void
    ) {
        self.window = window
        self.configuration = configuration
        self.emit = emit
        self.gate = ChangeGate(threshold: configuration.changeThreshold)
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
        let signature = Signature.make(
            from: pixelBuffer,
            configuration: configuration
        )
        guard !signature.isEmpty else {
            return
        }
        guard gate.shouldEmit(signature) else {
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
