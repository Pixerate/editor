import Foundation
import PixerateCore
import PixerateRaster

/**
 * Pixel expressions (`effects/pixel-language.ts`): the small, bounded language that effects written
 * at run time (by a person or an agent) use. It is data, not code: no loops, no functions of your
 * own, no memory and no access to anything but the pixel's position, the time and the effect's
 * controls. Every program runs a fixed number of steps per pixel (its `cost`, capped by
 * `maxCost`), so it cannot hang the GPU or the host app, and an iOS app may let agents write
 * effects without running downloaded code (App Store 2.5.2).
 *
 * The TS file is the executable specification: the same issues (messages, lines, order), the
 * same costs and the same CPU pixels. `PixelMSL.swift` compiles a checked program to Metal.
 */

/// The `sourceLanguage` of pixel expression effects.
public let PIXEL_LANGUAGE = "pixel"

/// A problem with an authored effect's source (`EffectAuthoringIssue`): `severity` is `error` or `warning`; `line` is 1-based.
public struct EffectAuthoringIssue: Equatable, Sendable {
    public var message: String
    public var line: Int?
    public var severity: String
    public init(message: String, line: Int? = nil, severity: String) {
        self.message = message
        self.line = line
        self.severity = severity
    }

    /// As the TS core writes it: `{ severity, line?, message }`.
    public var json: JSONValue {
        var o: JSONObject = ["severity": .string(severity)]
        if let line { o["line"] = .number(Double(line)) }
        o["message"] = .string(message)
        return .object(o)
    }
}

/// Limits a program must stay within (`PixelLimits`); nil takes the default.
public struct PixelLimits: Equatable, Sendable {
    /// Longest source in UTF-16 code units (default 65536).
    public var maxSourceLength: Int?
    /// Most work per pixel, in expression steps (`noise` and `sample` count 4; default 1024).
    public var maxCost: Int?
    public init(maxSourceLength: Int? = nil, maxCost: Int? = nil) {
        self.maxSourceLength = maxSourceLength
        self.maxCost = maxCost
    }
    /// `PIXEL_DEFAULT_LIMITS`.
    public static let defaults = PixelLimits(maxSourceLength: 65536, maxCost: 1024)
    /// These limits over the defaults.
    public var resolved: (maxSourceLength: Int, maxCost: Int) {
        (maxSourceLength ?? 65536, maxCost ?? 1024)
    }
}

public let PIXEL_DEFAULT_LIMITS = PixelLimits.defaults

public enum PixelControlType: String, Sendable, CaseIterable {
    case number, color, bool, vec2
}

/// A `control` line: one of the effect's settings.
public struct PixelControl: Equatable, Sendable {
    public var name: String
    public var type: PixelControlType
    /// A number, `#rrggbb` for colours, a bool, or `[x, y]` for vec2.
    public var defaultValue: JSONValue
    public var min: Double?
    public var max: Double?
    /// The comment at the end of its line.
    public var description: String
    public var line: Int
    /// Numbers it takes in a program (3 for a colour, 2 for a vec2, else 1).
    public var size: Int { type == .color ? 3 : type == .vec2 ? 2 : 1 }
}

/// An expression of a checked program, with its size (1 = number, 2…4 = vecN) and line.
public indirect enum PixelExpr: Equatable, Sendable {
    case num(Double, line: Int)
    case const([Double], line: Int)
    case variable(String, size: Int, line: Int)
    case neg(PixelExpr, line: Int)
    /// `op` is one of `+ - * / % < <= > >= == !=`.
    case bin(String, PixelExpr, PixelExpr, size: Int, line: Int)
    case call(String, [PixelExpr], size: Int, line: Int)
    /// Components 0…3 (x y z w).
    case swizzle(PixelExpr, [Int], line: Int)

    public var size: Int {
        switch self {
        case .num: return 1
        case .const(let v, _): return v.count
        case .variable(_, let s, _): return s
        case .neg(let a, _): return a.size
        case .bin(_, _, _, let s, _): return s
        case .call(_, _, let s, _): return s
        case .swizzle(_, let c, _): return c.count
        }
    }

    public var line: Int {
        switch self {
        case .num(_, let l), .const(_, let l), .variable(_, _, let l), .neg(_, let l), .bin(_, _, _, _, let l), .call(_, _, _, let l), .swizzle(_, _, let l): return l
        }
    }
}

/// A `let` of a program.
public struct PixelLet: Equatable, Sendable {
    public var name: String
    public var expr: PixelExpr
    public var line: Int
}

/// A compiled program: its controls, its `let`s in order, and what it puts out.
public struct PixelProgram: Equatable, Sendable {
    public var controls: [PixelControl]
    public var lets: [PixelLet]
    public var out: PixelExpr
    /// Steps per pixel.
    public var cost: Int
}

/// What `compilePixelSource` gives back: the program when it compiles (`ok`), and the issues either way.
public struct PixelCompileResult: Sendable {
    public var program: PixelProgram?
    public var issues: [EffectAuthoringIssue]
    public var ok: Bool { program != nil }
}

/// A value every program can read.
public struct PixelBuiltin: Sendable {
    public let name: String
    public let size: Int
    public let description: String
}

/// A function of the language: how many arguments, and how the result's size is found (`each`: the widest argument, the rest broadcast).
public struct PixelFunction: Sendable {
    public let name: String
    public let min: Int
    public let max: Int
    /// `each`, `scalar`, `vec2`, `vec3` or `vec4`.
    public let result: String
    public let description: String
}

/// Values every program can read, in the TS order (messages list them).
public let PIXEL_BUILTINS: [PixelBuiltin] = [
    PixelBuiltin(name: "uv", size: 2, description: "Where the pixel is, 0..1 across and down from the top left (pixel centres)."),
    PixelBuiltin(name: "pos", size: 2, description: "Where the pixel is, in pixels from the top left (pixel centres: 0.5, 1.5, …)."),
    PixelBuiltin(name: "size", size: 2, description: "The size of the picture in pixels."),
    PixelBuiltin(name: "time", size: 1, description: "The effect time in seconds."),
    PixelBuiltin(name: "PI", size: 1, description: "3.14159…"),
    PixelBuiltin(name: "TAU", size: 1, description: "2π."),
]

