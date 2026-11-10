// Portions ported from gridcraft/crates/numfmt/src/render.rs and gridcraft/crates/core/src/date.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import Foundation

/// Last serial that is a valid date in the 1900 date system: 9999-12-31.
public let MAX_DATE_SERIAL = 2_958_465

private let MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]
private let WEEKDAYS = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
]
private let UNIX_1899_12_30 = -25569

private func floorDiv(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    let r = a % b
    return (r != 0 && ((r < 0) != (b < 0))) ? q - 1 : q
}

/// Civil date for days since 1970-01-01 (Howard Hinnant's algorithm).
private func civilFromDays(_ z0: Int) -> (y: Int, m: Int, d: Int) {
    let z = z0 + 719468
    let era = floorDiv(z, 146097)
    let doe = z - era * 146097
    let yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365)
    let doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
    let mp = floorDiv(5 * doy + 2, 153)
    let d = doy - floorDiv(153 * mp + 2, 5) + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    return (y: yoe + era * 400 + (m <= 2 ? 1 : 0), m: m, d: d)
}

/// Year, month, day and weekday (0 = Sunday) of a whole 1900-system serial.
/// Serial 0 is the fictitious 1900-01-00 and serial 60 the fictitious
/// 1900-02-29; weekdays continue that calendar (serial 1 is a Sunday).
public func dateFromSerial(_ day: Int) -> (year: Int, month: Int, day: Int, weekday: Int) {
    let weekday = (((day + 6) % 7) + 7) % 7
    if day == 60 { return (year: 1900, month: 2, day: 29, weekday: weekday) }
    if day == 0 { return (year: 1900, month: 1, day: 0, weekday: weekday) }
    let real = day < 60 ? day + 1 : day
    let (y, m, d) = civilFromDays(real + UNIX_1899_12_30)
    return (year: y, month: m, day: d, weekday: weekday)
}

public struct NumberFormatFill: Sendable, Equatable {
    public var char: String
    public var index: Int

    public init(char: String, index: Int) {
        self.char = char
        self.index = index
    }
}

/// Text being built plus the first repeat-fill position.
public struct Out: Sendable, Equatable {
    public var text: String = ""
    public var fill: NumberFormatFill?
    /// True when every digit shown is zero (a number section that rounded to zero).
    public var zero: Bool = false

    public init() {}

    public mutating func push(_ s: String) {
        text += s
    }

    public mutating func setFill(_ c: String) {
        if fill == nil {
            fill = NumberFormatFill(char: c, index: text.utf16.count)
        }
    }

    public mutating func prepend(_ s: String) {
        text = s + text
        if var f = fill {
            f.index += s.utf16.count
            fill = f
        }
    }
}

/// Renders a text value through a text section (`@` is replaced by the text).
public func renderText(_ sec: Section, _ text: String) -> Out {
    var out = Out()
    for t in sec.toks {
        switch t {
        case .at:
            out.push(text)
        case .fill(let c):
            out.setFill(c)
        default:
            out.push(literalText(t))
        }
    }
    return out
}

/// Renders a number through a General section (literals around the General keyword).
public func renderGeneral(_ sec: Section, _ v: Double, _ width: Int) -> Out {
    var out = Out()
    for t in sec.toks {
        switch t {
        case .general:
            let hashCount = Swift.min(Swift.max(width, 1), 11)
            out.push(formatGeneralFit(v, width) ?? String(repeating: "#", count: hashCount))
        case .fill(let c):
            out.setFill(c)
        default:
            out.push(literalText(t))
        }
    }
    return out
}

private func padStart(_ s: String, _ width: Int, _ ch: Character = "0") -> String {
    let count = s.count
    if count >= width { return s }
    return String(repeating: String(ch), count: width - count) + s
}

private func padNum(_ n: Int, _ w: Int) -> String {
    w >= 2 ? padStart(String(n), Swift.min(w, 20), "0") : String(n)
}

private func jsRoundDouble(_ x: Double) -> Double {
    if !x.isFinite || x == 0 { return x }
    if x > 0 { return floor(x + 0.5) }
    let f = ceil(x - 0.5)
    return f == 0 ? 0 : f
}

