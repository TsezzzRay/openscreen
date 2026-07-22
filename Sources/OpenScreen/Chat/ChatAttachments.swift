import AppKit
import Foundation

enum ChatImageSource: String, Codable, Sendable {
    case systemCapture = "system_capture"
    case userUpload = "user_upload"
}

struct ChatImageAttachment: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let source: ChatImageSource
    let path: String

    var url: URL { URL(fileURLWithPath: path) }
}

enum ChatAttachmentError: LocalizedError {
    case invalidImage
    case pngEncodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidImage: "That file isn't a supported image."
        case .pngEncodingFailed: "Couldn't prepare that image."
        }
    }
}

actor ChatAttachmentStore {
    private let directory: URL?

    init(directory: URL? = nil) {
        self.directory = directory
    }

    func importImages(at urls: [URL]) throws -> [ChatImageAttachment] {
        var attachments: [ChatImageAttachment] = []
        do {
            for url in urls {
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                attachments.append(try importImage(Data(contentsOf: url)))
            }
            return attachments
        } catch {
            attachments.forEach(remove)
            throw error
        }
    }

    func importImages(_ imageData: [Data]) throws -> [ChatImageAttachment] {
        var attachments: [ChatImageAttachment] = []
        do {
            for data in imageData {
                attachments.append(try importImage(data))
            }
            return attachments
        } catch {
            attachments.forEach(remove)
            throw error
        }
    }

    func remove(_ attachment: ChatImageAttachment) {
        guard attachment.source == .userUpload else { return }
        try? FileManager.default.removeItem(at: attachment.url)
    }

    private func importImage(_ data: Data) throws -> ChatImageAttachment {
        guard let bitmap = NSBitmapImageRep(data: data) else {
            throw ChatAttachmentError.invalidImage
        }
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw ChatAttachmentError.pngEncodingFailed
        }
        let destination = try attachmentDirectory()
            .appendingPathComponent("\(UUID().uuidString).png")
        try png.write(to: destination, options: .atomic)
        return ChatImageAttachment(
            id: UUID().uuidString,
            source: .userUpload,
            path: destination.path
        )
    }

    private func attachmentDirectory() throws -> URL {
        let destination: URL
        if let directory {
            destination = directory
        } else {
            destination = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            .appendingPathComponent("OpenScreen", isDirectory: true)
            .appendingPathComponent("user-attachments", isDirectory: true)
        }
        try FileManager.default.createDirectory(
            at: destination,
            withIntermediateDirectories: true
        )
        return destination
    }
}
