import AppKit
import Foundation

final class FlippedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Finish AppKit's activating launch path before allowing a UI window.
        DispatchQueue.main.async {
            NSApplication.shared.setActivationPolicy(.accessory)
            let window = NSWindow(
                contentRect: NSRect(x: 120, y: 180, width: 640, height: 400),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            self.window = window
            window.title = "OpenScreen isolated input test"
            let field = NSTextField(frame: NSRect(x: 40, y: 260, width: 420, height: 36))
            field.placeholderString = "Isolated test input"
            field.setAccessibilityLabel("Isolated test input")
            window.contentView?.addSubview(field)
            let password = NSSecureTextField(frame: NSRect(x: 40, y: 205, width: 420, height: 36))
            password.placeholderString = "Protected test input"
            password.setAccessibilityLabel("Protected test input")
            window.contentView?.addSubview(password)
            let scrollView = NSScrollView(frame: NSRect(x: 40, y: 20, width: 420, height: 155))
            scrollView.setAccessibilityLabel("Isolated scroll area")
            scrollView.hasVerticalScroller = true
            let document = FlippedDocumentView(frame: NSRect(x: 0, y: 0, width: 400, height: 900))
            for index in 0..<15 {
                let label = NSTextField(labelWithString: "Isolated row \(index)")
                label.frame = NSRect(x: 12, y: CGFloat(index * 55), width: 250, height: 20)
                document.addSubview(label)
            }
            scrollView.documentView = document
            scrollView.contentView.scroll(to: .zero)
            scrollView.reflectScrolledClipView(scrollView.contentView)
            window.contentView?.addSubview(scrollView)
            FileHandle.standardInput.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                guard String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "scroll-state" else { return }
                DispatchQueue.main.async {
                    let value = scrollView.verticalScroller?.doubleValue ?? -1
                    FileHandle.standardOutput.write(Data("{\"scrollValue\":\(value)}\n".utf8))
                }
            }
            window.orderBack(nil)
            DispatchQueue.main.async {
                let localRect = scrollView.convert(scrollView.bounds, to: nil)
                let top = window.frame.height - localRect.maxY
                FileHandle.standardOutput.write(Data("{\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"windowId\":\"\(window.windowNumber)\",\"visible\":\(window.isVisible),\"windowWidth\":\(window.frame.width),\"windowHeight\":\(window.frame.height),\"scrollRect\":{\"x\":\(localRect.minX),\"y\":\(top),\"width\":\(localRect.width),\"height\":\(localRect.height)}}\n".utf8))
            }
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let delegate = FixtureDelegate()
app.delegate = delegate
app.run()
