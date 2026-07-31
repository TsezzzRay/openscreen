struct Coalescer {
    let intervalMilliseconds: Int64
    private var lastEmissionMilliseconds: Int64?
    private var lastActivityMilliseconds: Int64?
    private var trailingDeadlineMilliseconds: Int64?

    init(intervalMilliseconds: Int64) {
        self.intervalMilliseconds = intervalMilliseconds
    }

    mutating func record(atMilliseconds now: Int64) -> Bool {
        lastActivityMilliseconds = now
        trailingDeadlineMilliseconds = now + intervalMilliseconds
        guard
            let lastEmissionMilliseconds,
            now - lastEmissionMilliseconds < intervalMilliseconds
        else {
            self.lastEmissionMilliseconds = now
            return true
        }
        return false
    }

    mutating func flush(atMilliseconds now: Int64) -> Bool {
        guard
            let trailingDeadlineMilliseconds,
            now >= trailingDeadlineMilliseconds
        else {
            return false
        }
        self.trailingDeadlineMilliseconds = nil
        guard lastActivityMilliseconds != lastEmissionMilliseconds else {
            return false
        }
        lastEmissionMilliseconds = now
        return true
    }

    mutating func reset() {
        lastEmissionMilliseconds = nil
        lastActivityMilliseconds = nil
        trailingDeadlineMilliseconds = nil
    }
}
