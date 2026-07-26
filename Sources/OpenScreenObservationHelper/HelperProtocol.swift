import Foundation

struct HelperCommand: Decodable, Sendable {
    enum CommandType: String, Decodable, Sendable {
        case configure
        case capture
        case shutdown
    }

    let protocolVersion: Int
    let requestId: String
    let type: CommandType
    let excludedProcessIdentifiers: [pid_t]?
    let excludedBundleIdentifiers: [String]?
    let signal: NativeActivitySignal?

    static func decode(_ line: String) throws -> HelperCommand {
        try JSONDecoder().decode(HelperCommand.self, from: Data(line.utf8))
    }
}

struct HelperOutput: Encodable, Sendable {
    let protocolVersion: Int
    let type: String
    let processIdentifier: pid_t?
    let requestId: String?
    let signal: NativeActivitySignal?
    let result: NativeCaptureResult?
    let component: String?
    let status: String?
    let code: String?
    let message: String?

    static func ready(processIdentifier: pid_t) -> HelperOutput {
        HelperOutput(
            protocolVersion: 1,
            type: "ready",
            processIdentifier: processIdentifier,
            requestId: nil,
            signal: nil,
            result: nil,
            component: nil,
            status: nil,
            code: nil,
            message: nil
        )
    }

    static func configured(requestId: String) -> HelperOutput {
        HelperOutput(
            protocolVersion: 1,
            type: "configured",
            processIdentifier: nil,
            requestId: requestId,
            signal: nil,
            result: nil,
            component: nil,
            status: nil,
            code: nil,
            message: nil
        )
    }

    static func activity(_ signal: NativeActivitySignal) -> HelperOutput {
        HelperOutput(
            protocolVersion: 1,
            type: "signal",
            processIdentifier: nil,
            requestId: nil,
            signal: signal,
            result: nil,
            component: nil,
            status: nil,
            code: nil,
            message: nil
        )
    }

    static func captureResult(
        requestId: String,
        result: NativeCaptureResult
    ) -> HelperOutput {
        HelperOutput(
            protocolVersion: 1,
            type: "captureResult",
            processIdentifier: nil,
            requestId: requestId,
            signal: nil,
            result: result,
            component: nil,
            status: nil,
            code: nil,
            message: nil
        )
    }

    static func status(
        component: String,
        status: String,
        message: String? = nil
    ) -> HelperOutput {
        HelperOutput(
            protocolVersion: 1,
            type: "status",
            processIdentifier: nil,
            requestId: nil,
            signal: nil,
            result: nil,
            component: component,
            status: status,
            code: nil,
            message: message
        )
    }

    static func error(
        requestId: String? = nil,
        code: String,
        message: String
    ) -> HelperOutput {
        HelperOutput(
            protocolVersion: 1,
            type: "error",
            processIdentifier: nil,
            requestId: requestId,
            signal: nil,
            result: nil,
            component: nil,
            status: nil,
            code: code,
            message: message
        )
    }

    func encodedLine() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}

final class JSONLineWriter: @unchecked Sendable {
    private let lock = NSLock()

    func write(_ output: HelperOutput) {
        do {
            let data = try output.encodedLine()
            lock.lock()
            defer {
                lock.unlock()
            }
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            FileHandle.standardError.write(
                Data("OpenScreen helper output failed: \(error)\n".utf8)
            )
        }
    }
}
