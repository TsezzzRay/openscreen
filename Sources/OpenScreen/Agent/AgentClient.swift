import Foundation

enum AgentClientError: LocalizedError {
    case requestAlreadyRunning
    case processExited
    case requestFailed(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .requestAlreadyRunning: "A request is already running."
        case .processExited: "The agent stopped. Restart OpenScreen and try again."
        case .requestFailed: "Request failed. Please retry."
        case .invalidResponse: "Request failed. Please retry."
        }
    }
}

actor AgentClient {
    private struct Pending {
        let continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    }

    private let process = Process()
    private let inputPipe = Pipe()
    private let outputPipe = Pipe()
    private var outputBuffer = Data()
    private var pending: [UUID: Pending] = [:]

    func start() throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "agent/dist/main.js"]
        process.currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] _ in
            Task { await self?.finishAll(throwing: AgentClientError.processExited) }
        }
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { await self?.consume(data) }
        }
        try process.run()
    }

    func listSessions() async throws -> [ChatSessionSummary] {
        var sessions: [ChatSessionSummary]?
        for try await event in try request(.listSessions()) {
            if event.type == .sessions { sessions = event.sessions }
        }
        guard let sessions else { throw AgentClientError.invalidResponse }
        return sessions
    }

    func createSession() async throws -> ChatSessionSnapshot {
        try await sessionResponse(for: .createSession())
    }

    func loadSession(id: UUID) async throws -> ChatSessionSnapshot {
        try await sessionResponse(for: .loadSession(sessionID: id))
    }

    func renameSession(id: UUID, title: String) async throws -> ChatSessionSnapshot {
        try await sessionResponse(for: .renameSession(sessionID: id, title: title))
    }

    func send(
        requestID: UUID = UUID(),
        sessionID: UUID,
        text: String,
        images: [ChatImageAttachment]
    ) throws -> AsyncThrowingStream<AgentEvent, Error> {
        try request(.chat(
            requestID: requestID,
            sessionID: sessionID,
            text: text,
            images: images
        ))
    }

    func cancel(requestID: UUID, sessionID: UUID) async throws {
        for try await _ in try request(.cancel(
            sessionID: sessionID,
            targetRequestID: requestID
        )) {}
    }

    func recordAttempt(
        requestID: UUID,
        sessionID: UUID,
        text: String,
        images: [ChatImageAttachment] = [],
        status: AgentRequest.AttemptStatus
    ) async throws {
        for try await _ in try request(.recordAttempt(
            requestID: requestID,
            sessionID: sessionID,
            text: text,
            images: images,
            status: status
        )) {}
    }

    private func sessionResponse(for request: AgentRequest) async throws -> ChatSessionSnapshot {
        var session: ChatSessionSnapshot?
        for try await event in try self.request(request) {
            if event.type == .session { session = event.session }
        }
        guard let session else { throw AgentClientError.invalidResponse }
        return session
    }

    private func request(_ request: AgentRequest) throws -> AsyncThrowingStream<AgentEvent, Error> {
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

    func stop() {
        outputPipe.fileHandleForReading.readabilityHandler = nil
        try? inputPipe.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
        }
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else {
            finishAll(throwing: AgentClientError.processExited)
            return
        }

        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            do {
                let event = try JSONDecoder().decode(AgentEvent.self, from: line)
                guard let request = pending[event.requestId] else { continue }
                switch event.type {
                case .failed:
                    finish(
                        event.requestId,
                        throwing: AgentClientError.requestFailed(
                            event.message ?? "Model request failed"
                        )
                    )
                case .completed, .cancelled:
                    request.continuation.yield(event)
                    finish(event.requestId)
                case .started, .reasoningDelta, .answerDelta, .sessions, .session:
                    request.continuation.yield(event)
                }
            } catch {
                finishAll(throwing: error)
            }
        }
    }

    private func finish(_ requestID: UUID, throwing error: Error? = nil) {
        guard let request = pending.removeValue(forKey: requestID) else { return }
        if let error {
            request.continuation.finish(throwing: error)
        } else {
            request.continuation.finish()
        }
    }

    private func finishAll(throwing error: Error) {
        let requests = Array(pending.values)
        pending.removeAll()
        for request in requests {
            request.continuation.finish(throwing: error)
        }
    }
}
