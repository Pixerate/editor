import Foundation
import PixerateCore
import PixerateRaster

/**
 * DrawingML chart XML (`c:chartSpace`, ECMA-376 §21.2) writer (`chart/ooxml.ts`).
 */

public struct ChartOoxmlWriteResult: Sendable, Equatable {
    public var xml: String
    public var issues: [String]

    public init(xml: String, issues: [String]) {
        self.xml = xml
        self.issues = issues
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("xml", .string(xml)),
            ("issues", .array(issues.map(JSONValue.string)))
        ]))
    }
}

private let CURRENCY_SYMBOL: [String: String] = [
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "CNY": "¥",
    "INR": "₹"
]

private let MARKER_OUT: [ChartMarker: String] = [
    .circle: "circle",
    .square: "square",
    .diamond: "diamond",
    .triangle: "triangle",
    .cross: "x",
    .none: "none"
]

private let LEGEND_OUT: [ChartLegendPosition: String] = [
    .bottom: "b",
    .top: "t",
    .left: "l",
    .right: "r"
]

internal func esc(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count)
    for ch in s.unicodeScalars {
        switch ch {
        case "&": out += "&amp;"
        case "<": out += "&lt;"
        case ">": out += "&gt;"
        case "\"": out += "&quot;"
        default: out.unicodeScalars.append(ch)
        }
    }
    return out
}

private func hex(_ color: String?) -> String? {
    guard let color, !color.isEmpty else { return nil }
    guard let rgb = parseChartColor(color) else { return nil }
    return String(chartRgbToHex(rgb).dropFirst()).uppercased()
}

private func fillXml(_ color: String?, _ line: Bool = false) -> String {
    guard let h = hex(color) else { return "" }
    return line
        ? "<c:spPr><a:ln w=\"28575\" cap=\"rnd\"><a:solidFill><a:srgbClr val=\"\(h)\"/></a:solidFill><a:round/></a:ln></c:spPr>"
        : "<c:spPr><a:solidFill><a:srgbClr val=\"\(h)\"/></a:solidFill></c:spPr>"
}

private func rich(_ text: String) -> String {
    "<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>\(esc(text))</a:t></a:r></a:p></c:rich></c:tx><c:overlay val=\"0\"/>"
}

private func strLit(_ items: [String]) -> String {
    let pts = items.enumerated().map { i, s in
        "<c:pt idx=\"\(i)\"><c:v>\(esc(s))</c:v></c:pt>"
    }.joined()
    return "<c:strLit><c:ptCount val=\"\(items.count)\"/>\(pts)</c:strLit>"
}

private func numLit(_ items: [ChartValue], _ code: String = "General") -> String {
    let pts = items.enumerated().compactMap { i, v -> String? in
        guard let v, v.isFinite else { return nil }
        return "<c:pt idx=\"\(i)\"><c:v>\(JSONValue.jsString(v))</c:v></c:pt>"
    }.joined()
    return "<c:numLit><c:formatCode>\(esc(code))</c:formatCode><c:ptCount val=\"\(items.count)\"/>\(pts)</c:numLit>"
}

/**
 * A spreadsheet format code equivalent to a chart number format (`General` when there is none).
 */
public func chartFormatToCode(_ format: ChartNumberFormat) -> String {
    if let code = format.code, !code.isEmpty { return code }
    let d = format.decimals
    func frac(_ n: Int?, _ fallback: Int) -> String {
        let k = n ?? fallback
        return k > 0 ? "." + String(repeating: "0", count: k) : ""
    }
    let pre = (format.prefix ?? "").replacingOccurrences(of: "\"", with: "")
    let suf = (format.suffix ?? "").replacingOccurrences(of: "\"", with: "")
    func wrap(_ body: String) -> String {
        "\(!pre.isEmpty ? "\"\(pre)\"" : "")\(body)\(!suf.isEmpty ? "\"\(suf)\"" : "")"
    }
    switch format.style {
    case .percent?:
        return wrap("#,##0\(frac(d, 0))%")
    case .currency?:
        let rawCurr = format.currency ?? ""
        let code = (rawCurr.isEmpty ? "USD" : rawCurr).uppercased()
        let sym = CURRENCY_SYMBOL[code] ?? "\(code) "
        return wrap("\"\(sym)\"#,##0\(frac(d, 0))")
    case .compact?:
        return wrap("#,##0.0,,\"M\"")
    default:
        let hasPre = !(format.prefix ?? "").isEmpty
        let hasSuf = !(format.suffix ?? "").isEmpty
        return (d != nil || hasPre || hasSuf) ? wrap("#,##0\(frac(d, 0))") : "General"
    }
}

