import AppKit
import SwiftUI

struct ChatTurn: Identifiable {
    let id = UUID()
    let question: String
    var reasoning: String
    var answer: String
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published var draft = ""
    @Published private(set) var turns: [ChatTurn] = []
    @Published private(set) var isSending = false
    @Published private(set) var focusRequest = 0

    private let agentClient: AgentClient
    private let windowCapture: WindowCapture

    init(agentClient: AgentClient, windowCapture: WindowCapture) {
        self.agentClient = agentClient
        self.windowCapture = windowCapture
    }

    func requestInputFocus() {
        focusRequest += 1
    }

    func startTurn(question: String) -> Int {
        turns.append(ChatTurn(question: question, reasoning: "", answer: ""))
        return turns.index(before: turns.endIndex)
    }

    func finishTurn(at index: Int, answer: String) {
        guard turns.indices.contains(index) else { return }
        turns[index].answer = answer
    }

    func apply(_ event: AgentEvent, at index: Int) {
        guard turns.indices.contains(index), let delta = event.delta else { return }
        switch event.type {
        case .reasoningDelta:
            turns[index].reasoning += delta
        case .answerDelta:
            turns[index].answer += delta
        case .started, .completed, .failed:
            break
        }
    }

    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }

        let turnIndex = startTurn(question: text)
        draft = ""
        isSending = true

        Task {
            do {
                let imageURL = try await windowCapture.captureActiveWindow()
                let events = try await agentClient.send(text: text, imageURL: imageURL)
                for try await event in events {
                    apply(event, at: turnIndex)
                }
            } catch {
                finishTurn(at: turnIndex, answer: "Unable to answer: \(error.localizedDescription)")
            }
            isSending = false
            requestInputFocus()
        }
    }
}

struct ChatView: View {
    @ObservedObject var viewModel: ChatViewModel

    var body: some View {
        VStack(spacing: 18) {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(viewModel.turns) { turn in
                        HStack {
                            Spacer(minLength: 48)
                            Text(turn.question)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                                .background(Color.accentColor.opacity(0.85))
                                .clipShape(RoundedRectangle(cornerRadius: 18))
                        }
                        if !turn.reasoning.isEmpty {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Reasoning summary")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(turn.reasoning)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 48)
                            }
                        }
                        if !turn.answer.isEmpty {
                            HStack {
                                Text(turn.answer)
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 12)
                                    .background(Color.black.opacity(0.38))
                                    .clipShape(RoundedRectangle(cornerRadius: 18))
                                Spacer(minLength: 48)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }

            HStack(spacing: 12) {
                ChatTextEditor(
                    text: $viewModel.draft,
                    focusRequest: viewModel.focusRequest,
                    isEnabled: !viewModel.isSending,
                    onSubmit: viewModel.submit
                )
                .frame(height: 54)

                Button(action: viewModel.submit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 42, height: 42)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 13))
                .disabled(viewModel.isSending || viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
            .padding(10)
            .background(Color.black.opacity(0.28))
            .clipShape(RoundedRectangle(cornerRadius: 20))
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.70))
        .clipShape(RoundedRectangle(cornerRadius: 28))
    }
}

private struct ChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    let focusRequest: Int
    let isEnabled: Bool
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
        textView.isRichText = false
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: 16)
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: 8, height: 9)
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? SubmitTextView else { return }
        context.coordinator.parent = self
        textView.onSubmit = onSubmit
        textView.isEditable = isEnabled
        if textView.string != text {
            textView.string = text
        }
        if context.coordinator.focusRequest != focusRequest {
            context.coordinator.focusRequest = focusRequest
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatTextEditor
        var focusRequest = -1

        init(parent: ChatTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

private final class SubmitTextView: NSTextView {
    var onSubmit: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36, !event.modifierFlags.contains(.shift) {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }
}
