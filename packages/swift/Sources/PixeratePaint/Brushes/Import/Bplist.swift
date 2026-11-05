import Foundation

/**
 * A defensive reader for binary property lists (`bplist00`, `brushes/import/bplist.ts`), enough
 * for Procreate's `Brush.archive` (an `NSKeyedArchiver` archive): integers, reals, booleans,
 * strings, data, UIDs, arrays and dictionaries. Every offset is checked, the object graph is read
 * without following cycles, and its depth and size are limited, because brush packs are untrusted.
 */

/// A value read from a property list. Integers and reals are both numbers, as in JavaScript.
public indirect enum PlistValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case data([UInt8])
    case uid(Int)
    case array([PlistValue])
    case dict([String: PlistValue])

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
}

public struct PlistError: Error, LocalizedError {
    public let message: String
    init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

private let MAX_OBJECTS = 200_000
private let MAX_DEPTH = 64
/// Most objects read in all: a shared object is read again at each reference, so a small file could otherwise take very long.
private let MAX_READS = 1_000_000

/// Whether the bytes are a binary property list.
public func isBinaryPlist(_ b: [UInt8]) -> Bool { b.count >= 40 && Array(b[0..<8]) == Array("bplist00".utf8) }

/// The root object of a binary property list. Throws a `PlistError` when it is malformed.
public func readBinaryPlist(_ bytes: [UInt8]) throws -> PlistValue {
    if !isBinaryPlist(bytes) { throw PlistError("Not a binary property list.") }
    let t = bytes.count - 32
    let offsetSize = Int(bytes[t + 6])
    let refSize = Int(bytes[t + 7])
    // Read as a double, as JavaScript does, so 8-byte sizes can't overflow.
    func uint(_ p: Double, _ n: Int) throws -> Double {
        if p < 0 || p + Double(n) > Double(bytes.count) { throw PlistError("A property list offset is out of bounds.") }
        var v = 0.0
        for i in 0..<n { v = v * 256 + Double(bytes[Int(p) + i]) }
        return v
    }
    let count = try uint(Double(t + 8), 8)
    let top = try uint(Double(t + 16), 8)
    let tableAt = try uint(Double(t + 24), 8)
    if ![1, 2, 4, 8].contains(offsetSize) || ![1, 2, 4, 8].contains(refSize) { throw PlistError("The property list trailer is malformed.") }
    if count > Double(MAX_OBJECTS) || top >= count || tableAt + count * Double(offsetSize) > Double(t) { throw PlistError("The property list is malformed or too large.") }
    func offsetOf(_ i: Double) throws -> Int {
        if i >= count { throw PlistError("A property list reference is out of range.") }
        let o = try uint(tableAt + i * Double(offsetSize), offsetSize)
        if o >= tableAt { throw PlistError("A property list object is out of bounds.") }
        return Int(o)
    }
    var reading = Set<Double>()
    var reads = 0

    func read(_ index: Double, _ depth: Int) throws -> PlistValue {
        if depth > MAX_DEPTH { throw PlistError("The property list is nested too deeply.") }
        if reading.contains(index) { throw PlistError("The property list refers to itself.") }
        reads += 1
        if reads > MAX_READS { throw PlistError("The property list is malformed or too large.") }
        var p = try offsetOf(index)
        let marker = byteAt(bytes, p)
        let kind = marker >> 4
        let info = marker & 0xF
        p += 1
        // Lengths of 15 and more follow as an int object.
        func length() throws -> Int {
            if info != 0xF { return info }
            let m = byteAt(bytes, p)
            if m >> 4 != 1 { throw PlistError("A property list length is malformed.") }
            let n = 1 << (m & 0xF)
            let v = try uint(Double(p + 1), n)
            p += 1 + n
            if v > Double(bytes.count) { throw PlistError("A property list length is out of bounds.") }
            return Int(v)
        }
        func bigEndian(_ n: Int) throws -> UInt64 {
            if p + n > bytes.count { throw PlistError("A property list number is out of bounds.") }
            var v: UInt64 = 0
            for i in 0..<n { v = v << 8 | UInt64(bytes[p + i]) }
            return v
        }
        switch kind {
        case 0x0:
            return info == 8 ? .bool(false) : info == 9 ? .bool(true) : .null
        case 0x1:
            let n = 1 << info
            if n == 8 { return .number(Double(Int64(bitPattern: try bigEndian(8)))) }
            return .number(try uint(Double(p), n))
        case 0x2:
            let n = 1 << info
            if p + n > bytes.count { throw PlistError("A property list number is out of bounds.") }
            if n == 4 { return .number(Double(Float(bitPattern: UInt32(try bigEndian(4))))) }
            if n == 8 { return .number(Double(bitPattern: try bigEndian(8))) }
            return .number(0)
        case 0x3:
            return .number(p + 8 <= bytes.count ? Double(bitPattern: try bigEndian(8)) : 0)
        case 0x4:
            let n = try length()
            if p + n > bytes.count { throw PlistError("Property list data is out of bounds.") }
            return .data(Array(bytes[p..<(p + n)]))
        case 0x5:
            let n = try length()
            if p + n > bytes.count { throw PlistError("A property list string is out of bounds.") }
            return .string(String(String.UnicodeScalarView(bytes[p..<(p + n)].map { Unicode.Scalar($0) })))
        case 0x6:
            let n = try length()
            if p + n * 2 > bytes.count { throw PlistError("A property list string is out of bounds.") }
            return .string(String(decoding: (0..<n).map { UInt16(bytes[p + $0 * 2]) << 8 | UInt16(bytes[p + $0 * 2 + 1]) }, as: UTF16.self))
        case 0x8:
            return .uid(Int(Swift.min(try uint(Double(p), info + 1), Double(Int32.max))))
        case 0xA, 0xC:
            let n = try length()
            reading.insert(index)
            var out: [PlistValue] = []
            for i in 0..<n { out.append(try read(try uint(Double(p + i * refSize), refSize), depth + 1)) }
            reading.remove(index)
            return .array(out)
        case 0xD:
            let n = try length()
            reading.insert(index)
            var out: [String: PlistValue] = [:]
            for i in 0..<n {
                guard case .string(let key) = try read(try uint(Double(p + i * refSize), refSize), depth + 1) else { throw PlistError("A property list key is not a string.") }
                out[key] = try read(try uint(Double(p + (n + i) * refSize), refSize), depth + 1)
            }
            reading.remove(index)
            return .dict(out)
        default:
            throw PlistError("Property list object type \(String(kind, radix: 16)) is not supported.")
        }
    }
    return try read(top, 0)
}

/**
 * The root object of an `NSKeyedArchiver` archive with its UIDs resolved one level: each key of
 * the root maps to the archived value (strings and numbers as they are; `$null` as null).
 */
public func keyedArchiveRoot(_ plist: PlistValue) -> [String: PlistValue]? {
    guard case .dict(let top) = plist, case .array(let objects)? = top["$objects"], case .dict(let t)? = top["$top"], case .uid(let root)? = t["root"] else { return nil }
    func at(_ v: PlistValue) -> PlistValue {
        if case .uid(let i) = v { return i >= 0 && i < objects.count ? objects[i] : .null }
        return v
    }
    guard case .dict(let obj) = at(.uid(root)) else { return nil }
    var out: [String: PlistValue] = [:]
    for (k, v) in obj {
        let value = at(v)
        out[k] = value == .string("$null") ? .null : value
    }
    return out
}
