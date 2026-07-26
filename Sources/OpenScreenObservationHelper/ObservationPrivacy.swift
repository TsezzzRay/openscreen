import Foundation

struct SelfCaptureFilter: Sendable {
    private let processIdentifiers: Set<pid_t>
    private let bundleIdentifiers: Set<String>

    init(processIdentifiers: Set<pid_t>, bundleIdentifiers: Set<String>) {
        self.processIdentifiers = processIdentifiers
        self.bundleIdentifiers = Set(bundleIdentifiers.map { $0.lowercased() })
    }

    func contains(processIdentifier: pid_t, bundleIdentifier: String?) -> Bool {
        if processIdentifiers.contains(processIdentifier) {
            return true
        }
        guard let bundleIdentifier else {
            return false
        }
        return bundleIdentifiers.contains(bundleIdentifier.lowercased())
    }
}

func sanitizeAccessibilityValue(
    _ value: String?,
    role: String?,
    subrole: String?
) -> String? {
    guard let value = normalizeAccessibilityText(value) else {
        return nil
    }
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
        return "[REDACTED]"
    }
    return value
}

func normalizeAccessibilityText(_ value: String?) -> String? {
    guard
        let value,
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
        return nil
    }
    return value
}
