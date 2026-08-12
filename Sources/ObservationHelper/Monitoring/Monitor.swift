import AppKit
import Foundation

@MainActor
final class Monitor {
    private let onSignal: @Sendable (NativeActivitySignal) -> Void
    private let onStatus: @Sendable (SourceStatus) -> Void
    private let onDiagnostic: @Sendable (NativeDiagnosticEvent) -> Void
    private let visualSource: VisualSource
    private lazy var axSource = AXSource(
        onEvent: { [weak self] event in
            self?.handle(event)
        },
        onStatus: onStatus
    )
    private lazy var inputSource = InputSource(
        onEvent: { [weak self] event in
            self?.handle(event)
        },
        onStatus: onStatus
    )
    private var filter = SelfFilter(
        processIdentifiers: [],
        bundleIdentifiers: []
    )
    private var configuration: NativeObservationConfiguration?
    private var currentTarget = CachedTargetCache()
    private var placeholderAnnouncements = PlaceholderAnnouncementGate()
    private var coalescers = [
        NativeActivityKind: Coalescer
    ]()
    private var flushTasks = [
        NativeActivityKind: Task<Void, Never>
    ]()
    private var workspaceObservers = [NSObjectProtocol]()
    private var started = false

    init(
        onSignal: @escaping @Sendable (NativeActivitySignal) -> Void,
        onStatus: @escaping @Sendable (SourceStatus) -> Void,
        onDiagnostic: @escaping @Sendable (NativeDiagnosticEvent) -> Void = { _ in }
    ) {
        self.onSignal = onSignal
        self.onStatus = onStatus
        self.onDiagnostic = onDiagnostic
        self.visualSource = VisualSource(
            onSignal: onSignal,
            onStatus: onStatus,
            onDiagnostic: onDiagnostic
        )
    }

    func start(
        filter: SelfFilter,
        configuration: NativeObservationConfiguration
    ) {
        self.filter = filter
        self.configuration = configuration
        cancelCoalescedSignals()
        let interval = Int64(
            configuration.activityMonitoring.coalescingIntervalMilliseconds
        )
        coalescers = Dictionary(
            uniqueKeysWithValues: [
                NativeActivityKind.keyActivity,
                .accessibilityChanged,
            ].map {
                ($0, Coalescer(intervalMilliseconds: interval))
            }
        )
        guard !started else {
            refresh(kind: .applicationActivated)
            return
        }
        started = true
        installWorkspaceObservers()
        inputSource.start()
        refresh(kind: .applicationActivated)
    }

    func stop() {
        guard started else {
            return
        }
        started = false
        let center = NSWorkspace.shared.notificationCenter
        for observer in workspaceObservers {
            center.removeObserver(observer)
        }
        workspaceObservers.removeAll()
        currentTarget.replace(with: nil)
        placeholderAnnouncements.reset()
        cancelCoalescedSignals()
        coalescers.removeAll()
        axSource.stop()
        inputSource.stop()
        visualSource.stop()
        onStatus(
            SourceStatus(component: .visualStream, state: .stopped, message: nil)
        )
    }

    private func handle(_ event: AXSource.Event) {
        switch event {
        case .focusedWindow:
            refresh(kind: .focusedWindowChanged)
        case .focusedElement:
            emitCached(kind: .focusedElementChanged)
        case .valueChanged:
            emitCoalesced(kind: .accessibilityChanged)
        }
    }

    private func handle(_ event: InputSource.Event) {
        switch event {
        case .mouse:
            emitCached(kind: .mouseClick)
        case .key:
            emitCoalesced(kind: .keyActivity)
        }
    }

