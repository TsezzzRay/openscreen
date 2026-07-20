import AppKit
import SwiftUI

private extension ChatTurnStatus {
    var label: String {
        switch self {
        case .capturing: "Capturing screenshot…"
        case .requesting: "Requesting…"
        case .generating: "Generating…"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .interrupted: "Interrupted"
        }
    }
}

struct ChatScrollTrigger: Equatable {
    let sessionID: UUID?
    let turnID: UUID?
    let turnCount: Int
    let reasoningLength: Int
    let answerLength: Int
    let status: ChatTurnStatus?
    let turnError: String?
    let sessionError: String?
}

enum ChatScrollPosition {
    static func isAtBottom(
        contentHeight: CGFloat,
        visibleMaxY: CGFloat,
        threshold: CGFloat = 24
    ) -> Bool {
        contentHeight - visibleMaxY <= threshold
    }

    static func followsLatest(
        current: Bool,
        oldPhase: ScrollPhase,
        newPhase: ScrollPhase,
        contentHeight: CGFloat,
        visibleMaxY: CGFloat
    ) -> Bool {
        switch newPhase {
        case .tracking, .interacting:
            false
        case .idle where oldPhase != .animating:
            isAtBottom(contentHeight: contentHeight, visibleMaxY: visibleMaxY)
        default:
            current
        }
    }
}

struct ChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var showsHistory = false
    @State private var renamedSessionID: UUID?
    @State private var renameTitle = ""
    @State private var followsLatest = true

    private static let bottomID = "chat-bottom"

    private var scrollTrigger: ChatScrollTrigger {
        let turn = viewModel.turns.last
        return ChatScrollTrigger(
            sessionID: viewModel.currentSessionID,
            turnID: turn?.id,
            turnCount: viewModel.turns.count,
            reasoningLength: turn?.reasoning.utf8.count ?? 0,
            answerLength: turn?.answer.utf8.count ?? 0,
            status: turn?.status,
            turnError: turn?.error,
            sessionError: viewModel.sessionError
        )
    }

    var body: some View {
        VStack(spacing: 18) {
            HStack(spacing: 10) {
                Button {
                    showsHistory.toggle()
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession)
                .accessibilityLabel("Chat history")
                .popover(isPresented: $showsHistory) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Chats")
                            .font(.headline)
                            .padding(.horizontal, 8)
                        ForEach(viewModel.sessions) { session in
                            HStack(spacing: 8) {
                                Button {
                                    viewModel.selectSession(session.id)
                                    showsHistory = false
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(session.title)
                                            .lineLimit(1)
                                        Text(
                                            String(session.updatedAt.prefix(16))
                                                .replacingOccurrences(of: "T", with: " ")
                                        )
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                Button {
                                    renamedSessionID = session.id
                                    renameTitle = session.title
                                    showsHistory = false
                                } label: {
                                    Image(systemName: "pencil")
                                }
                                .buttonStyle(.plain)
                                .disabled(
                                    viewModel.isManagingSession ||
                                    viewModel.activeSessionIDs.contains(session.id)
                                )
                                .accessibilityLabel("Rename \(session.title)")
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                        }
                    }
                    .padding(10)
                    .frame(width: 280)
                }

                Text(viewModel.currentTitle)
                    .font(.headline)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    if let id = viewModel.currentSessionID {
                        renamedSessionID = id
                        renameTitle = viewModel.currentTitle
                    }
                } label: {
                    Image(systemName: "pencil")
                }
                .buttonStyle(.plain)
                .disabled(
                    viewModel.isManagingSession || viewModel.isSending ||
                    viewModel.currentSessionID == nil
                )
                .accessibilityLabel("Rename current chat")

                Button(action: viewModel.createNewSession) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession)
                .accessibilityLabel("New chat")
            }

            if let error = viewModel.sessionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(viewModel.turns) { turn in
                                HStack {
                                    Spacer(minLength: 48)
                                    MarkdownMessageView(turn.question)
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
                                            MarkdownMessageView(turn.reasoning)
                                                .font(.callout)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer(minLength: 48)
                                    }
                                }
                                if !turn.answer.isEmpty {
                                    HStack {
                                        MarkdownMessageView(turn.answer)
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 16)
                                            .padding(.vertical, 12)
                                            .background(Color.black.opacity(0.38))
                                            .clipShape(RoundedRectangle(cornerRadius: 18))
                                        Spacer(minLength: 48)
                                    }
                                }
                                turnStatus(turn)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(Self.bottomID)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .onScrollPhaseChange { oldPhase, newPhase, context in
                        followsLatest = ChatScrollPosition.followsLatest(
                            current: followsLatest,
                            oldPhase: oldPhase,
                            newPhase: newPhase,
                            contentHeight: context.geometry.contentSize.height,
                            visibleMaxY: context.geometry.visibleRect.maxY
                        )
                    }
                    .onScrollGeometryChange(for: CGFloat.self) { geometry in
                        geometry.contentSize.height
                    } action: { _, _ in
                        if followsLatest {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                    }

                    if !followsLatest {
                        Button {
                            followsLatest = true
                            withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                        }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("Jump to latest message")
                        .padding(8)
                    }
                }
                .onChange(of: scrollTrigger) { oldValue, newValue in
                    let startsNewContext = oldValue.sessionID != newValue.sessionID ||
                        oldValue.turnID != newValue.turnID ||
                        oldValue.turnCount != newValue.turnCount
                    if startsNewContext { followsLatest = true }
                    if followsLatest || startsNewContext {
                        proxy.scrollTo(Self.bottomID, anchor: .bottom)
                    }
                }
            }

            HStack(spacing: 12) {
                ChatTextEditor(
                    text: $viewModel.draft,
                    focusRequest: viewModel.focusRequest,
                    isEnabled: !viewModel.isManagingSession && !viewModel.isSending,
                    onSubmit: viewModel.submit
                )
                .frame(height: 54)

                requestButton
            }
            .padding(10)
            .background(Color.black.opacity(0.28))
            .clipShape(RoundedRectangle(cornerRadius: 20))
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.70))
        .clipShape(RoundedRectangle(cornerRadius: 28))
        .alert(
            "Rename Chat",
            isPresented: Binding(
                get: { renamedSessionID != nil },
                set: { if !$0 { renamedSessionID = nil } }
            )
        ) {
            TextField("Name", text: $renameTitle)
            Button("Cancel", role: .cancel) { renamedSessionID = nil }
            Button("Rename") {
                if let id = renamedSessionID {
                    viewModel.renameSession(id: id, title: renameTitle)
                }
                renamedSessionID = nil
            }
            .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func turnStatus(_ turn: ChatTurn) -> some View {
        HStack(spacing: 8) {
            Text(
                turn.status == .failed
                    ? "Failed: \(turn.error ?? "Request failed. Please retry.")"
                    : turn.status.label
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            Spacer()
            if turn.status == .failed || turn.status == .cancelled {
                Button("Retry") {
                    viewModel.retry(turnID: turn.id)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession || viewModel.isSending)
            }
        }
    }

    private var requestButton: some View {
        Button {
            if viewModel.isSending {
                viewModel.cancelCurrentRequest()
            } else {
                viewModel.submit()
            }
        } label: {
            Image(systemName: viewModel.isSending ? "xmark" : "arrow.up")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 42, height: 42)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 13))
        .disabled(
            viewModel.isManagingSession ||
            (!viewModel.isSending &&
                viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        )
        .accessibilityLabel(viewModel.isSending ? "Cancel request" : "Send")
    }
}
