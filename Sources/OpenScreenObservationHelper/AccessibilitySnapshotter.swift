import ApplicationServices
import Foundation

enum AccessibilitySnapshotter {
    private static let maximumDepth = 40
    private static let maximumNodes = 5_000
    private static let timeout: TimeInterval = 2
    private static let maximumTextLength = 8_192

    static func capture(window: WindowMetadata) -> AccessibilityCapture {
        let startedAt = Date()
        guard AXIsProcessTrusted() else {
            return AccessibilityCapture(
                status: .permissionDenied,
                durationMilliseconds: elapsedMilliseconds(since: startedAt),
                snapshot: nil
            )
        }

        let application = AXUIElementCreateApplication(window.processIdentifier)
        AXUIElementSetMessagingTimeout(application, Float(timeout))
        let root = focusedWindow(of: application) ?? application
        var budget = SnapshotBudget(
            maxDepth: maximumDepth,
            maxNodes: maximumNodes,
            deadline: startedAt.addingTimeInterval(timeout)
        )
        var visited = Set<CFHashCode>()
        guard let node = snapshot(
            element: root,
            depth: 0,
            budget: &budget,
            visited: &visited
        ) else {
            return AccessibilityCapture(
                status: budget.timedOut ? .timedOut : .failed,
                durationMilliseconds: elapsedMilliseconds(since: startedAt),
                snapshot: nil
            )
        }
        return AccessibilityCapture(
            status: budget.timedOut ? .timedOut : .complete,
            durationMilliseconds: elapsedMilliseconds(since: startedAt),
            snapshot: AccessibilitySnapshot(
                root: node,
                nodeCount: budget.nodeCount,
                truncated: budget.truncated
            )
        )
    }

    private static func snapshot(
        element: AXUIElement,
        depth: Int,
        budget: inout SnapshotBudget,
        visited: inout Set<CFHashCode>
    ) -> AccessibilityNode? {
        guard budget.consume(depth: depth) else {
            return nil
        }
        let identity = CFHash(element)
        guard visited.insert(identity).inserted else {
            return nil
        }

        let role = stringAttribute(element, kAXRoleAttribute) ?? "AXUnknown"
        let subrole = stringAttribute(element, kAXSubroleAttribute)
        let rawValue = textAttribute(element, kAXValueAttribute)
        let value = sanitizeAccessibilityValue(rawValue, role: role, subrole: subrole)
        var childNodes = [AccessibilityNode]()
        for child in children(of: element) {
            if let childNode = snapshot(
                element: child,
                depth: depth + 1,
                budget: &budget,
                visited: &visited
            ) {
                childNodes.append(childNode)
            }
            if budget.timedOut {
                break
            }
        }

        return AccessibilityNode(
            role: role,
            subrole: subrole,
            title: stringAttribute(element, kAXTitleAttribute),
            value: value,
            identifier: stringAttribute(element, kAXIdentifierAttribute),
            elementDescription: stringAttribute(element, kAXDescriptionAttribute),
            frame: frame(of: element),
            focused: boolAttribute(element, kAXFocusedAttribute),
            enabled: boolAttribute(element, kAXEnabledAttribute),
            selected: boolAttribute(element, kAXSelectedAttribute),
            children: childNodes.isEmpty ? nil : childNodes
        )
    }

    private static func focusedWindow(of application: AXUIElement) -> AXUIElement? {
        guard let value = attribute(application, kAXFocusedWindowAttribute) else {
            return nil
        }
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return (value as! AXUIElement)
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        if let visible = attribute(element, kAXVisibleChildrenAttribute) as? [AXUIElement] {
            return visible
        }
        return attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    private static func stringAttribute(
        _ element: AXUIElement,
        _ name: String
    ) -> String? {
        guard let value = attribute(element, name) as? String else {
            return nil
        }
        return normalizeAccessibilityText(truncate(value))
    }

    private static func textAttribute(
        _ element: AXUIElement,
        _ name: String
    ) -> String? {
        guard let value = attribute(element, name) else {
            return nil
        }
        if let text = value as? String {
            return normalizeAccessibilityText(truncate(text))
        }
        if let number = value as? NSNumber {
            return number.stringValue
        }
        return nil
    }

    private static func boolAttribute(
        _ element: AXUIElement,
        _ name: String
    ) -> Bool? {
        if let value = attribute(element, name) as? Bool {
            return value
        }
        return (attribute(element, name) as? NSNumber)?.boolValue
    }

    private static func frame(of element: AXUIElement) -> WindowFrame? {
        guard
            let positionValue = attribute(element, kAXPositionAttribute),
            let sizeValue = attribute(element, kAXSizeAttribute)
        else {
            return nil
        }
        guard
            CFGetTypeID(positionValue) == AXValueGetTypeID(),
            CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else {
            return nil
        }
        let position = positionValue as! AXValue
        let size = sizeValue as! AXValue
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard
            AXValueGetType(position) == .cgPoint,
            AXValueGetValue(position, .cgPoint, &point),
            AXValueGetType(size) == .cgSize,
            AXValueGetValue(size, .cgSize, &dimensions)
        else {
            return nil
        }
        return WindowFrame(
            x: point.x,
            y: point.y,
            width: dimensions.width,
            height: dimensions.height
        )
    }

    private static func attribute(
        _ element: AXUIElement,
        _ name: String
    ) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            name as CFString,
            &value
        ) == .success else {
            return nil
        }
        return value
    }

    private static func truncate(_ value: String) -> String {
        guard value.count > maximumTextLength else {
            return value
        }
        return String(value.prefix(maximumTextLength))
    }
}

private func elapsedMilliseconds(since date: Date) -> Double {
    Date().timeIntervalSince(date) * 1_000
}
