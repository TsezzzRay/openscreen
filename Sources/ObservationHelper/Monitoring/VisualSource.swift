import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

@MainActor
final class VisualSource {
    private let onSignal: @Sendable (NativeActivitySignal) -> Void
    private let onStatus: @Sendable (SourceStatus) -> Void
    private let onDiagnostic: @Sendable (NativeDiagnosticEvent) -> Void
    private let sampleQueue = DispatchQueue(
        label: "ObservationHelper.visual",
        qos: .utility
    )
    private var activeStream: ActiveVisualStream?
    private var desiredStream: DesiredVisualStream?
    private var generation = VisualStreamGeneration()
    private var recoveryBackoff = VisualRecoveryBackoff()
    private var transitionTask: Task<Void, Never>?

    init(
        onSignal: @escaping @Sendable (NativeActivitySignal) -> Void,
        onStatus: @escaping @Sendable (SourceStatus) -> Void,
        onDiagnostic: @escaping @Sendable (NativeDiagnosticEvent) -> Void
    ) {
        self.onSignal = onSignal
        self.onStatus = onStatus
        self.onDiagnostic = onDiagnostic
    }

    func restart(
        for window: WindowMetadata?,
        configuration nativeConfiguration:
            NativeObservationConfiguration.VisualMonitoring,
        validateWindow: @escaping @MainActor @Sendable (
            WindowMetadata
        ) -> WindowMetadata?
    ) {
        recoveryBackoff.reset()
        guard let window, window.windowIdentifier != nil else {
            desiredStream = nil
            scheduleTransition(to: nil, recovering: false)
            return
        }
        let desired = DesiredVisualStream(
            window: window,
            configuration: nativeConfiguration,
            validateWindow: validateWindow
        )
        desiredStream = desired
        scheduleTransition(to: desired, recovering: false)
    }

    func stop() {
        recoveryBackoff.reset()
        desiredStream = nil
        scheduleTransition(to: nil, recovering: false)
    }

    @discardableResult
    private func scheduleTransition(
        to desired: DesiredVisualStream?,
        recovering: Bool,
        delayMilliseconds: Int = 0
    ) -> Int {
        let expectedGeneration = generation.advance()
        let previousTask = transitionTask
        let oldStream = activeStream
        activeStream = nil
        if recovering {
            onDiagnostic(NativeDiagnosticEvent(
                event: .visualRestarting,
                reason: nil,
                generation: expectedGeneration,
                windowIdentifier: desired?.window.windowIdentifier,
                delayMilliseconds: delayMilliseconds
            ))
        }
        transitionTask = Task { @MainActor [weak self] in
            await previousTask?.value
            guard let self else {
                return
            }
            if let oldStream {
                await stop(oldStream)
            }
            guard generation.disposition(for: expectedGeneration) == .current,
                  let desired
            else {
                return
            }
            if delayMilliseconds > 0 {
                try? await Task.sleep(
                    for: .milliseconds(delayMilliseconds)
                )
            }
            guard generation.disposition(for: expectedGeneration) == .current else {
                return
            }
            await start(
                desired,
                generation: expectedGeneration,
                recovering: recovering
            )
        }
        return expectedGeneration
    }

    private func start(
        _ desired: DesiredVisualStream,
        generation expectedGeneration: Int,
        recovering: Bool
    ) async {
        guard
            let resolvedWindow = desired.validateWindow(desired.window),
            let windowIdentifier = resolvedWindow.windowIdentifier
        else {
            onDiagnostic(NativeDiagnosticEvent(
                event: .cachedTargetRejected,
                reason: "visual_start_target_unavailable",
                generation: expectedGeneration,
                windowIdentifier: desired.window.windowIdentifier
            ))
            return
        }
        let currentDesired = DesiredVisualStream(
            window: resolvedWindow,
            configuration: desired.configuration,
            validateWindow: desired.validateWindow
        )
        desiredStream = currentDesired
        do {
            let target = try await Target.resolve(
                id: windowIdentifier,
                maxWidth: currentDesired.configuration.maxWidth
            )
            guard generation.disposition(for: expectedGeneration) == .current else {
                return
            }
            let streamConfiguration = target.configuration
            streamConfiguration.minimumFrameInterval = CMTime(
                value: Int64(desired.configuration.sampleIntervalMilliseconds),
                timescale: 1_000
            )
            streamConfiguration.queueDepth = currentDesired.configuration.queueDepth
            streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
            streamConfiguration.showsCursor = false

            let receiver = VisualFrameReceiver(
                window: currentDesired.window,
                configuration: currentDesired.configuration
            ) { [onSignal] signal in
                onSignal(signal)
            }
            let delegate = VisualStreamDelegate(
                generation: expectedGeneration,
                windowIdentifier: windowIdentifier
            ) { [weak self] stoppedGeneration, stoppedWindowIdentifier, error in
                Task { @MainActor [weak self] in
                    self?.didStop(
                        generation: stoppedGeneration,
                        windowIdentifier: stoppedWindowIdentifier,
                        error: error
                    )
                }
            }
            let stream = SCStream(
                filter: target.filter,
                configuration: streamConfiguration,
                delegate: delegate
            )
            try stream.addStreamOutput(
                receiver,
                type: .screen,
                sampleHandlerQueue: sampleQueue
            )
            try await stream.startCapture()
            let active = ActiveVisualStream(
                stream: stream,
                receiver: receiver,
                delegate: delegate,
                generation: expectedGeneration,
                windowIdentifier: windowIdentifier
            )
            guard generation.disposition(for: expectedGeneration) == .current else {
                await stop(active)
                return
            }
            activeStream = active
            onStatus(SourceStatus(
                component: .visualStream,
                state: .ready,
                message: nil
            ))
            if recovering {
                onDiagnostic(NativeDiagnosticEvent(
                    event: .visualRecovered,
                    reason: nil,
                    generation: expectedGeneration,
                    windowIdentifier: currentDesired.window.windowIdentifier
                ))
            }
        } catch {
            guard generation.disposition(for: expectedGeneration) == .current else {
                return
            }
            onStatus(SourceStatus(
                component: .visualStream,
                state: .degraded,
                message: diagnosticReason(error)
            ))
        }
    }

