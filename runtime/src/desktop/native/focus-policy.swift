import ApplicationServices

enum FocusError: String, Error, CustomStringConvertible {
    case invalid = "invalid-request"
    case changed = "focus-changed"
    case unverifiable = "focus-unverifiable"
    case foreground = "foreground-changed"
    case windowChanged = "focus-window-changed"
    case targetChanged = "focus-target-changed"
    case valueChanged = "focus-value-changed"
    var description: String { rawValue }
}

struct FocusDiagnostic: Error, CustomStringConvertible {
    let step: String
    let status: AXError
    var description: String { "\(FocusError.unverifiable) [step=\(step), axStatus=\(status.rawValue)]" }
}

func verifiedForegroundPid(_ pid: pid_t?) throws -> pid_t {
    guard let pid, pid > 0 else { throw FocusError.unverifiable }
    return pid
}

func focusAttributeSettable(_ status: AXError, _ settable: Bool) throws -> Bool {
    if status == .attributeUnsupported || status == .notImplemented { return false }
    guard status == .success else { throw FocusDiagnostic(step: "query-settable", status: status) }
    return settable
}

func focusAssignmentConfirmed(_ status: AXError, _ isFocused: Bool, _ sameForeground: Bool) throws -> Bool {
    guard sameForeground else { throw FocusError.foreground }
    if status == .attributeUnsupported || status == .notImplemented { return false }
    guard status == .success else { throw FocusDiagnostic(step: "set-focused", status: status) }
    return isFocused
}

func verifyNativeInputBaseline(_ expected: String?, _ current: String?) throws {
    guard let expected, let current, expected == current else { throw FocusError.valueChanged }
}
