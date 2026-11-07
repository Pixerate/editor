import Foundation
import PixerateCore
import PixerateRaster

/**
 * DrawingML chart XML (`c:chartSpace`, ECMA-376 §21.2) and Office 2016+ extended chart XML
 * (`cx:chartSpace`, MS-ODRAWXML) reader (`chart/ooxml.ts`).
 */

public let CHART_OOXML_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
public let CHART_OOXML_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
public let CHART_OOXML_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"
internal let CHARTEX_NS = "http://schemas.microsoft.com/office/drawing/2014/chartex"

public struct ChartOoxmlReadResult: Sendable, Equatable {
    public var spec: ChartSpec
    public var issues: [ChartIssue]
    public var unsupported: [String]
    public var lossless: Bool

    public init(spec: ChartSpec, issues: [ChartIssue], unsupported: [String], lossless: Bool) {
        self.spec = spec
        self.issues = issues
        self.unsupported = unsupported
        self.lossless = lossless
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("spec", spec.toJSON()),
            ("issues", .array(issues.map { $0.toJSON() })),
            ("unsupported", .array(unsupported.map(JSONValue.string))),
            ("lossless", .bool(lossless))
        ]))
    }
}

// MARK: - Minimal XML DOM Parser (matching FallbackXmlDomParser in chart/contract.ts)

internal struct MiniXmlAttr {
    let name: String
    let localName: String
    let prefix: String?
    let namespaceURI: String?
    let value: String
}

internal enum MiniXmlChild {
    case element(MiniXmlElement)
    case text(String)
}

internal final class MiniXmlElement {
    let tagName: String
    let localName: String
    let prefix: String?
    let namespaceURI: String?
    let attributes: [MiniXmlAttr]
    weak var parentElement: MiniXmlElement?
    var childNodes: [MiniXmlChild] = []
    var children: [MiniXmlElement] = []

    init(
        tagName: String,
        localName: String,
        prefix: String?,
        namespaceURI: String?,
        attributes: [MiniXmlAttr]
    ) {
        self.tagName = tagName
        self.localName = localName
        self.prefix = prefix
        self.namespaceURI = namespaceURI
        self.attributes = attributes
    }

    var textContent: String {
        var out = ""
        for child in childNodes {
            switch child {
            case .text(let t): out += t
            case .element(let el): out += el.textContent
            }
        }
        return out
    }

    func getAttribute(_ name: String) -> String? {
        attributes.first(where: { $0.name == name })?.value
    }

    func getElementsByTagName(_ name: String) -> [MiniXmlElement] {
        var result: [MiniXmlElement] = []
        let matchAll = name == "*"
        func walk(_ node: MiniXmlElement) {
            for child in node.children {
                if matchAll || child.tagName == name || child.localName == name {
                    result.append(child)
                }
                walk(child)
            }
        }
        walk(self)
        return result
    }

    func getElementsByTagNameNS(_ ns: String, _ localName: String) -> [MiniXmlElement] {
        var result: [MiniXmlElement] = []
        let matchAllNs = ns == "*"
        let matchAllLocal = localName == "*"
        func walk(_ node: MiniXmlElement) {
            for child in node.children {
                let nsMatch = matchAllNs || child.namespaceURI == ns
                let localMatch = matchAllLocal || child.localName == localName
                if nsMatch && localMatch {
                    result.append(child)
                }
                walk(child)
            }
        }
        walk(self)
        return result
    }
}

internal struct MiniXmlDocument {
    let documentElement: MiniXmlElement?
    let hasError: Bool

    func getElementsByTagName(_ name: String) -> [MiniXmlElement] {
        if name == "parsererror" {
            return hasError ? [MiniXmlElement(tagName: "parsererror", localName: "parsererror", prefix: nil, namespaceURI: nil, attributes: [])] : []
        }
        guard let root = documentElement else { return [] }
        var out: [MiniXmlElement] = []
        if name == "*" || root.tagName == name || root.localName == name {
            out.append(root)
        }
        out.append(contentsOf: root.getElementsByTagName(name))
        return out
    }

    func getElementsByTagNameNS(_ ns: String, _ localName: String) -> [MiniXmlElement] {
        guard let root = documentElement else { return [] }
        var out: [MiniXmlElement] = []
        let nsMatch = ns == "*" || root.namespaceURI == ns
        let localMatch = localName == "*" || root.localName == localName
        if nsMatch && localMatch {
            out.append(root)
        }
        out.append(contentsOf: root.getElementsByTagNameNS(ns, localName))
        return out
    }
}

