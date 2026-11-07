// Portions ported from gridcraft/crates/numfmt/src/lib.rs, gridcraft/crates/core/src/parse.rs
// and gridcraft/crates/core/src/date.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import Foundation

public let FORMULA_ERRORS: Set<String> = [
    "#DIV/0!",
    "#VALUE!",
    "#REF!",
    "#NAME?",
    "#N/A",
    "#NUM!",
    "#CYCLE!",
    "#ERROR!",
    "#SPILL!",
    "#CALC!"
]

private let GENERAL_WIDTH = 11
private let OVERFLOW = "########"

/// Longest number format code, in characters, that is parsed (Excel's own limit).
public let MAX_NUMBER_FORMAT_CODE_CHARS = 255

public enum NumberFormatKind: String, Sendable, Equatable {
    case general
    case number
    case currency
    case accounting
    case date
    case time
    case percentage
    case fraction
    case scientific
    case text
    case special
    case custom
}

public struct FormattedNumberValue: Sendable, Equatable {
    public var text: String
    public var color: NumberFormatColor?
    public var fill: NumberFormatFill?
    public var numeric: Bool
    public var overflow: Bool

    public init(
        text: String,
        color: NumberFormatColor? = nil,
        fill: NumberFormatFill? = nil,
        numeric: Bool,
        overflow: Bool = false
    ) {
        self.text = text
        self.color = color
        self.fill = fill
        self.numeric = numeric
        self.overflow = overflow
    }

    public func toJSON(includeOverflow: Bool = false) -> JSONValue {
        var obj = JSONObject([
            ("text", .string(text)),
            ("numeric", .bool(numeric))
        ])
        if includeOverflow {
            obj["overflow"] = .bool(overflow)
        }
        if let fill {
            obj["fill"] = .object(JSONObject([
                ("char", .string(fill.char)),
                ("index", .number(Double(fill.index)))
            ]))
        }
        if let color {
            obj["color"] = .string(color)
        }
        return .object(obj)
    }
}

private func tooLong(_ code: String) -> Bool {
    code.utf16.count > MAX_NUMBER_FORMAT_CODE_CHARS && code.unicodeScalars.count > MAX_NUMBER_FORMAT_CODE_CHARS
}

private let SPECIAL_CODES: Set<String> = [
    "00000",
    "00000-0000",
    "[<=9999999]###-####;(###) ###-####",
    "000-00-0000"
]

private final class NumberFormatCacheStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [String: NumberFormat] = [:]
    private let capacity = 64
    private let maxCodeLength = 256

    func get(_ code: String) -> NumberFormat {
        if code.utf16.count > maxCodeLength {
            return NumberFormat.parse(code)
        }
        lock.lock()
        defer { lock.unlock() }
        if let fmt = map[code] { return fmt }
        let fmt = NumberFormat.parse(code)
        if map.count >= capacity { map.removeAll() }
        map[code] = fmt
        return fmt
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        map.removeAll()
    }
}

private let parseCache = NumberFormatCacheStorage()

public func clearNumberFormatCache() {
    parseCache.clear()
}

/// A parsed number format code. Parsing never fails: malformed parts become literal text.
public struct NumberFormat: Sendable, Equatable {
    public let code: String
    private let generalFlag: Bool
    private let sections: [Section]
    private let numSections: Int
    private let textSection: Int?

    private init(code: String, uncapped: Bool) {
        self.code = code
        let trimmed = code.jsTrimmed
        if trimmed.isEmpty || trimmed.lowercased() == "general" || trimmed == "checkbox" || (!uncapped && tooLong(code)) {
            self.generalFlag = true
            self.sections = []
            self.numSections = 0
            self.textSection = nil
            return
        }
        self.generalFlag = false
        let parsedSections = parseSections(code)
        self.sections = parsedSections
        let len = parsedSections.count
        let lastIsText = parsedSections.last?.kind == .text
        self.textSection = len >= 4 ? 3 : (lastIsText ? len - 1 : nil)
        self.numSections = len >= 4 ? 3 : (lastIsText ? len - 1 : len)
    }

