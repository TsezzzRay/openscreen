import AppKit
import Carbon.HIToolbox
import Combine
import SwiftUI

final class OpenScreenPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
func makePanel(contentView: NSView) -> NSPanel {
    let availableHeight = (NSScreen.main?.visibleFrame.height ?? 720) - 40
    let height = min(720, max(320, availableHeight))
    let panel = OpenScreenPanel(
        contentRect: NSRect(x: 0, y: 0, width: 420, height: height),
        styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.animationBehavior = .utilityWindow
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

    contentView.frame = panel.contentView?.bounds ?? .zero
    contentView.autoresizingMask = [.width, .height]
    panel.contentView = contentView
    return panel
}

@MainActor
final class PanelController {
    private let panel: NSPanel
    private let hostingView: NSHostingView<ChatView>
    private let viewModel: ChatViewModel
    private var redrawObservation: AnyCancellable?
    private var hotKey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        let hostingView = NSHostingView(rootView: ChatView(viewModel: viewModel))
        self.hostingView = hostingView
        panel = makePanel(contentView: hostingView)
        redrawObservation = Publishers.CombineLatest(viewModel.$question, viewModel.$answer)
            .dropFirst()
            .sink { [weak hostingView] _ in
                DispatchQueue.main.async {
                    hostingView?.needsDisplay = true
                    hostingView?.displayIfNeededIgnoringOpacity()
                }
            }
        panel.setFrameAutosaveName("OpenScreenPanelFrame")
        if !panel.setFrameUsingName("OpenScreenPanelFrame") {
            positionAtRightEdge()
        }
        registerHotKey()
    }

    func togglePanel() {
        if panel.isVisible {
            panel.orderOut(nil)
            return
        }

        if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(panel.frame) }) {
            positionAtRightEdge()
        }
        panel.makeKeyAndOrderFront(nil)
        viewModel.requestInputFocus()
    }

    private func positionAtRightEdge() {
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(pointer) }) ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        panel.setFrameOrigin(
            NSPoint(
                x: frame.maxX - panel.frame.width - 20,
                y: frame.midY - panel.frame.height / 2
            )
        )
    }

    private func registerHotKey() {
        var event = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: OSType(kEventHotKeyPressed)
        )
        let callback: EventHandlerUPP = { _, _, userData in
            guard let userData else { return noErr }
            let controller = Unmanaged<PanelController>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { controller.togglePanel() }
            return noErr
        }
        InstallEventHandler(
            GetApplicationEventTarget(),
            callback,
            1,
            &event,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandler
        )

        let identifier = EventHotKeyID(signature: 0x4F505343, id: 1)
        RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            identifier,
            GetApplicationEventTarget(),
            0,
            &hotKey
        )
    }
}
