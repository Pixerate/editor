import Foundation
import PixerateCore
import PixerateRaster

public struct ChartMermaidParseOptions: Sendable, Equatable {
    /// Accept a statement that is still being written (an unclosed `[` list): for streaming views.
    public var partial: Bool?
    /// Ignore the `%% @pixerate` line (what the Mermaid text alone says).
    public var ignoreMeta: Bool?

    public init(partial: Bool? = nil, ignoreMeta: Bool? = nil) {
        self.partial = partial
        self.ignoreMeta = ignoreMeta
    }
}

public struct ChartMermaidResult: Sendable, Equatable {
    public var spec: ChartSpec
    /// Problems, with 1-based `line` numbers. Lines that could not be read are listed and skipped.
    public var issues: [ChartIssue]
    public var family: ChartMermaidFamily?
    /// The `%% @pixerate` line was found and applied.
    public var hasMeta: Bool

    public init(spec: ChartSpec, issues: [ChartIssue], family: ChartMermaidFamily?, hasMeta: Bool) {
        self.spec = spec
        self.issues = issues
        self.family = family
        self.hasMeta = hasMeta
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("spec", spec.toJSON()),
            ("issues", .array(issues.map { $0.toJSON() })),
            ("family", family.map { .string($0.rawValue) } ?? .null),
            ("hasMeta", .bool(hasMeta)),
        ]))
    }
}

// JS `\d` and `\b` are ASCII-only; ICU's are Unicode-aware, so spell them out (see GOTCHAS).
private let rangeRegex = try! NSRegularExpression(pattern: "^(-?[0-9]+(?:\\.[0-9]+)?)\\s*-->\\s*(-?[0-9]+(?:\\.[0-9]+)?)$")
private let startsWithSignedDigitRegex = try! NSRegularExpression(pattern: "^-?[0-9]")
private let firstWordRestRegex = try! NSRegularExpression(pattern: "^(\\S+)\\s*(.*)$", options: [.dotMatchesLineSeparators])
private let closedListRegex = try! NSRegularExpression(pattern: "^\\[(.*)\\]$", options: [.dotMatchesLineSeparators])
private let openListRegex = try! NSRegularExpression(pattern: "^\\[(.*)$", options: [.dotMatchesLineSeparators])
private let fmTitleRegex = try! NSRegularExpression(pattern: "^title:\\s*(.+)$")
private let xyHeaderRegex = try! NSRegularExpression(pattern: "^xychart(?:-beta)?(?:\\s+(horizontal|vertical))?\\s*$", options: [.caseInsensitive])
private let pieHeaderRegex = try! NSRegularExpression(pattern: "^pie(\\s+showData)?(?:\\s+title\\s+(.*))?\\s*$", options: [.caseInsensitive])
private let radarHeaderRegex = try! NSRegularExpression(pattern: "^radar(?:-beta)?\\s*$", options: [.caseInsensitive])
private let sankeyHeaderLineRegex = try! NSRegularExpression(pattern: "^sankey(?:-beta)?\\s*$", options: [.caseInsensitive])
private let treemapHeaderLineRegex = try! NSRegularExpression(pattern: "^treemap(?:-beta)?\\s*$", options: [.caseInsensitive])
private let titleStmtRegex = try! NSRegularExpression(pattern: "^title\\s+(.+)$", options: [.caseInsensitive])
private let xAxisStmtRegex = try! NSRegularExpression(pattern: "^x-axis(?![A-Za-z0-9_])(.*)$", options: [.caseInsensitive])
private let yAxisStmtRegex = try! NSRegularExpression(pattern: "^y-axis(?![A-Za-z0-9_])(.*)$", options: [.caseInsensitive])
private let barLineStmtRegex = try! NSRegularExpression(pattern: "^(bar|line)(?![A-Za-z0-9_])(.*)$", options: [.caseInsensitive])
private let pieSliceStmtRegex = try! NSRegularExpression(pattern: "^\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)\\s*$")
private let showDataStmtRegex = try! NSRegularExpression(pattern: "^showData\\s*$", options: [.caseInsensitive])
private let radarAxisStmtRegex = try! NSRegularExpression(pattern: "^axis\\s+(.+)$")
private let radarAxisItemRegex = try! NSRegularExpression(pattern: "^([A-Za-z_][A-Za-z0-9_-]*)\\s*(?:\\[\\s*\"((?:[^\"\\\\]|\\\\.)*)\"\\s*\\])?$")
private let radarCurveStmtRegex = try! NSRegularExpression(pattern: "^curve\\s+([A-Za-z_][A-Za-z0-9_-]*)\\s*(?:\\[\\s*\"((?:[^\"\\\\]|\\\\.)*)\"\\s*\\])?\\s*\\{(.*)\\}?\\s*$")
private let radarCurveKeyedRegex = try! NSRegularExpression(pattern: "^([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)$")
private let radarCurveNumRegex = try! NSRegularExpression(pattern: "^-?[0-9]+(?:\\.[0-9]+)?$")
private let radarSettingStmtRegex = try! NSRegularExpression(pattern: "^(max|min|ticks|graticule|showLegend)\\s+(\\S+)$")
private let trailingCloseBraceRegex = try! NSRegularExpression(pattern: "\\}\\s*$")

