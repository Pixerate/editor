import Foundation

/// A JSON value. Objects keep their keys in JavaScript's order (integer keys ascending, then the
/// rest as inserted), so listings, validation messages and `stringified()` match the TypeScript
/// core byte for byte.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)
}

/// A JSON object with JavaScript's key order (see `JSONValue`).
public struct JSONObject: Equatable, Sendable, Sequence {
    private var order: [String] = []
    private var storage: [String: JSONValue] = [:]

    public init() {}

    public init(_ pairs: [(String, JSONValue)]) {
        for (k, v) in pairs { self[k] = v }
    }

    /// The keys in JavaScript's order: integer keys ascending, then the others as inserted.
    public var keys: [String] {
        let indices = order.filter(Self.isArrayIndex).sorted { UInt32($0)! < UInt32($1)! }
        return indices + order.filter { !Self.isArrayIndex($0) }
    }

    public var count: Int { order.count }
    public var isEmpty: Bool { order.isEmpty }

    public subscript(key: String) -> JSONValue? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { order.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                order.removeAll { $0 == key }
            }
        }
    }

    public func contains(_ key: String) -> Bool { storage[key] != nil }

    public func makeIterator() -> IndexingIterator<[(key: String, value: JSONValue)]> {
        keys.map { (key: $0, value: storage[$0]!) }.makeIterator()
    }

    /// Ordered comparison, as `JSON.stringify(a) === JSON.stringify(b)` compares.
    public static func == (a: JSONObject, b: JSONObject) -> Bool {
        a.keys == b.keys && a.keys.allSatisfy { a.storage[$0] == b.storage[$0] }
    }

    /// A canonical array index ("0", "1", … below 2³² − 1), which JavaScript lists first.
    static func isArrayIndex(_ key: String) -> Bool {
        guard !key.isEmpty, key.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return false }
        if key.count > 1 && key.hasPrefix("0") { return false }
        guard let n = UInt64(key) else { return false }
        return n < 4_294_967_295
    }
}

// MARK: - Literals

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(JSONObject(elements)) }
}

extension JSONObject: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self.init(elements) }
}

// MARK: - Accessors

extension JSONValue {
    public var objectValue: JSONObject? { if case .object(let o) = self { return o }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var isNull: Bool { self == .null }

    /// The member `key` of an object, or `nil`.
    public subscript(key: String) -> JSONValue? { objectValue?[key] }

    /// The value as `JSON.parse(JSON.stringify(value))` gives it back: NaN and ±Infinity (which a
    /// document may hold in memory, as TS objects do) become `null`; everything else is unchanged.
    public var asJSON: JSONValue {
        switch self {
        case .number(let n): return n.isFinite ? self : .null
        case .array(let a): return .array(a.map(\.asJSON))
        case .object(let o):
            var out = JSONObject()
            for (k, v) in o { out[k] = v.asJSON }
            return .object(out)
        default: return self
        }
    }
}

// MARK: - Parsing

/// Why `JSONValue.parse` failed, with the byte offset.
public struct JSONParseError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public let offset: Int
    public var description: String { "\(message) at position \(offset)" }
}

extension JSONValue {
    /// Parses JSON text (RFC 8259), keeping object key order.
    public static func parse(_ text: String) throws -> JSONValue {
        var p = JSONParser(Array(text.utf8))
        p.skipSpace()
        let value = try p.value(depth: 0)
        p.skipSpace()
        guard p.i == p.b.count else { throw p.error("Unexpected text after the JSON value") }
        return value
    }

    /// Parses JSON data (UTF-8).
    public static func parse(_ data: Data) throws -> JSONValue {
        try parse(String(decoding: data, as: UTF8.self))
    }
}

private struct JSONParser {
    let b: [UInt8]
    var i = 0
    init(_ bytes: [UInt8]) { b = bytes }

    func error(_ message: String) -> JSONParseError { JSONParseError(message: message, offset: i) }

    mutating func skipSpace() {
        while i < b.count, b[i] == 0x20 || b[i] == 0x0A || b[i] == 0x0D || b[i] == 0x09 { i += 1 }
    }