/// Renders a date/time. `nil` when the serial is outside the supported range.
public func renderDate(_ sec: Section, _ v: Double) -> Out? {
    if !v.isFinite || v < 0 || v >= Double(MAX_DATE_SERIAL + 1) { return nil }
    var subDigits = 0
    for t in sec.toks {
        if case let .date(.part(k, n)) = t, k == .subsec {
            subDigits = Swift.max(subDigits, n)
        }
    }
    subDigits = Swift.min(subDigits, 3)
    let unit = pow(10.0, Double(3 - subDigits))
    var day = Int(floor(v))
    var ms = Int(jsRoundDouble(((v - floor(v)) * 86_400_000.0) / unit) * unit)
    if ms >= 86_400_000 {
        ms -= 86_400_000
        day += 1
    }
    let totalMs = Int64(day) * 86_400_000 + Int64(ms)
    let needsDate = sec.toks.contains {
        if case let .date(d) = $0 { return isCalendarPart(d) }
        return false
    }
    if needsDate && day > MAX_DATE_SERIAL { return nil }
    let dt = needsDate ? dateFromSerial(day) : dateFromSerial(0)
    let ampm = sec.toks.contains {
        if case let .date(d) = $0 {
            switch d {
            case .ampm, .ap: return true
            default: return false
            }
        }
        return false
    }
    let hour = ms / 3_600_000
    let minute = (ms / 60_000) % 60
    let second = (ms / 1000) % 60
    let milli = ms % 1000
    let monthName = (dt.month >= 1 && dt.month <= 12) ? MONTHS[dt.month - 1] : ""
    let dayName = (dt.weekday >= 0 && dt.weekday < 7) ? WEEKDAYS[dt.weekday] : ""
    var out = Out()
    for t in sec.toks {
        if case let .fill(c) = t {
            out.setFill(c)
            continue
        }
        guard case let .date(d) = t else {
            out.push(literalText(t))
            continue
        }
        var s: String
        switch d {
        case .part(let k, let n):
            switch k {
            case .year:
                s = n <= 2 ? padStart(String(((dt.year % 100) + 100) % 100), 2) : padStart(String(dt.year), 4)
            case .month:
                if n <= 2 {
                    s = padNum(dt.month, n)
                } else if n == 3 {
                    s = String(monthName.prefix(3))
                } else if n == 5 {
                    s = String(monthName.prefix(1))
                } else {
                    s = monthName
                }
            case .day:
                if n <= 2 {
                    s = padNum(dt.day, n)
                } else if n == 3 {
                    s = String(dayName.prefix(3))
                } else {
                    s = dayName
                }
            case .hour:
                let h12 = (hour % 12 == 0) ? 12 : (hour % 12)
                s = padNum(ampm ? h12 : hour, n)
            case .minute:
                s = padNum(minute, n)
            case .second:
                s = padNum(second, n)
            case .subsec:
                let full = ".\(padStart(String(milli), 3))"
                s = String(full.prefix(1 + Swift.min(n, 3)))
                if n > 3 { s += String(repeating: "0", count: n - 3) }
            case .eh:
                s = padNum(Int(totalMs / 3_600_000), n)
            case .em:
                s = padNum(Int(totalMs / 60_000), n)
            case .es:
                s = padNum(Int(totalMs / 1000), n)
            }
        case .ampm:
            s = hour >= 12 ? "PM" : "AM"
        case .ap(let a, let p):
            s = hour >= 12 ? p : a
        }
        out.push(s)
    }
    return out
}

private func digitChar(_ toks: [Tok], _ i: Int) -> String {
    guard i >= 0 && i < toks.count, case let .digit(c) = toks[i] else { return "0" }
    return c
}

private func isDigitTokC(_ t: Tok?, _ c: String) -> Bool {
    guard case let .digit(tc)? = t else { return false }
    return tc == c
}