private func regexMatch(_ regex: NSRegularExpression, _ text: String) -> [String?]? {
    let ns = text as NSString
    guard let m = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else {
        return nil
    }
    var groups: [String?] = []
    for g in 0..<m.numberOfRanges {
        let r = m.range(at: g)
        if r.location != NSNotFound {
            groups.append(ns.substring(with: r))
        } else {
            groups.append(nil)
        }
    }
    return groups
}

private func takeTitle(_ text: String) -> (title: String?, rest: String) {
    let t = text.jsTrimmed
    if t.hasPrefix("\"") {
        let chars = Array(t)
        var end = -1
        for idx in 1..<chars.count {
            if chars[idx] == "\"" {
                end = idx
                break
            }
        }
        if end > 0 {
            let quotedPart = String(chars[0...end])
            let restPart = (end + 1 < chars.count) ? String(chars[(end + 1)...]).jsTrimmed : ""
            return (title: mermaidUnquote(quotedPart), rest: restPart)
        }
    }
    if t.isEmpty || t.hasPrefix("[") || regexMatch(rangeRegex, t) != nil || regexMatch(startsWithSignedDigitRegex, t) != nil {
        return (title: nil, rest: t)
    }
    if let m = regexMatch(firstWordRestRegex, t), let w = m[1] {
        return (title: w, rest: (m[2] ?? "").jsTrimmed)
    }
    return (title: nil, rest: t)
}

private func parseList(_ text: String, _ partial: Bool) -> [String]? {
    let t = text.jsTrimmed
    var m = regexMatch(closedListRegex, t)
    if m == nil && partial {
        m = regexMatch(openListRegex, t)
    }
    guard let m, let inner = m[1] else { return nil }
    if inner.jsTrimmed.isEmpty { return [] }
    var items = splitOutside(inner, ",").map { $0.jsTrimmed }
    if partial && !t.hasSuffix("]") {
        if let last = items.last {
            let afterFirst = last.hasPrefix("\"") ? String(last.dropFirst()) : ""
            if last.isEmpty || (last.hasPrefix("\"") && !afterFirst.hasSuffix("\"")) {
                items.removeLast()
            }
        }
    }
    return items.map(mermaidUnquote)
}

