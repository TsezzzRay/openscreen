import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

@_silgen_name("_AXUIElementGetWindow")
private func copyCGWindowIdentifier(
    _ element: AXUIElement,
    _ identifier: UnsafeMutablePointer<CGWindowID>
) -> AXError

enum AXSnapshot {
    private static let activationCache = AXRendererAccessibilityActivationCache()

    struct PreparedTarget: @unchecked Sendable {
        let startedAt: Date
        let roots: [AXUIElement]
        let windowIdentifiers: [CGWindowID]
        let missingWindowIdentifiers: [CGWindowID]
        let failureReason: AccessibilityFailureReason?
        let activationStatus: AXRendererActivationStatus?
        let activationAttempts: [AXRendererActivationAttempt]
        let activationWaitMilliseconds: Double
        let activationNodeCountBefore: Int?
        let excludedText: [String]
    }

    private static let nodeAttributeNames = [
        kAXRoleAttribute,
        kAXSubroleAttribute,
        kAXValueAttribute,
        kAXTitleAttribute,
        kAXIdentifierAttribute,
        kAXDescriptionAttribute,
        kAXPositionAttribute,
        kAXSizeAttribute,
        kAXFocusedAttribute,
        kAXEnabledAttribute,
        kAXSelectedAttribute,
        kAXVisibleChildrenAttribute,
        kAXChildrenAttribute,
    ]

    static func activateRendererAccessibility(
        identity: AXRendererProcessIdentity,
        cache: AXRendererAccessibilityActivationCache,
        setAttribute: (AXRendererActivationMethod) -> AXError,
        waitUntilUseful: (AXRendererActivationMethod, AXRendererActivationStatus) -> Bool
    ) -> AXRendererActivationOutcome {
        var attempts = [AXRendererActivationAttempt]()
        var becameUseful = false
        for method in [
            AXRendererActivationMethod.enhancedUserInterface,
            .manualAccessibility,
        ] {
            let status = cache.activate(identity: identity, method: method) {
                setAttribute(method)
            }
            attempts.append(AXRendererActivationAttempt(method: method, status: status))
            guard status == .enabled || status == .cached else {
                continue
            }
            if waitUntilUseful(method, status) {
                becameUseful = true
                break
            }
        }
        let status: AXRendererActivationStatus
        if attempts.contains(where: { $0.status == .enabled }) {
            status = .enabled
        } else if attempts.contains(where: { $0.status == .cached }) {
            status = .cached
        } else if attempts.allSatisfy({ $0.status == .unsupported }) {
            status = .unsupported
        } else {
            status = .failed
        }
        return AXRendererActivationOutcome(
            status: status,
            attempts: attempts,
            becameUseful: becameUseful
        )
    }

    static func shouldActivateRendererAccessibility(
        assessment: AccessibilityAssessment?,
        activationPreviouslyAttempted: Bool
    ) -> Bool {
        guard let assessment else {
            return true
        }
        if assessment.quality != .useful {
            return true
        }
        return assessment.contentRootFound && !activationPreviouslyAttempted
    }

    static func rendererReadinessImproved(
        initialAssessment: AccessibilityAssessment?,
        initialNodeCount: Int,
        currentAssessment: AccessibilityAssessment?,
        currentNodeCount: Int
    ) -> Bool {
        guard let currentAssessment, currentAssessment.quality == .useful else {
            return false
        }
        guard let initialAssessment, initialAssessment.quality == .useful else {
            return true
        }
        let nodeGrowth = max(32, initialNodeCount / 10)
        let semanticGrowth = max(4, initialAssessment.semanticNodeCount / 10)
        let textGrowth = max(128, initialAssessment.usefulTextCharacters / 5)
        return currentNodeCount >= initialNodeCount + nodeGrowth ||
            currentAssessment.semanticNodeCount >=
                initialAssessment.semanticNodeCount + semanticGrowth ||
            currentAssessment.usefulTextCharacters >=
                initialAssessment.usefulTextCharacters + textGrowth
    }