/// Functions, in the TS order (messages list them).
public let PIXEL_FUNCTIONS: [PixelFunction] = [
    PixelFunction(name: "sin", min: 1, max: 1, result: "each", description: "Sine (radians)."),
    PixelFunction(name: "cos", min: 1, max: 1, result: "each", description: "Cosine (radians)."),
    PixelFunction(name: "tan", min: 1, max: 1, result: "each", description: "Tangent (radians)."),
    PixelFunction(name: "asin", min: 1, max: 1, result: "each", description: "Arcsine."),
    PixelFunction(name: "acos", min: 1, max: 1, result: "each", description: "Arccosine."),
    PixelFunction(name: "atan", min: 1, max: 2, result: "each", description: "atan(x), or atan(y, x) for the angle of a point."),
    PixelFunction(name: "sqrt", min: 1, max: 1, result: "each", description: "Square root (0 for negatives)."),
    PixelFunction(name: "exp", min: 1, max: 1, result: "each", description: "e to the power."),
    PixelFunction(name: "log", min: 1, max: 1, result: "each", description: "Natural logarithm."),
    PixelFunction(name: "abs", min: 1, max: 1, result: "each", description: "Absolute value."),
    PixelFunction(name: "sign", min: 1, max: 1, result: "each", description: "-1, 0 or 1."),
    PixelFunction(name: "floor", min: 1, max: 1, result: "each", description: "Rounds down."),
    PixelFunction(name: "ceil", min: 1, max: 1, result: "each", description: "Rounds up."),
    PixelFunction(name: "fract", min: 1, max: 1, result: "each", description: "x - floor(x)."),
    PixelFunction(name: "pow", min: 2, max: 2, result: "each", description: "pow(x, y)."),
    PixelFunction(name: "mod", min: 2, max: 2, result: "each", description: "mod(x, y) = x - y·floor(x / y) (the same as x % y)."),
    PixelFunction(name: "min", min: 2, max: 2, result: "each", description: "The smaller."),
    PixelFunction(name: "max", min: 2, max: 2, result: "each", description: "The larger."),
    PixelFunction(name: "clamp", min: 3, max: 3, result: "each", description: "clamp(x, lo, hi)."),
    PixelFunction(name: "mix", min: 3, max: 3, result: "each", description: "mix(a, b, t) = a + (b - a)·t."),
    PixelFunction(name: "step", min: 2, max: 2, result: "each", description: "step(edge, x): 0 below edge, else 1."),
    PixelFunction(name: "smoothstep", min: 3, max: 3, result: "each", description: "smoothstep(lo, hi, x): a smooth 0..1 ramp."),
    PixelFunction(name: "select", min: 3, max: 3, result: "each", description: "select(c, a, b): a where c > 0.5, else b (c is a number)."),
    PixelFunction(name: "length", min: 1, max: 1, result: "scalar", description: "Length of a vector."),
    PixelFunction(name: "distance", min: 2, max: 2, result: "scalar", description: "Distance between two points."),
    PixelFunction(name: "dot", min: 2, max: 2, result: "scalar", description: "Dot product."),
    PixelFunction(name: "normalize", min: 1, max: 1, result: "each", description: "The vector at length 1 (0 stays 0)."),
    PixelFunction(name: "hash", min: 1, max: 1, result: "scalar", description: "hash(p): a random 0..1 for each whole-number cell of a vec2."),
    PixelFunction(name: "noise", min: 1, max: 1, result: "scalar", description: "noise(p): smooth value noise 0..1 over a vec2."),
    PixelFunction(
        name: "sample", min: 1, max: 1, result: "vec4",
        description: "sample(p): the input picture (source) at p, a vec2 in uv, as a vec4 with straight alpha (bilinear, clamped to the edge). An effect that calls it is a filter."
    ),
    PixelFunction(name: "vec2", min: 1, max: 2, result: "vec2", description: "A vec2 from parts (or one number for both)."),
    PixelFunction(name: "vec3", min: 1, max: 3, result: "vec3", description: "A vec3 from parts (or one number for all)."),
    PixelFunction(name: "vec4", min: 1, max: 4, result: "vec4", description: "A vec4 from parts (or one number for all)."),
]

private let BUILTIN_SIZES: [String: Int] = Dictionary(uniqueKeysWithValues: PIXEL_BUILTINS.map { ($0.name, $0.size) })
private let FUNCTIONS: [String: PixelFunction] = Dictionary(uniqueKeysWithValues: PIXEL_FUNCTIONS.map { ($0.name, $0) })
private let KEYWORDS: Set<String> = ["control", "let", "out", "range", "true", "false"]
private let TYPE_NAMES = ["number", "color", "bool", "vec2"]
private func sizeName(_ n: Int) -> String { n == 1 ? "number" : "vec\(n)" }

/// A number as JS prints it in a template string.
func pixelNumberText(_ v: Double) -> String {
    if v.isNaN { return "NaN" }
    if v.isInfinite { return v < 0 ? "-Infinity" : "Infinity" }
    return JSONValue.number(v).stringified()
}

// MARK: - Tokens

private enum TokKind: Equatable {
    case num(Double)
    case color([Double])
    case id(String)
    case op(String)
    case nl
}

private struct Tok {
    let kind: TokKind
    let line: Int
    var isNL: Bool { kind == .nl }
    func isOp(_ v: String) -> Bool { kind == .op(v) }
}

private struct PixelSyntaxError: Error {
    let message: String
    let line: Int
    init(_ message: String, _ line: Int) {
        self.message = message
        self.line = line
    }
}

@inline(__always) private func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }
@inline(__always) private func isHex(_ c: UInt16) -> Bool { isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) }
@inline(__always) private func isIdStart(_ c: UInt16) -> Bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 }
@inline(__always) private func isIdPart(_ c: UInt16) -> Bool { isIdStart(c) || isDigit(c) }

private func text(_ s: [UInt16], _ a: Int, _ b: Int) -> String { String(decoding: s[a..<b], as: UTF16.self) }