    mutating func value(depth: Int) throws -> JSONValue {
        guard depth < 512 else { throw error("JSON is nested too deeply") }
        guard i < b.count else { throw error("Unexpected end of JSON input") }
        switch b[i] {
        case UInt8(ascii: "{"):
            i += 1
            var obj = JSONObject()
            skipSpace()
            if i < b.count, b[i] == UInt8(ascii: "}") { i += 1; return .object(obj) }
            while true {
                skipSpace()
                guard i < b.count, b[i] == UInt8(ascii: "\"") else { throw error("Expected a property name") }
                let key = try string()
                skipSpace()
                guard i < b.count, b[i] == UInt8(ascii: ":") else { throw error("Expected ':' after a property name") }
                i += 1
                skipSpace()
                obj[key] = try value(depth: depth + 1)
                skipSpace()
                guard i < b.count else { throw error("Unexpected end of JSON input") }
                if b[i] == UInt8(ascii: ",") { i += 1; continue }
                if b[i] == UInt8(ascii: "}") { i += 1; return .object(obj) }
                throw error("Expected ',' or '}' in an object")
            }
        case UInt8(ascii: "["):
            i += 1
            var arr: [JSONValue] = []
            skipSpace()
            if i < b.count, b[i] == UInt8(ascii: "]") { i += 1; return .array(arr) }
            while true {
                skipSpace()
                arr.append(try value(depth: depth + 1))
                skipSpace()
                guard i < b.count else { throw error("Unexpected end of JSON input") }
                if b[i] == UInt8(ascii: ",") { i += 1; continue }
                if b[i] == UInt8(ascii: "]") { i += 1; return .array(arr) }
                throw error("Expected ',' or ']' in an array")
            }
        case UInt8(ascii: "\""):
            return .string(try string())
        case UInt8(ascii: "t"): try literal("true"); return .bool(true)
        case UInt8(ascii: "f"): try literal("false"); return .bool(false)
        case UInt8(ascii: "n"): try literal("null"); return .null
        default:
            return .number(try number())
        }
    }

    mutating func literal(_ word: String) throws {
        let w = Array(word.utf8)
        guard i + w.count <= b.count, Array(b[i ..< i + w.count]) == w else { throw error("Unexpected token") }
        i += w.count
    }

    mutating func number() throws -> Double {
        let start = i
        if i < b.count, b[i] == UInt8(ascii: "-") { i += 1 }
        guard i < b.count, (48 ... 57).contains(b[i]) else { throw error("Unexpected token") }
        if b[i] == 48 { i += 1 } else { while i < b.count, (48 ... 57).contains(b[i]) { i += 1 } }
        if i < b.count, b[i] == UInt8(ascii: ".") {
            i += 1
            guard i < b.count, (48 ... 57).contains(b[i]) else { throw error("Expected a digit after '.'") }
            while i < b.count, (48 ... 57).contains(b[i]) { i += 1 }
        }
        if i < b.count, b[i] == UInt8(ascii: "e") || b[i] == UInt8(ascii: "E") {
            i += 1
            if i < b.count, b[i] == UInt8(ascii: "+") || b[i] == UInt8(ascii: "-") { i += 1 }
            guard i < b.count, (48 ... 57).contains(b[i]) else { throw error("Expected a digit in the exponent") }
            while i < b.count, (48 ... 57).contains(b[i]) { i += 1 }
        }
        guard let n = Double(String(decoding: b[start ..< i], as: UTF8.self)) else { throw error("Invalid number") }
        return n
    }

    mutating func hex4() throws -> UInt16 {
        guard i + 4 <= b.count, let v = UInt16(String(decoding: b[i ..< i + 4], as: UTF8.self), radix: 16) else { throw error("Bad \\u escape") }
        i += 4
        return v
    }

    mutating func string() throws -> String {
        i += 1 // opening quote
        var units: [UInt16] = []
        var run = i
        func flush(_ end: Int) { units.append(contentsOf: String(decoding: b[run ..< end], as: UTF8.self).utf16) }
        while true {
            guard i < b.count else { throw error("Unterminated string") }
            let c = b[i]
            if c == UInt8(ascii: "\"") {
                flush(i)
                i += 1
                return String(decoding: units, as: UTF16.self)
            }
            if c < 0x20 { throw error("Bad control character in a string") }
            if c == UInt8(ascii: "\\") {
                flush(i)
                i += 1
                guard i < b.count else { throw error("Unterminated string") }
                let e = b[i]
                i += 1
                switch e {
                case UInt8(ascii: "\""): units.append(0x22)
                case UInt8(ascii: "\\"): units.append(0x5C)
                case UInt8(ascii: "/"): units.append(0x2F)
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "u"): units.append(try hex4())
                default: throw error("Bad escape in a string")
                }
                run = i
                continue
            }
            i += 1
        }
    }
}

