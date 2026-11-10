// The xychart-beta, pie and radar-beta grammars follow Ursula's statement adapters (src/xychart, src/pie,
// src/radar), and the metadata comment follows its `%% @ursula` line (src/source/metadata.ts).
import Foundation
import PixerateCore

internal extension String {
    func jsSlice(_ start: Int, _ end: Int? = nil) -> String {
        let units = Array(utf16)
        let n = units.count
        let s = start < 0 ? Swift.max(0, n + start) : Swift.min(n, start)
        let e: Int
        if let end {
            e = end < 0 ? Swift.max(0, n + end) : Swift.min(n, end)
        } else {
            e = n
        }
        guard s < e else { return "" }
        return String(utf16CodeUnits: Array(units[s..<e]), count: e - s)
    }
}

/// The comment line that carries what Mermaid cannot express. Every Mermaid tool ignores `%%` comments.
public let CHART_MERMAID_META_PREFIX = "%% @pixerate "

public enum ChartMermaidFamily: String, CaseIterable, Sendable, Equatable {
    case xychart
    case pie
    case radar
    case sankey
    case treemap
}

public struct ChartMermaidOptions: Sendable, Equatable {
    /// Write the `%% @pixerate {…}` line so the chart round-trips exactly (default `true`).
    public var meta: Bool?
    /// Indentation of statements (default four spaces).
    public var indent: String?

    public init(meta: Bool? = nil, indent: String? = nil) {
        self.meta = meta
        self.indent = indent
    }
}

internal func mermaidQuote(_ text: String) -> String {
    return "\"\(text.jsReplacingAll("\"", with: "#quot;"))\""
}

internal func mermaidUnquote(_ text: String) -> String {
    let t = text.jsTrimmed
    let inner: String
    if t.count >= 2 && t.hasPrefix("\"") && t.hasSuffix("\"") {
        inner = String(t.dropFirst().dropLast())
    } else {
        inner = t
    }
    return inner.replacingOccurrences(of: "#quot;", with: "\"")
}

private func isAsciiWordChar(_ scalar: Unicode.Scalar) -> Bool {
    let v = scalar.value
    return (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A) || (v >= 0x30 && v <= 0x39) || v == 0x5F
}

internal func mermaidWord(_ text: String) -> String {
    if !text.isEmpty && text.unicodeScalars.allSatisfy(isAsciiWordChar) {
        return text
    }
    return mermaidQuote(text)
}

internal func mermaidNum(_ value: Double) -> String {
    if value.isFinite && floor(value) == value {
        return JSONValue.jsNumber(value)
    }
    return JSONValue.jsNumber(jsToPrecision(value, 10).jsToNumber)
}

/// Splits on `sep` outside quotes and brackets.
internal func splitOutside(_ text: String, _ sep: Character) -> [String] {
    var out: [String] = []
    var cur = ""
    var quoted = false
    var depth = 0
    for ch in text {
        if ch == "\"" {
            quoted.toggle()
        } else if !quoted && (ch == "[" || ch == "{") {
            depth += 1
        } else if !quoted && (ch == "]" || ch == "}") {
            depth -= 1
        }
        if ch == sep && !quoted && depth == 0 {
            out.append(cur)
            cur = ""
        } else {
            cur.append(ch)
        }
    }
    out.append(cur)
    return out
}

/// A sankey-beta CSV field: quoted (with `""` for a quote) when it holds a comma, quote or edge spaces.
private func csvField(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    let hasEdgeSpace = (!scalars.isEmpty && (isJSWhitespace(scalars.first!) || isJSWhitespace(scalars.last!)))
    let needsQuote = hasEdgeSpace || text.jsIncludes("\"") || text.jsIncludes(",") || text.jsIncludes("\n")
    if needsQuote {
        return "\"\(text.jsReplacingAll("\"", with: "\"\""))\""
    }
    return text
}

/// A treemap-beta name: in double quotes, or single quotes when it holds a double quote.
private func treemapName(_ name: String) -> String {
    if !name.contains("\"") {
        return "\"\(name)\""
    }
    if !name.contains("'") {
        return "'\(name)'"
    }
    return "\"\(name.replacingOccurrences(of: "\"", with: "'"))\""
}

private let yamlSafeRegex = try! NSRegularExpression(pattern: "^[A-Za-z0-9_][A-Za-z0-9_ .,!?()/&+-]*$")
private let yamlColonSpaceRegex = try! NSRegularExpression(pattern: ":\\s")
private let slugReplaceRegex = try! NSRegularExpression(pattern: "[^A-Za-z0-9_-]+")