private func tokenize(_ s: [UInt16], _ comments: inout [Int: String]) throws -> [Tok] {
    var out: [Tok] = []
    var line = 1
    var depth = 0
    var i = 0
    let n = s.count
    func at(_ k: Int) -> UInt16 { k < n ? s[k] : 0 }
    while i < n {
        let c = s[i]
        if c == 10 {
            if depth == 0 { out.append(Tok(kind: .nl, line: line)) }
            line += 1
            i += 1
            continue
        }
        if c == 32 || c == 9 || c == 13 {
            i += 1
            continue
        }
        if c == 59 {
            if depth == 0 { out.append(Tok(kind: .nl, line: line)) }
            i += 1
            continue
        }
        if c == 47 && at(i + 1) == 47 {
            var j = i + 2
            while j < n && s[j] != 10 { j += 1 }
            let t = text(s, i + 2, j).trimmingCharacters(in: .whitespacesAndNewlines)
            if comments[line] == nil { comments[line] = t }
            i = j
            continue
        }
        if isDigit(c) || (c == 46 && isDigit(at(i + 1))) {
            // /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/ over the next 64 code units.
            let end = Swift.min(n, i + 64)
            var j = i
            var intPart = "", fracPart = ""
            while j < end && isDigit(s[j]) { j += 1 }
            intPart = text(s, i, j)
            if j < end && s[j] == 46 {
                j += 1
                let f = j
                while j < end && isDigit(s[j]) { j += 1 }
                fracPart = text(s, f, j)
            }
            var expPart = "0"
            if j < end && (s[j] == 101 || s[j] == 69) {
                var k = j + 1
                var sign = ""
                if k < end && (s[k] == 43 || s[k] == 45) { sign = s[k] == 45 ? "-" : ""; k += 1 }
                let e0 = k
                while k < end && isDigit(s[k]) { k += 1 }
                if k > e0 {
                    expPart = sign + text(s, e0, k)
                    j = k
                }
            }
            let v = Double("\(intPart.isEmpty ? "0" : intPart).\(fracPart.isEmpty ? "0" : fracPart)e\(expPart)") ?? .nan
            out.append(Tok(kind: .num(v), line: line))
            i = j
            continue
        }
        if c == 35 {
            // /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/
            var run = 0
            while run < 8 && i + 1 + run < n && isHex(s[i + 1 + run]) { run += 1 }
            var len = 0
            if run >= 8 && !isIdPart(at(i + 9)) { len = 8 } else if run >= 6 && !isIdPart(at(i + 7)) { len = 6 }
            if len == 0 { throw PixelSyntaxError("a colour is written #rrggbb or #rrggbbaa, e.g. #ff8800", line) }
            var v: [Double] = []
            var k = 0
            while k < len {
                v.append(Double(Int(text(s, i + 1 + k, i + 3 + k), radix: 16) ?? 0) / 255)
                k += 2
            }
            out.append(Tok(kind: .color(v), line: line))
            i += 1 + len
            continue
        }
        if isIdStart(c) {
            var j = i + 1
            while j < n && isIdPart(s[j]) { j += 1 }
            out.append(Tok(kind: .id(text(s, i, j)), line: line))
            i = j
            continue
        }
        let two = i + 1 < n ? text(s, i, i + 2) : ""
        if two == "<=" || two == ">=" || two == "==" || two == "!=" || two == ".." {
            out.append(Tok(kind: .op(two), line: line))
            i += 2
            continue
        }
        if c < 128, "+-*/%()<>,.:=".utf16.contains(c) {
            if c == 40 { depth += 1 }
            if c == 41 { depth = Swift.max(0, depth - 1) }
            out.append(Tok(kind: .op(text(s, i, i + 1)), line: line))
            i += 1
            continue
        }
        // One UTF-16 unit in JS; a whole surrogate pair here (Swift strings can't hold a lone surrogate).
        let ch = UTF16.isLeadSurrogate(c) && UTF16.isTrailSurrogate(at(i + 1)) ? text(s, i, i + 2) : text(s, i, i + 1)
        throw PixelSyntaxError("unexpected character \"\(ch)\"", line)
    }
    out.append(Tok(kind: .nl, line: line))
    return out
}

private func describeTok(_ t: Tok) -> String {
    switch t.kind {
    case .nl: return "the end of the line"
    case .num(let v): return "the number \(pixelNumberText(v))"
    case .color: return "a colour"
    case .id(let v), .op(let v): return "\"\(v)\""
    }
}

// MARK: - Parser and checker

private let COMPARISONS: Set<String> = ["<", "<=", ">", ">=", "==", "!="]

private final class PixelParser {
    let toks: [Tok]
    let comments: [Int: String]
    var p = 0
    var controls: [PixelControl] = []
    var lets: [PixelLet] = []
    var scopeOrder: [String] = []
    var scope: [String: (size: Int, line: Int)] = [:]
    var used = Set<String>()
    var poisoned = Set<String>()
    var declaring: String?

    init(_ toks: [Tok], _ comments: [Int: String]) {
        self.toks = toks
        self.comments = comments
    }

    func peek() -> Tok { toks[p] }
    func next() -> Tok {
        let t = toks[p]
        p += 1
        return t
    }
    func isOp(_ v: String) -> Bool { toks[p].isOp(v) }
    func expectOp(_ v: String, _ what: String) throws {
        let t = next()
        if !t.isOp(v) { throw PixelSyntaxError("expected \"\(v)\" \(what), found \(describeTok(t))", t.line) }
    }
    func ident(_ what: String) throws -> String {
        let t = next()
        guard case .id(let v) = t.kind else { throw PixelSyntaxError("expected \(what), found \(describeTok(t))", t.line) }
        return v
    }
    func define(_ name: String, _ size: Int, _ line: Int) {
        if scope[name] == nil { scopeOrder.append(name) }
        scope[name] = (size, line)
    }

    func checkNewName(_ name: String, _ line: Int) throws {
        if KEYWORDS.contains(name) { throw PixelSyntaxError("\"\(name)\" is a keyword; pick another name", line) }
        if BUILTIN_SIZES[name] != nil { throw PixelSyntaxError("\"\(name)\" is a built-in value; pick another name", line) }
        if FUNCTIONS[name] != nil { throw PixelSyntaxError("\"\(name)\" is a function; pick another name", line) }
        if let had = scope[name] { throw PixelSyntaxError("\"\(name)\" is already defined on line \(had.line); names can't be reused", line) }
    }

    func signedNumber(_ what: String) throws -> Double {
        var sign = 1.0
        if isOp("-") {
            _ = next()
            sign = -1
        }
        let t = next()
        guard case .num(let v) = t.kind else { throw PixelSyntaxError("expected \(what), found \(describeTok(t))", t.line) }
        return sign * v
    }

    // Expressions

    func combine(_ a: PixelExpr, _ b: PixelExpr, _ op: String, _ line: Int) throws -> Int {
        if a.size == b.size || b.size == 1 { return a.size }
        if a.size == 1 { return b.size }
        throw PixelSyntaxError("can't use \"\(op)\" on a \(sizeName(a.size)) and a \(sizeName(b.size)); make them the same size (e.g. with .xy or vec3(…))", line)
    }

    func comparison(_ t: Tok) -> String? {
        if case .op(let v) = t.kind, COMPARISONS.contains(v) { return v }
        return nil
    }

    func parseExpr() throws -> PixelExpr {
        let a = try parseAdd()
        let t = peek()
        if let op = comparison(t) {
            _ = next()
            let b = try parseAdd()
            if a.size != 1 || b.size != 1 { throw PixelSyntaxError("\"\(op)\" compares two numbers; this is a \(sizeName(a.size)) and a \(sizeName(b.size)) (compare one part, e.g. uv.x)", t.line) }
            let after = peek()
            if comparison(after) != nil { throw PixelSyntaxError("comparisons can't be chained; combine them with min/max or select", after.line) }
            return .bin(op, a, b, size: 1, line: t.line)
        }
        return a
    }

