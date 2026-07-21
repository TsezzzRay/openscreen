import AppKit
import SwiftUI

@MainActor
enum ChatComposerLayout {
    static let minimumHeight: CGFloat = 36
    static let maximumHeight: CGFloat = 120

    static func height(for contentHeight: CGFloat) -> CGFloat {
        min(max(contentHeight, minimumHeight), maximumHeight)
    }

    static func transcriptBottomPadding(for editorHeight: CGFloat) -> CGFloat {
        editorHeight + 104
    }

    static func contentHeight(of textView: NSTextView, width: CGFloat) -> CGFloat {
        guard width > 0, let textContainer = textView.textContainer,
              let layoutManager = textView.layoutManager else { return minimumHeight }
        textContainer.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        return ceil(layoutManager.usedRect(for: textContainer).height + textView.textContainerInset.height * 2)
    }
}

@MainActor
struct ChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let focusRequest: Int
    let isEnabled: Bool
    let onPasteImages: ([NSImage]) -> Void
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.onSubmit = onSubmit
        textView.onPasteImages = onPasteImages
        textView.isRichText = false
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: 16)
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: 0, height: 4)
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = NSSize(width: 0, height: ChatComposerLayout.minimumHeight)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = true
        scrollView.documentView = textView
        context.coordinator.scrollerVisibility = ChatScrollerVisibility(scrollView: scrollView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? SubmitTextView else { return }
        context.coordinator.parent = self
        textView.onSubmit = onSubmit
        textView.onPasteImages = onPasteImages
        textView.isEditable = isEnabled
        if textView.string != text {
            textView.string = text
            textView.setSelectedRange(NSRange(location: textView.string.utf16.count, length: 0))
        }
        DispatchQueue.main.async { context.coordinator.resize(textView) }
        if context.coordinator.focusRequest != focusRequest {
            context.coordinator.focusRequest = focusRequest
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
                context.coordinator.resize(textView)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextEditor
        var focusRequest = -1
        var scrollerVisibility: ChatScrollerVisibility?

        init(parent: ChatTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            resize(textView)
        }

        func resize(_ textView: NSTextView) {
            guard let scrollView = textView.enclosingScrollView else { return }
            let width = scrollView.contentSize.width
            guard width > 0 else { return }
            let contentHeight = ChatComposerLayout.contentHeight(of: textView, width: width)
            let editorHeight = ChatComposerLayout.height(for: contentHeight)
            textView.setFrameSize(NSSize(
                width: width,
                height: max(contentHeight, scrollView.contentSize.height)
            ))
            textView.scrollRangeToVisible(textView.selectedRange())
            if abs(parent.height - editorHeight) > 0.5 {
                parent.height = editorHeight
            }
        }
    }
}

final class SubmitTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onPasteImages: (([NSImage]) -> Void)?

    static func images(from pasteboard: NSPasteboard) -> [NSImage] {
        pasteboard.readObjects(forClasses: [NSImage.self]) as? [NSImage] ?? []
    }

    override func paste(_ sender: Any?) {
        let pastedImages = Self.images(from: .general)
        if !pastedImages.isEmpty {
            onPasteImages?(pastedImages)
            return
        }
        super.paste(sender)
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36, !event.modifierFlags.contains(.shift) {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}
