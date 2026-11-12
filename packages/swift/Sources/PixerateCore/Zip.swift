import Foundation

/**
 * Pure-Swift ZIP archive reader (`import/zip.ts`)
 * and raw deflate decompressor (`raster/zlib.ts`).
 */

// MARK: - Raw Deflate (RFC 1951)

public let DEFLATE_LENGTH_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
]
public let DEFLATE_LENGTH_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
]
public let DEFLATE_DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
]
public let DEFLATE_DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
]
public let DEFLATE_CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

public struct ZlibError: Error, LocalizedError, CustomStringConvertible, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

private struct Huffman: Sendable {
    var counts: [Int]
    var symbols: [Int]
}

private func buildHuffman(_ lengths: ArraySlice<UInt8>, _ n: Int) -> Huffman {
    let base = lengths.startIndex
    var counts = [Int](repeating: 0, count: 16)
    for i in 0..<n { counts[Int(lengths[base + i])] += 1 }
    counts[0] = 0
    var offs = [Int](repeating: 0, count: 16)
    for i in 1..<16 { offs[i] = offs[i - 1] + counts[i - 1] }
    var symbols = [Int](repeating: 0, count: n)
    for i in 0..<n where lengths[base + i] != 0 {
        let l = Int(lengths[base + i])
        symbols[offs[l]] = i
        offs[l] += 1
    }
    return Huffman(counts: counts, symbols: symbols)
}

private let fixedTables: (Huffman, Huffman) = {
    var l = [UInt8](repeating: 0, count: 288)
    for i in 0..<144 { l[i] = 8 }
    for i in 144..<256 { l[i] = 9 }
    for i in 256..<280 { l[i] = 7 }
    for i in 280..<288 { l[i] = 8 }
    let d = [UInt8](repeating: 5, count: 30)
    return (buildHuffman(l[...], 288), buildHuffman(d[...], 30))
}()

private struct BitReader {
    var pos = 0
    var bit: UInt32 = 0
    var bits = 0
    let data: [UInt8]

    mutating func need(_ n: Int) throws -> Int {
        while bits < n {
            if pos >= data.count { throw ZlibError("Unexpected end of compressed data") }
            bit |= UInt32(data[pos]) << UInt32(bits)
            pos += 1
            bits += 8
        }
        let v = Int(bit & ((1 << UInt32(n)) &- 1))
        bit = n >= 32 ? 0 : bit >> UInt32(n)
        bits -= n
        return v
    }

    mutating func decode(_ h: Huffman) throws -> Int {
        var code = 0
        var first = 0
        var index = 0
        for len in 1..<16 {
            code |= try need(1)
            let count = h.counts[len]
            if code - count < first { return h.symbols[index + (code - first)] }
            index += count
            first += count
            first <<= 1
            code <<= 1
        }
        throw ZlibError("Invalid Huffman code")
    }

    mutating func align() {
        bit = 0
        bits = 0
    }
}