private func errBarsXml(_ bars: ChartErrorBars, _ dir: String?) -> String {
    let dirTag = dir != nil ? "<c:errDir val=\"\(dir!)\"/>" : ""
    let barType = bars.direction?.rawValue ?? "both"
    let valType = ERR_OUT[bars.type] ?? "fixedVal"
    let noEndCap = bars.cap == false ? 1 : 0
    var x = "<c:errBars>\(dirTag)<c:errBarType val=\"\(barType)\"/><c:errValType val=\"\(valType)\"/><c:noEndCap val=\"\(noEndCap)\"/>"
    if bars.type == .custom {
        let plus: [ChartValue] = bars.plus ?? (bars.minus ?? []).map { _ in nil }
        let minus: [ChartValue] = bars.minus ?? plus
        x += "<c:plus>\(numLit(plus))</c:plus><c:minus>\(numLit(minus))</c:minus>"
    } else if bars.type != .stderr {
        let val = bars.value ?? (bars.type == .percent ? 5.0 : 1.0)
        x += "<c:val val=\"\(JSONValue.jsString(val))\"/>"
    }
    return "\(x)</c:errBars>"
}

/**
 * Writes a chart as a DrawingML chart part (`c:chartSpace`) with the data as literals (`chart/ooxml.ts`).
 */
