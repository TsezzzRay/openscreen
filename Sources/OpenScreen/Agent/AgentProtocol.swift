import Foundation

enum ChatImageSource: String, Codable, Sendable {
    case systemCapture = "system_capture"
    case userUpload = "user_upload"
}

struct ChatImageAttachment: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let source: ChatImageSource
    let path: String

    var url: URL { URL(fileURLWithPath: path) }
}

struct AgentRequest: Encodable {
    enum Kind: String, Encodable {
        case listSessions = "list_sessions"
        case createSession = "create_session"
        case loadSession = "load_session"
        case renameSession = "rename_session"
        case recordAttempt = "record_attempt"
        case cancel
        case chat
    }

    enum AttemptStatus: String, Encodable {
        case failed
        case cancelled
    }

    struct Input: Encodable {
        let text: String
        let images: [ChatImageAttachment]
    }

    let requestId: UUID
    let type: Kind
    let sessionId: UUID?
    let input: Input?
    let title: String?
    let targetRequestId: UUID?
    let status: AttemptStatus?

    private init(
        requestId: UUID,
        type: Kind,
        sessionId: UUID? = nil,
        input: Input? = nil,
        title: String? = nil,
        targetRequestId: UUID? = nil,
        status: AttemptStatus? = nil
    ) {
        self.requestId = requestId
        self.type = type
        self.sessionId = sessionId
        self.input = input
        self.title = title
        self.targetRequestId = targetRequestId
        self.status = status
    }

    static func listSessions(requestID: UUID = UUID()) -> Self {
        Self(requestId: requestID, type: .listSessions)
    }

    static func createSession(requestID: UUID = UUID()) -> Self {
        Self(requestId: requestID, type: .createSession)
    }

    static func loadSession(requestID: UUID = UUID(), sessionID: UUID) -> Self {
        Self(
            requestId: requestID,
            type: .loadSession,
            sessionId: sessionID
        )
    }

    static func renameSession(
        requestID: UUID = UUID(),
        sessionID: UUID,
        title: String
    ) -> Self {
        Self(
            requestId: requestID,
            type: .renameSession,
            sessionId: sessionID,
            title: title
        )
    }

    static func chat(
        requestID: UUID = UUID(),
        sessionID: UUID,
        text: String,
        images: [ChatImageAttachment]
    ) -> Self {
        Self(
            requestId: requestID,
            type: .chat,
            sessionId: sessionID,
            input: Input(text: text, images: images)
        )
    }

    static func cancel(
        requestID: UUID = UUID(),
        sessionID: UUID,
        targetRequestID: UUID
    ) -> Self {
        Self(
            requestId: requestID,
            type: .cancel,
            sessionId: sessionID,
            targetRequestId: targetRequestID
        )
    }

    static func recordAttempt(
        requestID: UUID,
        sessionID: UUID,
        text: String,
        images: [ChatImageAttachment] = [],
        status: AttemptStatus
    ) -> Self {
        Self(
            requestId: requestID,
            type: .recordAttempt,
            sessionId: sessionID,
            input: Input(text: text, images: images),
            status: status
        )
    }

    func encodedLine() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}

struct ChatSessionSummary: Decodable, Identifiable, Equatable, Sendable {
    let id: UUID
    let title: String
    let createdAt: String
    let updatedAt: String
}

enum ChatTurnStatus: String, Codable, Equatable, Sendable {
    case capturing
    case requesting
    case generating
    case completed
    case failed
    case cancelled
    case interrupted
}

struct StoredChatTurn: Decodable, Equatable, Sendable {
    let id: UUID
    let user: String
    let assistant: String
    let reasoning: String?
    let status: ChatTurnStatus
    let images: [ChatImageAttachment]?
    let error: String?

    init(
        id: UUID,
        user: String,
        assistant: String,
        reasoning: String?,
        status: ChatTurnStatus,
        images: [ChatImageAttachment]? = nil,
        error: String?
    ) {
        self.id = id
        self.user = user
        self.assistant = assistant
        self.reasoning = reasoning
        self.status = status
        self.images = images
        self.error = error
    }
}

struct ChatSessionSnapshot: Decodable, Identifiable, Equatable, Sendable {
    let id: UUID
    let title: String
    let createdAt: String
    let updatedAt: String
    let turns: [StoredChatTurn]
}

struct AgentEvent: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case started
        case reasoningDelta = "reasoning_delta"
        case answerDelta = "answer_delta"
        case sessions
        case session
        case completed
        case failed
        case cancelled
    }

    let requestId: UUID
    let sessionId: UUID?
    let type: Kind
    let delta: String?
    let message: String?
    let sessions: [ChatSessionSummary]?
    let session: ChatSessionSnapshot?

    init(
        requestID: UUID = UUID(),
        sessionID: UUID? = nil,
        type: Kind,
        delta: String? = nil,
        message: String? = nil,
        sessions: [ChatSessionSummary]? = nil,
        session: ChatSessionSnapshot? = nil
    ) {
        requestId = requestID
        sessionId = sessionID
        self.type = type
        self.delta = delta
        self.message = message
        self.sessions = sessions
        self.session = session
    }
}