/// Inflates raw deflate data (no zlib header).
public func inflateRaw(_ data: [UInt8], maxOutput: Int? = nil, sizeHint: Int? = nil) throws -> [UInt8] {
    let max = maxOutput ?? 512 * 1024 * 1024
    var out: [UInt8] = []
    out.reserveCapacity(Swift.max(1024, Swift.min(sizeHint ?? data.count * 4, max)))
    func ensure(_ n: Int) throws {
        if out.count + n > max { throw ZlibError("Decompressed data exceeds \(max) bytes") }
    }
    var br = BitReader(data: data)
    var final = 0
    while final == 0 {
        final = try br.need(1)
        let type = try br.need(2)
        if type == 0 {
            br.align()
            if br.pos + 4 > data.count { throw ZlibError("Unexpected end of compressed data") }
            let len = Int(data[br.pos]) | (Int(data[br.pos + 1]) << 8)
            let nlen = Int(data[br.pos + 2]) | (Int(data[br.pos + 3]) << 8)
            br.pos += 4
            if (len ^ 0xFFFF) != nlen { throw ZlibError("Stored block length mismatch") }
            if br.pos + len > data.count { throw ZlibError("Unexpected end of compressed data") }
            try ensure(len)
            out.append(contentsOf: data[br.pos..<(br.pos + len)])
            br.pos += len
            continue
        }
        let lit: Huffman
        let dist: Huffman
        if type == 1 {
            (lit, dist) = fixedTables
        } else if type == 2 {
            let hlit = try br.need(5) + 257
            let hdist = try br.need(5) + 1
            let hclen = try br.need(4) + 4
            var cl = [UInt8](repeating: 0, count: 19)
            for i in 0..<hclen { cl[DEFLATE_CL_ORDER[i]] = UInt8(try br.need(3)) }
            let clh = buildHuffman(cl[...], 19)
            var lengths = [UInt8](repeating: 0, count: hlit + hdist)
            var i = 0
            while i < hlit + hdist {
                let sym = try br.decode(clh)
                if sym < 16 {
                    lengths[i] = UInt8(sym)
                    i += 1
                } else {
                    var rep = 0
                    var val: UInt8 = 0
                    if sym == 16 {
                        if i == 0 { throw ZlibError("Repeat with no previous length") }
                        val = lengths[i - 1]
                        rep = 3 + (try br.need(2))
                    } else if sym == 17 {
                        rep = 3 + (try br.need(3))
                    } else {
                        rep = 11 + (try br.need(7))
                    }
                    if i + rep > hlit + hdist { throw ZlibError("Too many code lengths") }
                    while rep > 0 {
                        lengths[i] = val
                        i += 1
                        rep -= 1
                    }
                }
            }
            lit = buildHuffman(lengths[0..<hlit], hlit)
            dist = buildHuffman(lengths[hlit...], hdist)
        } else {
            throw ZlibError("Invalid block type")
        }
        while true {
            let sym = try br.decode(lit)
            if sym < 256 {
                try ensure(1)
                out.append(UInt8(sym))
            } else if sym == 256 {
                break
            } else {
                let li = sym - 257
                if li >= 29 { throw ZlibError("Invalid length symbol") }
                let len = DEFLATE_LENGTH_BASE[li] + (try br.need(DEFLATE_LENGTH_EXTRA[li]))
                let di = try br.decode(dist)
                if di >= 30 { throw ZlibError("Invalid distance symbol") }
                let d = DEFLATE_DIST_BASE[di] + (try br.need(DEFLATE_DIST_EXTRA[di]))
                if d > out.count { throw ZlibError("Distance too far back") }
                try ensure(len)
                for _ in 0..<len { out.append(out[out.count - d]) }
            }
        }
    }
    return out
}


// MARK: - ZIP reader (a line-by-line port of `import/zip.ts`)
//
// - Reads the central directory (including ZIP64 end records and extra fields), so sizes come from
//   the authoritative directory rather than local headers or data descriptors.
// - Supports stored (method 0) and deflate (method 8) entries.
// - Guards against zip bombs (entry-count and total-uncompressed-size caps, enforced on the bytes
//   actually inflated, not only the declared sizes), path traversal in entry names and encrypted entries.
// - Verifies CRC-32 checksums of extracted entries.
//
// Error messages, the order of checks and the JS string semantics (UTF-16 code units, `Map` keys that
// are not Unicode-normalised) match the TS core exactly: Office chart errors reach agents as
// `This is not an Office file: <message>`.

public enum ZipErrorCode: String, Sendable, Equatable {
    /// Not a ZIP archive, or its directory is truncated / inconsistent.
    case invalidArchive = "invalid_archive"
    /// Compression method other than stored/deflate, multi-disk archives, …
    case unsupportedFeature = "unsupported_feature"
    /// The entry is encrypted (general-purpose flag bit 0).
    case encrypted = "encrypted"
    /// An entry name is absolute or contains `..` segments.
    case unsafePath = "unsafe_path"
    /// More entries than `maxEntries`.
    case tooManyEntries = "too_many_entries"
    /// Extracting would exceed `maxTotalSize` uncompressed bytes.
    case tooLarge = "too_large"
    /// The entry data is corrupt (bad header, size or CRC mismatch, bad deflate stream).
    case corruptEntry = "corrupt_entry"
    /// No entry with the requested name.
    case entryNotFound = "entry_not_found"
    /// Kept for parity with the TS codes; the Swift inflater is always available.
    case unsupportedEnvironment = "unsupported_environment"
}

