import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct ActivitySignalCoalescingState {
    let intervalMilliseconds: Int64
    private var lastEmissionMilliseconds: Int64?
    private var lastActivityMilliseconds: Int64?
    private var trailingDeadlineMilliseconds: Int64?

    init(intervalMilliseconds: Int64) {
        self.intervalMilliseconds = intervalMilliseconds
    }

    mutating func record(atMilliseconds now: Int64) -> Bool {
        lastActivityMilliseconds = now
        trailingDeadlineMilliseconds = now + intervalMilliseconds
        guard
            let lastEmissionMilliseconds,
            now - lastEmissionMilliseconds < intervalMilliseconds
        else {
            self.lastEmissionMilliseconds = now
            return true
        }
        return false
    }

    mutating func flush(atMilliseconds now: Int64) -> Bool {
        guard
            let trailingDeadlineMilliseconds,
            now >= trailingDeadlineMilliseconds
        else {
            return false
        }
        self.trailingDeadlineMilliseconds = nil
        guard lastActivityMilliseconds != lastEmissionMilliseconds else {
            return false
        }
        lastEmissionMilliseconds = now
        return true
    }

    mutating func reset() {
        lastEmissionMilliseconds = nil
        lastActivityMilliseconds = nil
        trailingDeadlineMilliseconds = nil
    }
}

@MainActor
final class ActivityMonitor {
    private let writer: JSONLineWriter
    private let visualMonitor: VisualStreamMonitor
    private var filter = SelfCaptureFilter(
        processIdentifiers: [],
        bundleIdentifiers: []
    )
    private var configuration: NativeObservationConfiguration?
    private var currentWindow: WindowMetadata?
    private var keyActivityCoalescingState: ActivitySignalCoalescingState?
    private var accessibilityCoalescingState: ActivitySignalCoalescingState?
    private var keyActivityFlushTask: Task<Void, Never>?
    private var accessibilityFlushTask: Task<Void, Never>?
    private var workspaceObservers = [NSObjectProtocol]()
    private var accessibilityObserver: AXObserver?
    private var accessibilityApplication: AXUIElement?
    private var observedProcessIdentifier: pid_t?
    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var started = false

    init(writer: JSONLineWriter) {
        self.writer = writer
        self.visualMonitor = VisualStreamMonitor(writer: writer)
    }

