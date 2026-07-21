import AppKit
import Combine
import Foundation
import SwiftUI

enum MarkdownCodeActions {
    static func copy(_ text: String, to pasteboard: NSPasteboard = .general) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}

struct MarkdownBlock: Sendable {
    enum Kind: Equatable, Sendable {
        case paragraph
        case heading(level: Int)
        case listItem(marker: String, depth: Int)
        case codeBlock(language: String?)
    }

    let kind: Kind
    var content: AttributedString
}

struct MarkdownDocument: Sendable {
    let blocks: [MarkdownBlock]

    init(_ source: String) {
        guard !source.isEmpty else {
            blocks = []
            return
        }

        guard var attributed = try? AttributedString(markdown: source) else {
            blocks = [.init(kind: .paragraph, content: AttributedString(source))]
            return
        }

        let unsafeLinkRanges: [Range<AttributedString.Index>] = attributed.runs.compactMap { run in
            guard let link = run.link,
                  !["http", "https"].contains(link.scheme?.lowercased()) else { return nil }
            return run.range
        }
        for range in unsafeLinkRanges {
            attributed[range].link = nil
        }

        blocks = Self.makeBlocks(from: attributed)
    }

    private struct Descriptor {
        let identity: Int
        let kind: MarkdownBlock.Kind
        let paragraphIdentity: Int?
    }

    private struct Builder {
        let identity: Int
        let kind: MarkdownBlock.Kind
        var content = AttributedString()
        var paragraphIdentity: Int?
    }

    private static func makeBlocks(from attributed: AttributedString) -> [MarkdownBlock] {
        var builders: [Builder] = []

        for run in attributed.runs {
            let descriptor = descriptor(for: run.presentationIntent)
            if builders.last?.identity != descriptor.identity ||
                builders.last?.kind != descriptor.kind {
                builders.append(Builder(
                    identity: descriptor.identity,
                    kind: descriptor.kind,
                    paragraphIdentity: descriptor.paragraphIdentity
                ))
            } else if let previousParagraph = builders.last?.paragraphIdentity,
                      let paragraph = descriptor.paragraphIdentity,
                      previousParagraph != paragraph {
                builders[builders.endIndex - 1].content.append(AttributedString("\n\n"))
                builders[builders.endIndex - 1].paragraphIdentity = paragraph
            }
            builders[builders.endIndex - 1].content.append(AttributedString(attributed[run.range]))
        }

        return builders.map { MarkdownBlock(kind: $0.kind, content: $0.content) }
    }

    private static func descriptor(for intent: PresentationIntent?) -> Descriptor {
        let components = intent?.components ?? []
        let paragraphIdentity = components.first {
            if case .paragraph = $0.kind { return true }
            return false
        }?.identity

        if let component = components.first(where: {
            if case .codeBlock = $0.kind { return true }
            return false
        }), case let .codeBlock(language) = component.kind {
            return Descriptor(
                identity: component.identity,
                kind: .codeBlock(language: language),
                paragraphIdentity: nil
            )
        }

        if let component = components.first(where: {
            if case .header = $0.kind { return true }
            return false
        }), case let .header(level) = component.kind {
            return Descriptor(
                identity: component.identity,
                kind: .heading(level: level),
                paragraphIdentity: nil
            )
        }

        if let itemIndex = components.firstIndex(where: {
            if case .listItem = $0.kind { return true }
            return false
        }), case let .listItem(ordinal) = components[itemIndex].kind {
            let listKind = components.dropFirst(itemIndex + 1).first {
                if case .orderedList = $0.kind { return true }
                if case .unorderedList = $0.kind { return true }
                return false
            }?.kind
            let marker: String
            if case .orderedList? = listKind {
                marker = "\(ordinal)."
            } else {
                marker = "•"
            }
            let depth = max(0, components.reduce(into: 0) { count, component in
                if case .orderedList = component.kind { count += 1 }
                if case .unorderedList = component.kind { count += 1 }
            } - 1)
            return Descriptor(
                identity: components[itemIndex].identity,
                kind: .listItem(marker: marker, depth: depth),
                paragraphIdentity: paragraphIdentity
            )
        }

        return Descriptor(
            identity: components.first?.identity ?? 0,
            kind: .paragraph,
            paragraphIdentity: paragraphIdentity
        )
    }
}

private final class MarkdownRenderer: ObservableObject {
    @Published private(set) var document: MarkdownDocument?

    private let sources = PassthroughSubject<String, Never>()
    private var cancellable: AnyCancellable?

    init() {
        cancellable = sources
            .removeDuplicates()
            .throttle(
                for: .milliseconds(50),
                scheduler: DispatchQueue.global(qos: .userInitiated),
                latest: true
            )
            .map(MarkdownDocument.init)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] document in self?.document = document }
    }

    func render(_ source: String) {
        sources.send(source)
    }
}

enum MarkdownTextRole {
    case body
    case question
    case reasoning