    public init(_ code: String = "General") {
        self.init(code: code, uncapped: false)
    }

    public static func parse(_ code: String) -> NumberFormat {
        NumberFormat(code: code, uncapped: false)
    }

    public static func parseUncapped(_ code: String) -> NumberFormat {
        NumberFormat(code: code, uncapped: true)
    }

    public static func parseCached(_ code: String) -> NumberFormat {
        parseCache.get(code)
    }

    public static func general() -> NumberFormat {
        NumberFormat.parse("General")
    }

    public func isGeneral() -> Bool {
        generalFlag
    }

    private func numberSections() -> ArraySlice<Section> {
        sections.prefix(numSections)
    }

    public func isDate() -> Bool {
        numberSections().contains { $0.kind == .date }
    }

    public func isPercent() -> Bool {
        numberSections().contains { $0.kind == .number && $0.percent > 0 }
    }

    public func isText() -> Bool {
        numSections == 0 && textSection != nil
    }

    public func kind() -> NumberFormatKind {
        if generalFlag { return .general }
        if isText() { return .text }
        if SPECIAL_CODES.contains(code) { return .special }
        guard let s = sections.first else { return .custom }
        if s.kind == .general { return .general }
        if s.kind == .text { return .text }
        if s.kind == .date {
            let calendar = s.toks.contains {
                if case let .date(.part(k, _)) = $0 {
                    return k == .year || k == .month || k == .day
                }
                return false
            }
            return calendar ? .date : .time
        }
        if s.fraction { return .fraction }
        if s.exp { return .scientific }
        if s.percent > 0 { return .percentage }
        if s.fill && s.hasDigits { return .accounting }
        if s.currency && s.hasDigits { return .currency }
        if s.hasDigits { return .number }
        return .custom
    }

    private func select(_ v: Double) -> (sec: Section, dropSign: Bool)? {
        let secs = Array(numberSections())
        let k = secs.count
        guard let s0 = secs.first else { return nil }
        let c0 = s0.cond
        let c1 = k > 1 ? secs[1].cond : nil
        if c0 != nil || c1 != nil {
            let idx: Int
            if let c0, testCond(c0, v) { idx = 0 }
            else if let c1, testCond(c1, v) { idx = 1 }
            else if c0 != nil && c1 != nil { idx = 2 }
            else if c0 == nil { idx = 0 }
            else { idx = 1 }
            guard idx < k else { return nil }
            return (sec: secs[idx], dropSign: k >= 2)
        }
        if v < 0 && k >= 2 { return (sec: secs[1], dropSign: true) }
        if v == 0 && k >= 3 { return (sec: secs[2], dropSign: false) }
        return (sec: s0, dropSign: false)
    }

    public func formatNumber(_ n: Double) -> FormattedNumberValue {
        func general() -> FormattedNumberValue {
            FormattedNumberValue(
                text: formatGeneralFit(n, GENERAL_WIDTH) ?? OVERFLOW,
                numeric: true,
                overflow: false
            )
        }
        if !n.isFinite {
            return FormattedNumberValue(text: "#NUM!", numeric: false, overflow: true)
        }
        if generalFlag { return general() }
        guard let picked = select(n) else { return general() }
        let sec = picked.sec
        let dropSign = picked.dropSign
        let minus = n < 0 && !dropSign
        var out: Out?
        switch sec.kind {
        case .text:
            out = renderText(sec, formatGeneralFit(n, GENERAL_WIDTH) ?? "")
        case .general:
            out = renderGeneral(sec, abs(n), minus ? GENERAL_WIDTH - 1 : GENERAL_WIDTH)
        case .date:
            out = minus ? nil : renderDate(sec, abs(n))
        case .number:
            out = renderNumber(sec, abs(n))
        }
        guard var validOut = out else {
            return FormattedNumberValue(text: OVERFLOW, color: sec.color, numeric: true, overflow: true)
        }
        if minus && sec.kind != .text && !validOut.zero {
            validOut.prepend("-")
        }
        return FormattedNumberValue(
            text: validOut.text,
            color: sec.color,
            fill: validOut.fill,
            numeric: true,
            overflow: false
        )
    }

