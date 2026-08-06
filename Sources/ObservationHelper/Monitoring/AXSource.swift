import ApplicationServices
import Foundation

@MainActor
final class AXSource {
    enum Event: Sendable {
        case focusedWindow
        case focusedElement
        case valueChanged
    }

    private let onEvent: @MainActor @Sendable (Event) -> Void
    private let onStatus: @MainActor @Sendable (SourceStatus) -> Void
    private var observer: AXObserver?
    private var application: AXUIElement?
    private var processIdentifier: pid_t?

    init(
        onEvent: @escaping @MainActor @Sendable (Event) -> Void,
        onStatus: @escaping @MainActor @Sendable (SourceStatus) -> Void
    ) {
        self.onEvent = onEvent
        self.onStatus = onStatus
    }

    func observe(processIdentifier: pid_t?) {
        guard self.processIdentifier != processIdentifier else {
            return
        }
        clear()
        guard let processIdentifier else {
            return
        }
        guard AXIsProcessTrustedWithOptions(
            ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        ) else {
            onStatus(
                SourceStatus(
                    component: .accessibility,
                    state: .degraded,
                    message: "Accessibility permission is unavailable"
                )
            )
            return
        }

        var observer: AXObserver?
        guard
            AXObserverCreate(
                processIdentifier,
                axSourceCallback,
                &observer
            ) == .success,
            let observer
        else {
            onStatus(
                SourceStatus(
                    component: .accessibility,
                    state: .degraded,
                    message: "Unable to observe the frontmost application"
                )
            )
            return
        }

        let application = AXUIElementCreateApplication(processIdentifier)
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
        self.observer = observer
        self.application = application
        self.processIdentifier = processIdentifier
        onStatus(
            SourceStatus(component: .accessibility, state: .ready, message: nil)
        )
    }

    func stop() {
        clear()
        onStatus(
            SourceStatus(
                component: .accessibility,
                state: .stopped,
                message: nil
            )
        )
    }

    fileprivate func handle(notification: String) {
        switch notification {
        case kAXFocusedWindowChangedNotification:
            onEvent(.focusedWindow)
        case kAXFocusedUIElementChangedNotification:
            onEvent(.focusedElement)
        case kAXValueChangedNotification:
            onEvent(.valueChanged)
        case kAXTitleChangedNotification:
            break
        default:
            break
        }
    }

    private func clear() {
        if let observer {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .commonModes
            )
        }
        observer = nil
        application = nil
        processIdentifier = nil
    }
}

private func axSourceCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else {
        return
    }
    let source = Unmanaged<AXSource>.fromOpaque(refcon).takeUnretainedValue()
    let notification = notification as String
    Task { @MainActor in
        source.handle(notification: notification)
    }
}
