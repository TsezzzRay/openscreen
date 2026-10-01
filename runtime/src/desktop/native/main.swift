import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func writeJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([0x0a]))
}

func attribute(_ element: AXUIElement, _ key: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}

func element(_ parent: AXUIElement, _ key: String) -> AXUIElement? {
    guard let value = attribute(parent, key), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func point(_ target: AXUIElement) -> CGPoint? {
    guard let value = attribute(target, kAXPositionAttribute as String), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var result = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &result) ? result : nil
}

func size(_ target: AXUIElement) -> CGSize? {
    guard let value = attribute(target, kAXSizeAttribute as String), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var result = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &result) ? result : nil
}

struct ExpectedFocus {
    let windowTitle: String
    let role: String
    let label: String?
    let frame: CGRect
    let screenshotWidth: Double

    init(_ request: [String: Any]) throws {
        guard let title = request["windowTitle"] as? String,
              let role = request["role"] as? String,
              let frame = request["frame"] as? [String: Double],
              let x = frame["x"], let y = frame["y"], let w = frame["w"], let h = frame["h"],
              let screenshotWidth = request["screenshotWidth"] as? Double,
              [x, y, w, h, screenshotWidth].allSatisfy({ $0.isFinite }), w > 0, h > 0, screenshotWidth > 0
        else { throw FocusError.invalid }
        windowTitle = title
        self.role = role
        label = request["label"] as? String
        self.frame = CGRect(x: x, y: y, width: w, height: h)
        self.screenshotWidth = screenshotWidth
    }
}

final class FocusState {
    let app: AXUIElement
    let observer: AXObserver
    let pid: pid_t
    let windowId: CGWindowID
    var expected: ExpectedFocus?
    var boundElement: AXUIElement?
    var boundValue: String?
    var armedElement: AXUIElement?
    var focusChanged = false

    init(app: AXUIElement, observer: AXObserver, pid: pid_t, windowId: CGWindowID) {
        self.app = app
        self.observer = observer
        self.pid = pid
        self.windowId = windowId
    }

