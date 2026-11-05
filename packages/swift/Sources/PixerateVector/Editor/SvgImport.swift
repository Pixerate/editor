import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// SVG import (`parseVectorSvg` in `vector/svg.ts`), DOM-free like the TS: `<svg>`, `<g>`, `<a>`,
// `<switch>`, `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`, `<polyline>`, `<polygon>`,
// linear and radial gradients (through `href` chains), presentation attributes, `<style>` rules,
// `style` declarations, `transform`s, `fill-opacity` / `stroke-opacity` (as paint stacks),
// `clip-path` and `mask` references (each a mask group, the clip or mask first), and this editor's
// own export: live corners, paint stacks, stroke settings kept on a `<g data-vector-path>`, and
// live boolean groups. Text, `<use>` and symbols, filters, frames, own mask groups, instances,
// path effects, blends, shading, connectors, generated art, lenses and resizing constraints throw
// `VectorNotPorted` (#624). Regular expressions are the TS ones with
// JavaScript's `\s` and `\w` spelled out, since ICU's differ.

/// JavaScript's `\s`.
private let WS = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"
/// JavaScript's `\w`.
private let W = "A-Za-z0-9_"

private func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: options)
}

private extension NSRegularExpression {
    /// Every match (`/g` with `exec`), as the captured groups (nil when a group did not take part).
    func all(_ s: String) -> [[String?]] {
        let ns = s as NSString
        return matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
            (0 ..< m.numberOfRanges).map { i in m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
        }
    }

    /// The first match's groups (`exec`).
    func first(_ s: String) -> [String?]? {
        let ns = s as NSString
        guard let m = firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0 ..< m.numberOfRanges).map { i in m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
    }

    /// `s.replace(re, fn)` for a global regular expression.
    func replace(_ s: String, _ fn: ([String?]) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            out += fn((0 ..< m.numberOfRanges).map { i in m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) })
            last = m.range.location + m.range.length
        }
        return out + ns.substring(from: last)
    }

    /// `s.split(re)` (ECMA-262 `@@split`: an empty match at the current start does not split).
    func split(_ s: String) -> [String] {
        let ns = s as NSString
        let size = ns.length
        if size == 0 { return firstMatch(in: s, range: NSRange(location: 0, length: 0)) != nil ? [] : [s] }
        var out: [String] = []
        var p = 0
        var q = 0
        while q < size {
            let m = firstMatch(in: s, options: [.anchored, .withTransparentBounds], range: NSRange(location: q, length: size - q))
            let e = m.map { $0.range.location + $0.range.length } ?? p
            if m == nil || e == p {
                q += 1
                continue
            }
            out.append(ns.substring(with: NSRange(location: p, length: q - p)))
            p = e
            q = p
        }
        out.append(ns.substring(from: p))
        return out
    }
}

// MARK: - XML

/// An element of the tiny XML reader (`Element`).
final class SvgElement {
    let name: String
    var attrs: [String: String]
    var children: [SvgElement] = []
    /// Character data and elements of text content elements, in order.
    var content: [SvgContent]?

    init(name: String, attrs: [String: String]) {
        self.name = name
        self.attrs = attrs
    }
}

enum SvgContent {
    case text(String)
    case element(SvgElement)
}

private let TEXT_CONTENT: Set<String> = ["text", "tspan", "textPath", "style"]

private let COMMENT = regex("<!--[\\s\\S]*?-->")
private let PI = regex("<\\?[\\s\\S]*?\\?>")
private let CDATA = regex("<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
private let DOCTYPE = regex("<!DOCTYPE[^>\\[]*(\\[[\\s\\S]*?\\])?[\(WS)]*>", .caseInsensitive)
private let TAG = regex("<(\\/?)([A-Za-z_][\(W):.-]*)((?:[\(WS)]+[^\(WS)=/>]+(?:[\(WS)]*=[\(WS)]*(?:\"[^\"]*\"|'[^']*'|[^\(WS)>]+))?)*)[\(WS)]*(\\/?)>")
private let ATTR = regex("([^\(WS)=/>]+)(?:[\(WS)]*=[\(WS)]*(?:\"([^\"]*)\"|'([^']*)'|([^\(WS)>]+)))?")

private let HEX_ENTITY = regex("&#x([0-9a-f]+);", .caseInsensitive)
private let DEC_ENTITY = regex("&#(\\d+);")

private func codePoint(_ n: Int?) -> String {
    // `String.fromCodePoint` throws past U+10FFFF; such references are kept as they are here.
    guard let n, let s = Unicode.Scalar(UInt32(clamping: n)) else { return "\u{FFFD}" }
    return String(Character(s))
}

func decodeSvgEntities(_ s: String) -> String {
    var out = HEX_ENTITY.replace(s) { codePoint(Int($0[1]!, radix: 16)) }
    out = DEC_ENTITY.replace(out) { codePoint(Int($0[1]!)) }
    return out.replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&apos;", with: "'").replacingOccurrences(of: "&lt;", with: "<")
        .replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&amp;", with: "&")
}

/// A tiny non-validating XML reader (`parseXml`): elements and attributes, and the character data
/// of text content elements. Returns the first `<svg>` element.
func parseSvgXml(_ source: String) -> SvgElement? {
    var text = COMMENT.replace(source) { _ in "" }
    text = PI.replace(text) { _ in "" }
    text = CDATA.replace(text) { _ in "" }
    text = DOCTYPE.replace(text) { _ in "" }
    let ns = text as NSString
    let root = SvgElement(name: "#root", attrs: [:])
    var stack = [root]
    var last = 0
    for m in TAG.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        func group(_ i: Int) -> String { m.range(at: i).location == NSNotFound ? "" : ns.substring(with: m.range(at: i)) }
        let top = stack[stack.count - 1]
        if m.range.location > last && TEXT_CONTENT.contains(top.name) {
            top.content = (top.content ?? []) + [.text(decodeSvgEntities(ns.substring(with: NSRange(location: last, length: m.range.location - last))))]
        }
        last = m.range.location + m.range.length
        var name = group(2)
        if name.hasPrefix("svg:") { name.removeFirst(4) }
        if !group(1).isEmpty {
            for i in stride(from: stack.count - 1, to: 0, by: -1) where stack[i].name == name {
                stack.removeSubrange(i...)
                break
            }
            continue
        }
        var attrs: [String: String] = [:]
        for a in ATTR.all(group(3)) { attrs[a[1]!] = decodeSvgEntities(a[2] ?? a[3] ?? a[4] ?? "") }
        let el = SvgElement(name: name, attrs: attrs)
        stack[stack.count - 1].children.append(el)
        if TEXT_CONTENT.contains(top.name) { top.content = (top.content ?? []) + [.element(el)] }
        if group(4).isEmpty { stack.append(el) }
    }
    func find(_ el: SvgElement) -> SvgElement? {
        if el.name == "svg" { return el }
        for c in el.children { if let f = find(c) { return f } }
        return nil
    }
    return find(root)
}