    private func stop(_ active: ActiveVisualStream) async {
        do {
            try await active.stream.stopCapture()
        } catch {
            onDiagnostic(NativeDiagnosticEvent(
                event: .visualStreamStopped,
                reason: "stop_failed:" + diagnosticReason(error),
                generation: active.generation,
                windowIdentifier: active.windowIdentifier
            ))
        }
    }

    private func didStop(
        generation stoppedGeneration: Int,
        windowIdentifier: CGWindowID,
        error: Error
    ) {
        let reason = diagnosticReason(error)
        onDiagnostic(NativeDiagnosticEvent(
            event: .visualStreamStopped,
            reason: reason,
            generation: stoppedGeneration,
            windowIdentifier: windowIdentifier
        ))
        guard generation.disposition(for: stoppedGeneration) == .current,
              activeStream?.generation == stoppedGeneration
        else {
            return
        }
        onStatus(SourceStatus(
            component: .visualStream,
            state: .degraded,
            message: reason
        ))
        guard let desiredStream,
              let resolvedWindow = desiredStream.validateWindow(
                  desiredStream.window
              )
        else {
            let invalidatedWindowIdentifier = desiredStream?
                .window.windowIdentifier
            desiredStream = nil
            onDiagnostic(NativeDiagnosticEvent(
                event: .cachedTargetRejected,
                reason: "visual_restart_target_unavailable",
                generation: stoppedGeneration,
                windowIdentifier: invalidatedWindowIdentifier
            ))
            scheduleTransition(to: nil, recovering: false)
            return
        }
        let recovered = DesiredVisualStream(
            window: resolvedWindow,
            configuration: desiredStream.configuration,
            validateWindow: desiredStream.validateWindow
        )
        self.desiredStream = recovered
        let delayMilliseconds = recoveryBackoff.delayMilliseconds(
            at: Int64(Date().timeIntervalSince1970 * 1_000)
        )
        scheduleTransition(
            to: recovered,
            recovering: true,
            delayMilliseconds: delayMilliseconds
        )
    }
}

struct VisualStreamGeneration {
    enum Disposition: Equatable {
        case current
        case stale
    }

    private var currentGeneration = 0

    mutating func advance() -> Int {
        currentGeneration += 1
        return currentGeneration
    }

    func disposition(for generation: Int) -> Disposition {
        generation == currentGeneration ? .current : .stale
    }
}

struct VisualRecoveryBackoff {
    private let stabilityWindowMilliseconds: Int64
    private var lastFailureMilliseconds: Int64?
    private var consecutiveFailures = 0

    init(stabilityWindowMilliseconds: Int64 = 10_000) {
        self.stabilityWindowMilliseconds = stabilityWindowMilliseconds
    }

    mutating func delayMilliseconds(at nowMilliseconds: Int64) -> Int {
        if let lastFailureMilliseconds,
           nowMilliseconds >= lastFailureMilliseconds,
           nowMilliseconds - lastFailureMilliseconds <= stabilityWindowMilliseconds
        {
            consecutiveFailures += 1
        } else {
            consecutiveFailures = 1
        }
        lastFailureMilliseconds = nowMilliseconds
        guard consecutiveFailures > 1 else {
            return 0
        }
        let exponent = min(consecutiveFailures - 2, 3)
        return min(2_000, 250 * (1 << exponent))
    }

    mutating func reset() {
        lastFailureMilliseconds = nil
        consecutiveFailures = 0
    }
}

private struct DesiredVisualStream {
    let window: WindowMetadata
    let configuration: NativeObservationConfiguration.VisualMonitoring
    let validateWindow: @MainActor @Sendable (
        WindowMetadata
    ) -> WindowMetadata?
}

private struct ActiveVisualStream {
    let stream: SCStream
    let receiver: VisualFrameReceiver
    let delegate: VisualStreamDelegate
    let generation: Int
    let windowIdentifier: CGWindowID
}

private final class VisualStreamDelegate: NSObject, SCStreamDelegate,
    @unchecked Sendable
{
    private let generation: Int
    private let windowIdentifier: CGWindowID
    private let onStopped: @Sendable (Int, CGWindowID, Error) -> Void

    init(
        generation: Int,
        windowIdentifier: CGWindowID,
        onStopped: @escaping @Sendable (Int, CGWindowID, Error) -> Void
    ) {
        self.generation = generation
        self.windowIdentifier = windowIdentifier
        self.onStopped = onStopped
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStopped(generation, windowIdentifier, error)
    }
}

private func diagnosticReason(_ error: Error) -> String {
    let error = error as NSError
    return "\(error.domain):\(error.code)"
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
                window: window,
                visualSignature: signature
            )
        )
    }
}
