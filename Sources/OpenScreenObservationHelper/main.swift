import Foundation

final class JSONLineReader: @unchecked Sendable {
    private let handle: FileHandle
    private let onLine: @Sendable (String) -> Void
    private let onEnd: @Sendable () -> Void
    private let lock = NSLock()
    private var buffer = Data()
    private var ended = false

    init(
        handle: FileHandle,
        onLine: @escaping @Sendable (String) -> Void,
        onEnd: @escaping @Sendable () -> Void
    ) {
        self.handle = handle
        self.onLine = onLine
        self.onEnd = onEnd
    }

    func start() {
        Thread.detachNewThread { [self] in
            while true {
                let data = handle.availableData
                consume(data)
                if data.isEmpty {
                    break
                }
            }
        }
    }

    func stop() {
        lock.lock()
        ended = true
        lock.unlock()
    }

    private func consume(_ data: Data) {
        lock.lock()
        if data.isEmpty {
            let shouldEnd = !ended
            ended = true
            lock.unlock()
            if shouldEnd {
                onEnd()
            }
            return
        }
        buffer.append(data)
        var lines = [String]()
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[..<newline]
            buffer.removeSubrange(...newline)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                lines.append(line)
            }
        }
        lock.unlock()
        for line in lines {
            onLine(line)
        }
    }
}

@MainActor
final class HelperRuntime {
    private let writer: JSONLineWriter
    private let monitor: ActivityMonitor
    private var reader: JSONLineReader?
    private var filter: SelfCaptureFilter?
    private var signalSources = [DispatchSourceSignal]()
    private var stopped = false

    init(writer: JSONLineWriter) {
        self.writer = writer
        self.monitor = ActivityMonitor(writer: writer)
    }

    func start() {
        let reader = JSONLineReader(
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
            let command = try HelperCommand.decode(line)
            guard command.protocolVersion == 1 else {
                writer.write(
                    .error(
                        requestId: command.requestId,
                        code: "unsupported_protocol",
                        message: "Unsupported helper protocol version"
                    )
                )
                return
            }
            switch command.type {
            case .configure:
                configure(command)
            case .capture:
                capture(command)
            case .shutdown:
                shutdown()
            }
        } catch {
            writer.write(
                .error(
                    code: "invalid_command",
                    message: error.localizedDescription
                )
            )
        }
    }

    private func configure(_ command: HelperCommand) {
        var processIdentifiers = Set(command.excludedProcessIdentifiers ?? [])
        processIdentifiers.insert(ProcessInfo.processInfo.processIdentifier)
        var bundleIdentifiers = Set(command.excludedBundleIdentifiers ?? [])
        if let bundleIdentifier = Bundle.main.bundleIdentifier {
            bundleIdentifiers.insert(bundleIdentifier)
        }
        let filter = SelfCaptureFilter(
            processIdentifiers: processIdentifiers,
            bundleIdentifiers: bundleIdentifiers
        )
        self.filter = filter
        monitor.start(filter: filter)
        writer.write(.configured(requestId: command.requestId))
    }

    private func capture(_ command: HelperCommand) {
        guard let filter, let signal = command.signal else {
            writer.write(
                .error(
                    requestId: command.requestId,
                    code: "not_configured",
                    message: "Observation helper is not configured"
                )
            )
            return
        }
        Task { @MainActor [writer] in
            do {
                let result = try await ObservationCaptureEngine.capture(
                    signal: signal,
                    excluding: filter
                )
                writer.write(
                    .captureResult(
                        requestId: command.requestId,
                        result: result
                    )
                )
            } catch {
                writer.write(
                    .error(
                        requestId: command.requestId,
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

let helperWriter = JSONLineWriter()
Task { @MainActor in
    let runtime = HelperRuntime(writer: helperWriter)
    runtime.start()
}
RunLoop.main.run()
