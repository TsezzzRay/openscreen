import AppKit
import Foundation

func emit(_ kind: String, _ pid: pid_t?) {
    let value: Any = pid.map { Int($0) } ?? NSNull()
    let data = try! JSONSerialization.data(withJSONObject: ["kind": kind, "pid": value])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// Observe before reading the baseline so intervening activations are not lost.
let workspace = NSWorkspace.shared
let observer = workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main
) { notification in
    let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    emit("activated", application?.processIdentifier)
}
emit("initial", workspace.frontmostApplication?.processIdentifier)
RunLoop.main.run()
withExtendedLifetime(observer) {}