// MARK: - CSS

private struct CssRule {
    var selector: String
    var properties: [(String, String)]
}

private let CSS_COMMENT = regex("/\\*[\\s\\S]*?\\*/")
private let CSS_RULE = regex("([^{]+)\\{([^}]+)\\}")
private let IMPORTANT_ALL = regex("!important", .caseInsensitive)
private let SPACES = regex("[\(WS)]+")
private let TAG_NAME = regex("^[a-zA-Z_][\(W):.-]*$")
private let TAG_CLASS = regex("^([a-zA-Z_][\(W):.-]*)\\.([a-zA-Z0-9_-]+)$")

private func parseCssRules(_ cssText: String) -> [CssRule] {
    var rules: [CssRule] = []
    let clean = CSS_COMMENT.replace(cssText) { _ in "" }
    for m in CSS_RULE.all(clean) {
        let selector = m[1]!.jsTrimmed
        let body = m[2]!.jsTrimmed
        var properties: [(String, String)] = []
        for decl in body.components(separatedBy: ";") {
            guard let i = decl.firstIndex(of: ":"), i != decl.startIndex else { continue }
            let prop = String(decl[..<i]).jsTrimmed.jsLowercased
            let val = IMPORTANT_ALL.replace(String(decl[decl.index(after: i)...])) { _ in "" }.jsTrimmed
            guard !prop.isEmpty, !val.isEmpty else { continue }
            if let k = properties.firstIndex(where: { $0.0 == prop }) { properties[k].1 = val } else { properties.append((prop, val)) }
        }
        if !properties.isEmpty { rules.append(CssRule(selector: selector, properties: properties)) }
    }
    return rules
}

private func collectStyleRules(_ el: SvgElement, _ rules: inout [CssRule]) {
    if el.name == "style" {
        let raw = (el.content ?? []).map { if case .text(let t) = $0 { t } else { "" } }.joined()
        rules += parseCssRules(raw)
    }
    for child in el.children { collectStyleRules(child, &rules) }
}

private func classes(_ el: SvgElement) -> [String] { SPACES.split(el.attrs["class"] ?? "") }

private func matchesSelector(_ el: SvgElement, _ selector: String) -> Bool {
    let sel = selector.jsTrimmed
    if sel.isEmpty { return false }
    if sel.contains(",") { return sel.components(separatedBy: ",").contains { matchesSelector(el, $0) } }
    if sel.hasPrefix(".") { return classes(el).contains(String(sel.dropFirst()).jsTrimmed) }
    if sel.hasPrefix("#") { return el.attrs["id"] == String(sel.dropFirst()).jsTrimmed }
    if TAG_NAME.first(sel) != nil { return el.name.jsLowercased == sel.jsLowercased }
    if let m = TAG_CLASS.first(sel) {
        if el.name.jsLowercased != m[1]!.jsLowercased { return false }
        return classes(el).contains(m[2]!)
    }
    return false
}

// MARK: - Numbers and transforms

private let NUMBER_SPLIT = regex("[\(WS),]+|(?=-)(?<![eE])")

/// `numberList`: numbers separated by white space, commas or a minus sign.
func svgNumberList(_ s: String?) -> [Double] {
    NUMBER_SPLIT.split((s ?? "").jsTrimmed).filter { !$0.isEmpty }.map(\.jsToNumber).filter(\.isFinite)
}

/// `length`: `parseFloat`, or `fallback` when that is not finite.
private func length(_ s: String?, _ fallback: Double = 0) -> Double {
    guard let s else { return fallback }
    let n = s.jsParseFloat
    return n.isFinite ? n : fallback
}

/// `fraction`: a number or a percentage.
private func fraction(_ s: String?, _ fallback: Double) -> Double {
    guard let s else { return fallback }
    let n = s.jsParseFloat
    if !n.isFinite { return fallback }
    return s.jsTrimmed.hasSuffix("%") ? n / 100 : n
}

private let TRANSFORM = regex("(matrix|translate|scale|rotate|skewX|skewY)[\(WS)]*\\(([^)]*)\\)")

/// An SVG `transform` attribute as one matrix (`parseSvgTransform`); nil when it holds no
/// transform (the TS returns the `IDENTITY_MATRIX` object itself then).
public func parseSvgTransform(_ value: String?) -> VectorMatrix? {
    guard let value, !value.isEmpty else { return nil }
    var m: VectorMatrix?
    for t in TRANSFORM.all(value) {
        let n = svgNumberList(t[2])
        func at(_ i: Int) -> Double? { i < n.count ? n[i] : nil }
        var step = IDENTITY_MATRIX
        switch t[1]! {
        case "matrix": if n.count >= 6 { step = VectorMatrix(n[0], n[1], n[2], n[3], n[4], n[5]) }
        case "translate": step = translateMatrix(at(0) ?? 0, at(1) ?? 0)
        case "scale": step = scaleMatrix(at(0) ?? 1, at(1) ?? at(0) ?? 1)
        case "rotate": step = rotateMatrix(at(0) ?? 0, Vec2(at(1) ?? 0, at(2) ?? 0))
        case "skewX": step = VectorMatrix(1, 0, Foundation.tan(((at(0) ?? 0) * Double.pi) / 180), 1, 0, 0)
        default: step = VectorMatrix(1, Foundation.tan(((at(0) ?? 0) * Double.pi) / 180), 0, 1, 0, 0)
        }
        // SVG lists apply right to left: `translate(…) rotate(…)` rotates first.
        m = multiplyMatrices(step, m ?? IDENTITY_MATRIX)
    }
    return m
}