    func parseAdd() throws -> PixelExpr {
        var a = try parseMul()
        while true {
            let t = peek()
            guard case .op(let v) = t.kind, v == "+" || v == "-" else { return a }
            _ = next()
            let b = try parseMul()
            a = .bin(v, a, b, size: try combine(a, b, v, t.line), line: t.line)
        }
    }

    func parseMul() throws -> PixelExpr {
        var a = try parseUnary()
        while true {
            let t = peek()
            guard case .op(let v) = t.kind, v == "*" || v == "/" || v == "%" else { return a }
            _ = next()
            let b = try parseUnary()
            a = .bin(v, a, b, size: try combine(a, b, v, t.line), line: t.line)
        }
    }

    func parseUnary() throws -> PixelExpr {
        let t = peek()
        if t.isOp("-") {
            _ = next()
            let a = try parseUnary()
            return .neg(a, line: t.line)
        }
        return try parsePostfix()
    }

    func parsePostfix() throws -> PixelExpr {
        var a = try parsePrimary()
        while isOp(".") {
            let dot = next()
            let t = next()
            guard case .id(let v) = t.kind else { throw PixelSyntaxError("expected parts such as .x, .xy or .rgb after \".\", found \(describeTok(t))", dot.line) }
            let set: [Character]? = v.allSatisfy({ "xyzw".contains($0) }) ? Array("xyzw") : v.allSatisfy({ "rgba".contains($0) }) ? Array("rgba") : nil
            guard let set, v.utf16.count <= 4 else { throw PixelSyntaxError("\".\(v)\" isn't a part of a vector; use up to four of x y z w (or r g b a)", t.line) }
            let comps = v.map { ch in set.firstIndex(of: ch)! }
            if let bad = comps.first(where: { $0 >= a.size }) {
                let has = a.size == 1 ? "" : "; it has " + set.prefix(a.size).map { ".\($0)" }.joined(separator: " ")
                throw PixelSyntaxError("a \(sizeName(a.size)) has no \".\(set[bad])\"\(has)", t.line)
            }
            a = .swizzle(a, comps, line: t.line)
        }
        return a
    }

    func parsePrimary() throws -> PixelExpr {
        let t = next()
        switch t.kind {
        case .num(let v): return .num(v, line: t.line)
        case .color(let v): return .const(v, line: t.line)
        case .op("("):
            let e = try parseExpr()
            try expectOp(")", "to close \"(\"")
            return e
        case .id(let name):
            if isOp("(") {
                _ = next()
                var args: [PixelExpr] = []
                if !isOp(")") {
                    while true {
                        args.append(try parseExpr())
                        if isOp(",") {
                            _ = next()
                            continue
                        }
                        break
                    }
                }
                try expectOp(")", "to close the call to \(name)")
                return try typeCall(name, args, t.line)
            }
            if let size = BUILTIN_SIZES[name] { return .variable(name, size: size, line: t.line) }
            if poisoned.contains(name) { throw PixelSyntaxError("", t.line) }
            if let s = scope[name] {
                used.insert(name)
                return .variable(name, size: s.size, line: t.line)
            }
            if FUNCTIONS[name] != nil { throw PixelSyntaxError("\(name) is a function; call it, e.g. \(name)(…)", t.line) }
            let defined = scopeOrder.isEmpty ? "" : "defined so far: \(scopeOrder.joined(separator: ", ")); "
            throw PixelSyntaxError("there is no \"\(name)\"; \(defined)built in: \(PIXEL_BUILTINS.map(\.name).joined(separator: ", "))", t.line)
        default:
            throw PixelSyntaxError("expected a value, found \(describeTok(t))", t.line)
        }
    }

    func typeCall(_ fn: String, _ args: [PixelExpr], _ line: Int) throws -> PixelExpr {
        guard let spec = FUNCTIONS[fn] else { throw PixelSyntaxError("there is no function \"\(fn)\"; the functions are \(PIXEL_FUNCTIONS.map(\.name).joined(separator: ", "))", line) }
        if args.count < spec.min || args.count > spec.max {
            let want = spec.min == spec.max ? "\(spec.min)" : "\(spec.min) to \(spec.max)"
            throw PixelSyntaxError("\(fn) takes \(want) argument\(spec.max == 1 ? "" : "s"), not \(args.count)", line)
        }
        if fn == "sample" {
            if args[0].size != 2 { throw PixelSyntaxError("sample takes a vec2 in uv (e.g. sample(uv) or sample(uv + vec2(1, 0) / size)), not a \(sizeName(args[0].size))", line) }
            return .call(fn, args, size: 4, line: line)
        }
        if spec.result.hasPrefix("vec") {
            let n = Int(String(spec.result.last!))!
            let total = args.reduce(0) { $0 + $1.size }
            if !(args.count == 1 && args[0].size == 1) && total != n { throw PixelSyntaxError("\(fn) needs \(n) parts in all (or one number for all), and these make \(total)", line) }
            return .call(fn, args, size: n, line: line)
        }
        if fn == "hash" || fn == "noise" {
            if args[0].size != 2 { throw PixelSyntaxError("\(fn) takes a vec2 (e.g. \(fn)(uv * 8)), not a \(sizeName(args[0].size))", line) }
            return .call(fn, args, size: 1, line: line)
        }
        if fn == "select" && args[0].size != 1 { throw PixelSyntaxError("select's first argument is a number (the condition), not a \(sizeName(args[0].size))", line) }
        let sized = fn == "select" ? Array(args.dropFirst()) : args
        let n = sized.map(\.size).max() ?? 1
        if let bad = sized.first(where: { $0.size != n && $0.size != 1 }) { throw PixelSyntaxError("\(fn) can't mix a \(sizeName(n)) and a \(sizeName(bad.size)); make them the same size", line) }
        return .call(fn, args, size: spec.result == "scalar" ? 1 : n, line: line)
    }

    // Statements

