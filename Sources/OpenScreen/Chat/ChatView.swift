import AppKit
import SwiftUI

extension ChatTurnStatus {
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

    var showsInTranscript: Bool {
        self != .completed
    }

    var isInProgress: Bool {
        switch self {
        case .capturing, .requesting, .generating: true
        case .completed, .failed, .cancelled, .interrupted: false
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

    private var subtitle: String {
        if let status = viewModel.turns.last?.status, status.isInProgress {
            return status.label
        }
        let count = viewModel.turns.count
        if count == 0 { return "New chat" }
        return "\(count) \(count == 1 ? "turn" : "turns")"
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            if let error = viewModel.sessionError {
                sessionErrorBanner(error)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }

            transcript
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            LinearGradient(
                colors: [
                    Color(nsColor: .windowBackgroundColor).opacity(0.98),
                    Color(nsColor: .controlBackgroundColor).opacity(0.92),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.16), lineWidth: 0.5)
        }
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

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                showsHistory.toggle()
            } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isManagingSession)
            .accessibilityLabel("Chat history")
            .popover(isPresented: $showsHistory) { historyPopover }

            VStack(alignment: .leading, spacing: 1) {
                Text(viewModel.currentTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Menu {
                Button("Rename Chat", systemImage: "pencil") {
                    beginRename(
                        id: viewModel.currentSessionID,
                        title: viewModel.currentTitle
                    )
                }
                .disabled(
                    viewModel.isManagingSession || viewModel.isSending ||
                    viewModel.currentSessionID == nil
                )
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 30, height: 30)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("Chat actions")

            Button(action: viewModel.createNewSession) {
                Image(systemName: "plus")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isManagingSession)
            .accessibilityLabel("New chat")
        }
        .padding(.horizontal, 14)
        .frame(height: 58)
    }

    private var historyPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Chats")
                    .font(.headline)
                Spacer()
                Text("\(viewModel.sessions.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6)

            if viewModel.sessions.isEmpty {
                Text("No chats yet")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView {
                    LazyVStack(spacing: 3) {
                        ForEach(viewModel.sessions) { session in
                            historyRow(session)
                        }
                    }
                }
                .frame(maxHeight: 360)
            }
        }
        .padding(10)
        .frame(width: 300)
    }

    private func historyRow(_ session: ChatSessionSummary) -> some View {
        HStack(spacing: 8) {
            Button {
                viewModel.selectSession(session.id)
                showsHistory = false
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(session.title)
                            .lineLimit(1)
                        if viewModel.activeSessionIDs.contains(session.id) {
                            Circle()
                                .fill(Color.accentColor)
                                .frame(width: 6, height: 6)
                        }
                    }
                    Text(formattedTimestamp(session.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Menu {
                Button("Rename", systemImage: "pencil") {
                    showsHistory = false
                    beginRename(id: session.id, title: session.title)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 24, height: 24)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(
                viewModel.isManagingSession ||
                viewModel.activeSessionIDs.contains(session.id)
            )
            .accessibilityLabel("Actions for \(session.title)")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .background(
            session.id == viewModel.currentSessionID
                ? Color.accentColor.opacity(0.10)
                : Color.clear
        )
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(spacing: 24) {
                        if viewModel.turns.isEmpty {
                            emptyState
                        } else {
                            ForEach(viewModel.turns) { turn in
                                ChatTurnView(
                                    turn: turn,
                                    isInteractionDisabled: viewModel.isManagingSession || viewModel.isSending,
                                    onRetry: { viewModel.retry(turnID: turn.id) }
                                )
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomID)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 16)
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
                        withAnimation(.easeOut(duration: 0.16)) {
                            proxy.scrollTo(Self.bottomID, anchor: .bottom)
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.circle)
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
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "macwindow")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.secondary)
            Text("Ask about the current window")
                .font(.headline)
            Text("OpenScreen captures it only when you send a question.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: 260)
        .padding(.top, 96)
        .padding(.bottom, 72)
        .accessibilityElement(children: .combine)
    }

    private var composer: some View {
        HStack(spacing: 7) {
            Image(systemName: "macwindow")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 27, height: 27)
                .help("The current window is captured when you send")

            ChatTextEditor(
                text: $viewModel.draft,
                focusRequest: viewModel.focusRequest,
                isEnabled: !viewModel.isManagingSession && !viewModel.isSending,
                onSubmit: viewModel.submit
            )
            .frame(height: 36)

            requestButton
        }
        .padding(.leading, 7)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.78))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .stroke(Color.secondary.opacity(0.18), lineWidth: 0.5)
        }
        .shadow(color: Color.black.opacity(0.07), radius: 9, y: 4)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 12)
    }

    private var requestButton: some View {
        let isDisabled = viewModel.isManagingSession ||
            (!viewModel.isSending &&
                viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        return Button {
            if viewModel.isSending {
                viewModel.cancelCurrentRequest()
            } else {
                viewModel.submit()
            }
        } label: {
            Image(systemName: viewModel.isSending ? "xmark" : "arrow.up")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(viewModel.isSending ? Color.red.opacity(0.86) : Color.accentColor)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
        .animation(.easeOut(duration: 0.14), value: viewModel.isSending)
        .accessibilityLabel(viewModel.isSending ? "Cancel request" : "Send")
    }

    private func sessionErrorBanner(_ error: String) -> some View {
        Label(error, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color.red.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func beginRename(id: UUID?, title: String) {
        guard let id else { return }
        renamedSessionID = id
        renameTitle = title
    }

    private func formattedTimestamp(_ value: String) -> String {
        String(value.prefix(16)).replacingOccurrences(of: "T", with: " ")
    }
}

private struct ChatTurnView: View {
    let turn: ChatTurn
    let isInteractionDisabled: Bool
    let onRetry: () -> Void
    @State private var showsReasoning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            VStack(alignment: .trailing, spacing: 4) {
                Text("YOU")
                    .font(.caption2.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(.secondary)
                MarkdownMessageView(turn.question, alignment: .trailing)
                    .foregroundStyle(Color.accentColor)
                    .frame(maxWidth: 310, alignment: .trailing)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

            if !turn.reasoning.isEmpty {
                reasoningDisclosure
            }

            if !turn.answer.isEmpty {
                MarkdownMessageView(turn.answer)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if turn.status.showsInTranscript {
                statusRow
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var reasoningDisclosure: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    showsReasoning.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "sparkles")
                    Text("Reasoning summary")
                    Spacer()
                    Image(systemName: showsReasoning ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showsReasoning ? "Hide reasoning summary" : "Show reasoning summary")

            if showsReasoning {
                MarkdownMessageView(turn.reasoning)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var statusRow: some View {
        HStack(spacing: 7) {
            if turn.status.isInProgress {
                ProgressView()
                    .controlSize(.mini)
            }
            Text(statusText)
                .font(.caption)
                .foregroundStyle(turn.status == .failed ? Color.red : Color.secondary)
            Spacer()
            if turn.status == .failed || turn.status == .cancelled {
                Button("Retry", action: onRetry)
                    .buttonStyle(.plain)
                    .font(.caption.weight(.medium))
                    .disabled(isInteractionDisabled)
            }
        }
    }

    private var statusText: String {
        turn.status == .failed
            ? "Failed: \(turn.error ?? "Request failed. Please retry.")"
            : turn.status.label
    }
}
