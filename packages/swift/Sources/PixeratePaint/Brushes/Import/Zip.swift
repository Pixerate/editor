import Foundation
import PixerateCore

/**
 * A small, defensive ZIP reader for brush packs (`.brush`, `.brushset`): the central directory,
 * stored and deflated entries, and nothing else (no encryption, no ZIP64, no multi-disk). Brush
 * packs are untrusted files, so every offset and size is checked against the buffer and against
 * limits before anything is read or inflated (`brushes/import/zip.ts`).
 *
 * This is a separate reader from `PixerateCore.readZip` (`import/zip.ts`), as in the TS core: its
 * limits, messages and behaviour differ, and the brush importer depends on them.
 */

/// One file in a brush pack archive.
public final class BrushZipEntry {
    /// Its path in the archive (`/`-separated).
    public let name: String
    /// Uncompressed size, as the directory says.
    public let size: Int
    private let bytes: [UInt8]
    private let start: Int
    private let csize: Int
    private let method: Int
    private var cached: [UInt8]?

    init(name: String, size: Int, bytes: [UInt8], start: Int, csize: Int, method: Int) {
        self.name = name
        self.size = size
        self.bytes = bytes
        self.start = start
        self.csize = csize
        self.method = method
    }

    /// The file's bytes (inflated on first read).
    public func read() throws -> [UInt8] {
        if let cached { return cached }
        let raw = Array(bytes[start..<(start + csize)])
        let out = method == 0 ? raw : try inflateRaw(raw, maxOutput: Swift.max(size, 1), sizeHint: size)
        if out.count != size { throw BrushZipError("\"\(name)\" unpacked to \(out.count) bytes, not the \(size) its directory says.") }
        cached = out
        return out
    }
}

public struct BrushZipError: Error, LocalizedError, CustomStringConvertible, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

@inline(__always) private func u16(_ b: [UInt8], _ p: Int) -> Int { byteAt(b, p) | (byteAt(b, p + 1) << 8) }
@inline(__always) private func u32(_ b: [UInt8], _ p: Int) -> Int {
    byteAt(b, p) | (byteAt(b, p + 1) << 8) | (byteAt(b, p + 2) << 16) | (byteAt(b, p + 3) << 24)
}

/// Whether the bytes start like a ZIP archive.
public func isZip(_ b: [UInt8]) -> Bool {
    b.count >= 22 && b[0] == 0x50 && b[1] == 0x4B && (b[2] == 3 || b[2] == 5) && (b[3] == 4 || b[3] == 6)
}

/// The entries of a brush pack ZIP archive (directories left out). Throws a `BrushZipError` on anything
/// malformed or over the limits.
public func readBrushZip(
    _ bytes: [UInt8],
    maxEntries: Int = 4096,
    maxEntrySize: Int = 64 * 1024 * 1024,
    maxTotalSize: Int = 512 * 1024 * 1024
) throws -> [BrushZipEntry] {
    // The end of central directory record: within the last 64 KB + 22 bytes.
    var eocd = -1
    var p = bytes.count - 22
    while p >= Swift.max(0, bytes.count - 22 - 0xFFFF) {
        if u32(bytes, p) == 0x0605_4B50 {
            eocd = p
            break
        }
        p -= 1
    }
    if eocd < 0 { throw BrushZipError("Not a ZIP archive: no end of central directory.") }
    let count = u16(bytes, eocd + 10)
    let dirSize = u32(bytes, eocd + 12)
    let dirOffset = u32(bytes, eocd + 16)
    if count == 0xFFFF || dirOffset == 0xFFFF_FFFF { throw BrushZipError("ZIP64 archives are not supported.") }
    if count > maxEntries { throw BrushZipError("The archive has \(count) entries; at most \(maxEntries) are read.") }
    if dirOffset + dirSize > eocd { throw BrushZipError("The ZIP central directory is out of bounds.") }
    var entries: [BrushZipEntry] = []
    var total = 0
    p = dirOffset
    for i in 0..<count {
        if p + 46 > eocd || u32(bytes, p) != 0x0201_4B50 { throw BrushZipError("ZIP directory entry \(i) is malformed.") }
        let flags = u16(bytes, p + 8)
        let method = u16(bytes, p + 10)
        let csize = u32(bytes, p + 20)
        let size = u32(bytes, p + 24)
        let nameLen = u16(bytes, p + 28)
        let extraLen = u16(bytes, p + 30)
        let commentLen = u16(bytes, p + 32)
        let local = u32(bytes, p + 42)
        if p + 46 + nameLen > eocd { throw BrushZipError("ZIP directory entry \(i) is malformed.") }
        let decoded = String(decoding: bytes[(p + 46)..<(p + 46 + nameLen)], as: UTF8.self)
        let name = decoded.utf16.contains(0x5C) ? String(decoding: decoded.utf16.map { $0 == 0x5C ? 0x2F : $0 }, as: UTF16.self) : decoded
        p += 46 + nameLen + extraLen + commentLen
        if name.utf16.last == 0x2F { continue }
        if flags & 1 != 0 { throw BrushZipError("\"\(name)\" is encrypted; encrypted archives are not supported.") }
        if method != 0 && method != 8 {
            throw BrushZipError("\"\(name)\" uses compression method \(method); only stored and deflated files are read.")
        }
        if size > maxEntrySize { throw BrushZipError("\"\(name)\" is \(size) bytes; files over \(maxEntrySize) bytes are not read.") }
        total += size
        if total > maxTotalSize { throw BrushZipError("The archive unpacks to more than \(maxTotalSize) bytes.") }
        if local + 30 > bytes.count || u32(bytes, local) != 0x0403_4B50 { throw BrushZipError("\"\(name)\" has no local header.") }
        let start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
        if start + csize > bytes.count { throw BrushZipError("\"\(name)\" runs past the end of the archive.") }
        entries.append(BrushZipEntry(name: name, size: size, bytes: bytes, start: start, csize: csize, method: method))
    }
    return entries
}