    public func formatText(_ text: String) -> FormattedNumberValue {
        guard let idx = textSection, idx < sections.count else {
            return FormattedNumberValue(text: text, numeric: false)
        }
        let sec = sections[idx]
        let out = renderText(sec, text)
        return FormattedNumberValue(text: out.text, color: sec.color, fill: out.fill, numeric: false)
    }

    public func format(_ value: JSONValue?) -> FormattedNumberValue {
        guard let value, value != .null else {
            return FormattedNumberValue(text: "", numeric: false)
        }
        if case .string(let s) = value, s.isEmpty {
            return FormattedNumberValue(text: "", numeric: false)
        }
        switch value {
        case .bool(let b):
            return FormattedNumberValue(text: b ? "TRUE" : "FALSE", numeric: false)
        case .number(let n):
            var r = formatNumber(n)
            r.overflow = false
            return r
        case .string(let s):
            if FORMULA_ERRORS.contains(s) {
                return FormattedNumberValue(text: s, numeric: false)
            }
            if let serial = dateValueToSerial(s) {
                var r = formatNumber(serial)
                r.overflow = false
                return r
            }
            return formatText(s)
        default:
            return formatText(value.stringified())
        }
    }
}

// MARK: - Date & Input Helpers (from parse-input.ts & numfmt/index.ts)

public let MONTH_NAMES: [String] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]

private func floorDivInt(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    let r = a % b
    return (r != 0 && ((r < 0) != (b < 0))) ? q - 1 : q
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
public func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
    let y = month <= 2 ? year - 1 : year
    let era = floorDivInt(y >= 0 ? y : y - 399, 400)
    let yoe = y - era * 400
    let doy = floorDivInt(153 * (month > 2 ? month - 3 : month + 9) + 2, 5) + day - 1
    let doe = yoe * 365 + floorDivInt(yoe, 4) - floorDivInt(yoe, 100) + doy
    return era * 146097 + doe - 719468
}

public func isLeapYear(_ y: Int) -> Bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

public func daysInMonth(_ year: Int, _ month: Int) -> Int {
    if month == 2 { return isLeapYear(year) ? 29 : 28 }
    if month == 4 || month == 6 || month == 9 || month == 11 { return 30 }
    return (month >= 1 && month <= 12) ? 31 : 0
}

public func daysInMonth1900(_ year: Int, _ month: Int) -> Int {
    (year == 1900 && month == 2) ? 29 : daysInMonth(year, month)
}

private let UNIX_1899_12_30 = -25569
private let MAX_SERIAL_1900 = 2_958_465

/// Excel 1900-system serial for a date (1 = 1900-01-01, 60 = the fictitious 1900-02-29).
public func serialFromYmd(_ year: Int, _ month: Int, _ day: Int) -> Int? {
    var y = (year >= 0 && year < 1900) ? year + 1900 : year
    let m0 = month - 1
    y += floorDivInt(m0, 12)
    let m = (((m0 % 12) + 12) % 12) + 1
    if y < 1900 || y > 9999 { return nil }
    let first = daysFromCivil(y, m, 1) - UNIX_1899_12_30 - (y == 1900 && m <= 2 ? 1 : 0)
    let serial = first + day - 1
    return (serial >= 0 && serial <= MAX_SERIAL_1900) ? serial : nil
}

/// Fraction of a day for a time.
public func timeFraction(_ h: Double, _ m: Double, _ s: Double) -> Double {
    (h * 3600.0 + m * 60.0 + s) / 86400.0
}