private let xmlEntityRegex = try! NSRegularExpression(pattern: #"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);"#)
private let xmlOpenTagRegex = try! NSRegularExpression(pattern: #"^<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(/?)>"#)
private let xmlCloseTagRegex = try! NSRegularExpression(pattern: #"^</([A-Za-z_][\w:.-]*)\s*>"#)
private let xmlAttrRegex = try! NSRegularExpression(pattern: #"([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
private let xmlPiRegex = try! NSRegularExpression(pattern: #"<\?[\s\S]*?\?>"#)
private let xmlCommentRegex = try! NSRegularExpression(pattern: #"<!--[\s\S]*?-->"#)
private let xmlDoctypeRegex = try! NSRegularExpression(pattern: #"<!DOCTYPE[^>]*>"#, options: [.caseInsensitive])

internal func decodeXmlEntities(_ input: String) -> String {
    guard input.contains("&") else { return input }
    let ns = input as NSString
    let matches = xmlEntityRegex.matches(in: input, range: NSRange(location: 0, length: ns.length))
    if matches.isEmpty { return input }
    var out = ""
    var lastPos = 0
    for m in matches {
        let range = m.range
        if range.location > lastPos {
            out += ns.substring(with: NSRange(location: lastPos, length: range.location - lastPos))
        }
        let ent = ns.substring(with: m.range(at: 1))
        switch ent {
        case "lt": out += "<"
        case "gt": out += ">"
        case "amp": out += "&"
        case "quot": out += "\""
        case "apos": out += "'"
        default:
            if ent.hasPrefix("#x") || ent.hasPrefix("#X") {
                if let code = UInt32(ent.dropFirst(2), radix: 16), let scalar = UnicodeScalar(code) {
                    out.unicodeScalars.append(scalar)
                } else {
                    out += ns.substring(with: range)
                }
            } else if ent.hasPrefix("#") {
                if let code = UInt32(ent.dropFirst(1), radix: 10), let scalar = UnicodeScalar(code) {
                    out.unicodeScalars.append(scalar)
                } else {
                    out += ns.substring(with: range)
                }
            } else {
                out += ns.substring(with: range)
            }
        }
        lastPos = range.location + range.length
    }
    if lastPos < ns.length {
        out += ns.substring(from: lastPos)
    }
    return out
}

internal func parseChartXml(_ xml: String) -> MiniXmlDocument {
    var src = xml
    if src.hasPrefix("\u{FEFF}") { src.removeFirst() }
    src = xmlPiRegex.stringByReplacingMatches(in: src, range: NSRange(src.startIndex..., in: src), withTemplate: "")
    src = xmlCommentRegex.stringByReplacingMatches(in: src, range: NSRange(src.startIndex..., in: src), withTemplate: "")
    src = xmlDoctypeRegex.stringByReplacingMatches(in: src, range: NSRange(src.startIndex..., in: src), withTemplate: "")
    src = src.jsTrimmed
    if src.isEmpty {
        return MiniXmlDocument(documentElement: nil, hasError: true)
    }

    let nsSrc = src as NSString
    let len = nsSrc.length
    var pos = 0
    var root: MiniXmlElement?
    var stack: [(el: MiniXmlElement, nsScope: [String: String])] = []
    var hasError = false

    while pos < len {
        if nsSrc.character(at: pos) == 0x3C { // '<'
            let remRange = NSRange(location: pos, length: len - pos)
            if pos + 9 <= len && nsSrc.substring(with: NSRange(location: pos, length: 9)) == "<![CDATA[" {
                let searchRange = NSRange(location: pos + 9, length: len - (pos + 9))
                let endRange = nsSrc.range(of: "]]>", options: [], range: searchRange)
                if endRange.location == NSNotFound {
                    hasError = true
                    break
                }
                let text = nsSrc.substring(with: NSRange(location: pos + 9, length: endRange.location - (pos + 9)))
                if let top = stack.last {
                    top.el.childNodes.append(.text(text))
                }
                pos = endRange.location + 3
                continue
            }
            if pos + 2 <= len && nsSrc.character(at: pos + 1) == 0x2F { // '</'
                guard let m = xmlCloseTagRegex.firstMatch(in: src, range: remRange) else {
                    hasError = true
                    break
                }
                let closeTag = nsSrc.substring(with: m.range(at: 1))
                if stack.isEmpty || stack.last!.el.tagName != closeTag {
                    hasError = true
                    break
                }
                stack.removeLast()
                pos += m.range.length
                continue
            }
            guard let m = xmlOpenTagRegex.firstMatch(in: src, range: remRange) else {
                hasError = true
                break
            }
            let rawTag = nsSrc.substring(with: m.range(at: 1))
            let attrBlob = nsSrc.substring(with: m.range(at: 2))
            let selfClosing = m.range(at: 3).length > 0 && nsSrc.substring(with: m.range(at: 3)) == "/"

            let nsAttrBlob = attrBlob as NSString
            let attrMatches = xmlAttrRegex.matches(in: attrBlob, range: NSRange(location: 0, length: nsAttrBlob.length))
            var nsScope = stack.last?.nsScope ?? ["xml": "http://www.w3.org/XML/1998/namespace"]
            var rawAttrs: [(name: String, value: String)] = []
            for am in attrMatches {
                let aName = nsAttrBlob.substring(with: am.range(at: 1))
                let rawVal: String
                if am.range(at: 2).location != NSNotFound {
                    rawVal = nsAttrBlob.substring(with: am.range(at: 2))
                } else if am.range(at: 3).location != NSNotFound {
                    rawVal = nsAttrBlob.substring(with: am.range(at: 3))
                } else {
                    rawVal = ""
                }
                let aVal = decodeXmlEntities(rawVal)
                rawAttrs.append((name: aName, value: aVal))
                if aName == "xmlns" {
                    nsScope[""] = aVal
                } else if aName.hasPrefix("xmlns:") {
                    nsScope[String(aName.dropFirst(6))] = aVal
                }
            }

            let attrs: [MiniXmlAttr] = rawAttrs.map { item in
                if let colonIdx = item.name.firstIndex(of: ":") {
                    let pfx = String(item.name[..<colonIdx])
                    let loc = String(item.name[item.name.index(after: colonIdx)...])
                    let ans = pfx == "xmlns" ? "http://www.w3.org/2000/xmlns/" : nsScope[pfx]
                    return MiniXmlAttr(name: item.name, localName: loc, prefix: pfx, namespaceURI: ans, value: item.value)
                } else {
                    let ans = item.name == "xmlns" ? "http://www.w3.org/2000/xmlns/" : nil
                    return MiniXmlAttr(name: item.name, localName: item.name, prefix: nil, namespaceURI: ans, value: item.value)
                }
            }

            let prefix: String?
            let localName: String
            if let colonIdx = rawTag.firstIndex(of: ":") {
                prefix = String(rawTag[..<colonIdx])
                localName = String(rawTag[rawTag.index(after: colonIdx)...])
            } else {
                prefix = nil
                localName = rawTag
            }
            let ns = nsScope[prefix ?? ""]
            let el = MiniXmlElement(
                tagName: rawTag,
                localName: localName,
                prefix: prefix,
                namespaceURI: ns,
                attributes: attrs
            )
            if let top = stack.last {
                el.parentElement = top.el
                top.el.childNodes.append(.element(el))
                top.el.children.append(el)
            } else if root == nil {
                root = el
            } else {
                hasError = true
                break
            }
            if !selfClosing {
                stack.append((el: el, nsScope: nsScope))
            }
            pos += m.range.length
        } else {
            let searchRange = NSRange(location: pos, length: len - pos)
            let nextLt = nsSrc.range(of: "<", options: [], range: searchRange)
            let endPos = nextLt.location == NSNotFound ? len : nextLt.location
            let rawText = nsSrc.substring(with: NSRange(location: pos, length: endPos - pos))
            if let top = stack.last {
                top.el.childNodes.append(.text(decodeXmlEntities(rawText)))
            } else if !rawText.jsTrimmed.isEmpty {
                hasError = true
                break
            }
            pos = endPos
        }
    }

    if root == nil || !stack.isEmpty {
        hasError = true
    }
    return MiniXmlDocument(documentElement: root, hasError: hasError)
}

// MARK: - DrawingML & ChartEx Reader (`chart/ooxml.ts`)

private let MAX_POINTS = 100_000
private let sixHexRegex = try! NSRegularExpression(pattern: #"^[0-9a-f]{6}$"#, options: [.caseInsensitive])

internal func kids(_ el: MiniXmlElement?, _ name: String? = nil) -> [MiniXmlElement] {
    guard let el else { return [] }
    if let name {
        return el.children.filter { $0.localName == name }
    }
    return el.children
}

internal func kid(_ el: MiniXmlElement?, _ name: String) -> MiniXmlElement? {
    kids(el, name).first
}

internal func val(_ el: MiniXmlElement?, _ name: String) -> String? {
    kid(el, name)?.getAttribute("val")
}

internal func path(_ el: MiniXmlElement?, _ names: String...) -> MiniXmlElement? {
    var cur = el
    for n in names {
        cur = kid(cur, n)
    }
    return cur
}

internal func find(_ el: MiniXmlElement?, _ name: String) -> MiniXmlElement? {
    guard let el else { return nil }
    for c in kids(el) {
        if c.localName == name { return c }
        if let deep = find(c, name) { return deep }
    }
    return nil
}

internal func bool(_ v: String?, _ fallback: Bool = false) -> Bool {
    guard let v else { return fallback }
    return v == "1" || v == "true"
}

internal func numberOf(_ v: String?) -> Double? {
    guard let v else { return nil }
    let trimmed = v.jsTrimmed
    if trimmed.isEmpty { return nil }
    if let n = Double(trimmed), n.isFinite {
        return n == 0 ? 0 : n
    }
    return nil
}

internal func strings(_ e: MiniXmlElement?) -> [String] {
    guard let e else { return [] }
    if let cache = find(e, "strCache") ?? find(e, "numCache") ?? find(e, "strLit") ?? find(e, "numLit") {
        let countRaw = Int(val(cache, "ptCount") ?? "0") ?? 0
        let n = Swift.min(MAX_POINTS, Swift.max(0, countRaw))
        var out = Array(repeating: "", count: n)
        for pt in kids(cache, "pt").prefix(MAX_POINTS) {
            let idxStr = pt.getAttribute("idx") ?? "0"
            guard let i = Int(idxStr), i >= 0, i < MAX_POINTS else { continue }
            while out.count <= i { out.append("") }
            out[i] = kid(pt, "v")?.textContent ?? ""
        }
        return out
    }
    if let multi = find(e, "multiLvlStrCache") {
        let lvl = kid(multi, "lvl")
        return kids(lvl, "pt").map { kid($0, "v")?.textContent ?? "" }
    }
    if let v = kid(e, "v") ?? find(e, "v") {
        return [v.textContent]
    }
    return []
}

internal func numbers(_ e: MiniXmlElement?) -> [ChartValue] {
    strings(e).map { s in
        let t = s.jsTrimmed
        return t.isEmpty ? nil : numberOf(t)
    }
}

internal func formatCodeOf(_ e: MiniXmlElement?) -> String? {
    guard let nc = find(e, "numCache") else { return nil }
    return kid(nc, "formatCode")?.textContent
}

internal func richText(_ t: MiniXmlElement?) -> String? {
    guard let t else { return nil }
    let tx = kid(t, "tx")
    if let rich = kid(tx, "rich") {
        return kids(rich, "p").map { p in
            p.getElementsByTagNameNS("*", "t").map { $0.textContent }.joined()
        }.joined(separator: "\n")
    }
    return find(tx, "v")?.textContent
}

internal func solidColor(_ spPr: MiniXmlElement?) -> String? {
    let fill = kid(spPr, "solidFill") ?? kid(kid(spPr, "ln"), "solidFill")
    let srgb = kid(fill, "srgbClr")
    guard let v = srgb?.getAttribute("val") else { return nil }
    let ns = v as NSString
    if sixHexRegex.firstMatch(in: v, range: NSRange(location: 0, length: ns.length)) != nil {
        return "#\(v.lowercased())"
    }
    return nil
}

internal let MARKERS: [String: ChartMarker] = [
    "circle": .circle,
    "dot": .circle,
    "square": .square,
    "diamond": .diamond,
    "triangle": .triangle,
    "x": .cross,
    "plus": .cross,
    "star": .cross,
    "dash": .square,
    "none": .none
]

internal let TREND_IN: [String: ChartTrendlineType] = [
    "linear": .linear,
    "exp": .exponential,
    "log": .logarithmic,
    "poly": .polynomial,
    "power": .power,
    "movingAvg": .movingAverage
]

internal let TREND_OUT: [ChartTrendlineType: String] = [
    .linear: "linear",
    .exponential: "exp",
    .logarithmic: "log",
    .polynomial: "poly",
    .power: "power",
    .movingAverage: "movingAvg"
]

internal let LEGEND_IN: [String: ChartLegendPosition] = [
    "b": .bottom,
    "t": .top,
    "l": .left,
    "r": .right,
    "tr": .right
]

internal let ERR_IN: [String: ChartErrorBarType] = [
    "fixedVal": .fixed,
    "percentage": .percent,
    "stdDev": .stddev,
    "stdErr": .stderr,
    "cust": .custom
]

internal let ERR_OUT: [ChartErrorBarType: String] = [
    .fixed: "fixedVal",
    .percent: "percentage",
    .stddev: "stdDev",
    .stderr: "stdErr",
    .custom: "cust"
]

internal func readErrorBars(_ e: MiniXmlElement) -> ChartErrorBars? {
    guard let type = ERR_IN[val(e, "errValType") ?? "fixedVal"] else { return nil }
    var bars = ChartErrorBars(type: type)
    if let value = numberOf(val(e, "val")), type != .custom, type != .stderr {
        bars.value = Swift.abs(value)
    }
    if type == .custom {
        let plus = kid(e, "plus")
        let minus = kid(e, "minus")
        let p: [ChartValue] = plus != nil ? numbers(plus).map { $0.map { Swift.abs($0) } } : []
        let m: [ChartValue] = minus != nil ? numbers(minus).map { $0.map { Swift.abs($0) } } : []
        if p.contains(where: { $0 != nil }) { bars.plus = p }
        if m.contains(where: { $0 != nil }) && m != p { bars.minus = m }
    }
    if let dir = val(e, "errBarType") {
        if dir == "plus" { bars.direction = .plus }
        else if dir == "minus" { bars.direction = .minus }
    }
    if bool(val(e, "noEndCap")) { bars.cap = false }
    return bars
}

internal func uniqueStrings(_ list: [String]) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    for item in list where seen.insert(item).inserted {
        out.append(item)
    }
    return out
}

/**
 * Reads a DrawingML chart part (`c:chartSpace`) or an Office 2016 chartex part (`cx:chartSpace`).
 */
public func chartFromOoxml(_ xml: String) -> ChartOoxmlReadResult {
    var issues: [ChartIssue] = []
    var unsupported: [String] = []
    let doc = parseChartXml(xml)
    guard let root = doc.documentElement,
          root.localName == "chartSpace",
          doc.getElementsByTagName("parsererror").isEmpty else {
        return ChartOoxmlReadResult(
            spec: normalizeChartSpec(.object(JSONObject())).spec,
            issues: [ChartIssue(path: "", message: "This is not a chart part: expected a c:chartSpace (or cx:chartSpace) root element.")],
            unsupported: unsupported,
            lossless: false
        )
    }
    if (root.namespaceURI?.contains("chartex") ?? false) || kid(root, "chartData") != nil {
        return readChartex(root, &issues, &unsupported)
    }

    let chart = kid(root, "chart")
    let plot = kid(chart, "plotArea")
    var input = JSONObject([("type", .string("bar"))])
    if let titleEl = kid(chart, "title"), !bool(val(chart, "autoTitleDeleted")) {
        input["title"] = .string(richText(titleEl) ?? "")
    }
    let legend = kid(chart, "legend")
    let legendPos = LEGEND_IN[val(legend, "legendPos") ?? "r"] ?? .right
    input["legend"] = .object(JSONObject([
        ("show", .bool(legend != nil)),
        ("position", .string(legendPos.rawValue))
    ]))
    if kid(root, "roundedCorners") != nil && bool(val(root, "roundedCorners")) {
        unsupported.append("rounded corners")
    }

    let valAxes = kids(plot, "valAx")
    func vertical(_ a: MiniXmlElement) -> Bool {
        let p = val(a, "axPos") ?? ""
        return p == "l" || p == "r"
    }
    func secondaryPlaced(_ a: MiniXmlElement) -> Bool {
        let p = val(a, "axPos") ?? ""
        return val(a, "crosses") == "max" || p == "r" || p == "t"
    }
    func groupValAxis(_ g: MiniXmlElement) -> MiniXmlElement? {
        let ids = kids(g, "axId").map { $0.getAttribute("val") }
        let axes = ids.compactMap { id in valAxes.first { val($0, "axId") == id } }
        return axes.first(where: vertical) ?? axes.first
    }
    let groups = kids(plot).filter { $0.localName.hasSuffix("Chart") }
    let used = groups.compactMap(groupValAxis)
    let primaryAxis = used.first { !secondaryPlaced($0) } ?? used.first

    var series: [JSONObject] = []
    var categories: [String] = []
    var types: [ChartType] = []
    var stacking: ChartStacking = .none
    var orientation: ChartOrientation = .vertical
    var dataLabels = false
    var points = false

    for g in groups {
        let name = g.localName
        let grouping = val(g, "grouping") ?? "clustered"
        let type: ChartType
        if name.contains("3D") {
            let flatName = name.replacingOccurrences(of: "3DChart", with: "")
            unsupported.append("3-D \(flatName) chart (drawn flat)")
        }
        switch name {
        case "barChart", "bar3DChart":
            type = .bar
            if val(g, "barDir") == "bar" { orientation = .horizontal }
        case "lineChart", "line3DChart":
            type = .line
            if kids(g, "ser").contains(where: { s in
                let sym = val(kid(s, "marker"), "symbol") ?? (bool(val(g, "marker"), true) ? "auto" : "none")
                return sym != "none"
            }) {
                points = true
            }
        case "areaChart", "area3DChart":
            type = .area
        case "pieChart", "pie3DChart", "ofPieChart":
            type = .pie
            if name == "ofPieChart" { unsupported.append("pie-of-pie (drawn as one pie)") }
        case "doughnutChart":
            type = .donut
            let hs = numberOf(val(g, "holeSize")) ?? 50.0
            input["innerRadius"] = .number(Swift.min(0.9, Swift.max(0.0, hs / 100.0)))
        case "scatterChart":
            type = .scatter
            if (val(g, "scatterStyle") ?? "").lowercased().contains("line") { points = true }
        case "bubbleChart":
            type = .bubble
        case "radarChart":
            type = .radar
        default:
            let base = name.hasSuffix("Chart") ? String(name.dropLast(5)) : name
            unsupported.append("\(base) chart")
            continue
        }
        if grouping == "stacked" { stacking = .stacked }
        else if grouping == "percentStacked" { stacking = .percent }
        let gap = numberOf(val(g, "gapWidth"))
        let overlap = numberOf(val(g, "overlap"))
        if type == .bar {
            let n = Double(Swift.max(1, kids(g, "ser").count))
            let g100 = (gap ?? 150.0) / 100.0
            let defaultOverlap = grouping == "clustered" ? 0.0 : 100.0
            let o = Swift.max(-1.0, Swift.min(1.0, (overlap ?? defaultOverlap) / 100.0))
            let barsWidth = grouping == "clustered" ? n - (n - 1.0) * o : 1.0
            let gw = JS.round(Swift.max(0.0, Swift.min(0.9, g100 / (barsWidth + g100))) * 100.0) / 100.0
            input["gapWidth"] = .number(gw == 0 ? 0 : gw)
            if grouping == "clustered" {
                input["overlap"] = .number(o == 0 ? 0 : o)
            }
        }
        if bool(val(kid(g, "dLbls"), "showVal")) { dataLabels = true }
        types.append(type)
        let axis = groupValAxis(g)
        let secondary = axis != nil && primaryAxis != nil && axis !== primaryAxis

        for s in kids(g, "ser").prefix(1000) {
            var out = JSONObject([
                ("id", .string("series-\(series.count + 1)")),
                ("name", .string(strings(kid(s, "tx")).first ?? "Series \(series.count + 1)")),
                ("values", .array([]))
            ])
            if let color = solidColor(kid(s, "spPr")) { out["color"] = .string(color) }
            if type != .bubble { out["type"] = .string(type.rawValue) }
            if secondary { out["axis"] = .string("secondary") }
            if let marker = val(kid(s, "marker"), "symbol"),
               let mapped = MARKERS[marker],
               mapped != .circle,
               (type == .scatter || mapped != .none),
               (type == .line || type == .scatter) {
                out["marker"] = .string(mapped.rawValue)
            }
            if bool(val(s, "smooth")) { out["curve"] = .string("smooth") }
            let sl = kid(s, "dLbls")
            if sl != nil && val(sl, "showVal") != nil {
                out["dataLabels"] = .bool(bool(val(sl, "showVal")))
            }
            let labelCode = [kid(sl, "numFmt"), kid(kid(g, "dLbls"), "numFmt")]
                .compactMap { $0 }
                .first { $0.getAttribute("sourceLinked") != "1" }?
                .getAttribute("formatCode")
            let valueEl = kid(s, "val") ?? kid(s, "yVal")
            let code = labelCode ?? formatCodeOf(valueEl)
            if let code, !code.isEmpty, code != "General" {
                out["format"] = .object(JSONObject([("code", .string(code))]))
            }
            let catEl = kid(s, "cat") ?? kid(s, "xVal")
            let cats = strings(catEl)
            if type == .scatter || type == .bubble {
                let xs = cats.map { numberOf($0.jsTrimmed) }
                if xs.contains(where: { $0 != nil }) {
                    out["x"] = .array(xs.map { $0.map(JSONValue.number) ?? .null })
                }
            }
            if categories.isEmpty && !cats.isEmpty { categories = cats }
            out["values"] = .array(numbers(valueEl).map { $0.map(JSONValue.number) ?? .null })
            if type == .bubble {
                out["sizes"] = .array(numbers(kid(s, "bubbleSize")).map { $0.map(JSONValue.number) ?? .null })
            }
            let dPts = kids(s, "dPt")
            if !dPts.isEmpty {
                var pc: [String?] = []
                for dp in dPts {
                    if let idxStr = val(dp, "idx"),
                       let i = Int(idxStr),
                       i >= 0,
                       i < MAX_POINTS,
                       let c = solidColor(kid(dp, "spPr")) {
                        while pc.count <= i { pc.append(nil) }
                        pc[i] = c
                    }
                }
                if pc.contains(where: { $0 != nil }) {
                    out["pointColors"] = .array(pc.map { $0.map(JSONValue.string) ?? .null })
                }
            }
            var trends: [JSONValue] = []
            for t in kids(s, "trendline") {
                guard let kind = TREND_IN[val(t, "trendlineType") ?? ""] else { continue }
                var line = JSONObject([("type", .string(kind.rawValue))])
                let order = numberOf(val(t, "order"))
                let period = numberOf(val(t, "period"))
                if kind == .polynomial, let order, order != 0 { line["order"] = .number(order) }
                if kind == .movingAverage, let period, period != 0 { line["period"] = .number(period) }
                for k in ["forward", "backward", "intercept"] {
                    if let n = numberOf(val(t, k)), (k == "intercept" || n > 0) {
                        line[k] = .number(n)
                    }
                }
                if bool(val(t, "dispEq")) { line["showEquation"] = .bool(true) }
                if bool(val(t, "dispRSqr")) { line["showR2"] = .bool(true) }
                if let tName = kid(t, "name")?.textContent, !tName.isEmpty {
                    line["name"] = .string(tName)
                }
                if let tc = solidColor(kid(t, "spPr")) {
                    line["color"] = .string(tc)
                }
                trends.append(.object(line))
            }
            if !trends.isEmpty { out["trendlines"] = .array(trends) }

            for e in kids(s, "errBars") {
                guard let bars = readErrorBars(e) else {
                    unsupported.append("error bars of type \"\(val(e, "errValType") ?? "undefined")\"")
                    continue
                }
                if val(e, "errDir") == "x" {
                    if type == .scatter || type == .bubble {
                        out["xErrorBars"] = bars.toJSON()
                    } else {
                        unsupported.append("x error bars on a category chart")
                    }
                } else if type == .pie || type == .donut || type == .radar {
                    unsupported.append("error bars on a \(type.rawValue) chart")
                } else {
                    out["errorBars"] = bars.toJSON()
                }
            }
            series.append(out)
        }
    }

    if types.isEmpty {
        let msg = !unsupported.isEmpty
            ? "The chart type is not supported: \(unsupported.joined(separator: ", "))."
            : "The chart has no plot groups."
        issues.append(ChartIssue(path: "plotArea", message: msg))
        return ChartOoxmlReadResult(
            spec: normalizeChartSpec(.object(input)).spec,
            issues: issues,
            unsupported: unsupported,
            lossless: false
        )
    }

    let first = types[0]
    let combo = types.contains { $0 != first }
    let mainType: ChartType = combo ? (types.contains(.bar) ? .bar : first) : first
    input["type"] = .string(mainType.rawValue)
    if !combo {
        for i in 0..<series.count { series[i]["type"] = nil }
    } else {
        for i in 0..<series.count {
            if series[i]["type"]?.stringValue == mainType.rawValue {
                series[i]["type"] = nil
            }
        }
    }
    if !combo {
        for s in series where s["axis"] != nil {
            let sName = s["name"]?.stringValue ?? ""
            issues.append(ChartIssue(path: "series", message: "\"\(sName)\" is on a second value axis."))
        }
    }
    if combo && types.contains(where: { !isCartesianChart($0) }) {
        unsupported.append("a pie or radar mixed with other chart types")
    }
    input["series"] = .array(series.map(JSONValue.object))
    let maxValuesLen = series.reduce(0) { Swift.max($0, $1["values"]?.arrayValue?.count ?? 0) }
    let finalCats = !categories.isEmpty ? categories : (0..<maxValuesLen).map { "\($0 + 1)" }
    input["categories"] = .array(finalCats.map(JSONValue.string))
    input["stacking"] = .string(stacking.rawValue)
    input["orientation"] = .string(orientation.rawValue)
    input["dataLabels"] = .bool(dataLabels)
    input["points"] = .bool(points || first != .line)
    if bool(val(groups[0], "varyColors")) && !combo && isCartesianChart(first) && series.count == 1 {
        input["varyColors"] = .bool(true)
    }

    func readAxis(_ a: MiniXmlElement?, _ fallback: ChartAxis) -> JSONObject {
        var axis = fallback.toJSON().objectValue ?? JSONObject()
        axis["format"] = .object(JSONObject())
        guard let a else { return axis }
        axis["show"] = .bool(!bool(val(a, "delete")))
        axis["title"] = .string(richText(kid(a, "title")) ?? "")
        axis["gridlines"] = .bool(kid(a, "majorGridlines") != nil)
        let scaling = kid(a, "scaling")
        axis["min"] = numberOf(val(scaling, "min")).map(JSONValue.number) ?? .null
        axis["max"] = numberOf(val(scaling, "max")).map(JSONValue.number) ?? .null
        if val(scaling, "orientation") == "maxMin" { axis["reverse"] = .bool(true) }
        if kid(scaling, "logBase") != nil {
            if a.localName != "valAx" {
                unsupported.append("a logarithmic category axis")
            } else {
                axis["scale"] = .string("log")
                let base = numberOf(val(scaling, "logBase")) ?? 10.0
                if base != 10.0 { axis["logBase"] = .number(base) }
            }
        }
        axis["step"] = numberOf(val(a, "majorUnit")).map(JSONValue.number) ?? .null
        let fmt = kid(a, "numFmt")
        let code = fmt?.getAttribute("formatCode")
        if let code, !code.isEmpty, code != "General", fmt?.getAttribute("sourceLinked") != "1" {
            axis["format"] = .object(JSONObject([("code", .string(code))]))
        }
        return axis
    }

    let xy = first == .scatter || first == .bubble
    let catAxis = kid(plot, "catAx") ?? kid(plot, "dateAx") ?? (xy ? valAxes.first(where: { !vertical($0) }) : nil)
    var xAxisObj = readAxis(catAxis, defaultChartAxis(false))
    if kid(plot, "dateAx") != nil { xAxisObj["kind"] = .string("date") }
    input["xAxis"] = .object(xAxisObj)
    input["yAxis"] = .object(readAxis(primaryAxis ?? valAxes.first(where: vertical) ?? valAxes.first, defaultChartAxis(true)))
    let secondaryAxis = valAxes.first { a in
        a !== primaryAxis && (xy ? vertical(a) && a !== primaryAxis : true) && a !== catAxis
    }
    if series.contains(where: { $0["axis"]?.stringValue == "secondary" }), let secondaryAxis {
        input["yAxis2"] = .object(readAxis(secondaryAxis, defaultChartAxis(false)))
    }
    let normalized = normalizeChartSpec(.object(input))
    issues.append(contentsOf: normalized.issues)
    let uniq = uniqueStrings(unsupported)
    return ChartOoxmlReadResult(
        spec: normalized.spec,
        issues: issues,
        unsupported: uniq,
        lossless: uniq.isEmpty && normalized.issues.isEmpty
    )
}

internal func readChartex(
    _ root: MiniXmlElement,
    _ issues: inout [ChartIssue],
    _ unsupported: inout [String]
) -> ChartOoxmlReadResult {
    struct ChartexDataEntry {
        var categories: [String]
        var values: [ChartValue]
        var code: String?
        var paths: [[String]]?
    }
    var data: [String: ChartexDataEntry] = [:]
    for d in kids(kid(root, "chartData"), "data") {
        let id = d.getAttribute("id") ?? String(data.count)
        let strDim = kids(d, "strDim").first
        let numDim = kids(d, "numDim").first
        func lvl(_ dim: MiniXmlElement?) -> MiniXmlElement? { kids(dim, "lvl").first }
        let cats = kids(lvl(strDim), "pt").map { $0.textContent }
        let levels: [[String]] = kids(strDim, "lvl").map { l in
            var out: [String] = []
            for p in kids(l, "pt") {
                let idx = Int(p.getAttribute("idx") ?? "") ?? out.count
                while out.count <= idx { out.append("") }
                out[idx] = p.textContent.jsTrimmed
            }
            return out
        }
        var paths: [[String]]? = nil
        if levels.count > 1 {
            var carried = Array(repeating: "", count: levels.count)
            paths = levels[0].indices.map { i in
                var p: [String] = []
                for k in stride(from: levels.count - 1, through: 1, by: -1) {
                    let name = i < levels[k].count ? levels[k][i] : ""
                    if !name.isEmpty {
                        carried[k] = name
                        for j in 1..<k { carried[j] = "" }
                    }
                    if !carried[k].isEmpty { p.append(carried[k]) }
                }
                if !levels[0][i].isEmpty { p.append(levels[0][i]) }
                return p
            }
        }
        var values: [ChartValue] = []
        let nl = lvl(numDim)
        for p in kids(nl, "pt") {
            let i = Int(p.getAttribute("idx") ?? "") ?? values.count
            while values.count < i { values.append(nil) }
            let val = numberOf(p.textContent.jsTrimmed)
            if values.count == i { values.append(val) }
            else { values[i] = val }
        }
        data[id] = ChartexDataEntry(categories: cats, values: values, code: nl?.getAttribute("formatCode"), paths: paths)
    }

    let chart = kid(root, "chart")
    let region = path(chart, "plotArea", "plotAreaRegion")
    let seriesEls = kids(region, "series")
    let layouts: [String: ChartType] = [
        "waterfall": .waterfall,
        "funnel": .funnel,
        "treemap": .treemap,
        "sunburst": .sunburst,
        "boxWhisker": .box,
        "clusteredColumn": .histogram,
        "paretoLine": .histogram
    ]
    let layout = seriesEls.first?.getAttribute("layoutId") ?? ""
    guard let type = layouts[layout] else {
        let name = layout.isEmpty ? "unknown" : layout
        issues.append(ChartIssue(path: "plotArea", message: "The chart layout \"\(name)\" is not supported."))
        return ChartOoxmlReadResult(
            spec: normalizeChartSpec(.object(JSONObject())).spec,
            issues: issues,
            unsupported: [layout.isEmpty ? "unknown chartex layout" : layout],
            lossless: false
        )
    }
    if layout == "paretoLine" { unsupported.append("pareto line") }
    var series: [JSONObject] = []
    var categories: [String] = []
    for s in seriesEls {
        if s.getAttribute("layoutId") == "paretoLine" { continue }
        let ref = kid(s, "dataId")?.getAttribute("val") ?? "0"
        guard let d = data[ref] else { continue }
        if categories.isEmpty { categories = d.categories }
        var out = JSONObject([
            ("id", .string("series-\(series.count + 1)")),
            ("name", .string(strings(kid(s, "tx")).first ?? "Series \(series.count + 1)")),
            ("values", .array(d.values.map { $0.map(JSONValue.number) ?? .null }))
        ])
        if let code = d.code, !code.isEmpty, code != "General" {
            out["format"] = .object(JSONObject([("code", .string(code))]))
        }
        series.append(out)
    }
    let title = richText(kid(chart, "title"))
    let longest = series.reduce(0) { Swift.max($0, $1["values"]?.arrayValue?.count ?? 0) }
    let finalCats: [String] = categories.count >= longest
        ? categories
        : (0..<longest).map { i in i < categories.count ? categories[i] : "\(i + 1)" }
    var input = JSONObject([
        ("type", .string(type.rawValue)),
        ("title", .string(title ?? "")),
        ("series", .array(series.map(JSONValue.object))),
        ("categories", .array(finalCats.map(JSONValue.string)))
    ])
    if type == .waterfall { input["showTotal"] = .bool(false) }
    let firstRef = kid(seriesEls.first, "dataId")?.getAttribute("val") ?? "0"
    if (type == .treemap || type == .sunburst), let first = data[firstRef], let firstPaths = first.paths {
        var treeIssues: [ChartIssue] = []
        let rows: [(path: [JSONValue], value: JSONValue?)] = firstPaths.enumerated().map { i, p in
            let v = (i < first.values.count ? first.values[i] : nil) ?? 0
            return (path: p.map(JSONValue.string), value: .number(v))
        }
        let tree = chartTreeFromRows(rows, &treeIssues)
        input["tree"] = .array(tree.map { $0.toJSON() })
        for t in treeIssues {
            issues.append(ChartIssue(path: "chartData", message: t.message))
        }
    }
    let normalized = normalizeChartSpec(.object(input))
    issues.append(contentsOf: normalized.issues)
    return ChartOoxmlReadResult(
        spec: normalized.spec,
        issues: issues,
        unsupported: unsupported,
        lossless: unsupported.isEmpty && normalized.issues.isEmpty
    )
}
