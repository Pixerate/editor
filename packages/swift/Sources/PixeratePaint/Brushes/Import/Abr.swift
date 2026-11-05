import Foundation

/**
 * A defensive reader for Photoshop brush files (`.abr`, `brushes/import/abr.ts`): the tips, not
 * the presets around them.
 *
 * - Versions 1 and 2: computed tips (diameter, roundness, angle, hardness, spacing) and sampled
 *   tips (a grey image, raw or PackBits-compressed, 8 or 16 bits).
 * - Versions 6, 7 and 10: the sampled tips of the `samp` section, with preset names and spacing
 *   read from the `desc` section by their keys; everything else in it is reported, not mapped.
 *
 * Brush files are untrusted: every read is bounds-checked, sizes are limited, and a tip that can't
 * be read is reported and skipped rather than failing the whole file.
 */

/// A tip read from a brush file.
public enum AbrTip: Equatable {
    /// A grey image, one byte per pixel (255 paints); spacing as a fraction of the diameter, when known.
    case sampled(name: String?, width: Int, height: Int, mask: [UInt8], spacing: Double?)
    /// Diameter px, roundness 0..1, angle degrees, hardness 0..1, spacing.
    case computed(name: String?, diameter: Double, roundness: Double, angle: Double, hardness: Double, spacing: Double)

    public var name: String? {
        switch self {
        case .sampled(let n, _, _, _, _), .computed(let n, _, _, _, _, _): return n
        }
    }
}

public struct AbrFile {
    public var version: Int
    public var tips: [AbrTip] = []
    /// What the file has that was not read, in words.
    public var unsupported: [String] = []
}

