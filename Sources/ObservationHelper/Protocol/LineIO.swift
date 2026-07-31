import Foundation

final class LineReader: @unchecked Sendable {
    private let handle: FileHandle
    private let onLine: @Sendable (String) -> Void
    private let onEnd: @Sendable () -> Void
    private let lock = NSLock()
    private var buffer = Data()
    private var ended = false

    init(
        handle: FileHandle,
        onLine: @escaping @Sendable (String) -> Void,
        onEnd: @escaping @Sendable () -> Void
    ) {
        self.handle = handle
        self.onLine = onLine
        self.onEnd = onEnd
    }

    func start() {
        Thread.detachNewThread { [self] in
            while true {
                let data = handle.availableData
                consume(data)
                if data.isEmpty {
                    break
                }
            }
        }
    }

    func stop() {
        lock.lock()
        ended = true
        lock.unlock()
    }

    private func consume(_ data: Data) {
        lock.lock()
        if data.isEmpty {
            let shouldEnd = !ended
            ended = true
            lock.unlock()
            if shouldEnd {
                onEnd()
            }
            return
        }
        buffer.append(data)
        var lines = [String]()
        while let newline = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[..<newline]
            buffer.removeSubrange(...newline)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                lines.append(line)
            }
        }
        lock.unlock()
        for line in lines {
            onLine(line)
        }
    }
}

final class LineWriter: @unchecked Sendable {
    private let lock = NSLock()

    func write(_ output: Wire.Output) {
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
