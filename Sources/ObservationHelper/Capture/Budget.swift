import Foundation

struct Budget {
    let maxDepth: Int
    let maxNodes: Int
    let deadline: Date

    private(set) var nodeCount = 0
    private(set) var truncated = false
    private(set) var timedOut = false

    mutating func consume(depth: Int) -> Bool {
        guard Date() < deadline else {
            truncated = true
            timedOut = true
            return false
        }
        guard depth <= maxDepth, nodeCount < maxNodes else {
            truncated = true
            return false
        }
        nodeCount += 1
        return true
    }
}
