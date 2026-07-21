import Foundation

struct ChatTurn: Identifiable {
    let id: UUID
    let question: String
    let attachments: [ChatImageAttachment]
    var reasoning: String
    var answer: String
    var status: ChatTurnStatus
    var error: String?

    init(
        id: UUID = UUID(),
        question: String,
        attachments: [ChatImageAttachment] = [],
        reasoning: String,
        answer: String,
        status: ChatTurnStatus = .completed,
        error: String? = nil
    ) {
        self.id = id
        self.question = question
        self.attachments = attachments
        self.reasoning = reasoning
        self.answer = answer
        self.status = status
        self.error = error
    }
}