// MARK: - Styles

/// The inherited presentation properties (`InheritedStyle`), by the TS field names.
private typealias SvgStyle = [String: String]

private let STYLE_KEYS: [(String, String)] = [
    ("fill", "fill"), ("stroke", "stroke"), ("stroke-width", "strokeWidth"), ("stroke-linecap", "strokeLinecap"), ("stroke-linejoin", "strokeLinejoin"),
    ("stroke-dasharray", "strokeDasharray"), ("fill-rule", "fillRule"), ("fill-opacity", "fillOpacity"), ("stroke-opacity", "strokeOpacity"),
    ("mix-blend-mode", "mixBlendMode"), ("filter", "filter"),
]
private let STYLE_KEY = Dictionary(uniqueKeysWithValues: STYLE_KEYS)

private func readStyle(_ el: SvgElement, _ parent: SvgStyle, _ cssRules: [CssRule]? = nil) -> SvgStyle {
    var out = parent
    out["mixBlendMode"] = nil
    out["filter"] = nil
    for (attr, key) in STYLE_KEYS { if let v = el.attrs[attr] { out[key] = v.jsTrimmed } }
    for rule in cssRules ?? [] where matchesSelector(el, rule.selector) {
        for (prop, val) in rule.properties { if let key = STYLE_KEY[prop] { out[key] = val } }
    }
    for decl in (el.attrs["style"] ?? "").components(separatedBy: ";") {
        guard let i = decl.firstIndex(of: ":"), let key = STYLE_KEY[String(decl[..<i]).jsTrimmed] else { continue }
        let v = String(decl[decl.index(after: i)...])
        out[key] = (v.range(of: "!important").map { v.replacingCharacters(in: $0, with: "") } ?? v).jsTrimmed
    }
    return out
}

/// `style="a: b; …"` as declarations split at `:` (two parts only, later ones win).
private func styleDeclarations(_ el: SvgElement) -> [String: String] {
    var out: [String: String] = [:]
    for d in (el.attrs["style"] ?? "").components(separatedBy: ";") {
        let parts = d.components(separatedBy: ":").map(\.jsTrimmed)
        if parts.count == 2 { out[parts[0]] = parts[1] }
    }
    return out
}

/// An attribute, or the same property in the element's `style` (`attrOrStyle`).
private func attrOrStyle(_ el: SvgElement, _ name: String) -> String? {
    for decl in (el.attrs["style"] ?? "").components(separatedBy: ";") {
        guard let i = decl.firstIndex(of: ":"), String(decl[..<i]).jsTrimmed == name else { continue }
        let v = String(decl[decl.index(after: i)...])
        return (v.range(of: "!important").map { v.replacingCharacters(in: $0, with: "") } ?? v).jsTrimmed
    }
    return el.attrs[name]
}

private let URL_ID = regex("^url\\([\(WS)]*['\"]?#([^'\")\(WS)]+)['\"]?[\(WS)]*\\)")

/// The id an `url(#id)` reference names, or nil.
private func urlId(_ value: String?) -> String? { URL_ID.first((value ?? "").jsTrimmed)?[1] ?? nil }

// MARK: - Gradients

private let PAINT_SERVERS: Set<String> = ["linearGradient", "radialGradient", "pattern"]

private func collect(_ el: SvgElement, _ names: Set<String>, _ raw: inout [String: SvgElement]) {
    if names.contains(el.name), let id = el.attrs["id"] { raw[id] = el }
    for c in el.children { collect(c, names, &raw) }
}

private func readStops(_ el: SvgElement) -> [JSONValue] {
    el.children.filter { $0.name == "stop" }.map { c in
        let style = styleDeclarations(c)
        let raw = c.attrs["offset"] ?? "0"
        let offset = raw.hasSuffix("%") ? raw.jsParseFloat / 100 : raw.jsParseFloat
        var stop = JSONObject([("offset", .number(offset.isFinite ? Swift.max(0, Swift.min(1, offset)) : 0)), ("color", .string(style["stop-color"] ?? c.attrs["stop-color"] ?? "#000"))])
        if let opacity = style["stop-opacity"] ?? c.attrs["stop-opacity"] { stop["opacity"] = .number(opacity.jsParseFloat) }
        return .object(stop)
    }
}

