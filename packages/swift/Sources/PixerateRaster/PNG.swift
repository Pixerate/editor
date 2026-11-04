import Foundation

/**
 * Dependency-free, synchronous PNG encode / decode for layer pixels and masks, plus base64 and
 * data-URL helpers. The port of `raster/png.ts`: `encodePng` writes the same bytes as the TS one.
 *
 * Encodes 8-bit greyscale (masks) or RGBA (layers). Decodes non-interlaced 1/2/4/8/16-bit
 * greyscale, RGB, palette, grey + alpha and RGBA, always to 8-bit RGBA or grey.
 */

private let SIGNATURE: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]

private let crcTable: [UInt32] = (0..<256).map { n in
    var c = UInt32(n)
    for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
}

private func crc32(_ bytes: [UInt8], _ start: Int, _ end: Int) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for i in start..<end { c = crcTable[Int((c ^ UInt32(bytes[i])) & 255)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
}

public struct DecodedPng: Equatable {
    public var width: Int
    public var height: Int
    /// 4 for RGBA output, 1 for greyscale without alpha when `keepGray` was asked for.
    public var channels: Int
    public var data: [UInt8]
}

public struct PngError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

@inline(__always) private func paeth(_ a: Int, _ b: Int, _ c: Int) -> Int {
    let p = a + b - c
    let pa = Swift.abs(p - a)
    let pb = Swift.abs(p - b)
    let pc = Swift.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/// PNG bytes for `width × height` pixels of 1 (grey) or 4 (RGBA) bytes each.
public func encodePng(_ width: Int, _ height: Int, _ data: [UInt8], _ channels: Int = 4) -> [UInt8] {
    let stride = width * channels
    var raw = [UInt8](repeating: 0, count: (stride + 1) * height)
    let bpp = channels
    var cand = [[UInt8]](repeating: [UInt8](repeating: 0, count: stride), count: 5)
    for y in 0..<height {
        let row = y * stride
        let prevRow = (y - 1) * stride
        // Try each filter and keep the one with the smallest sum of signed residues.
        var best = 0
        var bestScore = Int.max
        for f in 0..<5 {
            var score = 0
            for x in 0..<stride {
                let v = Int(data[row + x])
                let a = x >= bpp ? Int(data[row + x - bpp]) : 0
                let b = y > 0 ? Int(data[prevRow + x]) : 0
                let c = x >= bpp && y > 0 ? Int(data[prevRow + x - bpp]) : 0
                var r: Int
                switch f {
                case 0: r = v
                case 1: r = v - a
                case 2: r = v - b
                case 3: r = v - ((a + b) >> 1)
                default: r = v - paeth(a, b, c)
                }
                r &= 255
                cand[f][x] = UInt8(r)
                score += r < 128 ? r : 256 - r
                if score >= bestScore { break }
            }
            if score < bestScore {
                bestScore = score
                best = f
            }
        }
        let o = y * (stride + 1)
        raw[o] = UInt8(best)
        // Only a filter whose scoring loop ran to the end can win, so its row is complete.
        for x in 0..<stride { raw[o + 1 + x] = cand[best][x] }
    }
    let idat = deflate(raw)
    var ihdr = [UInt8](repeating: 0, count: 13)
    writeU32(&ihdr, 0, UInt32(width))
    writeU32(&ihdr, 4, UInt32(height))
    ihdr[8] = 8
    ihdr[9] = channels == 1 ? 0 : 6
    let chunks: [(String, [UInt8])] = [("IHDR", ihdr), ("IDAT", idat), ("IEND", [])]
    var out = SIGNATURE
    for (type, d) in chunks {
        let p = out.count
        out += [0, 0, 0, 0]
        writeU32(&out, p, UInt32(d.count))
        out += Array(type.utf8)
        out += d
        let crc = crc32(out, p + 4, p + 8 + d.count)
        out += [0, 0, 0, 0]
        writeU32(&out, p + 8 + d.count, crc)
    }
    return out
}

private func writeU32(_ b: inout [UInt8], _ o: Int, _ v: UInt32) {
    b[o] = UInt8(v >> 24)
    b[o + 1] = UInt8((v >> 16) & 255)
    b[o + 2] = UInt8((v >> 8) & 255)
    b[o + 3] = UInt8(v & 255)
}

private func readU32(_ b: ArraySlice<UInt8>, _ o: Int) -> Int {
    let s = b.startIndex + o
    let at = { (i: Int) -> UInt32 in i < b.endIndex ? UInt32(b[i]) : 0 }
    return Int((at(s) << 24) | (at(s + 1) << 16) | (at(s + 2) << 8) | at(s + 3))
}

public func isPng(_ bytes: [UInt8]) -> Bool {
    bytes.count > 8 && SIGNATURE.enumerated().allSatisfy { bytes[$0.offset] == $0.element }
}

/**
 * Decodes a PNG. Output is RGBA (4 channels) unless `keepGray` is set and the image is
 * greyscale without alpha, in which case it is one byte per pixel.
 */
public func decodePng(_ bytes: [UInt8], keepGray: Bool = false, maxPixels: Int? = nil) throws -> DecodedPng {
    if !isPng(bytes) { throw PngError("Not a PNG image.") }
    var p = 8
    var width = 0, height = 0, depth = 0, type = 0, interlace = 0
    var palette: ArraySlice<UInt8>? = nil
    var trns: ArraySlice<UInt8>? = nil
    var idat: [ArraySlice<UInt8>] = []
    let all = bytes[...]
    while p + 8 <= bytes.count {
        let len = readU32(all, p)
        let t = String(decoding: bytes[(p + 4)..<(p + 8)], as: UTF8.self)
        let body = bytes[Swift.min(bytes.count, p + 8)..<Swift.min(bytes.count, p + 8 + len)]
        if p + 12 + len > bytes.count { throw PngError("Truncated PNG.") }
        if t == "IHDR" {
            width = readU32(body, 0)
            height = readU32(body, 4)
            let at = { (i: Int) -> Int in body.startIndex + i < body.endIndex ? Int(body[body.startIndex + i]) : 0 }
            depth = at(8)
            type = at(9)
            interlace = at(12)
        } else if t == "PLTE" {
            palette = body
        } else if t == "tRNS" {
            trns = body
        } else if t == "IDAT" {
            idat.append(body)
        } else if t == "IEND" {
            break
        }
        p += 12 + len
    }
    if width == 0 || height == 0 { throw PngError("PNG has no image header.") }
    if interlace != 0 { throw PngError("Interlaced PNGs are not supported here; decode them with a canvas.") }
    let maxPx = maxPixels ?? 1 << 28
    if width * height > maxPx { throw PngError("PNG is too large (\(width)×\(height)).") }
    let samples = type == 0 ? 1 : type == 2 ? 3 : type == 3 ? 1 : type == 4 ? 2 : type == 6 ? 4 : 0
    if samples == 0 || ![1, 2, 4, 8, 16].contains(depth) { throw PngError("Unsupported PNG format (type \(type), depth \(depth)).") }
    var z: [UInt8] = []
    for c in idat { z += c }
    let bitsPerPixel = samples * depth
    let stride = (width * bitsPerPixel + 7) / 8
    let raw = try inflate(z, maxOutput: (stride + 1) * height, sizeHint: (stride + 1) * height)
    if raw.count < (stride + 1) * height { throw PngError("PNG image data is truncated.") }
    let bpp = Swift.max(1, bitsPerPixel >> 3)
    var lines = [UInt8](repeating: 0, count: stride * height)
    for y in 0..<height {
        let f = raw[y * (stride + 1)]
        let src = y * (stride + 1) + 1
        let dst = y * stride
        let up = dst - stride
        for x in 0..<stride {
            let v = Int(raw[src + x])
            let a = x >= bpp ? Int(lines[dst + x - bpp]) : 0
            let b = y > 0 ? Int(lines[up + x]) : 0
            let c = x >= bpp && y > 0 ? Int(lines[up + x - bpp]) : 0
            let r: Int
            switch f {
            case 0: r = v
            case 1: r = v + a
            case 2: r = v + b
            case 3: r = v + ((a + b) >> 1)
            case 4: r = v + paeth(a, b, c)
            default: throw PngError("Invalid PNG filter \(f).")
            }
            lines[dst + x] = UInt8(r & 255)
        }
    }
    let sample = { (y: Int, i: Int) -> Int in
        // The i-th sample of row y, scaled to 8 bits.
        let row = y * stride
        if depth == 8 { return Int(lines[row + i]) }
        if depth == 16 { return Int(lines[row + i * 2]) }
        let perByte = 8 / depth
        let byte = Int(lines[row + i / perByte])
        let shift = 8 - depth * ((i % perByte) + 1)
        let v = (byte >> shift) & ((1 << depth) - 1)
        return type == 3 ? v : Int(JS.round(Double(v * 255) / Double((1 << depth) - 1)))
    }
    let gray = keepGray && type == 0 && trns == nil
    let channels = gray ? 1 : 4
    var out = [UInt8](repeating: 0, count: width * height * channels)
    let tb = { (i: Int) -> Int in
        guard let trns, trns.startIndex + i < trns.endIndex else { return 0 }
        return Int(trns[trns.startIndex + i])
    }
    let trnsGray = trns != nil && type == 0 ? (depth == 16 ? tb(0) : sample16(tb, 0, depth)) : -1
    let trnsRgb: [Int]? = trns != nil && type == 2 ? (0..<3).map { depth == 16 ? tb($0 * 2) : sample16(tb, $0, depth) } : nil
    for y in 0..<height {
        for x in 0..<width {
            let d = (y * width + x) * channels
            if type == 0 {
                let v = UInt8(truncatingIfNeeded: sample(y, x))
                if gray {
                    out[d] = v
                } else {
                    out[d] = v
                    out[d + 1] = v
                    out[d + 2] = v
                    out[d + 3] = Int(v) == trnsGray && trns != nil ? 0 : 255
                }
            } else if type == 2 {
                let r = sample(y, x * 3)
                let g = sample(y, x * 3 + 1)
                let b = sample(y, x * 3 + 2)
                out[d] = UInt8(truncatingIfNeeded: r)
                out[d + 1] = UInt8(truncatingIfNeeded: g)
                out[d + 2] = UInt8(truncatingIfNeeded: b)
                out[d + 3] = trnsRgb != nil && r == trnsRgb![0] && g == trnsRgb![1] && b == trnsRgb![2] ? 0 : 255
            } else if type == 3 {
                let i = sample(y, x)
                guard let palette, i * 3 + 2 < palette.count else { throw PngError("PNG palette index out of range.") }
                let pb = palette.startIndex
                out[d] = palette[pb + i * 3]
                out[d + 1] = palette[pb + i * 3 + 1]
                out[d + 2] = palette[pb + i * 3 + 2]
                out[d + 3] = trns != nil && i < trns!.count ? UInt8(tb(i)) : 255
            } else if type == 4 {
                let v = UInt8(truncatingIfNeeded: sample(y, x * 2))
                out[d] = v
                out[d + 1] = v
                out[d + 2] = v
                out[d + 3] = UInt8(truncatingIfNeeded: sample(y, x * 2 + 1))
            } else {
                out[d] = UInt8(truncatingIfNeeded: sample(y, x * 4))
                out[d + 1] = UInt8(truncatingIfNeeded: sample(y, x * 4 + 1))
                out[d + 2] = UInt8(truncatingIfNeeded: sample(y, x * 4 + 2))
                out[d + 3] = UInt8(truncatingIfNeeded: sample(y, x * 4 + 3))
            }
        }
    }
    return DecodedPng(width: width, height: height, channels: channels, data: out)
}

/// A tRNS sample (stored as 16-bit big endian) scaled like the image samples.
private func sample16(_ trns: (Int) -> Int, _ k: Int, _ depth: Int) -> Int {
    let v = (trns(k * 2) << 8) | trns(k * 2 + 1)
    if depth == 8 { return v & 255 }
    return Int(JS.round(Double((v & ((1 << depth) - 1)) * 255) / Double((1 << depth) - 1)))
}

// MARK: - Base64 / data URLs

private let B64 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)
private let B64_INV: [Int] = {
    var inv = [Int](repeating: -1, count: 128)
    for i in 0..<64 { inv[Int(B64[i])] = i }
    inv[Int(UInt8(ascii: "-"))] = 62
    inv[Int(UInt8(ascii: "_"))] = 63
    return inv
}()

public func bytesToBase64(_ bytes: [UInt8]) -> String {
    var s: [UInt8] = []
    s.reserveCapacity((bytes.count + 2) / 3 * 4)
    var i = 0
    while i + 2 < bytes.count {
        let n = (Int(bytes[i]) << 16) | (Int(bytes[i + 1]) << 8) | Int(bytes[i + 2])
        s += [B64[n >> 18], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]]
        i += 3
    }
    if i < bytes.count {
        let n = (Int(bytes[i]) << 16) | (i + 1 < bytes.count ? Int(bytes[i + 1]) << 8 : 0)
        s += [B64[n >> 18], B64[(n >> 12) & 63], i + 1 < bytes.count ? B64[(n >> 6) & 63] : UInt8(ascii: "="), UInt8(ascii: "=")]
    }
    return String(decoding: s, as: UTF8.self)
}

