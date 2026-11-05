import Foundation
import PixerateCore

// Expressions for dimensional constraints and named parameters (`vector/constraints/expr.ts`):
// numbers, names, `+ - * /`, unary minus, parentheses and the constant `pi`. The parser walks
// UTF-16 code units, as the TS indexes its string.

/// Longest expression accepted (UTF-16 code units, `VECTOR_EXPR_MAX_LENGTH`).
public let VECTOR_EXPR_MAX_LENGTH = 1024
/// Deepest nesting (parentheses, unary minus) and name reference chain.
private let MAX_DEPTH = 64

/// What is wrong with an expression (`VectorExprError`).
public struct VectorExprError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

private indirect enum Expr {
    case num(Double)
    case variable(String)
    case neg(Expr)
    case bin(UInt16, Expr, Expr)
}

private let C_PLUS: UInt16 = 0x2B, C_MINUS: UInt16 = 0x2D, C_STAR: UInt16 = 0x2A, C_SLASH: UInt16 = 0x2F
private let C_OPEN: UInt16 = 0x28, C_CLOSE: UInt16 = 0x29, C_DOT: UInt16 = 0x2E

/// JavaScript's `\s` on one UTF-16 code unit.
private func isSpace(_ c: UInt16) -> Bool {
    switch c {
    case 0x09 ... 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

private func isDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }
private func isLetter(_ c: UInt16) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F }

private func text(_ units: ArraySlice<UInt16>) -> String { String(decoding: Array(units), as: UTF16.self) }

/// A valid name: a letter or `_`, then letters, digits or `_` (not `pi`), at most 64 characters.
public func isValidVectorParameterName(_ s: String) -> Bool {
    let u = Array(s.utf16)
    guard let first = u.first, isLetter(first), u.allSatisfy({ isLetter($0) || isDigit($0) }) else { return false }
    return u.count <= 64 && s.lowercased() != "pi"
}

private func parse(_ source: String) throws -> Expr {
    let t = Array(source.utf16)
    if t.count > VECTOR_EXPR_MAX_LENGTH { throw VectorExprError("expression too long or too deeply nested") }
    if source.jsTrimmed.isEmpty { throw VectorExprError("syntax error: empty expression") }
    var i = 0
    var depth = 0
    func ws() { while i < t.count && isSpace(t[i]) { i += 1 } }
    func peek() -> UInt16? {
        ws()
        return i < t.count ? t[i] : nil
    }
    func enter() throws {
        depth += 1
        if depth > MAX_DEPTH { throw VectorExprError("expression too long or too deeply nested") }
    }
    func sum() throws -> Expr {
        try enter()
        var e = try product()
        var c = peek()
        while let op = c, op == C_PLUS || op == C_MINUS {
            i += 1
            e = .bin(op, e, try product())
            c = peek()
        }
        depth -= 1
        return e
    }
    func product() throws -> Expr {
        var e = try unary()
        var c = peek()
        while let op = c, op == C_STAR || op == C_SLASH {
            i += 1
            e = .bin(op, e, try unary())
            c = peek()
        }
        return e
    }
    func unary() throws -> Expr {
        let c = peek()
        if c == C_MINUS || c == C_PLUS {
            i += 1
            try enter()
            let e = try unary()
            depth -= 1
            return c == C_MINUS ? .neg(e) : e
        }
        return try atom()
    }
    func atom() throws -> Expr {
        let c = peek()
        if c == C_OPEN {
            i += 1
            let e = try sum()
            if peek() != C_CLOSE { throw VectorExprError("syntax error: missing `)`") }
            i += 1
            return e
        }
        if let c, isDigit(c) || c == C_DOT {
            // /^(\d*\.?\d*)([eE][+-]?\d+)?/
            var j = i
            while j < t.count && isDigit(t[j]) { j += 1 }
            if j < t.count && t[j] == C_DOT { j += 1 }
            while j < t.count && isDigit(t[j]) { j += 1 }
            let mantissa = text(t[i ..< j])
            if j < t.count && (t[j] == 0x65 || t[j] == 0x45) {
                var k = j + 1
                if k < t.count && (t[k] == C_PLUS || t[k] == C_MINUS) { k += 1 }
                let digits = k
                while k < t.count && isDigit(t[k]) { k += 1 }
                if k > digits { j = k }
            }
            let whole = text(t[i ..< j])
            i = j
            let v = whole.jsToNumber
            if mantissa.isEmpty || mantissa == "." || !v.isFinite { throw VectorExprError("syntax error: bad number `\(whole)`") }
            if i < t.count && t[i] == C_DOT { throw VectorExprError("syntax error: bad number `\(whole).`") }
            return .num(v)
        }
        if let c, isLetter(c) {
            var j = i
            while j < t.count && (isLetter(t[j]) || isDigit(t[j])) { j += 1 }
            let name = text(t[i ..< j])
            i = j
            return name.lowercased() == "pi" ? .num(Double.pi) : .variable(name)
        }
        if c == nil { throw VectorExprError("syntax error: unexpected end") }
        throw VectorExprError("syntax error: unexpected `\(text(t[i ... i]))`")
    }
    let e = try sum()
    if peek() != nil { throw VectorExprError("syntax error: unexpected `\(text(t[i...]).jsTrimmed)`") }
    return e
}