/// A `<linearGradient>` / `<radialGradient>` as a vector gradient (`resolveGradient`).
private func resolveGradient(_ id: String, _ raw: [String: SvgElement]) -> JSONObject? {
    guard let first = raw[id] else { return nil }
    if let own = first.attrs["data-vector-gradient"], let g = sanitizeVectorGradient(try? JSONValue.parse(own)) { return g }
    if first.name == "pattern" { return nil }
    var chain: [SvgElement] = []
    var el: SvgElement? = first
    while let e = el, !chain.contains(where: { $0 === e }), chain.count < 32 {
        chain.append(e)
        let href = e.attrs["href"] ?? e.attrs["xlink:href"]
        el = href.flatMap { $0.hasPrefix("#") ? raw[String($0.dropFirst())] : nil }
    }
    func attr(_ name: String) -> String? { chain.first { $0.attrs[name] != nil }?.attrs[name] }
    let stops = chain.map(readStops).first { !$0.isEmpty } ?? []
    if stops.isEmpty { return nil }
    let user = attr("gradientUnits") == "userSpaceOnUse"
    let t = parseSvgTransform(attr("gradientTransform")) ?? IDENTITY_MATRIX
    let plain = t.a == 1 && t.b == 0 && t.c == 0 && t.d == 1 && t.e == 0 && t.f == 0
    func at(_ name: String, _ fallback: Double) -> Double { user ? length(attr(name), fallback) : fraction(attr(name), fallback) }
    let spread = attr("spreadMethod").flatMap { $0 == "reflect" || $0 == "repeat" ? $0 : nil }
    func map(_ x: Double, _ y: Double) -> JSONValue { applyMatrix(t, Vec2(x, y)).json }
    if first.name == "radialGradient" {
        let cx = at("cx", user ? 0 : 0.5)
        let cy = at("cy", user ? 0 : 0.5)
        let r = at("r", user ? 0 : 0.5)
        let fx = attr("fx") != nil ? at("fx", cx) : cx
        let fy = attr("fy") != nil ? at("fy", cy) : cy
        let fr = attr("fr") != nil ? at("fr", 0) : 0
        let focal = abs(fx - cx) > 1e-9 || abs(fy - cy) > 1e-9
        if !user && plain && !focal && !(fr > 0) {
            var g = JSONObject([("type", "radial"), ("cx", .number(cx)), ("cy", .number(cy)), ("r", .number(r)), ("stops", .array(stops))])
            if let spread { g["spread"] = .string(spread) }
            return g
        }
        var g = JSONObject([("type", "radial"), ("stops", .array(stops)), ("start", map(cx, cy)), ("end", map(cx + r, cy)), ("width", map(cx, cy + r)), ("units", .string(user ? "userSpaceOnUse" : "objectBoundingBox"))])
        if let spread { g["spread"] = .string(spread) }
        if focal { g["focal"] = map(fx, fy) }
        if fr > 0 && r > 0 { g["focalRadius"] = .number(Swift.min(0.99, fr / r)) }
        return g
    }
    let x1 = at("x1", 0)
    let y1 = at("y1", 0)
    let x2 = attr("x2") != nil ? at("x2", 1) : user ? 0 : 1
    let y2 = at("y2", 0)
    if !user && plain {
        // CSS angle: 0° points up, clockwise. Keep the shorthand when it paints the same.
        let deg = (JS.atan2(x2 - x1, -(y2 - y1)) * 180) / Double.pi + 360
        let angle = JS.round(deg.truncatingRemainder(dividingBy: 360))
        let c = angleToSvgLinearCoords(angle)
        let len = JS.hypot(x2 - x1, y2 - y1)
        let d = len > 0 ? Vec2((x2 - x1) / len, (y2 - y1) / len) : Vec2(0, 1)
        func along(_ x: Double, _ y: Double) -> Double { x * d.x + y * d.y }
        let same = len > 0 && abs((c.x2 - c.x1) * d.y - (c.y2 - c.y1) * d.x) < 1e-3 && abs(along(c.x1, c.y1) - along(x1, y1)) < 1e-3 && abs(along(c.x2, c.y2) - along(x2, y2)) < 1e-3
        if same {
            var g = JSONObject([("type", "linear"), ("angle", .number(angle)), ("stops", .array(stops))])
            if let spread { g["spread"] = .string(spread) }
            return g
        }
    }
    var g = JSONObject([("type", "linear"), ("stops", .array(stops)), ("start", map(x1, y1)), ("end", map(x2, y2)), ("width", map(x1 - (y2 - y1), y1 + (x2 - x1))), ("units", .string(user ? "userSpaceOnUse" : "objectBoundingBox"))])
    if let spread { g["spread"] = .string(spread) }
    return g
}

// MARK: - Corners

private let CORNER_ITEM = regex("^(\\d+)\\.(\\d+):([\\d.eE+-]+)(?::([a-z]+))?$")

/// Puts `data-vector-corners` back on subpaths (`applyVectorCornersAttribute`).
func applyVectorCornersAttribute(_ subpaths: [VectorSubpath], _ value: String) -> [VectorSubpath] {
    var out = subpaths
    for item in SPACES.split(value.jsTrimmed) {
        guard let m = CORNER_ITEM.first(item), let s = Int(m[1]!), let i = Int(m[2]!) else { continue }
        let radius = m[3]!.jsParseFloat
        guard s < out.count, i < out[s].anchors.count, radius > 0 else { continue }
        let kind = m[4].flatMap { $0 }.flatMap { VectorCornerKind(rawValue: $0) }
        out[s].anchors[i].corner = VectorCorner(radius: radius, kind: kind.flatMap { $0 == .round ? nil : $0.rawValue })
    }
    return out
}

// MARK: - Parsing

private let SKIP: Set<String> = ["defs", "clipPath", "mask", "symbol", "style", "title", "desc", "metadata", "pattern", "marker", "filter", "image", "linearGradient", "radialGradient", "script", "foreignObject"]
private let BOOLEAN_OPERATIONS = ["union", "subtract", "intersect", "exclude"]

/// Parses SVG markup into a vector document (`parseVectorSvg`). Throws when there is no `<svg>`
/// element. `createId` makes ids for elements without a usable `id` (default `node-1`, …).
public func parseVectorSvg(_ svg: String, createId: (() -> String)? = nil) throws -> VectorDocument {
    guard let root = parseSvgXml(svg) else { throw VectorEditorError("The markup has no <svg> element.") }
    return try SvgImporter(root: root, createId: createId).document()
}

private final class SvgImporter {
    let root: SvgElement
    var counter = 0
    var usedIds = Set<String>()
    let makeId: (() -> String)?
    var styleRules: [CssRule] = []
    var gradients: [String: SvgElement] = [:]
    var filters: [String: SvgElement] = [:]
    var masks: [String: SvgElement] = [:]
    var byId: [String: SvgElement] = [:]
    /// Masks being read (a mask that refers back to itself is ignored there).
    var resolving = Set<String>()
    /// The base style mask and clip content inherits.
    var rootStyle: SvgStyle = ["fill": "#000", "stroke": "none", "strokeWidth": ""]

