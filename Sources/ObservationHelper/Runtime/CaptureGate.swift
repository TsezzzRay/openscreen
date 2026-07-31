struct CaptureGate {
    private var activeRequestIdentifier: String?

    mutating func begin(requestIdentifier: String) -> Bool {
        guard activeRequestIdentifier == nil else {
            return false
        }
        activeRequestIdentifier = requestIdentifier
        return true
    }

    mutating func end(requestIdentifier: String) {
        guard activeRequestIdentifier == requestIdentifier else {
            return
        }
        activeRequestIdentifier = nil
    }
}
