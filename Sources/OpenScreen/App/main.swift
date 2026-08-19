import AppKit
import Dispatch

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.accessory)
application.delegate = delegate

// Ctrl+C or `kill` (e.g. restarting `npm run dev`) delivers SIGINT/SIGTERM
// directly to this process, bypassing AppKit's applicationShouldTerminate
// entirely. Without this, AgentClient.stop()'s graceful shutdown of the node
// child never runs and it is orphaned. Routing through NSApp.terminate(_:)
// here deadlocks: calling it from outside AppKit's own event dispatch enters
// a nested run loop that never pumps the MainActor task doing the real
// cleanup. Run the same cleanup directly instead, then exit.
func handleShutdownSignal() {
    Task { @MainActor in
        await delegate.shutdownForSignal()
        exit(0)
    }
}
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler(handler: handleShutdownSignal)
sigintSource.resume()
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler(handler: handleShutdownSignal)
sigtermSource.resume()

application.run()
