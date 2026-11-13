import Foundation
import PixerateCore

public let CHART_TYPES: [ChartType] = ChartType.allCases
public let CHART_MARKERS: [ChartMarker] = ChartMarker.allCases
public let CHART_TRENDLINE_TYPES: [ChartTrendlineType] = ChartTrendlineType.allCases
public let CHART_LABEL_POSITIONS: [ChartLabelPosition] = ChartLabelPosition.allCases
public let CHART_AXIS_KINDS: [ChartAxisKind] = ChartAxisKind.allCases
public let CHART_AXIS_SCALES: [ChartAxisScale] = ChartAxisScale.allCases
public let CHART_SERIES_TYPES: [ChartSeriesType] = ChartSeriesType.allCases
public let CHART_STACKINGS: [ChartStacking] = ChartStacking.allCases
public let CHART_CURVES: [ChartCurve] = ChartCurve.allCases
public let CHART_RADAR_GRATICULES: [ChartRadarGraticule] = ChartRadarGraticule.allCases
public let CHART_LIKERT_NEUTRALS: [ChartLikertNeutral] = ChartLikertNeutral.allCases
public let CHART_LIKERT_SORTS: [ChartLikertSort] = ChartLikertSort.allCases
public let CHART_SANKEY_LINK_COLORS: [ChartSankeyLinkColor] = ChartSankeyLinkColor.allCases
public let CHART_REFERENCE_AXES: [ChartReferenceAxis] = ChartReferenceAxis.allCases
public let CHART_ORIENTATIONS: [ChartOrientation] = ChartOrientation.allCases
public let CHART_LEGEND_POSITIONS: [ChartLegendPosition] = ChartLegendPosition.allCases
public let CHART_NUMBER_STYLES: [ChartNumberStyle] = ChartNumberStyle.allCases

public let CHART_TYPE_LABELS: [ChartType: String] = [
    .bar: "Bar",
    .line: "Line",
    .area: "Area",
    .scatter: "Scatter",
    .bubble: "Bubble",
    .pie: "Pie",
    .donut: "Donut",
    .radar: "Radar",
    .waterfall: "Waterfall",
    .histogram: "Histogram",
    .box: "Box plot",
    .funnel: "Funnel",
    .treemap: "Treemap",
    .slope: "Slope",
    .likert: "Likert",
    .parliament: "Parliament",
    .sunburst: "Sunburst",
    .sankey: "Sankey",
    .streamgraph: "Streamgraph",
    .barrace: "Bar race",
    .choropleth: "Map"
]

public enum ChartFamily: String, CaseIterable, Sendable, Equatable {
    case cartesian
    case xy
    case pie
    case radar
    case waterfall
    case histogram
    case box
    case funnel
    case treemap
    case slope
    case likert
    case parliament
    case sunburst
    case sankey
    case streamgraph
    case barrace
    case choropleth
}

public let DEFAULT_CHART_PALETTE: [String] = [
    "#4269d0", "#efb118", "#ff725c", "#6cc5b0", "#3ca951",
    "#ff8ab7", "#a463f2", "#97bbf5", "#9c6b4e", "#9498a0"
]

public let DEFAULT_CHART_THEME = ChartTheme(
    background: "#ffffff",
    surface: "#ffffff",
    text: "#0f172a",
    mutedText: "#64748b",
    grid: "#e2e8f0",
    axis: "#94a3b8",
    selection: "#2563eb",
    positive: "#3ca951",
    negative: "#e5484d",
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", sans-serif",
    fontSize: 11,
    titleSize: 15
)

public let CSS_VARIABLE_CHART_THEME = ChartTheme(
    background: "transparent",
    surface: "var(--background, #ffffff)",
    text: "var(--foreground, #0f172a)",
    mutedText: "var(--muted-foreground, #64748b)",
    grid: "var(--border, #e2e8f0)",
    axis: "var(--muted-foreground, #94a3b8)",
    selection: "var(--primary, #2563eb)",
    positive: DEFAULT_CHART_THEME.positive,
    negative: DEFAULT_CHART_THEME.negative,
    fontFamily: "inherit",
    fontSize: DEFAULT_CHART_THEME.fontSize,
    titleSize: DEFAULT_CHART_THEME.titleSize
)

/// Bar, line, area and scatter: categories (or numeric x) against values, series may mix.
public func isCartesianChart(_ type: ChartType) -> Bool {
    type == .bar || type == .line || type == .area || type == .scatter
}

/// Whether the chart plots series against a numeric x axis (bubble charts, and scatter charts with x values).
public func isXyChart(_ spec: ChartSpec) -> Bool {
    isXyChart(type: spec.type, series: spec.series)
}

public func isXyChart(type: ChartType, series: [ChartSeries]) -> Bool {
    if type == .bubble { return true }
    return type == .scatter && series.contains { s in
        !(s.hidden ?? false) && (s.x?.contains(where: { $0 != nil }) ?? false)
    }
}

/// How a chart is laid out (see `ChartType`).
public func chartFamily(_ spec: ChartSpec) -> ChartFamily {
    chartFamily(type: spec.type, series: spec.series)
}

public func chartFamily(type: ChartType, series: [ChartSeries]) -> ChartFamily {
    if isXyChart(type: type, series: series) { return .xy }
    switch type {
    case .pie, .donut: return .pie
    case .radar: return .radar
    case .waterfall: return .waterfall
    case .histogram: return .histogram
    case .box: return .box
    case .funnel: return .funnel
    case .treemap: return .treemap
    case .slope: return .slope
    case .likert: return .likert
    case .parliament: return .parliament
    case .sunburst: return .sunburst
    case .sankey: return .sankey
    case .streamgraph: return .streamgraph
    case .barrace: return .barrace
    case .choropleth: return .choropleth
    case .bubble: return .xy
    case .bar, .line, .area, .scatter: return .cartesian
    }
}

/// Chart types whose legend lists categories (one colour per category) rather than series.
public func chartColorsByCategory(_ type: ChartType) -> Bool {
    type == .pie || type == .donut || type == .funnel || type == .treemap ||
        type == .slope || type == .parliament || type == .sunburst || type == .sankey
}

/// Whether this chart colours by category: a pie-like type, or `varyColors` on a one-series chart.
public func chartSpecColorsByCategory(_ spec: ChartSpec) -> Bool {
    chartColorsByCategory(spec.type) || chartVariesColors(spec)
}

public func defaultChartAxis(_ value: Bool) -> ChartAxis {
    ChartAxis(show: true, title: "", min: nil, max: nil, step: nil, gridlines: value, format: ChartNumberFormat())
}

/// A complete spec with every default filled in.
public func createChartSpec(_ partial: JSONValue = .object(JSONObject())) -> ChartSpec {
    normalizeChartSpec(partial).spec
}

/// The colour a series is drawn with.
public func chartSeriesColor(_ spec: ChartSpec, _ seriesIndex: Int) -> String {
    if seriesIndex >= 0 && seriesIndex < spec.series.count,
       let c = spec.series[seriesIndex].color, !c.isEmpty {
        return c
    }
    if spec.type == .likert {
        return chartLikertColor(spec.series.count, seriesIndex)
    }
    return cyclePaletteColor(spec.palette.isEmpty ? DEFAULT_CHART_PALETTE : spec.palette, seriesIndex)
}

