import Foundation

struct AgentRequest: Encodable {
    struct Input: Encodable {
        let text: String
        let image: String
    }

    let input: Input

    init(text: String, imagePath: String) {
        input = Input(text: text, image: imagePath)
    }

    func encodedLine() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}

private struct AgentResponse: Decodable {
    let output: String
}

enum AgentClientError: Error {
    case requestAlreadyRunning
    case processExited
}

actor AgentClient {
    private let process = Process()
    private let inputPipe = Pipe()
    private let outputPipe = Pipe()
    private var outputBuffer = Data()
    private var pending: CheckedContinuation<String, Error>?

    func start() throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "agent/dist/main.js"]
        process.currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.standardError
        process.terminationHandler = { [weak self] _ in
            Task { await self?.finish(with: .failure(AgentClientError.processExited)) }
        }
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { await self?.consume(data) }
        }
        try process.run()
    }

    func send(text: String, imageURL: URL) async throws -> String {
        guard pending == nil else {
            throw AgentClientError.requestAlreadyRunning
        }

        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            do {
                try inputPipe.fileHandleForWriting.write(
                    contentsOf: AgentRequest(text: text, imagePath: imageURL.path).encodedLine()
                )
            } catch {
                pending = nil
                continuation.resume(throwing: error)
            }
        }
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
            finish(with: .failure(AgentClientError.processExited))
            return
        }

        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            do {
                let response = try JSONDecoder().decode(AgentResponse.self, from: line)
                finish(with: .success(response.output))
            } catch {
                finish(with: .failure(error))
            }
        }
    }

    private func finish(with result: Result<String, Error>) {
        guard let pending else { return }
        self.pending = nil
        pending.resume(with: result)
    }
}