public func base64ToBytes(_ text: String) throws -> [UInt8] {
    // Whitespace and padding are skipped (the TS `/[\s=]/g`).
    let clean = text.utf16.filter { c in
        !(c == 0x3D || c == 0x20 || (c >= 0x09 && c <= 0x0D) || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF)
    }
    var out: [UInt8] = []
    out.reserveCapacity(clean.count * 3 / 4)
    var bits = 0
    var acc = 0
    for c in clean {
        let v = c < 128 ? B64_INV[Int(c)] : -1
        if v < 0 { throw PngError("Invalid base64 data.") }
        acc = ((acc << 6) | v) & 0xFFFF_FFFF
        bits += 6
        if bits >= 8 {
            bits -= 8
            out.append(UInt8((acc >> bits) & 255))
        }
    }
    return out
}

/// The bytes and MIME type of a `data:` URL (base64 or percent-encoded).
public func parseDataUrl(_ url: String) -> (mime: String, bytes: [UInt8])? {
    guard let re = try? NSRegularExpression(pattern: "^data:([^;,]*)((?:;[^;,]*)*?),", options: [.caseInsensitive]) else { return nil }
    let ns = url as NSString
    guard let m = re.firstMatch(in: url, range: NSRange(location: 0, length: ns.length)) else { return nil }
    let mime = ns.substring(with: m.range(at: 1))
    let params = ns.substring(with: m.range(at: 2))
    let body = ns.substring(from: m.range.location + m.range.length)
    let isBase64 = params.range(of: ";base64", options: .caseInsensitive) != nil
    if isBase64 {
        guard let bytes = try? base64ToBytes(body) else { return nil }
        return (mime.isEmpty ? "text/plain" : mime, bytes)
    }
    guard let text = body.removingPercentEncoding else { return nil }
    return (mime.isEmpty ? "text/plain" : mime, text.utf16.map { UInt8($0 & 255) })
}

public func pngDataUrl(_ width: Int, _ height: Int, _ data: [UInt8], _ channels: Int = 4) -> String {
    "data:image/png;base64,\(bytesToBase64(encodePng(width, height, data, channels)))"
}