    init(root: SvgElement, createId: (() -> String)?) {
        self.root = root
        makeId = createId
        collectStyleRules(root, &styleRules)
        collect(root, PAINT_SERVERS, &gradients)
        collect(root, ["filter"], &filters)
        collect(root, ["clipPath", "mask"], &masks)
        func index(_ el: SvgElement) {
            if let id = el.attrs["id"], byId[id] == nil { byId[id] = el }
            el.children.forEach(index)
        }
        index(root)
    }

    func createId() -> String {
        if let makeId { return makeId() }
        counter += 1
        return "node-\(counter)"
    }

    func idFor(_ el: SvgElement?) -> String {
        if let id = el?.attrs["id"], !id.isEmpty, !usedIds.contains(id) {
            usedIds.insert(id)
            return id
        }
        var next = createId()
        while usedIds.contains(next) { next = createId() }
        usedIds.insert(next)
        return next
    }

    func filtersOf(_ value: String?) throws -> [JSONValue] {
        guard let id = urlId(value), let el = filters[id] else { return [] }
        // not ported yet: filters (sanitizeVectorFilters) (#624)
        if el.attrs["data-vector-filters"] != nil { throw VectorNotPorted("importing filters") }
        let prims = el.children.filter { $0.name.hasPrefix("fe") }
        if prims.isEmpty { return [] }
        for p in prims {
            let blur = p.name == "feGaussianBlur" && prims.count == 1 && (p.attrs["in"] == nil || p.attrs["in"] == "SourceGraphic")
            if p.name != "feDropShadow" && !blur { return [] }
        }
        throw VectorNotPorted("importing filters")
    }

    func paint(_ value: String) -> JSONValue {
        let v = value.jsTrimmed
        if let id = urlId(v) { return resolveGradient(id, gradients).map { .object($0) } ?? .null }
        if v == "none" || v.isEmpty { return .null }
        return .string(v)
    }

    func shapeOf(_ el: SvgElement) -> [VectorSubpath]? {
        let a = el.attrs
        switch el.name {
        case "path":
            // Our own export: the sharp path and its live corners.
            if let d = a["data-vector-d"], !d.isEmpty, let corners = a["data-vector-corners"], !corners.isEmpty {
                let sharp = bezierToSubpaths(.svg(d))
                if !sharp.isEmpty { return applyVectorCornersAttribute(sharp, corners) }
            }
            guard let d = a["d"], !d.isEmpty else { return nil }
            return bezierToSubpaths(.svg(d))
        case "rect":
            let w = length(a["width"])
            let h = length(a["height"])
            if w <= 0 || h <= 0 { return nil }
            return [rectSubpath(VectorBounds(x: length(a["x"]), y: length(a["y"]), width: w, height: h), length(a["rx"] ?? a["ry"], 0))]
        case "circle":
            let r = length(a["r"])
            if r <= 0 { return nil }
            let cx = length(a["cx"])
            let cy = length(a["cy"])
            return [ellipseSubpath(VectorBounds(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))]
        case "ellipse":
            let rx = length(a["rx"])
            let ry = length(a["ry"])
            if rx <= 0 || ry <= 0 { return nil }
            return [ellipseSubpath(VectorBounds(x: length(a["cx"]) - rx, y: length(a["cy"]) - ry, width: 2 * rx, height: 2 * ry))]
        case "line":
            return [lineSubpath(Vec2(length(a["x1"]), length(a["y1"])), Vec2(length(a["x2"]), length(a["y2"])))]
        case "polyline", "polygon":
            let n = svgNumberList(a["points"])
            if n.count < 4 { return nil }
            var anchors: [VectorAnchor] = []
            var i = 0
            while i + 1 < n.count {
                anchors.append(VectorAnchor(x: n[i], y: n[i + 1]))
                i += 2
            }
            return [VectorSubpath(anchors: anchors, closed: el.name == "polygon")]
        default:
            return nil
        }
    }

    func strokeStyle(_ s: SvgStyle, into p: inout JSONObject) {
        if let w = s["strokeWidth"], !w.isEmpty { p["strokeWidth"] = .number(length(w, 1)) }
        if let v = s["strokeLinecap"], !v.isEmpty { p["strokeLinecap"] = .string(v) }
        if let v = s["strokeLinejoin"], !v.isEmpty { p["strokeLinejoin"] = .string(v) }
        if let v = s["strokeDasharray"], !v.isEmpty, v != "none" { p["strokeDasharray"] = .array(svgNumberList(v).map { .number($0) }) }
        if s["fillRule"] == "evenodd" { p["fillRule"] = "evenodd" }
    }

    /// A node mapped by `m` (scale and skew baked in, stroke width scaled; `placed`).
    func placed(_ node: VectorNode, _ m: VectorMatrix) throws -> VectorNode {
        var next = try transformVectorNode(node, m)
        let strokeScale = (abs(m.a * m.d - m.b * m.c)).squareRoot()
        if strokeScale > 0 && abs(strokeScale - 1) > 1e-9 {
            if hasPaint(next.stroke) { next.strokeWidth = (next.strokeWidth ?? 1) * strokeScale }
            if let strokes = next["strokes"]?.arrayValue {
                next["strokes"] = .array(strokes.map { l in
                    guard var o = l.objectValue, (o["kind"]?.stringValue ?? "paint") == "paint" else { return l }
                    o["strokeWidth"] = .number((o["strokeWidth"]?.numberValue ?? 1) * strokeScale)
                    return .object(o)
                })
            }
        }
        return normalizeVectorPaintStacks(next, prefer: "stack")
    }

    /// Paint with an element's `fill-opacity` / `stroke-opacity`: a one-layer stack below 1.
    func withOpacities(_ node: VectorNode, _ s: SvgStyle) -> VectorNode {
        var out = node
        let fo = s["fillOpacity"].map { fraction($0, 1) } ?? 1
        let so = s["strokeOpacity"].map { fraction($0, 1) } ?? 1
        if fo < 1 && hasPaint(out.fill) { out = withVectorFills(out, [JSONObject([("paint", out.fill!), ("opacity", .number(Swift.max(0, fo)))])]) }
        if so < 1 && hasPaint(out.stroke) {
            out = withVectorStrokes(out, vectorStrokes(out).map { l in
                var c = l
                c["opacity"] = .number(Swift.max(0, so))
                return c
            })
        }
        return out
    }

