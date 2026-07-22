import AppKit
import SwiftUI
import UniformTypeIdentifiers

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

struct ChatImagePreviewState {
    private(set) var url: URL?

    mutating func present(_ attachment: ChatImageAttachment) {
        url = attachment.url
    }

    mutating func dismiss() {
        url = nil
    }
}

private struct ChatPanelMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .underWindowBackground
        view.blendingMode = .behindWindow
        view.state = .active
        view.alphaValue = 0.68
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

final class ChatScroller: NSScroller {
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override func drawKnob() {
        let knob = rect(for: .knob)
        guard knob.height > 0 else { return }
        let thumb = NSRect(x: knob.midX - 2.5, y: knob.minY, width: 5, height: knob.height)
        NSColor.secondaryLabelColor.withAlphaComponent(0.36).setFill()
        NSBezierPath(roundedRect: thumb, xRadius: 2.5, yRadius: 2.5).fill()
    }

    func show() {
        layer?.removeAllAnimations()
        alphaValue = 1
    }

    func hide() {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            animator().alphaValue = 0
        }
    }

    override func mouseDown(with event: NSEvent) {
        show()
        super.mouseDown(with: event)
        hide()
    }
}

@MainActor
final class ChatScrollerVisibility: NSObject {
    private weak var scrollView: NSScrollView?

    init(scrollView: NSScrollView) {
        self.scrollView = scrollView
        super.init()
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .overlay
        let scroller = ChatScroller()
        scroller.alphaValue = 0
        scrollView.verticalScroller = scroller
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(scrollingDidStart(_:)),
            name: NSScrollView.willStartLiveScrollNotification,
            object: scrollView
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(scrollingDidEnd(_:)),
            name: NSScrollView.didEndLiveScrollNotification,
            object: scrollView
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func scrollingDidStart(_ notification: Notification) {
        (scrollView?.verticalScroller as? ChatScroller)?.show()
    }

    @objc private func scrollingDidEnd(_ notification: Notification) {
        (scrollView?.verticalScroller as? ChatScroller)?.hide()
    }
}

private final class ChatScrollerStyleView: NSView {
    private var didInstallScroller = false
    private var scrollerVisibility: ChatScrollerVisibility?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            didInstallScroller = false
            scrollerVisibility = nil
            return
        }
        scheduleInstallation()
    }

    func scheduleInstallation() {
        guard !didInstallScroller, window != nil else { return }
        didInstallScroller = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.installScroller()
        }
    }

    private func installScroller() {
        guard let scrollView = enclosingScrollView else { return }
        scrollerVisibility = ChatScrollerVisibility(scrollView: scrollView)
    }
}

private struct ChatScrollerStyle: NSViewRepresentable {
    func makeNSView(context: Context) -> ChatScrollerStyleView {
        ChatScrollerStyleView()
    }

    func updateNSView(_ view: ChatScrollerStyleView, context: Context) {
        view.scheduleInstallation()
    }
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
    @State private var composerHeight = ChatComposerLayout.minimumHeight
    @State private var showsImageImporter = false
    @State private var imagePreview = ChatImagePreviewState()
    @FocusState private var isRenameFocused: Bool

    private static let bottomID = "chat-bottom"

    private var composerAttachmentHeight: CGFloat {
        viewModel.pendingAttachments.isEmpty ? 0 : 62
    }

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

    private var subtitle: String? {
        if let status = viewModel.turns.last?.status, status.isInProgress {
            return status.label
        }
        return nil
    }

    var body: some View {
        transcript
            .overlay(alignment: .top) { topControls }
            .overlay(alignment: .bottom) { composer }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { ChatPanelMaterial() }
            .overlay {
                if let url = imagePreview.url {
                    imagePreviewOverlay(url: url)
                        .transition(.opacity)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(Color.white.opacity(0.12), lineWidth: 0.5)
            }
            .overlay {
                if let id = renamedSessionID {
                    renameOverlay(sessionID: id)
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }
            }
            .animation(.easeOut(duration: 0.14), value: renamedSessionID)
            .animation(.easeOut(duration: 0.14), value: imagePreview.url)
            .fileImporter(
                isPresented: $showsImageImporter,
                allowedContentTypes: [.image],
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case let .success(urls):
                    viewModel.addAttachments(from: urls)
                case let .failure(error):
                    viewModel.reportAttachmentError(error)
                }
            }
    }