/// Reads Mermaid `xychart-beta`, `pie`, `radar-beta`, `sankey-beta` or `treemap-beta` text as a chart.
/// Never throws: lines it cannot read are reported with their line numbers and skipped.
public func chartFromMermaid(_ text: String, _ options: ChartMermaidParseOptions = ChartMermaidParseOptions()) -> ChartMermaidResult {
    var issues: [ChartIssue] = []
    let partial = options.partial ?? false
    let stripped = text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
    let all = stripped.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var start = 0
    var frontTitle: String? = nil

    if all.first?.jsTrimmed == "---" {
        if let end = all.enumerated().first(where: { $0.offset > 0 && $0.element.jsTrimmed == "---" })?.offset {
            for l in all[1..<end] {
                if let m = regexMatch(fmTitleRegex, l.jsTrimmed), let rawTitle = m[1] {
                    frontTitle = mermaidUnquote(rawTitle)
                }
            }
            start = end + 1
        }
    }

    var family: ChartMermaidFamily? = nil
    var headerLine = -1
    var horizontal = false
    var showData = false
    var meta: JSONObject? = nil

    for i in start..<all.count {
        let t = all[i].jsTrimmed
        if t.isEmpty || t.hasPrefix("%%") { continue }
        if let m = regexMatch(xyHeaderRegex, t) {
            family = .xychart
            horizontal = (m[1]?.lowercased() == "horizontal")
        } else if let m = regexMatch(pieHeaderRegex, t) {
            family = .pie
            showData = (m[1] != nil)
            if let t2 = m[2], !t2.isEmpty {
                frontTitle = t2.jsTrimmed
            }
        } else if regexMatch(radarHeaderRegex, t) != nil {
            family = .radar
        } else if regexMatch(sankeyHeaderLineRegex, t) != nil {
            family = .sankey
        } else if regexMatch(treemapHeaderLineRegex, t) != nil {
            family = .treemap
        } else {
            issues.append(ChartIssue(
                path: "header",
                message: "Line \(i + 1): expected a chart header (xychart-beta, pie, radar-beta, sankey-beta or treemap-beta), got \"\(t.jsSlice(0, 40))\".",
                line: i + 1
            ))
        }
        headerLine = i
        break
    }

    var title = frontTitle ?? ""
    var categories: [String] = []
    var series: [ChartSeries] = []
    var xAxis = defaultChartAxis(false)
    var yAxis = defaultChartAxis(true)
    var radarAxes: [(id: String, label: String)] = []
    var pieSlices: [(label: String, value: Double)] = []
    var legendShow = true
    var radarTicks: Int? = nil
    var graticule: ChartRadarGraticule = .circle
    var barCount = 0
    var lineCount = 0

    func lineIssue(_ i: Int, _ message: String) {
        issues.append(ChartIssue(path: "line \(i + 1)", message: "Line \(i + 1): \(message)", line: i + 1))
    }

    let whole = (family == .sankey || family == .treemap)
    let metaPrefixTrimmed = CHART_MERMAID_META_PREFIX.jsTrimmed

    if family != nil {
        for i in (headerLine + 1)..<all.count {
            let raw = all[i]
            let t = raw.jsTrimmed
            if t.isEmpty { continue }
            if t.hasPrefix(metaPrefixTrimmed) {
                if options.ignoreMeta == true { continue }
                let jsonText = t.jsSlice(metaPrefixTrimmed.utf16.count).jsTrimmed
                if let parsed = try? JSONValue.parse(jsonText) {
                    if let obj = parsed.objectValue {
                        meta = obj
                    } else {
                        lineIssue(i, "the @pixerate metadata is not a JSON object; it was ignored.")
                    }
                } else {
                    if !partial {
                        lineIssue(i, "the @pixerate metadata is not valid JSON; it was ignored.")
                    }
                }
                continue
            }
            if t.hasPrefix("%%") || whole { continue }
            let isLast = (i == all.count - 1) || all[(i + 1)...].allSatisfy { $0.jsTrimmed.isEmpty }

            if let m = regexMatch(titleStmtRegex, t), let rawT = m[1] {
                title = mermaidUnquote(rawT)
                continue
            }

            if family == .xychart {
                if let m = regexMatch(xAxisStmtRegex, t) {
                    let (xt, rest) = takeTitle(m[1] ?? "")
                    if let xt, !xt.isEmpty { xAxis.title = xt }
                    if let list = parseList(rest, partial && isLast) {
                        categories = list
                    } else if let r = regexMatch(rangeRegex, rest), let r1 = r[1], let r2 = r[2] {
                        xAxis.min = r1.jsToNumber
                        xAxis.max = r2.jsToNumber
                    } else if !rest.isEmpty {
                        lineIssue(i, "expected x-axis [a, b, …] or a range \"min --> max\", got \"\(rest.jsSlice(0, 40))\".")
                    }
                    continue
                }
                if let m = regexMatch(yAxisStmtRegex, t) {
                    let (yt, rest) = takeTitle(m[1] ?? "")
                    if let yt, !yt.isEmpty { yAxis.title = yt }
                    if let r = regexMatch(rangeRegex, rest), let r1 = r[1], let r2 = r[2] {
                        yAxis.min = r1.jsToNumber
                        yAxis.max = r2.jsToNumber
                    } else if !rest.isEmpty {
                        lineIssue(i, "expected y-axis \"min --> max\", got \"\(rest.jsSlice(0, 40))\".")
                    }
                    continue
                }
                if let m = regexMatch(barLineStmtRegex, t), let rawKind = m[1] {
                    let kindStr = rawKind.lowercased()
                    let isBar = (kindStr == "bar")
                    let (st, rest) = takeTitle(m[2] ?? "")
                    guard let list = parseList(rest, partial && isLast) else {
                        if !(partial && isLast) {
                            lineIssue(i, "expected \(kindStr) [1, 2, 3], got \"\(rest.jsSlice(0, 40))\".")
                        }
                        continue
                    }
                    let values: [ChartValue] = list.map { x in
                        x.jsTrimmed.isEmpty ? nil : x.jsToNumber
                    }
                    if values.contains(where: { $0 != nil && !$0!.isFinite }) {
                        lineIssue(i, "\(kindStr) values must be numbers.")
                        continue
                    }
                    let defaultName: String
                    if isBar {
                        barCount += 1
                        defaultName = "Bar \(barCount)"
                    } else {
                        lineCount += 1
                        defaultName = "Line \(lineCount)"
                    }
                    series.append(ChartSeries(
                        id: "series-\(series.count + 1)",
                        name: st ?? defaultName,
                        values: values,
                        type: isBar ? .bar : .line
                    ))
                    continue
                }
            } else if family == .pie {
                if let m = regexMatch(pieSliceStmtRegex, t), let rawLabel = m[1], let rawVal = m[2] {
                    pieSlices.append((
                        label: rawLabel.replacingOccurrences(of: "#quot;", with: "\""),
                        value: rawVal.jsToNumber
                    ))
                    continue
                }
                if regexMatch(showDataStmtRegex, t) != nil {
                    showData = true
                    continue
                }
            } else if family == .radar {
                if let m = regexMatch(radarAxisStmtRegex, t), let axisList = m[1] {
                    for part in splitOutside(axisList, ",") {
                        let pt = part.jsTrimmed
                        if let a = regexMatch(radarAxisItemRegex, pt), let id = a[1] {
                            radarAxes.append((id: id, label: a[2] ?? id))
                        } else {
                            lineIssue(i, "could not read the axis \"\(pt)\".")
                        }
                    }
                    continue
                }
                if let m = regexMatch(radarCurveStmtRegex, t), let curveId = m[1], let rawBody = m[3] {
                    let nsBody = rawBody as NSString
                    let body = trailingCloseBraceRegex.stringByReplacingMatches(
                        in: rawBody,
                        range: NSRange(location: 0, length: nsBody.length),
                        withTemplate: ""
                    )
                    let entries = !body.jsTrimmed.isEmpty
                        ? splitOutside(body, ",").map { $0.jsTrimmed }.filter { !$0.isEmpty }
                        : []
                    let ids = radarAxes.map { $0.id }
                    var values: [ChartValue] = Array(repeating: nil, count: ids.count)
                    var k = 0
                    for e in entries {
                        if let keyed = regexMatch(radarCurveKeyedRegex, e), let kId = keyed[1], let kVal = keyed[2] {
                            if let at = ids.firstIndex(of: kId) {
                                values[at] = kVal.jsToNumber
                            } else {
                                lineIssue(i, "curve \(curveId) names an unknown axis \"\(kId)\".")
                            }
                        } else if regexMatch(radarCurveNumRegex, e) != nil {
                            let numVal = e.jsToNumber
                            if k < values.count {
                                values[k] = numVal
                            } else {
                                values.append(numVal)
                            }
                            k += 1
                        } else {
                            lineIssue(i, "could not read \"\(e)\" in curve \(curveId).")
                        }
                    }
                    series.append(ChartSeries(id: curveId, name: m[2] ?? curveId, values: values))
                    continue
                }
                if let m = regexMatch(radarSettingStmtRegex, t), let key = m[1], let val = m[2] {
                    if key == "max" {
                        yAxis.max = val.jsToNumber
                    } else if key == "min" {
                        yAxis.min = val.jsToNumber
                    } else if key == "showLegend" {
                        legendShow = (val != "false")
                    } else if key == "ticks" {
                        let n = val.jsToNumber
                        if n.isFinite && n >= 1 {
                            radarTicks = Int(Swift.min(50, JS.round(n)))
                        } else {
                            lineIssue(i, "expected ticks to be a number of rings (1 or more), got \"\(val)\".")
                        }
                    } else if val == "circle" {
                        graticule = .circle
                    } else if val == "polygon" {
                        graticule = .polygon
                    } else {
                        lineIssue(i, "expected graticule circle or polygon, got \"\(val)\".")
                    }
                    continue
                }
            }

            if !(partial && isLast) {
                lineIssue(i, "could not read \"\(t.jsSlice(0, 60))\"; it was skipped.")
            }
        }
    }

    var input = JSONObject()
    if whole, let fam = family {
        input = readWholeMermaid(fam, all: all, headerLine: headerLine, partial: partial, title: title, issues: &issues)
    } else if family == .pie {
        input["type"] = .string("pie")
        input["title"] = .string(title)
        input["dataLabels"] = .bool(showData)
        input["categories"] = .array(pieSlices.map { .string($0.label) })
        let s1 = JSONObject([
            ("id", .string("series-1")),
            ("name", .string(title.isEmpty ? "Values" : title)),
            ("values", .array(pieSlices.map { .number($0.value) })),
        ])
        input["series"] = .array([.object(s1)])
    } else if family == .radar {
        input["type"] = .string("radar")
        input["title"] = .string(title)
        input["categories"] = .array(radarAxes.map { .string($0.label) })
        input["series"] = .array(series.map { $0.toJSON() })
        input["yAxis"] = yAxis.toJSON()
        input["legend"] = ChartLegend(show: legendShow, position: .bottom).toJSON()
        input["radarTicks"] = radarTicks.map { .number(Double($0)) } ?? .null
        input["radarGraticule"] = .string(graticule.rawValue)
    } else {
        let allBar = !series.isEmpty && series.allSatisfy { $0.type == .bar }
        let allLine = !series.isEmpty && series.allSatisfy { $0.type == .line }
        let cType: ChartType = allLine ? .line : .bar
        let cSeriesType: ChartSeriesType = allLine ? .line : .bar
        let longest = series.map { $0.values.count }.max() ?? 0
        let cats = !categories.isEmpty ? categories : (0..<longest).map { "\($0 + 1)" }
        let cleanedSeries: [ChartSeries] = series.map { s in
            if allBar || allLine || s.type == cSeriesType {
                var copy = s
                copy.type = nil
                return copy
            }
            return s
        }
        input["type"] = .string(cType.rawValue)
        input["title"] = .string(title)
        input["orientation"] = .string(horizontal ? "horizontal" : "vertical")
        input["categories"] = .array(cats.map(JSONValue.string))
        input["xAxis"] = xAxis.toJSON()
        input["yAxis"] = yAxis.toJSON()
        input["series"] = .array(cleanedSeries.map { $0.toJSON() })
    }

    if let meta {
        let metaSeries = meta["series"]?.arrayValue
        for (k, v) in meta {
            if k == "v" || k == "series" { continue }
            input[k] = v
        }
        if let metaSeries {
            let baseSeries = input["series"]?.arrayValue ?? []
            var mergedSeries: [JSONValue] = []
            for (i, extraVal) in metaSeries.enumerated() {
                var merged = (i < baseSeries.count ? baseSeries[i].objectValue : nil) ?? JSONObject()
                if let extraObj = extraVal.objectValue {
                    for (ek, ev) in extraObj {
                        merged[ek] = ev
                    }
                }
                mergedSeries.append(.object(merged))
            }
            input["series"] = .array(mergedSeries)
        }
    }

    let normalized = normalizeChartSpec(.object(input))
    if family == nil && !partial && issues.isEmpty {
        issues.append(ChartIssue(
            path: "header",
            message: "The text is empty: expected a chart header (xychart-beta, pie, radar-beta, sankey-beta or treemap-beta)."
        ))
    }
    return ChartMermaidResult(
        spec: normalized.spec,
        issues: issues + normalized.issues,
        family: family,
        hasMeta: meta != nil
    )
}