public struct ZipError: Error, LocalizedError, CustomStringConvertible, Equatable, Sendable {
    public let code: ZipErrorCode
    public let message: String
    public let entryName: String?

    public init(_ code: ZipErrorCode, _ message: String, entryName: String? = nil) {
        self.code = code
        self.message = message
        self.entryName = entryName
    }

    public var errorDescription: String? { message }
    public var description: String { message }
}

public struct ZipEntry: Sendable, Equatable {
    /// Entry path with `/` separators (backslashes are normalized).
    public let name: String
    /// Whether the entry is a directory (name ends with `/`).
    public let isDirectory: Bool
    /// Whether the entry is encrypted; reading it throws `ZipError(.encrypted)`.
    public let encrypted: Bool
    /// Compression method (0 = stored, 8 = deflate).
    public let method: Int
    /// Declared compressed size in bytes.
    public let compressedSize: Int
    /// Declared uncompressed size in bytes.
    public let size: Int
    /// CRC-32 of the uncompressed data.
    public let crc32: UInt32
    /// Offset of the entry's local file header.
    public let localHeaderOffset: Int

    public init(name: String, isDirectory: Bool, encrypted: Bool, method: Int, compressedSize: Int, size: Int, crc32: UInt32, localHeaderOffset: Int) {
        self.name = name
        self.isDirectory = isDirectory
        self.encrypted = encrypted
        self.method = method
        self.compressedSize = compressedSize
        self.size = size
        self.crc32 = crc32
        self.localHeaderOffset = localHeaderOffset
    }

    public static func == (a: ZipEntry, b: ZipEntry) -> Bool {
        JSKey(a.name) == JSKey(b.name) && a.isDirectory == b.isDirectory && a.encrypted == b.encrypted && a.method == b.method
            && a.compressedSize == b.compressedSize && a.size == b.size && a.crc32 == b.crc32 && a.localHeaderOffset == b.localHeaderOffset
    }
}

/// What to do with entries whose names are absolute or contain `..` segments.
public enum ZipUnsafePaths: String, Sendable, Equatable {
    /// Reject the archive (the default).
    case error
    /// Leave them out of `entries`.
    case skip
}

public struct ZipReadOptions: Sendable, Equatable {
    /// Maximum number of entries in the central directory (default 10 000).
    public var maxEntries: Int?
    /// Maximum number of uncompressed bytes extracted from the archive, summed over every `read` call
    /// (default 256 MiB). Enforced while inflating.
    public var maxTotalSize: Int?
    /// `.error` (default) rejects the archive, `.skip` leaves unsafe entries out of `entries`.
    public var unsafePaths: ZipUnsafePaths?

    public init(maxEntries: Int? = nil, maxTotalSize: Int? = nil, unsafePaths: ZipUnsafePaths? = nil) {
        self.maxEntries = maxEntries
        self.maxTotalSize = maxTotalSize
        self.unsafePaths = unsafePaths
    }
}

public let DEFAULT_ZIP_MAX_ENTRIES = 10_000
public let DEFAULT_ZIP_MAX_TOTAL_SIZE = 256 * 1024 * 1024

private let SIG_EOCD = 0x0605_4B50
private let SIG_ZIP64_EOCD = 0x0606_4B50
private let SIG_ZIP64_LOCATOR = 0x0706_4B50
private let SIG_CENTRAL = 0x0201_4B50
private let SIG_LOCAL = 0x0403_4B50
private let EOCD_SIZE = 22
private let MAX_COMMENT = 0xFFFF

