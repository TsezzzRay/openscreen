import Darwin
import Foundation

enum AgentClientError: LocalizedError {
    case requestAlreadyRunning
    case processExited
    case requestFailed(ProductFailure)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .requestAlreadyRunning:
            "A request is already running."
        case .processExited:
            "The agent stopped. Restart OpenScreen and try again."
        case .requestFailed, .invalidResponse:
            "Request failed. Please retry."
        }
    }
}

protocol AgentProductClient: Sendable {
    func listSessions() async throws -> [ProductSessionSummary]
    func createSession() async throws -> ProductSessionView
    func getSession(id: String) async throws -> ProductSessionView
    func renameSession(id: String, name: String) async throws -> ProductSessionSummary
    func prompt(
        requestID: String,
        sessionID: String,
        text: String,
        images: [ProductImageAttachment]
    ) async throws -> AsyncThrowingStream<AgentEvent, Error>
    func abort(sessionID: String, targetRequestID: String) async throws
    func compact(sessionID: String, instructions: String?) async throws -> ProductCompactionResult
    func setThinking(
        sessionID: String,
        thinking: ProductThinkingLevel
    ) async throws -> ProductSessionState
}

actor AgentClient: AgentProductClient {
    static let launchArguments = ["node", "agent/dist/main.js"]

    struct DecodedLine {
        let requestID: String
        let event: AgentEvent?
    }

    private struct Pending {
        let continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    }

    private struct Correlation: Decodable {
        let requestId: String
    }

    init(launchArguments: [String] = AgentClient.launchArguments) {
        self.configuredLaunchArguments = launchArguments
    }

    static func decodeLine(_ line: Data) throws -> DecodedLine {
        let correlation = try JSONDecoder().decode(Correlation.self, from: line)
        return DecodedLine(
            requestID: correlation.requestId,
            event: try? JSONDecoder().decode(AgentEvent.self, from: line)
        )
    }

    private let process = Process()
    private let inputPipe = Pipe()
    private let outputPipe = Pipe()
    private let configuredLaunchArguments: [String]
    private var outputTask: Task<Void, Never>?
    private var outputBuffer = Data()
    private var pending: [String: Pending] = [:]
    private var started = false
    private var processTerminated = false
    private var outputEnded = false

    func start() throws {
        if process.isRunning { return }
        guard !started else { throw AgentClientError.processExited }
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = configuredLaunchArguments
        process.currentDirectoryURL = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath
        )
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] _ in
            Task { await self?.processDidTerminate() }
        }
        try process.run()
        started = true
        startOutputReader()
    }

    func listSessions() async throws -> [ProductSessionSummary] {
        var result: [ProductSessionSummary]?
        for try await event in try request(.listSessions()) where event.kind == .sessions {
            result = event.sessions
        }
        guard let result else { throw AgentClientError.invalidResponse }
        return result
    }

    func createSession() async throws -> ProductSessionView {
        try await sessionView(for: .createSession())
    }

    func getSession(id: String) async throws -> ProductSessionView {
        try await sessionView(for: .getSession(sessionID: id))
    }

    func renameSession(id: String, name: String) async throws -> ProductSessionSummary {
        var result: ProductSessionSummary?
        for try await event in try request(.renameSession(sessionID: id, name: name))
        where event.kind == .sessionRenamed {
            result = event.renamedSession
        }
        guard let result else { throw AgentClientError.invalidResponse }
        return result
    }

    func prompt(
        requestID: String,
        sessionID: String,
        text: String,
        images: [ProductImageAttachment]
    ) async throws -> AsyncThrowingStream<AgentEvent, Error> {
        try request(.prompt(
            requestID: requestID,
            sessionID: sessionID,
            text: text,
            images: images
        ))
    }

    func abort(sessionID: String, targetRequestID: String) async throws {
        for try await _ in try request(.abort(
            sessionID: sessionID,
            targetRequestID: targetRequestID
        )) {}
    }

    func compact(
        sessionID: String,
        instructions: String?
    ) async throws -> ProductCompactionResult {
        var result: ProductCompactionResult?
        for try await event in try request(.compact(
            sessionID: sessionID,
            instructions: instructions
        )) where event.kind == .compactionCompleted {
            result = event.compaction
        }
        guard let result else { throw AgentClientError.invalidResponse }
        return result
    }

    func setThinking(
        sessionID: String,
        thinking: ProductThinkingLevel
    ) async throws -> ProductSessionState {
        try await state(for: .setThinking(sessionID: sessionID, thinking: thinking))
    }

    func stop() async {
        guard started else {
            finishAll(throwing: AgentClientError.processExited)
            return
        }
        try? inputPipe.fileHandleForWriting.close()
        finishAll(throwing: AgentClientError.processExited)
        if !(await waitForProcessExit()) {
            process.terminate()
        }
        if !(await waitForProcessExit()) {
            kill(process.processIdentifier, SIGKILL)
            _ = await waitForProcessExit()
        }
        await waitForOutputEnd()
    }

    private func sessionView(for command: AgentRequest) async throws -> ProductSessionView {
        var result: ProductSessionView?
        for try await event in try request(command) where event.kind == .sessionView {
            result = event.view
        }
        guard let result else { throw AgentClientError.invalidResponse }
        return result
    }

    private func state(for command: AgentRequest) async throws -> ProductSessionState {
        var result: ProductSessionState?
        for try await event in try request(command) where event.kind == .stateUpdated {
            result = event.state
        }
        guard let result else { throw AgentClientError.invalidResponse }
        return result
    }

    private func request(_ request: AgentRequest) throws -> AsyncThrowingStream<AgentEvent, Error> {
        guard started, process.isRunning, !processTerminated else {
            throw AgentClientError.processExited
        }
        guard pending[request.requestId] == nil else {
            throw AgentClientError.requestAlreadyRunning
        }
        let (stream, continuation) = AsyncThrowingStream<AgentEvent, Error>.makeStream()
        pending[request.requestId] = Pending(continuation: continuation)
        do {
            try inputPipe.fileHandleForWriting.write(contentsOf: request.encodedLine())
        } catch {
            pending.removeValue(forKey: request.requestId)
            continuation.finish(throwing: error)
            throw error
        }
        return stream
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = Data(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            guard let decoded = try? Self.decodeLine(line),
                  let request = pending[decoded.requestID]
            else { continue }
            if let event = decoded.event {
                switch event.kind {
                case .failed:
                    finish(
                        decoded.requestID,
                        throwing: AgentClientError.requestFailed(
                            event.failure ?? .init(code: .unknown, message: "Agent request failed")
                        )
                    )
                case .completed:
                    finish(decoded.requestID)
                default:
                    request.continuation.yield(event)
                }
            } else {
                finish(decoded.requestID, throwing: AgentClientError.invalidResponse)
            }
        }
    }

    private func finish(_ requestID: String, throwing error: Error? = nil) {
        guard let request = pending.removeValue(forKey: requestID) else { return }
        if let error { request.continuation.finish(throwing: error) }
        else { request.continuation.finish() }
    }

    private func finishAll(throwing error: Error) {
        let requests = Array(pending.values)
        pending.removeAll()
        requests.forEach { $0.continuation.finish(throwing: error) }
    }

    private func startOutputReader() {
        let handle = outputPipe.fileHandleForReading
        let chunks = AsyncStream<Data> { continuation in
            handle.readabilityHandler = { readableHandle in
                let data = readableHandle.availableData
                if data.isEmpty {
                    readableHandle.readabilityHandler = nil
                    continuation.finish()
                } else {
                    continuation.yield(data)
                }
            }
            continuation.onTermination = { _ in
                handle.readabilityHandler = nil
            }
        }
        outputTask = Task.detached { [weak self] in
            for await data in chunks {
                if Task.isCancelled { break }
                await self?.consume(data)
            }
            await self?.outputDidEnd()
        }
    }

    private func waitForProcessExit() async -> Bool {
        for _ in 0..<12 {
            if !process.isRunning { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return !process.isRunning
    }

    private func waitForOutputEnd() async {
        for _ in 0..<20 where !outputEnded {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func processDidTerminate() {
        processTerminated = true
        finishAfterProcessOutput()
    }

    private func outputDidEnd(throwing error: Error? = nil) {
        outputEnded = true
        if let error {
            finishAll(throwing: error)
            return
        }
        finishAfterProcessOutput()
    }

    private func finishAfterProcessOutput() {
        guard processTerminated, outputEnded else { return }
        finishAll(throwing: AgentClientError.processExited)
    }
}
