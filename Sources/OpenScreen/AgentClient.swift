import Foundation

struct AgentRequest: Encodable {
    struct Input: Encodable {
        let text: String
        let image: String
    }

    let requestId: UUID
    let input: Input

    init(requestID: UUID = UUID(), text: String, imagePath: String) {
        requestId = requestID
        input = Input(text: text, image: imagePath)
    }

    func encodedLine() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}

struct AgentEvent: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case started
        case reasoningDelta = "reasoning_delta"
        case answerDelta = "answer_delta"
        case completed
        case failed
    }

    let requestId: UUID
    let type: Kind
    let delta: String?
    let message: String?

    init(
        requestID: UUID = UUID(),
        type: Kind,
        delta: String? = nil,
        message: String? = nil
    ) {
        requestId = requestID
        self.type = type
        self.delta = delta
        self.message = message
    }
}

enum AgentClientError: LocalizedError {
    case requestAlreadyRunning
    case processExited
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .requestAlreadyRunning: "A request is already running."
        case .processExited: "The agent process exited."
        case .requestFailed(let message): message
        }
    }
}

actor AgentClient {
    private struct Pending {
        let requestID: UUID
        let continuation: AsyncThrowingStream<AgentEvent, Error>.Continuation
    }

    private let process = Process()
    private let inputPipe = Pipe()
    private let outputPipe = Pipe()
    private var outputBuffer = Data()
    private var pending: Pending?

    func start() throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "agent/dist/main.js"]
        process.currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] _ in
            Task { await self?.finish(throwing: AgentClientError.processExited) }
        }
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { await self?.consume(data) }
        }
        try process.run()
    }

    func send(text: String, imageURL: URL) throws -> AsyncThrowingStream<AgentEvent, Error> {
        guard pending == nil else {
            throw AgentClientError.requestAlreadyRunning
        }

        let requestID = UUID()
        let (stream, continuation) = AsyncThrowingStream<AgentEvent, Error>.makeStream()
        pending = Pending(requestID: requestID, continuation: continuation)
        do {
            try inputPipe.fileHandleForWriting.write(
                contentsOf: AgentRequest(
                    requestID: requestID,
                    text: text,
                    imagePath: imageURL.path
                ).encodedLine()
            )
        } catch {
            pending = nil
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
            finish(throwing: AgentClientError.processExited)
            return
        }

        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            do {
                let event = try JSONDecoder().decode(AgentEvent.self, from: line)
                guard let pending, event.requestId == pending.requestID else { continue }
                switch event.type {
                case .failed:
                    finish(throwing: AgentClientError.requestFailed(event.message ?? "Model request failed"))
                case .completed:
                    pending.continuation.yield(event)
                    finish()
                case .started, .reasoningDelta, .answerDelta:
                    pending.continuation.yield(event)
                }
            } catch {
                finish(throwing: error)
            }
        }
    }

    private func finish(throwing error: Error? = nil) {
        guard let pending else { return }
        self.pending = nil
        if let error {
            pending.continuation.finish(throwing: error)
        } else {
            pending.continuation.finish()
        }
    }
}
