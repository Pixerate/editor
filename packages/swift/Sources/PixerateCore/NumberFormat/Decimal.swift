// Portions ported from gridcraft/crates/numfmt/src/decimal.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation

/// Most decimals ever computed; placeholders beyond this are padded with zeros.
public let MAX_DECIMALS = 400

/// `n` significant digits of a positive finite `a` (correctly rounded) and the
/// power of ten of the first digit.
private func significantDigits(_ a: Double, _ n: Int) -> (digits: [Int], exp: Int) {
    let frac = Swift.max(0, Swift.min(100, n - 1))
    let s = jsToExponential(a, frac)
    let bytes = Array(s.utf8)
    guard let eIdx = bytes.firstIndex(of: UInt8(ascii: "e")) else {
        return (digits: [0], exp: 0)
    }
    var digits: [Int] = []
    digits.reserveCapacity(n)
    for i in 0..<eIdx {
        let c = bytes[i]
        if c >= 48 && c <= 57 {
            digits.append(Int(c - 48))
        }
    }
    let expStr = String(decoding: bytes[(eIdx + 1)...], as: UTF8.self)
    let exp = Int(expStr) ?? 0
    return (digits: digits, exp: exp)
}

/// The exact decimal expansion of a positive finite double, as significant digits (no trailing zeros).
private func exactDigits(_ a: Double) -> String {
    let (digits, _) = jsExactDecimal(a)
    var chars = Array(digits)
    while chars.last == "0" {
        chars.removeLast()
    }
    return String(chars)
}

/// True when `a`'s exact decimal expansion has a 5 as its 16th significant digit and only zeros after.
private func isExactTie(_ a: Double) -> Bool {
    func isTie(_ ds: String) -> Bool {
        let chars = Array(ds.utf8)
        guard chars.count >= 16, chars[15] == UInt8(ascii: "5") else { return false }
        for i in 16..<chars.count {
            if chars[i] != UInt8(ascii: "0") { return false }
        }
        return true
    }
    let screen = significantDigits(a, 30).digits.map(String.init).joined()
    guard isTie(screen) else { return false }
    var exact = exactDigits(a)
    if exact.count < 16 {
        exact += String(repeating: "0", count: 16 - exact.count)
    }
    return isTie(exact)
}

/// The 15 significant digits of a positive finite number and the power of ten
/// of the first digit: `a ≈ d0.d1d2… × 10^exp`.
///
/// The value is rounded to the nearest 15-digit decimal. An exact tie at the
/// 16th digit goes toward zero, as Excel does: `1234567890123455` shows
/// `1234567890123450`, not `…460`.
public func decimalDigits(_ a: Double) -> (digits: [Int], exp: Int) {
    if !a.isFinite || a <= 0 {
        return (digits: Array(repeating: 0, count: 15), exp: 0)
    }
    let (d16, exp) = significantDigits(a, 16)
    var digits = Array(d16.prefix(15))
    while digits.count < 15 { digits.append(0) }
    let sixteenth = d16.count > 15 ? d16[15] : 0
    if sixteenth <= 4 {
        return (digits: digits, exp: exp)
    }
    if sixteenth == 5 {
        if isExactTie(a) {
            return (digits: digits, exp: exp)
        }
        var r = significantDigits(a, 15)
        while r.digits.count < 15 { r.digits.append(0) }
        return r
    }
    var e = exp
    var carry = true
    for i in stride(from: 14, through: 0, by: -1) {
        if digits[i] == 9 {
            digits[i] = 0
        } else {
            digits[i] += 1
            carry = false
            break
        }
    }
    if carry {
        digits = Array(repeating: 0, count: 15)
        digits[0] = 1
        e += 1
    }
    return (digits: digits, exp: e)
}