    func parseControl(_ line: Int) throws {
        let nameTok = peek()
        let name = try ident("a control name, e.g. control speed: number = 1")
        try checkNewName(name, nameTok.line)
        declaring = name
        try expectOp(":", "after the control name (control \(name): number = 1)")
        let typeTok = peek()
        let typeName = try ident("a control type (\(TYPE_NAMES.joined(separator: ", ")))")
        guard let type = PixelControlType(rawValue: typeName) else { throw PixelSyntaxError("\"\(typeName)\" isn't a control type; use \(TYPE_NAMES.joined(separator: ", "))", typeTok.line) }
        try expectOp("=", "and a default value (control \(name): \(typeName) = …)")
        var def: JSONValue
        switch type {
        case .number:
            def = .number(try signedNumber("a number"))
        case .bool:
            let t = next()
            guard case .id(let v) = t.kind, v == "true" || v == "false" else { throw PixelSyntaxError("a bool control's default is true or false, not \(describeTok(t))", t.line) }
            def = .bool(v == "true")
        case .color:
            let t = next()
            guard case .color(let v) = t.kind, v.count == 3 else { throw PixelSyntaxError("a colour control's default is #rrggbb, not \(describeTok(t))", t.line) }
            def = .string("#" + v.map { c in
                let h = String(Int(JS.round(c * 255)), radix: 16)
                return h.count < 2 ? "0" + h : h
            }.joined())
        case .vec2:
            let t = next()
            guard case .id("vec2") = t.kind else { throw PixelSyntaxError("a vec2 control's default is vec2(x, y), not \(describeTok(t))", t.line) }
            try expectOp("(", "after vec2")
            let x = try signedNumber("a number")
            try expectOp(",", "between x and y")
            let y = try signedNumber("a number")
            try expectOp(")", "to close vec2(")
            def = [.number(x), .number(y)]
        }
        var min: Double?
        var max: Double?
        let r = peek()
        if case .id("range") = r.kind {
            _ = next()
            if type == .color || type == .bool { throw PixelSyntaxError("a \(typeName) control has no range", r.line) }
            let lo = try signedNumber("the lowest value after range")
            let hi = try signedNumber("the highest value after range")
            min = lo
            max = hi
            if !(lo < hi) { throw PixelSyntaxError("range \(pixelNumberText(lo)) \(pixelNumberText(hi)) is empty; write the lowest value first", r.line) }
            let vals = def.arrayValue?.compactMap(\.numberValue) ?? [def.numberValue ?? .nan]
            if vals.contains(where: { $0 < lo || $0 > hi }) { throw PixelSyntaxError("the default \(def.stringified()) is outside range \(pixelNumberText(lo)) \(pixelNumberText(hi))", r.line) }
        }
        let control = PixelControl(name: name, type: type, defaultValue: def, min: min, max: max, description: (comments[line].flatMap { $0.isEmpty ? nil : $0 }) ?? "The \(name) control.", line: line)
        define(name, control.size, line)
        controls.append(control)
    }

    func run(_ sourceLines: Int, _ maxCost: Int) -> PixelCompileResult {
        var issues: [EffectAuthoringIssue] = []
        var out: (expr: PixelExpr, line: Int)?
        func hasError() -> Bool { issues.contains { $0.severity == "error" } }
        while p < toks.count {
            let t = peek()
            if t.isNL {
                p += 1
                continue
            }
            let line = t.line
            declaring = nil
            do {
                if let out { throw PixelSyntaxError("\"out = …\" must be the last line; move this line above line \(out.line)", line) }
                if case .id("control") = t.kind {
                    _ = next()
                    if let first = lets.first { throw PixelSyntaxError("put control lines before the first let (line \(first.line))", line) }
                    try parseControl(line)
                } else if case .id("let") = t.kind {
                    _ = next()
                    let nameTok = peek()
                    let name = try ident("a name after let, e.g. let d = length(uv)")
                    try checkNewName(name, nameTok.line)
                    declaring = name
                    try expectOp("=", "after let \(name)")
                    let expr = try parseExpr()
                    define(name, expr.size, line)
                    lets.append(PixelLet(name: name, expr: expr, line: line))
                } else if case .id("out") = t.kind {
                    _ = next()
                    try expectOp("=", "after out")
                    let expr = try parseExpr()
                    if expr.size == 2 { throw PixelSyntaxError("out is a number (grey), a vec3 (colour) or a vec4 (colour and alpha), not a vec2", line) }
                    out = (expr, line)
                } else {
                    throw PixelSyntaxError("a line starts with control, let or out, not \(describeTok(t))", line)
                }
                let end = peek()
                if !end.isNL { throw PixelSyntaxError("unexpected \(describeTok(end)); put one statement on each line", end.line) }
            } catch let e as PixelSyntaxError {
                if !e.message.isEmpty { issues.append(EffectAuthoringIssue(message: e.message, line: e.line, severity: "error")) }
                else if !hasError() { issues.append(EffectAuthoringIssue(message: "this line uses a name whose own line has an error", line: e.line, severity: "error")) }
                if let declaring { poisoned.insert(declaring) }
                while p < toks.count && !toks[p].isNL { p += 1 }
            } catch {
                fatalError("pixel parser threw \(error)")
            }
        }

        if out == nil && !hasError() {
            issues.append(EffectAuthoringIssue(message: "nothing is drawn: end with a line such as out = vec3(uv, 0.5)", line: sourceLines, severity: "error"))
        }
        guard let out, !hasError() else { return PixelCompileResult(program: nil, issues: issues) }

        let cost = lets.reduce(0) { $0 + exprCost($1.expr) } + exprCost(out.expr)
        if cost > maxCost {
            return PixelCompileResult(program: nil, issues: issues + [EffectAuthoringIssue(message: "the program does \(cost) steps per pixel; the limit is \(maxCost). Share work with let, or simplify", line: out.line, severity: "error")])
        }
        for c in controls where !used.contains(c.name) { issues.append(EffectAuthoringIssue(message: "control \"\(c.name)\" isn't used", line: c.line, severity: "warning")) }
        for l in lets where !used.contains(l.name) { issues.append(EffectAuthoringIssue(message: "\"\(l.name)\" isn't used", line: l.line, severity: "warning")) }
        return PixelCompileResult(program: PixelProgram(controls: controls, lets: lets, out: out.expr, cost: cost), issues: issues)
    }
}

/**
 * Parses and type-checks a pixel expression program (`compilePixelSource`). Problems come back as
 * issues with 1-based line numbers (errors stop it compiling; warnings, such as an unused control,
 * do not).
 */
public func compilePixelSource(_ source: String, limits: PixelLimits = PixelLimits()) -> PixelCompileResult {
    let lim = limits.resolved
    let units = Array(source.utf16)
    if units.count > lim.maxSourceLength {
        return PixelCompileResult(program: nil, issues: [EffectAuthoringIssue(message: "the source is \(units.count) characters; the limit is \(lim.maxSourceLength)", severity: "error")])
    }
    var comments: [Int: String] = [:]
    let toks: [Tok]
    do {
        toks = try tokenize(units, &comments)
    } catch let e as PixelSyntaxError {
        return PixelCompileResult(program: nil, issues: [EffectAuthoringIssue(message: e.message, line: e.line, severity: "error")])
    } catch {
        fatalError("pixel tokenizer threw \(error)")
    }
    let lines = units.reduce(1) { $1 == 10 ? $0 + 1 : $0 }
    return PixelParser(toks, comments).run(lines, lim.maxCost)
}

