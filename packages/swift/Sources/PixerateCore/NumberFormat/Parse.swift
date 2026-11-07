// Portions ported from gridcraft/crates/numfmt/src/parse.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation

/// Colour from a `[Red]` or `[ColorN]` section tag (`color1`…`color56` = palette index).
public typealias NumberFormatColor = String

private let MAX_SECTIONS = 4

public enum DatePartKind: String, Sendable, Equatable {
    case year
    case month
    case minute
    case day
    case hour
    case second
    case subsec
    case eh
    case em
    case es
}

public enum DatePart: Sendable, Equatable {
    case part(k: DatePartKind, n: Int)
    case ampm
    case ap(a: String, p: String)
}

public func isCalendarPart(_ d: DatePart) -> Bool {
    if case let .part(k, _) = d {
        return k == .year || k == .month || k == .day
    }
    return false
}

public enum Tok: Sendable, Equatable {
    case lit(String)
    case digit(String)
    case point
    case comma
    case percent
    case exp(upper: Bool, plus: Bool)
    case slash
    case denom(String)
    case fill(String)
    case at
    case general
    case date(DatePart)
}

public func literalText(_ tok: Tok) -> String {
    switch tok {
    case .lit(let s), .denom(let s):
        return s
    case .digit(let c):
        return c
    case .point:
        return "."
    case .comma:
        return ","
    case .percent:
        return "%"
    case .exp(let upper, let plus):
        return "\(upper ? "E" : "e")\(plus ? "+" : "-")"
    case .slash:
        return "/"
    default:
        return ""
    }
}

public enum CondOp: String, Sendable, Equatable {
    case eq = "="
    case ne = "<>"
    case lt = "<"
    case le = "<="
    case gt = ">"
    case ge = ">="
}

public struct Cond: Sendable, Equatable {
    public var op: CondOp
    public var value: Double

    public init(op: CondOp, value: Double) {
        self.op = op
        self.value = value
    }
}

public func testCond(_ c: Cond, _ v: Double) -> Bool {
    switch c.op {
    case .eq: return v == c.value
    case .ne: return v != c.value
    case .lt: return v < c.value
    case .le: return v <= c.value
    case .gt: return v > c.value
    case .ge: return v >= c.value
    }
}

public enum SecKind: String, Sendable, Equatable {
    case number
    case date
    case text
    case general
}

public struct Section: Sendable, Equatable {
    public var toks: [Tok]
    public var color: NumberFormatColor?
    public var cond: Cond?
    public var kind: SecKind
    public var thousands: Bool
    public var scale: Int
    public var percent: Int
    public var hasAt: Bool
    public var hasDigits: Bool
    public var exp: Bool
    public var fraction: Bool
    public var currency: Bool
    public var fill: Bool

    public init(
        toks: [Tok] = [],
        color: NumberFormatColor? = nil,
        cond: Cond? = nil,
        kind: SecKind = .number,
        thousands: Bool = false,
        scale: Int = 0,
        percent: Int = 0,
        hasAt: Bool = false,
        hasDigits: Bool = false,
        exp: Bool = false,
        fraction: Bool = false,
        currency: Bool = false,
        fill: Bool = false
    ) {
        self.toks = toks
        self.color = color
        self.cond = cond
        self.kind = kind
        self.thousands = thousands
        self.scale = scale
        self.percent = percent
        self.hasAt = hasAt
        self.hasDigits = hasDigits
        self.exp = exp
        self.fraction = fraction
        self.currency = currency
        self.fill = fill
    }
}

private func isDigitTok(_ t: Tok?, _ c: String? = nil) -> Bool {
    guard case let .digit(tc)? = t else { return false }
    return c == nil || tc == c
}

/// Splits a code into sections at unquoted, unescaped, unbracketed semicolons.
public func splitSections(_ code: String) -> [String] {
    let cs = code.unicodeScalars.map(String.init)
    let lastClose = cs.lastIndex(of: "]") ?? -1
    var out: [String] = [""]
    var quoted = false
    var escape = false
    var i = 0
    while i < cs.count {
        let c = cs[i]
        i += 1
        let cur = out.count - 1
        if escape {
            out[cur] += c
            escape = false
            continue
        }
        if c == "\"" {
            quoted.toggle()
            out[cur] += c
        } else if (c == "\\" || c == "_" || c == "*") && !quoted {
            escape = true
            out[cur] += c
        } else if c == "[" && !quoted && lastClose >= i {
            var s = c
            while i < cs.count {
                let d = cs[i]
                i += 1
                s += d
                if d == "]" { break }
            }
            out[cur] += s
        } else if c == ";" && !quoted {
            if out.count >= MAX_SECTIONS { break }
            out.append("")
        } else {
            out[cur] += c
        }
    }
    return out
}

