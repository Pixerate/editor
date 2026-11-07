import Foundation
import PixerateCore
import PixerateRaster

public struct ChartAxisSummary: Sendable, Equatable {
    public var min: Double
    public var max: Double
    public var ticks: [Double]
    public var logBase: Double?
    public var reversed: Bool?

    public init(min: Double, max: Double, ticks: [Double], logBase: Double? = nil, reversed: Bool? = nil) {
        self.min = min
        self.max = max
        self.ticks = ticks
        self.logBase = logBase
        self.reversed = reversed
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("min", .number(min)),
            ("max", .number(max)),
            ("ticks", .array(ticks.map(JSONValue.number)))
        ])
        if let logBase { obj["logBase"] = .number(logBase) }
        if let reversed { obj["reversed"] = .bool(reversed) }
        return .object(obj)
    }
}

public struct ChartSummary: Sendable, Equatable {
    public var type: ChartType
    public var title: String
    public var categories: Int
    public var series: [ChartSeriesSummary]
    public var valueAxis: ChartAxisSummary?
    public var secondaryAxis: ChartAxisSummary?
    public var xAxis: ChartAxisSummary?
    public var warnings: [ChartWarning]
    public var colors: ChartColorCheck
    public var description: String

    public init(
        type: ChartType,
        title: String,
        categories: Int,
        series: [ChartSeriesSummary],
        valueAxis: ChartAxisSummary? = nil,
        secondaryAxis: ChartAxisSummary? = nil,
        xAxis: ChartAxisSummary? = nil,
        warnings: [ChartWarning],
        colors: ChartColorCheck,
        description: String
    ) {
        self.type = type
        self.title = title
        self.categories = categories
        self.series = series
        self.valueAxis = valueAxis
        self.secondaryAxis = secondaryAxis
        self.xAxis = xAxis
        self.warnings = warnings
        self.colors = colors
        self.description = description
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("type", .string(type.rawValue)),
            ("title", .string(title)),
            ("categories", .number(Double(categories))),
            ("series", .array(series.map { $0.toJSON() }))
        ])
        if let valueAxis { obj["valueAxis"] = valueAxis.toJSON() }
        if let secondaryAxis { obj["secondaryAxis"] = secondaryAxis.toJSON() }
        if let xAxis { obj["xAxis"] = xAxis.toJSON() }
        obj["warnings"] = .array(warnings.map { $0.toJSON() })
        obj["colors"] = .object(JSONObject([
            ("ok", .bool(colors.ok)),
            ("issues", .array(colors.issues.map(JSONValue.string)))
        ]))
        obj["description"] = .string(description)
        return .object(obj)
    }
}

public func summarizeChart(
    _ spec: ChartSpec,
    width: Double = 640,
    height: Double = 400,
    measureText: ChartTextMeasure? = nil,
    scene: ChartScene? = nil
) -> ChartSummary {
    let resolvedScene = scene ?? layoutChart(spec, ChartLayoutOptions(width: width, height: height, selection: nil, measureText: measureText))
    let visible = spec.series.filter { !($0.hidden ?? false) }
    let series = visible.map { summarizeChartSeries($0, spec.categories) }
    let colors: [String]
    if chartSpecColorsByCategory(spec) {
        colors = spec.categories.enumerated().map { i, _ in
            if let first = visible.first,
               let pc = first.pointColors,
               i < pc.count,
               let own = pc[i], !own.isEmpty {
                return own
            }
            return chartSliceColor(spec, i)
        }
    } else {
        colors = visible.map { s in
            let idx = spec.series.firstIndex(of: s) ?? 0
            return chartSeriesColor(spec, idx)
        }
    }
    let surface = resolvedScene.theme.surface.hasPrefix("var(") ? "#ffffff" : resolvedScene.theme.surface
    let check = checkChartColors(colors, surface: surface)
    func axis(_ s: ChartValueScale?, _ a: ChartAxis) -> ChartAxisSummary? {
        guard let s else { return nil }
        return ChartAxisSummary(
            min: s.domain.0,
            max: s.domain.1,
            ticks: s.ticks,
            logBase: (s.logBase != nil && s.logBase != 0) ? s.logBase : nil,
            reversed: (a.reverse == true) ? true : nil
        )
    }
    return ChartSummary(
        type: spec.type,
        title: spec.title,
        categories: spec.categories.count,
        series: series,
        valueAxis: axis(resolvedScene.valueScale, spec.yAxis),
        secondaryAxis: axis(resolvedScene.valueScale2, spec.yAxis2),
        xAxis: axis(resolvedScene.xScale, spec.xAxis),
        warnings: resolvedScene.warnings,
        colors: check,
        description: describeChart(spec, series)
    )
}