    private func installWorkspaceObservers() {
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(
            center.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.refresh(kind: .applicationActivated)
                }
            }
        )
        workspaceObservers.append(
            center.addObserver(
                forName: NSWorkspace.activeSpaceDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.refresh(kind: .spaceChanged)
                }
            }
        )
        workspaceObservers.append(
            center.addObserver(
                forName: NSWorkspace.didWakeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.refresh(kind: .wake)
                }
            }
        )
        workspaceObservers.append(
            center.addObserver(
                forName: NSWorkspace.didTerminateApplicationNotification,
                object: nil,
                queue: .main
            ) { [weak self] notification in
                guard
                    let application = notification.userInfo?[
                        NSWorkspace.applicationUserInfoKey
                    ] as? NSRunningApplication
                else {
                    return
                }
                Task { @MainActor in
                    guard self?.currentTarget.window?.processIdentifier
                        == application.processIdentifier
                    else {
                        return
                    }
                    self?.refresh(kind: .applicationActivated)
                }
            }
        )
    }

    private func refresh(kind: NativeActivityKind) {
        guard let configuration else {
            return
        }
        resetCoalescedSignals()
        let window = WindowResolver.currentWindow(
            excluding: filter,
            configuration: configuration.windowSelection
        )
        let shouldEmit = placeholderAnnouncements.shouldEmit(window: window)
        currentTarget.replace(with: window)
        axSource.observe(processIdentifier: window?.processIdentifier)
        visualSource.restart(
            for: currentTarget.window,
            configuration: configuration.visualMonitoring,
            validateWindow: { [filter] target in
                WindowResolver.resolveFrozenTarget(
                    target,
                    excluding: filter,
                    configuration: configuration.windowSelection
                )
            }
        )
        guard shouldEmit, let window else {
            return
        }
        onSignal(
            NativeActivitySignal(
                kind: kind,
                occurredAt: iso8601Timestamp(),
                window: window
            )
        )
    }

    private func emitCached(kind: NativeActivityKind) {
        guard let configuration else {
            return
        }
        let filter = filter
        let selection = configuration.windowSelection
        let validation = currentTarget.validate(using: { target in
            WindowResolver.resolveFrozenTarget(
                target,
                excluding: filter,
                configuration: selection
            )
        })
        switch validation {
        case .absent:
            return
        case .invalidated:
            onDiagnostic(NativeDiagnosticEvent(
                event: .cachedTargetRejected,
                reason: "window_unavailable",
                generation: nil
            ))
            refresh(kind: kind)
            return
        case .valid(let window):
            emit(kind: kind, window: window)
        }
    }

    private func emit(kind: NativeActivityKind, window: WindowMetadata) {
        onSignal(
            NativeActivitySignal(
                kind: kind,
                occurredAt: iso8601Timestamp(),
                window: window
            )
        )
    }

    private func emitCoalesced(kind: NativeActivityKind) {
        let now = monotonicMilliseconds()
        guard var coalescer = coalescers[kind] else {
            emitCached(kind: kind)
            return
        }
        let shouldEmit = coalescer.record(atMilliseconds: now)
        coalescers[kind] = coalescer
        flushTasks[kind]?.cancel()
        flushTasks[kind] = makeFlushTask(
            kind: kind,
            delayMilliseconds: coalescer.intervalMilliseconds
        )
        if shouldEmit {
            emitCached(kind: kind)
        }
    }

    private func makeFlushTask(
        kind: NativeActivityKind,
        delayMilliseconds: Int64
    ) -> Task<Void, Never> {
        Task { @MainActor [weak self] in
            do {
                try await Task.sleep(
                    for: .milliseconds(delayMilliseconds)
                )
            } catch {
                return
            }
            self?.flushCoalesced(kind: kind)
        }
    }

    private func flushCoalesced(kind: NativeActivityKind) {
        let now = monotonicMilliseconds()
        guard var coalescer = coalescers[kind] else {
            return
        }
        let shouldEmit = coalescer.flush(atMilliseconds: now)
        coalescers[kind] = coalescer
        flushTasks[kind] = nil
        if shouldEmit {
            emitCached(kind: kind)
        }
    }

    private func cancelCoalescedSignals() {
        for task in flushTasks.values {
            task.cancel()
        }
        flushTasks.removeAll()
    }

    private func resetCoalescedSignals() {
        cancelCoalescedSignals()
        for kind in coalescers.keys {
            coalescers[kind]?.reset()
        }
    }

}

enum CachedTargetValidation: Equatable {
    case absent
    case invalidated
    case valid(WindowMetadata)
}

struct CachedTargetCache {
    private(set) var window: WindowMetadata?

    init(_ window: WindowMetadata? = nil) {
        self.window = nil
        replace(with: window)
    }

    mutating func replace(with window: WindowMetadata?) {
        self.window = window?.windowIdentifier == nil ? nil : window
    }

    mutating func validate(
        using resolve: (WindowMetadata) -> WindowMetadata?
    ) -> CachedTargetValidation {
        guard let window else {
            return .absent
        }
        guard let resolved = resolve(window) else {
            self.window = nil
            return .invalidated
        }
        self.window = resolved
        return .valid(resolved)
    }
}

struct PlaceholderAnnouncementGate {
    private struct Key: Equatable {
        let processIdentifier: pid_t
        let bundleIdentifier: String?
        let applicationName: String
    }

    private var lastPlaceholder: Key?

    mutating func shouldEmit(window: WindowMetadata?) -> Bool {
        guard let window else {
            reset()
            return false
        }
        guard window.windowIdentifier == nil else {
            reset()
            return true
        }
        let key = Key(
            processIdentifier: window.processIdentifier,
            bundleIdentifier: window.bundleIdentifier,
            applicationName: window.applicationName
        )
        guard key != lastPlaceholder else {
            return false
        }
        lastPlaceholder = key
        return true
    }

    mutating func reset() {
        lastPlaceholder = nil
    }
}

private func monotonicMilliseconds() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
}