public func chartToOoxml(_ inputSpec: ChartSpec) -> ChartOoxmlWriteResult {
    var spec = inputSpec
    var issues: [String] = []
    let family = chartFamily(spec)
    var type = spec.type

    if family == .waterfall || family == .histogram || family == .box || family == .funnel {
        issues.append("\(spec.type.rawValue) charts are written as bar charts: DrawingML has no \(spec.type.rawValue) type (Office 2016 stores it as chartex).")
        type = .bar
    } else if family == .treemap {
        let extra = !spec.tree.isEmpty ? " of the top-level group totals" : ""
        issues.append("Treemaps are written as pie charts\(extra): DrawingML has no treemap type.")
        type = .pie
    } else if family == .sunburst {
        let what = !spec.tree.isEmpty ? "top-level group totals" : "values"
        issues.append("Sunburst charts are written as doughnut charts of the \(what): DrawingML has no sunburst type (Office 2016 stores it as chartex).")
        type = .donut
    } else if family == .choropleth {
        issues.append("Maps are written as bar charts of the values by region: DrawingML has no map chart (Office 2016 stores region maps as chartex with Bing geodata).")
        type = .bar
    } else if family == .barrace {
        issues.append("Bar chart races are written as clustered bar charts of every name at every time point: DrawingML has no animation.")
        type = .bar
    } else if family == .streamgraph {
        issues.append("Streamgraphs are written as stacked area charts: DrawingML has no streamgraph type.")
        spec.type = .area
        spec.stacking = .stacked
        type = .area
    } else if family == .sankey {
        issues.append("Sankey diagrams are written as bar charts of how much passes through each node: DrawingML has no flows.")
        type = .bar
    } else if family == .parliament {
        issues.append("Parliament charts are written as doughnut charts of the seats: DrawingML has no parliament type.")
        type = .donut
    } else if family == .slope {
        issues.append("Slope charts are written as line charts with the two series as lines over the categories: DrawingML has no slope type.")
        type = .line
    } else if family == .likert {
        issues.append("Likert charts are written as 100% stacked horizontal bars: DrawingML has no diverging bar.")
        spec.type = .bar
        spec.stacking = .percent
        spec.orientation = .horizontal
        type = .bar
    }

    let visible = spec.series.filter { !($0.hidden ?? false) }
    let annotations = [
        (!spec.referenceLines.isEmpty || !spec.referenceBands.isEmpty) ? "reference lines and bands" : "",
        spec.series.contains(where: { $0.callouts != nil }) ? "callouts" : "",
        !spec.highlight.isEmpty ? "the highlight" : "",
        !spec.note.isEmpty ? "the note" : ""
    ].filter { !$0.isEmpty }
    if !annotations.isEmpty {
        let joined = annotations.joined(separator: ", ")
        let capitalized = joined.prefix(1).uppercased() + joined.dropFirst()
        let verb = (annotations.count == 1 && !annotations[0].hasSuffix("s")) ? "is" : "are"
        issues.append("\(capitalized) \(verb) not written: DrawingML has no equivalent.")
    }
    if spec.view3d != nil { issues.append("The 3-D view is not written: the chart is saved flat.") }
    if visible.count < spec.series.count {
        let diff = spec.series.count - visible.count
        issues.append("\(diff) hidden series \(diff == 1 ? "is" : "are") left out.")
    }

    let grouping = spec.stacking == .stacked ? "stacked" : (spec.stacking == .percent ? "percentStacked" : "standard")
    let ids = (cat: 500_000_001, val: 500_000_002, cat2: 500_000_003, val2: 500_000_004)
    let xy = family == .xy || type == .scatter || type == .bubble
    let pieLike = type == .pie || type == .donut
    func typed(_ s: ChartSeries) -> String {
        if pieLike || type == .radar { return type.rawValue }
        if type == .bubble { return "bubble" }
        if xy { return "scatter" }
        return chartSeriesType(chartType: type, series: s).rawValue
    }

    struct GroupBucket {
        var kind: String
        var secondary: Bool
        var series: [(s: ChartSeries, index: Int)]
    }
    var groups: [GroupBucket] = []
    for s in visible {
        let kind = typed(s)
        let secondary = !pieLike && s.axis == .secondary
        let idx = spec.series.firstIndex(where: { $0.id == s.id }) ?? 0
        if let gi = groups.firstIndex(where: { $0.kind == kind && $0.secondary == secondary }) {
            groups[gi].series.append((s: s, index: idx))
        } else {
            groups.append(GroupBucket(kind: kind, secondary: secondary, series: [(s: s, index: idx)]))
        }
    }
    if pieLike && visible.count > 1 {
        issues.append("Only the first series of a pie is drawn; the others are kept in the part.")
    }

    let catLit = strLit(spec.categories)
    var order = 0
    func serXml(_ kind: String, _ s: ChartSeries, _ index: Int) -> String {
        let ord = order
        order += 1
        var parts = [
            "<c:idx val=\"\(index)\"/>",
            "<c:order val=\"\(ord)\"/>",
            "<c:tx><c:v>\(esc(s.name))</c:v></c:tx>"
        ]
        let lineLike = kind == "line" || kind == "scatter" || kind == "radar"
        parts.append(fillXml(s.color, lineLike))
        if kind == "bar" || kind == "bubble" {
            parts.append("<c:invertIfNegative val=\"0\"/>")
        }
        if lineLike {
            let marker = s.marker ?? ((spec.points || kind == "scatter") ? .circle : .none)
            let sym = MARKER_OUT[marker] ?? "circle"
            parts.append("<c:marker><c:symbol val=\"\(sym)\"/>\(marker != .none ? "<c:size val=\"5\"/>" : "")</c:marker>")
        }
        if let pointColors = s.pointColors {
            for (i, c) in pointColors.enumerated() {
                if let h = hex(c) {
                    parts.append("<c:dPt><c:idx val=\"\(i)\"/>\(kind == "bar" ? "<c:invertIfNegative val=\"0\"/>" : "")<c:bubble3D val=\"0\"/><c:spPr><a:solidFill><a:srgbClr val=\"\(h)\"/></a:solidFill></c:spPr></c:dPt>")
                }
            }
        }
        let labels = s.dataLabels ?? spec.dataLabels
        let code = s.format.map(chartFormatToCode)
        if s.dataLabels != nil || (code != nil && !code!.isEmpty) {
            let numFmtTag = (code != nil && !code!.isEmpty) ? "<c:numFmt formatCode=\"\(esc(code!))\" sourceLinked=\"0\"/>" : ""
            parts.append("<c:dLbls>\(numFmtTag)<c:showLegendKey val=\"0\"/><c:showVal val=\"\(labels ? 1 : 0)\"/><c:showCatName val=\"0\"/><c:showSerName val=\"0\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/></c:dLbls>")
        }
        if !pieLike && kind != "radar" {
            for t in s.trendlines ?? [] {
                let nameTag = (t.name != nil && !t.name!.isEmpty) ? "<c:name>\(esc(t.name!))</c:name>" : ""
                let tOut = TREND_OUT[t.type] ?? "linear"
                var x = "<c:trendline>\(nameTag)\(fillXml(t.color, true))<c:trendlineType val=\"\(tOut)\"/>"
                if t.type == .polynomial { x += "<c:order val=\"\(t.order ?? 2)\"/>" }
                if t.type == .movingAverage { x += "<c:period val=\"\(t.period ?? 2)\"/>" }
                if let fw = t.forward, fw != 0 { x += "<c:forward val=\"\(JSONValue.jsString(fw))\"/>" }
                if let bw = t.backward, bw != 0 { x += "<c:backward val=\"\(JSONValue.jsString(bw))\"/>" }
                if let ic = t.intercept { x += "<c:intercept val=\"\(JSONValue.jsString(ic))\"/>" }
                x += "<c:dispRSqr val=\"\(t.showR2 == true ? 1 : 0)\"/><c:dispEq val=\"\(t.showEquation == true ? 1 : 0)\"/></c:trendline>"
                parts.append(x)
            }
        }
        if !pieLike && kind != "radar" {
            let xyKind = kind == "scatter" || kind == "bubble"
            if let eb = s.errorBars {
                parts.append(errBarsXml(eb, xyKind ? "y" : nil))
            }
            if let xeb = s.xErrorBars {
                if xyKind {
                    parts.append(errBarsXml(xeb, "x"))
                } else {
                    issues.append("\"\(s.name)\" has x error bars, which only scatter and bubble charts can hold; they are left out.")
                }
            }
        } else if s.errorBars != nil || s.xErrorBars != nil {
            issues.append("Error bars on \"\(s.name)\" are left out: \(kind) charts cannot show them.")
        }

        let valCode = chartFormatToCode(s.format ?? (s.axis == .secondary ? spec.yAxis2.format : spec.yAxis.format))
        let curve = s.curve ?? spec.curve
        if kind == "scatter" || kind == "bubble" {
            let xs: [ChartValue] = s.x ?? spec.categories.indices.map { Double($0 + 1) }
            parts.append("<c:xVal>\(numLit(xs))</c:xVal><c:yVal>\(numLit(s.values, valCode))</c:yVal>")
            if kind == "bubble" {
                let sz: [ChartValue] = s.sizes ?? s.values.map { _ in 1.0 }
                parts.append("<c:bubbleSize>\(numLit(sz))</c:bubbleSize><c:bubble3D val=\"0\"/>")
            } else {
                parts.append("<c:smooth val=\"\(curve == .smooth ? 1 : 0)\"/>")
            }
        } else {
            parts.append("<c:cat>\(catLit)</c:cat><c:val>\(numLit(s.values, valCode))</c:val>")
            if kind == "line" {
                parts.append("<c:smooth val=\"\(curve == .smooth ? 1 : 0)\"/>")
            }
        }
        if curve == .step && lineLike {
            issues.append("\"\(s.name)\" uses step lines, which DrawingML cannot express; they are written straight.")
        }
        if curve == .smooth && kind == "area" {
            issues.append("\"\(s.name)\" is a smoothed area, which DrawingML cannot express; it is written straight.")
        }
        return "<c:ser>\(parts.joined())</c:ser>"
    }

    let dLbls = "<c:dLbls><c:showLegendKey val=\"0\"/><c:showVal val=\"\(spec.dataLabels ? 1 : 0)\"/><c:showCatName val=\"0\"/><c:showSerName val=\"0\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/></c:dLbls>"
    let vary = chartVariesColors(spec) ? 1 : 0
    let groupXml: [String] = groups.map { g in
        let axes = g.secondary
            ? "<c:axId val=\"\(ids.cat2)\"/><c:axId val=\"\(ids.val2)\"/>"
            : "<c:axId val=\"\(ids.cat)\"/><c:axId val=\"\(ids.val)\"/>"
        let sers = g.series.map { serXml(g.kind, $0.s, $0.index) }.joined()
        switch g.kind {
        case "bar":
            let n = Double(g.series.count)
            let barsWidth = spec.stacking == .none ? n - (n - 1.0) * spec.overlap : 1.0
            let gapPct = Int(JS.round(Swift.min(500.0, (spec.gapWidth / Swift.max(0.01, 1.0 - spec.gapWidth)) * barsWidth * 100.0)))
            let overlapPct = spec.stacking == .none ? Int(JS.round(spec.overlap * 100.0)) : 100
            let barGrouping = spec.stacking == .none ? "clustered" : grouping
            return "<c:barChart><c:barDir val=\"\(spec.orientation == .horizontal ? "bar" : "col")\"/><c:grouping val=\"\(barGrouping)\"/><c:varyColors val=\"\(vary)\"/>\(sers)\(dLbls)<c:gapWidth val=\"\(gapPct)\"/><c:overlap val=\"\(overlapPct)\"/>\(axes)</c:barChart>"
        case "line":
            return "<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"\(vary)\"/>\(sers)\(dLbls)<c:marker val=\"1\"/>\(axes)</c:lineChart>"
        case "area":
            return "<c:areaChart><c:grouping val=\"\(grouping)\"/><c:varyColors val=\"\(vary)\"/>\(sers)\(dLbls)\(axes)</c:areaChart>"
        case "scatter":
            return "<c:scatterChart><c:scatterStyle val=\"lineMarker\"/><c:varyColors val=\"\(vary)\"/>\(sers)\(dLbls)\(axes)</c:scatterChart>"
        case "bubble":
            return "<c:bubbleChart><c:varyColors val=\"0\"/>\(sers)\(dLbls)<c:bubbleScale val=\"100\"/>\(axes)</c:bubbleChart>"
        case "radar":
            return "<c:radarChart><c:radarStyle val=\"marker\"/><c:varyColors val=\"0\"/>\(sers)\(dLbls)\(axes)</c:radarChart>"
        case "donut":
            let hole = Int(JS.round(Swift.max(10.0, Swift.min(90.0, spec.innerRadius * 100.0))))
            return "<c:doughnutChart><c:varyColors val=\"1\"/>\(sers)\(dLbls)<c:firstSliceAng val=\"0\"/><c:holeSize val=\"\(hole)\"/></c:doughnutChart>"
        default:
            return "<c:pieChart><c:varyColors val=\"1\"/>\(sers)\(dLbls)<c:firstSliceAng val=\"0\"/></c:pieChart>"
        }
    }

    func scaling(_ a: ChartAxis) -> String {
        let logTag = a.scale == .log ? "<c:logBase val=\"\(JSONValue.jsString(a.logBase ?? 10.0))\"/>" : ""
        let orient = "<c:orientation val=\"\(a.reverse == true ? "maxMin" : "minMax")\"/>"
        let maxTag = a.max != nil ? "<c:max val=\"\(JSONValue.jsString(a.max!))\"/>" : ""
        let minTag = a.min != nil ? "<c:min val=\"\(JSONValue.jsString(a.min!))\"/>" : ""
        return "<c:scaling>\(logTag)\(orient)\(maxTag)\(minTag)</c:scaling>"
    }
    func title(_ a: ChartAxis) -> String {
        !a.title.isEmpty ? "<c:title>\(rich(a.title))</c:title>" : ""
    }
    func fmt(_ a: ChartAxis) -> String {
        let code = chartFormatToCode(a.format)
        return code != "General"
            ? "<c:numFmt formatCode=\"\(esc(code))\" sourceLinked=\"0\"/>"
            : "<c:numFmt formatCode=\"\(spec.stacking == .percent ? "0%" : "General")\" sourceLinked=\"1\"/>"
    }
    let horizontal = spec.orientation == .horizontal
    let catPos = horizontal ? "l" : "b"
    let valPos = horizontal ? "b" : "l"
    func valAx(_ id: Int, _ cross: Int, _ a: ChartAxis, _ pos: String, _ crosses: String, _ catKind: Bool = false) -> String {
        let stepTag = (a.step != nil && a.step != 0) ? "<c:majorUnit val=\"\(JSONValue.jsString(a.step!))\"/>" : ""
        return "<c:valAx><c:axId val=\"\(id)\"/>\(scaling(a))<c:delete val=\"\(a.show ? 0 : 1)\"/><c:axPos val=\"\(pos)\"/>\(a.gridlines ? "<c:majorGridlines/>" : "")\(title(a))\(fmt(a))<c:majorTickMark val=\"out\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"\(cross)\"/><c:crosses val=\"\(crosses)\"/><c:crossBetween val=\"\(catKind ? "midCat" : "between")\"/>\(stepTag)</c:valAx>"
    }
    func catAx(_ id: Int, _ cross: Int, _ a: ChartAxis, _ pos: String, _ hidden: Bool = false) -> String {
        let tag = a.kind == .date ? "dateAx" : "catAx"
        let tail = a.kind == .date
            ? "<c:lblOffset val=\"100\"/><c:baseTimeUnit val=\"days\"/>"
            : "<c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/><c:noMultiLvlLbl val=\"0\"/>"
        return "<c:\(tag)><c:axId val=\"\(id)\"/><c:scaling><c:orientation val=\"\(a.reverse == true ? "maxMin" : "minMax")\"/></c:scaling><c:delete val=\"\((a.show && !hidden) ? 0 : 1)\"/><c:axPos val=\"\(pos)\"/>\(a.gridlines ? "<c:majorGridlines/>" : "")\(title(a))<c:numFmt formatCode=\"General\" sourceLinked=\"1\"/><c:majorTickMark val=\"out\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"\(cross)\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/>\(tail)</c:\(tag)>"
    }

    var axes = ""
    if !pieLike {
        if xy {
            axes = valAx(ids.cat, ids.val, spec.xAxis, "b", "autoZero", true) + valAx(ids.val, ids.cat, spec.yAxis, "l", "autoZero", true)
        } else {
            if spec.xAxis.scale == .log {
                issues.append("The category axis cannot be logarithmic; its log scale is left out.")
            }
            axes = catAx(ids.cat, ids.val, spec.xAxis, catPos) + valAx(ids.val, ids.cat, spec.yAxis, valPos, "autoZero")
        }
        if groups.contains(where: { $0.secondary }) {
            axes += catAx(ids.cat2, ids.val2, spec.xAxis, catPos, true) + valAx(ids.val2, ids.cat2, spec.yAxis2, horizontal ? "t" : "r", "max")
        }
    }

    let legendPos = LEGEND_OUT[spec.legend.position] ?? "r"
    let legend = spec.legend.show ? "<c:legend><c:legendPos val=\"\(legendPos)\"/><c:overlay val=\"0\"/></c:legend>" : ""
    let titleXml = !spec.title.isEmpty
        ? "<c:title>\(rich(spec.title))</c:title><c:autoTitleDeleted val=\"0\"/>"
        : "<c:autoTitleDeleted val=\"1\"/>"
    if !spec.subtitle.isEmpty {
        issues.append("The subtitle is left out: DrawingML charts have one title.")
    }
    if family == .radar && spec.series.contains(where: { !($0.trendlines ?? []).isEmpty }) {
        issues.append("Trendlines on a radar chart are left out.")
    }

    let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
        "<c:chartSpace xmlns:c=\"\(CHART_OOXML_NS)\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">" +
        "<c:roundedCorners val=\"0\"/><c:chart>\(titleXml)<c:plotArea><c:layout/>\(groupXml.joined())\(axes)</c:plotArea>\(legend)<c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart>" +
        "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz=\"\(Int(JS.round(10.0 * 100.0)))\"/></a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr></c:chartSpace>"
    return ChartOoxmlWriteResult(xml: xml, issues: uniqueStrings(issues))
}
