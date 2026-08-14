import Foundation

enum ProductImageMimeType: String, Codable, Equatable, Sendable {
    case png = "image/png"
    case jpeg = "image/jpeg"
}

struct ProductImageAttachment: Codable, Equatable, Sendable {
    let path: String
    let mimeType: ProductImageMimeType
}

enum ProductThinkingLevel: String, Codable, CaseIterable, Identifiable, Sendable {
    case off
    case minimal
    case low
    case medium
    case high
    case xhigh
    case max

    var id: String { rawValue }
}

struct ProductSessionState: Codable, Equatable, Sendable {
    let thinking: ProductThinkingLevel
}

struct ProductSessionSummary: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let createdAt: String
    let name: String?

    var displayName: String { name ?? "New Chat" }
}

enum ProductTranscriptRole: String, Codable, Equatable, Sendable {
    case user
    case assistant
    case tool
    case context
}

struct ProductTranscriptMessage: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let role: ProductTranscriptRole
    let timestamp: String
    let text: String
    let reasoning: String?
    let toolName: String?
    let isError: Bool?
    let imageCount: Int?

    init(
        id: String,
        role: ProductTranscriptRole,
        timestamp: String,
        text: String,
        reasoning: String? = nil,
        toolName: String? = nil,
        isError: Bool? = nil,
        imageCount: Int? = nil
    ) {
        self.id = id
        self.role = role
        self.timestamp = timestamp
        self.text = text
        self.reasoning = reasoning
        self.toolName = toolName
        self.isError = isError
        self.imageCount = imageCount
    }
}

struct ProductSessionView: Codable, Equatable, Sendable {
    let session: ProductSessionSummary
    let messages: [ProductTranscriptMessage]
    let state: ProductSessionState
}

struct ProductCompactionResult: Codable, Equatable, Sendable {
    let summary: String
    let firstKeptEntryId: String
    let tokensBefore: Int
}

struct ProductContextUsage: Codable, Equatable, Sendable {
    let contextTokens: Int
    let contextWindow: Int
}

enum ProductErrorCode: String, Codable, Equatable, Sendable {
    case aborted
    case busy
    case duplicateRequest = "duplicate-request"
    case invalidArgument = "invalid-argument"
    case notFound = "not-found"
    case provider
    case session
    case unknown
}

struct ProductFailure: Codable, Equatable, Sendable {
    let code: ProductErrorCode
    let message: String
}

enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

struct ProductToolEvent: Equatable, Sendable {
    let callId: String
    let name: String
    let input: [String: JSONValue]?
    let text: String?
    let isError: Bool?
}

struct AgentRequest: Encodable, Sendable {
    enum Kind: String, Encodable, Sendable {
        case listSessions = "list_sessions"
        case createSession = "create_session"
        case getSession = "get_session"
        case renameSession = "rename_session"
        case prompt
        case abort
        case compact
        case setThinking = "set_thinking"
    }

    struct Input: Encodable, Sendable {
        let text: String
        let images: [ProductImageAttachment]?
    }

    let requestId: String
    let type: Kind
    let sessionId: String?
    let name: String?
    let input: Input?
    let targetRequestId: String?
    let instructions: String?
    let thinking: ProductThinkingLevel?

    private init(
        requestId: String,
        type: Kind,
        sessionId: String? = nil,
        name: String? = nil,
        input: Input? = nil,
        targetRequestId: String? = nil,
        instructions: String? = nil,
        thinking: ProductThinkingLevel? = nil
    ) {
        self.requestId = requestId
        self.type = type
        self.sessionId = sessionId
        self.name = name
        self.input = input
        self.targetRequestId = targetRequestId
        self.instructions = instructions
        self.thinking = thinking
    }

    static func listSessions(requestID: String = UUID().uuidString) -> Self {
        .init(requestId: requestID, type: .listSessions)
    }

    static func createSession(requestID: String = UUID().uuidString) -> Self {
        .init(requestId: requestID, type: .createSession)
    }

    static func getSession(requestID: String = UUID().uuidString, sessionID: String) -> Self {
        .init(requestId: requestID, type: .getSession, sessionId: sessionID)
    }

    static func renameSession(
        requestID: String = UUID().uuidString,
        sessionID: String,
        name: String
    ) -> Self {
        .init(requestId: requestID, type: .renameSession, sessionId: sessionID, name: name)
    }

    static func prompt(
        requestID: String = UUID().uuidString,
        sessionID: String,
        text: String,
        images: [ProductImageAttachment]
    ) -> Self {
        .init(
            requestId: requestID,
            type: .prompt,
            sessionId: sessionID,
            input: .init(
                text: text,
                images: images.isEmpty ? nil : images
            )
        )
    }

    static func abort(
        requestID: String = UUID().uuidString,
        sessionID: String,
        targetRequestID: String
    ) -> Self {
        .init(
            requestId: requestID,
            type: .abort,
            sessionId: sessionID,
            targetRequestId: targetRequestID
        )
    }