private let CRC_TABLE: [UInt32] = {
    var table = [UInt32](repeating: 0, count: 256)
    for n in 0..<256 {
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        table[n] = c
    }
    return table
}()

/// CRC-32 (IEEE 802.3), as used by ZIP.
public func zipCrc32(_ data: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0xFFFF_FFFF
    for b in data { crc = CRC_TABLE[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8) }
    return crc ^ 0xFFFF_FFFF
}

/// Whether `name` is absolute, has a drive letter, or contains `..` / NUL (UTF-16 code units, as in JS).
public func isUnsafeZipPath(_ name: String) -> Bool {
    let units = Array(name.utf16)
    if units.isEmpty || units.contains(0) { return true }
    // name.replace(/\\/g, "/")
    let normalized = units.map { $0 == 0x5C ? 0x2F : $0 }
    let isLetter: (UInt16) -> Bool = { ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) }
    if normalized[0] == 0x2F || (normalized.count >= 2 && isLetter(normalized[0]) && normalized[1] == 0x3A) { return true }
    return normalized.split(separator: 0x2F, omittingEmptySubsequences: false).contains { $0.elementsEqual([0x2E, 0x2E]) }
}

/// CP437 high half, used for names without the UTF-8 flag.
private let CP437_HIGH: [Unicode.Scalar] = Array(
    ("\u{00C7}\u{00FC}\u{00E9}\u{00E2}\u{00E4}\u{00E0}\u{00E5}\u{00E7}\u{00EA}\u{00EB}\u{00E8}\u{00EF}\u{00EE}\u{00EC}\u{00C4}\u{00C5}"
        + "\u{00C9}\u{00E6}\u{00C6}\u{00F4}\u{00F6}\u{00F2}\u{00FB}\u{00F9}\u{00FF}\u{00D6}\u{00DC}\u{00A2}\u{00A3}\u{00A5}\u{20A7}\u{0192}"
        + "\u{00E1}\u{00ED}\u{00F3}\u{00FA}\u{00F1}\u{00D1}\u{00AA}\u{00BA}\u{00BF}\u{2310}\u{00AC}\u{00BD}\u{00BC}\u{00A1}\u{00AB}\u{00BB}"
        + "\u{2591}\u{2592}\u{2593}\u{2502}\u{2524}\u{2561}\u{2562}\u{2556}\u{2555}\u{2563}\u{2551}\u{2557}\u{255D}\u{255C}\u{255B}\u{2510}"
        + "\u{2514}\u{2534}\u{252C}\u{251C}\u{2500}\u{253C}\u{255E}\u{255F}\u{255A}\u{2554}\u{2569}\u{2566}\u{2560}\u{2550}\u{256C}\u{2567}"
        + "\u{2568}\u{2564}\u{2565}\u{2559}\u{2558}\u{2552}\u{2553}\u{256B}\u{256A}\u{2518}\u{250C}\u{2588}\u{2584}\u{258C}\u{2590}\u{2580}"
        + "\u{03B1}\u{00DF}\u{0393}\u{03C0}\u{03A3}\u{03C3}\u{00B5}\u{03C4}\u{03A6}\u{0398}\u{03A9}\u{03B4}\u{221E}\u{03C6}\u{03B5}\u{2229}"
        + "\u{2261}\u{00B1}\u{2265}\u{2264}\u{2320}\u{2321}\u{00F7}\u{2248}\u{00B0}\u{2219}\u{00B7}\u{221A}\u{207F}\u{00B2}\u{25A0}\u{00A0}"
    ).unicodeScalars
)

private func decodeName(_ bytes: ArraySlice<UInt8>, _ isUtf8: Bool) -> String {
    if isUtf8 || bytes.allSatisfy({ $0 < 0x80 }) { return jsDecodeUtf8(bytes) }
    var out = String.UnicodeScalarView()
    for b in bytes { out.append(b < 0x80 ? Unicode.Scalar(b) : CP437_HIGH[Int(b) - 0x80]) }
    return String(out)
}

