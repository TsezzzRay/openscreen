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

struct MarkdownMessageView: View {
    enum Alignment {
        case leading
        case trailing

        var horizontal: HorizontalAlignment { self == .leading ? .leading : .trailing }
        var frame: SwiftUI.Alignment { self == .leading ? .leading : .trailing }
        var text: TextAlignment { self == .leading ? .leading : .trailing }
    }

    private let source: String
    private let alignment: Alignment
    @StateObject private var renderer = MarkdownRenderer()

    init(_ source: String, alignment: Alignment = .leading) {
        self.source = source
        self.alignment = alignment
    }

    var body: some View {
        Group {
            if let document = renderer.document {
                VStack(alignment: alignment.horizontal, spacing: 8) {
                    ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                        blockView(block)
                    }
                }
            } else {
                Text(source)
            }
        }
        .frame(maxWidth: .infinity, alignment: alignment.frame)
        .multilineTextAlignment(alignment.text)
        .textSelection(.enabled)
        .task(id: source) { renderer.render(source) }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case .paragraph:
            Text(styledInlineCode(in: block.content))
        case let .heading(level):
            Text(styledInlineCode(in: block.content))
                .font(headingFont(level))
        case let .listItem(marker, depth):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker)
                    .frame(width: 24, alignment: .trailing)
                Text(styledInlineCode(in: block.content))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(depth) * 16)
        case let .codeBlock(language):
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(language.flatMap { $0.isEmpty ? nil : $0 } ?? "Code")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        MarkdownCodeActions.copy(String(block.content.characters))
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .labelStyle(.titleAndIcon)
                    }
                    .buttonStyle(.plain)
                    .font(.caption2)
                    .accessibilityLabel("Copy code")
                }
                ScrollView(.horizontal) {
                    Text(String(block.content.characters))
                        .font(.callout.monospaced())
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(10)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.75))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.secondary.opacity(0.14), lineWidth: 0.5)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func styledInlineCode(in source: AttributedString) -> AttributedString {
        var content = source
        let codeRanges: [Range<AttributedString.Index>] = content.runs.compactMap { run in
            run.inlinePresentationIntent?.contains(.code) == true ? run.range : nil
        }
        for range in codeRanges {
            content[range].font = .body.monospaced()
            content[range].backgroundColor = Color.secondary.opacity(0.12)
        }
        return content
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        case 3: .headline
        default: .subheadline.bold()
        }
    }
}