    /// A `<g data-vector-path data-vector-fills>` from our own export as the path it came from (`stackedPath`).
    func stackedPath(_ g: SvgElement, _ m: VectorMatrix, _ meta: JSONObject) throws -> VectorNode? {
        let fillEl = g.children.first { $0.name == "path" && $0.attrs["data-vector-part"] == "fill" }
        guard let subpaths = fillEl.flatMap(shapeOf), !subpaths.isEmpty else { return nil }
        func parse(_ v: String?) -> JSONValue { v.flatMap { try? JSONValue.parse($0) } ?? .array([]) }
        var props = JSONObject([("id", .string(idFor(g))), ("type", "path")])
        for (k, v) in meta { props[k] = v }
        var node = VectorNode(props: props, subpaths: subpaths)
        node.fill = .null
        node.stroke = .null
        if g.attrs["data-vector-fill-rule"] == "evenodd" { node.fillRule = "evenodd" }
        node = withVectorFills(node, try sanitizeVectorFills(parse(g.attrs["data-vector-fills"])))
        node = withVectorStrokes(node, try sanitizeVectorStrokes(parse(g.attrs["data-vector-strokes"])))
        return try placed(node, m)
    }

    /// A `<g data-vector-path>` from our own export (a stroke drawn in parts) as one path (`mergedPath`).
    func mergedPath(_ g: SvgElement, _ style: SvgStyle, _ m: VectorMatrix, _ meta: JSONObject) throws -> VectorNode? {
        func part(_ name: String) -> SvgElement? { g.children.first { $0.name == "path" && $0.attrs["data-vector-part"] == name } }
        guard let fillEl = part("fill"), let subpaths = shapeOf(fillEl), !subpaths.isEmpty else { return nil }
        let a = g.attrs
        let fs = readStyle(fillEl, style, styleRules)
        let strokeEl = part("stroke")
        let outlineEl = part("stroke-outline")
        let ss = strokeEl.map { readStyle($0, style) }
        let width = length(a["data-vector-stroke-width"], ss.map { length($0["strokeWidth"], 1) } ?? 1)
        func arrow(_ v: String?) -> String? { v.flatMap { VECTOR_ARROWHEADS.contains($0) ? $0 : nil } }
        func scale(_ v: String?) -> Double? {
            let n = v.map(\.jsParseFloat) ?? .nan
            return n > 0 ? n : nil
        }
        let profile = widthProfileFromAttribute(a["data-vector-width-profile"])
        func kept(_ key: String, _ values: [String]) -> String? { a[key].flatMap { values.contains($0) ? $0 : nil } }
        var props = JSONObject([("id", .string(idFor(g))), ("type", "path")])
        for (k, v) in meta { props[k] = v }
        props["subpaths"] = .null
        props["fill"] = paint(fs["fill"] ?? "")
        props["stroke"] = ss.map { paint($0["stroke"] ?? "") } ?? outlineEl.map { paint(readStyle($0, style, styleRules)["fill"] ?? "") } ?? .null
        if let ss { strokeStyle(ss, into: &props) }
        if fs["fillRule"] == "evenodd" { props["fillRule"] = "evenodd" }
        props["strokeWidth"] = .number(width)
        if let align = a["data-vector-stroke-align"], align == "inside" || align == "outside" { props["strokeAlign"] = .string(align) }
        if let v = arrow(a["data-vector-start-arrow"]) { props["startArrow"] = .string(v) }
        if let v = arrow(a["data-vector-end-arrow"]) { props["endArrow"] = .string(v) }
        if a["data-vector-arrow-align"] == "tip" { props["arrowAlign"] = "tip" }
        if let v = scale(a["data-vector-start-arrow-scale"]) { props["startArrowScale"] = .number(v) }
        if let v = scale(a["data-vector-end-arrow-scale"]) { props["endArrowScale"] = .number(v) }
        if !profile.isEmpty { props["strokeWidthProfile"] = widthProfileJSON(profile) }
        if let v = kept("data-vector-stroke-linecap", ["round", "square"]) { props["strokeLinecap"] = .string(v) }
        if let v = kept("data-vector-stroke-linejoin", ["round", "bevel"]) { props["strokeLinejoin"] = .string(v) }
        if let v = a["data-vector-stroke-dasharray"], !v.isEmpty {
            let dash = svgNumberList(v)
            if !dash.isEmpty { props["strokeDasharray"] = .array(dash.map { .number($0) }) }
        }
        return try placed(VectorNode(props: props, subpaths: subpaths), m)
    }

    /// A `<g data-vector-live>` from our own export as the node it came from (`liveNode`): live
    /// boolean groups; path effects, text and symmetry are not ported.
    func liveNode(_ g: SvgElement, _ style: SvgStyle, _ m: VectorMatrix, _ meta: JSONObject) throws -> VectorNode? {
        let raw = g.attrs["data-vector-live"].flatMap { try? JSONValue.parse($0) }?.objectValue ?? JSONObject()
        guard let sourceEl = g.children.first(where: { $0.name == "g" && $0.attrs["data-vector-part"] == "source" }) else { return nil }
        // not ported yet: path effects (sanitizeVectorEffects, transformVectorEffects), symmetry and blends (#624)
        if let e = raw["effects"]?.arrayValue, !e.isEmpty { throw VectorNotPorted("importing path effects") }
        if raw["kind"] == "text" || raw["kind"] == "path" { throw VectorNotPorted("importing live \(raw["kind"]!.stringValue!) nodes") }
        if raw["symmetry"] != nil && raw["symmetry"] != .null { throw VectorNotPorted("importing symmetry groups") }
        if g.attrs["data-vector-blend"] != nil { throw VectorNotPorted("importing blends") }
        let inner = try visit(sourceEl, style, m)
        let liveBoolean = raw["liveBoolean"]?.stringValue.flatMap { BOOLEAN_OPERATIONS.contains($0) ? $0 : nil }
        let id = idFor(g)
        if inner.isEmpty { return nil }
        var props = JSONObject([("id", .string(id)), ("type", "group")])
        for (k, v) in meta { props[k] = v }
        var group = VectorNode(props: props, children: inner)
        if let liveBoolean { group["liveBoolean"] = .string(liveBoolean) }
        return group
    }