/// 1900-system serial number of an ISO date text (`YYYY-MM-DD` with optional time).
public func dateValueToSerial(_ value: String) -> Double? {
    let utf16Count = value.utf16.count
    if utf16Count < 8 || utf16Count > 30 { return nil }
    let trimmed = value.jsTrimmed
    guard let m = matchGroups(#"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$"#, in: trimmed) else {
        return nil
    }
    guard let y = Int(m[1]), let mo = Int(m[2]), let d = Int(m[3]) else { return nil }
    if mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) { return nil }
    guard let serial = serialFromYmd(y, mo, d) else { return nil }
    if m[4].isEmpty { return Double(serial) }
    guard let hh = Double(m[4]), let mm = Double(m[5]) else { return nil }
    let ss = m[6].isEmpty ? 0.0 : (Double(m[6]) ?? 0.0)
    if hh > 23 || mm > 59 || ss >= 60 { return nil }
    return Double(serial) + timeFraction(hh, mm, ss)
}

public func dateValueToSerial(_ value: JSONValue?) -> Double? {
    guard case let .string(s)? = value else { return nil }
    return dateValueToSerial(s)
}

public func formatNumberFormatValue(_ value: JSONValue?, _ code: String) -> FormattedNumberValue {
    NumberFormat.parseCached(code).format(value)
}

public enum FormatTextFunctionResult: Sendable, Equatable {
    case text(String)
    case error(String)

    public func toJSON() -> JSONValue {
        switch self {
        case .text(let t):
            return .object(JSONObject([("text", .string(t))]))
        case .error(let e):
            return .object(JSONObject([("error", .string(e))]))
        }
    }
}

public func formatTextFunction(_ value: JSONValue?, _ code: String) -> FormatTextFunctionResult {
    if case let .string(s)? = value, FORMULA_ERRORS.contains(s) {
        return .error(s)
    }
    if code.isEmpty { return .text("") }
    if tooLong(code) { return .error("#VALUE!") }
    let fmt = NumberFormat.parseCached(code)
    let n: Double
    if value == nil || value == .null || value == .string("") {
        n = 0
    } else if case let .number(num)? = value {
        n = num
    } else if case let .bool(b)? = value {
        return .text(fmt.formatText(b ? "TRUE" : "FALSE").text)
    } else if case let .string(s)? = value {
        let serial = dateValueToSerial(s)
        guard let parsed = serial ?? parseNumberText(s) else {
            return .text(fmt.formatText(s).text)
        }
        n = parsed
    } else {
        return .text(fmt.formatText(value?.stringified() ?? "").text)
    }
    if !n.isFinite { return .error("#NUM!") }
    let f = fmt.formatNumber(n)
    return f.overflow ? .error("#VALUE!") : .text(f.text)
}

private let INDEXED_COLORS: [String] = [
    "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
    "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#808080",
    "#9999FF", "#993366", "#FFFFCC", "#CCFFFF", "#660066", "#FF8080", "#0066CC", "#CCCCFF",
    "#000080", "#FF00FF", "#FFFF00", "#00FFFF", "#800080", "#800000", "#008080", "#0000FF",
    "#00CCFF", "#CCFFFF", "#CCFFCC", "#FFFF99", "#99CCFF", "#FF99CC", "#CC99FF", "#FFCC99",
    "#3366FF", "#33CCCC", "#99CC00", "#FFCC00", "#FF9900", "#FF6600", "#666699", "#969696",
    "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333"
]

private let NAMED_CSS: [String: String] = [
    "black": "#000000",
    "blue": "#0000FF",
    "cyan": "#00FFFF",
    "green": "#00FF00",
    "magenta": "#FF00FF",
    "red": "#FF0000",
    "white": "#FFFFFF",
    "yellow": "#FFFF00"
]