/// A frontmatter value, quoted when YAML would read it as something else.
private func yamlText(_ text: String) -> String {
    let ns = text as NSString
    let full = NSRange(location: 0, length: ns.length)
    let safe = yamlSafeRegex.firstMatch(in: text, range: full) != nil
        && yamlColonSpaceRegex.firstMatch(in: text, range: full) == nil
    return safe ? text : JSONValue.string(text).stringified()
}

/// The Mermaid family a chart is written as.
public func chartMermaidFamily(_ spec: ChartSpec) -> ChartMermaidFamily {
    let family = chartFamily(spec)
    if family == .sankey && !spec.links.isEmpty { return .sankey }
    if family == .treemap || family == .sunburst { return .treemap }
    if family == .pie || family == .funnel || family == .parliament { return .pie }
    if family == .radar { return .radar }
    return .xychart
}

private func slug(_ label: String, _ i: Int, _ taken: inout Set<String>) -> String {
    let nfkd = label.decomposedStringWithCompatibilityMapping
    let ns = nfkd as NSString
    var base = slugReplaceRegex.stringByReplacingMatches(
        in: nfkd,
        range: NSRange(location: 0, length: ns.length),
        withTemplate: "_"
    )
    while base.hasPrefix("_") { base.removeFirst() }
    while base.hasSuffix("_") { base.removeLast() }
    if base.isEmpty { base = "a\(i + 1)" }
    if let first = base.unicodeScalars.first {
        let isLetterOrUnderscore = (first.value >= 0x41 && first.value <= 0x5A)
            || (first.value >= 0x61 && first.value <= 0x7A)
            || first.value == 0x5F
        if !isLetterOrUnderscore {
            base = "a_\(base)"
        }
    }
    var id = base
    var k = 2
    while taken.contains(id) {
        id = "\(base)_\(k)"
        k += 1
    }
    taken.insert(id)
    return id
}

/// Fields that differ from what the Mermaid text alone would give, for the metadata line.
private func metaFor(_ spec: ChartSpec, _ text: String) -> JSONObject? {
    let base = chartFromMermaid(text, ChartMermaidParseOptions(ignoreMeta: true)).spec
    guard let specObj = spec.toJSON().objectValue,
          let baseObj = base.toJSON().objectValue else { return nil }
    var meta = JSONObject()
    for (key, specVal) in specObj {
        if key == "series" || key == "version" { continue }
        if specVal.stringified() != baseObj[key]?.stringified() {
            meta[key] = specVal
        }
    }
    var seriesArr: [JSONValue] = []
    var anySeriesDiff = false
    for (i, s) in spec.series.enumerated() {
        let b = i < base.series.count ? base.series[i] : nil
        let sObj = s.toJSON().objectValue ?? JSONObject()
        let bObj = b?.toJSON().objectValue
        var out = JSONObject()
        for (k, v) in sObj {
            if k == "values" {
                if let bObj, v.stringified() != bObj["values"]?.stringified() {
                    out["values"] = v
                }
                continue
            }
            if bObj == nil || v.stringified() != bObj?[k]?.stringified() {
                out[k] = v
            }
        }
        if !out.isEmpty { anySeriesDiff = true }
        seriesArr.append(.object(out))
    }
    if anySeriesDiff || spec.series.count != base.series.count {
        meta["series"] = .array(seriesArr)
    }
    return meta.isEmpty ? nil : meta
}

