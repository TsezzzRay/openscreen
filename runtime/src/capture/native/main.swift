// OpenScreen capture helper.
//
// Answers one question: what is on the user's screens right now, and what does
// the window they are working in say? It is spawned once per prompt and exits.
//
// This exists because the recorder that keeps the background activity history
// cannot answer that question on demand. Its frames are written on its own
// triggers — a click, a typing pause, an idle heartbeat — so the newest one
// lags the moment the user asked by a median of ~2.5s and can name a window
// they have already left, and the only on-demand frame it offers is a 480x312
// thumbnail with no text in it. Both are read here directly instead:
// ScreenCaptureKit for full-resolution pixels, the accessibility tree for the
// text, at the instant the prompt is submitted.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct Options {
    var outDir = FileManager.default.temporaryDirectory.path
    /// Fraction of the display's logical size. 1.0 is already legible and about
    /// a fifth the bytes of the native retina image.
    var scale = 1.0
    var quality = 0.6
    var maxNodes = 400
    var maxText = 8000
    /// Bundle identifiers whose windows are cut out of the capture, so the
    /// assistant's own interface never becomes the screen it is asked about.
    var excludeBundleIds: [String] = []
}

func parseOptions() -> Options {
    var options = Options()
    var arguments = Array(CommandLine.arguments.dropFirst())
    while let flag = arguments.first {
        arguments.removeFirst()
        func value() -> String? {
            guard let next = arguments.first else { return nil }
            arguments.removeFirst()
            return next
        }
        switch flag {
        case "--out-dir": options.outDir = value() ?? options.outDir
        case "--scale": options.scale = Double(value() ?? "") ?? options.scale
        case "--quality": options.quality = Double(value() ?? "") ?? options.quality
        case "--max-nodes": options.maxNodes = Int(value() ?? "") ?? options.maxNodes
        case "--max-text": options.maxText = Int(value() ?? "") ?? options.maxText
        case "--exclude-bundle":
            if let id = value() { options.excludeBundleIds.append(id) }
        default: break
        }
    }
    return options
}

// MARK: - Accessibility

func axValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
    else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    axValue(element, attribute) as? String
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = axValue(element, attribute) else { return nil }
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axValue(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let value = axValue(element, attribute), CFGetTypeID(value) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let value = axValue(element, attribute), CFGetTypeID(value) == AXValueGetTypeID()
    else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

/// Depth-first walk of the focused window, taking the first text-bearing
/// attribute each element exposes. Bounded on both node count and characters so
/// a large document cannot stall the prompt or flood the model's context.
func collectText(_ root: AXUIElement, maxNodes: Int, maxText: Int) -> (String, Int) {
    var pieces: [String] = []
    var visited = 0
    var characters = 0
    var stack = [root]
    while let element = stack.popLast(), visited < maxNodes, characters < maxText {
        visited += 1
        for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            guard let raw = axString(element, attribute as String) else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            pieces.append(trimmed)
            characters += trimmed.count
            break
        }
        stack.append(contentsOf: axChildren(element).reversed())
    }
    return (String(pieces.joined(separator: "\n").prefix(maxText)), visited)
}

struct FocusedWindow {
    var appName: String
    var bundleId: String?
    var windowTitle: String?
    var text: String?
    var nodes: Int
    var displayId: UInt32?
}

/// The frontmost application the user is actually working in.
///
/// Not `NSWorkspace.frontmostApplication`: the assistant's own command bar takes
/// the keyboard while it is open, and macOS then reports the assistant as
/// frontmost. Reading its window yields the assistant's own interface as the
/// screen the user is asking about. The on-screen window list is in front-to-back
/// order, so the first normal-layer window whose owner is not excluded is the
/// window the question is really about.
///
/// The system-wide element's focused-application attribute is not used either;
/// it reports nothing in practice.
func frontmostOwner(excluding excluded: [String]) -> NSRunningApplication? {
    let listed = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    guard let windows = listed as? [[String: Any]] else { return nil }
    for window in windows {
        // Layer 0 is an ordinary application window; menu bars, the Dock, and
        // notification banners sit above it and are never the subject.
        guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let pid = window[kCGWindowOwnerPID as String] as? pid_t else { continue }
        guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
        if let bundleId = app.bundleIdentifier, excluded.contains(bundleId) { continue }
        return app
    }
    return nil
}

