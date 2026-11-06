import Foundation

/// The code points JavaScript's `String.prototype.trim` and `\s` treat as white space
/// (WhiteSpace and LineTerminator in ECMA-262).
public func isJSWhitespace(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

extension String {
    /// `String.prototype.trim`: JavaScript's white space and line terminators, not Foundation's.
    public var jsTrimmed: String {
        let scalars = Array(unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end && isJSWhitespace(scalars[start]) { start += 1 }
        while end > start && isJSWhitespace(scalars[end - 1]) { end -= 1 }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: scalars[start ..< end])
        return String(out)
    }

    /// `String.prototype.toLowerCase`: the full Unicode lowercase mapping (`İ` → `i̇`) with the
    /// Final_Sigma rule V8 applies (`ΟΔΟΣ` → `οδος`), which Swift's `lowercased()` leaves out.
    public var jsLowercased: String {
        if utf8.allSatisfy({ $0 < 0x80 }) { return lowercased() }
        let scalars = Array(unicodeScalars)
        var out = ""
        for (i, s) in scalars.enumerated() {
            if s.value == 0x03A3 {
                out += isFinalSigma(scalars, i) ? "ς" : "σ"
            } else {
                out += s.properties.lowercaseMapping
            }
        }
        return out
    }
}

/// Unicode's Final_Sigma condition: a cased letter (then case-ignorables) before, and no
/// case-ignorables followed by a cased letter after.
private func isFinalSigma(_ scalars: [Unicode.Scalar], _ i: Int) -> Bool {
    var j = i - 1
    while j >= 0 && scalars[j].properties.isCaseIgnorable { j -= 1 }
    guard j >= 0 && scalars[j].properties.isCased else { return false }
    var k = i + 1
    while k < scalars.count && scalars[k].properties.isCaseIgnorable { k += 1 }
    return !(k < scalars.count && scalars[k].properties.isCased)
}

// MARK: - Numbers from strings

/// `[+-]?(Infinity|digits[.digits][e±digits]|.digits[e±digits])`, the StrDecimalLiteral of ECMA-262.
private func decimalPrefix(_ scalars: [Unicode.Scalar], _ from: Int) -> Int {
    var i = from
    func digit(_ k: Int) -> Bool { k < scalars.count && scalars[k].value >= 48 && scalars[k].value <= 57 }
    if i < scalars.count && (scalars[i] == "+" || scalars[i] == "-") { i += 1 }
    let inf = Array("Infinity".unicodeScalars)
    if i + inf.count <= scalars.count && Array(scalars[i ..< i + inf.count]) == inf { return i + inf.count }
    let start = i
    while digit(i) { i += 1 }
    let intDigits = i - start
    var fracDigits = 0
    if i < scalars.count && scalars[i] == "." {
        var k = i + 1
        while digit(k) { k += 1 }
        fracDigits = k - i - 1
        if intDigits > 0 || fracDigits > 0 { i = k }
    }
    if intDigits == 0 && fracDigits == 0 { return from }
    if i < scalars.count && (scalars[i] == "e" || scalars[i] == "E") {
        var k = i + 1
        if k < scalars.count && (scalars[k] == "+" || scalars[k] == "-") { k += 1 }
        let e0 = k
        while digit(k) { k += 1 }
        if k > e0 { i = k }
    }
    return i
}

private func decimalValue(_ scalars: ArraySlice<Unicode.Scalar>) -> Double {
    var s = String(String.UnicodeScalarView(scalars))
    if s.hasSuffix("Infinity") { return s.hasPrefix("-") ? -.infinity : .infinity }
    // Swift's parser wants a digit after a lone trailing point ("5." is 5 in JavaScript).
    if let dot = s.firstIndex(of: "."), s.index(after: dot) == s.endIndex || !(s[s.index(after: dot)].isNumber) {
        s.insert("0", at: s.index(after: dot))
    }
    return Double(s) ?? .nan
}

extension String {
    /// `String.prototype.trimStart`.
    public var jsTrimmedStart: String {
        let scalars = Array(unicodeScalars)
        var start = 0
        while start < scalars.count && isJSWhitespace(scalars[start]) { start += 1 }
        return String(String.UnicodeScalarView(scalars[start...]))
    }

    /// `parseFloat(s)`: the longest decimal prefix after leading white space, or NaN.
    public var jsParseFloat: Double {
        let scalars = Array(jsTrimmedStart.unicodeScalars)
        let end = decimalPrefix(scalars, 0)
        return end == 0 ? .nan : decimalValue(scalars[0 ..< end])
    }

    /// `Number(s)`: the whole trimmed string as a number (0 when empty, hex / octal / binary
    /// literals read), or NaN.
    public var jsToNumber: Double {
        let t = jsTrimmed
        if t.isEmpty { return 0 }
        let scalars = Array(t.unicodeScalars)
        if scalars.count > 2, scalars[0] == "0" {
            let radix: Int? = switch scalars[1] {
            case "x", "X": 16
            case "o", "O": 8
            case "b", "B": 2
            default: nil
            }
            if let radix {
                var v = 0.0
                for s in scalars[2...] {
                    guard let d = Int(String(s), radix: radix) else { return .nan }
                    v = v * Double(radix) + Double(d)
                }
                return v
            }
        }
        let end = decimalPrefix(scalars, 0)
        return end == scalars.count ? decimalValue(scalars[0 ..< end]) : .nan
    }
}

/// `Number.prototype.toFixed(digits)` for finite values: the nearest multiple of 10^-digits, the
/// larger one on an exact tie (`printf` rounds exact ties to even), and the sign of any negative.
public func jsToFixed(_ v: Double, _ digits: Int) -> String {
    if v.isNaN { return "NaN" }
    if Swift.abs(v) >= 1e21 || !v.isFinite { return v.isFinite ? JSONValue.jsNumber(v) : v < 0 ? "-Infinity" : "Infinity" }
    let a = Swift.abs(v)
    var s = String(format: "%.\(digits)f", a)
    // An exact tie has a terminating expansion that is 5 just past the last digit, then zeros.
    let exact = String(format: "%.\(digits + 40)f", a)
    let tail = exact.suffix(40)
    if tail.first == "5" && tail.dropFirst().allSatisfy({ $0 == "0" }) {
        var chars = Array(exact.dropLast(40))
        if chars.last == "." { chars.removeLast() }
        var k = chars.count - 1
        var carry = true
        while carry && k >= 0 {
            if chars[k] == "." { k -= 1; continue }
            if chars[k] == "9" {
                chars[k] = "0"
                k -= 1
            } else {
                chars[k] = Character(String(chars[k].wholeNumberValue! + 1))
                carry = false
            }
        }
        if carry { chars.insert("1", at: 0) }
        s = String(chars)
    }
    return v < 0 ? "-" + s : s
}
