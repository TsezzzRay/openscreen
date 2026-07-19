import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let agentClient = AgentClient()
    private var panelController: PanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        WindowCapture.requestPermission()

        Task {
            do {
                try await agentClient.start()
                let viewModel = ChatViewModel(
                    agentClient: agentClient,
                    windowCapture: WindowCapture()
                )
                panelController = PanelController(viewModel: viewModel)
                await viewModel.restoreSessions()
            } catch {
                FileHandle.standardError.write(Data("OpenScreen: \(error)\n".utf8))
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        Task { await agentClient.stop() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
