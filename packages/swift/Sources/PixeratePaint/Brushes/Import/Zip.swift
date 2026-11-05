import Foundation
import PixerateRaster

/**
 * A small, defensive ZIP reader for brush packs (`brushes/import/zip.ts`): the central directory,
 * stored and deflated entries, and nothing else (no encryption, no ZIP64, no multi-disk). Brush
 * packs are untrusted files, so every offset and size is checked against the buffer and against
 * limits before anything is read or inflated.
 */

public struct ZipError: Error, LocalizedError {
    public let message: String
    init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// One file in the archive.
public final class ZipEntry {
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
        let out: [UInt8]
        if method == 0 { out = raw } else {
            do { out = try inflateRaw(raw, maxOutput: Swift.max(size, 1), sizeHint: size) } catch { throw ZipError("\"\(name)\" can't be inflated: \(error).") }
        }
        if out.count != size { throw ZipError("\"\(name)\" unpacked to \(out.count) bytes, not the \(size) its directory says.") }
        cached = out
        return out
    }
}

/// A byte, or 0 past the end (as JavaScript's `undefined` reads in bit operations).
@inline(__always) func byteAt(_ b: [UInt8], _ p: Int) -> Int { p >= 0 && p < b.count ? Int(b[p]) : 0 }
private func u16le(_ b: [UInt8], _ p: Int) -> Int { byteAt(b, p) | (byteAt(b, p + 1) << 8) }
private func u32le(_ b: [UInt8], _ p: Int) -> Int { byteAt(b, p) | (byteAt(b, p + 1) << 8) | (byteAt(b, p + 2) << 16) | (byteAt(b, p + 3) << 24) }

/// Whether the bytes start like a ZIP archive.
public func isZip(_ b: [UInt8]) -> Bool {
    b.count >= 22 && b[0] == 0x50 && b[1] == 0x4B && (b[2] == 3 || b[2] == 5) && (b[3] == 4 || b[3] == 6)
}

/// The entries of a ZIP archive (directories left out). Throws a `ZipError` on anything malformed or over the limits.
public func readZip(_ bytes: [UInt8], maxEntries: Int = 4096, maxEntrySize: Int = 64 * 1024 * 1024, maxTotalSize: Int = 512 * 1024 * 1024) throws -> [ZipEntry] {
    // The end of central directory record: within the last 64 KB + 22 bytes.
    var eocd = -1
    var p = bytes.count - 22
    while p >= Swift.max(0, bytes.count - 22 - 0xFFFF) {
        if u32le(bytes, p) == 0x0605_4B50 {
            eocd = p
            break
        }
        p -= 1
    }
    if eocd < 0 { throw ZipError("Not a ZIP archive: no end of central directory.") }
    let count = u16le(bytes, eocd + 10)
    let dirSize = u32le(bytes, eocd + 12)
    let dirOffset = u32le(bytes, eocd + 16)
    if count == 0xFFFF || dirOffset == 0xFFFF_FFFF { throw ZipError("ZIP64 archives are not supported.") }
    if count > maxEntries { throw ZipError("The archive has \(count) entries; at most \(maxEntries) are read.") }
    if dirOffset + dirSize > eocd { throw ZipError("The ZIP central directory is out of bounds.") }
    var entries: [ZipEntry] = []
    var total = 0
    p = dirOffset
    for i in 0..<count {
        if p + 46 > eocd || u32le(bytes, p) != 0x0201_4B50 { throw ZipError("ZIP directory entry \(i) is malformed.") }
        let flags = u16le(bytes, p + 8)
        let method = u16le(bytes, p + 10)
        let csize = u32le(bytes, p + 20)
        let size = u32le(bytes, p + 24)
        let nameLen = u16le(bytes, p + 28)
        let extraLen = u16le(bytes, p + 30)
        let commentLen = u16le(bytes, p + 32)
        let local = u32le(bytes, p + 42)
        if p + 46 + nameLen > eocd { throw ZipError("ZIP directory entry \(i) is malformed.") }
        let name = String(decoding: bytes[(p + 46)..<(p + 46 + nameLen)], as: UTF8.self).replacingOccurrences(of: "\\", with: "/")
        p += 46 + nameLen + extraLen + commentLen
        if name.hasSuffix("/") { continue }
        if flags & 1 != 0 { throw ZipError("\"\(name)\" is encrypted; encrypted archives are not supported.") }
        if method != 0 && method != 8 { throw ZipError("\"\(name)\" uses compression method \(method); only stored and deflated files are read.") }
        if size > maxEntrySize { throw ZipError("\"\(name)\" is \(size) bytes; files over \(maxEntrySize) bytes are not read.") }
        total += size
        if total > maxTotalSize { throw ZipError("The archive unpacks to more than \(maxTotalSize) bytes.") }
        if local + 30 > bytes.count || u32le(bytes, local) != 0x0403_4B50 { throw ZipError("\"\(name)\" has no local header.") }
        let start = local + 30 + u16le(bytes, local + 26) + u16le(bytes, local + 28)
        if start + csize > bytes.count { throw ZipError("\"\(name)\" runs past the end of the archive.") }
        entries.append(ZipEntry(name: name, size: size, bytes: bytes, start: start, csize: csize, method: method))
    }
    return entries
}