/// Steps an expression takes per pixel (`exprCost`; `noise` and `sample` count 4).
public func exprCost(_ e: PixelExpr) -> Int {
    switch e {
    case .num, .const, .variable: return 0
    case .neg(let a, _), .swizzle(let a, _, _): return 1 + exprCost(a)
    case .bin(_, let a, let b, _, _): return 1 + exprCost(a) + exprCost(b)
    case .call(let fn, let args, _, _):
        let own: Int = fn == "noise" || fn == "sample" ? 4 : 1
        return own + args.reduce(0) { (sum: Int, a: PixelExpr) -> Int in sum + exprCost(a) }
    }
}

/// Whether an expression calls `sample` (reads the input picture).
private func exprSamples(_ e: PixelExpr) -> Bool {
    switch e {
    case .num, .const, .variable: return false
    case .neg(let a, _), .swizzle(let a, _, _): return exprSamples(a)
    case .bin(_, let a, let b, _, _): return exprSamples(a) || exprSamples(b)
    case .call(let fn, let args, _, _): return fn == "sample" || args.contains(where: exprSamples)
    }
}

/// Whether a program reads an input picture (calls `sample`): such an effect is a filter with an image input `source` (`pixelProgramSamples`).
public func pixelProgramSamples(_ program: PixelProgram) -> Bool {
    program.lets.contains { exprSamples($0.expr) } || exprSamples(program.out)
}

// MARK: - Controls as an effect description

private let HEX_PATTERN = "^#[0-9a-fA-F]{6}$"

/// The JSON Schema of one control (`pixelControlSchema`).
public func pixelControlSchema(_ c: PixelControl) -> JSONObject {
    func range(_ o: inout JSONObject) {
        if let min = c.min {
            o["minimum"] = .number(min)
            o["maximum"] = c.max.map(JSONValue.number) ?? .null
        }
    }
    switch c.type {
    case .number:
        var o: JSONObject = ["type": "number", "description": .string(c.description)]
        range(&o)
        return o
    case .bool:
        return ["type": "boolean", "description": .string(c.description)]
    case .color:
        return ["type": "string", "pattern": .string(HEX_PATTERN), "description": .string("\(c.description) (#rrggbb)")]
    case .vec2:
        var items: JSONObject = ["type": "number", "description": "x or y."]
        range(&items)
        return ["type": "array", "description": .string("\(c.description) ([x, y])"), "minItems": 2, "maxItems": 2, "items": .object(items)]
    }
}

// MARK: - CPU evaluation

/// The integer hash behind `hash` and `noise` (`pixelHash`; identical in TS and MSL).
public func pixelHash(_ x: Double, _ y: Double) -> Double {
    let ix = UInt32(bitPattern: JS.i32(JS.floor(JS.max(-1e9, JS.min(1e9, x)))))
    let iy = UInt32(bitPattern: JS.i32(JS.floor(JS.max(-1e9, JS.min(1e9, y)))))
    var h = (ix &* 0x8da6_b343) ^ (iy &* 0xd816_3841)
    h ^= h >> 13
    h = h &* 0x5bd1_e995
    h ^= h >> 15
    return Double(h) / 4_294_967_296
}

/// Smooth value noise 0..1 over the `pixelHash` lattice (`pixelNoise`).
public func pixelNoise(_ x: Double, _ y: Double) -> Double {
    let ix = JS.floor(x)
    let iy = JS.floor(y)
    let fx = x - ix
    let fy = y - iy
    let ux = fx * fx * (3 - 2 * fx)
    let uy = fy * fy * (3 - 2 * fy)
    let a = pixelHash(ix, iy)
    let b = pixelHash(ix + 1, iy)
    let c = pixelHash(ix, iy + 1)
    let d = pixelHash(ix + 1, iy + 1)
    let top = a + (b - a) * ux
    let bottom = c + (d - c) * ux
    return top + (bottom - top) * uy
}

/**
 * `sample(p)` (`pixelSample`): the picture at `p` (a vec2 in uv, so pixel centres are at
 * (x + 0.5) / width), as straight-alpha RGBA 0..1. Bilinear between the four nearest pixels,
 * clamped to the edge, with colour weighted by alpha; colour where all four are transparent is 0.
 * A coordinate that is not a number reads the left or top edge. No picture (or an empty one) reads
 * as transparent. Writes the four numbers at `into[at...]`.
 */
public func pixelSample(_ src: EffectPixels?, _ x: Double, _ y: Double, into: UnsafeMutablePointer<Double>, at: Int = 0) {
    guard let src, src.width >= 1, src.height >= 1, src.data.count >= src.width * src.height * 4 else {
        for k in 0..<4 { into[at + k] = 0 }
        return
    }
    src.data.withUnsafeBufferPointer { (d: UnsafeBufferPointer<UInt8>) in
        pixelSampleBytes(d, src.width, src.height, x, y, into: into, at: at)
    }
}

/// `pixelSample` over raw bytes (`d` holds w × h × 4).
@inline(__always)
func pixelSampleBytes(_ d: UnsafeBufferPointer<UInt8>, _ w: Int, _ h: Int, _ x: Double, _ y: Double, into: UnsafeMutablePointer<Double>, at: Int) {
    let W = Double(w), H = Double(h)
    var tx: Double = x * W - 0.5
    var ty: Double = y * H - 0.5
    if !(tx > -1) { tx = -1 } else if tx > W { tx = W }
    if !(ty > -1) { ty = -1 } else if ty > H { ty = H }
    let fx0: Double = JS.floor(tx)
    let fy0: Double = JS.floor(ty)
    let fx: Double = tx - fx0
    let fy: Double = ty - fy0
    let ix: Int = Int(fx0), iy: Int = Int(fy0)
    let x0: Int = Swift.min(Swift.max(ix, 0), w - 1)
    let x1: Int = Swift.min(Swift.max(ix + 1, 0), w - 1)
    let y0: Int = Swift.min(Swift.max(iy, 0), h - 1)
    let y1: Int = Swift.min(Swift.max(iy + 1, 0), h - 1)
    let i00: Int = (y0 * w + x0) * 4
    let i10: Int = (y0 * w + x1) * 4
    let i01: Int = (y1 * w + x0) * 4
    let i11: Int = (y1 * w + x1) * 4
    let w00: Double = (1 - fx) * (1 - fy) * Double(d[i00 + 3])
    let w10: Double = fx * (1 - fy) * Double(d[i10 + 3])
    let w01: Double = (1 - fx) * fy * Double(d[i01 + 3])
    let w11: Double = fx * fy * Double(d[i11 + 3])
    let a: Double = w00 + w10 + w01 + w11
    if a > 0 {
        for c in 0..<3 {
            var sum: Double = w00 * Double(d[i00 + c])
            sum += w10 * Double(d[i10 + c])
            sum += w01 * Double(d[i01 + c])
            sum += w11 * Double(d[i11 + c])
            into[at + c] = sum / (a * 255)
        }
    } else {
        into[at] = 0
        into[at + 1] = 0
        into[at + 2] = 0
    }
    into[at + 3] = a / 255
}