private func evalWith(_ e: Expr, _ lookup: (String) throws -> Double) throws -> Double {
    let v: Double
    switch e {
    case let .num(n): v = n
    case let .variable(n): v = try lookup(n)
    case let .neg(a): v = -(try evalWith(a, lookup))
    case let .bin(op, a, b):
        let x = try evalWith(a, lookup)
        let y = try evalWith(b, lookup)
        if op == C_SLASH && y == 0 { throw VectorExprError("division by zero") }
        v = op == C_PLUS ? x + y : op == C_MINUS ? x - y : op == C_STAR ? x * y : x / y
    }
    if !v.isFinite { throw VectorExprError("result is not a finite number") }
    return v
}

/// Checks an expression's syntax (throws a `VectorExprError` saying what is wrong).
public func checkVectorExpression(_ text: String) throws {
    _ = try parse(text)
}

/// Names an expression refers to, in first-use order.
public func vectorExpressionNames(_ text: String) throws -> [String] {
    var out: [String] = []
    func walk(_ e: Expr) {
        switch e {
        case let .variable(n): if !out.contains(n) { out.append(n) }
        case let .neg(a): walk(a)
        case let .bin(_, a, b):
            walk(a)
            walk(b)
        case .num: break
        }
    }
    walk(try parse(text))
    return out
}

/// Named expressions (parameters and dimensional constraint names), evaluated lazily with cycle
/// detection (`VectorExprEnv`).
public final class VectorExprEnv {
    private var exprs: [String: String] = [:]
    private var cache: [String: Double] = [:]

    public init() {}

    public func set(_ name: String, _ expr: String) {
        exprs[name] = expr
        cache.removeAll()
    }

    public func has(_ name: String) -> Bool { exprs[name] != nil }

    /// The value of a name.
    public func value(_ name: String) throws -> Double {
        var stack: [String] = []
        return try value(name, &stack)
    }

    private func value(_ name: String, _ stack: inout [String]) throws -> Double {
        if let hit = cache[name] { return hit }
        if stack.contains(name) { throw VectorExprError("parameter `\(name)` refers to itself") }
        if stack.count >= MAX_DEPTH { throw VectorExprError("expression too long or too deeply nested") }
        guard let text = exprs[name] else { throw VectorExprError("unknown parameter `\(name)`") }
        let e = try parse(text)
        stack.append(name)
        let v = try evalWith(e) { n in try self.value(n, &stack) }
        stack.removeLast()
        cache[name] = v
        return v
    }

    /// Evaluates a free expression against these names.
    public func eval(_ text: String) throws -> Double {
        try evalWith(try parse(text)) { n in try self.value(n) }
    }
}

/// Evaluates an expression with no names.
public func evalVectorExpression(_ text: String) throws -> Double {
    try evalWith(try parse(text)) { n in throw VectorExprError("unknown parameter `\(n)`") }
}

/// A value as an expression: up to 6 decimals, trailing zeros trimmed (`formatVectorValue`).
public func formatVectorValue(_ v: Double) -> String {
    var s = jsToFixed(v, 6)
    while s.hasSuffix("0") { s.removeLast() }
    if s.hasSuffix(".") { s.removeLast() }
    return s.isEmpty || s == "-0" ? "0" : s
}