/// A byte, or 0 past the end (JavaScript's `undefined` reads as 0 in bit operations).
@inline(__always) public func byteAt(_ b: [UInt8], _ p: Int) -> Int {
    p >= 0 && p < b.count ? Int(b[p]) : 0
}

@inline(__always) private func readU16(_ b: [UInt8], _ p: Int) -> Int {
    byteAt(b, p) | (byteAt(b, p + 1) << 8)
}

@inline(__always) private func readU32(_ b: [UInt8], _ p: Int) -> Int {
    byteAt(b, p) | (byteAt(b, p + 1) << 8) | (byteAt(b, p + 2) << 16) | (byteAt(b, p + 3) << 24)
}

private func readU64(_ b: [UInt8], _ p: Int) throws -> Int {
    let lo = readU32(b, p), hi = readU32(b, p + 4)
    // Number.isSafeInteger(lo + hi * 2^32)
    if hi > 0x1F_FFFF { throw ZipError(.unsupportedFeature, "ZIP64 value exceeds the supported range.") }
    return lo + hi * 0x1_0000_0000
}

/// `name.replace(/\\/g, "/")` over code units.
private func slashes(_ s: String) -> String {
    s.utf16.contains(0x5C) ? String(decoding: s.utf16.map { $0 == 0x5C ? 0x2F : $0 }, as: UTF16.self) : s
}

/// A parsed ZIP archive. Entry data is extracted lazily with `read`. Create it with `readZip`.
public final class ZipArchive {
    /// Entries in central-directory order.
    public let entries: [ZipEntry]
    private var byName: [JSKey: ZipEntry] = [:]
    private var extracted = 0
    private let bytes: [UInt8]
    private let maxTotalSize: Int

    fileprivate init(_ bytes: [UInt8], _ entries: [ZipEntry], _ maxTotalSize: Int) {
        self.bytes = bytes
        self.entries = entries
        self.maxTotalSize = maxTotalSize
        for entry in entries where byName[JSKey(entry.name)] == nil { byName[JSKey(entry.name)] = entry }
    }

    /// Looks up an entry by exact name (a leading `/` is ignored).
    public func get(_ name: String) -> ZipEntry? {
        let units = Array(name.utf16)
        let start = units.firstIndex { $0 != 0x2F } ?? units.count
        return byName[JSKey(String(decoding: units[start...], as: UTF16.self))]
    }

    public func has(_ name: String) -> Bool { get(name) != nil }

    /// Uncompressed bytes extracted so far (counted against `maxTotalSize`).
    public var extractedSize: Int { extracted }

    /// Extracts the named entry's data, verifying its size and CRC-32.
    public func read(_ name: String) throws -> [UInt8] {
        guard let entry = get(name) else {
            throw ZipError(.entryNotFound, "ZIP entry \"\(name)\" not found.", entryName: name)
        }
        return try read(entry)
    }