public struct AbrError: Error, LocalizedError {
    public let message: String
    init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Largest tip image read (pixels); Photoshop's own limit is 5000 × 5000.
private let MAX_TIP_PIXELS = 5000 * 5000
/// Most tips read from one file.
private let MAX_TIPS = 1000

private final class Reader {
    let bytes: [UInt8]
    let end: Int
    var pos = 0
    init(_ bytes: [UInt8], end: Int? = nil) {
        self.bytes = bytes
        self.end = Swift.min(end ?? bytes.count, bytes.count)
    }
    func need(_ n: Int) throws {
        if n < 0 || pos < 0 || pos + n > end { throw AbrError("The brush file ends early or a size in it is wrong.") }
    }
    func u8() throws -> Int {
        try need(1)
        pos += 1
        return Int(bytes[pos - 1])
    }
    func u16() throws -> Int {
        try need(2)
        pos += 2
        return Int(bytes[pos - 2]) << 8 | Int(bytes[pos - 1])
    }
    func i16() throws -> Int {
        let v = try u16()
        return v & 0x8000 != 0 ? v - 0x10000 : v
    }
    func u32() throws -> Int {
        try need(4)
        pos += 4
        return Int(bytes[pos - 4]) << 24 | Int(bytes[pos - 3]) << 16 | Int(bytes[pos - 2]) << 8 | Int(bytes[pos - 1])
    }
    func i32() throws -> Int { Int(Int32(truncatingIfNeeded: try u32())) }
    func take(_ n: Int) throws -> [UInt8] {
        try need(n)
        pos += n
        return Array(bytes[(pos - n)..<pos])
    }
    func skip(_ n: Int) throws {
        try need(n)
        pos += n
    }
    func ascii(_ n: Int) throws -> String { latin1(try take(n)) }
}

func latin1(_ b: [UInt8]) -> String { String(String.UnicodeScalarView(b.map { Unicode.Scalar($0) })) }
private func utf16Text(_ units: [Int]) -> String { String(decoding: units.map { UInt16(truncatingIfNeeded: $0) }, as: UTF16.self) }
private func trimNuls(_ s: String) -> String { s.replacingOccurrences(of: "\u{0}+$", with: "", options: .regularExpression) }
private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

/// PackBits rows: `height` big-endian row lengths, then each row's runs, into `rowBytes` per row.
private func unpackRows(_ r: Reader, _ height: Int, _ rowBytes: Int) throws -> [UInt8] {
    var lengths: [Int] = []
    for _ in 0..<height { lengths.append(try r.u16()) }
    var out = [UInt8](repeating: 0, count: rowBytes * height)
    for y in 0..<height {
        let row = Reader(try r.take(lengths[y]))
        var x = 0
        while row.pos < row.end && x < rowBytes {
            let n = try row.u8()
            if n < 128 {
                let run = Swift.min(n + 1, rowBytes - x)
                let src = try row.take(run)
                for k in 0..<run { out[y * rowBytes + x + k] = src[k] }
                if n + 1 > run { try row.skip(Swift.min(n + 1 - run, row.end - row.pos)) }
                x += run
            } else if n > 128 {
                let v = UInt8(try row.u8())
                let run = Swift.min(257 - n, rowBytes - x)
                for k in 0..<run { out[y * rowBytes + x + k] = v }
                x += run
            }
            // 128 is a no-op.
        }
    }
    return out
}

/// A tip image (`depth` 8 or 16 bits, raw or PackBits) as one byte per pixel.
private func readImage(_ r: Reader, _ width: Int, _ height: Int, _ depth: Int, _ compression: Int) throws -> [UInt8] {
    if !(width > 0 && height > 0) { throw AbrError("A tip is \(width)×\(height) px.") }
    if Double(width) * Double(height) > Double(MAX_TIP_PIXELS) { throw AbrError("A tip is \(width)×\(height) px; tips over \(MAX_TIP_PIXELS) pixels are not read.") }
    if depth != 8 && depth != 16 { throw AbrError("A tip has \(depth)-bit depth; 8 and 16 bits are read.") }
    let bpp = depth / 8
    let rowBytes = width * bpp
    let data: [UInt8]
    if compression == 0 { data = try r.take(rowBytes * height) } else if compression == 1 { data = try unpackRows(r, height, rowBytes) } else {
        throw AbrError("A tip uses compression \(compression); raw and PackBits are read.")
    }
    if bpp == 1 { return data }
    // 16 bits: the high byte of each big-endian sample.
    return (0..<(width * height)).map { data[$0 * 2] }
}

private func readV1(_ r: Reader, _ version: Int, _ file: inout AbrFile) throws {
    let count = try r.u16()
    var i = 0
    while i < count && file.tips.count < MAX_TIPS {
        defer { i += 1 }
        let type = try r.u16()
        let size = try r.u32()
        try r.need(size)
        let end = r.pos + size
        let b = Reader(r.bytes, end: end)
        b.pos = r.pos
        do {
            if type == 1 {
                try b.skip(4)
                let spacing = try b.u16()
                let diameter = try b.u16()
                let roundness = try b.u16()
                let angle = try b.i16()
                let hardness = try b.u16()
                file.tips.append(.computed(name: nil, diameter: clamp(Double(diameter), 1, 2500), roundness: clamp(Double(roundness) / 100, 0.01, 1), angle: clamp(Double(angle), -180, 180), hardness: clamp(Double(hardness) / 100, 0, 1), spacing: clamp(Double(spacing) / 100, 0.01, 10)))
            } else if type == 2 {
                try b.skip(4)
                let spacing = try b.u16()
                var name: String? = nil
                if version == 2 {
                    let n = try b.u32()
                    if n > 1024 { throw AbrError("A tip name is too long.") }
                    var chars: [Int] = []
                    for _ in 0..<n { chars.append(try b.u16()) }
                    let t = trimNuls(utf16Text(chars)).trimmingCharacters(in: .whitespacesAndNewlines)
                    name = t.isEmpty ? nil : t
                }
                try b.skip(1 + 8)
                let top = try b.i32()
                let left = try b.i32()
                let bottom = try b.i32()
                let right = try b.i32()
                let depth = try b.u16()
                let compression = try b.u8()
                let width = right - left
                let height = bottom - top
                let mask = try readImage(b, width, height, depth, compression)
                file.tips.append(.sampled(name: name, width: width, height: height, mask: mask, spacing: spacing != 0 ? clamp(Double(spacing) / 100, 0.01, 10) : nil))
            } else {
                file.unsupported.append("Brush \(i + 1) is of type \(type), which is not read.")
            }
        } catch {
            file.unsupported.append("Brush \(i + 1) could not be read: \(error.localizedDescription)")
        }
        r.pos = end
    }
}

/// Names and spacing of the presets in a `desc` section, by the sampled tip each names (`sampledData`).
private func readDescriptor(_ bytes: [UInt8]) -> [String: (name: String?, spacing: Double?)] {
    var out: [String: (name: String?, spacing: Double?)] = [:]
    func find(_ pattern: [UInt8], _ from: Int) -> Int {
        if pattern.count > bytes.count { return -1 }
        var p = Swift.max(0, from)
        while p <= bytes.count - pattern.count {
            var k = 0
            while k < pattern.count && bytes[p + k] == pattern[k] { k += 1 }
            if k == pattern.count { return p }
            p += 1
        }
        return -1
    }
    func text(_ p: Int) -> String? {
        let r = Reader(bytes)
        r.pos = p
        guard let n = try? r.u32(), n <= 512 else { return nil }
        var chars: [Int] = []
        for _ in 0..<n {
            guard let c = try? r.u16() else { return nil }
            chars.append(c)
        }
        return trimNuls(utf16Text(chars))
    }
    let NAME = Array("Nm  TEXT".utf8)
    let SAMPLED = Array("sampledDataTEXT".utf8)
    let SPACING = Array("SpcnUntF#Prc".utf8)
    var lastName: String? = nil
    var lastNameAt = -1
    var p = find(SAMPLED, 0)
    while p >= 0 {
        defer { p = find(SAMPLED, p + SAMPLED.count) }
        // The preset's name is the last Nm before its sampledData; its spacing the first Spcn after.
        var q = find(NAME, lastNameAt + 1)
        while q >= 0 && q < p {
            lastName = text(q + NAME.count)
            lastNameAt = q
            q = find(NAME, q + NAME.count)
        }
        guard let uuid = text(p + SAMPLED.count), !uuid.isEmpty else { continue }
        let s = find(SPACING, p)
        var spacing: Double? = nil
        if s >= 0 && s + SPACING.count + 8 <= bytes.count {
            var bits: UInt64 = 0
            for k in 0..<8 { bits = bits << 8 | UInt64(bytes[s + SPACING.count + k]) }
            let v = Double(bitPattern: bits)
            if v.isFinite && v > 0 { spacing = clamp(v / 100, 0.01, 10) }
        }
        if out[uuid] == nil { out[uuid] = (lastName.flatMap { $0.isEmpty ? nil : $0.trimmingCharacters(in: .whitespacesAndNewlines) }, spacing) }
    }
    return out
}

private func readV6(_ r: Reader, _ subversion: Int, _ file: inout AbrFile) throws {
    var samples: [(uuid: String, width: Int, height: Int, mask: [UInt8])] = []
    var presets: [String: (name: String?, spacing: Double?)] = [:]
    while r.pos + 12 <= r.end {
        let sig = try r.ascii(4)
        if sig != "8BIM" && sig != "8B64" { break }
        let key = try r.ascii(4)
        let len = try r.u32()
        try r.need(len)
        let end = r.pos + len
        if key == "samp" {
            let s = Reader(r.bytes, end: end)
            s.pos = r.pos
            while s.pos + 4 <= end && samples.count < MAX_TIPS {
                let size = try s.u32()
                let padded = size + ((4 - (size % 4)) % 4)
                let next = s.pos + padded
                if s.pos + size > end { break }
                let b = Reader(r.bytes, end: s.pos + size)
                b.pos = s.pos
                do {
                    let keyLen = try b.u8()
                    let uuid = try b.ascii(keyLen)
                    // GIMP skips the key and what follows it: 47 bytes in all (subversion 1), 301 (subversion 2).
                    b.pos = s.pos + (subversion == 1 ? 47 : 301)
                    let top = try b.i32()
                    let left = try b.i32()
                    let bottom = try b.i32()
                    let right = try b.i32()
                    let depth = try b.u16()
                    let compression = try b.u8()
                    let width = right - left
                    let height = bottom - top
                    samples.append((uuid, width, height, try readImage(b, width, height, depth, compression)))
                } catch {
                    file.unsupported.append("Sampled tip \(samples.count + 1) could not be read: \(error.localizedDescription)")
                }
                s.pos = Swift.min(next, end)
            }
        } else if key == "desc" {
            presets = readDescriptor(Array(r.bytes[r.pos..<end]))
        } else if key == "patt" {
            file.unsupported.append("Patterns (the brushes' textures) are not imported; add a pattern image as a grain source with add_brush_source.")
        }
        r.pos = end + (len % 2)
    }
    for s in samples {
        let p = presets[s.uuid]
        file.tips.append(.sampled(name: p?.name, width: s.width, height: s.height, mask: s.mask, spacing: p?.spacing))
    }
    if !presets.isEmpty { file.unsupported.append("Preset dynamics, textures, dual brushes and colour settings are not mapped; each tip imports with its name and spacing.") }
}

/// The tips of an `.abr` file (see the file comment). Throws an `AbrError` when the file is not one at all.
public func readAbr(_ bytes: [UInt8]) throws -> AbrFile {
    let r = Reader(bytes)
    let version: Int
    do { version = try r.u16() } catch { throw AbrError("Not a brush file: it is empty.") }
    var file = AbrFile(version: version)
    do {
        if version == 1 || version == 2 {
            try readV1(r, version, &file)
        } else if version == 6 || version == 7 || version == 10 {
            let subversion = try r.u16()
            if subversion != 1 && subversion != 2 { throw AbrError("ABR version \(version).\(subversion) is not supported.") }
            try readV6(r, subversion, &file)
        } else {
            throw AbrError("Not a Photoshop brush file, or ABR version \(version), which is not supported (1, 2, 6, 7 and 10 are).")
        }
    } catch {
        if file.tips.isEmpty { throw error as? AbrError ?? AbrError(error.localizedDescription) }
        file.unsupported.append("The rest of the file could not be read: \(error.localizedDescription)")
    }
    return file
}