private func fillInt(
    _ toks: [Tok],
    _ idxs: [Int],
    _ digits: String,
    _ thousands: Bool,
    _ forceZero: Bool,
    _ pieces: inout [String]
) {
    let digitChars = Array(digits).map(String.init)
    var rem = digitChars.count
    var pos = 0
    let count = idxs.count
    for k in 0..<count {
        let ti = idxs[count - 1 - k]
        let leftmost = k + 1 == count
        let ph = digitChar(toks, ti)
        var rev: [String] = []
        func pushDigit(_ c: String) {
            if thousands && pos > 0 && pos % 3 == 0 { rev.append(",") }
            rev.append(c)
            pos += 1
        }
        let take = leftmost ? rem : Swift.min(rem, 1)
        if take == 0 {
            if ph == "0" {
                pushDigit("0")
            } else if forceZero && k == 0 {
                pushDigit("0")
            } else if ph == "?" {
                if thousands && pos > 0 && pos % 3 == 0 { rev.append(" ") }
                rev.append(" ")
                pos += 1
            }
        } else {
            for _ in 0..<take {
                rem -= 1
                pushDigit(rem >= 0 && rem < digitChars.count ? digitChars[rem] : "0")
            }
        }
        pieces[ti] = rev.reversed().joined()
    }
}

private func withCommas(_ digits: String, _ thousands: Bool) -> String {
    if !thousands { return digits }
    let chars = Array(digits).map(String.init)
    let n = chars.count
    var s = ""
    for i in 0..<n {
        if i > 0 && (n - i) % 3 == 0 { s += "," }
        s += chars[i]
    }
    return s
}

private func fillFrac(_ toks: [Tok], _ idxs: [Int], _ frac: String, _ pieces: inout [String]) {
    let fracChars = Array(frac).map(String.init)
    var lastSig = -1
    for i in stride(from: fracChars.count - 1, through: 0, by: -1) {
        if fracChars[i] != "0" {
            lastSig = i
            break
        }
    }
    for (i, ti) in idxs.enumerated() {
        let ph = digitChar(toks, ti)
        if i <= lastSig {
            pieces[ti] = i < fracChars.count ? fracChars[i] : "0"
        } else if ph == "0" {
            pieces[ti] = "0"
        } else if ph == "?" {
            pieces[ti] = " "
        } else {
            pieces[ti] = ""
        }
    }
}

private func digitIndices(_ toks: [Tok], _ start: Int, _ end: Int) -> [Int] {
    var out: [Int] = []
    if start < end {
        for i in start..<Swift.min(end, toks.count) {
            if case .digit = toks[i] { out.append(i) }
        }
    }
    return out
}

/// Renders a non-negative number through a number section.
public func renderNumber(_ sec: Section, _ v: Double) -> Out {
    var x = abs(v)
    if sec.percent > 0 && !sec.exp {
        x *= pow(100.0, Double(Swift.min(sec.percent, 20)))
    }
    if sec.scale > 0 {
        x /= pow(1000.0, Double(Swift.min(sec.scale, 110)))
    }
    if !x.isFinite { x = Double.greatestFiniteMagnitude }
    let toks = sec.toks
    let n = toks.count
    var pieces = Array(repeating: "", count: n)
    var before = Array(repeating: "", count: n + 1)
    var lits = Array<String?>(repeating: nil, count: n)
    var zero = false
    if sec.fraction {
        renderFraction(sec, x, &pieces, &lits)
    } else {
        let point = toks.firstIndex(of: .point)
        let exp = toks.firstIndex(where: { if case .exp = $0 { return true } else { return false } })
        let intEnd = point ?? exp ?? n
        let fracEnd = exp ?? n
        let intIdx = digitIndices(toks, 0, intEnd)
        let fracIdx = point == nil ? [] : digitIndices(toks, point! + 1, fracEnd)
        var intS: String
        var fracS: String
        if let exp {
            let expDigitIdx = digitIndices(toks, exp + 1, n)
            let step = Swift.max(intIdx.count, 1)
            var e: Int
            if x == 0 {
                e = 0
                intS = String(repeating: "0", count: intIdx.count)
                fracS = String(repeating: "0", count: fracIdx.count)
            } else {
                let (digits, xe) = decimalDigits(x)
                e = xe - (((xe % step) + step) % step)
                (intS, fracS) = fixedFromDigits(digits, xe - e, fracIdx.count)
                if intS.count > step {
                    e += step
                    (intS, fracS) = fixedFromDigits(digits, xe - e, fracIdx.count)
                }
            }
            let et = toks[exp]
            let upper: Bool
            let plus: Bool
            if case let .exp(u, p) = et {
                upper = u
                plus = p
            } else {
                upper = true
                plus = true
            }
            if intS.isEmpty && fracS.allSatisfy({ $0 == "0" }) {
                e = 0
            }
            let head = upper ? "E" : "e"
            let sign = e < 0 ? "-" : plus ? "+" : ""
            let expDigits = String(abs(e))
            if !expDigitIdx.isEmpty {
                pieces[exp] = head
                before[expDigitIdx[0]] = sign
                fillInt(toks, expDigitIdx, expDigits, false, false, &pieces)
            } else {
                pieces[exp] = "\(head)\(sign)\(expDigits)"
            }
        } else {
            (intS, fracS) = fixed(x, fracIdx.count)
        }
        zero = (intS + fracS).allSatisfy { $0 == "0" }
        fillInt(toks, intIdx, intS, sec.thousands, false, &pieces)
        let anchor = point ?? exp
        if intIdx.isEmpty && !intS.isEmpty, let anchor {
            before[anchor] = withCommas(intS, sec.thousands)
        }
        fillFrac(toks, fracIdx, fracS, &pieces)
        if let point { pieces[point] = "." }
    }
    var out = Out()
    for i in 0..<n {
        out.push(before[i])
        let t = toks[i]
        switch t {
        case .lit(let s):
            out.push(lits[i] ?? s)
        case .percent:
            out.push("%")
        case .fill(let c):
            out.setFill(c)
        case .at, .general, .date, .comma:
            continue
        default:
            out.push(pieces[i])
        }
    }
    out.zero = zero
    return out
}

