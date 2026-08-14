import AppKit
import CoreGraphics

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let agentClient = AgentClient()
    private var panelController: PanelController?
    private var terminationPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
        }

        Task {
            do {
                try await agentClient.start()
                let viewModel = ChatViewModel(
                    agentClient: agentClient
                )
                panelController = PanelController(viewModel: viewModel)
                await viewModel.restoreSessions()
            } catch {
                FileHandle.standardError.write(Data("OpenScreen: \(error)\n".utf8))
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        Task {
            await agentClient.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
