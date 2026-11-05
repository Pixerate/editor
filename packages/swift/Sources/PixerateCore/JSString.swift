import Foundation

/// The code points JavaScript's `String.prototype.trim` and `\s` treat as white space
/// (WhiteSpace and LineTerminator in ECMA-262).
func isJSWhitespace(_ s: Unicode.Scalar) -> Bool {
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