/// Rounds the number `digits × 10^exp` (see `decimalDigits`) to `decimals`
/// places, half away from zero. Returns the integer digits (`""` when the
/// integer part is zero) and exactly `decimals` fraction digits.
public func fixedFromDigits(_ digits: [Int], _ exp: Int, _ decimals: Int) -> (String, String) {
    let decimalsCalc = Swift.min(decimals, MAX_DECIMALS)
    let keep = exp + decimalsCalc + 1
    var m: [Int]
    if keep <= 0 {
        m = (keep == 0 && (digits.first ?? 0) >= 5) ? [1] : []
    } else if keep >= digits.count {
        m = digits
        while m.count < keep { m.append(0) }
    } else {
        m = Array(digits.prefix(keep))
        if (keep < digits.count ? digits[keep] : 0) >= 5 {
            var carry = true
            for i in stride(from: m.count - 1, through: 0, by: -1) {
                if m[i] == 9 {
                    m[i] = 0
                } else {
                    m[i] += 1
                    carry = false
                    break
                }
            }
            if carry { m.insert(1, at: 0) }
        }
    }
    var lead = 0
    while lead < m.count && m[lead] == 0 { lead += 1 }
    m = Array(m.dropFirst(lead))
    func toS(_ ds: ArraySlice<Int>) -> String {
        ds.map(String.init).joined()
    }
    let intPart: String
    var fracPart: String
    if m.count <= decimalsCalc {
        intPart = ""
        let zeros = Swift.max(0, decimalsCalc - m.count)
        fracPart = String(repeating: "0", count: zeros) + toS(m[...])
    } else {
        let split = m.count - decimalsCalc
        intPart = toS(m[0..<split])
        fracPart = toS(m[split..<m.count])
    }
    if decimals > decimalsCalc {
        fracPart += String(repeating: "0", count: decimals - decimalsCalc)
    }
    return (intPart, fracPart)
}

/// Rounds a non-negative number to `decimals` places (see `fixedFromDigits`).
public func fixed(_ a: Double, _ decimals: Int) -> (String, String) {
    if !a.isFinite || a <= 0 {
        let count = Swift.max(0, Swift.min(decimals, MAX_DECIMALS * 4))
        return ("", String(repeating: "0", count: count))
    }
    let (digits, exp) = decimalDigits(a)
    return fixedFromDigits(digits, exp, decimals)
}

private func charCount(_ s: String) -> Int {
    s.unicodeScalars.count
}

private func stripTrailingZeros(_ s: String) -> String {
    var chars = Array(s)
    while chars.last == "0" {
        chars.removeLast()
    }
    return String(chars)
}

/// The General format squeezed into `maxChars` characters, as Excel shows it
/// in a narrow column: fewer decimals, then scientific notation; `nil` when
/// even that does not fit (the caller paints `####`).
public func formatGeneralFit(_ n: Double, _ maxChars: Int) -> String? {
    if !n.isFinite { return nil }
    if n == 0 { return maxChars >= 1 ? "0" : nil }
    let sign = n < 0 ? "-" : ""
    let (digits, x) = decimalDigits(abs(n))
    let intLen = sign.count + Swift.max(x, 0) + 1
    if x >= -4 && intLen <= maxChars {
        let avail = maxChars - intLen
        var decimals = avail >= 2 ? avail - 1 : 0
        while true {
            let (i, f0) = fixedFromDigits(digits, x, decimals)
            let f = stripTrailingZeros(f0)
            if i.isEmpty && f.isEmpty { break }
            var s = sign + (i.isEmpty ? "0" : i)
            if !f.isEmpty { s += ".\(f)" }
            if charCount(s) <= maxChars { return s }
            if decimals == 0 { break }
            decimals -= 1
        }
    }
    let maxMd = Swift.min(maxChars, 14)
    if maxMd >= 0 {
        for md in stride(from: maxMd, through: 0, by: -1) {
            var e = x
            var (mi, mf) = fixedFromDigits(digits, 0, md)
            if mi.count > 1 {
                e += 1
                (mi, mf) = fixedFromDigits(digits, -1, md)
            }
            mf = stripTrailingZeros(mf)
            var s = sign + (mi.isEmpty ? "0" : mi)
            if !mf.isEmpty { s += ".\(mf)" }
            let absE = String(abs(e))
            let paddedE = absE.count < 2 ? String(repeating: "0", count: 2 - absE.count) + absE : absE
            s += "E\(e < 0 ? "-" : "+")\(paddedE)"
            if charCount(s) <= maxChars { return s }
        }
    }
    return nil
}