public func numberFormatColorToCss(_ color: NumberFormatColor) -> String {
    if let named = NAMED_CSS[color] { return named }
    if color.hasPrefix("color"), let idx = Int(color.dropFirst(5)), idx >= 1 && idx <= INDEXED_COLORS.count {
        return INDEXED_COLORS[idx - 1]
    }
    return "#000000"
}

// MARK: - Cell Input Parsing (from parse-input.ts)

public enum CellInputFormatKind: String, Sendable, Equatable {
    case number
    case currency
    case percentage
    case date
    case time
}

public enum ParsedCellInputType: String, Sendable, Equatable {
    case empty
    case text
    case number
    case boolean
    case error
    case date
}

public struct ParsedCellInput: Sendable, Equatable {
    public var value: JSONValue
    public var type: ParsedCellInputType
    public var numberFormat: String?
    public var formatKind: CellInputFormatKind?
    public var cellFormat: String?

    public init(
        value: JSONValue,
        type: ParsedCellInputType,
        numberFormat: String? = nil,
        formatKind: CellInputFormatKind? = nil,
        cellFormat: String? = nil
    ) {
        self.value = value
        self.type = type
        self.numberFormat = numberFormat
        self.formatKind = formatKind
        self.cellFormat = cellFormat
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("value", value),
            ("type", .string(type.rawValue))
        ])
        if let numberFormat { obj["numberFormat"] = .string(numberFormat) }
        if let formatKind { obj["formatKind"] = .string(formatKind.rawValue) }
        if let cellFormat { obj["cellFormat"] = .string(cellFormat) }
        return .object(obj)
    }
}

private struct DateParts {
    var year: Int
    var month: Int
    var day: Int
    var time: Double?
}

private enum NumericParsed {
    case number(value: Double, format: String?)
    case date(date: DateParts, format: String)
    case time(value: Double, format: String)
}

private func normalizeZero(_ n: Double) -> Double {
    n == 0 ? 0 : n
}

private func formatKindOf(_ format: String?) -> CellInputFormatKind? {
    guard let format else { return nil }
    if format.contains("$") { return .currency }
    if format.contains("%") { return .percentage }
    return .number
}

private func padZero(_ n: Int, _ width: Int = 2) -> String {
    let s = String(n)
    return s.count < width ? String(repeating: "0", count: width - s.count) + s : s
}

private func isoText(_ parts: DateParts) -> String? {
    if parts.day > daysInMonth(parts.year, parts.month) { return nil }
    let date = "\(padZero(parts.year, 4))-\(padZero(parts.month))-\(padZero(parts.day))"
    guard let time = parts.time else { return date }
    let rounded = (time * 86400.0).rounded(.toNearestOrAwayFromZero)
    var seconds = Int(rounded)
    if seconds >= 86400 { seconds = 86399 }
    return "\(date) \(padZero(seconds / 3600)):\(padZero((seconds / 60) % 60)):\(padZero(seconds % 60))"
}

public func parseCellInput(_ input: String) -> ParsedCellInput {
    if input.isEmpty { return ParsedCellInput(value: .string(""), type: .empty) }
    if input.hasPrefix("'") { return ParsedCellInput(value: .string(String(input.dropFirst(1))), type: .text) }
    let t = input.jsTrimmed
    let upper = t.uppercased()
    if upper == "TRUE" { return ParsedCellInput(value: .bool(true), type: .boolean) }
    if upper == "FALSE" { return ParsedCellInput(value: .bool(false), type: .boolean) }
    if FORMULA_ERRORS.contains(upper) { return ParsedCellInput(value: .string(upper), type: .error) }
    if let numeric = parseNumeric(t) {
        switch numeric {
        case .date(let date, let format):
            if let iso = isoText(date) {
                return ParsedCellInput(
                    value: .string(iso),
                    type: .date,
                    numberFormat: format,
                    formatKind: .date,
                    cellFormat: "date"
                )
            }
        case .number(let val, let format):
            let fk = formatKindOf(format)
            return ParsedCellInput(
                value: .number(normalizeZero(val)),
                type: .number,
                numberFormat: format,
                formatKind: fk,
                cellFormat: fk?.rawValue
            )
        case .time(let val, let format):
            return ParsedCellInput(
                value: .number(normalizeZero(val)),
                type: .number,
                numberFormat: format,
                formatKind: .time,
                cellFormat: nil
            )
        }
    }
    return ParsedCellInput(value: .string(input), type: .text)
}