    func start(
        filter: SelfCaptureFilter,
        configuration: NativeObservationConfiguration
    ) {
        self.filter = filter
        self.configuration = configuration
        cancelCoalescedSignals()
        let interval = Int64(
            configuration.activityMonitoring.coalescingIntervalMilliseconds
        )
        keyActivityCoalescingState = ActivitySignalCoalescingState(
            intervalMilliseconds: interval
        )
        accessibilityCoalescingState = ActivitySignalCoalescingState(
            intervalMilliseconds: interval
        )
        guard !started else {
            refresh(kind: .applicationActivated)
            return
        }
        started = true
        installWorkspaceObservers()
        installEventTap()
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
        currentWindow = nil
        cancelCoalescedSignals()
        keyActivityCoalescingState = nil
        accessibilityCoalescingState = nil
        removeAccessibilityObserver()
        visualMonitor.stop()
        if let eventTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), eventTapSource, .commonModes)
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        eventTapSource = nil
        eventTap = nil
        writer.write(.status(component: "eventTap", status: "stopped"))
        writer.write(.status(component: "accessibility", status: "stopped"))
        writer.write(.status(component: "visualStream", status: "stopped"))
    }

    func handleAccessibilityNotification(_ notification: String) {
        switch notification {
        case kAXFocusedWindowChangedNotification:
            refresh(kind: .focusedWindowChanged)
        case kAXFocusedUIElementChangedNotification:
            emitCached(kind: .focusedElementChanged)
        case kAXValueChangedNotification, kAXTitleChangedNotification:
            emitCoalesced(kind: .accessibilityChanged)
        default:
            break
        }
    }

    func handleEventTap(type: CGEventType, flagsRawValue: UInt64) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            emitCached(kind: .mouseClick)
        case .keyDown:
            let flags = CGEventFlags(rawValue: flagsRawValue)
            guard
                !flags.contains(.maskCommand),
                !flags.contains(.maskControl)
            else {
                return
            }
            emitCoalesced(kind: .keyActivity)
        default:
            break
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
                    guard self?.observedProcessIdentifier == application.processIdentifier else {
                        return
                    }
                    self?.refresh(kind: .applicationActivated)
                }
            }
        )
    }

    private func installEventTap() {
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.keyDown.rawValue)
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        guard let eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: observationEventTapCallback,
            userInfo: pointer
        ) else {
            writer.write(
                .status(
                    component: "eventTap",
                    status: "degraded",
                    message: "Input Monitoring permission is unavailable"
                )
            )
            return
        }
        self.eventTap = eventTap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        eventTapSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
        writer.write(.status(component: "eventTap", status: "ready"))
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
        currentWindow = window
        observeAccessibility(for: window)
        visualMonitor.restart(
            for: window,
            configuration: configuration.visualMonitoring
        )
        guard let window else {
            return
        }
        writer.write(
            .activity(
                NativeActivitySignal(
                    kind: kind,
                    occurredAt: iso8601Timestamp(),
                    window: window
                )
            )
        )
    }

    private func emitCached(kind: NativeActivityKind) {
        guard let window = currentWindow else {
            return
        }
        emit(kind: kind, window: window)
    }

    private func emit(kind: NativeActivityKind, window: WindowMetadata) {
        writer.write(
            .activity(
                NativeActivitySignal(
                    kind: kind,
                    occurredAt: iso8601Timestamp(),
                    window: window
                )
            )
        )
    }

    private func emitCoalesced(kind: NativeActivityKind) {
        let now = monotonicMilliseconds()
        let shouldEmit: Bool
        let interval: Int64
        switch kind {
        case .keyActivity:
            guard var state = keyActivityCoalescingState else {
                return
            }
            shouldEmit = state.record(atMilliseconds: now)
            interval = state.intervalMilliseconds
            keyActivityCoalescingState = state
            keyActivityFlushTask?.cancel()
            keyActivityFlushTask = makeFlushTask(
                kind: kind,
                delayMilliseconds: interval
            )
        case .accessibilityChanged:
            guard var state = accessibilityCoalescingState else {
                return
            }
            shouldEmit = state.record(atMilliseconds: now)
            interval = state.intervalMilliseconds
            accessibilityCoalescingState = state
            accessibilityFlushTask?.cancel()
            accessibilityFlushTask = makeFlushTask(
                kind: kind,
                delayMilliseconds: interval
            )
        default:
            emitCached(kind: kind)
            return
        }
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
        let shouldEmit: Bool
        switch kind {
        case .keyActivity:
            guard var state = keyActivityCoalescingState else {
                return
            }
            shouldEmit = state.flush(atMilliseconds: now)
            keyActivityCoalescingState = state
            keyActivityFlushTask = nil
        case .accessibilityChanged:
            guard var state = accessibilityCoalescingState else {
                return
            }
            shouldEmit = state.flush(atMilliseconds: now)
            accessibilityCoalescingState = state
            accessibilityFlushTask = nil
        default:
            return
        }
        if shouldEmit {
            emitCached(kind: kind)
        }
    }

    private func cancelCoalescedSignals() {
        keyActivityFlushTask?.cancel()
        keyActivityFlushTask = nil
        accessibilityFlushTask?.cancel()
        accessibilityFlushTask = nil
    }

    private func resetCoalescedSignals() {
        cancelCoalescedSignals()
        keyActivityCoalescingState?.reset()
        accessibilityCoalescingState?.reset()
    }

    private func observeAccessibility(for window: WindowMetadata?) {
        guard let window else {
            removeAccessibilityObserver()
            return
        }
        guard observedProcessIdentifier != window.processIdentifier else {
            return
        }
        removeAccessibilityObserver()

        guard AXIsProcessTrustedWithOptions(
            ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        ) else {
            writer.write(
                .status(
                    component: "accessibility",
                    status: "degraded",
                    message: "Accessibility permission is unavailable"
                )
            )
            return
        }

        var observer: AXObserver?
        guard
            AXObserverCreate(
                window.processIdentifier,
                observationAXCallback,
                &observer
            ) == .success,
            let observer
        else {
            writer.write(
                .status(
                    component: "accessibility",
                    status: "degraded",
                    message: "Unable to observe the frontmost application"
                )
            )
            return
        }
        let application = AXUIElementCreateApplication(window.processIdentifier)
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        for notification in [
            kAXFocusedWindowChangedNotification,
            kAXFocusedUIElementChangedNotification,
            kAXValueChangedNotification,
            kAXTitleChangedNotification,
        ] {
            _ = AXObserverAddNotification(
                observer,
                application,
                notification as CFString,
                pointer
            )
        }
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .commonModes
        )
        accessibilityObserver = observer
        accessibilityApplication = application
        observedProcessIdentifier = window.processIdentifier
        writer.write(.status(component: "accessibility", status: "ready"))
    }

    private func removeAccessibilityObserver() {
        if let accessibilityObserver {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(accessibilityObserver),
                .commonModes
            )
        }
        accessibilityObserver = nil
        accessibilityApplication = nil
        observedProcessIdentifier = nil
    }
}

private func monotonicMilliseconds() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
}

private func observationAXCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else {
        return
    }
    let monitor = Unmanaged<ActivityMonitor>.fromOpaque(refcon).takeUnretainedValue()
    let notification = notification as String
    Task { @MainActor in
        monitor.handleAccessibilityNotification(notification)
    }
}

private func observationEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else {
        return Unmanaged.passUnretained(event)
    }
    let monitor = Unmanaged<ActivityMonitor>.fromOpaque(refcon).takeUnretainedValue()
    let flagsRawValue = event.flags.rawValue
    Task { @MainActor in
        monitor.handleEventTap(type: type, flagsRawValue: flagsRawValue)
    }
    return Unmanaged.passUnretained(event)
}
