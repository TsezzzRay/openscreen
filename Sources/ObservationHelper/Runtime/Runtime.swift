import Foundation

@MainActor
final class Runtime {
    private let writer: LineWriter
    private let monitor: Monitor
    private var reader: LineReader?
    private var filter: SelfFilter?
    private var configuration: NativeObservationConfiguration?
    private var captureGate = CaptureGate()
    private var signalSources = [DispatchSourceSignal]()
    private var stopped = false

    init(writer: LineWriter) {
        self.writer = writer
        self.monitor = Monitor(
            onSignal: { [writer] signal in
                writer.write(.signal(signal))
            },
            onStatus: { [writer] status in
                writer.write(.status(status))
            },
            onDiagnostic: { [writer] diagnostic in
                writer.write(.diagnostic(diagnostic))
            }
        )
    }

    func start() {
        let reader = LineReader(
            handle: .standardInput,
            onLine: { [self] line in
                Task { @MainActor in
                    handle(line: line)
                }
            },
            onEnd: { [self] in
                Task { @MainActor in
                    shutdown()
                }
            }
        )
        self.reader = reader
        reader.start()
        installSignalHandlers()
        writer.write(
            .ready(
                processIdentifier: ProcessInfo.processInfo.processIdentifier
            )
        )
    }

    private func handle(line: String) {
        do {
            let command = try Wire.Command.decode(line)
            switch command {
            case .configure(let request):
                configure(request)
            case .capture(let request):
                capture(request)
            case .shutdown:
                shutdown()
            }
        } catch {
            writer.write(
                .error(
                    requestId: nil,
                    code: "invalid_command",
                    message: error.localizedDescription
                )
            )
        }
    }

    private func configure(_ request: Wire.Configure) {
        var processIdentifiers = Set(request.excludedProcessIdentifiers)
        processIdentifiers.insert(ProcessInfo.processInfo.processIdentifier)
        var bundleIdentifiers = Set(request.excludedBundleIdentifiers)
        if let bundleIdentifier = Bundle.main.bundleIdentifier {
            bundleIdentifiers.insert(bundleIdentifier)
        }
        let filter = SelfFilter(
            processIdentifiers: processIdentifiers,
            bundleIdentifiers: bundleIdentifiers
        )
        self.filter = filter
        configuration = request.configuration
        monitor.start(filter: filter, configuration: request.configuration)
        writer.write(.configured(requestId: request.requestId))
    }

    private func capture(_ request: Wire.Capture) {
        guard let filter, let configuration else {
            writer.write(
                .error(
                    requestId: request.requestId,
                    code: "not_configured",
                    message: "Observation helper is not configured"
                )
            )
            return
        }
        guard captureGate.begin(requestIdentifier: request.requestId) else {
            writer.write(
                .error(
                    requestId: request.requestId,
                    code: "capture_busy",
                    message: "Another observation capture is still running"
                )
            )
            return
        }
        Task { @MainActor [writer, self] in
            defer {
                captureGate.end(requestIdentifier: request.requestId)
            }
            do {
                let result = try await CaptureEngine.capture(
                    target: request.target,
                    excluding: filter,
                    configuration: configuration
                )
                writer.write(
                    .captureResult(
                        requestId: request.requestId,
                        result: result
                    )
                )
            } catch let captureError as CaptureError {
                writer.write(
                    .error(
                        requestId: request.requestId,
                        code: captureError.code,
                        message: captureError.localizedDescription
                    )
                )
            } catch {
                writer.write(
                    .error(
                        requestId: request.requestId,
                        code: "capture_failed",
                        message: error.localizedDescription
                    )
                )
            }
        }
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: .main
            )
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    self?.shutdown()
                }
            }
            source.resume()
            signalSources.append(source)
        }
    }

    func shutdown() {
        guard !stopped else {
            return
        }
        stopped = true
        reader?.stop()
        reader = nil
        monitor.stop()
        for source in signalSources {
            source.cancel()
        }
        signalSources.removeAll()
        exit(EXIT_SUCCESS)
    }
}
