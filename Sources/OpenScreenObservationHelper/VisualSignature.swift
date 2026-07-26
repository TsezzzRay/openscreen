import CoreGraphics
import CoreVideo
import Foundation

enum VisualSignature {
    static let width = 32
    static let height = 18

    static func make(
        bgraBytes: [UInt8],
        width: Int,
        height: Int,
        bytesPerRow: Int,
        outputWidth: Int = width,
        outputHeight: Int = height
    ) -> [UInt8] {
        guard
            width > 0,
            height > 0,
            outputWidth > 0,
            outputHeight > 0,
            bgraBytes.count >= bytesPerRow * height
        else {
            return []
        }
        var output = [UInt8]()
        output.reserveCapacity(outputWidth * outputHeight)
        for outputY in 0..<outputHeight {
            let sourceY = min(height - 1, outputY * height / outputHeight)
            for outputX in 0..<outputWidth {
                let sourceX = min(width - 1, outputX * width / outputWidth)
                let index = sourceY * bytesPerRow + sourceX * 4
                let blue = Double(bgraBytes[index])
                let green = Double(bgraBytes[index + 1])
                let red = Double(bgraBytes[index + 2])
                output.append(
                    UInt8(clamping: Int((0.114 * blue + 0.587 * green + 0.299 * red).rounded()))
                )
            }
        }
        return output
    }

    static func make(from image: CGImage) -> [UInt8] {
        let bytesPerRow = width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        guard let context = CGContext(
            data: &bytes,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            return []
        }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return make(
            bgraBytes: bytes,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow
        )
    }

    static func make(from pixelBuffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer {
            CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
        }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return []
        }
        let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
        let sourceBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let byteCount = sourceBytesPerRow * sourceHeight
        let bytes = Array(
            UnsafeBufferPointer(
                start: baseAddress.assumingMemoryBound(to: UInt8.self),
                count: byteCount
            )
        )
        return make(
            bgraBytes: bytes,
            width: sourceWidth,
            height: sourceHeight,
            bytesPerRow: sourceBytesPerRow,
            outputWidth: width,
            outputHeight: height
        )
    }

    static func distance(_ left: [UInt8], _ right: [UInt8]) -> Double {
        guard left.count == right.count, !left.isEmpty else {
            return left.isEmpty && right.isEmpty ? 0 : 1
        }
        let difference = zip(left, right).reduce(0) { partial, pixels in
            partial + abs(Int(pixels.0) - Int(pixels.1))
        }
        return Double(difference) / Double(left.count * 255)
    }
}
