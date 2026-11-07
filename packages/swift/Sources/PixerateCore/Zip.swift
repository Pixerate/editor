import Foundation

/**
 * Pure-Swift ZIP archive reader (`import/zip.ts` and `brushes/import/zip.ts`)
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

public struct ZlibError: Error, CustomStringConvertible, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
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

// MARK: - ZIP Types & Constants

public let DEFAULT_ZIP_MAX_ENTRIES = 10_000
public let DEFAULT_ZIP_MAX_TOTAL_SIZE = 256 * 1024 * 1024

public enum ZipUnsafePaths: String, Sendable, Equatable {
    case reject
    case allow
}

public struct ZipReadOptions: Sendable, Equatable {
    public var maxEntries: Int?
    public var maxTotalSize: Int?
    public var unsafePaths: ZipUnsafePaths?

    public init(
        maxEntries: Int? = nil,
        maxTotalSize: Int? = nil,
        unsafePaths: ZipUnsafePaths? = nil
    ) {
        self.maxEntries = maxEntries
        self.maxTotalSize = maxTotalSize
        self.unsafePaths = unsafePaths
    }
}

public enum ZipErrorCode: String, Sendable, Equatable {
    case invalidArchive = "invalid_archive"
    case unsupportedFeature = "unsupported_feature"
    case encrypted = "encrypted"
    case unsafePath = "unsafe_path"
    case tooManyEntries = "too_many_entries"
    case tooLarge = "too_large"
    case corruptEntry = "corrupt_entry"
    case entryNotFound = "entry_not_found"
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

    public init(_ message: String) {
        self.code = .invalidArchive
        self.message = message
        self.entryName = nil
    }

    public var errorDescription: String? { message }
    public var description: String { message }
}

private let LOCAL_FILE_HEADER_SIG: UInt32 = 0x0403_4B50
private let CENTRAL_DIR_HEADER_SIG: UInt32 = 0x0201_4B50
private let EOCD_SIG: UInt32 = 0x0605_4B50
private let ZIP64_EOCD_SIG: UInt32 = 0x0606_4B50
private let ZIP64_LOCATOR_SIG: UInt32 = 0x0706_4B50
private let ZIP64_EXTRA_ID: UInt16 = 0x0001
private let MAX_EOCD_COMMENT_BYTES = 0xFFFF
private let EOCD_MIN_BYTES = 22
private let ZIP64_LOCATOR_BYTES = 20
private let ZIP64_EOCD_MIN_BYTES = 56
private let CENTRAL_DIR_FIXED_BYTES = 46
private let LOCAL_HEADER_FIXED_BYTES = 30

private let METHOD_STORED = 0
private let METHOD_DEFLATE = 8
private let METHOD_AES = 99

private let FLAG_ENCRYPTED = 0x0001
private let FLAG_STRONG_ENCRYPTED = 0x0040
private let FLAG_UTF8 = 0x0800

/// Code Page 437 upper half (0x80–0xFF), the legacy default encoding for ZIP filenames.
private let CP437_HIGH: [Character] = Array(
    "\u{00C7}\u{00FC}\u{00E9}\u{00E2}\u{00E4}\u{00E0}\u{00E5}\u{00E7}" +
    "\u{00EA}\u{00EB}\u{00E8}\u{00EF}\u{00EE}\u{00EC}\u{00C4}\u{00C5}" +
    "\u{00C9}\u{00E6}\u{00C6}\u{00F4}\u{00F6}\u{00F2}\u{00FB}\u{00F9}" +
    "\u{00FF}\u{00D6}\u{00DC}\u{00A2}\u{00A3}\u{00A5}\u{20A7}\u{0192}" +
    "\u{00E1}\u{00ED}\u{00F3}\u{00FA}\u{00F1}\u{00D1}\u{00AA}\u{00BA}" +
    "\u{00BF}\u{2310}\u{00AC}\u{00BD}\u{00BC}\u{00A1}\u{00AB}\u{00BB}" +
    "\u{2591}\u{2592}\u{2593}\u{2502}\u{2524}\u{2561}\u{2562}\u{2556}" +
    "\u{2555}\u{2563}\u{2551}\u{2557}\u{255D}\u{255C}\u{255B}\u{2510}" +
    "\u{2514}\u{2534}\u{252C}\u{251C}\u{2500}\u{253C}\u{255E}\u{255F}" +
    "\u{255A}\u{2554}\u{2569}\u{2566}\u{2560}\u{2550}\u{256C}\u{2567}" +
    "\u{2568}\u{2564}\u{2565}\u{2559}\u{2558}\u{2552}\u{2553}\u{256B}" +
    "\u{256A}\u{2518}\u{250C}\u{2588}\u{2584}\u{258C}\u{2590}\u{2580}" +
    "\u{03B1}\u{00DF}\u{0393}\u{03C0}\u{03A3}\u{03C3}\u{00B5}\u{03C4}" +
    "\u{03A6}\u{0398}\u{03A9}\u{03B4}\u{221E}\u{03C6}\u{03B5}\u{2229}" +
    "\u{2261}\u{00B1}\u{2265}\u{2264}\u{2320}\u{2321}\u{00F7}\u{2248}" +
    "\u{00B0}\u{2219}\u{00B7}\u{221A}\u{207F}\u{00B2}\u{25A0}\u{00A0}"
)

private let CRC32_TABLE: [UInt32] = {
    var table = [UInt32](repeating: 0, count: 256)
    for i in 0..<256 {
        var c = UInt32(i)
        for _ in 0..<8 {
            c = (c & 1) != 0 ? (0xEDB8_8320 ^ (c >> 1)) : (c >> 1)
        }
        table[i] = c
    }
    return table
}()

/// Computes the standard IEEE 802.3 CRC-32 checksum over `data` (`import/zip.ts`).
public func zipCrc32(_ data: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0xFFFF_FFFF
    for b in data {
        crc = CRC32_TABLE[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8)
    }
    return crc ^ 0xFFFF_FFFF
}

/// Returns `true` when `name` is not a safe relative archive path (`import/zip.ts`).
public func isUnsafeZipPath(_ name: String) -> Bool {
    if name.isEmpty { return true }
    for code in name.utf16 {
        if code == 0 || code < 0x20 || code == 0x7F { return true }
    }
    if name.hasPrefix("/") || name.hasPrefix("\\") { return true }
    let chars = Array(name)
    if chars.count >= 2 && chars[1] == ":" && ((chars[0] >= "a" && chars[0] <= "z") || (chars[0] >= "A" && chars[0] <= "Z")) {
        return true
    }
    let parts = name.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }
    for part in parts where part == ".." {
        return true
    }
    return false
}

private func decodeEntryName(_ bytes: ArraySlice<UInt8>, utf8: Bool) -> String {
    if utf8 {
        return String(decoding: bytes, as: UTF8.self)
    }
    var out = ""
    out.reserveCapacity(bytes.count)
    for b in bytes {
        if b < 0x80 {
            out.unicodeScalars.append(UnicodeScalar(b))
        } else {
            out.append(CP437_HIGH[Int(b - 0x80)])
        }
    }
    return out
}

/// A byte, or 0 past the end (as JavaScript's `undefined` reads in bit operations).
@inline(__always) public func byteAt(_ b: [UInt8], _ p: Int) -> Int {
    p >= 0 && p < b.count ? Int(b[p]) : 0
}

@inline(__always) private func u16le(_ b: [UInt8], _ p: Int) -> Int {
    byteAt(b, p) | (byteAt(b, p + 1) << 8)
}

@inline(__always) private func u32le(_ b: [UInt8], _ p: Int) -> UInt32 {
    UInt32(byteAt(b, p)) |
        (UInt32(byteAt(b, p + 1)) << 8) |
        (UInt32(byteAt(b, p + 2)) << 16) |
        (UInt32(byteAt(b, p + 3)) << 24)
}

@inline(__always) private func u64le(_ b: [UInt8], _ p: Int, label: String, entryName: String? = nil) throws -> Int {
    let lo = u32le(b, p)
    let hi = u32le(b, p + 4)
    if hi > 0x001F_FFFF {
        throw ZipError(
            .tooLarge,
            "ZIP64 field \"\(label)\" exceeds JavaScript safe integer range.",
            entryName: entryName
        )
    }
    return Int(hi) * 0x1_0000_0000 + Int(lo)
}

// MARK: - ZipEntry & ZipArchive

/// Metadata for a single file entry inside a ZIP archive.
public final class ZipEntry {
    /// Entry path normalized to forward slashes (`/`), with any leading `./` stripped.
    public let name: String
    /// Compressed byte size inside the archive.
    public let compressedSize: Int
    /// Uncompressed byte size once extracted.
    public let uncompressedSize: Int
    /// Uncompressed size alias (`brushes/import/zip.ts` compatibility).
    public var size: Int { uncompressedSize }
    /// ZIP compression method (`0` = stored, `8` = deflate).
    public let compressionMethod: Int
    /// Expected CRC-32 checksum of the uncompressed payload.
    public let crc32: UInt32

    private let bytes: [UInt8]
    private let start: Int
    private var cached: [UInt8]?

    public init(
        name: String,
        compressedSize: Int,
        uncompressedSize: Int,
        compressionMethod: Int,
        crc32: UInt32 = 0,
        bytes: [UInt8] = [],
        start: Int = 0
    ) {
        self.name = name
        self.compressedSize = compressedSize
        self.uncompressedSize = uncompressedSize
        self.compressionMethod = compressionMethod
        self.crc32 = crc32
        self.bytes = bytes
        self.start = start
    }

    /// Reads the entry's bytes (`brushes/import/zip.ts` compatibility).
    public func read() throws -> [UInt8] {
        if let cached { return cached }
        let raw = Array(bytes[start..<(start + compressedSize)])
        let out: [UInt8]
        if compressionMethod == 0 {
            out = raw
        } else {
            do {
                out = try inflateRaw(raw, maxOutput: Swift.max(uncompressedSize, 1), sizeHint: uncompressedSize)
            } catch {
                throw ZipError("\"\(name)\" can't be inflated: \(error).")
            }
        }
        if out.count != uncompressedSize {
            throw ZipError("\"\(name)\" unpacked to \(out.count) bytes, not the \(uncompressedSize) its directory says.")
        }
        cached = out
        return out
    }
}

private struct InternalEntryRecord {
    var name: String
    var compressedSize: Int
    var uncompressedSize: Int
    var compressionMethod: Int
    var crc32: UInt32
    var localHeaderOffset: Int
}

/// A parsed ZIP archive allowing on-demand extraction of individual entries (`import/zip.ts`).
public final class ZipArchive {
    /// All file entries (directory entries are omitted), in central-directory order.
    public let entries: [ZipEntry]
    private let bytes: [UInt8]
    private let maxTotalSize: Int
    private let byName: [String: InternalEntryRecord]
    private var cache: [String: [UInt8]] = [:]

    fileprivate init(
        entries: [ZipEntry],
        bytes: [UInt8],
        maxTotalSize: Int,
        byName: [String: InternalEntryRecord]
    ) {
        self.entries = entries
        self.bytes = bytes
        self.maxTotalSize = maxTotalSize
        self.byName = byName
    }

    /// Returns `true` if the archive contains a file entry with `name`.
    public func has(_ name: String) -> Bool {
        byName[name] != nil
    }

    /// Look up metadata for `name`, or `nil` if not present.
    public func entry(_ name: String) -> ZipEntry? {
        guard let rec = byName[name] else { return nil }
        return ZipEntry(
            name: rec.name,
            compressedSize: rec.compressedSize,
            uncompressedSize: rec.uncompressedSize,
            compressionMethod: rec.compressionMethod,
            crc32: rec.crc32
        )
    }

    /// Decompress, CRC-verify, and return the raw bytes of `name`.
    public func read(_ name: String) throws -> [UInt8] {
        guard let rec = byName[name] else {
            throw ZipError(.entryNotFound, "ZIP entry not found: \"\(name)\".", entryName: name)
        }
        if let cached = cache[name] {
            return cached
        }
        let extracted = try extractEntry(bytes: bytes, record: rec, maxTotalSize: maxTotalSize)
        cache[name] = extracted
        return extracted
    }

    /// Decompress, CRC-verify, and UTF-8 decode `name`.
    public func readText(_ name: String) throws -> String {
        let raw = try read(name)
        return String(decoding: raw, as: UTF8.self)
    }
}

// MARK: - Central Directory & Extraction

private func findEocd(_ bytes: [UInt8]) throws -> Int {
    if bytes.count < EOCD_MIN_BYTES {
        throw ZipError(.invalidArchive, "File is too small to be a ZIP archive (\(bytes.count) bytes).")
    }
    let minOffset = Swift.max(0, bytes.count - (EOCD_MIN_BYTES + MAX_EOCD_COMMENT_BYTES))
    var pos = bytes.count - EOCD_MIN_BYTES
    while pos >= minOffset {
        if u32le(bytes, pos) == EOCD_SIG {
            let commentLength = u16le(bytes, pos + 20)
            if pos + EOCD_MIN_BYTES + commentLength <= bytes.count {
                return pos
            }
        }
        pos -= 1
    }
    if bytes.count >= 4 && u32le(bytes, 0) == LOCAL_FILE_HEADER_SIG {
        throw ZipError(.invalidArchive, "ZIP archive appears to be truncated (missing end-of-central-directory record).")
    }
    throw ZipError(.invalidArchive, "Data is not a valid ZIP archive (missing end-of-central-directory signature).")
}

private func readCentralDirectoryLocation(_ bytes: [UInt8], eocdOffset: Int) throws -> (totalEntries: Int, cdSize: Int, cdOffset: Int) {
    let diskNumber = u16le(bytes, eocdOffset + 4)
    let cdDisk = u16le(bytes, eocdOffset + 6)
    let diskEntries = u16le(bytes, eocdOffset + 8)
    var totalEntries = u16le(bytes, eocdOffset + 10)
    let cdSize32 = u32le(bytes, eocdOffset + 12)
    let cdOffset32 = u32le(bytes, eocdOffset + 16)
    var cdSize = Int(cdSize32)
    var cdOffset = Int(cdOffset32)

    let locatorCandidate = eocdOffset - ZIP64_LOCATOR_BYTES
    let hasZip64Locator = locatorCandidate >= 0 && u32le(bytes, locatorCandidate) == ZIP64_LOCATOR_SIG

    if hasZip64Locator {
        let z64Disk = u32le(bytes, locatorCandidate + 4)
        let z64TotalDisks = u32le(bytes, locatorCandidate + 16)
        if z64Disk != 0 || z64TotalDisks > 1 {
            throw ZipError(.unsupportedFeature, "Multi-disk ZIP archives are not supported.")
        }
        let z64EocdOffset = try u64le(bytes, locatorCandidate + 8, label: "zip64EocdOffset")
        if z64EocdOffset < 0 || z64EocdOffset + ZIP64_EOCD_MIN_BYTES > locatorCandidate {
            throw ZipError(.invalidArchive, "ZIP64 end-of-central-directory record is out of bounds.")
        }
        if u32le(bytes, z64EocdOffset) != ZIP64_EOCD_SIG {
            throw ZipError(.invalidArchive, "ZIP64 end-of-central-directory signature mismatch.")
        }
        let z64DiskNumber = u32le(bytes, z64EocdOffset + 16)
        let z64CdDisk = u32le(bytes, z64EocdOffset + 20)
        if z64DiskNumber != 0 || z64CdDisk != 0 {
            throw ZipError(.unsupportedFeature, "Multi-disk ZIP archives are not supported.")
        }
        let z64DiskEntries = try u64le(bytes, z64EocdOffset + 24, label: "zip64DiskEntries")
        totalEntries = try u64le(bytes, z64EocdOffset + 32, label: "zip64TotalEntries")
        if z64DiskEntries != totalEntries {
            throw ZipError(.unsupportedFeature, "Multi-disk ZIP archives are not supported.")
        }
        cdSize = try u64le(bytes, z64EocdOffset + 40, label: "zip64CdSize")
        cdOffset = try u64le(bytes, z64EocdOffset + 48, label: "zip64CdOffset")
    } else {
        if diskNumber != 0 || cdDisk != 0 || diskEntries != totalEntries {
            throw ZipError(.unsupportedFeature, "Multi-disk ZIP archives are not supported.")
        }
        if totalEntries == 0xFFFF || cdSize32 == 0xFFFF_FFFF || cdOffset32 == 0xFFFF_FFFF {
            throw ZipError(.invalidArchive, "ZIP archive requires ZIP64 records, but the ZIP64 locator is missing.")
        }
    }

    if cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > eocdOffset {
        throw ZipError(.invalidArchive, "ZIP central directory extends past the end-of-central-directory record.")
    }
    return (totalEntries, cdSize, cdOffset)
}

private func resolveZip64Fields(
    _ bytes: [UInt8],
    extraStart: Int,
    extraLen: Int,
    entryName: String,
    uncompressedSize: Int,
    compressedSize: Int,
    localHeaderOffset: Int,
    diskNumberStart: Int,
    needUncomp: Bool,
    needComp: Bool,
    needOffset: Bool,
    needDisk: Bool
) throws -> (uncompressedSize: Int, compressedSize: Int, localHeaderOffset: Int, diskNumberStart: Int) {
    let end = extraStart + extraLen
    var pos = extraStart
    while pos + 4 <= end {
        let headerId = UInt16(u16le(bytes, pos))
        let dataSize = u16le(bytes, pos + 2)
        let fieldStart = pos + 4
        let fieldEnd = fieldStart + dataSize
        if fieldEnd > end { break }
        if headerId == ZIP64_EXTRA_ID {
            var cursor = fieldStart
            var uncomp = uncompressedSize
            var comp = compressedSize
            var offset = localHeaderOffset
            var disk = diskNumberStart
            if needUncomp {
                if cursor + 8 > fieldEnd {
                    throw ZipError(.invalidArchive, "ZIP64 extra field for \"\(entryName)\" is truncated.", entryName: entryName)
                }
                uncomp = try u64le(bytes, cursor, label: "uncompressedSize", entryName: entryName)
                cursor += 8
            }
            if needComp {
                if cursor + 8 > fieldEnd {
                    throw ZipError(.invalidArchive, "ZIP64 extra field for \"\(entryName)\" is truncated.", entryName: entryName)
                }
                comp = try u64le(bytes, cursor, label: "compressedSize", entryName: entryName)
                cursor += 8
            }
            if needOffset {
                if cursor + 8 > fieldEnd {
                    throw ZipError(.invalidArchive, "ZIP64 extra field for \"\(entryName)\" is truncated.", entryName: entryName)
                }
                offset = try u64le(bytes, cursor, label: "localHeaderOffset", entryName: entryName)
                cursor += 8
            }
            if needDisk {
                if cursor + 4 > fieldEnd {
                    throw ZipError(.invalidArchive, "ZIP64 extra field for \"\(entryName)\" is truncated.", entryName: entryName)
                }
                disk = Int(u32le(bytes, cursor))
            }
            return (uncomp, comp, offset, disk)
        }
        pos = fieldEnd
    }
    throw ZipError(.invalidArchive, "ZIP entry \"\(entryName)\" requires a ZIP64 extended information field, which is missing.", entryName: entryName)
}

private func extractEntry(bytes: [UInt8], record: InternalEntryRecord, maxTotalSize: Int) throws -> [UInt8] {
    let lhOffset = record.localHeaderOffset
    if lhOffset < 0 || lhOffset + LOCAL_HEADER_FIXED_BYTES > bytes.count {
        throw ZipError(.corruptEntry, "ZIP entry \"\(record.name)\" has an invalid local file header.", entryName: record.name)
    }
    if u32le(bytes, lhOffset) != LOCAL_FILE_HEADER_SIG {
        throw ZipError(.corruptEntry, "ZIP entry \"\(record.name)\" has an invalid local file header.", entryName: record.name)
    }
    let localFlags = u16le(bytes, lhOffset + 6)
    let localMethod = u16le(bytes, lhOffset + 8)
    if (localFlags & FLAG_ENCRYPTED) != 0 || (localFlags & FLAG_STRONG_ENCRYPTED) != 0 || localMethod == METHOD_AES {
        throw ZipError(.encrypted, "ZIP entry \"\(record.name)\" is encrypted; password-protected archives are not supported.", entryName: record.name)
    }
    let localNameLen = u16le(bytes, lhOffset + 26)
    let localExtraLen = u16le(bytes, lhOffset + 28)
    let dataStart = lhOffset + LOCAL_HEADER_FIXED_BYTES + localNameLen + localExtraLen
    let dataEnd = dataStart + record.compressedSize
    if dataStart < 0 || dataEnd > bytes.count {
        throw ZipError(.corruptEntry, "ZIP entry \"\(record.name)\" compressed data is truncated.", entryName: record.name)
    }
    let raw = Array(bytes[dataStart..<dataEnd])
    let output: [UInt8]
    if record.compressionMethod == METHOD_STORED {
        if record.compressedSize != record.uncompressedSize {
            throw ZipError(
                .corruptEntry,
                "Stored ZIP entry \"\(record.name)\" has mismatched sizes (\(record.compressedSize) vs \(record.uncompressedSize)).",
                entryName: record.name
            )
        }
        output = raw
    } else if record.compressionMethod == METHOD_DEFLATE {
        let limit = Swift.min(maxTotalSize, Swift.max(record.uncompressedSize, 0))
        do {
            output = try inflateRaw(raw, maxOutput: limit, sizeHint: record.uncompressedSize)
        } catch let err as ZlibError {
            if err.message.hasPrefix("Decompressed data exceeds ") {
                throw ZipError(
                    .corruptEntry,
                    "ZIP entry \"\(record.name)\" inflates beyond its declared size of \(limit) bytes.",
                    entryName: record.name
                )
            }
            throw ZipError(.corruptEntry, "ZIP entry \"\(record.name)\" has an invalid deflate stream.", entryName: record.name)
        } catch {
            throw ZipError(.corruptEntry, "ZIP entry \"\(record.name)\" has an invalid deflate stream.", entryName: record.name)
        }
        if output.count != record.uncompressedSize {
            throw ZipError(
                .corruptEntry,
                "ZIP entry \"\(record.name)\" decompressed to \(output.count) bytes, expected \(record.uncompressedSize).",
                entryName: record.name
            )
        }
    } else {
        throw ZipError(
            .unsupportedFeature,
            "ZIP entry \"\(record.name)\" uses unsupported compression method \(record.compressionMethod).",
            entryName: record.name
        )
    }

    let actualCrc = zipCrc32(output)
    if actualCrc != record.crc32 {
        let expectedHex = String(record.crc32, radix: 16, uppercase: false)
        let actualHex = String(actualCrc, radix: 16, uppercase: false)
        let padExpected = String(repeating: "0", count: Swift.max(0, 8 - expectedHex.count)) + expectedHex
        let padActual = String(repeating: "0", count: Swift.max(0, 8 - actualHex.count)) + actualHex
        throw ZipError(
            .corruptEntry,
            "ZIP entry \"\(record.name)\" failed CRC-32 verification (expected 0x\(padExpected), got 0x\(padActual)).",
            entryName: record.name
        )
    }
    return output
}

/// Parses a ZIP archive's central directory and returns a `ZipArchive` handle (`import/zip.ts`).
public func readZipArchive(_ bytes: [UInt8], options: ZipReadOptions = ZipReadOptions()) throws -> ZipArchive {
    let maxEntries = options.maxEntries ?? DEFAULT_ZIP_MAX_ENTRIES
    let maxTotalSize = options.maxTotalSize ?? DEFAULT_ZIP_MAX_TOTAL_SIZE
    let rejectUnsafe = (options.unsafePaths ?? .reject) != .allow
    if maxEntries < 0 {
        throw ZipError(.invalidArchive, "Invalid maxEntries option: \(maxEntries).")
    }
    if maxTotalSize < 0 {
        throw ZipError(.invalidArchive, "Invalid maxTotalSize option: \(maxTotalSize).")
    }
    let eocdOffset = try findEocd(bytes)
    let loc = try readCentralDirectoryLocation(bytes, eocdOffset: eocdOffset)
    if loc.totalEntries > maxEntries {
        throw ZipError(
            .tooManyEntries,
            "ZIP archive contains \(loc.totalEntries) entries, exceeding limit of \(maxEntries)."
        )
    }
    var records: [InternalEntryRecord] = []
    var byName: [String: InternalEntryRecord] = [:]
    var totalUncompressed = 0
    var offset = loc.cdOffset
    let cdEnd = loc.cdOffset + loc.cdSize

    for i in 0..<loc.totalEntries {
        if offset + CENTRAL_DIR_FIXED_BYTES > cdEnd {
            throw ZipError(.invalidArchive, "Central directory truncated at entry \(i) of \(loc.totalEntries).")
        }
        if u32le(bytes, offset) != CENTRAL_DIR_HEADER_SIG {
            throw ZipError(.invalidArchive, "Invalid central directory file header signature at entry \(i).")
        }
        let flags = u16le(bytes, offset + 8)
        let compressionMethod = u16le(bytes, offset + 10)
        let crc32 = u32le(bytes, offset + 16)
        let comp32 = u32le(bytes, offset + 20)
        let uncomp32 = u32le(bytes, offset + 24)
        var compressedSize = Int(comp32)
        var uncompressedSize = Int(uncomp32)
        let nameLen = u16le(bytes, offset + 28)
        let extraLen = u16le(bytes, offset + 30)
        let commentLen = u16le(bytes, offset + 32)
        var diskNumberStart = u16le(bytes, offset + 34)
        let lhOffset32 = u32le(bytes, offset + 42)
        var localHeaderOffset = Int(lhOffset32)

        let nameStart = offset + CENTRAL_DIR_FIXED_BYTES
        let extraStart = nameStart + nameLen
        let headerEnd = extraStart + extraLen + commentLen
        if headerEnd > cdEnd {
            throw ZipError(.invalidArchive, "Central directory entry \(i) extends past central directory bounds.")
        }
        let utf8 = (flags & FLAG_UTF8) != 0
        let rawName = decodeEntryName(bytes[nameStart..<(nameStart + nameLen)], utf8: utf8)
        let isDirectoryEntry = rawName.hasSuffix("/") || (rawName.hasSuffix("\\") && !rawName.contains("/"))
        var normalizedName = rawName.replacingOccurrences(of: "\\", with: "/")
        if isDirectoryEntry {
            offset = headerEnd
            continue
        }
        if rejectUnsafe && isUnsafeZipPath(normalizedName) {
            throw ZipError(.unsafePath, "ZIP entry has an unsafe path: \"\(normalizedName)\".", entryName: normalizedName)
        }
        while normalizedName.hasPrefix("./") {
            normalizedName.removeFirst(2)
        }
        if normalizedName.isEmpty {
            offset = headerEnd
            continue
        }
        if (flags & FLAG_ENCRYPTED) != 0 || (flags & FLAG_STRONG_ENCRYPTED) != 0 || compressionMethod == METHOD_AES {
            throw ZipError(
                .encrypted,
                "ZIP entry \"\(normalizedName)\" is encrypted; password-protected archives are not supported.",
                entryName: normalizedName
            )
        }
        if compressionMethod != METHOD_STORED && compressionMethod != METHOD_DEFLATE {
            throw ZipError(
                .unsupportedFeature,
                "ZIP entry \"\(normalizedName)\" uses unsupported compression method \(compressionMethod).",
                entryName: normalizedName
            )
        }
        if uncomp32 == 0xFFFF_FFFF || comp32 == 0xFFFF_FFFF || lhOffset32 == 0xFFFF_FFFF || diskNumberStart == 0xFFFF {
            let z64 = try resolveZip64Fields(
                bytes,
                extraStart: extraStart,
                extraLen: extraLen,
                entryName: normalizedName,
                uncompressedSize: uncompressedSize,
                compressedSize: compressedSize,
                localHeaderOffset: localHeaderOffset,
                diskNumberStart: diskNumberStart,
                needUncomp: uncomp32 == 0xFFFF_FFFF,
                needComp: comp32 == 0xFFFF_FFFF,
                needOffset: lhOffset32 == 0xFFFF_FFFF,
                needDisk: diskNumberStart == 0xFFFF
            )
            uncompressedSize = z64.uncompressedSize
            compressedSize = z64.compressedSize
            localHeaderOffset = z64.localHeaderOffset
            diskNumberStart = z64.diskNumberStart
        }
        if diskNumberStart != 0 {
            throw ZipError(.unsupportedFeature, "Multi-disk ZIP archives are not supported.", entryName: normalizedName)
        }
        if uncompressedSize > maxTotalSize {
            throw ZipError(
                .tooLarge,
                "ZIP entry \"\(normalizedName)\" uncompressed size (\(uncompressedSize) bytes) exceeds limit of \(maxTotalSize) bytes.",
                entryName: normalizedName
            )
        }
        totalUncompressed += uncompressedSize
        if totalUncompressed > maxTotalSize {
            throw ZipError(
                .tooLarge,
                "Total uncompressed ZIP size (\(totalUncompressed) bytes) exceeds limit of \(maxTotalSize) bytes.",
                entryName: normalizedName
            )
        }
        let rec = InternalEntryRecord(
            name: normalizedName,
            compressedSize: compressedSize,
            uncompressedSize: uncompressedSize,
            compressionMethod: compressionMethod,
            crc32: crc32,
            localHeaderOffset: localHeaderOffset
        )
        if byName[normalizedName] != nil {
            if let existingIdx = records.firstIndex(where: { $0.name == normalizedName }) {
                records[existingIdx] = rec
            }
        } else {
            records.append(rec)
        }
        byName[normalizedName] = rec
        offset = headerEnd
    }

    let entries = records.map { r in
        ZipEntry(
            name: r.name,
            compressedSize: r.compressedSize,
            uncompressedSize: r.uncompressedSize,
            compressionMethod: r.compressionMethod,
            crc32: r.crc32
        )
    }
    return ZipArchive(entries: entries, bytes: bytes, maxTotalSize: maxTotalSize, byName: byName)
}

public func readZip(_ bytes: [UInt8], options: ZipReadOptions) throws -> ZipArchive {
    try readZipArchive(bytes, options: options)
}

/// Whether the bytes start like a ZIP archive (`brushes/import/zip.ts`).
public func isZip(_ b: [UInt8]) -> Bool {
    b.count >= 22 && b[0] == 0x50 && b[1] == 0x4B && (b[2] == 3 || b[2] == 5) && (b[3] == 4 || b[3] == 6)
}

/// The entries of a ZIP archive (directories left out), matching `brushes/import/zip.ts`.
public func readZip(
    _ bytes: [UInt8],
    maxEntries: Int = 4096,
    maxEntrySize: Int = 64 * 1024 * 1024,
    maxTotalSize: Int = 512 * 1024 * 1024
) throws -> [ZipEntry] {
    var eocd = -1
    var p = bytes.count - 22
    while p >= Swift.max(0, bytes.count - 22 - 0xFFFF) {
        if u32le(bytes, p) == EOCD_SIG {
            eocd = p
            break
        }
        p -= 1
    }
    if eocd < 0 { throw ZipError("Not a ZIP archive: no end of central directory.") }
    let count = u16le(bytes, eocd + 10)
    let dirSize = Int(u32le(bytes, eocd + 12))
    let dirOffset32 = u32le(bytes, eocd + 16)
    let dirOffset = Int(dirOffset32)
    if count == 0xFFFF || dirOffset32 == 0xFFFF_FFFF { throw ZipError("ZIP64 archives are not supported.") }
    if count > maxEntries { throw ZipError("The archive has \(count) entries; at most \(maxEntries) are read.") }
    if dirOffset + dirSize > eocd { throw ZipError("The ZIP central directory is out of bounds.") }
    var entries: [ZipEntry] = []
    var total = 0
    p = dirOffset
    for i in 0..<count {
        if p + 46 > eocd || u32le(bytes, p) != CENTRAL_DIR_HEADER_SIG {
            throw ZipError("ZIP directory entry \(i) is malformed.")
        }
        let flags = u16le(bytes, p + 8)
        let method = u16le(bytes, p + 10)
        let crc = u32le(bytes, p + 16)
        let csize = Int(u32le(bytes, p + 20))
        let size = Int(u32le(bytes, p + 24))
        let nameLen = u16le(bytes, p + 28)
        let extraLen = u16le(bytes, p + 30)
        let commentLen = u16le(bytes, p + 32)
        let local = Int(u32le(bytes, p + 42))
        if p + 46 + nameLen > eocd { throw ZipError("ZIP directory entry \(i) is malformed.") }
        let name = String(decoding: bytes[(p + 46)..<(p + 46 + nameLen)], as: UTF8.self)
            .replacingOccurrences(of: "\\", with: "/")
        p += 46 + nameLen + extraLen + commentLen
        if name.hasSuffix("/") { continue }
        if flags & 1 != 0 { throw ZipError("\"\(name)\" is encrypted; encrypted archives are not supported.") }
        if method != 0 && method != 8 {
            throw ZipError("\"\(name)\" uses compression method \(method); only stored and deflated files are read.")
        }
        if size > maxEntrySize {
            throw ZipError("\"\(name)\" is \(size) bytes; files over \(maxEntrySize) bytes are not read.")
        }
        total += size
        if total > maxTotalSize { throw ZipError("The archive unpacks to more than \(maxTotalSize) bytes.") }
        if local + 30 > bytes.count || u32le(bytes, local) != LOCAL_FILE_HEADER_SIG {
            throw ZipError("\"\(name)\" has no local header.")
        }
        let start = local + 30 + u16le(bytes, local + 26) + u16le(bytes, local + 28)
        if start + csize > bytes.count { throw ZipError("\"\(name)\" runs past the end of the archive.") }
        entries.append(ZipEntry(
            name: name,
            compressedSize: csize,
            uncompressedSize: size,
            compressionMethod: method,
            crc32: crc,
            bytes: bytes,
            start: start
        ))
    }
    return entries
}