private func isWaterfallTotalCategory(_ label: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: "\\b(sub)?total\\b", options: [.caseInsensitive]) else {
        return false
    }
    let range = NSRange(label.startIndex..<label.endIndex, in: label)
    return regex.firstMatch(in: label, options: [], range: range) != nil
}

/// A plain-language description of a chart: type, what it compares, ranges and notable extremes.
public func describeChart(_ spec: ChartSpec, _ seriesInput: [ChartSeriesSummary]? = nil) -> String {
    let series = seriesInput ?? spec.series.filter { !($0.hidden ?? false) }.map { summarizeChartSeries($0, spec.categories) }
    let kind = (CHART_TYPE_LABELS[spec.type] ?? spec.type.rawValue).lowercased()
    var parts: [String] = []
    let family = chartFamily(spec)
    let format = spec.yAxis.format
    func fmt(_ v: Double?) -> String {
        guard let v else { return "blank" }
        return formatChartNumber(v, format)
    }
    let head = !spec.title.isEmpty ? "\(spec.title): a \(kind) chart" : "A \(kind) chart"
    if series.isEmpty || series.allSatisfy({ $0.count == 0 }) {
        return "\(head) with no data."
    }
    if family == .pie || family == .funnel || family == .treemap || family == .sunburst {
        let s = series[0]
        let total = s.sum ?? 0
        func share(_ v: Double?) -> String {
            guard total != 0, let v else { return "" }
            return " (\(Int(JS.round((v / total) * 100)))%)"
        }
        parts.append("\(head) of \(s.name) across \(spec.categories.count) categories, totalling \(fmt(s.sum)).")
        parts.append("The largest is \(s.maxAt ?? "null") at \(fmt(s.max))\(share(s.max)); the smallest is \(s.minAt ?? "null") at \(fmt(s.min))\(share(s.min)).")
        if !spec.tree.isEmpty {
            let depth = chartTreeDepth(spec.tree)
            let items = chartTreeToRows(spec.tree).count
            parts.append("The data is grouped \(depth) level\(depth == 1 ? "" : "s") deep with \(items) item\(items == 1 ? "" : "s").")
        }
        return parts.joined(separator: " ")
    }
    if family == .choropleth {
        let s = spec.series.first(where: { !($0.hidden ?? false) })!
        let map = getChartMap(spec.map)
        let matches: [ChartMapRegion?] = map.map { matchChartMapRegions($0, spec.categories) } ?? spec.categories.map { _ in nil }
        var rows: [(name: String, v: Double)] = []
        for (i, _) in spec.categories.enumerated() {
            if let region = matches[i], i < s.values.count, let val = s.values[i] {
                rows.append((name: region.name, v: val))
            }
        }
        rows.sort { $0.v > $1.v }
        let missing = spec.categories.indices.filter { matches[$0] == nil }.count
        let mapName = map?.name ?? spec.map
        if rows.isEmpty {
            return "\(head) of \(mapName) with no regions matched."
        }
        let missingSuffix = missing > 0 ? " \(missing) categor\(missing == 1 ? "y names" : "ies name") no region." : ""
        return "\(head) of \(mapName) shading \(rows.count) region\(rows.count == 1 ? "" : "s") by \(s.name): highest \(rows[0].name) (\(fmt(rows[0].v))), lowest \(rows[rows.count - 1].name) (\(fmt(rows[rows.count - 1].v))).\(missingSuffix)"
    }
    if family == .barrace {
        let n = spec.categories.count
        let first = chartRaceRanking(spec, 0).first
        let last = chartRaceRanking(spec, Double(n - 1)).first
        func lead(_ e: ChartRaceEntry?, _ at: String) -> String {
            guard let e else { return "" }
            return "\(e.name) leads at \(at) with \(fmt(e.value))"
        }
        let firstCat = n > 0 ? spec.categories[0] : "undefined"
        let lastCat = n > 0 ? spec.categories[n - 1] : "undefined"
        return "\(head) of \(series.count) names over \(n) time points (\(firstCat) to \(lastCat)), showing the top \(Swift.min(spec.raceTopN, series.count)). \(lead(first, firstCat)); \(lead(last, lastCat))."
    }
    if family == .sankey {
        if spec.links.isEmpty {
            return "\(head) with no flows yet."
        }
        let total = spec.links.reduce(0.0) { $0 + $1.value }
        var sortedLinks = spec.links
        sortedLinks.sort { $0.value > $1.value }
        let largest = sortedLinks[0]
        let sources = spec.sankeyNodes.filter { n in !spec.links.contains { $0.target == n } }
        let sinks = spec.sankeyNodes.filter { n in !spec.links.contains { $0.source == n } }
        return "\(head) of \(spec.links.count) flows between \(spec.sankeyNodes.count) nodes, from \(sources.joined(separator: ", ")) to \(sinks.joined(separator: ", ")). The largest flow is \(largest.source) → \(largest.target) (\(fmt(largest.value))); all flows add up to \(fmt(total))."
    }
    if family == .parliament {
        let s = spec.series.first(where: { !($0.hidden ?? false) })!
        let seats: [(c: String, n: Int)] = spec.categories.enumerated().map { i, c in
            let v = i < s.values.count ? (s.values[i] ?? 0) : 0
            return (c: c, n: Swift.max(0, Int(JS.round(v))))
        }
        let total = seats.reduce(0) { $0 + $1.n }
        let majority = spec.parliamentMajority ?? (total / 2 + 1)
        var sortedSeats = seats
        sortedSeats.sort { $0.n > $1.n }
        let largest = sortedSeats.first
        let verdict: String
        if let largest, largest.n >= majority {
            verdict = "\(largest.c) holds a majority with \(largest.n)"
        } else {
            let lName = largest?.c ?? "undefined"
            let lSeats = largest.map { String($0.n) } ?? "undefined"
            verdict = "no group reaches the majority of \(majority); the largest is \(lName) with \(lSeats)"
        }
        return "\(head) of \(total) seats across \(seats.count) groups: \(verdict)."
    }
    if family == .slope {
        let vis = spec.series.filter { !($0.hidden ?? false) }
        guard vis.count >= 2 else {
            return "\(head) that needs a second series to compare against."
        }
        let a = vis[0]
        let b = vis[1]
        var moves: [(c: String, d: Double)] = []
        for (i, c) in spec.categories.enumerated() {
            if i < a.values.count, i < b.values.count,
               let av = a.values[i], let bv = b.values[i] {
                moves.append((c: c, d: bv - av))
            }
        }
        let up = moves.filter { $0.d > 0 }.count
        let down = moves.filter { $0.d < 0 }.count
        var top = moves
        top.sort { $0.d > $1.d }
        let extremes = !top.isEmpty
            ? " The biggest rise is \(top[0].c) (\(fmt(top[0].d))); the biggest fall is \(top[top.count - 1].c) (\(fmt(top[top.count - 1].d)))."
            : ""
        return "\(head) from \(a.name) to \(b.name): \(up) of \(moves.count) rose and \(down) fell.\(extremes)"
    }
    if family == .likert {
        let answers = spec.series.filter { !($0.hidden ?? false) }
        let side = answers.count / 2
        let agree: [(c: String, share: Double)] = spec.categories.enumerated().map { i, c in
            let vals = answers.map { x -> Double in
                let v = i < x.values.count ? (x.values[i] ?? 0) : 0
                return Swift.max(0.0, v)
            }
            let total = vals.reduce(0.0, +)
            let posSum = vals.dropFirst(answers.count - side).reduce(0.0, +)
            return (c: c, share: total != 0 ? posSum / total : 0)
        }
        var best = agree
        best.sort { $0.share > $1.share }
        func pct(_ v: Double) -> String {
            "\(Int(JS.round(v * 100)))%"
        }
        let firstAns = answers.first?.name ?? "undefined"
        let lastAns = answers.last?.name ?? "undefined"
        let bestC = best.first?.c ?? "undefined"
        let worstC = best.last?.c ?? "undefined"
        return "\(head) of \(spec.categories.count) questions with \(answers.count) answers from \(firstAns) to \(lastAns). Most positive: \(bestC) (\(pct(best.first?.share ?? 0))); least: \(worstC) (\(pct(best.last?.share ?? 0)))."
    }
    if family == .streamgraph {
        let n = spec.categories.count
        let vis = spec.series.filter { !($0.hidden ?? false) }
        let totals: [Double] = (0..<n).map { i in
            vis.reduce(0.0) { sum, s in
                let v = i < s.values.count ? (s.values[i] ?? 0) : 0
                return sum + Swift.max(0.0, v)
            }
        }
        let maxTotal = Swift.max(0.0, totals.max() ?? 0.0)
        let catRange = n > 0 ? " (\(spec.categories[0]) to \(spec.categories[n - 1]))" : ""
        return "\(head) of \(series.count) series over \(n) categories\(catRange), stacked symmetrically around a center baseline with a peak volume of \(fmt(maxTotal))."
    }
    if family == .waterfall {
        let s = spec.series.first(where: { !($0.hidden ?? false) })!
        let steps: [Double] = s.values.enumerated().compactMap { i, v in
            guard let v, v.isFinite else { return nil }
            let cat = i < spec.categories.count ? spec.categories[i] : ""
            if isWaterfallTotalCategory(cat) { return nil }
            return v
        }
        let total = steps.reduce(0.0, +)
        let up = steps.filter { $0 > 0 }.count
        let down = steps.filter { $0 < 0 }.count
        return "\(head) of \(s.name): \(up) increase\(up == 1 ? "" : "s") and \(down) decrease\(down == 1 ? "" : "s") over \(spec.categories.count) steps, ending at a total of \(fmt(total))."
    }
    if family == .histogram || family == .box {
        parts.append("\(head) of \(series.map { $0.name }.joined(separator: ", ")).")
        for s in series {
            parts.append("\(s.name): \(s.count) values from \(fmt(s.min)) to \(fmt(s.max)), mean \(fmt(s.mean)).")
        }
        return parts.joined(separator: " ")
    }
    let catRange = !spec.categories.isEmpty ? " (\(spec.categories[0]) to \(spec.categories[spec.categories.count - 1]))" : ""
    let what = family == .xy
        ? "\(series.count) series of points"
        : "\(series.count) series over \(spec.categories.count) categories\(catRange)"
    parts.append("\(head) showing \(what).")
    for s in series.prefix(8) {
        if s.count == 0 {
            parts.append("\(s.name) has no values.")
            continue
        }
        let pct = s.change != nil ? Int(JS.round(abs(s.change!) * 100)) : 0
        let trend: String
        if let st = s.trend, st != .flat {
            let pctPart = pct != 0 ? ", \(s.change! > 0 ? "up" : "down") \(pct)% from first to last" : ""
            trend = ", \(st.rawValue)\(pctPart)"
        } else if s.trend == .flat {
            trend = ", roughly flat"
        } else {
            trend = ""
        }
        parts.append("\(s.name) ranges from \(fmt(s.min)) (\(s.minAt ?? "null")) to \(fmt(s.max)) (\(s.maxAt ?? "null"))\(trend).")
    }
    if series.count > 8 {
        parts.append("\(series.count - 8) more series are not described.")
    }
    let axisPairs: [(ChartAxis, String)] = [
        (spec.yAxis, "value axis"),
        (spec.yAxis2, "secondary value axis"),
        (spec.xAxis, family == .xy ? "x axis" : "category axis")
    ]
    for (a, name) in axisPairs {
        if name == "secondary value axis" && !spec.series.contains(where: { !($0.hidden ?? false) && $0.axis == .secondary }) {
            continue
        }
        let log = a.scale == .log && name != "category axis"
        if log || a.reverse == true {
            var traits: [String] = []
            if log { traits.append("logarithmic (base \(JSONValue.jsNumber(a.logBase ?? 10)))") }
            if a.reverse == true { traits.append("reversed") }
            parts.append("The \(name) is \(traits.joined(separator: " and ")).")
        }
    }
    for s in spec.series.filter({ !($0.hidden ?? false) && ($0.errorBars != nil || $0.xErrorBars != nil) }).prefix(8) {
        var barParts: [String] = []
        if let eb = s.errorBars { barParts.append(describeChartErrorBars(eb)) }
        if let xeb = s.xErrorBars { barParts.append("x \(describeChartErrorBars(xeb))") }
        parts.append("\(s.name) has \(barParts.joined(separator: " and ")).")
    }
    return parts.joined(separator: " ")
}
