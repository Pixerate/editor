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

/// Exact decimal significant digits (without leading or trailing zeros, except `"0"` for 0)
/// and base-10 scientific exponent (`abs(value) == d0.d1d2... * 10^exp10`) of an IEEE-754 `Double`.
public func jsExactDecimal(_ value: Double) -> (digits: String, exp10: Int) {
    let a = abs(value)
    if a == 0 || !a.isFinite { return ("0", 0) }
    let bits = a.bitPattern
    let rawExp = Int((bits >> 52) & 0x7ff)
    let frac = bits & 0x000f_ffff_ffff_ffff
    let mant = rawExp == 0 ? frac : ((1 as UInt64) << 52) | frac
    let exp2 = (rawExp == 0 ? 1 : rawExp) - 1023 - 52

    let base: UInt64 = 1_000_000_000
    var limbs: [UInt32] = []
    var m = mant
    while m > 0 {
        limbs.append(UInt32(m % base))
        m /= base
    }
    func mul(_ factor: UInt64) {
        var carry: UInt64 = 0
        for i in 0..<limbs.count {
            let prod = UInt64(limbs[i]) * factor + carry
            limbs[i] = UInt32(prod % base)
            carry = prod / base
        }
        while carry > 0 {
            limbs.append(UInt32(carry % base))
            carry /= base
        }
    }
    let decimalShift: Int
    if exp2 >= 0 {
        var rem = exp2
        while rem > 0 {
            let step = min(rem, 29)
            mul(1 << step)
            rem -= step
        }
        decimalShift = 0
    } else {
        var rem = -exp2
        let pow5: [UInt64] = [
            1, 5, 25, 125, 625, 3125, 15625, 78125,
            390625, 1_953_125, 9_765_625, 48_828_125, 244_140_625
        ]
        while rem > 0 {
            let step = min(rem, 12)
            mul(pow5[step])
            rem -= step
        }
        decimalShift = exp2
    }
    var raw = String(limbs[limbs.count - 1])
    if limbs.count > 1 {
        for i in stride(from: limbs.count - 2, through: 0, by: -1) {
            let part = String(limbs[i])
            if part.count < 9 {
                raw += String(repeating: "0", count: 9 - part.count)
            }
            raw += part
        }
    }
    let exp10 = raw.count - 1 + decimalShift
    var trimmed = raw
    while trimmed.count > 1 && trimmed.last == "0" {
        trimmed.removeLast()
    }
    return (trimmed, exp10)
}

private func jsRoundSignificant(_ value: Double, precision: Int) -> (digits: String, exp10: Int) {
    let p = max(1, precision)
    let (digits, exp10) = jsExactDecimal(value)
    let bytes = Array(digits.utf8)
    if bytes.count <= p {
        return (digits + String(repeating: "0", count: p - bytes.count), exp10)
    }
    var prefix = Array(bytes[0..<p])
    if bytes[p] >= UInt8(ascii: "5") {
        var k = p - 1
        var carry = true
        while carry && k >= 0 {
            if prefix[k] == UInt8(ascii: "9") {
                prefix[k] = UInt8(ascii: "0")
                k -= 1
            } else {
                prefix[k] += 1
                carry = false
            }
        }
        if carry {
            return ("1" + String(repeating: "0", count: p - 1), exp10 + 1)
        }
    }
    return (String(decoding: prefix, as: UTF8.self), exp10)
}

/// JS `Number.prototype.toExponential(fractionDigits)` (0 ≤ fractionDigits ≤ 100).
public func jsToExponential(_ value: Double, _ fractionDigits: Int) -> String {
    if value.isNaN { return "NaN" }
    if !value.isFinite { return value < 0 ? "-Infinity" : "Infinity" }
    let f = max(0, min(100, fractionDigits))
    let sign = value < 0 ? "-" : ""
    if value == 0 {
        let frac = f > 0 ? "." + String(repeating: "0", count: f) : ""
        return "\(sign)0\(frac)e+0"
    }
    let (digits, exp10) = jsRoundSignificant(abs(value), precision: f + 1)
    let mantissa = f == 0 ? digits : "\(digits.prefix(1)).\(digits.dropFirst())"
    let expSign = exp10 >= 0 ? "+" : "-"
    return "\(sign)\(mantissa)e\(expSign)\(abs(exp10))"
}

/// JS `Number.prototype.toPrecision(precision)` (1 ≤ precision ≤ 100).
public func jsToPrecision(_ value: Double, _ precision: Int) -> String {
    if value.isNaN { return "NaN" }
    if !value.isFinite { return value < 0 ? "-Infinity" : "Infinity" }
    let p = max(1, min(100, precision))
    let sign = value < 0 ? "-" : ""
    if value == 0 {
        return sign + (p > 1 ? "0." + String(repeating: "0", count: p - 1) : "0")
    }
    let (digits, e) = jsRoundSignificant(abs(value), precision: p)
    if e < -6 || e >= p {
        let mantissa = p == 1 ? digits : "\(digits.prefix(1)).\(digits.dropFirst())"
        let expSign = e >= 0 ? "+" : "-"
        return "\(sign)\(mantissa)e\(expSign)\(abs(e))"
    }
    if e == p - 1 {
        return sign + digits
    }
    if e >= 0 {
        let split = digits.index(digits.startIndex, offsetBy: e + 1)
        return "\(sign)\(digits[..<split]).\(digits[split...])"
    }
    return "\(sign)0.\(String(repeating: "0", count: -(e + 1)))\(digits)"
}