private func readWholeMermaid(
    _ family: ChartMermaidFamily,
    all: [String],
    headerLine: Int,
    partial: Bool,
    title: String,
    issues: inout [ChartIssue]
) -> JSONObject {
    let metaPrefixTrimmed = CHART_MERMAID_META_PREFIX.jsTrimmed
    let body: [String] = Array(all[headerLine...]).map { l in
        l.jsTrimmed.hasPrefix(metaPrefixTrimmed) ? "%%" : l
    }

    if family == .sankey {
        var read = parseSankey(body.joined(separator: "\n"))
        if case .error = read, partial && body.count > 1 {
            read = parseSankey(body.dropLast().joined(separator: "\n"))
        }
        switch read {
        case .error(let err):
            let line = err.line.map { $0 + headerLine }
            if !(partial && body.count <= 2) {
                issues.append(ChartIssue(
                    path: "sankey",
                    message: line.map { "Line \($0): \(err.error)" } ?? err.error,
                    line: line
                ))
            }
            return JSONObject([
                ("type", .string("sankey")),
                ("title", .string(title)),
            ])
        case .data(let data):
            let s1 = JSONObject([
                ("id", .string("series-1")),
                ("name", .string("Values")),
                ("values", .array([])),
            ])
            return JSONObject([
                ("type", .string("sankey")),
                ("title", .string(title)),
                ("links", .array(data.links.map { $0.toJSON() })),
                ("sankeyNodes", .array(data.nodes.map(JSONValue.string))),
                ("series", .array([.object(s1)])),
            ])
        }
    } else {
        var read = parseTreemap(body.joined(separator: "\n"))
        if case .error = read, partial && body.count > 1 {
            read = parseTreemap(body.dropLast().joined(separator: "\n"))
        }
        switch read {
        case .error(let err):
            let line = err.line.map { $0 + headerLine }
            if !(partial && body.count <= 2) {
                issues.append(ChartIssue(
                    path: "treemap",
                    message: line.map { "Line \($0): \(err.error)" } ?? err.error,
                    line: line
                ))
            }
            return JSONObject([
                ("type", .string("treemap")),
                ("title", .string(title)),
            ])
        case .data(let data):
            var items = data.items
            var name = data.title ?? title
            if items.count == 1, let firstChildren = items[0].children, !firstChildren.isEmpty {
                if name.isEmpty { name = items[0].name }
                items = firstChildren
            }
            func toNode(_ item: TreemapItem) -> ChartTreeNode {
                if let children = item.children, !children.isEmpty {
                    return ChartTreeNode(name: item.name, children: children.map(toNode))
                }
                return ChartTreeNode(name: item.name, value: item.value ?? 0)
            }
            let tree = items.map(toNode)
            func isLeaf(_ n: ChartTreeNode) -> Bool { n.children == nil }
            let flatOrOneLevel = tree.allSatisfy(isLeaf) || tree.allSatisfy { $0.children?.allSatisfy(isLeaf) == true }
            let s1 = JSONObject([
                ("id", .string("series-1")),
                ("name", .string("Values")),
                ("values", .array(tree.map { .number(chartTreeTotal($0)) })),
            ])
            return JSONObject([
                ("type", .string(flatOrOneLevel ? "treemap" : "sunburst")),
                ("title", .string(name)),
                ("tree", .array(tree.map { $0.toJSON() })),
                ("categories", .array(tree.map { .string($0.name) })),
                ("series", .array([.object(s1)])),
            ])
        }
    }
}