    /// Maps a unit box onto the bounds of `nodes` (`bboxMatrix`).
    func bboxMatrix(_ nodes: [VectorNode]) throws -> VectorMatrix? {
        guard let b = unionBounds(try nodes.map { try vectorNodeBounds($0) }), b.width > 0, b.height > 0 else { return nil }
        return VectorMatrix(b.width, 0, 0, b.height, b.x, b.y)
    }

    /// The nodes a `<clipPath>` or `<mask>` holds as one mask node (`maskNode`).
    func maskNode(_ el: SvgElement, _ m: VectorMatrix, _ nodes: [VectorNode], _ units: String?) throws -> VectorNode? {
        guard let id = el.attrs["id"], !id.isEmpty, !resolving.contains(id) else { return nil }
        var space = m
        if units == "objectBoundingBox" {
            guard let box = try bboxMatrix(nodes) else { return nil }
            space = box
        }
        resolving.insert(id)
        let isClip = el.name == "clipPath"
        let content = isClip ? clipRulesAsFillRules(el) : el
        let inner = try visit(content, readStyle(content, rootStyle, styleRules), multiplyMatrices(parseSvgTransform(el.attrs["transform"]) ?? IDENTITY_MATRIX, space))
        resolving.remove(id)
        // A clip's paint is not drawn: imported clips are unpainted outlines.
        func strip(_ n: VectorNode) -> VectorNode {
            if n.isGroup {
                var g = n
                g.children = n.children.map(strip)
                return g
            }
            var c = n
            c.fill = .null
            c.stroke = .null
            return withVectorStrokes(withVectorFills(c, []), [])
        }
        let list = isClip ? inner.map(strip) : inner
        if list.isEmpty { return nil }
        if list.count == 1 { return list[0] }
        return VectorNode(props: JSONObject([("id", .string(idFor(nil))), ("type", "group"), ("name", .string(isClip ? "Clip" : "Mask"))]), children: list)
    }

    /// A `<clipPath>`'s content with each `clip-rule` read as the `fill-rule` import knows.
    func clipRulesAsFillRules(_ el: SvgElement) -> SvgElement {
        let copy = SvgElement(name: el.name, attrs: el.attrs)
        if let rule = attrOrStyle(el, "clip-rule"), !rule.isEmpty { copy.attrs["fill-rule"] = rule }
        copy.children = el.children.map(clipRulesAsFillRules)
        copy.content = el.content
        return copy
    }

    /// Nodes made from an element with `clip-path` and / or `mask`, wrapped in mask groups (`masked`).
    func masked(_ el: SvgElement, _ nodes: [VectorNode], _ m: VectorMatrix) throws -> [VectorNode] {
        var out = nodes
        if let clipEl = urlId(attrOrStyle(el, "clip-path")).flatMap({ masks[$0] }), clipEl.name == "clipPath",
           let source = try maskNode(clipEl, m, out, clipEl.attrs["clipPathUnits"]) {
            out = [VectorNode(props: JSONObject([("id", .string(idFor(nil))), ("type", "group"), ("name", "Clip Group"), ("mask", ["type": "clip"])]), children: [source] + out)]
        }
        if let maskEl = urlId(attrOrStyle(el, "mask")).flatMap({ masks[$0] }), maskEl.name == "mask",
           let source = try maskNode(maskEl, m, out, maskEl.attrs["maskContentUnits"]) {
            let type = attrOrStyle(maskEl, "mask-type") == "alpha" ? "alpha" : "luminance"
            out = [VectorNode(props: JSONObject([("id", .string(idFor(nil))), ("type", "group"), ("name", "Opacity Mask"), ("mask", .object(JSONObject([("type", .string(type))])))]), children: [source] + out)]
        }
        return out
    }

    func visit(_ el: SvgElement, _ style: SvgStyle, _ matrix: VectorMatrix) throws -> [VectorNode] {
        var out: [VectorNode] = []
        for child in el.children where !SKIP.contains(child.name) {
            let nodes = try visitOne(child, style, matrix)
            out += nodes.isEmpty ? nodes : try masked(child, nodes, multiplyMatrices(parseSvgTransform(child.attrs["transform"]) ?? IDENTITY_MATRIX, matrix))
        }
        return out
    }