public func parseNumberText(_ text: String) -> Double? {
    guard let numeric = parseNumeric(text.jsTrimmed) else { return nil }
    switch numeric {
    case .number(let val, _), .time(let val, _):
        return normalizeZero(val)
    case .date(let date, _):
        guard let serial = serialFromYmd(date.year, date.month, date.day) else { return nil }
        return Double(serial) + (date.time ?? 0)
    }
}

private func parseNumeric(_ t: String) -> NumericParsed? {
    if t.isEmpty { return nil }
    if t.hasPrefix("(") && t.hasSuffix(")") && t.utf16.count >= 2 {
        let innerStr = String(t.dropFirst().dropLast()).jsTrimmed
        guard let inner = parseNumeric(innerStr) else { return nil }
        switch inner {
        case .date:
            return nil
        case .number(let v, let fmt):
            return .number(value: -v, format: fmt)
        case .time(let v, let fmt):
            return .time(value: -v, format: fmt)
        }
    }
    if let plain = parsePlain(t) { return plain }
    if let fraction = parseFraction(t) {
        return .number(value: fraction, format: "# ?/?")
    }
    return parseDateTime(t)
}

private func trimStartJS(_ s: String) -> String {
    let u = Array(s.utf16)
    var i = 0
    while i < u.count && isJSWhitespaceUnit(u[i]) { i += 1 }
    return String(utf16CodeUnits: Array(u[i...]), count: u.count - i)
}

private func trimEndJS(_ s: String) -> String {
    let u = Array(s.utf16)
    var end = u.count
    while end > 0 && isJSWhitespaceUnit(u[end - 1]) { end -= 1 }
    return String(utf16CodeUnits: Array(u[0..<end]), count: end)
}

private func isJSWhitespaceUnit(_ u: UInt16) -> Bool {
    switch u {
    case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    default:
        return false
    }
}