public struct FoundChartMermaid: Sendable, Equatable {
    public var source: String
    public var family: ChartMermaidFamily
    /// 1-based line where the block starts in the input.
    public var line: Int

    public init(source: String, family: ChartMermaidFamily, line: Int) {
        self.source = source
        self.family = family
        self.line = line
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("source", .string(source)),
            ("family", .string(family.rawValue)),
            ("line", .number(Double(line))),
        ]))
    }
}

// JS `\s` also matches \v and the BOM (U+FEFF); ICU's does not.
private let findXyHeaderRegex = try! NSRegularExpression(pattern: "^[\\s\\x{0B}\\x{FEFF}]*xychart(-beta)?(?![A-Za-z0-9_])")
private let findPieHeaderRegex = try! NSRegularExpression(pattern: "^[\\s\\x{0B}\\x{FEFF}]*pie(?![A-Za-z0-9_])")
private let findRadarHeaderRegex = try! NSRegularExpression(pattern: "^[\\s\\x{0B}\\x{FEFF}]*radar(-beta)?(?![A-Za-z0-9_])")
private let findSankeyHeaderRegex = try! NSRegularExpression(pattern: "^[\\s\\x{0B}\\x{FEFF}]*sankey(-beta)?\\s*$")
private let findTreemapHeaderRegex = try! NSRegularExpression(pattern: "^[\\s\\x{0B}\\x{FEFF}]*treemap(-beta)?\\s*$")
private let openFenceRegex = try! NSRegularExpression(pattern: "^ {0,3}(`{3,}|~{3,})\\s*([A-Za-z0-9_-]*)")