private func pixelUnary(_ fn: String) -> ((Double) -> Double)? {
    switch fn {
    case "sin": return { JS.sin($0) }
    case "cos": return { JS.cos($0) }
    case "tan": return { Foundation.tan($0) }
    case "asin": return { Foundation.asin($0) }
    case "acos": return { JS.acos($0) }
    case "atan": return { JS.atan($0) }
    case "sqrt": return { $0 > 0 ? $0.squareRoot() : 0 }
    case "exp": return { JS.exp($0) }
    case "log": return { Foundation.log($0) }
    case "abs": return { Swift.abs($0) }
    case "sign": return { $0 > 0 ? 1 : $0 < 0 ? -1 : 0 }
    case "floor": return { JS.floor($0) }
    case "ceil": return { JS.ceil($0) }
    case "fract": return { $0 - JS.floor($0) }
    default: return nil
    }
}

private func pixelFmod(_ x: Double, _ y: Double) -> Double { x - y * JS.floor(x / y) }

private func pixelBinary(_ op: String) -> ((Double, Double) -> Double)? {
    switch op {
    case "+": return { $0 + $1 }
    case "-": return { $0 - $1 }
    case "*": return { $0 * $1 }
    case "/": return { $0 / $1 }
    case "%", "mod": return pixelFmod
    case "pow": return { JS.pow($0, $1) }
    case "min": return { JS.min($0, $1) }
    case "max": return { JS.max($0, $1) }
    case "atan": return { JS.atan2($0, $1) }
    case "step": return { edge, x in x < edge ? 0 : 1 }
    case "<": return { $0 < $1 ? 1 : 0 }
    case "<=": return { $0 <= $1 ? 1 : 0 }
    case ">": return { $0 > $1 ? 1 : 0 }
    case ">=": return { $0 >= $1 ? 1 : 0 }
    case "==": return { $0 == $1 ? 1 : 0 }
    case "!=": return { $0 != $1 ? 1 : 0 }
    default: return nil
    }
}

private func pixelTernary(_ fn: String) -> ((Double, Double, Double) -> Double)? {
    switch fn {
    case "clamp": return { x, lo, hi in JS.min(JS.max(x, lo), hi) }
    case "mix": return { a, b, t in a + (b - a) * t }
    case "smoothstep": return { lo, hi, x in
        let t = JS.min(JS.max((x - lo) / (hi - lo), 0), 1)
        return t * t * (3 - 2 * t)
    }
    default: return nil
    }
}

/// A control value as numbers for the evaluator (`pixelControlNumbers`: `#rrggbb` → 0..1 per channel, bool → 0 or 1).
public func pixelControlNumbers(_ c: PixelControl, _ value: JSONValue?) -> [Double] {
    let v = (value == nil || value == .null) ? c.defaultValue : value!
    switch c.type {
    case .number:
        return [v.numberValue ?? c.defaultValue.numberValue ?? 0]
    case .bool:
        return [v == .bool(true) ? 1 : 0]
    case .color:
        var hex = c.defaultValue.stringValue ?? "#000000"
        if let s = v.stringValue, s.range(of: HEX_PATTERN, options: .regularExpression) != nil { hex = s }
        let u = Array(hex.utf16)
        return [1, 3, 5].map { k in Double(Int(String(decoding: u[k..<k + 2], as: UTF16.self), radix: 16) ?? 0) / 255 }
    case .vec2:
        // A Float64Array store converts each part with ToNumber.
        func num(_ x: JSONValue) -> Double {
            switch x {
            case .number(let n): return n
            case .bool(let b): return b ? 1 : 0
            case .null: return 0
            default: return .nan
            }
        }
        if let a = v.arrayValue, a.count == 2 { return a.map(num) }
        return (c.defaultValue.arrayValue ?? []).map(num)
    }
}

/// `byte(v)`: v > 0 ? (v < 1 ? Math.round(v·255) : 255) : 0, NaN → 0.
@inline(__always) func pixelByte(_ v: Double) -> UInt8 { v > 0 ? (v < 1 ? UInt8(JS.round(v * 255)) : 255) : 0 }

/// A program ready to run per pixel on the CPU (`PixelEvaluator`).
public final class PixelEvaluator: @unchecked Sendable {
    private typealias Op = (UnsafeMutablePointer<Double>) -> Void
    private let program: PixelProgram
    private var ops: [Op] = []
    private var top = 0
    private var named: [String: Int] = [:]
    private var controlSlots: [Int] = []
    private var outAt = 0
    private let lock = NSLock()
    /// The picture `sample` reads during a `render` (its bytes, width and height).
    private var sampleBytes: UnsafeBufferPointer<UInt8>? = nil
    private var sampleWidth = 0
    private var sampleHeight = 0

    /**
     * Compiles a checked program into register operations: every expression node writes its result
     * into its own slots of one register file, in the order they depend on each other.
     */
    public init(_ program: PixelProgram) {
        self.program = program
        for b in PIXEL_BUILTINS { named[b.name] = alloc(b.size) }
        controlSlots = program.controls.map { c in
            let at = alloc(c.size)
            named[c.name] = at
            return at
        }
        for l in program.lets { named[l.name] = emit(l.expr) }
        outAt = emit(program.out)
    }

    private func alloc(_ n: Int) -> Int {
        let at = top
        top += n
        return at
    }

    private func emit(_ e: PixelExpr) -> Int {
        switch e {
        case .num(let v, _):
            let at = alloc(1)
            ops.append { r in r[at] = v }
            return at
        case .const(let v, _):
            let at = alloc(v.count)
            ops.append { r in for i in 0..<v.count { r[at + i] = v[i] } }
            return at
        case .variable(let name, _, _):
            return named[name]!
        case .neg(let a0, _):
            let a = emit(a0)
            let n = e.size
            let at = alloc(n)
            ops.append { r in for i in 0..<n { r[at + i] = -r[a + i] } }
            return at
        case .swizzle(let a0, let comps, _):
            let a = emit(a0)
            let at = alloc(comps.count)
            ops.append { r in for i in 0..<comps.count { r[at + i] = r[a + comps[i]] } }
            return at
        case .bin(let op, let a0, let b0, let size, _):
            let a = emit(a0)
            let b = emit(b0)
            let f = pixelBinary(op)!
            return each2(f, a, b, a0.size, b0.size, size)
        case .call(let fn, let args0, let size, _):
            let args = args0.map(emit)
            return call(fn, args, args0.map(\.size), size)
        }
    }