func readFocusedWindow(_ options: Options) -> (FocusedWindow?, String?) {
    guard AXIsProcessTrusted() else { return (nil, "accessibility permission not granted") }
    guard let front = frontmostOwner(excluding: options.excludeBundleIds) else {
        return (nil, "no frontmost application")
    }
    var focused = FocusedWindow(
        appName: front.localizedName ?? "",
        bundleId: front.bundleIdentifier,
        windowTitle: nil,
        text: nil,
        nodes: 0,
        displayId: nil)
    let app = AXUIElementCreateApplication(front.processIdentifier)
    guard let window = axElement(app, kAXFocusedWindowAttribute as String) else {
        return (focused, "no focused window")
    }
    focused.windowTitle = axString(window, kAXTitleAttribute as String)
    let (text, nodes) = collectText(
        window, maxNodes: options.maxNodes, maxText: options.maxText)
    focused.text = text.isEmpty ? nil : text
    focused.nodes = nodes
    // Accessibility positions and CGDisplayBounds share a top-left global
    // origin, so the window's centre picks its display directly.
    if let origin = axPoint(window, kAXPositionAttribute as String),
        let size = axSize(window, kAXSizeAttribute as String)
    {
        let centre = CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        if CGGetActiveDisplayList(16, &ids, &count) == .success {
            for id in ids.prefix(Int(count)) where CGDisplayBounds(id).contains(centre) {
                focused.displayId = id
                break
            }
        }
    }
    return (focused, nil)
}

// MARK: - Screenshot

func encodeJpeg(_ image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard
        let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
        destination, image,
        [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}

let options = parseOptions()
let capturedAt = ISO8601DateFormatter().string(from: Date())
let (focused, focusError) = readFocusedWindow(options)

var displayReports: [[String: Any]] = []
var captureError: String?
do {
    let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true)
    let excluded = content.windows.filter { window in
        guard let id = window.owningApplication?.bundleIdentifier else { return false }
        return options.excludeBundleIds.contains(id)
    }
    try FileManager.default.createDirectory(
        atPath: options.outDir, withIntermediateDirectories: true)

    for display in content.displays {
        var report: [String: Any] = [
            "displayId": display.displayID,
            "width": display.width,
            "height": display.height,
            "focused": focused?.displayId == display.displayID,
        ]
        do {
            let filter = SCContentFilter(display: display, excludingWindows: excluded)
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(Double(display.width) * options.scale))
            configuration.height = max(1, Int(Double(display.height) * options.scale))
            let image: CGImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: configuration)
            guard let data = encodeJpeg(image, quality: options.quality) else {
                throw NSError(
                    domain: "OpenScreenCapture", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "JPEG encoding failed"])
            }
            let path = (options.outDir as NSString).appendingPathComponent(
                "display-\(display.displayID).jpg")
            try data.write(to: URL(fileURLWithPath: path))
            report["path"] = path
            report["bytes"] = data.count
            report["pixelWidth"] = image.width
            report["pixelHeight"] = image.height
        } catch {
            report["error"] = "\(error)"
        }
        displayReports.append(report)
    }
} catch {
    captureError = "\(error)"
}

var payload: [String: Any] = ["capturedAt": capturedAt, "displays": displayReports]
if let focused {
    var report: [String: Any] = ["appName": focused.appName, "nodes": focused.nodes]
    if let value = focused.bundleId { report["bundleId"] = value }
    if let value = focused.windowTitle { report["windowTitle"] = value }
    if let value = focused.text { report["text"] = value }
    if let value = focused.displayId { report["displayId"] = value }
    payload["focused"] = report
}
var errors: [String: Any] = [:]
if let focusError { errors["focused"] = focusError }
if let captureError { errors["capture"] = captureError }
if !errors.isEmpty { payload["errors"] = errors }

FileHandle.standardOutput.write(
    try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
