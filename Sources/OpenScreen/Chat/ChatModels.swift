import Foundation

struct ChatTurn: Identifiable {
    let id: UUID
    let question: String
    var reasoning: String
    var answer: String
    var status: ChatTurnStatus
    var error: String?

    init(
        id: UUID = UUID(),
        question: String,
        reasoning: String,
        answer: String,
        status: ChatTurnStatus = .completed,
        error: String? = nil
    ) {
        self.id = id
        self.question = question
        self.reasoning = reasoning
        self.answer = answer
        self.status = status
        self.error = error
    }
}
