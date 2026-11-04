import Compression
import Foundation
import PixerateCore

/// Reads the PNGs the recorder writes (8-bit RGBA or RGB, any filters, not interlaced) as straight
/// RGBA. ImageIO would hand back premultiplied pixels, which loses the exact values the snapshots
/// compare.
public func decodeConformancePNG(_ data: Data) throws -> ConformanceImage {
    let bytes = [UInt8](data)
    let signature: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
    guard bytes.count > 8, Array(bytes[0..<8]) == signature else { throw ContractError("Not a PNG image.") }
    var offset = 8
    var width = 0, height = 0, colorType = 0
    var idat: [UInt8] = []
    func be32(_ at: Int) -> Int { Int(bytes[at]) << 24 | Int(bytes[at + 1]) << 16 | Int(bytes[at + 2]) << 8 | Int(bytes[at + 3]) }
    while offset + 8 <= bytes.count {
        let length = be32(offset)
        let type = String(bytes: bytes[offset + 4..<offset + 8], encoding: .ascii) ?? ""
        let body = offset + 8
        guard body + length + 4 <= bytes.count else { throw ContractError("PNG chunk \(type) is cut short.") }
        switch type {
        case "IHDR":
            width = be32(body)
            height = be32(body + 4)
            guard bytes[body + 8] == 8 else { throw ContractError("Only 8-bit PNGs are supported.") }
            colorType = Int(bytes[body + 9])
            guard colorType == 6 || colorType == 2 else { throw ContractError("Only RGB and RGBA PNGs are supported.") }
            guard bytes[body + 12] == 0 else { throw ContractError("Interlaced PNGs are not supported.") }
        case "IDAT":
            idat.append(contentsOf: bytes[body..<body + length])
        default:
            break
        }
        offset = body + length + 4
        if type == "IEND" { break }
    }
    guard width > 0, height > 0, idat.count > 6 else { throw ContractError("The PNG has no image data.") }
    let channels = colorType == 6 ? 4 : 3
    let stride = width * channels
    let raw = try inflate(Array(idat[2..<(idat.count - 4)]), expected: (stride + 1) * height)
    var out = [UInt8](repeating: 255, count: width * height * 4)
    var previous = [UInt8](repeating: 0, count: stride)
    var line = [UInt8](repeating: 0, count: stride)
    for y in 0..<height {
        let start = y * (stride + 1)
        let filter = raw[start]
        for x in 0..<stride {
            let value = raw[start + 1 + x]
            let a = x >= channels ? Int(line[x - channels]) : 0
            let b = Int(previous[x])
            let c = x >= channels ? Int(previous[x - channels]) : 0
            let predicted: Int
            switch filter {
            case 0: predicted = 0
            case 1: predicted = a
            case 2: predicted = b
            case 3: predicted = (a + b) / 2
            case 4:
                let p = a + b - c
                let pa = abs(p - a), pb = abs(p - b), pc = abs(p - c)
                predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
            default: throw ContractError("PNG filter \(filter) is not valid.")
            }
            line[x] = UInt8(truncatingIfNeeded: Int(value) + predicted)
        }
        for x in 0..<width {
            for ch in 0..<channels { out[(y * width + x) * 4 + ch] = line[x * channels + ch] }
        }
        swap(&previous, &line)
    }
    return ConformanceImage(width: width, height: height, data: out)
}

/// Raw DEFLATE data (the zlib wrapper removed) inflated to exactly `expected` bytes.
private func inflate(_ input: [UInt8], expected: Int) throws -> [UInt8] {
    var output = [UInt8](repeating: 0, count: expected + 1)
    let written = input.withUnsafeBufferPointer { src in
        output.withUnsafeMutableBufferPointer { dst in
            compression_decode_buffer(dst.baseAddress!, dst.count, src.baseAddress!, src.count, nil, COMPRESSION_ZLIB)
        }
    }
    guard written == expected else { throw ContractError("The PNG's image data inflates to \(written) bytes, not \(expected).") }
    return Array(output[0..<expected])
}
