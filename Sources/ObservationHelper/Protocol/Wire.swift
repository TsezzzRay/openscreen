import Foundation

enum Wire {
    struct Configure: Sendable {
        let requestId: String
        let excludedProcessIdentifiers: [pid_t]
        let excludedBundleIdentifiers: [String]
        let configuration: NativeObservationConfiguration
    }

    struct Capture: Sendable {
        let requestId: String
        let target: WindowMetadata
    }

    struct Shutdown: Sendable {
        let requestId: String
    }

    enum Command: Decodable, Sendable {
        case configure(Configure)
        case capture(Capture)
        case shutdown(Shutdown)

        private enum CommandType: String, Decodable {
            case configure
            case capture
            case shutdown
        }

        private enum CodingKeys: String, CodingKey {
            case requestId
            case type
            case excludedProcessIdentifiers
            case excludedBundleIdentifiers
            case configuration
            case target
        }

        var requestId: String {
            switch self {
            case .configure(let request):
                request.requestId
            case .capture(let request):
                request.requestId
            case .shutdown(let request):
                request.requestId
            }
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let requestId = try container.decode(String.self, forKey: .requestId)
            let type = try container.decode(CommandType.self, forKey: .type)
            switch type {
            case .configure:
                self = .configure(
                    Configure(
                        requestId: requestId,
                        excludedProcessIdentifiers: try container.decode(
                            [pid_t].self,
                            forKey: .excludedProcessIdentifiers
                        ),
                        excludedBundleIdentifiers: try container.decode(
                            [String].self,
                            forKey: .excludedBundleIdentifiers
                        ),
                        configuration: try container.decode(
                            NativeObservationConfiguration.self,
                            forKey: .configuration
                        )
                    )
                )
            case .capture:
                self = .capture(
                    Capture(
                        requestId: requestId,
                        target: try container.decode(
                            WindowMetadata.self,
                            forKey: .target
                        )
                    )
                )
            case .shutdown:
                self = .shutdown(
                    Shutdown(
                        requestId: requestId
                    )
                )
            }
        }

        static func decode(_ line: String) throws -> Command {
            try JSONDecoder().decode(Command.self, from: Data(line.utf8))
        }
    }

    enum Output: Encodable, Sendable {
        case ready(processIdentifier: pid_t)
        case configured(requestId: String)
        case signal(NativeActivitySignal)
        case captureResult(requestId: String, result: NativeCaptureResult)
        case status(SourceStatus)
        case diagnostic(NativeDiagnosticEvent)
        case error(requestId: String?, code: String, message: String)

        private enum CodingKeys: String, CodingKey {
            case type
            case processIdentifier
            case requestId
            case signal
            case result
            case component
            case status
            case code
            case message
            case event
            case reason
            case generation
            case windowIdentifier
            case delayMilliseconds
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .ready(let processIdentifier):
                try container.encode("ready", forKey: .type)
                try container.encode(
                    processIdentifier,
                    forKey: .processIdentifier
                )
            case .configured(let requestId):
                try container.encode("configured", forKey: .type)
                try container.encode(requestId, forKey: .requestId)
            case .signal(let signal):
                try container.encode("signal", forKey: .type)
                try container.encode(signal, forKey: .signal)
            case .captureResult(let requestId, let result):
                try container.encode("captureResult", forKey: .type)
                try container.encode(requestId, forKey: .requestId)
                try container.encode(result, forKey: .result)
            case .status(let status):
                try container.encode("status", forKey: .type)
                try container.encode(status.component.rawValue, forKey: .component)
                try container.encode(status.state.rawValue, forKey: .status)
                try container.encodeIfPresent(status.message, forKey: .message)
            case .diagnostic(let diagnostic):
                try container.encode("diagnostic", forKey: .type)
                try container.encode(diagnostic.event.rawValue, forKey: .event)
                try container.encodeIfPresent(diagnostic.reason, forKey: .reason)
                try container.encodeIfPresent(
                    diagnostic.generation,
                    forKey: .generation
                )
                try container.encodeIfPresent(
                    diagnostic.windowIdentifier,
                    forKey: .windowIdentifier
                )
                try container.encodeIfPresent(
                    diagnostic.delayMilliseconds,
                    forKey: .delayMilliseconds
                )
            case .error(let requestId, let code, let message):
                try container.encode("error", forKey: .type)
                try container.encodeIfPresent(requestId, forKey: .requestId)
                try container.encode(code, forKey: .code)
                try container.encode(message, forKey: .message)
            }
        }

        func encodedLine() throws -> Data {
            var data = try JSONEncoder().encode(self)
            data.append(0x0A)
            return data
        }
    }
}