    static func compact(
        requestID: String = UUID().uuidString,
        sessionID: String,
        instructions: String?
    ) -> Self {
        .init(
            requestId: requestID,
            type: .compact,
            sessionId: sessionID,
            instructions: instructions
        )
    }

    static func setThinking(
        requestID: String = UUID().uuidString,
        sessionID: String,
        thinking: ProductThinkingLevel
    ) -> Self {
        .init(requestId: requestID, type: .setThinking, sessionId: sessionID, thinking: thinking)
    }

    func encodedLine() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}

struct AgentEvent: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case sessions
        case sessionView = "session_view"
        case sessionRenamed = "session_renamed"
        case runStarted = "run_started"
        case answerDelta = "answer_delta"
        case reasoningDelta = "reasoning_delta"
        case toolStarted = "tool_started"
        case toolUpdated = "tool_updated"
        case toolFinished = "tool_finished"
        case answerCompleted = "answer_completed"
        case compactionCompleted = "compaction_completed"
        case stateUpdated = "state_updated"
        case abortCompleted = "abort_completed"
        case completed
        case failed
    }

    let requestId: String
    let kind: Kind
    let sessionId: String?
    let delta: String?
    let sessions: [ProductSessionSummary]?
    let view: ProductSessionView?
    let renamedSession: ProductSessionSummary?
    let tool: ProductToolEvent?
    let answer: String?
    let contextUsage: ProductContextUsage?
    let automatic: Bool?
    let compaction: ProductCompactionResult?
    let state: ProductSessionState?
    let targetRequestId: String?
    let failure: ProductFailure?

    var type: Kind { kind }

    private enum CodingKeys: String, CodingKey {
        case requestId, type, sessionId, delta, sessions, view, session
        case callId, name, input, text, isError, answer, contextUsage, automatic
        case result
        case state, targetRequestId, error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try container.decode(String.self, forKey: .requestId)
        kind = try container.decode(Kind.self, forKey: .type)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        delta = try container.decodeIfPresent(String.self, forKey: .delta)
        sessions = try container.decodeIfPresent([ProductSessionSummary].self, forKey: .sessions)
        view = try container.decodeIfPresent(ProductSessionView.self, forKey: .view)
        renamedSession = try container.decodeIfPresent(ProductSessionSummary.self, forKey: .session)
        if let callId = try container.decodeIfPresent(String.self, forKey: .callId),
           let name = try container.decodeIfPresent(String.self, forKey: .name) {
            tool = ProductToolEvent(
                callId: callId,
                name: name,
                input: try container.decodeIfPresent([String: JSONValue].self, forKey: .input),
                text: try container.decodeIfPresent(String.self, forKey: .text),
                isError: try container.decodeIfPresent(Bool.self, forKey: .isError)
            )
        } else {
            tool = nil
        }
        answer = try container.decodeIfPresent(String.self, forKey: .answer)
        contextUsage = try container.decodeIfPresent(ProductContextUsage.self, forKey: .contextUsage)
        automatic = try container.decodeIfPresent(Bool.self, forKey: .automatic)
        compaction = try container.decodeIfPresent(ProductCompactionResult.self, forKey: .result)
        state = try container.decodeIfPresent(ProductSessionState.self, forKey: .state)
        targetRequestId = try container.decodeIfPresent(String.self, forKey: .targetRequestId)
        failure = try container.decodeIfPresent(ProductFailure.self, forKey: .error)
    }

    init(
        requestId: String,
        type: Kind,
        sessionId: String? = nil,
        delta: String? = nil,
        sessions: [ProductSessionSummary]? = nil,
        view: ProductSessionView? = nil,
        renamedSession: ProductSessionSummary? = nil,
        tool: ProductToolEvent? = nil,
        answer: String? = nil,
        contextUsage: ProductContextUsage? = nil,
        automatic: Bool? = nil,
        compaction: ProductCompactionResult? = nil,
        state: ProductSessionState? = nil,
        targetRequestId: String? = nil,
        failure: ProductFailure? = nil
    ) {
        self.requestId = requestId
        kind = type
        self.sessionId = sessionId
        self.delta = delta
        self.sessions = sessions
        self.view = view
        self.renamedSession = renamedSession
        self.tool = tool
        self.answer = answer
        self.contextUsage = contextUsage
        self.automatic = automatic
        self.compaction = compaction
        self.state = state
        self.targetRequestId = targetRequestId
        self.failure = failure
    }

    static func toolEvent(
        requestID: String,
        kind: Kind,
        sessionID: String,
        callID: String,
        name: String,
        text: String? = nil,
        isError: Bool? = nil
    ) -> Self {
        .init(
            requestId: requestID,
            type: kind,
            sessionId: sessionID,
            tool: .init(callId: callID, name: name, input: nil, text: text, isError: isError)
        )
    }
}