    /// Extracts an entry's data, verifying its size and CRC-32.
    public func read(_ entry: ZipEntry) throws -> [UInt8] {
        let name = entry.name
        if entry.encrypted {
            throw ZipError(.encrypted, "ZIP entry \"\(name)\" is encrypted; encrypted archives are not supported.", entryName: name)
        }
        if entry.isDirectory { return [] }
        let remaining = maxTotalSize - extracted
        if entry.size > remaining {
            throw ZipError(.tooLarge, "Extracting \"\(name)\" (\(entry.size) bytes) would exceed the \(maxTotalSize)-byte limit.", entryName: name)
        }

        let offset = entry.localHeaderOffset
        if offset + 30 > bytes.count || readU32(bytes, offset) != SIG_LOCAL {
            throw ZipError(.corruptEntry, "ZIP entry \"\(name)\" has no valid local header.", entryName: name)
        }
        let dataStart = offset + 30 + readU16(bytes, offset + 26) + readU16(bytes, offset + 28)
        let dataEnd = dataStart + entry.compressedSize
        if dataEnd > bytes.count {
            throw ZipError(.corruptEntry, "ZIP entry \"\(name)\" is truncated.", entryName: name)
        }
        let raw = bytes[dataStart..<dataEnd]

        let data: [UInt8]
        if entry.method == 0 {
            if entry.compressedSize != entry.size {
                throw ZipError(.corruptEntry, "Stored ZIP entry \"\(name)\" has inconsistent sizes.", entryName: name)
            }
            data = Array(raw)
        } else if entry.method == 8 {
            // Cap at the declared size: more output means a lying header (or a bomb).
            data = try zipInflate(Array(raw), entry.size, name)
        } else {
            throw ZipError(
                .unsupportedFeature,
                "ZIP entry \"\(name)\" uses unsupported compression method \(entry.method); only stored and deflate are supported.",
                entryName: name
            )
        }
        if data.count != entry.size {
            throw ZipError(.corruptEntry, "ZIP entry \"\(name)\" size does not match the directory.", entryName: name)
        }
        extracted += data.count
        if zipCrc32(data) != entry.crc32 {
            throw ZipError(.corruptEntry, "ZIP entry \"\(name)\" failed its CRC-32 check.", entryName: name)
        }
        return data
    }

    /// Extracts the named entry and decodes it as UTF-8 (a leading BOM is removed).
    public func readText(_ name: String) throws -> String {
        stripBom(jsDecodeUtf8(try read(name)))
    }

    /// Extracts an entry and decodes it as UTF-8 (a leading BOM is removed).
    public func readText(_ entry: ZipEntry) throws -> String {
        stripBom(jsDecodeUtf8(try read(entry)))
    }

    private func stripBom(_ text: String) -> String {
        // `TextDecoder` already dropped one BOM; `readText` drops a second one too.
        text.utf16.first == 0xFEFF ? String(decoding: text.utf16.dropFirst(), as: UTF16.self) : text
    }
}

/// Inflates a raw deflate stream, failing as soon as output exceeds `limit` bytes.
private func zipInflate(_ raw: [UInt8], _ limit: Int, _ entryName: String) throws -> [UInt8] {
    do {
        return try inflateRaw(raw, maxOutput: limit, sizeHint: limit)
    } catch let error as ZlibError where error.message.hasPrefix("Decompressed data exceeds ") {
        throw ZipError(.corruptEntry, "ZIP entry \"\(entryName)\" inflates beyond its declared size of \(limit) bytes.", entryName: entryName)
    } catch {
        throw ZipError(.corruptEntry, "ZIP entry \"\(entryName)\" has an invalid deflate stream.", entryName: entryName)
    }
}

private func findEndOfCentralDirectory(_ bytes: [UInt8]) -> Int {
    let min = Swift.max(0, bytes.count - EOCD_SIZE - MAX_COMMENT)
    var i = bytes.count - EOCD_SIZE
    while i >= min {
        if readU32(bytes, i) == SIG_EOCD && i + EOCD_SIZE + readU16(bytes, i + 20) <= bytes.count { return i }
        i -= 1
    }
    return -1
}