private func jsTrimEnd(_ s: String) -> String {
    let scalars = Array(s.unicodeScalars)
    var end = scalars.count
    while end > 0 && isJSWhitespace(scalars[end - 1]) {
        end -= 1
    }
    var out = String.UnicodeScalarView()
    out.append(contentsOf: scalars[0..<end])
    return String(out)
}

/// Finds Mermaid charts in Markdown or chat text: fenced ```mermaid blocks (and unlabelled
/// fences) whose header is xychart-beta, pie, radar-beta, sankey-beta or treemap-beta, else the whole text when it is one.
public func findMermaidCharts(_ text: String) -> [FoundChartMermaid] {
    let stripped = text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
    let lines = stripped.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var found: [FoundChartMermaid] = []

    func familyOf(_ body: String) -> ChartMermaidFamily? {
        var rows = body.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        if let firstRow = rows.firstIndex(where: { !$0.jsTrimmed.isEmpty }) {
            if rows[firstRow].jsTrimmed == "---" {
                if let end = rows.enumerated().first(where: { $0.offset > firstRow && $0.element.jsTrimmed == "---" })?.offset {
                    rows = Array(rows[(end + 1)...])
                }
            }
        }
        guard let header = rows.first(where: { !$0.jsTrimmed.isEmpty && !$0.jsTrimmed.hasPrefix("%%") }) else {
            return nil
        }
        if regexMatch(findXyHeaderRegex, header) != nil { return .xychart }
        if regexMatch(findPieHeaderRegex, header) != nil { return .pie }
        if regexMatch(findRadarHeaderRegex, header) != nil { return .radar }
        if regexMatch(findSankeyHeaderRegex, header) != nil { return .sankey }
        if regexMatch(findTreemapHeaderRegex, header) != nil { return .treemap }
        return nil
    }

    var i = 0
    while i < lines.count {
        guard let open = regexMatch(openFenceRegex, lines[i]),
              let fence = open[1] else {
            i += 1
            continue
        }
        let info = (open[2] ?? "").lowercased()
        let fenceChar = fence.first!
        let fenceLen = fence.count
        let closeRegex = try! NSRegularExpression(pattern: "^ {0,3}\(fenceChar){\(fenceLen),}\\s*$")
        var end = i + 1
        while end < lines.count && regexMatch(closeRegex, lines[end]) == nil {
            end += 1
        }
        let body = lines[(i + 1)..<end].joined(separator: "\n")
        if info.isEmpty || info == "mermaid" {
            if let family = familyOf(body) {
                found.append(FoundChartMermaid(source: "\(jsTrimEnd(body))\n", family: family, line: i + 2))
            }
        }
        i = end + 1
    }

    if found.isEmpty {
        if let family = familyOf(text) {
            found.append(FoundChartMermaid(source: "\(text.jsTrimmed)\n", family: family, line: 1))
        }
    }
    return found
}