    private var topControls: some View {
        VStack(spacing: 0) {
            header

            if let error = viewModel.sessionError {
                sessionErrorBanner(error)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                showsHistory.toggle()
            } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .frame(width: 30, height: 30)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isManagingSession)
            .accessibilityLabel("Chat history")
            .popover(isPresented: $showsHistory) { historyPopover }

            VStack(alignment: .leading, spacing: 1) {
                Text(viewModel.currentTitle)
                    .font(.headline)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
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
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(Circle())
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("Chat actions")

            Button(action: viewModel.createNewSession) {
                Image(systemName: "plus")
                    .frame(width: 30, height: 30)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(Circle())
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
            ZStack {
                ScrollView {
                    LazyVStack(spacing: 24) {
                        if viewModel.turns.isEmpty {
                            emptyState
                        } else {
                            ForEach(viewModel.turns) { turn in
                                ChatTurnView(
                                    turn: turn,
                                    isInteractionDisabled: viewModel.isManagingSession || viewModel.isSending,
                                    onRetry: { viewModel.retry(turnID: turn.id) },
                                    onPreview: { imagePreview.present($0) }
                                )
                            }
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomID)
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 76)
                    .padding(
                        .bottom,
                        ChatComposerLayout.transcriptBottomPadding(
                            for: composerHeight + composerAttachmentHeight
                        )
                    )
                    .frame(maxWidth: .infinity)
                    .background { ChatScrollerStyle() }
                }
                .mask {
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black, location: 0.11),
                            .init(color: .black, location: 0.82),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
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
        VStack(alignment: .leading, spacing: 6) {
            if !viewModel.pendingAttachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(viewModel.pendingAttachments) { attachment in
                            attachmentThumbnail(
                                attachment,
                                width: 64,
                                height: 48,
                                removable: true
                            )
                        }
                    }
                    .padding(.top, 4)
                    .padding(.trailing, 4)
                }
                .scrollIndicators(.hidden)
                .frame(height: 58)
            }

            if let error = viewModel.attachmentError {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }

            ChatTextEditor(
                text: Binding(
                    get: { viewModel.draft },
                    set: { viewModel.updateDraft($0) }
                ),
                height: $composerHeight,
                focusRequest: viewModel.focusRequest,
                isEnabled: !viewModel.isManagingSession,
                onPasteImages: viewModel.addPastedImages,
                onSubmit: viewModel.submit
            )
            .frame(height: composerHeight)

            HStack {
                Button {
                    showsImageImporter = true
                } label: {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isManagingSession)
                .accessibilityLabel("Add screenshots")

                if viewModel.isImportingAttachments {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Preparing screenshots")
                }

                Spacer()
                requestButton
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.top, 11)
        .padding(.bottom, 8)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(nsColor: .textBackgroundColor))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.secondary.opacity(0.14), lineWidth: 0.5)
        }
        .shadow(color: Color.black.opacity(0.10), radius: 18, y: 8)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 12)
    }

    private var requestButton: some View {
        let isDisabled = viewModel.isManagingSession ||
            (!viewModel.isSending &&
                (viewModel.isImportingAttachments ||
                    viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
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

    @ViewBuilder
    private func attachmentThumbnail(
        _ attachment: ChatImageAttachment,
        width: CGFloat,
        height: CGFloat,
        removable: Bool
    ) -> some View {
        if let image = NSImage(contentsOf: attachment.url) {
            ZStack(alignment: .topTrailing) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: width, height: height)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.primary.opacity(0.12), lineWidth: 0.5)
                    }
                    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .onTapGesture { imagePreview.present(attachment) }
                    .accessibilityLabel("Attached screenshot")
                    .accessibilityHint("Opens screenshot preview")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { imagePreview.present(attachment) }

                if removable {
                    Button {
                        viewModel.removeAttachment(id: attachment.id)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.primary)
                            .frame(width: 20, height: 20)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(Circle())
                            .shadow(color: .black.opacity(0.16), radius: 3, y: 1)
                    }
                    .buttonStyle(.plain)
                    .offset(x: 5, y: -5)
                    .accessibilityLabel("Remove screenshot")
                }
            }
        }
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

    private func renameOverlay(sessionID: UUID) -> some View {
        ZStack {
            Color.black.opacity(0.12)
                .contentShape(Rectangle())
                .onTapGesture { renamedSessionID = nil }

            VStack(alignment: .leading, spacing: 14) {
                Text("Rename chat")
                    .font(.headline)

                TextField("Chat name", text: $renameTitle)
                    .textFieldStyle(.plain)
                    .focused($isRenameFocused)
                    .onSubmit { commitRename(sessionID) }
                    .padding(.horizontal, 11)
                    .frame(height: 34)
                    .background(Color.primary.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .stroke(Color.primary.opacity(0.10), lineWidth: 0.5)
                    }

                HStack(spacing: 8) {
                    Spacer()
                    Button("Cancel") { renamedSessionID = nil }
                        .keyboardShortcut(.cancelAction)
                    Button("Save") { commitRename(sessionID) }
                        .keyboardShortcut(.defaultAction)
                        .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .buttonStyle(.bordered)
            }
            .padding(18)
            .frame(width: 292)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.white.opacity(0.20), lineWidth: 0.5)
            }
            .shadow(color: .black.opacity(0.18), radius: 22, y: 10)
        }
    }

    private func imagePreviewOverlay(url: URL) -> some View {
        ZStack(alignment: .topTrailing) {
            Color.black.opacity(0.72)
                .contentShape(Rectangle())
                .onTapGesture { imagePreview.dismiss() }

            if let image = NSImage(contentsOf: url) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(24)
                    .onTapGesture {}
                    .accessibilityLabel("Screenshot preview")
            } else {
                Label("Screenshot unavailable", systemImage: "photo.badge.exclamationmark")
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            Button {
                imagePreview.dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 34, height: 34)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel("Close screenshot preview")
            .padding(14)
        }
    }

    private func commitRename(_ sessionID: UUID) {
        let title = renameTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        viewModel.renameSession(id: sessionID, title: title)
        renamedSessionID = nil
    }

    private func beginRename(id: UUID?, title: String) {
        guard let id else { return }
        renamedSessionID = id
        renameTitle = title
        Task { @MainActor in isRenameFocused = true }
    }

    private func formattedTimestamp(_ value: String) -> String {
        String(value.prefix(16)).replacingOccurrences(of: "T", with: " ")
    }
}