    func visitOne(_ child: SvgElement, _ style: SvgStyle, _ matrix: VectorMatrix) throws -> [VectorNode] {
        let m = multiplyMatrices(parseSvgTransform(child.attrs["transform"]) ?? IDENTITY_MATRIX, matrix)
        let s = readStyle(child, style, styleRules)
        let opacity = child.attrs["opacity"].map(\.jsParseFloat)
        let hidden = child.attrs["display"] == "none" || child.attrs["visibility"] == "hidden"
        let blendMode = vectorBlendModeFromCss(s["mixBlendMode"])
        let filters = try filtersOf(s["filter"])
        var meta = JSONObject()
        let label = child.attrs["inkscape:label"]
        let dataName = child.attrs["data-name"]
        if !(label ?? "").isEmpty || !(dataName ?? "").isEmpty { meta["name"] = .string(label ?? dataName!) }
        if let o = opacity, o.isFinite, o < 1 { meta["opacity"] = .number(o) }
        if hidden { meta["visible"] = false }
        if let b = blendMode, b != "normal" { meta["blendMode"] = .string(b) }
        if !filters.isEmpty { meta["filters"] = .array(filters) }
        // A blend's in-betweens are regenerated from its keys.
        if child.attrs["data-vector-blend-step"] != nil { return [] }
        if let op = child.attrs["data-vector-boolean-operation"], BOOLEAN_OPERATIONS.contains(op) { meta["booleanOperation"] = .string(op) }
        // not ported yet: resizing constraints, connectors, generated art and lenses (#624)
        for (attr, what) in [("data-vector-resizing", "resizing constraints"), ("data-vector-connector", "connectors"), ("data-vector-generation", "generated art"), ("data-vector-lens", "lenses")] where child.attrs[attr] != nil {
            throw VectorNotPorted("importing \(what)")
        }
        let g = child.name == "g"
        // not ported yet: frames, own mask groups, instances and symbols, text (#624)
        if g && child.attrs["data-vector-frame"] != nil { throw VectorNotPorted("importing frames") }
        if g && child.attrs["data-vector-mask"] != nil { throw VectorNotPorted("importing mask groups") }
        if g && child.attrs["data-vector-live"] != nil { return try liveNode(child, s, m, meta).map { [$0] } ?? [] }
        if child.name == "use" {
            let href = (child.attrs["href"] ?? child.attrs["xlink:href"] ?? "").jsTrimmed
            if href.hasPrefix("#") && byId[String(href.dropFirst())] != nil { throw VectorNotPorted("importing <use> and symbols") }
            return []
        }
        if g && child.attrs["data-vector-instance"] != nil { throw VectorNotPorted("importing instances") }
        if (g && child.attrs["data-vector-text"] != nil) || child.name == "text" { throw VectorNotPorted("importing text") }
        if g && child.attrs["data-vector-path"] != nil && child.attrs["data-vector-fills"] != nil { return try stackedPath(child, m, meta).map { [$0] } ?? [] }
        if g && child.attrs["data-vector-path"] != nil { return try mergedPath(child, s, m, meta).map { [$0] } ?? [] }
        if g || child.name == "svg" || child.name == "a" || child.name == "switch" {
            let children = try visit(child, s, m)
            if children.isEmpty { return [] }
            if g && child.attrs["data-vector-blend"] != nil { throw VectorNotPorted("importing blends") }
            var props = JSONObject([("id", .string(idFor(child))), ("type", "group")])
            for (k, v) in meta { props[k] = v }
            return [VectorNode(props: props, children: children)]
        }
        guard let subpaths = shapeOf(child), !subpaths.isEmpty else { return [] }
        var props = JSONObject([("id", .string(idFor(child))), ("type", "path")])
        for (k, v) in meta { props[k] = v }
        props["subpaths"] = .null
        props["fill"] = child.name == "line" ? .null : (sanitizeVectorShadedPaint(child.attrs["data-vector-shading"].flatMap { try? JSONValue.parse($0) }).map { .object($0) } ?? paint(s["fill"] ?? ""))
        props["stroke"] = paint(s["stroke"] ?? "")
        strokeStyle(s, into: &props)
        return [try placed(withOpacities(VectorNode(props: props, subpaths: subpaths), s), m)]
    }

    func document() throws -> VectorDocument {
        let viewBox = svgNumberList(root.attrs["viewBox"])
        let width = viewBox.count == 4 ? viewBox[2] : length(root.attrs["width"], 300)
        let height = viewBox.count == 4 ? viewBox[3] : length(root.attrs["height"], 150)
        let rootMatrix = viewBox.count == 4 ? translateMatrix(-viewBox[0], -viewBox[1]) : IDENTITY_MATRIX
        rootStyle = readStyle(root, rootStyle, styleRules)
        // not ported yet: symbols (#624)
        func hasOwnSymbol(_ el: SvgElement) -> Bool { (el.name == "symbol" && el.attrs["data-vector-symbol"] != nil) || el.children.contains(where: hasOwnSymbol) }
        if hasOwnSymbol(root) { throw VectorNotPorted("importing symbols") }
        let nodes = try visit(root, rootStyle, rootMatrix)
        return VectorDocument(width: width, height: height, nodes: nodes)
    }
}

extension VectorEditorController {
    /// Adds the nodes of SVG markup on top of the document, selected (`importSvg`).
    @discardableResult
    public func importSvg(_ svg: String) throws -> VectorActionResult {
        let parsed: VectorDocument
        do {
            parsed = try parseVectorSvg(svg)
        } catch let e as VectorNotPorted {
            throw e
        } catch {
            return .failure("\(error)")
        }
        let nodes = try parsed.nodes.map { try freshIds($0) }
        if nodes.isEmpty { return .failure("The SVG has no shapes the editor can read.") }
        change("Import SVG") {
            setDoc(doc.nodes + nodes)
            selection = nodes.map(\.id)
            anchors = []
        }
        return .success
    }

    /// Replaces the document with parsed SVG markup, one undo step (`loadSvg`).
    @discardableResult
    public func loadSvg(_ svg: String) throws -> VectorActionResult {
        let parsed: VectorDocument
        do {
            parsed = try parseVectorSvg(svg, createId: createId)
        } catch let e as VectorNotPorted {
            throw e
        } catch {
            return .failure("\(error)")
        }
        let next = try loadedDocument(parsed)
        change("Import SVG") {
            doc = next
            selection = []
            anchors = []
            editingId = nil
            pen = nil
        }
        return .success
    }
}

/// Reads `data-vector-width-profile` (`t,left,right;…`; invalid points are dropped; `widthProfileFromAttribute`).
func widthProfileFromAttribute(_ value: String?) -> [VectorWidthPoint] {
    guard let value, !value.isEmpty else { return [] }
    let points: [JSONValue] = value.components(separatedBy: ";").map { part in
        let n = part.components(separatedBy: ",").map(\.jsParseFloat)
        let t = n.count > 0 ? n[0] : .nan
        let left = n.count > 1 ? n[1] : .nan
        let right = n.count > 2 && n[2].isFinite ? n[2] : left
        return .object(JSONObject([("t", .number(t)), ("left", .number(left)), ("right", .number(right))]))
    }
    return sanitizeWidthProfile(.array(points))
}
