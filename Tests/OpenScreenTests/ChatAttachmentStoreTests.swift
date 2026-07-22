import AppKit
import XCTest
@testable import OpenScreen

@MainActor
final class ChatAttachmentStoreTests: XCTestCase {
    func testImportsMultipleImagesAsManagedPNGFiles() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let sourceDirectory = root.appendingPathComponent("source", isDirectory: true)
        let destination = root.appendingPathComponent("managed", isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        let sources = try ["one", "two"].map { name in
            let url = sourceDirectory.appendingPathComponent("\(name).png")
            let image = NSImage(size: NSSize(width: 20, height: 20))
            image.lockFocus()
            NSColor.systemBlue.setFill()
            NSRect(x: 0, y: 0, width: 20, height: 20).fill()
            image.unlockFocus()
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url)
            return url
        }

        let store = ChatAttachmentStore(directory: destination)
        requireActor(store)
        let attachments = try await store.importImages(at: sources)

        XCTAssertEqual(attachments.count, 2)
        XCTAssertTrue(attachments.allSatisfy { $0.source == .userUpload })
        XCTAssertTrue(attachments.allSatisfy { $0.url.pathExtension == "png" })
        XCTAssertTrue(attachments.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
    }

    private func requireActor<T: Actor>(_ actor: T) {}
}