    static func capture(
        window: WindowMetadata,
        configuration: NativeObservationConfiguration.Accessibility
    ) -> AccessibilityCapture {
        capture(
            prepared: prepare(window: window, configuration: configuration),
            configuration: configuration
        )
    }

    static func prepare(
        window: WindowMetadata,
        configuration: NativeObservationConfiguration.Accessibility
    ) -> PreparedTarget {
        prepare(
            group: FrozenWindowGroup(
                root: window,
                memberWindowIdentifiers: []
            ),
            configuration: configuration
        )
    }

    static func prepare(
        group: FrozenWindowGroup,
        configuration: NativeObservationConfiguration.Accessibility
    ) -> PreparedTarget {
        let startedAt = Date()
        guard AXIsProcessTrusted() else {
            return PreparedTarget(
                startedAt: startedAt,
                roots: [],
                windowIdentifiers: [],
                missingWindowIdentifiers: group.windowIdentifiers,
                failureReason: .permissionDenied,
                activationStatus: nil,
                activationAttempts: [],
                activationWaitMilliseconds: 0,
                activationNodeCountBefore: nil,
                excludedText: []
            )
        }
        guard
            let rootWindowIdentifier = group.root.windowIdentifier,
            !group.windowIdentifiers.isEmpty
        else {
            return PreparedTarget(
                startedAt: startedAt,
                roots: [],
                windowIdentifiers: [],
                missingWindowIdentifiers: group.windowIdentifiers,
                failureReason: .targetMismatch,
                activationStatus: nil,
                activationAttempts: [],
                activationWaitMilliseconds: 0,
                activationNodeCountBefore: nil,
                excludedText: []
            )
        }
        let application = AXUIElementCreateApplication(
            group.root.processIdentifier
        )
        let timeout = TimeInterval(configuration.timeoutMilliseconds) / 1_000
        AXUIElementSetMessagingTimeout(application, Float(timeout))
        let excludedText = [group.root.applicationName, group.root.title]
            .compactMap { $0 }
        let identity = AXRendererProcessIdentity(
            processIdentifier: group.root.processIdentifier,
            bundleIdentifier: group.root.bundleIdentifier,
            launchTimestampMilliseconds: NSRunningApplication(
                processIdentifier: group.root.processIdentifier
            )?.launchDate.map { Int64($0.timeIntervalSince1970 * 1_000) }
        )
        func resolvedRoot() -> AXUIElement? {
            let windows = (
                attribute(application, kAXWindowsAttribute) as? [AXUIElement]
            ) ?? []
            let identifiers = windows.map(windowIdentifier(of:))
            guard let index = matchingWindowIndex(
                targetWindowIdentifier: rootWindowIdentifier,
                candidateWindowIdentifiers: identifiers
            ) else {
                return nil
            }
            return windows[index]
        }

        var activationNodeCountBefore: Int?
        let initialAssessment: AccessibilityAssessment?
        if let root = resolvedRoot() {
            let readiness = readinessAssessment(
                root: root,
                excluding: excludedText,
                configuration: configuration,
                deadline: startedAt.addingTimeInterval(timeout)
            )
            activationNodeCountBefore = readiness.nodeCount
            initialAssessment = readiness.assessment
        } else {
            initialAssessment = nil
        }

        var activationOutcome: AXRendererActivationOutcome?
        var activationWaitMilliseconds: Double = 0
        if shouldActivateRendererAccessibility(
            assessment: initialAssessment,
            activationPreviouslyAttempted:
                activationCache.hasCompletedAttempt(identity: identity)
        ) {
            let activationStartedAt = Date()
            let activationDeadline = min(
                startedAt.addingTimeInterval(timeout),
                activationStartedAt.addingTimeInterval(0.75)
            )
            activationOutcome = activateRendererAccessibility(
                identity: identity,
                cache: activationCache,
                setAttribute: { method in
                    AXUIElementSetAttributeValue(
                        application,
                        method.attributeName as CFString,
                        kCFBooleanTrue
                    )
                },
                waitUntilUseful: { method, _ in
                    let methodDeadline = min(
                        activationDeadline,
                        Date().addingTimeInterval(
                            method == .enhancedUserInterface ? 0.35 : 0.75
                        )
                    )
                    repeat {
                        if let root = resolvedRoot() {
                            let readiness = readinessAssessment(
                                root: root,
                                excluding: excludedText,
                                configuration: configuration,
                                deadline: methodDeadline
                            )
                            if activationNodeCountBefore == nil {
                                activationNodeCountBefore = readiness.nodeCount
                            }
                            if rendererReadinessImproved(
                                initialAssessment: initialAssessment,
                                initialNodeCount: activationNodeCountBefore ?? 0,
                                currentAssessment: readiness.assessment,
                                currentNodeCount: readiness.nodeCount
                            ) {
                                return true
                            }
                        }
                        if Date() < methodDeadline {
                            Thread.sleep(forTimeInterval: 0.05)
                        }
                    } while Date() < methodDeadline
                    return false
                }
            )
            activationWaitMilliseconds = elapsedMilliseconds(
                since: activationStartedAt
            )
        }

        let refreshedWindows = (
            attribute(application, kAXWindowsAttribute) as? [AXUIElement]
        ) ?? []
        let refreshedIdentifiers = refreshedWindows.map(windowIdentifier(of:))
        guard matchingWindowIndex(
            targetWindowIdentifier: rootWindowIdentifier,
            candidateWindowIdentifiers: refreshedIdentifiers
        ) != nil else {
            return PreparedTarget(
                startedAt: startedAt,
                roots: [],
                windowIdentifiers: [],
                missingWindowIdentifiers: group.windowIdentifiers,
                failureReason: refreshedWindows.isEmpty
                    ? .focusedWindowUnavailable
                    : .targetMismatch,
                activationStatus: activationOutcome?.status,
                activationAttempts: activationOutcome?.attempts ?? [],
                activationWaitMilliseconds: activationWaitMilliseconds,
                activationNodeCountBefore: activationNodeCountBefore,
                excludedText: excludedText
            )
        }
        let matchedIndices = matchingWindowIndices(
            targetWindowIdentifiers: group.windowIdentifiers,
            candidateWindowIdentifiers: refreshedIdentifiers
        )
        let matchedWindowIdentifiers = zip(
            group.windowIdentifiers,
            matchedIndices
        ).compactMap { identifier, index in
            index == nil ? nil : identifier
        }
        let missingWindowIdentifiers = zip(
            group.windowIdentifiers,
            matchedIndices
        ).compactMap { identifier, index in
            index == nil ? identifier : nil
        }
        return PreparedTarget(
            startedAt: startedAt,
            roots: matchedIndices.compactMap { index in
                index.map { refreshedWindows[$0] }
            },
            windowIdentifiers: matchedWindowIdentifiers,
            missingWindowIdentifiers: missingWindowIdentifiers,
            failureReason: nil,
            activationStatus: activationOutcome?.status,
            activationAttempts: activationOutcome?.attempts ?? [],
            activationWaitMilliseconds: activationWaitMilliseconds,
            activationNodeCountBefore: activationNodeCountBefore,
            excludedText: excludedText
        )
    }

