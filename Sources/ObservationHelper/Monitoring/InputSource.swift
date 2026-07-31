import CoreGraphics
import Foundation

@MainActor
final class InputSource {
    enum Event: Sendable {
        case mouse
        case key
    }

    private let onEvent: @MainActor @Sendable (Event) -> Void
    private let onStatus: @MainActor @Sendable (SourceStatus) -> Void
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    init(
        onEvent: @escaping @MainActor @Sendable (Event) -> Void,
        onStatus: @escaping @MainActor @Sendable (SourceStatus) -> Void
    ) {
        self.onEvent = onEvent
        self.onStatus = onStatus
    }

    func start() {
        guard tap == nil else {
            return
        }
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.keyDown.rawValue)
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: inputSourceCallback,
            userInfo: pointer
        ) else {
            onStatus(
                SourceStatus(
                    component: .eventTap,
                    state: .degraded,
                    message: "Input Monitoring permission is unavailable"
                )
            )
            return
        }
        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        onStatus(
            SourceStatus(component: .eventTap, state: .ready, message: nil)
        )
    }

    func stop() {
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        source = nil
        tap = nil
        onStatus(
            SourceStatus(component: .eventTap, state: .stopped, message: nil)
        )
    }

    fileprivate func handle(type: CGEventType, flags: CGEventFlags) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            onEvent(.mouse)
        case .keyDown:
            guard
                !flags.contains(.maskCommand),
                !flags.contains(.maskControl)
            else {
                return
            }
            onEvent(.key)
        default:
            break
        }
    }
}

private func inputSourceCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else {
        return Unmanaged.passUnretained(event)
    }
    let source = Unmanaged<InputSource>.fromOpaque(refcon).takeUnretainedValue()
    let flags = event.flags
    Task { @MainActor in
        source.handle(type: type, flags: flags)
    }
    return Unmanaged.passUnretained(event)
}