/// Best rational approximation of `x` with denominator at most `maxDen` (continued fractions).
public func approximate(_ x: Double, _ maxDen: Double) -> (Double, Double) {
    if x.isNaN || x <= 0 || !x.isFinite { return (0, 1) }
    if x >= 1e15 { return (jsRoundDouble(x), 1) }
    var p0 = 0.0
    var q0 = 1.0
    var p1 = 1.0
    var q1 = 0.0
    var r = x
    for _ in 0..<64 {
        let aF = floor(r)
        if aF > 1e15 { break }
        let q2 = aF * q1 + q0
        if q2 > maxDen { break }
        let p2 = aF * p1 + p0
        p0 = p1
        q0 = q1
        p1 = p2
        q1 = q2
        let frac = r - aF
        if frac < 1e-12 { break }
        r = 1.0 / frac
    }
    if q1 == 0 { return (jsRoundDouble(x), 1) }
    let k = floor((maxDen - q0) / q1)
    let pb = p0 + k * p1
    let qb = q0 + k * q1
    let errA = abs(p1 / q1 - x)
    let errB = qb > 0 ? abs(pb / qb - x) : .infinity
    return errB < errA ? (pb, qb) : (p1, q1)
}

private func shownWidth(_ t: Tok) -> Int {
    switch t {
    case .lit(let s), .denom(let s):
        return s.unicodeScalars.count
    case .digit, .slash:
        return 1
    default:
        return 0
    }
}

private func blankRange(
    _ toks: [Tok],
    _ start: Int,
    _ end: Int,
    _ spaces: Bool,
    _ pieces: inout [String],
    _ lits: inout [String?]
) {
    let hi = Swift.min(end, toks.count)
    if start < hi {
        for i in start..<hi {
            let t = toks[i]
            let s = spaces ? String(repeating: " ", count: shownWidth(t)) : ""
            switch t {
            case .lit:
                lits[i] = s
            case .digit, .slash, .denom:
                pieces[i] = s
            default:
                break
            }
        }
    }
}

