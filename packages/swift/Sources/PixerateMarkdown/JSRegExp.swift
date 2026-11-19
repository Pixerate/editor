import Foundation

/// The white space JavaScript's `\s` matches (WhiteSpace and LineTerminator in ECMA-262), as the
/// inside of an ICU character class.
private let JS_SPACE = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"
private let JS_WORD = "A-Za-z0-9_"
private let JS_BOUNDARY = "(?:(?<=[\(JS_WORD)])(?![\(JS_WORD)])|(?<![\(JS_WORD)])(?=[\(JS_WORD)]))"
private let JS_NOT_BOUNDARY = "(?:(?<=[\(JS_WORD)])(?=[\(JS_WORD)])|(?<![\(JS_WORD)])(?![\(JS_WORD)]))"

/**
 * A JavaScript regular expression (with the `u` flag) run by `NSRegularExpression`, so a port of
 * the TS core matches what it matches. ICU differs from JavaScript in ways the pattern is
 * rewritten for: `$` also matches before a final line break in ICU (it becomes `\z`), `\d`, `\s`,
 * `\w` and `\b` are Unicode-wide in ICU (they become JavaScript's sets), and an unescaped `[`
 * inside a class starts a nested set in ICU (it is escaped). Positions are UTF-16 offsets.
 */
public struct JSRegExp: @unchecked Sendable {
    public let regex: NSRegularExpression

    public init(_ pattern: String, ignoreCase: Bool = false) {
        regex = try! NSRegularExpression(pattern: JSRegExp.translate(pattern), options: ignoreCase ? [.caseInsensitive] : [])
    }

    /// The ICU pattern for JavaScript `pattern`.
    static func translate(_ pattern: String) -> String {
        var out = ""
        var inClass = false
        var chars = Array(pattern)
        var i = 0
        // A class may start with `]` or `^]` in neither language here; keep it simple.
        while i < chars.count {
            let c = chars[i]
            if c == "\\" && i + 1 < chars.count {
                let n = chars[i + 1]
                i += 2
                switch n {
                case "d": out += inClass ? "0-9" : "[0-9]"
                case "D": out += "[^0-9]"
                case "s": out += inClass ? JS_SPACE : "[\(JS_SPACE)]"
                case "S": out += "[^\(JS_SPACE)]"
                case "w": out += inClass ? JS_WORD : "[\(JS_WORD)]"
                case "W": out += "[^\(JS_WORD)]"
                case "b": out += inClass ? "\\x{08}" : JS_BOUNDARY
                case "B": out += JS_NOT_BOUNDARY
                default: out += "\\\(n)"
                }
                continue
            }
            if inClass {
                if c == "]" { inClass = false; out += "]" }
                else if c == "[" { out += "\\[" }
                else if c == "&" && i + 1 < chars.count && chars[i + 1] == "&" { out += "\\&" }
                else { out.append(c) }
            } else {
                if c == "[" { inClass = true; out += "[" }
                else if c == "$" { out += "\\z" }
                else { out.append(c) }
            }
            i += 1
        }
        chars.removeAll()
        return out
    }

    /// `regex.exec(text.slice(from))` with offsets in `text`: the first match at or after `from`.
    public func exec(_ text: NSString, from: Int = 0, to: Int? = nil) -> NSTextCheckingResult? {
        let end = to ?? text.length
        guard from <= end else { return nil }
        return regex.firstMatch(in: text as String, options: [], range: NSRange(location: from, length: end - from))
    }

    /// `regex.test(text)`.
    public func test(_ text: NSString) -> Bool { exec(text) != nil }
    public func test(_ text: String) -> Bool { test(text as NSString) }

    /// `text.matchAll(regex)` (global).
    public func matches(_ text: NSString) -> [NSTextCheckingResult] {
        regex.matches(in: text as String, options: [], range: NSRange(location: 0, length: text.length))
    }

    /// A match's group `i` as a string, or nil when it did not take part.
    public static func group(_ m: NSTextCheckingResult, _ i: Int, in text: NSString) -> String? {
        let r = m.range(at: i)
        return r.location == NSNotFound ? nil : text.substring(with: r)
    }
}