    static func capture(
        prepared: PreparedTarget,
        configuration: NativeObservationConfiguration.Accessibility
    ) -> AccessibilityCapture {
        let startedAt = prepared.startedAt
        let timeout = TimeInterval(configuration.timeoutMilliseconds) / 1_000
        guard !prepared.roots.isEmpty else {
            let failureReason = prepared.failureReason ?? .snapshotUnavailable
            return AccessibilityCapture(
                status: failureReason == .permissionDenied
                    ? .permissionDenied
                    : .failed,
                quality: .unavailable,
                durationMilliseconds: elapsedMilliseconds(since: startedAt),
                snapshot: nil,
                failureReason: failureReason,
                activation: prepared.activationStatus.map {
                    AccessibilityActivation(
                        status: $0,
                        attempts: prepared.activationAttempts,
                        waitMilliseconds: prepared.activationWaitMilliseconds,
                        nodeCountBefore: prepared.activationNodeCountBefore,
                        nodeCountAfter: nil
                    )
                },
                windowIdentifiers: prepared.windowIdentifiers,
                missingWindowIdentifiers: prepared.missingWindowIdentifiers,
                completedAt: iso8601Timestamp()
            )
        }
        var budget = Budget(
            maxDepth: configuration.maxDepth,
            maxNodes: configuration.maxNodes,
            deadline: startedAt.addingTimeInterval(timeout)
        )
        var visited = Set<CFHashCode>()
        var nodes = [AccessibilityNode]()
        for root in prepared.roots {
            if let node = snapshot(
                element: root,
                depth: 0,
                budget: &budget,
                visited: &visited,
                maximumTextLength: configuration.maxTextLength
            ) {
                nodes.append(node)
            }
            if budget.timedOut {
                break
            }
        }
        guard !nodes.isEmpty else {
            return AccessibilityCapture(
                status: budget.timedOut ? .timedOut : .failed,
                quality: budget.nodeCount == 0 ? .empty : .unavailable,
                durationMilliseconds: elapsedMilliseconds(since: startedAt),
                snapshot: nil,
                failureReason: budget.timedOut
                    ? .traversalTimedOut
                    : .snapshotUnavailable,
                activation: prepared.activationStatus.map {
                    AccessibilityActivation(
                        status: $0,
                        attempts: prepared.activationAttempts,
                        waitMilliseconds: prepared.activationWaitMilliseconds,
                        nodeCountBefore: prepared.activationNodeCountBefore,
                        nodeCountAfter: nil
                    )
                },
                windowIdentifiers: prepared.windowIdentifiers,
                missingWindowIdentifiers: prepared.missingWindowIdentifiers,
                completedAt: iso8601Timestamp()
            )
        }
        let isPartial = !prepared.missingWindowIdentifiers.isEmpty
        let root = groupedRoot(nodes)
        let assessment = assess(root, excluding: prepared.excludedText)
        return AccessibilityCapture(
            status: budget.timedOut
                ? (assessment.quality == .useful ? .partial : .timedOut)
                : (isPartial ? .partial : .complete),
            quality: assessment.quality,
            durationMilliseconds: elapsedMilliseconds(since: startedAt),
            snapshot: AccessibilitySnapshot(
                root: root,
                nodeCount: budget.nodeCount,
                truncated: budget.truncated
            ),
            failureReason: budget.timedOut
                ? .traversalTimedOut
                : (isPartial ? .targetMismatch : nil),
            activation: prepared.activationStatus.map {
                AccessibilityActivation(
                    status: $0,
                    attempts: prepared.activationAttempts,
                    waitMilliseconds: prepared.activationWaitMilliseconds,
                    nodeCountBefore: prepared.activationNodeCountBefore,
                    nodeCountAfter: budget.nodeCount
                )
            },
            windowIdentifiers: prepared.windowIdentifiers,
            missingWindowIdentifiers: prepared.missingWindowIdentifiers,
            contentRootFound: assessment.contentRootFound,
            semanticNodeCount: assessment.semanticNodeCount,
            usefulTextCharacters: assessment.usefulTextCharacters,
            completedAt: iso8601Timestamp()
        )
    }