private func renderFraction(
    _ sec: Section,
    _ x: Double,
    _ pieces: inout [String],
    _ lits: inout [String?]
) {
    let toks = sec.toks
    func isDigit(_ i: Int) -> Bool {
        guard i >= 0 && i < toks.count else { return false }
        if case .digit = toks[i] { return true }
        return false
    }
    guard let slash = toks.firstIndex(of: .slash) else { return }
    var numLast = -1
    for i in stride(from: slash - 1, through: 0, by: -1) {
        if isDigit(i) {
            numLast = i
            break
        }
    }
    if numLast == -1 { return }
    var numStart = numLast
    while numStart > 0 && isDigit(numStart - 1) { numStart -= 1 }
    let wholeIdx = digitIndices(toks, 0, numStart)
    let numIdx = digitIndices(toks, numStart, numLast + 1)
    let sepStart = !wholeIdx.isEmpty ? wholeIdx[wholeIdx.count - 1] + 1 : numStart
    var fixedDen: Double?
    var denStart: Int
    if slash + 1 < toks.count, case let .denom(ds) = toks[slash + 1] {
        let parsed = Double(ds) ?? 1e9
        fixedDen = Swift.min(Swift.max(parsed.isFinite ? parsed : 1e9, 1), 1_000_000_000)
        denStart = slash + 1
    } else {
        denStart = slash + 1
        while denStart < toks.count {
            if case .lit = toks[denStart] {
                denStart += 1
            } else {
                break
            }
        }
    }
    var denEnd = denStart
    if fixedDen != nil {
        denEnd += 1
    } else {
        while isDigit(denEnd) { denEnd += 1 }
    }
    let denIdx = digitIndices(toks, denStart, denEnd)
    func hasQ(_ idx: [Int]) -> Bool {
        idx.contains { isDigitTokC(toks[$0], "?") }
    }
    let hasWhole = !wholeIdx.isEmpty
    var whole = hasWhole ? floor(x) : 0
    let f = hasWhole ? x - floor(x) : x
    var num: Double
    let den: Double
    if let fixedDen {
        num = jsRoundDouble(f * fixedDen)
        den = fixedDen
    } else {
        let digits = Swift.min(Swift.max(denIdx.count, 1), 7)
        (num, den) = approximate(f, pow(10.0, Double(digits)) - 1.0)
    }
    if hasWhole && num >= den && den > 0 {
        whole += floor(num / den)
        num = num.truncatingRemainder(dividingBy: den)
    }
    let wholeS = whole >= 1 ? fixed(whole, 0).0 : ""
    let numZeroPh = numIdx.contains { isDigitTokC(toks[$0], "0") }
    if hasWhole && num == 0 && !numZeroPh {
        fillInt(toks, wholeIdx, wholeS, sec.thousands, true, &pieces)
        let spaces = hasQ(wholeIdx) || hasQ(numIdx) || hasQ(denIdx)
        blankRange(toks, sepStart, denEnd, spaces, &pieces, &lits)
        return
    }
    if hasWhole {
        let unitsHash = isDigitTokC(toks[wholeIdx[wholeIdx.count - 1]], "#")
        let force = wholeS.isEmpty && num == 0 && !unitsHash
        fillInt(toks, wholeIdx, wholeS, sec.thousands, force, &pieces)
        let wholeShown = wholeIdx.contains { i in
            pieces[i].contains(where: { $0 >= "0" && $0 <= "9" })
        }
        if !wholeShown {
            let spaces = hasQ(wholeIdx) || hasQ(numIdx)
            blankRange(toks, sepStart, numStart, spaces, &pieces, &lits)
        }
    }
    let numFixed0 = fixed(num, 0).0
    fillInt(toks, numIdx, numFixed0.isEmpty ? "0" : numFixed0, false, true, &pieces)
    pieces[slash] = "/"
    let denFixed0 = fixed(den, 0).0
    let denS = denFixed0.isEmpty ? "0" : denFixed0
    if fixedDen != nil {
        pieces[denStart] = denS
    } else {
        let zeros = denIdx.filter { isDigitTokC(toks[$0], "0") }.count
        let padded = String(repeating: "0", count: Swift.max(zeros - denS.count, 0)) + denS
        let paddedChars = Array(padded).map(String.init)
        let count = denIdx.count
        for (k, ti) in denIdx.enumerated() {
            var s: String
            if k + 1 == count {
                s = k < paddedChars.count ? paddedChars[k...].joined() : ""
            } else {
                s = k < paddedChars.count ? paddedChars[k] : ""
            }
            if s.isEmpty {
                s = isDigitTokC(toks[ti], "?") ? " " : isDigitTokC(toks[ti], "0") ? "0" : ""
            }
            pieces[ti] = s
        }
    }
}