/// Parses a ZIP archive's central directory. Entry data is not extracted until `ZipArchive.read` is
/// called. Throws `ZipError`.
public func readZip(_ bytes: [UInt8], options: ZipReadOptions = ZipReadOptions()) throws -> ZipArchive {
    let maxEntries = options.maxEntries ?? DEFAULT_ZIP_MAX_ENTRIES
    let maxTotalSize = options.maxTotalSize ?? DEFAULT_ZIP_MAX_TOTAL_SIZE

    let eocd = findEndOfCentralDirectory(bytes)
    if eocd < 0 { throw ZipError(.invalidArchive, "Not a ZIP archive (no end of central directory record).") }

    var diskNumber = readU16(bytes, eocd + 4)
    var cdDisk = readU16(bytes, eocd + 6)
    var count = readU16(bytes, eocd + 10)
    var cdSize = readU32(bytes, eocd + 12)
    var cdOffset = readU32(bytes, eocd + 16)

    if count == 0xFFFF || cdSize == 0xFFFF_FFFF || cdOffset == 0xFFFF_FFFF {
        let locator = eocd - 20
        if locator < 0 || readU32(bytes, locator) != SIG_ZIP64_LOCATOR {
            throw ZipError(.invalidArchive, "ZIP64 archive is missing its end of central directory locator.")
        }
        let record = try readU64(bytes, locator + 8)
        if record + 56 > bytes.count || readU32(bytes, record) != SIG_ZIP64_EOCD {
            throw ZipError(.invalidArchive, "ZIP64 end of central directory record not found.")
        }
        diskNumber = readU32(bytes, record + 16)
        cdDisk = readU32(bytes, record + 20)
        count = try readU64(bytes, record + 32)
        cdSize = try readU64(bytes, record + 40)
        cdOffset = try readU64(bytes, record + 48)
    }
    if diskNumber != 0 || cdDisk != 0 {
        throw ZipError(.unsupportedFeature, "Multi-disk (spanned) ZIP archives are not supported.")
    }
    if count > maxEntries {
        throw ZipError(.tooManyEntries, "ZIP archive has \(count) entries; the limit is \(maxEntries).")
    }
    if cdOffset + cdSize > bytes.count {
        throw ZipError(.invalidArchive, "ZIP central directory lies outside the file.")
    }

    var entries: [ZipEntry] = []
    var p = cdOffset
    var i = 0
    while i < count {
        i += 1
        if p + 46 > bytes.count || readU32(bytes, p) != SIG_CENTRAL {
            throw ZipError(.invalidArchive, "ZIP central directory is corrupt.")
        }
        let flags = readU16(bytes, p + 8)
        let method = readU16(bytes, p + 10)
        let crc32 = UInt32(readU32(bytes, p + 16))
        var compressedSize = readU32(bytes, p + 20)
        var size = readU32(bytes, p + 24)
        let nameLength = readU16(bytes, p + 28)
        let extraLength = readU16(bytes, p + 30)
        let commentLength = readU16(bytes, p + 32)
        var localHeaderOffset = readU32(bytes, p + 42)
        let nameStart = p + 46
        let extraStart = nameStart + nameLength
        let next = extraStart + extraLength + commentLength
        if next > bytes.count { throw ZipError(.invalidArchive, "ZIP central directory is truncated.") }

        // ZIP64 extended information: only the fields that overflowed are present, in order.
        var e = extraStart
        while e + 4 <= extraStart + extraLength {
            let id = readU16(bytes, e)
            let len = readU16(bytes, e + 2)
            if id == 0x0001 {
                var f = e + 4
                let end = f + len
                if size == 0xFFFF_FFFF && f + 8 <= end {
                    size = try readU64(bytes, f)
                    f += 8
                }
                if compressedSize == 0xFFFF_FFFF && f + 8 <= end {
                    compressedSize = try readU64(bytes, f)
                    f += 8
                }
                if localHeaderOffset == 0xFFFF_FFFF && f + 8 <= end { localHeaderOffset = try readU64(bytes, f) }
            }
            e += 4 + len
        }

        let rawName = decodeName(bytes[nameStart..<extraStart], (flags & 0x0800) != 0)
        let name = slashes(rawName)
        p = next
        if isUnsafeZipPath(rawName) {
            if options.unsafePaths == .skip { continue }
            throw ZipError(.unsafePath, "ZIP entry name \"\(rawName)\" is absolute or escapes the archive root.", entryName: rawName)
        }
        entries.append(ZipEntry(
            name: name,
            isDirectory: name.utf16.last == 0x2F,
            encrypted: (flags & 0x0001) != 0,
            method: method,
            compressedSize: compressedSize,
            size: size,
            crc32: crc32,
            localHeaderOffset: localHeaderOffset
        ))
    }
    return ZipArchive(bytes, entries, maxTotalSize)
}
