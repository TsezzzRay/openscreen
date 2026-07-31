import Foundation

let writer = LineWriter()
Task { @MainActor in
    let runtime = Runtime(writer: writer)
    runtime.start()
}
RunLoop.main.run()