    var font: NSFont {
        NSFont.preferredFont(forTextStyle: self == .reasoning ? .callout : .body)
    }

    var color: NSColor {
        switch self {
        case .body: .labelColor
        case .question: .controlAccentColor
        case .reasoning: .secondaryLabelColor
        }
    }
}

private struct SelectableMarkdownView: NSViewRepresentable {
    let document: MarkdownDocument
    let alignment: NSTextAlignment
    let role: MarkdownTextRole

    func makeNSView(context: Context) -> SelectableMarkdownTextView {
        SelectableMarkdownTextView()
    }

    func updateNSView(_ textView: SelectableMarkdownTextView, context: Context) {
        textView.render(document, alignment: alignment, role: role)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView textView: SelectableMarkdownTextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width else { return nil }
        return CGSize(width: width, height: textView.contentHeight(for: width))
    }
}

final class SelectableMarkdownTextView: NSTextView {
    private struct CodeOverlay {
        let range: NSRange
        let source: String
        let button: NSButton
    }

    private var codeOverlays: [CodeOverlay] = []

    convenience init() {
        self.init(frame: .zero)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        configure()
    }

    private func configure() {
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = true
        isHorizontallyResizable = false
        isVerticallyResizable = true
        linkTextAttributes = [
            .foregroundColor: NSColor.linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func render(
        _ document: MarkdownDocument,
        alignment: NSTextAlignment,
        role: MarkdownTextRole
    ) {
        let rendered = makeAttributedString(document, alignment: alignment, role: role)
        guard textStorage?.isEqual(to: rendered.text) != true else { return }

        textStorage?.setAttributedString(rendered.text)
        installCodeButtons(rendered.codeBlocks)
        invalidateIntrinsicContentSize()
    }

    func contentHeight(for width: CGFloat) -> CGFloat {
        guard width > 0, let textContainer, let layoutManager else { return 0 }
        setFrameSize(NSSize(width: width, height: max(frame.height, 1)))
        textContainer.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        return ceil(layoutManager.usedRect(for: textContainer).height)
    }

    override func layout() {
        super.layout()
        guard let textContainer, let layoutManager else { return }
        layoutManager.ensureLayout(for: textContainer)

        for overlay in codeOverlays {
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: overlay.range,
                actualCharacterRange: nil
            )
            let blockRect = layoutManager.boundingRect(
                forGlyphRange: glyphRange,
                in: textContainer
            )
            let size = overlay.button.fittingSize
            overlay.button.frame = NSRect(
                x: max(0, bounds.maxX - size.width - 8),
                y: blockRect.minY + 4,
                width: size.width,
                height: size.height
            )
        }
    }

    @objc private func copyCode(_ sender: NSButton) {
        guard codeOverlays.indices.contains(sender.tag) else { return }
        MarkdownCodeActions.copy(codeOverlays[sender.tag].source)
    }

    private struct RenderedContent {
        struct CodeBlock {
            let range: NSRange
            let source: String
        }

        let text: NSAttributedString
        let codeBlocks: [CodeBlock]
    }

    private func makeAttributedString(
        _ document: MarkdownDocument,
        alignment: NSTextAlignment,
        role: MarkdownTextRole
    ) -> RenderedContent {
        let result = NSMutableAttributedString()
        var codeBlocks: [RenderedContent.CodeBlock] = []

        for (index, block) in document.blocks.enumerated() {
            if index > 0 {
                let previous = document.blocks[index - 1]
                let separator = if case .listItem = previous.kind, case .listItem = block.kind {
                    "\n"
                } else {
                    "\n\n"
                }
                result.append(NSAttributedString(string: separator, attributes: baseAttributes(role)))
            }

            let start = result.length
            switch block.kind {
            case .paragraph:
                result.append(fragment(block.content, font: role.font, alignment: alignment, role: role))
            case let .heading(level):
                result.append(fragment(
                    block.content,
                    font: headingFont(level),
                    alignment: alignment,
                    role: role
                ))
            case let .listItem(marker, depth):
                result.append(NSAttributedString(
                    string: String(repeating: "    ", count: depth) + marker + " ",
                    attributes: baseAttributes(role)
                ))
                result.append(fragment(block.content, font: role.font, alignment: alignment, role: role))
            case let .codeBlock(language):
                let source = String(block.content.characters)
                let displayedSource = source.hasSuffix("\n") ? String(source.dropLast()) : source
                let label = language.flatMap { $0.isEmpty ? nil : $0 } ?? "Code"
                let code = NSMutableAttributedString(
                    string: "\(label)\n\(displayedSource)",
                    attributes: baseAttributes(role)
                )
                let paragraphStyle = codeParagraphStyle(alignment: alignment)
                code.addAttribute(.paragraphStyle, value: paragraphStyle, range: code.fullRange)
                code.addAttributes([
                    .font: NSFont.preferredFont(forTextStyle: .caption2),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ], range: NSRange(location: 0, length: (label as NSString).length))
                code.addAttribute(
                    .font,
                    value: NSFont.monospacedSystemFont(ofSize: role.font.pointSize, weight: .regular),
                    range: NSRange(
                        location: (label as NSString).length + 1,
                        length: (displayedSource as NSString).length
                    )
                )
                result.append(code)
                codeBlocks.append(.init(
                    range: NSRange(location: start, length: code.length),
                    source: source
                ))
            }
        }

        return RenderedContent(text: result, codeBlocks: codeBlocks)
    }

    private func fragment(
        _ content: AttributedString,
        font: NSFont,
        alignment: NSTextAlignment,
        role: MarkdownTextRole
    ) -> NSAttributedString {
        let fragment = NSMutableAttributedString(attributedString: NSAttributedString(content))
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.alignment = alignment
        fragment.addAttributes([
            .font: font,
            .foregroundColor: role.color,
            .paragraphStyle: paragraphStyle,
        ], range: fragment.fullRange)
        fragment.enumerateAttribute(
            .inlinePresentationIntent,
            in: fragment.fullRange
        ) { value, range, _ in
            guard let rawValue = (value as? NSNumber)?.uintValue else { return }
            let intent = InlinePresentationIntent(rawValue: rawValue)
            var inlineFont = font
            if intent.contains(.code) {
                inlineFont = NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular)
                fragment.addAttribute(
                    .backgroundColor,
                    value: NSColor.secondaryLabelColor.withAlphaComponent(0.12),
                    range: range
                )
            } else {
                var traits: NSFontTraitMask = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.boldFontMask) }
                if intent.contains(.emphasized) { traits.insert(.italicFontMask) }
                inlineFont = NSFontManager.shared.convert(font, toHaveTrait: traits)
            }
            fragment.addAttribute(.font, value: inlineFont, range: range)
            if intent.contains(.strikethrough) {
                fragment.addAttribute(
                    .strikethroughStyle,
                    value: NSUnderlineStyle.single.rawValue,
                    range: range
                )
            }
        }
        return fragment
    }

    private func baseAttributes(_ role: MarkdownTextRole) -> [NSAttributedString.Key: Any] {
        [
            .font: role.font,
            .foregroundColor: role.color,
        ]
    }

    private func headingFont(_ level: Int) -> NSFont {
        let style: NSFont.TextStyle = switch level {
        case 1: .title2
        case 2: .title3
        default: .headline
        }
        let font = NSFont.preferredFont(forTextStyle: style)
        return NSFont.systemFont(ofSize: font.pointSize, weight: .bold)
    }

    private func codeParagraphStyle(alignment: NSTextAlignment) -> NSParagraphStyle {
        let block = NSTextBlock()
        block.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.75)
        block.setBorderColor(NSColor.separatorColor.withAlphaComponent(0.28))
        for edge in [NSRectEdge.minX, .maxX, .minY, .maxY] {
            block.setWidth(8, type: .absoluteValueType, for: .padding, edge: edge)
        }
        block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .minX)
        block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .maxX)
        block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .minY)
        block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .maxY)

        let style = NSMutableParagraphStyle()
        style.alignment = alignment
        style.textBlocks = [block]
        return style
    }

    private func installCodeButtons(_ blocks: [RenderedContent.CodeBlock]) {
        codeOverlays.forEach { $0.button.removeFromSuperview() }
        codeOverlays = blocks.enumerated().map { index, block in
            let button = NSButton(title: "Copy", target: self, action: #selector(copyCode(_:)))
            button.tag = index
            button.isBordered = false
            button.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
            button.imagePosition = .imageLeading
            button.font = NSFont.preferredFont(forTextStyle: .caption2)
            button.contentTintColor = .secondaryLabelColor
            button.toolTip = "Copy code"
            addSubview(button)
            return CodeOverlay(range: block.range, source: block.source, button: button)
        }
        needsLayout = true
    }
}

private extension NSAttributedString {
    var fullRange: NSRange { NSRange(location: 0, length: length) }
}

struct MarkdownMessageView: View {
    enum Alignment {
        case leading
        case trailing

        var frame: SwiftUI.Alignment { self == .leading ? .leading : .trailing }
        var text: TextAlignment { self == .leading ? .leading : .trailing }
    }

    private let source: String
    private let alignment: Alignment
    private let role: MarkdownTextRole
    @StateObject private var renderer = MarkdownRenderer()

    init(
        _ source: String,
        alignment: Alignment = .leading,
        role: MarkdownTextRole = .body
    ) {
        self.source = source
        self.alignment = alignment
        self.role = role
    }

    var body: some View {
        Group {
            if let document = renderer.document {
                SelectableMarkdownView(
                    document: document,
                    alignment: alignment == .leading ? .left : .right,
                    role: role
                )
            } else {
                Text(source)
            }
        }
        .frame(maxWidth: .infinity, alignment: alignment.frame)
        .multilineTextAlignment(alignment.text)
        .textSelection(.enabled)
        .task(id: source) { renderer.render(source) }
    }
}