// MARK: - Serialising

extension JSONValue {
    /// The text `JSON.stringify(value, null, space)` gives in JavaScript.
    public func stringified(space: Int? = nil) -> String {
        var out = ""
        write(into: &out, indent: String(repeating: " ", count: min(10, max(0, space ?? 0))), level: "")
        return out
    }

    private func write(into out: inout String, indent: String, level: String) {
        switch self {
        case .null: out += "null"
        case .bool(let v): out += v ? "true" : "false"
        case .number(let n): out += JSONValue.jsNumber(n)
        case .string(let s): out += JSONValue.quote(s)
        case .array(let items):
            if items.isEmpty { out += "[]"; return }
            let inner = level + indent
            out += "["
            for (k, item) in items.enumerated() {
                if k > 0 { out += "," }
                if !indent.isEmpty { out += "\n" + inner }
                item.write(into: &out, indent: indent, level: inner)
            }
            if !indent.isEmpty { out += "\n" + level }
            out += "]"
        case .object(let obj):
            if obj.isEmpty { out += "{}"; return }
            let inner = level + indent
            out += "{"
            for (k, (key, value)) in obj.enumerated() {
                if k > 0 { out += "," }
                if !indent.isEmpty { out += "\n" + inner }
                out += JSONValue.quote(key) + (indent.isEmpty ? ":" : ": ")
                value.write(into: &out, indent: indent, level: inner)
            }
            if !indent.isEmpty { out += "\n" + level }
            out += "}"
        }
    }

    /// A string as JSON.stringify quotes it (lone surrogates escaped).
    static func quote(_ s: String) -> String {
        var out = "\""
        let units = Array(s.utf16)
        var k = 0
        while k < units.count {
            let u = units[k]
            switch u {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0 ..< 0x20: out += String(format: "\\u%04x", u)
            case 0xD800 ... 0xDBFF where k + 1 < units.count && (0xDC00 ... 0xDFFF).contains(units[k + 1]):
                out += String(decoding: [u, units[k + 1]], as: UTF16.self)
                k += 1
            case 0xD800 ... 0xDFFF: out += String(format: "\\u%04x", u)
            default: out += String(decoding: [u], as: UTF16.self)
            }
            k += 1
        }
        return out + "\""
    }

    /// A number as JavaScript prints it (`Number.prototype.toString`): shortest round trip,
    /// plain digits from 1e-6 up to 1e21, exponents (`1e+21`, `1e-7`) outside.
    public static func jsNumber(_ n: Double) -> String {
        guard n.isFinite else { return "null" }
        if n == 0 { return "0" }
        // Swift's description is the shortest round-trip form; re-lay its digits the JS way.
        var text = "\(n)"
        var sign = ""
        if text.hasPrefix("-") { sign = "-"; text.removeFirst() }
        var mantissa = text
        var exp = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<e])
            exp = Int(text[text.index(after: e)...])!
        }
        var digits = mantissa.replacingOccurrences(of: ".", with: "")
        var point = (mantissa.firstIndex(of: ".").map { mantissa.distance(from: mantissa.startIndex, to: $0) } ?? mantissa.count) + exp
        while digits.hasPrefix("0") && digits.count > 1 { digits.removeFirst(); point -= 1 }
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        // `point` is where the decimal point falls in `digits` (n = 0.digits × 10^point).
        let k = digits.count
        if point >= -5 && point <= 21 {
            if point <= 0 { return sign + "0." + String(repeating: "0", count: -point) + digits }
            if point >= k { return sign + digits + String(repeating: "0", count: point - k) }
            let cut = digits.index(digits.startIndex, offsetBy: point)
            return sign + digits[..<cut] + "." + digits[cut...]
        }
        let e = point - 1
        let lead = digits.prefix(1) + (k > 1 ? "." + digits.dropFirst() : "")
        return sign + lead + "e" + (e >= 0 ? "+" : "-") + String(abs(e))
    }
}