    private func each2(_ f: @escaping (Double, Double) -> Double, _ a: Int, _ b: Int, _ sa0: Int, _ sb0: Int, _ n: Int) -> Int {
        let at = alloc(n)
        let sa = sa0 == 1 ? 0 : 1, sb = sb0 == 1 ? 0 : 1
        ops.append { r in for i in 0..<n { r[at + i] = f(r[a + i * sa], r[b + i * sb]) } }
        return at
    }

    private func call(_ fn: String, _ args: [Int], _ sizes: [Int], _ n: Int) -> Int {
        let steps = sizes.map { $0 == 1 ? 0 : 1 }
        if args.count == 1, let f = pixelUnary(fn) {
            let at = alloc(n)
            let a = args[0], sa = steps[0]
            ops.append { r in for i in 0..<n { r[at + i] = f(r[a + i * sa]) } }
            return at
        }
        if let f = pixelBinary(fn) { return each2(f, args[0], args[1], sizes[0], sizes[1], n) }
        if fn == "select" {
            let at = alloc(n)
            let c = args[0], a = args[1], b = args[2]
            let sa = steps[1], sb = steps[2]
            ops.append { r in
                let pick = r[c] > 0.5
                for i in 0..<n { r[at + i] = pick ? r[a + i * sa] : r[b + i * sb] }
            }
            return at
        }
        if let f = pixelTernary(fn) {
            let at = alloc(n)
            let a = args[0], b = args[1], c = args[2]
            let sa = steps[0], sb = steps[1], sc = steps[2]
            ops.append { r in for i in 0..<n { r[at + i] = f(r[a + i * sa], r[b + i * sb], r[c + i * sc]) } }
            return at
        }
        let at = alloc(n)
        let a = args[0]
        let sa = sizes[0]
        switch fn {
        case "length":
            ops.append { r in
                var s = 0.0
                for i in 0..<sa { s += r[a + i] * r[a + i] }
                r[at] = s.squareRoot()
            }
        case "distance", "dot":
            let b = args[1]
            let m = Swift.max(sizes[0], sizes[1])
            let s0 = steps[0], s1 = steps[1]
            if fn == "distance" {
                ops.append { r in
                    var s = 0.0
                    for i in 0..<m {
                        let d = r[a + i * s0] - r[b + i * s1]
                        s += d * d
                    }
                    r[at] = s.squareRoot()
                }
            } else {
                ops.append { r in
                    var s = 0.0
                    for i in 0..<m { s += r[a + i * s0] * r[b + i * s1] }
                    r[at] = s
                }
            }
        case "normalize":
            ops.append { r in
                var s = 0.0
                for i in 0..<n { s += r[a + i] * r[a + i] }
                let len = s.squareRoot()
                for i in 0..<n { r[at + i] = len > 0 ? r[a + i] / len : 0 }
            }
        case "hash":
            ops.append { r in r[at] = pixelHash(r[a], r[a + 1]) }
        case "noise":
            ops.append { r in r[at] = pixelNoise(r[a], r[a + 1]) }
        case "sample":
            ops.append { [unowned self] (r: UnsafeMutablePointer<Double>) in
                if let d = self.sampleBytes {
                    pixelSampleBytes(d, self.sampleWidth, self.sampleHeight, r[a], r[a + 1], into: r, at: at)
                } else {
                    for k in 0..<4 { r[at + k] = 0 }
                }
            }
        case "vec2", "vec3", "vec4":
            if args.count == 1 && sizes[0] == 1 {
                ops.append { r in for i in 0..<n { r[at + i] = r[a] } }
            } else {
                let parts = Array(zip(args, sizes))
                ops.append { r in
                    var o = at
                    for (x, s) in parts {
                        for i in 0..<s {
                            r[o] = r[x + i]
                            o += 1
                        }
                    }
                }
            }
        default:
            fatalError("no evaluator for \(fn)")
        }
        return at
    }

    /**
     * Draws the program into straight-alpha RGBA8 (`out` must hold width × height × 4 bytes).
     * `source` is the picture `sample` reads (any size; none reads as transparent).
     */
    public func render(width: Int, height: Int, timeMs: Double, values: JSONObject, into out: inout [UInt8], source: EffectPixels? = nil) {
        lock.lock()
        defer { lock.unlock() }
        if let source, source.width >= 1, source.height >= 1, source.data.count >= source.width * source.height * 4 {
            source.data.withUnsafeBufferPointer { (d: UnsafeBufferPointer<UInt8>) in
                sampleBytes = d
                sampleWidth = source.width
                sampleHeight = source.height
                defer { sampleBytes = nil }
                draw(width: width, height: height, timeMs: timeMs, values: values, into: &out)
            }
        } else {
            sampleBytes = nil
            draw(width: width, height: height, timeMs: timeMs, values: values, into: &out)
        }
    }

    private func draw(width: Int, height: Int, timeMs: Double, values: JSONObject, into out: inout [UInt8]) {
        let regs = UnsafeMutablePointer<Double>.allocate(capacity: Swift.max(1, top))
        regs.initialize(repeating: 0, count: Swift.max(1, top))
        defer { regs.deallocate() }
        let uv = named["uv"]!, pos = named["pos"]!, sz = named["size"]!
        regs[sz] = Double(width)
        regs[sz + 1] = Double(height)
        regs[named["time"]!] = timeMs / 1000
        regs[named["PI"]!] = Double.pi
        regs[named["TAU"]!] = Double.pi * 2
        for (i, c) in program.controls.enumerated() {
            let v = pixelControlNumbers(c, values[c.name])
            for k in 0..<v.count { regs[controlSlots[i] + k] = v[k] }
        }
        let outSize = program.out.size
        let W = Double(width), H = Double(height)
        var o = 0
        out.withUnsafeMutableBufferPointer { buf in
            for y in 0..<Swift.max(0, height) {
                for x in 0..<Swift.max(0, width) {
                    regs[pos] = Double(x) + 0.5
                    regs[pos + 1] = Double(y) + 0.5
                    regs[uv] = (Double(x) + 0.5) / W
                    regs[uv + 1] = (Double(y) + 0.5) / H
                    for op in ops { op(regs) }
                    if outSize == 1 {
                        let g = pixelByte(regs[outAt])
                        buf[o] = g
                        buf[o + 1] = g
                        buf[o + 2] = g
                        buf[o + 3] = 255
                    } else {
                        buf[o] = pixelByte(regs[outAt])
                        buf[o + 1] = pixelByte(regs[outAt + 1])
                        buf[o + 2] = pixelByte(regs[outAt + 2])
                        buf[o + 3] = outSize == 4 ? pixelByte(regs[outAt + 3]) : 255
                    }
                    o += 4
                }
            }
        }
    }
}

/// `createPixelEvaluator`.
public func createPixelEvaluator(_ program: PixelProgram) -> PixelEvaluator { PixelEvaluator(program) }