    func matchesWindowNumber(_ window: AXUIElement) -> Bool {
        guard let origin = point(window), let dimensions = size(window),
              let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowId) as? [[String: Any]],
              raw.count == 1, let entry = raw.first,
              (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId,
              (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let bounds = entry[kCGWindowBounds as String] as? [String: Any],
              let cgBounds = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
        return abs(origin.x - cgBounds.minX) <= 8 && abs(origin.y - cgBounds.minY) <= 8 &&
            abs(dimensions.width - cgBounds.width) <= 8 && abs(dimensions.height - cgBounds.height) <= 8
    }

    func snapshot(_ expected: ExpectedFocus) throws -> (AXUIElement, String, CFRange) {
        guard let window = element(app, kAXFocusedWindowAttribute as String),
              let focused = element(app, kAXFocusedUIElementAttribute as String),
              let owningWindow = element(focused, kAXWindowAttribute as String),
              CFEqual(window, owningWindow), matchesWindowNumber(window) else { throw FocusError.changed }
        guard (attribute(window, kAXTitleAttribute as String) as? String) == expected.windowTitle,
              (attribute(focused, kAXRoleAttribute as String) as? String) == expected.role else { throw FocusError.changed }
        let label = (attribute(focused, kAXTitleAttribute as String) as? String) ??
                    (attribute(focused, kAXDescriptionAttribute as String) as? String)
        if let requiredLabel = expected.label, label != requiredLabel { throw FocusError.changed }
        guard let origin = point(focused), let dimensions = size(focused),
              let windowOrigin = point(window), let windowSize = size(window),
              let value = attribute(focused, kAXValueAttribute as String) as? String,
              let selected = attribute(focused, kAXSelectedTextRangeAttribute as String),
              CFGetTypeID(selected) == AXValueGetTypeID() else { throw FocusError.unverifiable }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(selected as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
              range.location + range.length <= value.utf16.count else { throw FocusError.unverifiable }
        let local = CGRect(origin: CGPoint(x: origin.x - windowOrigin.x, y: origin.y - windowOrigin.y), size: dimensions)
        let global = CGRect(origin: origin, size: dimensions)
        let scale = expected.screenshotWidth > 0 ? Double(windowSize.width) / expected.screenshotWidth : 1
        let scaled = CGRect(x: expected.frame.minX * scale, y: expected.frame.minY * scale,
                            width: expected.frame.width * scale, height: expected.frame.height * scale)
        func near(_ left: CGRect, _ right: CGRect) -> Bool {
            abs(left.minX - right.minX) <= 8 && abs(left.minY - right.minY) <= 8 &&
            abs(left.width - right.width) <= 8 && abs(left.height - right.height) <= 8
        }
        guard near(local, expected.frame) || near(global, expected.frame) || near(local, scaled) else {
            throw FocusError.changed
        }
        return (focused, value, range)
    }

    func locate(_ expected: ExpectedFocus) throws -> AXUIElement {
        guard let windows = attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] else { throw FocusError.windowChanged }
        let matchingWindows = windows.filter {
            matchesWindowNumber($0) && (attribute($0, kAXTitleAttribute as String) as? String) == expected.windowTitle
        }
        guard matchingWindows.count == 1, let window = matchingWindows.first else { throw FocusError.windowChanged }
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var matches: [AXUIElement] = []
        var visited = 0
        while !queue.isEmpty {
            let (candidate, depth) = queue.removeFirst()
            visited += 1
            guard visited <= 400 else { throw FocusError.unverifiable }
            let label = (attribute(candidate, kAXTitleAttribute as String) as? String) ??
                        (attribute(candidate, kAXDescriptionAttribute as String) as? String)
            if (attribute(candidate, kAXRoleAttribute as String) as? String) == expected.role,
               label == expected.label, let origin = point(candidate), let dimensions = size(candidate),
               abs(origin.x - expected.frame.minX) <= 1, abs(origin.y - expected.frame.minY) <= 1,
               abs(dimensions.width - expected.frame.width) <= 1, abs(dimensions.height - expected.frame.height) <= 1 {
                matches.append(candidate)
            }
            if let children = attribute(candidate, kAXChildrenAttribute as String) as? [AXUIElement], !children.isEmpty {
                guard depth < 8, visited + queue.count + children.count <= 400 else { throw FocusError.unverifiable }
                queue.append(contentsOf: children.map { ($0, depth + 1) })
            }
        }
        guard matches.count == 1, let target = matches.first,
              let owner = element(target, kAXWindowAttribute as String), CFEqual(owner, window),
              (attribute(target, kAXEnabledAttribute as String) as? Bool) != false else { throw FocusError.targetChanged }
        return target
    }

    func verifyTarget(_ expected: ExpectedFocus) throws -> AXUIElement {
        let target = try locate(expected)
        guard let boundElement, CFEqual(target, boundElement) else { throw FocusError.valueChanged }
        try verifyNativeInputBaseline(boundValue, attribute(target, kAXValueAttribute as String) as? String)
        return target
    }

    func setFocused(_ expected: ExpectedFocus) throws -> Bool {
        let target = try verifyTarget(expected)
        var settable = DarwinBoolean(false)
        let status = AXUIElementIsAttributeSettable(target, kAXFocusedAttribute as CFString, &settable)
        guard try focusAttributeSettable(status, settable.boolValue) else { return false }
        let foreground = try verifiedForegroundPid(NSWorkspace.shared.frontmostApplication?.processIdentifier)
        let result = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let after = try verifiedForegroundPid(NSWorkspace.shared.frontmostApplication?.processIdentifier)
        var focusedValue: CFTypeRef?
        let focusedStatus = AXUIElementCopyAttributeValue(target, kAXFocusedAttribute as CFString, &focusedValue)
        guard focusedStatus == .success, let focusedValue,
              CFGetTypeID(focusedValue) == CFBooleanGetTypeID() else {
            throw FocusDiagnostic(step: "read-focused", status: focusedStatus)
        }
        return try focusAssignmentConfirmed(result,
            CFBooleanGetValue((focusedValue as! CFBoolean)),
            foreground == after)
    }

    func handle(_ request: [String: Any]) {
        guard let id = request["id"] as? Int, let command = request["command"] as? String else { return }
        do {
            switch command {
            case "bind":
                let expected = try ExpectedFocus(request)
                let target = try locate(expected)
                guard let value = attribute(target, kAXValueAttribute as String) as? String else { throw FocusError.unverifiable }
                self.expected = expected
                boundElement = target
                boundValue = value
                writeJSON(["id": id, "ok": true])
            case "focus":
                guard let expected else { throw FocusError.invalid }
                let supported = try setFocused(expected)
                writeJSON(["id": id, "ok": true, "supported": supported])
            case "verify-target":
                guard let expected else { throw FocusError.invalid }
                _ = try verifyTarget(expected)
                writeJSON(["id": id, "ok": true])
            case "arm":
                guard let expected, let boundElement, let boundValue else { throw FocusError.invalid }
                let (focused, value, range) = try snapshot(expected)
                guard CFEqual(focused, boundElement) else { throw FocusError.valueChanged }
                try verifyNativeInputBaseline(boundValue, value)
                armedElement = focused
                focusChanged = false
                writeJSON(["id": id, "ok": true, "value": value, "selectionStart": range.location, "selectionLength": range.length])
            case "check":
                guard !focusChanged, let expected, let armedElement else { throw FocusError.changed }
                let (focused, value, range) = try snapshot(expected)
                guard CFEqual(focused, armedElement) else { throw FocusError.changed }
                writeJSON(["id": id, "ok": true, "value": value, "selectionStart": range.location, "selectionLength": range.length])
            case "stop":
                writeJSON(["id": id, "ok": true])
                exit(0)
            default: throw FocusError.invalid
            }
        } catch {
            writeJSON(["id": id, "ok": false, "reason": String(describing: error)])
        }
    }
}

var activeState: FocusState?

let arguments = CommandLine.arguments
guard arguments.count == 5, arguments[1] == "--pid", let pid = Int32(arguments[2]), pid > 0 else {
    writeJSON(["event": "error", "reason": "invalid-pid"])
    exit(1)
}
guard arguments[3] == "--window-id", let windowId = UInt32(arguments[4]), windowId > 0 else {
    writeJSON(["event": "error", "reason": "invalid-window-id"])
    exit(1)
}
guard AXIsProcessTrusted() else {
    writeJSON(["event": "error", "reason": "accessibility-permission-denied"])
    exit(1)
}
let app = AXUIElementCreateApplication(pid)
let callback: AXObserverCallback = { _, _, _, _ in activeState?.focusChanged = true }
var observer: AXObserver?
guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
    writeJSON(["event": "error", "reason": "observer-unavailable"])
    exit(1)
}
let state = FocusState(app: app, observer: observer, pid: pid, windowId: windowId)
activeState = state
CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
guard AXObserverAddNotification(observer, app, kAXFocusedUIElementChangedNotification as CFString, nil) == .success else {
    writeJSON(["event": "error", "reason": "focus-notification-unavailable"])
    exit(1)
}
writeJSON(["event": "ready"])
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async { state.handle(request) }
    }
    DispatchQueue.main.async { exit(0) }
}
RunLoop.main.run()