private let LIKERT_NEGATIVE: [[String]] = [
    ["#e66101"],
    ["#e66101", "#fdb863"],
    ["#b35806", "#f1a340", "#fee0b6"],
    ["#b35806", "#e08214", "#fdb863", "#fee0b6"]
]
private let LIKERT_POSITIVE: [[String]] = [
    ["#5e3c99"],
    ["#b2abd2", "#5e3c99"],
    ["#d8daeb", "#998ec3", "#542788"],
    ["#d8daeb", "#b2abd2", "#8073ac", "#542788"]
]
private let LIKERT_NEUTRAL = "#d4d4d8"

/// The colour of answer `index` of `count` on a Likert chart: oranges for the negative half
/// (darkest first), grey for a middle answer, purples for the positive half (darkest last).
public func chartLikertColor(_ count: Int, _ index: Int) -> String {
    let side = count / 2
    if count % 2 == 1 && index == side { return LIKERT_NEUTRAL }
    if side <= 0 { return LIKERT_POSITIVE[0][0] }
    func ramp(_ sets: [[String]]) -> [String] {
        sets[Swift.min(side, sets.count) - 1]
    }
    func pick(_ list: [String], _ k: Int) -> String {
        let idx = Swift.min(list.count - 1, Swift.max(0, (k * list.count) / side))
        return list[idx]
    }
    if index < side {
        return pick(ramp(LIKERT_NEGATIVE), index)
    }
    return pick(ramp(LIKERT_POSITIVE), index - (count - side))
}

/// The colour a pie slice is drawn with (by category).
public func chartSliceColor(_ spec: ChartSpec, _ index: Int) -> String {
    cyclePaletteColor(spec.palette.isEmpty ? DEFAULT_CHART_PALETTE : spec.palette, index)
}

public func chartSliceColor(palette: [String], _ index: Int) -> String {
    cyclePaletteColor(palette.isEmpty ? DEFAULT_CHART_PALETTE : palette, index)
}

/// Whether `varyColors` applies: a bar, line, area or scatter chart with one visible series.
public func chartVariesColors(_ spec: ChartSpec) -> Bool {
    spec.varyColors && isCartesianChart(spec.type) && spec.series.filter { !($0.hidden ?? false) }.count == 1
}

/// The colour of one bar or point: its override, else the palette colour of its category (`varyColors`), else the series colour.
public func chartPointColor(_ spec: ChartSpec, _ seriesIndex: Int, _ index: Int) -> String {
    if seriesIndex >= 0 && seriesIndex < spec.series.count,
       let pointColors = spec.series[seriesIndex].pointColors,
       index >= 0 && index < pointColors.count,
       let own = pointColors[index], !own.isEmpty {
        return own
    }
    if chartVariesColors(spec) {
        return chartSliceColor(spec, index)
    }
    return chartSeriesColor(spec, seriesIndex)
}

/// How a series is drawn in a cartesian chart.
public func chartSeriesType(_ spec: ChartSpec, _ series: ChartSeries) -> ChartSeriesType {
    chartSeriesType(chartType: spec.type, series: series)
}

public func chartSeriesType(chartType: ChartType, series: ChartSeries) -> ChartSeriesType {
    if let t = series.type { return t }
    if chartType == .bubble { return .scatter }
    if chartType == .slope { return .line }
    if let ct = ChartSeriesType(rawValue: chartType.rawValue), isCartesianChart(chartType) {
        return ct
    }
    return .bar
}

/// An id not used by any series (`series-1`, `series-2`, …).
public func uniqueChartSeriesId(_ series: [ChartSeries], _ base: String = "series") -> String {
    let used = Set(series.map { $0.id })
    var i = series.count + 1
    while true {
        let id = "\(base)-\(i)"
        if !used.contains(id) { return id }
        i += 1
    }
}

/// Reads a number the way people type it in a data grid: `1,234.5`, `12%` (→ 0.12),
/// `$40`, `(3)` (→ -3). Blank → `nil` (inside `.some(nil)`). Returns `.none` (`nil`) when it is not a number.
public func parseChartValue(_ input: JSONValue?) -> ChartValue? {
    guard let input else { return .some(nil) }
    switch input {
    case .null:
        return .some(nil)
    case .number(let n):
        return n.isFinite ? .some(n) : .none
    case .string(let raw):
        var text = raw.jsTrimmed
        if text.isEmpty || text == "-" || text == "—" { return .some(nil) }
        var negative = false
        if text.hasPrefix("(") && text.hasSuffix(")") && !text.contains("\n") && !text.contains("\r") {
            negative = true
            text = String(text.dropFirst().dropLast()).jsTrimmed
        }
        let percent = text.hasSuffix("%")
        if percent {
            text = String(text.dropLast()).jsTrimmed
        }
        if let first = text.first, first == "$" || first == "€" || first == "£" || first == "¥" {
            text.removeFirst()
        }
        text = text.replacingOccurrences(of: ",", with: "")
        text = String(text.filter { !$0.isWhitespace })
        guard matchesChartNumberPattern(text), let parsed = Double(text) else { return .none }
        var value = parsed
        if percent { value /= 100.0 }
        if negative { value = -value }
        if value == 0 { value = 0 }
        return value.isFinite ? .some(value) : .none
    default:
        return .none
    }
}

private func matchesChartNumberPattern(_ s: String) -> Bool {
    guard !s.isEmpty else { return false }
    let chars = Array(s)
    var idx = 0
    if chars[idx] == "+" || chars[idx] == "-" {
        idx += 1
        if idx >= chars.count { return false }
    }
    var digitsBeforeDot = 0
    while idx < chars.count && chars[idx].isASCII && chars[idx].isNumber {
        digitsBeforeDot += 1
        idx += 1
    }
    var digitsAfterDot = 0
    if idx < chars.count && chars[idx] == "." {
        idx += 1
        while idx < chars.count && chars[idx].isASCII && chars[idx].isNumber {
            digitsAfterDot += 1
            idx += 1
        }
    }
    if digitsBeforeDot == 0 && digitsAfterDot == 0 { return false }
    if idx < chars.count && (chars[idx] == "e" || chars[idx] == "E") {
        idx += 1
        if idx < chars.count && (chars[idx] == "+" || chars[idx] == "-") {
            idx += 1
        }
        var expDigits = 0
        while idx < chars.count && chars[idx].isASCII && chars[idx].isNumber {
            expDigits += 1
            idx += 1
        }
        if expDigits == 0 { return false }
    }
    return idx == chars.count
}

internal func jsJSONStringify(_ value: JSONValue?) -> String {
    guard let value else { return "undefined" }
    return value.stringified()
}

internal func jsCellString(_ value: JSONValue?) -> String {
    guard let value else { return "undefined" }
    switch value {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .number(let n): return JSONValue.jsString(n)
    case .string(let s): return s
    case .array, .object: return value.stringified()
    }
}