private struct ChatTurnView: View {
    let turn: ChatTurn
    let isInteractionDisabled: Bool
    let onRetry: () -> Void
    let onPreview: (ChatImageAttachment) -> Void
    @State private var showsReasoning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            userMessage

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

    private var userMessage: some View {
        VStack(alignment: .trailing, spacing: 10) {
            if !turn.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(turn.attachments) { attachment in
                            if let image = NSImage(contentsOf: attachment.url) {
                                Button {
                                    onPreview(attachment)
                                } label: {
                                    Image(nsImage: image)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 112, height: 76)
                                        .clipShape(RoundedRectangle(
                                            cornerRadius: 12,
                                            style: .continuous
                                        ))
                                        .overlay {
                                            RoundedRectangle(
                                                cornerRadius: 12,
                                                style: .continuous
                                            )
                                            .stroke(Color.primary.opacity(0.12), lineWidth: 0.5)
                                        }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Open screenshot")
                            }
                        }
                    }
                }
                .defaultScrollAnchor(.trailing)
                .scrollIndicators(.hidden)
            }

            MarkdownMessageView(turn.question, alignment: .trailing, role: .question)
                .foregroundStyle(Color.accentColor)
        }
        .frame(maxWidth: 310, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
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
                MarkdownMessageView(turn.reasoning, role: .reasoning)
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