private func parsePlain(_ t: String) -> NumericParsed? {
    var s = t
    var neg = false
    var currency = false
    var percent = false
    if s.hasPrefix("-") {
        neg = true
        s = trimStartJS(String(s.dropFirst()))
    } else if s.hasPrefix("+") {
        s = trimStartJS(String(s.dropFirst()))
    }
    if s.hasPrefix("$") {
        currency = true
        s = trimStartJS(String(s.dropFirst()))
        if !neg && s.hasPrefix("-") {
            neg = true
            s = String(s.dropFirst())
        }
    }
    if s.hasSuffix("%") {
        percent = true
        s = trimEndJS(String(s.dropLast()))
    }
    if s.isEmpty { return nil }
    let hasSep = s.contains(",")
    let digits: String
    if hasSep {
        let parts = s.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let intPart = parts[0]
        let fracPart: String? = parts.count > 1 ? parts[1] : nil
        let groups = intPart.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        guard let first = groups.first, !first.isEmpty, first.count <= 3,
              groups.dropFirst().allSatisfy({ $0.count == 3 }) else {
            return nil
        }
        digits = groups.joined() + (fracPart != nil ? ".\(fracPart!)" : "")
    } else {
        digits = s
    }
    guard let firstCh = digits.first, (firstCh >= "0" && firstCh <= "9") || firstCh == "." else {
        return nil
    }
    guard digits.range(of: #"^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"#, options: .regularExpression) != nil,
          let rawN = Double(digits), rawN.isFinite else {
        return nil
    }
    var n = rawN
    let sci = digits.contains("e") || digits.contains("E")
    if percent { n /= 100.0 }
    if neg { n = -n }
    let hasDot = digits.contains(".")
    let format: String? = currency
        ? (hasDot ? "\"$\"#,##0.00" : "\"$\"#,##0")
        : percent
            ? (hasDot ? "0.00%" : "0%")
            : sci
                ? "0.00E+00"
                : hasSep
                    ? (hasDot ? "#,##0.00" : "#,##0")
                    : nil
    return .number(value: n, format: format)
}

private func parseDecimal(_ s: String) -> Double? {
    guard s.range(of: #"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$"#, options: .regularExpression) != nil else {
        return nil
    }
    return Double(s)
}

private func parseFraction(_ t: String) -> Double? {
    guard let spaceIdx = t.firstIndex(of: " ") else { return nil }
    let whole = String(t[..<spaceIdx])
    let frac = String(t[t.index(after: spaceIdx)...]).jsTrimmed
    let neg = whole.hasPrefix("-")
    let wholeClean = whole.replacingOccurrences(of: #"^-+"#, with: "", options: .regularExpression)
    guard let w = parseDecimal(wholeClean), w.isFinite,
          let slashIdx = frac.firstIndex(of: "/") else {
        return nil
    }
    let aStr = String(frac[..<slashIdx])
    let bStr = String(frac[frac.index(after: slashIdx)...])
    guard let a = parseDecimal(aStr), let b = parseDecimal(bStr), b != 0 else {
        return nil
    }
    let v = w + a / b
    return neg ? -v : v
}

private func monthFromName(_ s: String) -> Int? {
    let l = s.lowercased()
    if l.utf16.count < 3 { return nil }
    guard let idx = MONTH_NAMES.firstIndex(where: { $0.lowercased().hasPrefix(l) }) else {
        return nil
    }
    return idx + 1
}

private func parseTime(_ input: String) -> (fraction: Double, seconds: Bool, ampm: Bool)? {
    let lower = input.jsTrimmed.lowercased()
    var body = lower
    var pm: Bool?
    for (suffix, isPm) in [("am", false), ("a", false), ("pm", true), ("p", true)] {
        if lower.hasSuffix(suffix) {
            body = String(lower.dropLast(suffix.count)).jsTrimmed
            pm = isPm
            break
        }
    }
    let parts = body.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    if parts.count == 1 && pm == nil { return nil }
    if parts.count > 3 || parts.contains("") { return nil }
    func num(_ idx: Int) -> Double? {
        idx < parts.count ? parseDecimal(parts[idx]) : 0
    }
    guard var h = num(0), let m = num(1), let s = num(2) else { return nil }
    if m >= 60 || s >= 60 || h < 0 || m < 0 || s < 0 { return nil }
    if let pm {
        if h > 12 { return nil }
        if h == 12 { h = 0 }
        if pm { h += 12 }
    } else if h >= 10000 {
        return nil
    }
    return (fraction: timeFraction(h, m, s), seconds: parts.count == 3, ampm: pm != nil)
}

private func expandYear(_ text: String, _ y: Int) -> Int {
    text.utf16.count <= 2 ? (y < 30 ? 2000 + y : 1900 + y) : y
}

private func validYmd(_ year: Int, _ month: Int, _ day: Int) -> DateParts? {
    if month < 1 || month > 12 || day < 1 || year < 1900 || year > 9999 { return nil }
    if day > daysInMonth1900(year, month) { return nil }
    return DateParts(year: year, month: month, day: day)
}

private func currentYear() -> Int {
    Calendar(identifier: .gregorian).component(.year, from: Date())
}

private func parseDate(_ input: String) -> (date: DateParts, format: String)? {
    let t = input.jsTrimmed.replacingOccurrences(of: #",+$"#, with: "", options: .regularExpression)
    func num(_ s: String) -> Int? {
        let tr = s.jsTrimmed
        guard tr.range(of: #"^[+-]?\d+$"#, options: .regularExpression) != nil else { return nil }
        return Int(tr)
    }
    func withFormat(_ date: DateParts?, _ format: String) -> (date: DateParts, format: String)? {
        guard let date else { return nil }
        return (date: date, format: format)
    }
    let parts = t.components(separatedBy: CharacterSet(charactersIn: "/.-"))
    if parts.count == 3 {
        let a = parts[0].jsTrimmed
        let b = parts[1].jsTrimmed
        let c = parts[2].jsTrimmed
        if a.utf16.count == 4 {
            if let y = num(a), let m = num(b), let d = num(c) {
                return withFormat(validYmd(y, m, d), "yyyy-mm-dd")
            }
        }
        if let m = num(a), let d = num(b), let y = num(c) {
            return withFormat(validYmd(expandYear(c, y), m, d), "m/d/yyyy")
        }
        if let d = num(a), let m = monthFromName(b), let y = num(c) {
            return withFormat(validYmd(expandYear(c, y), m, d), "d-mmm-yy")
        }
    }
    if parts.count == 2 {
        let a = parts[0].jsTrimmed
        let b = parts[1].jsTrimmed
        if let x = num(a), let y = num(b) {
            if x >= 1 && x <= 12 && y >= 1 && y <= 31 {
                return withFormat(validYmd(currentYear(), x, y), "d-mmm")
            }
            if x >= 1 && x <= 12 && b.utf16.count == 4 {
                return withFormat(validYmd(y, x, 1), "mmm-yy")
            }
        }
        if let dayA = num(a), let monthB = monthFromName(b) {
            return withFormat(validYmd(currentYear(), monthB, dayA), "d-mmm")
        }
        if let monthA = monthFromName(a), let yearB = num(b) {
            return withFormat(validYmd(expandYear(b, yearB), monthA, 1), "mmm-yy")
        }
    }
    let words = t.components(separatedBy: CharacterSet(charactersIn: " ,")).filter { !$0.isEmpty }
    if words.count == 3 {
        let w0 = words[0]
        let w1 = words[1]
        let w2 = words[2]
        if let m = monthFromName(w0), let d = num(w1), let y = num(w2) {
            return withFormat(validYmd(expandYear(w2, y), m, d), "d-mmm-yy")
        }
        if let d = num(w0), let m = monthFromName(w1), let y = num(w2) {
            return withFormat(validYmd(expandYear(w2, y), m, d), "d-mmm-yy")
        }
    }
    return nil
}

private func parseDateTime(_ t: String) -> NumericParsed? {
    if let time = parseTime(t) {
        let format: String
        if time.fraction >= 1 {
            format = "[h]:mm:ss"
        } else if time.seconds {
            format = time.ampm ? "h:mm:ss AM/PM" : "h:mm:ss"
        } else {
            format = time.ampm ? "h:mm AM/PM" : "h:mm"
        }
        return .time(value: time.fraction, format: format)
    }
    if let date = parseDate(t) {
        return .date(date: date.date, format: date.format)
    }
    var searchStart = t.startIndex
    while let spaceIdx = t[searchStart...].firstIndex(of: " ") {
        let left = String(t[..<spaceIdx])
        let right = String(t[t.index(after: spaceIdx)...])
        if let d = parseDate(left), let tm = parseTime(right), tm.fraction < 1 {
            var dt = d.date
            dt.time = tm.fraction
            return .date(date: dt, format: "m/d/yyyy h:mm")
        }
        searchStart = t.index(after: spaceIdx)
    }
    return nil
}

private func matchGroups(_ pattern: String, in text: String) -> [String]? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
    let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = regex.firstMatch(in: text, options: [], range: nsRange) else { return nil }
    var out: [String] = []
    for i in 0..<match.numberOfRanges {
        let r = match.range(at: i)
        if let swiftRange = Range(r, in: text) {
            out.append(String(text[swiftRange]))
        } else {
            out.append("")
        }
    }
    return out
}
