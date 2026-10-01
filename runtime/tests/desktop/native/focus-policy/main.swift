import ApplicationServices
import Foundation

func outcome(_ action: () throws -> Bool) -> String {
    do { return try action() ? "supported" : "unsupported" }
    catch { return String(describing: error) }
}

let cases: [String: String] = [
    "settable": outcome { try focusAttributeSettable(.success, true) },
    "unsettable": outcome { try focusAttributeSettable(.success, false) },
    "missingAttribute": outcome { try focusAttributeSettable(.attributeUnsupported, false) },
    "notImplemented": outcome { try focusAttributeSettable(.notImplemented, false) },
    "queryFailure": outcome { try focusAttributeSettable(.cannotComplete, false) },
    "assignmentUnsupported": outcome { try focusAssignmentConfirmed(.attributeUnsupported, false, true) },
    "assignmentFailure": outcome { try focusAssignmentConfirmed(.cannotComplete, false, true) },
    "noActualFocus": outcome { try focusAssignmentConfirmed(.success, false, true) },
    "foregroundChanged": outcome { try focusAssignmentConfirmed(.success, true, false) },
    "assigned": outcome { try focusAssignmentConfirmed(.success, true, true) },
    "foregroundMissing": outcome { _ = try verifiedForegroundPid(nil); return true },
    "foregroundZero": outcome { _ = try verifiedForegroundPid(0); return true },
    "foregroundKnown": outcome { try verifiedForegroundPid(123) == 123 },
    "nativeValueChanged": outcome { try verifyNativeInputBaseline("", "changed"); return true },
    "nativeValueUnavailable": outcome { try verifyNativeInputBaseline("", nil); return true },
    "nativeValueUnchanged": outcome { try verifyNativeInputBaseline("", ""); return true },
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: cases, options: [.sortedKeys]))