    static func groupedRoot(
        _ nodes: [AccessibilityNode]
    ) -> AccessibilityNode {
        guard nodes.count != 1 else {
            return nodes[0]
        }
        return AccessibilityNode(
            role: "AXApplication",
            subrole: nil,
            title: nil,
            value: nil,
            identifier: nil,
            elementDescription: nil,
            frame: nil,
            focused: nil,
            enabled: true,
            selected: nil,
            children: nodes
        )
    }

    private static func readinessAssessment(
        root: AXUIElement,
        excluding excludedText: [String],
        configuration: NativeObservationConfiguration.Accessibility,
        deadline: Date
    ) -> (assessment: AccessibilityAssessment?, nodeCount: Int) {
        var budget = Budget(
            maxDepth: min(configuration.maxDepth, 12),
            maxNodes: min(configuration.maxNodes, 256),
            deadline: deadline
        )
        var visited = Set<CFHashCode>()
        let candidate = snapshot(
            element: root,
            depth: 0,
            budget: &budget,
            visited: &visited,
            maximumTextLength: min(configuration.maxTextLength, 2_048)
        )
        return (
            candidate.map { assess($0, excluding: excludedText) },
            budget.nodeCount
        )
    }

    private static func snapshot(
        element: AXUIElement,
        depth: Int,
        budget: inout Budget,
        visited: inout Set<CFHashCode>,
        maximumTextLength: Int
    ) -> AccessibilityNode? {
        guard budget.consume(depth: depth) else {
            return nil
        }
        let identity = CFHash(element)
        guard visited.insert(identity).inserted else {
            return nil
        }

        let attributes = nodeAttributes(of: element)
        let role = stringAttribute(
            attributes,
            kAXRoleAttribute,
            maximumTextLength: maximumTextLength
        ) ?? "AXUnknown"
        let subrole = stringAttribute(
            attributes,
            kAXSubroleAttribute,
            maximumTextLength: maximumTextLength
        )
        let rawValue = textAttribute(
            attributes,
            kAXValueAttribute,
            maximumTextLength: maximumTextLength
        )
        let value = sanitize(rawValue, role: role, subrole: subrole)
        var childNodes = [AccessibilityNode]()
        for child in children(from: attributes) {
            if let childNode = snapshot(
                element: child,
                depth: depth + 1,
                budget: &budget,
                visited: &visited,
                maximumTextLength: maximumTextLength
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
            title: stringAttribute(
                attributes,
                kAXTitleAttribute,
                maximumTextLength: maximumTextLength
            ),
            value: value,
            identifier: stringAttribute(
                attributes,
                kAXIdentifierAttribute,
                maximumTextLength: maximumTextLength
            ),
            elementDescription: stringAttribute(
                attributes,
                kAXDescriptionAttribute,
                maximumTextLength: maximumTextLength
            ),
            frame: frame(from: attributes),
            focused: boolAttribute(attributes, kAXFocusedAttribute),
            enabled: boolAttribute(attributes, kAXEnabledAttribute),
            selected: boolAttribute(attributes, kAXSelectedAttribute),
            children: childNodes.isEmpty ? nil : childNodes
        )
    }

    static func matchingWindowIndex(
        targetWindowIdentifier: CGWindowID,
        candidateWindowIdentifiers: [CGWindowID?]
    ) -> Int? {
        let matches = candidateWindowIdentifiers.indices.filter {
            candidateWindowIdentifiers[$0] == targetWindowIdentifier
        }
        return matches.count == 1 ? matches[0] : nil
    }

    static func matchingWindowIndices(
        targetWindowIdentifiers: [CGWindowID],
        candidateWindowIdentifiers: [CGWindowID?]
    ) -> [Int?] {
        targetWindowIdentifiers.map { targetWindowIdentifier in
            matchingWindowIndex(
                targetWindowIdentifier: targetWindowIdentifier,
                candidateWindowIdentifiers: candidateWindowIdentifiers
            )
        }
    }

    static func hasUsefulContent(
        _ node: AccessibilityNode,
        excluding excludedText: [String]
    ) -> Bool {
        if node.role == "AXWebArea" || node.role == "AXDocument" {
            return true
        }
        let excluded = Set(excludedText.compactMap(normalizedKey))
        let values = [node.title, node.value, node.elementDescription]
        if values.contains(where: { value in
            guard let key = normalizedKey(value) else {
                return false
            }
            return !excluded.contains(key)
        }), node.role != "AXWindow", node.role != "AXGroup" {
            return true
        }
        return (node.children ?? []).contains {
            hasUsefulContent($0, excluding: excludedText)
        }
    }

    static func assess(
        _ node: AccessibilityNode,
        excluding excludedText: [String]
    ) -> AccessibilityAssessment {
        let excluded = Set(excludedText.compactMap(normalizedKey))
        let shellRoles: Set<String> = [
            "AXMenuBar", "AXMenu", "AXMenuItem", "AXToolbar",
            "AXStatusBar", "AXScrollBar", "AXSplitter",
        ]
        let semanticRoles: Set<String> = [
            "AXButton", "AXCheckBox", "AXComboBox", "AXDocument",
            "AXLink", "AXListBox", "AXMenuButton", "AXPopUpButton",
            "AXRadioButton", "AXSlider", "AXTab", "AXTextArea",
            "AXTextField", "AXToggle", "AXWebArea",
        ]
        let textRoles: Set<String> = [
            "AXCell", "AXDocument", "AXHeading", "AXLink", "AXListBox",
            "AXRow", "AXStaticText", "AXTextArea", "AXTextField", "AXWebArea",
        ]
        var contentRootFound = false
        var semanticNodeCount = 0
        var usefulTextCharacters = 0
        var nodeCount = 0
        var focusedSemanticElement = false

        func visit(_ candidate: AccessibilityNode, insideShell: Bool) {
            nodeCount += 1
            let isShell = insideShell || shellRoles.contains(candidate.role)
            if candidate.role == "AXWebArea" || candidate.role == "AXDocument" {
                contentRootFound = true
            }
            if semanticRoles.contains(candidate.role), !isShell {
                semanticNodeCount += 1
                if candidate.focused == true {
                    focusedSemanticElement = true
                }
            }
            if !isShell && textRoles.contains(candidate.role) {
                for value in [candidate.title, candidate.value, candidate.elementDescription] {
                    guard
                        let normalized = normalizedKey(value),
                        !excluded.contains(normalized)
                    else {
                        continue
                    }
                    usefulTextCharacters += value?.count ?? 0
                }
            }
            for child in candidate.children ?? [] {
                visit(child, insideShell: isShell)
            }
        }
        visit(node, insideShell: false)

        let quality: AccessibilityQuality
        if contentRootFound || usefulTextCharacters > 0 || focusedSemanticElement ||
            semanticNodeCount >= 2
        {
            quality = .useful
        } else if nodeCount <= 1 && node.role == "AXUnknown" {
            quality = .empty
        } else {
            quality = .shellOnly
        }
        return AccessibilityAssessment(
            quality: quality,
            contentRootFound: contentRootFound,
            semanticNodeCount: semanticNodeCount,
            usefulTextCharacters: usefulTextCharacters
        )
    }

    private static func windowIdentifier(of element: AXUIElement) -> CGWindowID? {
        var identifier = CGWindowID.zero
        guard copyCGWindowIdentifier(element, &identifier) == .success else {
            return nil
        }
        return identifier
    }

    private static func children(
        from attributes: [String: Any]
    ) -> [AXUIElement] {
        if let visible = attributes[kAXVisibleChildrenAttribute] as? [AXUIElement] {
            return visible
        }
        return attributes[kAXChildrenAttribute] as? [AXUIElement] ?? []
    }

    private static func stringAttribute(
        _ attributes: [String: Any],
        _ name: String,
        maximumTextLength: Int
    ) -> String? {
        guard let value = attributes[name] as? String else {
            return nil
        }
        return normalize(
            truncate(value, maximumTextLength: maximumTextLength)
        )
    }

    private static func stringAttribute(
        _ element: AXUIElement,
        _ name: String,
        maximumTextLength: Int
    ) -> String? {
        guard let value = attribute(element, name) as? String else {
            return nil
        }
        return normalize(
            truncate(value, maximumTextLength: maximumTextLength)
        )
    }

    private static func textAttribute(
        _ attributes: [String: Any],
        _ name: String,
        maximumTextLength: Int
    ) -> String? {
        guard let value = attributes[name] else {
            return nil
        }
        if let text = value as? String {
            return normalize(
                truncate(text, maximumTextLength: maximumTextLength)
            )
        }
        if let number = value as? NSNumber {
            return number.stringValue
        }
        return nil
    }

    private static func boolAttribute(
        _ attributes: [String: Any],
        _ name: String
    ) -> Bool? {
        if let value = attributes[name] as? Bool {
            return value
        }
        return (attributes[name] as? NSNumber)?.boolValue
    }

    private static func frame(
        from attributes: [String: Any]
    ) -> WindowFrame? {
        guard
            let positionValue = attributes[kAXPositionAttribute],
            let sizeValue = attributes[kAXSizeAttribute]
        else {
            return nil
        }
        guard
            CFGetTypeID(positionValue as AnyObject) == AXValueGetTypeID(),
            CFGetTypeID(sizeValue as AnyObject) == AXValueGetTypeID()
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

    private static func nodeAttributes(
        of element: AXUIElement
    ) -> [String: Any] {
        var rawValues: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(
            element,
            nodeAttributeNames as CFArray,
            AXCopyMultipleAttributeOptions(rawValue: 0),
            &rawValues
        )
        if error == .success, let rawValues {
            let values = (rawValues as NSArray).map { $0 }
            if let mapped = mapBatchValues(
                names: nodeAttributeNames,
                values: values
            ) {
                return mapped
            }
        }
        return Dictionary(uniqueKeysWithValues: nodeAttributeNames.compactMap {
            name in
            attribute(element, name).map { (name, $0) }
        })
    }

    static func mapBatchValues(
        names: [String],
        values: [Any]
    ) -> [String: Any]? {
        guard names.count == values.count else {
            return nil
        }
        return Dictionary(uniqueKeysWithValues: zip(names, values))
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

    private static func truncate(
        _ value: String,
        maximumTextLength: Int
    ) -> String {
        guard value.count > maximumTextLength else {
            return value
        }
        return String(value.prefix(maximumTextLength))
    }

    static func sanitize(
        _ value: String?,
        role: String?,
        subrole: String?
    ) -> String? {
        guard let value = normalize(value) else {
            return nil
        }
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            return "[REDACTED]"
        }
        return value
    }

    static func normalize(_ value: String?) -> String? {
        guard
            let value,
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return value
    }

    private static func normalizedKey(_ value: String?) -> String? {
        normalize(value)?.folding(
            options: [.caseInsensitive, .diacriticInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        )
    }
}

struct AXRendererProcessIdentity: Hashable, Sendable {
    let processIdentifier: pid_t
    let bundleIdentifier: String?
    let launchTimestampMilliseconds: Int64?
}

final class AXRendererAccessibilityActivationCache: @unchecked Sendable {
    private struct Key: Hashable {
        let identity: AXRendererProcessIdentity
        let method: AXRendererActivationMethod
    }

    private let lock = NSLock()
    private var resolved = [Key: AXRendererActivationStatus]()

    func hasCompletedAttempt(identity: AXRendererProcessIdentity) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let statuses = AXRendererActivationMethod.allCases.compactMap {
            resolved[Key(identity: identity, method: $0)]
        }
        return statuses.contains(.enabled) ||
            statuses.count == AXRendererActivationMethod.allCases.count
    }

    func activate(
        identity: AXRendererProcessIdentity,
        method: AXRendererActivationMethod,
        using setAccessibilityAttribute: () -> AXError
    ) -> AXRendererActivationStatus {
        lock.lock()
        defer { lock.unlock() }
        let key = Key(identity: identity, method: method)
        if let status = resolved[key] {
            return status == .enabled ? .cached : status
        }
        switch setAccessibilityAttribute() {
        case .success:
            resolved[key] = .enabled
            return .enabled
        case .attributeUnsupported:
            resolved[key] = .unsupported
            return .unsupported
        default:
            return .failed
        }
    }
}

private func elapsedMilliseconds(since date: Date) -> Double {
    Date().timeIntervalSince(date) * 1_000
}