private func pickEnum<T: RawRepresentable>(
    _ value: JSONValue?,
    _ options: [T],
    _ fallback: T,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> T where T.RawValue == String {
    guard let value else { return fallback }
    if case .string(let s) = value, let match = options.first(where: { $0.rawValue == s }) {
        return match
    }
    let listStr = options.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
    issues.append(ChartIssue(
        path: path,
        message: "\(path) must be one of \(listStr); got \(jsJSONStringify(value))."
    ))
    return fallback
}

private func textField(
    _ value: JSONValue?,
    _ fallback: String,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> String {
    guard let value, value != .null else { return fallback }
    switch value {
    case .string(let s): return s
    case .number(let n): return JSONValue.jsString(n)
    case .bool(let b): return b ? "true" : "false"
    default:
        issues.append(ChartIssue(path: path, message: "\(path) must be text."))
        return fallback
    }
}

private func flagField(
    _ value: JSONValue?,
    _ fallback: Bool,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> Bool {
    guard let value else { return fallback }
    if case .bool(let b) = value { return b }
    issues.append(ChartIssue(path: path, message: "\(path) must be true or false."))
    return fallback
}

private func boundField(
    _ value: JSONValue?,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> Double? {
    guard let value, value != .null else { return nil }
    if case .string(let s) = value, s.isEmpty { return nil }
    let n: Double?
    switch value {
    case .number(let d): n = d
    case .string(let s): n = s.jsToNumber
    default: n = nil
    }
    if let n, n.isFinite { return n == 0 ? 0 : n }
    issues.append(ChartIssue(path: path, message: "\(path) must be a number or null."))
    return nil
}

private func jsNumberValue(_ value: JSONValue?) -> Double? {
    guard let value else { return .nan }
    switch value {
    case .number(let d): return d
    case .string(let s): return s.jsToNumber
    case .bool(let b): return b ? 1 : 0
    case .null: return 0
    default: return .nan
    }
}

private func isWholeNumber(_ d: Double) -> Bool {
    d.isFinite && floor(d) == d
}

private func normalizeFormat(
    _ value: JSONValue?,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> ChartNumberFormat {
    guard let value, value != .null else { return ChartNumberFormat() }
    guard case .object(let obj) = value else {
        issues.append(ChartIssue(path: path, message: "\(path) must be an object."))
        return ChartNumberFormat()
    }
    var out = ChartNumberFormat()
    if let styleVal = obj["style"] {
        out.style = pickEnum(styleVal, CHART_NUMBER_STYLES, .number, "\(path).style", &issues)
    }
    if let decVal = obj["decimals"] {
        if let d = jsNumberValue(decVal), isWholeNumber(d), d >= 0 && d <= 10 {
            out.decimals = Int(d)
        } else {
            issues.append(ChartIssue(
                path: "\(path).decimals",
                message: "\(path).decimals must be a whole number from 0 to 10."
            ))
        }
    }
    if let currencyVal = obj["currency"] {
        out.currency = textField(currencyVal, "", "\(path).currency", &issues)
    }
    if let prefixVal = obj["prefix"] {
        out.prefix = textField(prefixVal, "", "\(path).prefix", &issues)
    }
    if let suffixVal = obj["suffix"] {
        out.suffix = textField(suffixVal, "", "\(path).suffix", &issues)
    }
    if let codeVal = obj["code"] {
        out.code = textField(codeVal, "", "\(path).code", &issues)
    }
    return out
}

public func normalizeChartAxis(
    _ value: JSONValue?,
    _ fallback: ChartAxis,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> ChartAxis {
    guard let value else { return fallback }
    guard case .object(let obj) = value else {
        issues.append(ChartIssue(path: path, message: "\(path) must be an object."))
        return fallback
    }
    var min = obj.keys.contains("min") ? boundField(obj["min"], "\(path).min", &issues) : fallback.min
    var max = obj.keys.contains("max") ? boundField(obj["max"], "\(path).max", &issues) : fallback.max
    if let mn = min, let mx = max, mn >= mx {
        issues.append(ChartIssue(
            path: "\(path).max",
            message: "\(path).max (\(JSONValue.jsString(mx))) must be greater than \(path).min (\(JSONValue.jsString(mn)))."
        ))
        min = fallback.min
        max = fallback.max
    }
    var step = obj.keys.contains("step") ? boundField(obj["step"], "\(path).step", &issues) : fallback.step
    if let st = step, !(st > 0) {
        issues.append(ChartIssue(
            path: "\(path).step",
            message: "\(path).step must be greater than 0 (or null for automatic)."
        ))
        step = fallback.step
    }
    var axis = ChartAxis(
        show: flagField(obj["show"], fallback.show, "\(path).show", &issues),
        title: textField(obj["title"], fallback.title, "\(path).title", &issues),
        min: min,
        max: max,
        step: step,
        gridlines: flagField(obj["gridlines"], fallback.gridlines, "\(path).gridlines", &issues),
        format: obj.keys.contains("format") ? normalizeFormat(obj["format"], "\(path).format", &issues) : fallback.format
    )
    let kind: ChartAxisKind?
    if obj.keys.contains("kind") {
        if obj["kind"] == .null {
            kind = nil
        } else {
            kind = pickEnum(obj["kind"], CHART_AXIS_KINDS, .category, "\(path).kind", &issues)
        }
    } else {
        kind = fallback.kind
    }
    if let kind, kind != .category {
        axis.kind = kind
    }
    let scale: ChartAxisScale
    if obj.keys.contains("scale") {
        if obj["scale"] == .null {
            scale = .linear
        } else {
            scale = pickEnum(obj["scale"], CHART_AXIS_SCALES, .linear, "\(path).scale", &issues)
        }
    } else {
        scale = fallback.scale ?? .linear
    }
    if scale == .log {
        axis.scale = .log
        let hasLogBaseKey = obj.keys.contains("logBase")
        let rawBase: JSONValue? = hasLogBaseKey ? obj["logBase"] : (fallback.logBase.map(JSONValue.number))
        if let rawBase, rawBase != .null {
            if let b = jsNumberValue(rawBase), b.isFinite && b >= 2 && b <= 1000 {
                if b != 10 { axis.logBase = b }
            } else {
                issues.append(ChartIssue(
                    path: "\(path).logBase",
                    message: "\(path).logBase must be a number from 2 to 1000 (default 10)."
                ))
            }
        }
        if let mn = axis.min, !(mn > 0) {
            issues.append(ChartIssue(
                path: "\(path).min",
                message: "\(path).min must be greater than 0 on a logarithmic axis (or null for automatic); got \(JSONValue.jsString(mn))."
            ))
            axis.min = nil
        }
        if let mx = axis.max, !(mx > 0) {
            issues.append(ChartIssue(
                path: "\(path).max",
                message: "\(path).max must be greater than 0 on a logarithmic axis (or null for automatic); got \(JSONValue.jsString(mx))."
            ))
            axis.max = nil
        }
    }
    let rev: Bool
    if obj.keys.contains("reverse") {
        if obj["reverse"] == .null {
            rev = false
        } else {
            rev = flagField(obj["reverse"], false, "\(path).reverse", &issues)
        }
    } else {
        rev = fallback.reverse ?? false
    }
    if rev { axis.reverse = true }
    return axis
}

private func normalizeLegend(_ value: JSONValue?, _ issues: inout [ChartIssue]) -> ChartLegend {
    let fallback = ChartLegend(show: true, position: .bottom)
    guard let value else { return fallback }
    guard case .object(let obj) = value else {
        issues.append(ChartIssue(path: "legend", message: "legend must be an object."))
        return fallback
    }
    return ChartLegend(
        show: flagField(obj["show"], fallback.show, "legend.show", &issues),
        position: pickEnum(obj["position"], CHART_LEGEND_POSITIONS, fallback.position, "legend.position", &issues)
    )
}

/// Values as numbers or nils; bad entries become nil and are reported.
public func normalizeChartValues(
    _ value: JSONValue?,
    _ length: Int?,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> [ChartValue] {
    guard let value else {
        if let length, length > 0 { return Array(repeating: nil, count: length) }
        return []
    }
    guard case .array(let arr) = value else {
        issues.append(ChartIssue(path: path, message: "\(path) must be an array of numbers."))
        if let length, length > 0 { return Array(repeating: nil, count: length) }
        return []
    }
    var out: [ChartValue] = arr.enumerated().map { i, v in
        guard let parsed = parseChartValue(v) else {
            issues.append(ChartIssue(
                path: "\(path)[\(i)]",
                message: "\(path)[\(i)] is not a number: \(jsJSONStringify(v))."
            ))
            return nil
        }
        return parsed
    }
    guard let length else { return out }
    if out.count > length { return Array(out.prefix(length)) }
    while out.count < length { out.append(nil) }
    return out
}

private func hasNonNullKey(_ obj: JSONObject, _ name: String) -> Bool {
    guard let val = obj[name] else { return false }
    return val != .null
}

private func normalizeSeries(
    _ value: JSONValue,
    _ length: Int,
    _ used: inout Set<String>,
    _ index: Int,
    _ issues: inout [ChartIssue]
) -> ChartSeries? {
    let path = "series[\(index)]"
    guard case .object(let obj) = value else {
        issues.append(ChartIssue(path: path, message: "\(path) must be an object with a name and values."))
        return nil
    }
    var id = ""
    if case .string(let s)? = obj["id"], !s.jsTrimmed.isEmpty {
        id = s.jsTrimmed
    }
    if id.isEmpty || used.contains(id) {
        if !id.isEmpty {
            issues.append(ChartIssue(
                path: "\(path).id",
                message: "Series id \"\(id)\" is used twice; the second was renamed."
            ))
        }
        var n = index + 1
        while true {
            id = "series-\(n)"
            if !used.contains(id) { break }
            n += 1
        }
    }
    used.insert(id)
    var series = ChartSeries(
        id: id,
        name: textField(obj["name"], "Series \(index + 1)", "\(path).name", &issues),
        values: normalizeChartValues(obj["values"], length, "\(path).values", &issues)
    )
    if case .string(let c)? = obj["color"], !c.jsTrimmed.isEmpty {
        series.color = c.jsTrimmed
    }
    if hasNonNullKey(obj, "type") {
        series.type = pickEnum(obj["type"], CHART_SERIES_TYPES, .bar, "\(path).type", &issues)
    }
    if obj["hidden"] == .bool(true) {
        series.hidden = true
    }
    if hasNonNullKey(obj, "axis") {
        if pickEnum(obj["axis"], ChartSeriesAxis.allCases, .primary, "\(path).axis", &issues) == .secondary {
            series.axis = .secondary
        }
    }
    if hasNonNullKey(obj, "x") {
        let list = normalizeChartValues(obj["x"], length, "\(path).x", &issues)
        if list.contains(where: { $0 != nil }) {
            series.x = list
        }
    }
    if hasNonNullKey(obj, "sizes") {
        let list = normalizeChartValues(obj["sizes"], length, "\(path).sizes", &issues)
        if list.contains(where: { $0 != nil }) {
            series.sizes = list
        }
    }
    if hasNonNullKey(obj, "sizes"), let sizes = series.sizes, sizes.contains(where: { $0 != nil && $0! < 0 }) {
        issues.append(ChartIssue(path: "\(path).sizes", message: "\(path).sizes must not be negative."))
        series.sizes = sizes.map { v in (v != nil && v! < 0) ? nil : v }
    }
    if hasNonNullKey(obj, "pointColors") {
        if case .array(let arr)? = obj["pointColors"] {
            let colors: [String?] = (0..<length).map { i in
                guard i < arr.count, case .string(let c) = arr[i], !c.jsTrimmed.isEmpty else { return nil }
                return c.jsTrimmed
            }
            if colors.contains(where: { $0 != nil }) {
                series.pointColors = colors
            }
        } else {
            issues.append(ChartIssue(
                path: "\(path).pointColors",
                message: "\(path).pointColors must be an array of colours or nulls."
            ))
        }
    }
    if hasNonNullKey(obj, "callouts") {
        if case .array(let arr)? = obj["callouts"] {
            let labels: [String?] = (0..<length).map { i in
                guard i < arr.count else { return nil }
                switch arr[i] {
                case .string(let c):
                    return !c.jsTrimmed.isEmpty ? c : nil
                case .number(let n):
                    return JSONValue.jsString(n)
                default:
                    return nil
                }
            }
            if labels.contains(where: { $0 != nil }) {
                series.callouts = labels
            }
        } else {
            issues.append(ChartIssue(
                path: "\(path).callouts",
                message: "\(path).callouts must be an array of labels or nulls, one per category."
            ))
        }
    }
    if hasNonNullKey(obj, "marker") {
        series.marker = pickEnum(obj["marker"], CHART_MARKERS, .circle, "\(path).marker", &issues)
    }
    if hasNonNullKey(obj, "curve") {
        series.curve = pickEnum(obj["curve"], CHART_CURVES, .linear, "\(path).curve", &issues)
    }
    if hasNonNullKey(obj, "dataLabels") {
        series.dataLabels = flagField(obj["dataLabels"], false, "\(path).dataLabels", &issues)
    }
    if hasNonNullKey(obj, "format") {
        let format = normalizeFormat(obj["format"], "\(path).format", &issues)
        if !format.isEmpty {
            series.format = format
        }
    }
    if hasNonNullKey(obj, "errorBars") {
        if let bars = normalizeChartErrorBars(obj["errorBars"], length, "\(path).errorBars", &issues) {
            series.errorBars = bars
        }
    }
    if hasNonNullKey(obj, "xErrorBars") {
        if let bars = normalizeChartErrorBars(obj["xErrorBars"], length, "\(path).xErrorBars", &issues) {
            series.xErrorBars = bars
        }
    }
    if hasNonNullKey(obj, "trendlines") {
        if case .array(let arr)? = obj["trendlines"] {
            let lines = arr.enumerated().compactMap { i, t in
                normalizeChartTrendline(t, "\(path).trendlines[\(i)]", &issues)
            }
            if !lines.isEmpty {
                series.trendlines = lines
            }
        } else {
            issues.append(ChartIssue(path: "\(path).trendlines", message: "\(path).trendlines must be an array."))
        }
    }
    return series
}

private func referenceCommon(
    _ obj: JSONObject,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> (label: String?, axis: ChartReferenceAxis?, color: String?) {
    var outLabel: String? = nil
    var outAxis: ChartReferenceAxis? = nil
    var outColor: String? = nil
    let label = textField(obj["label"], "", "\(path).label", &issues)
    if !label.isEmpty { outLabel = label }
    if hasNonNullKey(obj, "axis") {
        let axis = pickEnum(obj["axis"], CHART_REFERENCE_AXES, .y, "\(path).axis", &issues)
        if axis != .y { outAxis = axis }
    }
    if case .string(let c)? = obj["color"], !c.jsTrimmed.isEmpty {
        outColor = c.jsTrimmed
    } else if hasNonNullKey(obj, "color") {
        issues.append(ChartIssue(path: "\(path).color", message: "\(path).color must be a CSS colour."))
    }
    return (outLabel, outAxis, outColor)
}

private func finiteNumber(_ value: JSONValue?) -> Double? {
    guard let value else { return nil }
    switch value {
    case .number(let n):
        return n.isFinite ? (n == 0 ? 0 : n) : nil
    case .string(let s):
        guard !s.jsTrimmed.isEmpty else { return nil }
        let n = s.jsToNumber
        return n.isFinite ? (n == 0 ? 0 : n) : nil
    default:
        return nil
    }
}

/// Checks one reference line; `nil` (reported) when it has no usable value.
public func normalizeChartReferenceLine(
    _ value: JSONValue?,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> ChartReferenceLine? {
    guard let value, case .object(let obj) = value else {
        issues.append(ChartIssue(
            path: path,
            message: "\(path) must be an object with a value, e.g. {\"value\": 100, \"label\": \"Target\"}."
        ))
        return nil
    }
    guard let at = finiteNumber(obj["value"]) else {
        issues.append(ChartIssue(
            path: "\(path).value",
            message: "\(path).value must be a number (where the line crosses the axis)."
        ))
        return nil
    }
    for k in obj.keys {
        if k != "value" && k != "label" && k != "axis" && k != "color" {
            issues.append(ChartIssue(
                path: "\(path).\(k)",
                message: "\(path) has no \"\(k)\"; it takes value, label, axis and color."
            ))
        }
    }
    let common = referenceCommon(obj, path, &issues)
    return ChartReferenceLine(value: at, label: common.label, axis: common.axis, color: common.color)
}

/// Checks one reference band; `nil` (reported) when its ends are not numbers. Ends are put in order.
public func normalizeChartReferenceBand(
    _ value: JSONValue?,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> ChartReferenceBand? {
    guard let value, case .object(let obj) = value else {
        issues.append(ChartIssue(
            path: path,
            message: "\(path) must be an object with from and to, e.g. {\"from\": 80, \"to\": 120, \"label\": \"Target range\"}."
        ))
        return nil
    }
    guard let from = finiteNumber(obj["from"]), let to = finiteNumber(obj["to"]) else {
        issues.append(ChartIssue(
            path: path,
            message: "\(path) needs numbers for from and to (the ends of the band on its axis)."
        ))
        return nil
    }
    for k in obj.keys {
        if k != "from" && k != "to" && k != "label" && k != "axis" && k != "color" {
            issues.append(ChartIssue(
                path: "\(path).\(k)",
                message: "\(path) has no \"\(k)\"; it takes from, to, label, axis and color."
            ))
        }
    }
    let common = referenceCommon(obj, path, &issues)
    return ChartReferenceBand(
        from: Swift.min(from, to),
        to: Swift.max(from, to),
        label: common.label,
        axis: common.axis,
        color: common.color
    )
}

/// Checks one set of error bars; `nil` (reported) when it is unusable. Custom amounts are padded to `length`.
public func normalizeChartErrorBars(
    _ value: JSONValue?,
    _ length: Int,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> ChartErrorBars? {
    guard let value, case .object(let obj) = value else {
        let typesList = CHART_ERROR_BAR_TYPES.map { $0.rawValue }.joined(separator: ", ")
        issues.append(ChartIssue(
            path: path,
            message: "\(path) must be an object with a type (\(typesList)), or null for none."
        ))
        return nil
    }
    let before = issues.count
    let type = pickEnum(obj["type"], CHART_ERROR_BAR_TYPES, .fixed, "\(path).type", &issues)
    if obj["type"] == nil {
        let quoted = CHART_ERROR_BAR_TYPES.map { "\"\($0.rawValue)\"" }.joined(separator: ", ")
        issues.append(ChartIssue(
            path: "\(path).type",
            message: "\(path).type is required: one of \(quoted)."
        ))
    }
    var bars = ChartErrorBars(type: type)
    if hasNonNullKey(obj, "value") {
        let n = jsNumberValue(obj["value"]) ?? .nan
        if type == .stderr || type == .custom {
            let reason = type == .custom ? "pass plus and minus amounts instead" : "the amount comes from the data"
            issues.append(ChartIssue(
                path: "\(path).value",
                message: "\(type.rawValue) error bars take no value; \(reason)."
            ))
        } else if n.isFinite && n >= 0 {
            bars.value = n == 0 ? 0 : n
        } else {
            let pctHint = type == .percent ? " (a percentage, e.g. 5 for 5%)" : ""
            issues.append(ChartIssue(
                path: "\(path).value",
                message: "\(path).value must be a number, 0 or more\(pctHint)."
            ))
        }
    }
    for name in ["plus", "minus"] {
        guard hasNonNullKey(obj, name) else { continue }
        if type != .custom {
            issues.append(ChartIssue(
                path: "\(path).\(name)",
                message: "\(path).\(name) only applies to custom error bars; set type to \"custom\"."
            ))
            continue
        }
        let list = normalizeChartValues(obj[name], length, "\(path).\(name)", &issues)
        if list.contains(where: { $0 != nil && $0! < 0 }) {
            issues.append(ChartIssue(
                path: "\(path).\(name)",
                message: "\(path).\(name) amounts must be 0 or more (distances from the point)."
            ))
        } else {
            if name == "plus" { bars.plus = list }
            else { bars.minus = list }
        }
    }
    if type == .custom && bars.plus == nil && bars.minus == nil && issues.count == before {
        issues.append(ChartIssue(
            path: "\(path).plus",
            message: "Custom error bars need plus and / or minus amounts, one per category."
        ))
    }
    if hasNonNullKey(obj, "direction") {
        let direction = pickEnum(obj["direction"], CHART_ERROR_BAR_DIRECTIONS, .both, "\(path).direction", &issues)
        if direction != .both { bars.direction = direction }
    }
    if hasNonNullKey(obj, "cap") && !flagField(obj["cap"], true, "\(path).cap", &issues) {
        bars.cap = false
    }
    return issues.count > before ? nil : bars
}

/// Checks one trendline; `nil` (reported) when it is unusable.
public func normalizeChartTrendline(
    _ value: JSONValue?,
    _ path: String,
    _ issues: inout [ChartIssue]
) -> ChartTrendline? {
    guard let value, case .object(let obj) = value else {
        issues.append(ChartIssue(path: path, message: "\(path) must be an object with a type."))
        return nil
    }
    let type = pickEnum(obj["type"], CHART_TRENDLINE_TYPES, .linear, "\(path).type", &issues)
    var line = ChartTrendline(type: type)
    func whole(_ name: String, _ min: Int, _ max: Int) -> Int? {
        guard hasNonNullKey(obj, name) else { return nil }
        if let n = jsNumberValue(obj[name]), isWholeNumber(n), Int(n) >= min && Int(n) <= max {
            return Int(n)
        }
        issues.append(ChartIssue(
            path: "\(path).\(name)",
            message: "\(path).\(name) must be a whole number from \(min) to \(max)."
        ))
        return nil
    }
    if type == .polynomial { line.order = whole("order", 2, 6) }
    if type == .movingAverage { line.period = whole("period", 2, 1000) }
    for name in ["forward", "backward"] {
        guard hasNonNullKey(obj, name) else { continue }
        if let n = jsNumberValue(obj[name]), n.isFinite && n >= 0 {
            if n > 0 {
                if name == "forward" { line.forward = n }
                else { line.backward = n }
            }
        } else {
            issues.append(ChartIssue(
                path: "\(path).\(name)",
                message: "\(path).\(name) must be a number of x units, 0 or more."
            ))
        }
    }
    if hasNonNullKey(obj, "intercept") {
        let n = jsNumberValue(obj["intercept"]) ?? .nan
        if !n.isFinite {
            issues.append(ChartIssue(
                path: "\(path).intercept",
                message: "\(path).intercept must be a number or null."
            ))
        } else if type == .linear || type == .polynomial || type == .exponential {
            if type == .exponential && n <= 0 {
                issues.append(ChartIssue(
                    path: "\(path).intercept",
                    message: "\(path).intercept must be greater than 0 for an exponential trendline."
                ))
            } else {
                line.intercept = n == 0 ? 0 : n
            }
        } else {
            issues.append(ChartIssue(
                path: "\(path).intercept",
                message: "A \(type.rawValue) trendline cannot have a fixed intercept; use linear, polynomial or exponential."
            ))
        }
    }
    if hasNonNullKey(obj, "showEquation") && flagField(obj["showEquation"], false, "\(path).showEquation", &issues) {
        line.showEquation = true
    }
    if hasNonNullKey(obj, "showR2") && flagField(obj["showR2"], false, "\(path).showR2", &issues) {
        line.showR2 = true
    }
    if hasNonNullKey(obj, "name") {
        let t = textField(obj["name"], "", "\(path).name", &issues).jsTrimmed
        if !t.isEmpty { line.name = t }
    }
    if hasNonNullKey(obj, "color") {
        let t = textField(obj["color"], "", "\(path).color", &issues).jsTrimmed
        if !t.isEmpty { line.color = t }
    }
    return line
}

/// Turns any input (a partial spec, saved JSON, an agent's arguments) into a complete,
/// valid `ChartSpec`. Every value is checked; problems are reported as sentences in
/// `issues` and replaced by defaults, so the result is always drawable. Series values are
/// padded or trimmed to the number of categories.
public func normalizeChartSpec(_ input: JSONValue?) -> (spec: ChartSpec, issues: [ChartIssue]) {
    var issues: [ChartIssue] = []
    let value: JSONObject
    if let input {
        if case .object(let obj) = input {
            value = obj
        } else {
            issues.append(ChartIssue(path: "", message: "A chart must be an object."))
            value = JSONObject()
        }
    } else {
        value = JSONObject()
    }
    let type = pickEnum(value["type"], CHART_TYPES, .bar, "type", &issues)
    let rawSeries: [JSONValue]
    if case .array(let arr)? = value["series"] {
        rawSeries = arr
    } else {
        if value["series"] != nil {
            issues.append(ChartIssue(path: "series", message: "series must be an array."))
        }
        rawSeries = []
    }

    var categories: [String]
    if case .array(let arr)? = value["categories"] {
        categories = arr.enumerated().map { i, c in
            textField(c, "", "categories[\(i)]", &issues)
        }
    } else {
        if value["categories"] != nil {
            issues.append(ChartIssue(path: "categories", message: "categories must be an array of labels."))
        }
        let longest = rawSeries.reduce(0) { n, s in
            if case .object(let sObj) = s, case .array(let vals)? = sObj["values"] {
                return Swift.max(n, vals.count)
            }
            return n
        }
        categories = (0..<longest).map { "\($0 + 1)" }
    }

    let tree = normalizeChartTree(value["tree"], &issues)
    let links = normalizeChartLinks(value["links"], &issues)
    let sankeyOrder: [String]
    if case .array(let arr)? = value["sankeyNodes"] {
        sankeyOrder = arr.map { jsCellString($0) }
    } else {
        sankeyOrder = []
    }
    let sankeyNodes = chartSankeyNodes(links, sankeyOrder, &issues)
    if let snVal = value["sankeyNodes"], snVal != .null {
        if case .array = snVal {} else {
            issues.append(ChartIssue(path: "sankeyNodes", message: "sankeyNodes must be an array of node names."))
        }
    }
    if !tree.isEmpty && !links.isEmpty {
        issues.append(ChartIssue(
            path: "links",
            message: "A chart holds either grouped data (tree) or flows (links), not both; the flows were used."
        ))
    }
    if !links.isEmpty {
        categories = sankeyNodes
    } else if !tree.isEmpty {
        categories = tree.map { $0.name }
    }

    var used = Set<String>()
    var series = rawSeries.enumerated().compactMap { i, s in
        normalizeSeries(s, categories.count, &used, i, &issues)
    }
    if !tree.isEmpty || !links.isEmpty {
        if series.isEmpty {
            series.append(ChartSeries(id: uniqueChartSeriesId(series), name: "Values", values: []))
        }
        let derivedValues: [ChartValue] = !links.isEmpty
            ? chartSankeyNodeValues(links, sankeyNodes).map { Optional.some($0) }
            : tree.map { Optional.some(chartTreeTotal($0)) }
        series[0].values = derivedValues
    }

    var palette = DEFAULT_CHART_PALETTE
    if case .array(let arr)? = value["palette"] {
        let colors = arr.compactMap { item -> String? in
            if case .string(let c) = item, !c.jsTrimmed.isEmpty { return c }
            return nil
        }
        if !colors.isEmpty {
            palette = colors
        } else {
            issues.append(ChartIssue(path: "palette", message: "palette must list at least one colour."))
        }
    } else if value["palette"] != nil {
        issues.append(ChartIssue(path: "palette", message: "palette must be an array of colours."))
    }

    func fraction(_ name: String, _ fallback: Double, _ min: Double, _ max: Double) -> Double {
        guard let raw = value[name] else { return fallback }
        if raw != .null, let r = jsNumberValue(raw), r.isFinite && r >= min && r <= max {
            return r == 0 ? 0 : r
        }
        issues.append(ChartIssue(
            path: name,
            message: "\(name) must be a number from \(JSONValue.jsString(min)) to \(JSONValue.jsString(max))."
        ))
        return fallback
    }
    let innerRadius = fraction("innerRadius", 0.55, 0, 0.9)
    let gapWidth = fraction("gapWidth", 0.28, 0, 0.9)
    let overlap = fraction("overlap", -0.12, -1, 1)

    var bins: Int? = nil
    if let rawBins = value["bins"], rawBins != .null {
        if let b = jsNumberValue(rawBins), isWholeNumber(b), Int(b) >= 1 && Int(b) <= 500 {
            bins = Int(b)
        } else {
            issues.append(ChartIssue(
                path: "bins",
                message: "bins must be a whole number from 1 to 500, or null for automatic."
            ))
        }
    }

    var highlight: [String] = []
    if case .array(let arr)? = value["highlight"] {
        for h in arr {
            switch h {
            case .string(let s):
                if !highlight.contains(s) { highlight.append(s) }
            case .number(let n):
                let name = JSONValue.jsString(n)
                if !highlight.contains(name) { highlight.append(name) }
            default:
                issues.append(ChartIssue(
                    path: "highlight",
                    message: "highlight must list category labels or series names."
                ))
            }
        }
    } else if let rawHighlight = value["highlight"], rawHighlight != .null {
        issues.append(ChartIssue(
            path: "highlight",
            message: "highlight must be an array of category labels or series names."
        ))
    }

    func listOf<T>(
        _ name: String,
        _ read: (JSONValue?, String, inout [ChartIssue]) -> T?
    ) -> [T] {
        guard let raw = value[name], raw != .null else { return [] }
        guard case .array(let arr) = raw else {
            issues.append(ChartIssue(path: name, message: "\(name) must be an array."))
            return []
        }
        return arr.enumerated().compactMap { i, item in
            read(item, "\(name)[\(i)]", &issues)
        }
    }
    let referenceLines = listOf("referenceLines", normalizeChartReferenceLine)
    let referenceBands = listOf("referenceBands", normalizeChartReferenceBand)

    var parliamentMajority: Int? = nil
    if let rawMaj = value["parliamentMajority"], rawMaj != .null {
        if let m = jsNumberValue(rawMaj), isWholeNumber(m), Int(m) >= 1 {
            parliamentMajority = Int(m)
        } else {
            issues.append(ChartIssue(
                path: "parliamentMajority",
                message: "parliamentMajority must be a whole number of seats, 1 or more, or null for half plus one."
            ))
        }
    }

    var mapSteps = 5
    if let rawSteps = value["mapSteps"] {
        if rawSteps != .null, let n = jsNumberValue(rawSteps), isWholeNumber(n), Int(n) >= 2 && Int(n) <= 9 {
            mapSteps = Int(n)
        } else {
            issues.append(ChartIssue(
                path: "mapSteps",
                message: "mapSteps must be a whole number of colour classes from 2 to 9."
            ))
        }
    }

    var mapThresholds: [Double] = []
    if let rawThresh = value["mapThresholds"], rawThresh != .null {
        if case .array(let arr) = rawThresh {
            let list = arr.map { jsNumberValue($0) ?? .nan }
            let invalid = list.contains(where: { !$0.isFinite }) ||
                list.count > 8 ||
                list.enumerated().contains(where: { i, t in i > 0 && t <= list[i - 1] })
            if invalid {
                issues.append(ChartIssue(
                    path: "mapThresholds",
                    message: "mapThresholds must be up to 8 numbers in ascending order (the class breaks), or [] for equal classes."
                ))
            } else {
                mapThresholds = list.map { $0 == 0 ? 0 : $0 }
            }
        } else {
            issues.append(ChartIssue(
                path: "mapThresholds",
                message: "mapThresholds must be up to 8 numbers in ascending order (the class breaks), or [] for equal classes."
            ))
        }
    }

    var raceTopN = 10
    if let rawTopN = value["raceTopN"] {
        if rawTopN != .null, let n = jsNumberValue(rawTopN), isWholeNumber(n), Int(n) >= 1 && Int(n) <= 30 {
            raceTopN = Int(n)
        } else {
            issues.append(ChartIssue(
                path: "raceTopN",
                message: "raceTopN must be a whole number of bars from 1 to 30."
            ))
        }
    }

    var view3d: ChartView3d? = nil
    if let raw = value["view3d"], raw != .null {
        if case .object(let v) = raw {
            func angle(_ key: String, _ lo: Double, _ hi: Double, _ fallback: Double, _ what: String) -> Double {
                guard let rawField = v[key] else { return fallback }
                if rawField != .null, let n = jsNumberValue(rawField), n.isFinite, n >= lo && n <= hi { return n }
                issues.append(ChartIssue(path: "view3d.\(key)", message: "view3d.\(key) must be \(what)."))
                return fallback
            }
            for k in v.keys where !["azimuth", "elevation", "depth"].contains(k) {
                issues.append(ChartIssue(path: "view3d.\(k)", message: "view3d has no \"\(k)\"; it takes azimuth, elevation and depth."))
            }
            view3d = ChartView3d(
                azimuth: angle("azimuth", 0, 360, CHART_VIEW3D_DEFAULTS.azimuth, "a turn from 0 to 360 degrees"),
                elevation: angle("elevation", 0, 90, CHART_VIEW3D_DEFAULTS.elevation, "an angle from 0 to 90 degrees"),
                depth: angle("depth", 0.2, 20, CHART_VIEW3D_DEFAULTS.depth, "a multiple of the bar width from 0.2 to 20")
            )
        } else {
            issues.append(ChartIssue(path: "view3d", message: "view3d must be { azimuth, elevation, depth } or null for a flat chart."))
        }
    }

    var radarTicks: Int? = nil
    if let rawRadar = value["radarTicks"], rawRadar != .null {
        if let t = jsNumberValue(rawRadar), isWholeNumber(t), Int(t) >= 1 && Int(t) <= 50 {
            radarTicks = Int(t)
        } else {
            issues.append(ChartIssue(
                path: "radarTicks",
                message: "radarTicks must be a whole number from 1 to 50, or null for round-number rings."
            ))
        }
    }

    let rawMapText = textField(value["map"], "europe", "map", &issues).jsTrimmed
    let mapId = rawMapText.isEmpty ? "europe" : rawMapText

    var spec = ChartSpec(
        version: 1,
        type: type,
        title: textField(value["title"], "", "title", &issues),
        subtitle: textField(value["subtitle"], "", "subtitle", &issues),
        categories: categories,
        series: series,
        xAxis: normalizeChartAxis(value["xAxis"], defaultChartAxis(false), "xAxis", &issues),
        yAxis: normalizeChartAxis(value["yAxis"], defaultChartAxis(true), "yAxis", &issues),
        yAxis2: normalizeChartAxis(value["yAxis2"], defaultChartAxis(false), "yAxis2", &issues),
        legend: normalizeLegend(value["legend"], &issues),
        stacking: pickEnum(value["stacking"], CHART_STACKINGS, .none, "stacking", &issues),
        orientation: pickEnum(value["orientation"], CHART_ORIENTATIONS, .vertical, "orientation", &issues),
        curve: pickEnum(value["curve"], CHART_CURVES, .linear, "curve", &issues),
        points: flagField(value["points"], true, "points", &issues),
        dataLabels: flagField(value["dataLabels"], false, "dataLabels", &issues),
        labelPosition: pickEnum(value["labelPosition"], CHART_LABEL_POSITIONS, .auto, "labelPosition", &issues),
        palette: palette,
        innerRadius: innerRadius,
        gapWidth: gapWidth,
        overlap: overlap,
        bins: bins,
        showTotal: flagField(value["showTotal"], true, "showTotal", &issues),
        radarTicks: radarTicks,
        radarGraticule: pickEnum(value["radarGraticule"], CHART_RADAR_GRATICULES, .polygon, "radarGraticule", &issues),
        note: textField(value["note"], "", "note", &issues),
        highlight: highlight,
        referenceLines: referenceLines,
        referenceBands: referenceBands,
        varyColors: flagField(value["varyColors"], false, "varyColors", &issues),
        likertNeutral: pickEnum(value["likertNeutral"], CHART_LIKERT_NEUTRALS, .split, "likertNeutral", &issues),
        likertSort: pickEnum(value["likertSort"], CHART_LIKERT_SORTS, .none, "likertSort", &issues),
        parliamentArc: fraction("parliamentArc", 180, 90, 360),
        parliamentMajority: parliamentMajority,
        parliamentLabel: textField(value["parliamentLabel"], "", "parliamentLabel", &issues),
        tree: !links.isEmpty ? [] : tree,
        sunburstLabel: textField(value["sunburstLabel"], "", "sunburstLabel", &issues),
        links: links,
        sankeyNodes: !links.isEmpty ? sankeyNodes : [],
        sankeyLinkColor: pickEnum(value["sankeyLinkColor"], CHART_SANKEY_LINK_COLORS, .source, "sankeyLinkColor", &issues),
        raceTopN: raceTopN,
        map: mapId,
        mapSteps: mapSteps,
        mapThresholds: mapThresholds,
        view3d: view3d
    )

    if spec.stacking == .percent {
        if spec.yAxis.scale == .log {
            issues.append(ChartIssue(
                path: "yAxis.scale",
                message: "A logarithmic yAxis cannot show percent stacking (shares from 0% to 100% include 0); use stacking \"stacked\" or \"none\", or a linear axis."
            ))
            spec.yAxis.scale = nil
            spec.yAxis.logBase = nil
        }
        if spec.yAxis2.scale == .log {
            issues.append(ChartIssue(
                path: "yAxis2.scale",
                message: "A logarithmic yAxis2 cannot show percent stacking (shares from 0% to 100% include 0); use stacking \"stacked\" or \"none\", or a linear axis."
            ))
            spec.yAxis2.scale = nil
            spec.yAxis2.logBase = nil
        }
    }
    return (spec: spec, issues: issues)
}

/// A deep copy (specs are value types in Swift).
public func cloneChartSpec(_ spec: ChartSpec) -> ChartSpec {
    spec
}

public func cloneChartSeries(_ series: ChartSeries) -> ChartSeries {
    series
}

public enum ChartSeriesDirection: String, Sendable, Equatable {
    case columns
    case rows
}

public struct ChartTableOptions: Sendable, Equatable {
    public var seriesIn: ChartSeriesDirection?
    public var header: ChartHeaderOption?
    public var xFromFirstColumn: Bool?

    public init(
        seriesIn: ChartSeriesDirection? = nil,
        header: ChartHeaderOption? = nil,
        xFromFirstColumn: Bool? = nil
    ) {
        self.seriesIn = seriesIn
        self.header = header
        self.xFromFirstColumn = xFromFirstColumn
    }
}

public struct ChartTableData: Sendable, Equatable {
    public var categories: [String]
    public var series: [ChartSeries]
    public var issues: [ChartIssue]

    public init(categories: [String], series: [ChartSeries], issues: [ChartIssue]) {
        self.categories = categories
        self.series = series
        self.issues = issues
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("categories", .array(categories.map(JSONValue.string))),
            ("series", .array(series.map { $0.toJSON() })),
            ("issues", .array(issues.map { $0.toJSON() }))
        ]))
    }
}

/// Reads a grid of cells (from CSV, a spreadsheet range or the clipboard) as categories and
/// series. Cells that are not numbers become gaps and are reported.
public func chartDataFromTable(
    _ rows: [[JSONValue]],
    _ options: ChartTableOptions = ChartTableOptions()
) -> ChartTableData {
    var grid = rows.filter { r in
        r.contains { c in c != .null && !jsCellString(c).jsTrimmed.isEmpty }
    }
    if options.seriesIn == .rows {
        let width = grid.map { $0.count }.max() ?? 0
        grid = (0..<width).map { c in
            grid.map { r in c < r.count ? r[c] : .null }
        }
    }
    var issues: [ChartIssue] = []
    if grid.isEmpty {
        return ChartTableData(categories: [], series: [], issues: issues)
    }
    let width = grid.map { $0.count }.max() ?? 0
    let header: Bool
    switch options.header ?? .bool(true) {
    case .bool(let b):
        header = b
    case .auto:
        header = grid[0].dropFirst().contains { c in
            c != .null && !jsCellString(c).jsTrimmed.isEmpty && parseChartValue(c) == nil
        }
    }
    let names = header ? grid[0] : []
    let body = header ? Array(grid.dropFirst()) : grid
    let categories: [String] = body.enumerated().map { i, r in
        let c: JSONValue = r.isEmpty ? .null : r[0]
        if c == .null || jsCellString(c).jsTrimmed.isEmpty {
            return "\(i + 1)"
        }
        return jsCellString(c).jsTrimmed
    }
    var series: [ChartSeries] = []
    if width > 1 {
        for col in 1..<width {
            let name: String
            if col < names.count && names[col] != .null && !jsCellString(names[col]).jsTrimmed.isEmpty {
                name = jsCellString(names[col]).jsTrimmed
            } else {
                name = "Series \(col)"
            }
            let values: [ChartValue] = body.enumerated().map { i, r in
                let cellVal: JSONValue? = col < r.count ? r[col] : .null
                guard let parsed = parseChartValue(cellVal) else {
                    let rawStr = col < r.count ? jsCellString(r[col]) : "undefined"
                    issues.append(ChartIssue(
                        path: "\(name)[\(i)]",
                        message: "\"\(rawStr)\" in \(name) (\(categories[i])) is not a number; it was left blank."
                    ))
                    return nil
                }
                return parsed
            }
            series.append(ChartSeries(id: "series-\(col)", name: name, values: values))
        }
    }
    if options.xFromFirstColumn == true {
        let x: [ChartValue] = body.enumerated().map { i, r in
            let cellVal: JSONValue? = r.isEmpty ? .null : r[0]
            guard let parsed = parseChartValue(cellVal) else {
                let rawStr = r.isEmpty ? "undefined" : jsCellString(r[0])
                issues.append(ChartIssue(
                    path: "x[\(i)]",
                    message: "\"\(rawStr)\" in the first column is not a number; that point has no x."
                ))
                return nil
            }
            return parsed
        }
        for idx in series.indices {
            series[idx].x = x
        }
    }
    return ChartTableData(categories: categories, series: series, issues: issues)
}

/// The chart's data as a grid: a header row of series names, then one row per category.
public func chartDataToTable(
    _ spec: ChartSpec,
    categoryHeader: String = ""
) -> [[JSONValue]] {
    let headerRow: [JSONValue] = [.string(categoryHeader)] + spec.series.map { .string($0.name) }
    let bodyRows: [[JSONValue]] = spec.categories.enumerated().map { i, category in
        [.string(category)] + spec.series.map { s in
            let v: ChartValue = i < s.values.count ? s.values[i] : nil
            return v.map(JSONValue.number) ?? .null
        }
    }
    return [headerRow] + bodyRows
}

/// A colour input value (`#rrggbb`) for a CSS colour: `#abc` expands, non-hex colours show as black.
public func chartColorInputValue(_ color: String) -> String {
    let chars = Array(color)
    if chars.count == 7 && chars[0] == "#" && chars.dropFirst().allSatisfy({ $0.isHexDigit }) {
        return color.lowercased()
    }
    if chars.count == 4 && chars[0] == "#" && chars.dropFirst().allSatisfy({ $0.isHexDigit }) {
        let expanded = chars.dropFirst().map { "\($0)\($0)" }.joined()
        return "#\(expanded)".lowercased()
    }
    return "#000000"
}