private func lowerAscii(_ c: String) -> String {
    (c >= "A" && c <= "Z") ? c.lowercased() : c
}

private func startsWithCi(_ cs: [String], _ i: Int, _ pat: [String]) -> Bool {
    for k in 0..<pat.count {
        guard i + k < cs.count else { return false }
        if lowerAscii(cs[i + k]) != pat[k] { return false }
    }
    return true
}

private func pushLit(_ toks: inout [Tok], _ s: String) {
    if s.isEmpty { return }
    if case let .lit(prev)? = toks.last {
        toks[toks.count - 1] = .lit(prev + s)
    } else {
        toks.append(.lit(s))
    }
}

private let CURRENCY_CHARS: Set<String> = ["$", "€", "£", "¥", "₹", "₩", "₽", "¢", "₪", "₫", "฿"]
private func isCurrencyChar(_ c: String) -> Bool {
    CURRENCY_CHARS.contains(c)
}

private let NAMED_COLORS: Set<String> = ["black", "blue", "cyan", "green", "magenta", "red", "white", "yellow"]

private func parseColor(_ lc: String) -> NumberFormatColor? {
    if NAMED_COLORS.contains(lc) { return lc }
    guard lc.hasPrefix("color") else { return nil }
    let rest = String(lc.dropFirst(5)).jsTrimmed
    guard rest.range(of: #"^\+?\d{1,3}$"#, options: .regularExpression) != nil,
          let n = Int(rest.replacingOccurrences(of: "+", with: "")),
          n >= 1 && n <= 56 else {
        return nil
    }
    return "color\(n)"
}

private func parseCond(_ s: String) -> Cond? {
    let t = s.jsTrimmed
    let op: CondOp
    let rest: String
    if t.hasPrefix("<=") {
        op = .le
        rest = String(t.dropFirst(2))
    } else if t.hasPrefix(">=") {
        op = .ge
        rest = String(t.dropFirst(2))
    } else if t.hasPrefix("<>") {
        op = .ne
        rest = String(t.dropFirst(2))
    } else if t.hasPrefix("<") {
        op = .lt
        rest = String(t.dropFirst(1))
    } else if t.hasPrefix(">") {
        op = .gt
        rest = String(t.dropFirst(1))
    } else if t.hasPrefix("=") {
        op = .eq
        rest = String(t.dropFirst(1))
    } else {
        return nil
    }
    let r = rest.jsTrimmed
    guard r.range(of: #"^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$"#, options: [.regularExpression, .caseInsensitive]) != nil,
          let value = Double(r), value.isFinite else {
        return nil
    }
    return Cond(op: op, value: value)
}

private struct Raw {
    var toks: [Tok] = []
    var color: NumberFormatColor?
    var cond: Cond?
    var currency: Bool = false
}

private func bracket(_ raw: inout Raw, _ content: String) {
    let lc = content.jsTrimmed.lowercased()
    if let color = parseColor(lc) {
        raw.color = color
        return
    }
    if lc.hasPrefix("<") || lc.hasPrefix(">") || lc.hasPrefix("=") {
        if let c = parseCond(lc) {
            raw.cond = c
        }
        return
    }
    if content.hasPrefix("$") {
        let afterDollar = String(content.dropFirst(1))
        let sym = afterDollar.components(separatedBy: "-").first ?? ""
        if !sym.isEmpty {
            raw.currency = true
            pushLit(&raw.toks, sym)
        }
        return
    }
    let scalars = lc.unicodeScalars.map(String.init)
    if let first = scalars.first,
       (first == "h" || first == "m" || first == "s"),
       scalars.allSatisfy({ $0 == first }) {
        let n = Swift.min(scalars.count, 255)
        let k: DatePartKind = first == "h" ? .eh : first == "m" ? .em : .es
        raw.toks.append(.date(.part(k: k, n: n)))
    }
}

private let PAT_GENERAL = ["g", "e", "n", "e", "r", "a", "l"]
private let PAT_AMPM = ["a", "m", "/", "p", "m"]
private let PAT_AP = ["a", "/", "p"]
private let DATE_CHARS: Set<String> = ["y", "Y", "m", "M", "d", "D", "h", "H", "s", "S", "e", "E"]

private func tokenize(_ src: String) -> Raw {
    let cs = src.unicodeScalars.map(String.init)
    var raw = Raw()
    let lastClose = cs.lastIndex(of: "]") ?? -1
    var i = 0
    while i < cs.count {
        let c = cs[i]
        if c == "\"" {
            var s = ""
            i += 1
            while i < cs.count {
                let d = cs[i]
                i += 1
                if d == "\"" { break }
                s += d
            }
            if s.unicodeScalars.map(String.init).contains(where: isCurrencyChar) {
                raw.currency = true
            }
            pushLit(&raw.toks, s)
            continue
        }
        if c == "\\" {
            if i + 1 < cs.count {
                let d = cs[i + 1]
                if isCurrencyChar(d) { raw.currency = true }
                pushLit(&raw.toks, d)
            }
            i += 2
            continue
        }
        if c == "_" {
            if i + 1 < cs.count {
                pushLit(&raw.toks, " ")
            }
            i += 2
            continue
        }
        if c == "*" {
            if i + 1 < cs.count {
                raw.toks.append(.fill(cs[i + 1]))
            }
            i += 2
            continue
        }
        if c == "[" {
            let close: Int = lastClose > i ? (cs[(i + 1)...].firstIndex(of: "]") ?? -1) : -1
            if close != -1 {
                let content = cs[(i + 1)..<close].joined()
                bracket(&raw, content)
                i = close + 1
            } else {
                pushLit(&raw.toks, "[")
                i += 1
            }
            continue
        }
        if c == "0" || c == "#" || c == "?" {
            raw.toks.append(.digit(c))
        } else if c == "." {
            raw.toks.append(.point)
        } else if c == "," {
            raw.toks.append(.comma)
        } else if c == "%" {
            raw.toks.append(.percent)
        } else if c == "@" {
            raw.toks.append(.at)
        } else if c == "/" {
            raw.toks.append(.slash)
            i += 1
            if i < cs.count && cs[i] >= "1" && cs[i] <= "9" {
                var s = ""
                while i < cs.count && cs[i] >= "0" && cs[i] <= "9" {
                    s += cs[i]
                    i += 1
                }
                raw.toks.append(.denom(s))
            }
            continue
        } else if (c == "e" || c == "E") && i + 1 < cs.count && (cs[i + 1] == "+" || cs[i + 1] == "-") {
            raw.toks.append(.exp(upper: c == "E", plus: cs[i + 1] == "+"))
            i += 2
            continue
        } else if (c == "G" || c == "g") && startsWithCi(cs, i, PAT_GENERAL) {
            raw.toks.append(.general)
            i += 7
            continue
        } else if (c == "A" || c == "a") && startsWithCi(cs, i, PAT_AMPM) {
            raw.toks.append(.date(.ampm))
            i += 5
            continue
        } else if (c == "A" || c == "a") && startsWithCi(cs, i, PAT_AP) {
            let p = (i + 2 < cs.count) ? cs[i + 2] : "P"
            raw.toks.append(.date(.ap(a: c, p: p)))
            i += 3
            continue
        } else if DATE_CHARS.contains(c) {
            let lc = lowerAscii(c)
            var n = 0
            while i + n < cs.count && lowerAscii(cs[i + n]) == lc {
                n += 1
            }
            let n8 = Swift.min(n, 255)
            let d: DatePart
            switch lc {
            case "y": d = .part(k: .year, n: n8)
            case "e": d = .part(k: .year, n: 4)
            case "m": d = .part(k: .month, n: n8)
            case "d": d = .part(k: .day, n: n8)
            case "h": d = .part(k: .hour, n: n8)
            default: d = .part(k: .second, n: n8)
            }
            raw.toks.append(.date(d))
            i += Swift.max(n, 1)
            continue
        } else {
            if isCurrencyChar(c) { raw.currency = true }
            pushLit(&raw.toks, c)
        }
        i += 1
    }
    return raw
}

private func datePartOf(_ t: Tok?) -> DatePart? {
    if case let .date(d)? = t { return d }
    return nil
}

private func datePartKind(_ d: DatePart?) -> DatePartKind? {
    if case let .part(k, _)? = d { return k }
    return nil
}

private func analyze(_ raw: Raw) -> Section {
    var toks = raw.toks
    let isDate = toks.contains { if case .date = $0 { return true } else { return false } }
    let hasGeneral = toks.contains(.general)
    var sec = Section(
        toks: [],
        color: raw.color,
        cond: raw.cond,
        kind: .number,
        thousands: false,
        scale: 0,
        percent: 0,
        hasAt: toks.contains(.at),
        hasDigits: false,
        exp: false,
        fraction: false,
        currency: raw.currency,
        fill: toks.contains { if case .fill = $0 { return true } else { return false } }
    )
    if isDate {
        sec.kind = .date
        var prevPart: [DatePart?] = []
        var last: DatePart?
        for i in 0..<toks.count {
            prevPart.append(last)
            if let d = datePartOf(toks[i]) { last = d }
        }
        var nextPart = Array<DatePart?>(repeating: nil, count: toks.count)
        var next: DatePart?
        for i in stride(from: toks.count - 1, through: 0, by: -1) {
            nextPart[i] = next
            if let d = datePartOf(toks[i]) { next = d }
        }
        for i in 0..<toks.count {
            if case let .date(.part(k, n)) = toks[i], k == .month, n <= 2 {
                let prevK = datePartKind(prevPart[i])
                let nextK = datePartKind(nextPart[i])
                let afterH = prevK == .hour || prevK == .eh
                let beforeS = nextK == .second || nextK == .es
                if afterH || beforeS {
                    toks[i] = .date(.part(k: .minute, n: n))
                }
            }
        }
        var out: [Tok] = []
        var i = 0
        while i < toks.count {
            let t = toks[i]
            if t == .point && isDigitTok(i + 1 < toks.count ? toks[i + 1] : nil, "0") {
                var n = 0
                while isDigitTok(i + 1 + n < toks.count ? toks[i + 1 + n] : nil, "0") {
                    n += 1
                }
                out.append(.date(.part(k: .subsec, n: Swift.min(n, 255))))
                i += 1 + n
                continue
            }
            switch t {
            case .date, .fill:
                out.append(t)
            default:
                pushLit(&out, literalText(t))
            }
            i += 1
        }
        sec.toks = out
        return sec
    }
    if hasGeneral {
        sec.kind = .general
        var out: [Tok] = []
        for t in toks {
            switch t {
            case .general, .fill:
                out.append(t)
            default:
                pushLit(&out, literalText(t))
            }
        }
        sec.toks = out
        return sec
    }
    sec.hasDigits = toks.contains { isDigitTok($0) }
    if sec.hasAt && !sec.hasDigits {
        sec.kind = .text
        var out: [Tok] = []
        for t in toks {
            switch t {
            case .at, .fill:
                out.append(t)
            default:
                pushLit(&out, literalText(t))
            }
        }
        sec.toks = out
        return sec
    }

    var seenPoint = false
    var seenExp = false
    var seenDigit = false
    var fractionSlash = false
    var digitAfterCommas = Array(repeating: false, count: toks.count)
    var firstNonLitAfter = Array<Tok?>(repeating: nil, count: toks.count)
    var after = false
    var nonLit: Tok?
    for j in stride(from: toks.count - 1, through: 0, by: -1) {
        digitAfterCommas[j] = after
        firstNonLitAfter[j] = nonLit
        let t = toks[j]
        if t != .comma { after = isDigitTok(t) }
        if case .lit = t {} else { nonLit = t }
    }
    var lastExp = -1
    for j in stride(from: toks.count - 1, through: 0, by: -1) {
        if case .exp = toks[j] {
            lastExp = j
            break
        }
    }
    let firstDigit = toks.firstIndex(where: { isDigitTok($0) }) ?? -1
    let scientific = firstDigit != -1 && toks[firstDigit...].contains(where: { if case .exp = $0 { return true } else { return false } })
    for i in 0..<toks.count {
        let t = toks[i]
        var replace: Tok?
        switch t {
        case .digit:
            seenDigit = true
        case .point:
            if seenPoint || seenExp { replace = .lit(".") }
            else { seenPoint = true }
        case .percent:
            sec.percent += 1
        case .exp:
            if seenExp || !seenDigit { replace = .lit(literalText(t)) }
            else {
                seenExp = true
                sec.exp = true
            }
        case .comma:
            let nextDigit = digitAfterCommas[i]
            if seenDigit && nextDigit && !seenPoint && !seenExp {
                sec.thousands = true
                replace = .lit("")
            } else if seenDigit && scientific {
                replace = .lit("")
            } else if seenDigit && !nextDigit {
                sec.scale += 1
                replace = .lit("")
            } else {
                replace = .lit(",")
            }
        case .slash:
            let nextIsDenom: Bool = {
                guard i + 1 < toks.count else { return false }
                if case .denom = toks[i + 1] { return true }
                return false
            }()
            let nextOk = nextIsDenom || isDigitTok(firstNonLitAfter[i])
            let hasExp = seenExp || lastExp > i
            if !fractionSlash && seenDigit && nextOk && !seenPoint && !hasExp {
                fractionSlash = true
                sec.fraction = true
            } else {
                replace = .lit("/")
            }
        case .denom(let s):
            let prevIsSlash = i > 0 && toks[i - 1] == .slash
            if !(prevIsSlash && sec.fraction) {
                replace = .lit(s)
            }
        default:
            break
        }
        if let replace { toks[i] = replace }
    }
    if sec.fraction {
        for i in 0..<toks.count {
            if toks[i] == .point { toks[i] = .lit(".") }
        }
    }
    var out: [Tok] = []
    for t in toks {
        if case let .lit(s) = t {
            pushLit(&out, s)
        } else {
            out.append(t)
        }
    }
    sec.toks = out
    return sec
}

/// Parses a whole format code into its sections.
public func parseSections(_ code: String) -> [Section] {
    splitSections(code).map { analyze(tokenize($0)) }
}
