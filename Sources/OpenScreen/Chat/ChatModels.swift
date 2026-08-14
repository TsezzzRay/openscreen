import Foundation

enum ChatTurnStatus: String, Equatable, Sendable {
    case capturing
    case requesting
    case generating
    case completed
    case failed
    case aborted
    case interrupted
}

struct ProductToolActivity: Equatable, Identifiable, Sendable {
    enum Status: Equatable, Sendable {
        case running
        case finished
    }

    let callID: String
    let name: String
    var text: String
    var status: Status
    var isError: Bool

    var id: String { callID }
}

struct ChatTurn: Identifiable {
    let id: String
    let question: String
    let attachments: [ChatImageAttachment]
    let historicalImageCount: Int
    var reasoning: String
    var answer: String
    var toolActivities: [ProductToolActivity]
    var contextUsage: ProductContextUsage?
    var status: ChatTurnStatus
    var error: String?

    init(
        id: String = UUID().uuidString,
        question: String,
        attachments: [ChatImageAttachment] = [],
        historicalImageCount: Int = 0,
        reasoning: String,
        answer: String,
        toolActivities: [ProductToolActivity] = [],
        contextUsage: ProductContextUsage? = nil,
        status: ChatTurnStatus = .completed,
        error: String? = nil
    ) {
        self.id = id
        self.question = question
        self.attachments = attachments
        self.historicalImageCount = historicalImageCount
        self.reasoning = reasoning
        self.answer = answer
        self.toolActivities = toolActivities
        self.contextUsage = contextUsage
        self.status = status
        self.error = error
    }
}