/// Writes a chart as Mermaid (`xychart-beta`, `pie`, `radar-beta`, `sankey-beta`, or `treemap-beta`),
/// with an optional `%% @pixerate {…}` comment for lossless round-tripping.
public func chartToMermaid(_ spec: ChartSpec, _ options: ChartMermaidOptions = ChartMermaidOptions()) -> String {
    let ind = options.indent ?? "    "
    let family = chartMermaidFamily(spec)
    let visible = spec.series.filter { $0.hidden != true }
    var lines: [String] = []
    func fmtVal(_ x: ChartValue) -> String {
        guard let x, x.isFinite else { return "0" }
        return mermaidNum(x)
    }
    var front: [String] = []
    switch family {
    case .sankey:
        if !spec.title.isEmpty {
            front.append(contentsOf: ["---", "title: \(yamlText(spec.title))", "---"])
        }
        lines.append("sankey-beta")
        for l in spec.links {
            lines.append("\(csvField(l.source)),\(csvField(l.target)),\(mermaidNum(l.value))")
        }
    case .treemap:
        lines.append("treemap-beta")
        if !spec.title.isEmpty {
            lines.append("title \(spec.title)")
        }
        let first = visible.first ?? spec.series.first
        let tree = !spec.tree.isEmpty ? spec.tree : chartTreeFromSeries(spec.categories, first?.values ?? [])
        func writeNodes(_ nodes: [ChartTreeNode], _ depth: Int) {
            let pad = String(repeating: ind, count: depth)
            for n in nodes {
                if let children = n.children {
                    lines.append("\(pad)\(treemapName(n.name))")
                    writeNodes(children, depth + 1)
                } else {
                    lines.append("\(pad)\(treemapName(n.name)): \(mermaidNum(n.value ?? 0))")
                }
            }
        }
        writeNodes(tree, 1)
    case .pie:
        let s = visible.first ?? spec.series.first
        lines.append("pie\(spec.dataLabels ? " showData" : "")")
        if !spec.title.isEmpty {
            lines.append("\(ind)title \(spec.title)")
        }
        for (i, c) in spec.categories.enumerated() {
            let value = (s != nil && i < s!.values.count) ? s!.values[i] : nil
            if let value, value.isFinite && value > 0 {
                lines.append("\(ind)\(mermaidQuote(c)) : \(mermaidNum(value))")
            }
        }
    case .radar:
        lines.append("radar-beta")
        if !spec.title.isEmpty {
            lines.append("\(ind)title \(spec.title)")
        }
        var taken = Set<String>()
        let ids = spec.categories.enumerated().map { i, c in slug(c, i, &taken) }
        let axisItems = ids.enumerated().map { i, id in
            let cat = spec.categories[i]
            return id == cat ? id : "\(id)[\"\(cat.replacingOccurrences(of: "\"", with: "'"))\"]"
        }.joined(separator: ", ")
        lines.append("\(ind)axis \(axisItems)")
        var seriesTaken = Set<String>(ids)
        for (i, s) in spec.series.enumerated() {
            let id = slug(s.id, i, &seriesTaken)
            let vals = s.values.map(fmtVal).joined(separator: ", ")
            lines.append("\(ind)curve \(id)[\"\(s.name.replacingOccurrences(of: "\"", with: "'"))\"]{\(vals)}")
        }
        if let maxVal = spec.yAxis.max {
            lines.append("\(ind)max \(mermaidNum(maxVal))")
        }
        if let minVal = spec.yAxis.min {
            lines.append("\(ind)min \(mermaidNum(minVal))")
        }
        if let ticks = spec.radarTicks {
            lines.append("\(ind)ticks \(ticks)")
        }
        if spec.radarGraticule == .polygon {
            lines.append("\(ind)graticule polygon")
        }
        if !spec.legend.show {
            lines.append("\(ind)showLegend false")
        }
    case .xychart:
        lines.append("xychart-beta\(spec.orientation == .horizontal ? " horizontal" : "")")
        if !spec.title.isEmpty {
            lines.append("\(ind)title \(mermaidQuote(spec.title))")
        }
        let xTitle = !spec.xAxis.title.isEmpty ? " \(mermaidQuote(spec.xAxis.title))" : ""
        lines.append("\(ind)x-axis\(xTitle) [\(spec.categories.map(mermaidWord).joined(separator: ", "))]")
        let y = spec.yAxis
        if !y.title.isEmpty || y.min != nil || y.max != nil {
            var out = "\(ind)y-axis"
            if !y.title.isEmpty {
                out += " \(mermaidQuote(y.title))"
            }
            if y.min != nil || y.max != nil {
                let all = spec.series.flatMap { $0.values }.compactMap { $0 }.filter { $0.isFinite }
                let lo = y.min ?? ([0.0] + all).min()!
                let hi = y.max ?? ([lo + 1.0] + all).max()!
                out += " \(mermaidNum(lo)) --> \(mermaidNum(hi))"
            }
            lines.append(out)
        }
        for s in spec.series {
            let sType = s.type ?? (spec.type == .bar ? .bar : .line)
            let kind = sType == .bar ? "bar" : "line"
            lines.append("\(ind)\(kind) \(mermaidQuote(s.name)) [\(s.values.map(fmtVal).joined(separator: ", "))]")
        }
    }
    var text = "\((front + lines).joined(separator: "\n"))\n"
    if options.meta != false {
        if let meta = metaFor(spec, text), let header = lines.first {
            var fullMeta = JSONObject()
            fullMeta["v"] = .number(1)
            for (k, v) in meta {
                fullMeta[k] = v
            }
            let metaLine = "\(CHART_MERMAID_META_PREFIX)\(JSONValue.object(fullMeta).stringified())"
            let rest = Array(lines.dropFirst())
            text = "\((front + [header, metaLine] + rest).joined(separator: "\n"))\n"
        }
    }
    return text
}
