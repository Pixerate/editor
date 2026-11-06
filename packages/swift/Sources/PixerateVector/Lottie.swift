// Portions after effectcraft's crates/lottie/src/shapes.rs and anim.rs (MIT OR Apache-2.0, ©
// ArtCraft Team and contributors) by way of packages/core/src/vector/lottie.ts. See
// THIRD_PARTY_NOTICES.md.

import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Lottie (Bodymovin JSON, v5) export and import for vector documents (`vector/lottie.ts`), keeping
// path effects live: trim, round corners, pucker & bloat, twist, zig zag, offset, merge and
// repeater map onto Lottie's shape modifiers one to one, both ways. Wiggle and envelope effects,
// masks, frames, text and instances export as their drawn shapes, filters are left out, and `notes`
// lists what was approximated. Import reads one frame. The animation is plain JSON with the TS key
// order; values read from untrusted Lottie go through `Number()` and `??` as the TS reads them.

private typealias Json = JSONObject

private func round4(_ v: Double) -> Double { JS.round(v * 1e4) / 1e4 }
private func st(_ k: JSONValue) -> JSONValue { .object(JSONObject([("a", 0), ("k", k)])) }
private func num(_ v: Double) -> JSONValue { .number(v) }
private func pair(_ x: Double, _ y: Double) -> JSONValue { .array([.number(x), .number(y)]) }

private let LOTTIE_BLEND: [String: Int] = [
    "normal": 0, "multiply": 1, "screen": 2, "overlay": 3, "darken": 4, "lighten": 5, "color-dodge": 6, "color-burn": 7, "hard-light": 8, "soft-light": 9,
    "difference": 10, "exclusion": 11, "hue": 12, "saturation": 13, "color": 14, "luminosity": 15, "linear-dodge": 16,
]
private let LOTTIE_BLEND_BACK: [String: String] = Dictionary(uniqueKeysWithValues: LOTTIE_BLEND.map { (String($0.value), $0.key) })
private let LOTTIE_JOIN: [String: Int] = ["miter": 1, "round": 2, "bevel": 3]
private let LOTTIE_CAP: [String: Int] = ["butt": 1, "round": 2, "square": 3]
private let LOTTIE_MERGE = ["merge", "add", "subtract", "intersect", "exclude"]

/// `Number(v)` of a JSON value (`undefined` is nil → NaN).
private func jsNumberOf(_ v: JSONValue?) -> Double {
    switch v {
    case nil: return .nan
    case .null: return 0
    case let .bool(b): return b ? 1 : 0
    case let .number(n): return n
    case let .string(s): return s.jsToNumber
    case let .array(a):
        if a.isEmpty { return 0 }
        if a.count == 1 { return a[0].numberValue ?? (a[0].stringValue?.jsToNumber ?? (a[0] == .null ? 0 : .nan)) }
        return .nan
    case .object: return .nan
    }
}

/// `String(v)` of a JSON value as a template literal prints it.
private func jsTemplate(_ v: JSONValue?) -> String {
    switch v {
    case nil: return "undefined"
    case .null: return "null"
    case let .bool(b): return b ? "true" : "false"
    case let .number(n): return jsString(n)
    case let .string(s): return s
    case let .array(a): return a.map { $0 == .null ? "" : jsTemplate($0) }.joined(separator: ",")
    case .object: return "[object Object]"
    }
}

/// `a ?? b` of the TS: nil and `null` fall through.
private func nn(_ v: JSONValue?) -> JSONValue? { v == .null ? nil : v }

// MARK: - Export

/// Options of `vectorDocumentToLottie` (`VectorLottieExportOptions`).
public struct VectorLottieExportOptions: Sendable {
    /// Frames per second (default 30).
    public var fps: Double?
    /// Length in frames (default 1: a still).
    public var frames: Double?
    /// The animation's name (default "Vector").
    public var name: String?
    /// Export these nodes instead of the whole document.
    public var nodes: [VectorNode]?

    public init(fps: Double? = nil, frames: Double? = nil, name: String? = nil, nodes: [VectorNode]? = nil) {
        self.fps = fps
        self.frames = frames
        self.name = name
        self.nodes = nodes
    }
}

/// What `vectorDocumentToLottie` returns: the animation and what was approximated.
public struct VectorLottieExport: Sendable {
    public var lottie: JSONObject
    public var notes: [String]

    public var json: JSONValue { .object(JSONObject([("lottie", .object(lottie)), ("notes", .array(notes.map { .string($0) }))])) }
}

private func label(_ n: VectorNode) -> String { n.name ?? n.id }

/// `{ ...node, ...layer }`.
private func merged(_ node: VectorNode, _ layer: JSONObject) -> VectorNode {
    var out = node
    for (k, v) in layer { out[k] = v }
    return out
}

private func shapeOf(_ sp: VectorSubpath) -> JSONValue {
    var v: [JSONValue] = [], i: [JSONValue] = [], o: [JSONValue] = []
    for a in sp.anchors {
        let p = Vec2(a.x, a.y)
        let pin = a.in ?? p
        let pout = a.out ?? p
        v.append(pair(round4(p.x), round4(p.y)))
        i.append(pair(round4(pin.x - p.x), round4(pin.y - p.y)))
        o.append(pair(round4(pout.x - p.x), round4(pout.y - p.y)))
    }
    return .object(JSONObject([("c", .bool(sp.closed)), ("v", .array(v)), ("i", .array(i)), ("o", .array(o))]))
}

private func colorOf(_ css: String) -> [Double] {
    let c = parseVectorColor(css) ?? [0, 0, 0, 1]
    return [round4(c[0]), round4(c[1]), round4(c[2]), 1]
}

private func colorJSON(_ css: String) -> JSONValue { .array(colorOf(css).map(num)) }

/// The fill / stroke item of one paint layer, or nil (with a note) when it cannot be exported.
private func paintItem(_ kind: String, _ layer: JSONObject, _ node: VectorNode, _ notes: inout [String]) -> Json? {
    if layer["visible"] == .bool(false) { return nil }
    guard let paint = layer["paint"], paint != .null, paint != .string("none") else { return nil }
    let fill = kind == "fill"
    var base = Json()
    if !fill {
        let width = nn(layer["strokeWidth"])?.numberValue ?? nn(node["strokeWidth"])?.numberValue ?? 1
        base["w"] = st(num(round4(width)))
        if let lc = LOTTIE_CAP[nn(layer["strokeLinecap"])?.stringValue ?? nn(node["strokeLinecap"])?.stringValue ?? "butt"] { base["lc"] = num(Double(lc)) }
        if let lj = LOTTIE_JOIN[nn(layer["strokeLinejoin"])?.stringValue ?? nn(node["strokeLinejoin"])?.stringValue ?? "miter"] { base["lj"] = num(Double(lj)) }
        base["ml"] = 4
        if let dash = (nn(layer["strokeDasharray"]) ?? nn(node["strokeDasharray"]))?.arrayValue, !dash.isEmpty {
            base["d"] = .array(dash.enumerated().map { k, v in
                .object(JSONObject([("n", .string(k % 2 == 0 ? "d" : "g")), ("nm", .string(k % 2 == 0 ? "dash" : "gap")), ("v", st(num(round4(v.numberValue ?? .nan))))]))
            })
        }
    }
    let mode = layer["blendMode"]?.stringValue
    let blend = mode.flatMap { !$0.isEmpty && $0 != "normal" ? LOTTIE_BLEND[$0] : nil }
    if let mode, !mode.isEmpty, mode != "normal", blend == nil { notes.append("\(label(node)): blend mode \(mode) has no Lottie equivalent (normal used).") }
    func finish(_ out: inout Json) { if let blend { out["bm"] = num(Double(blend)) } }
    let opacity = nn(layer["opacity"])?.numberValue ?? 1
    if let css = paint.stringValue {
        guard let c = parseVectorColor(css) else { return nil }
        var out = Json([("ty", .string(fill ? "fl" : "st"))])
        for (k, v) in base { out[k] = v }
        out["c"] = st(colorJSON(css))
        out["o"] = st(num(round4(100 * c[3] * opacity)))
        out["r"] = fill && node.fillRule == "evenodd" ? 2 : 1
        finish(&out)
        return out
    }
    if isVectorShadedPaint(paint) {
        notes.append("\(label(node)): mesh and freeform gradients have no Lottie equivalent (their first colour used).")
        let first = paint["type"] == "mesh" ? paint["colors"]?.arrayValue?.first?.stringValue : paint["points"]?.arrayValue?.first?["color"]?.stringValue
        guard let first, !first.isEmpty else { return nil }
        var out = Json([("ty", .string(fill ? "fl" : "st"))])
        for (k, v) in base { out[k] = v }
        out["c"] = st(colorJSON(first))
        out["o"] = st(num(round4(100 * opacity)))
        out["r"] = 1
        finish(&out)
        return out
    }
    guard isVectorGradient(paint), let g = paint.objectValue else { return nil }
    let type = g["type"]?.stringValue ?? ""
    if type == "conic" || type == "diamond" || type == "reflected" {
        notes.append("\(label(node)): a \(type) gradient has no Lottie equivalent (\(type == "conic" || type == "diamond" ? "radial" : "linear") used).")
    }
    if !fill, let sm = g["strokeMode"]?.stringValue, !sm.isEmpty, sm != "within" { notes.append("\(label(node)): gradients along or across a stroke have no Lottie equivalent (painted within).") }
    let h = vectorGradientHandles(g, vectorPathLocalBounds(node))
    let radial = type == "radial" || type == "conic" || type == "diamond"
    let stops = expandVectorGradientStops(g)
    var flat: [Double] = []
    for s in stops { flat += [round4(s.offset)] + colorOf(s.color).prefix(3) }
    if stops.contains(where: { ($0.opacity ?? 1) < 1 }) { for s in stops { flat += [round4(s.offset), round4(s.opacity ?? 1)] } }
    var out = Json([("ty", .string(fill ? "gf" : "gs"))])
    for (k, v) in base { out[k] = v }
    out["o"] = st(num(round4(100 * opacity)))
    out["s"] = st(pair(round4(h.start.x), round4(h.start.y)))
    out["e"] = st(pair(round4(h.end.x), round4(h.end.y)))
    out["t"] = radial ? 2 : 1
    out["g"] = .object(JSONObject([("p", num(Double(stops.count))), ("k", st(.array(flat.map(num))))]))
    if fill { out["r"] = node.fillRule == "evenodd" ? 2 : 1 }
    finish(&out)
    if radial, let focal = h.focal {
        let len = JS.hypot(h.end.x - h.start.x, h.end.y - h.start.y)
        let r = len != 0 && !len.isNaN ? len : 1
        let d = Vec2(focal.x - h.start.x, focal.y - h.start.y)
        out["h"] = st(num(round4((100 * JS.hypot(d.x, d.y)) / r)))
        out["a"] = st(num(round4(((JS.atan2(d.y, d.x) - JS.atan2(h.end.y - h.start.y, h.end.x - h.start.x)) * 180) / Double.pi)))
    }
    return out
}

/// A path effect as a Lottie shape modifier (in the node's own space, `c` its box centre), or nil.
private func effectItem(_ e: JSONValue, _ c: Vec2, _ node: VectorNode, _ notes: inout [String]) -> Json? {
    let p = e["params"]?.objectValue ?? Json()
    func n(_ k: String) -> Double { jsNumberOf(nn(p[k]) ?? 0) }
    func v(_ k: String) -> Vec2 {
        guard let o = nn(p[k]) else { return Vec2(0, 0) }
        return Vec2(o["x"]?.numberValue ?? .nan, o["y"]?.numberValue ?? .nan)
    }
    func with(_ pairs: [(String, JSONValue)]) -> Json {
        var o = Json(pairs)
        if e["enabled"] == .bool(false) { o["hd"] = true }
        return o
    }
    switch e["type"]?.stringValue {
    case "trim":
        return with([("ty", "tm"), ("nm", "Trim Paths"), ("s", st(num(n("start")))), ("e", st(num(n("end")))), ("o", st(num(n("offset")))), ("m", p["mode"] == "individual" ? 2 : 1)])
    case "roundCorners":
        return with([("ty", "rd"), ("nm", "Round Corners"), ("r", st(num(n("radius"))))])
    case "puckerBloat":
        return with([("ty", "pb"), ("nm", "Pucker & Bloat"), ("a", st(num(n("amount"))))])
    case "twist":
        return with([("ty", "tw"), ("nm", "Twist"), ("a", st(num(n("angle")))), ("c", st(pair(round4(c.x + v("center").x), round4(c.y + v("center").y))))])
    case "zigzag":
        return with([("ty", "zz"), ("nm", "Zig Zag"), ("s", st(num(n("size")))), ("r", st(num(n("ridges")))), ("pt", st(truthy(p["smooth"]) ? 2 : 1))])
    case "offset":
        if n("copies") > 1 { notes.append("\(label(node)): Offset Paths copies are not part of Lottie (one exported).") }
        let ml = n("miterLimit")
        return with([("ty", "op"), ("nm", "Offset Paths"), ("a", st(num(n("amount")))), ("lj", num(Double(LOTTIE_JOIN[jsTemplate(nn(p["join"]) ?? "miter")] ?? 1))),
                     ("ml", st(num(ml != 0 && !ml.isNaN ? ml : 4)))])
    case "merge":
        // `MERGE.indexOf(mode ?? 'merge') + 1 || 1`: a mode that is not a string is not found.
        let mode = nn(p["mode"]).map { $0.stringValue ?? "" } ?? "merge"
        return with([("ty", "mm"), ("nm", "Merge Paths"), ("mm", num(Double(LOTTIE_MERGE.firstIndex(of: mode).map { $0 + 1 } ?? 1)))])
    case "repeater":
        let anchor = v("anchor"), pos = v("position"), scale = v("scale")
        let tr = Json([("ty", "tr"), ("a", st(pair(round4(c.x + anchor.x), round4(c.y + anchor.y)))), ("p", st(pair(round4(pos.x), round4(pos.y)))), ("s", st(pair(round4(scale.x), round4(scale.y)))),
                       ("r", st(num(n("rotation")))), ("so", st(num(n("startOpacity")))), ("eo", st(num(n("endOpacity"))))])
        return with([("ty", "rp"), ("nm", "Repeater"), ("c", st(num(n("copies")))), ("o", st(num(n("offset")))), ("m", p["composite"] == "above" ? 1 : 2), ("tr", .object(tr))])
    default:
        return nil
    }
}

/// The transform item of a group: its node's rigid placement and opacity.
private func transformItem(_ m: VectorMatrix, _ opacity: Double) -> JSONValue {
    .object(Json([("ty", "tr"), ("a", st(pair(0, 0))), ("p", st(pair(round4(m.e), round4(m.f)))), ("s", st(pair(100, 100))), ("r", st(num(round4(matrixRotation(m))))), ("o", st(num(round4(opacity * 100))))]))
}

private func boxCentre(_ path: BezierPath) -> Vec2 {
    guard let b = bezierPathBounds(.commands(path)) else { return Vec2(0, 0) }
    return Vec2((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)
}

/// A path node as shape items: its subpaths, its effects, its strokes and fills (top first).
private func pathItems(_ node: VectorNode, _ notes: inout [String]) throws -> [JSONValue] {
    var items: [JSONValue] = node.subpaths.filter { !$0.anchors.isEmpty }.enumerated().map { k, sp in .object(Json([("ty", "sh"), ("nm", .string("Path \(k + 1)")), ("ks", st(shapeOf(sp)))])) }
    let c = boxCentre(subpathsToBezier(node.subpaths))
    var effects: [Json] = []
    for e in node["effects"]?.arrayValue ?? [] { if let it = effectItem(e, c, node, &notes) { effects.append(it) } }
    // Repeaters copy what is painted, so they go after the paint; the other modifiers before it.
    let repeaters = effects.filter { $0["ty"] == "rp" }
    items += effects.filter { $0["ty"] != "rp" }.map { .object($0) }
    if !repeaters.isEmpty, let first = effects.firstIndex(where: { $0["ty"] == "rp" }), first < effects.count - 1 { notes.append("\(label(node)): effects after a repeater act before it in Lottie.") }
    var out: [JSONValue] = []
    for s in vectorStrokes(node).reversed() {
        if hasStrokeExtras(merged(node, s)) { continue }
        if let it = paintItem("stroke", s, node, &notes) { out.append(.object(it)) }
    }
    for f in vectorFills(node).reversed() {
        if let it = paintItem("fill", f, node, &notes) { out.append(.object(it)) }
    }
    return items + out + repeaters.map { .object($0) }
}

private let LIVE_EFFECTS: Set<String> = ["wiggle", "envelope", "contour", "blockShadow", "extrude", "bevel"]

/// A node as one Lottie group (or nil when it draws nothing).
private func nodeGroup(_ node: VectorNode, _ notes: inout [String]) throws -> Json? {
    if !node.isVisible { return nil }
    if let filters = node["filters"]?.arrayValue, !filters.isEmpty { notes.append("\(label(node)): filters (shadows, glows, blurs) are not part of Lottie (left out).") }
    if node.isPath, node["strokes"]?.arrayValue?.contains(where: { $0["kind"] == "brushstroke" && $0["visible"] != .bool(false) }) == true {
        notes.append("\(label(node)): brushstrokes are raster images, not part of Lottie (left out).")
    }
    let m = nodeMatrix(node)
    var items: [JSONValue] = []
    let live = (node["effects"]?.arrayValue ?? []).contains { $0["enabled"] != .bool(false) && LIVE_EFFECTS.contains($0["type"]?.stringValue ?? "") }
    if node.isText || node.isInstance || live || isVectorMaskGroup(node) || isVectorFrame(node) || isVectorSymmetryGroup(node) || isVectorLens(node) {
        // Drawn shapes: text as glyph outlines, instances as their art, masks clipped, frames as clip groups.
        if live { notes.append("\(label(node)): wiggle, envelope, contour, block shadow, extrude and bevel effects have no Lottie equivalent (exported as drawn).") }
        if isVectorLens(node) { notes.append("\(label(node)): a lens exports as drawn (what it shows now, clipped by its outline).") }
        if isVectorMaskGroup(node) && node["mask"]?["type"] != "clip" { notes.append("\(label(node)): opacity masks are not exported (the contents are drawn whole).") }
        let drawn = isVectorFrame(node) ? vectorFrameDrawn(node) : node
        if isVectorMaskGroup(drawn) && drawn["mask"]?["type"] == "clip" {
            var plain = drawn
            plain["transform"] = Optional<JSONValue>.none
            // The clipped result: each shape in its source's style, top first.
            for s in try vectorAppearanceShapes(plain).reversed() {
                var source = s.source
                source.subpaths = bezierToSubpaths(.commands(s.path))
                source["effects"] = .null
                source["opacity"] = .number(s.opacity)
                items.append(.object(Json([("ty", "gr"), ("nm", .string(source.name ?? "Shape")), ("it", .array(try pathItems(source, &notes) + [transformItem(IDENTITY_MATRIX, s.opacity)])), ("np", 0)])))
            }
        } else {
            var plain = node
            plain["transform"] = Optional<JSONValue>.none
            let expanded = try expandVectorAppearance(plain)
            if let g = try nodeGroup(expanded, &notes) { items = (g["it"]?.arrayValue ?? []).filter { $0["ty"] != "tr" } }
            if node.isText && items.isEmpty { notes.append("\(label(node)): text without glyph outlines (load fonts) is left out.") }
        }
    } else if node.isPath {
        items = try pathItems(node, &notes)
        // Stroke alignment, arrowheads and width profiles: the stroke exported as its filled outline.
        for s in vectorStrokes(node).reversed() {
            if !hasStrokeExtras(merged(node, s)) || s["visible"] == .bool(false) { continue }
            var asNode = merged(node, s)
            asNode["stroke"] = s["paint"]
            asNode["fills"] = Optional<JSONValue>.none
            asNode["strokes"] = Optional<JSONValue>.none
            let outline = try vectorStrokeOutline(asNode)
            var layer = Json()
            for key in ["paint", "opacity", "blendMode"] { if let v = s[key] { layer[key] = v } }
            var nonzero = node
            nonzero["fillRule"] = "nonzero"
            let fill = paintItem("fill", layer, nonzero, &notes)
            if !outline.isEmpty, let fill {
                let shapes: [JSONValue] = bezierToSubpaths(.commands(outline)).map { .object(Json([("ty", "sh"), ("ks", st(shapeOf($0)))])) }
                items.insert(.object(Json([("ty", "gr"), ("nm", "Stroke"), ("it", .array(shapes + [.object(fill), transformItem(IDENTITY_MATRIX, 1)])), ("np", 0)])), at: 0)
            }
        }
    } else {
        for child in node.children.reversed() {
            if let it = try nodeGroup(child, &notes) { items.append(.object(it)) }
        }
        if truthy(node["liveBoolean"]) {
            let lb = node["liveBoolean"]?.stringValue ?? ""
            // Merge Paths over the operands' paths, painted in the bottom operand's style.
            notes.append("\(label(node)): a live boolean exports as Merge Paths in its bottom operand's style.")
            func strip(_ list: [JSONValue]) -> [JSONValue] {
                list.flatMap { it -> [JSONValue] in
                    if it["ty"] == "gr", var o = it.objectValue {
                        o["it"] = .array(strip(it["it"]?.arrayValue ?? []))
                        return [.object(o)]
                    }
                    return it["ty"] == "sh" || it["ty"] == "tr" ? [it] : []
                }
            }
            items = strip(items)
            let op = (LOTTIE_MERGE.firstIndex(of: lb == "subtract" ? "subtract" : lb == "intersect" ? "intersect" : lb == "exclude" ? "exclude" : "add") ?? -1) + 1
            items.append(.object(Json([("ty", "mm"), ("nm", "Merge Paths"), ("mm", num(Double(op)))])))
            if var bottom = node.children.first(where: { $0.isPath }) {
                bottom.subpaths = []
                bottom["effects"] = .null
                items += try pathItems(bottom, &notes)
            }
        }
        let c = boxCentre(node.children.flatMap { $0.isPath ? subpathsToBezier($0.subpaths) : [] })
        for e in node["effects"]?.arrayValue ?? [] { if let it = effectItem(e, c, node, &notes) { items.append(.object(it)) } }
    }
    if items.isEmpty { return nil }
    var out = Json([("ty", "gr"), ("nm", .string(label(node))), ("it", .array(items + [transformItem(m, node.opacity ?? 1)])), ("np", num(Double(items.count)))])
    if let mode = node["blendMode"]?.stringValue, !mode.isEmpty, mode != "normal", let bm = LOTTIE_BLEND[mode] { out["bm"] = num(Double(bm)) }
    return out
}

/**
 * The document (or `options.nodes` of it) as a Lottie animation (`vectorDocumentToLottie`): one
 * shape layer whose groups mirror the nodes (top first), path effects as live shape modifiers and
 * gradients as gradient fills, on a background layer when the document has one.
 */
public func vectorDocumentToLottie(_ docIn: VectorDocument, _ options: VectorLottieExportOptions = VectorLottieExportOptions()) throws -> VectorLottieExport {
    var notes: [String] = []
    let fps = options.fps ?? 30
    let op = JS.max(1, JS.round(options.frames ?? 1))
    var shapes: [JSONValue] = []
    // Lenses draw what is below them: resolve their backdrops when the caller has not.
    let doc = options.nodes == nil ? resolveVectorLenses(resolveVectorMasterPages(docIn)) : docIn
    for n in (options.nodes ?? doc.nodes).reversed() {
        if let g = try nodeGroup(n, &notes) { shapes.append(.object(g)) }
    }
    let ks = JSONValue.object(Json([("o", st(100)), ("r", st(0)), ("p", st([0, 0, 0])), ("a", st([0, 0, 0])), ("s", st([100, 100, 100]))]))
    let name = JSONValue.string(options.name ?? "Vector")
    var layers: [JSONValue] = [.object(Json([("ddd", 0), ("ind", 1), ("ty", 4), ("nm", name), ("sr", 1), ("ks", ks), ("ao", 0), ("shapes", .array(shapes)), ("ip", 0), ("op", num(op)), ("st", 0), ("bm", 0)]))]
    // The page background, when the whole document is exported.
    if options.nodes == nil, let bg = doc.background, !bg.isEmpty, parseVectorColor(bg) != nil {
        let bgShapes: JSONValue = [
            .object(Json([("ty", "rc"), ("s", st(pair(doc.width, doc.height))), ("p", st(pair(doc.width / 2, doc.height / 2))), ("r", st(0))])),
            .object(Json([("ty", "fl"), ("c", st(colorJSON(bg))), ("o", st(100)), ("r", 1)])),
        ]
        layers.append(.object(Json([("ddd", 0), ("ind", 2), ("ty", 4), ("nm", "Background"), ("sr", 1), ("ks", ks), ("ao", 0), ("shapes", bgShapes), ("ip", 0), ("op", num(op)), ("st", 0), ("bm", 0)])))
    }
    var seen = Set<String>()
    let unique = notes.filter { seen.insert($0).inserted }
    let lottie = Json([("v", "5.7.4"), ("fr", num(fps)), ("ip", 0), ("op", num(op)), ("w", num(doc.width)), ("h", num(doc.height)), ("nm", name), ("ddd", 0), ("assets", []), ("layers", .array(layers))])
    return VectorLottieExport(lottie: lottie, notes: unique)
}

// MARK: - Import

/// A cubic-bezier ease's progress at `x` (0–1) with control points (x1, y1), (x2, y2).
private func ease(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double) -> Double {
    func bez(_ a: Double, _ b: Double, _ t: Double) -> Double { 3 * a * t * JS.pow(1 - t, 2) + 3 * b * t * t * (1 - t) + JS.pow(t, 3) }
    var lo = 0.0
    var hi = 1.0
    for _ in 0 ..< 40 {
        let mid = (lo + hi) / 2
        if bez(x1, x2, mid) < x { lo = mid } else { hi = mid }
    }
    return bez(y1, y2, (lo + hi) / 2)
}

/// `Array.isArray(v) ? v.map(Number) : typeof v === 'number' ? [v] : []`.
private func nums(_ v: JSONValue?) -> [Double] {
    if let a = v?.arrayValue { return a.map(jsNumberOf) }
    if let n = v?.numberValue { return [n] }
    return []
}

/// `list[i]` (nil past the end).
private func at(_ list: [Double], _ i: Int) -> Double? { i < list.count ? list[i] : nil }

/// Whether `k` is a keyframe list (its first entry an object with `t`).
private func isKeyed(_ k: JSONValue?) -> Bool {
    guard let a = k?.arrayValue, let first = a.first, let o = first.objectValue else { return false }
    return o.contains("t")
}

/// A Lottie property's value at `frame`, keyframes eased and held keys held (`lottieValueAt`).
public func lottieValueAt(_ prop: JSONValue?, _ frame: Double) -> [Double] {
    guard let prop, truthy(prop), case let .object(p) = prop else {
        // Arrays are objects to the TS: `[…].k` is undefined.
        if prop?.arrayValue != nil { return [] }
        return nums(prop)
    }
    let k = p["k"]
    guard (p["a"] == .number(1) || isKeyed(k)), let keys = k?.arrayValue else { return nums(k) }
    if keys.isEmpty { return [] }
    func start(_ i: Int) -> [Double] { nums(nn(keys[i]["s"]) ?? (i > 0 ? keys[i - 1]["e"] : nil)) }
    if frame <= jsNumberOf(keys[0]["t"]) { return start(0) }
    for i in 0 ..< keys.count - 1 {
        let a = keys[i]
        let b = keys[i + 1]
        let t0 = jsNumberOf(a["t"])
        let t1 = jsNumberOf(b["t"])
        if frame >= t1 { continue }
        let from = start(i)
        if a["h"] == .number(1) { return from }
        let to = b["s"] != nil ? nums(b["s"]) : nums(a["e"])
        let x = t1 > t0 ? (frame - t0) / (t1 - t0) : 1
        let y: Double
        if let o = a["o"], truthy(o), let iq = a["i"], truthy(iq) {
            y = ease(at(nums(o["x"]), 0) ?? 0, at(nums(o["y"]), 0) ?? 0, at(nums(iq["x"]), 0) ?? 1, at(nums(iq["y"]), 0) ?? 1, x)
        } else {
            y = x
        }
        return from.enumerated().map { d, v in v + ((at(to, d) ?? v) - v) * y }
    }
    let last = keys[keys.count - 1]
    return last["s"] != nil ? nums(last["s"]) : nums(keys.count >= 2 ? keys[keys.count - 2]["e"] : nil)
}

/// A Lottie path value at `frame` as a subpath.
private func subpathOf(_ prop: JSONValue?, _ frame: Double) -> VectorSubpath? {
    guard let p = prop, truthy(p) else { return nil }
    var k = p["k"]
    if isKeyed(k), let keys = k?.arrayValue {
        // Keyframed paths: the key in force (shapes are not interpolated here).
        var pick = keys[0]
        for key in keys where jsNumberOf(key["t"]) <= frame { pick = key }
        if let list = pick["s"]?.arrayValue { k = list.first } else { k = pick["s"] }
    }
    guard let s = k, truthy(s), let vs = s["v"]?.arrayValue else { return nil }
    let v = vs.map(nums)
    let i = (s["i"]?.arrayValue ?? []).map(nums)
    let o = (s["o"]?.arrayValue ?? []).map(nums)
    let anchors = v.enumerated().map { k, xy -> VectorAnchor in
        let x = at(xy, 0) ?? .nan, y = at(xy, 1) ?? .nan
        let ik = k < i.count ? i[k] : [0, 0]
        let ok = k < o.count ? o[k] : [0, 0]
        let (ix, iy) = (at(ik, 0), at(ik, 1))
        let (ox, oy) = (at(ok, 0), at(ok, 1))
        func truthyN(_ n: Double?) -> Bool { n.map { $0 != 0 && !$0.isNaN } ?? false }
        let hin = truthyN(ix) || truthyN(iy) ? Vec2(x + (ix ?? .nan), y + (iy ?? .nan)) : nil
        let hout = truthyN(ox) || truthyN(oy) ? Vec2(x + (ox ?? .nan), y + (oy ?? .nan)) : nil
        return VectorAnchor(x: x, y: y, in: hin, out: hout)
    }
    return anchors.isEmpty ? nil : VectorSubpath(closed: truthy(s["c"]), anchors: anchors)
}

/// A Lottie colour (0–1, or 0–255 in old files) as CSS.
private func cssColor(_ c: [Double]) -> String {
    let k: Double = c.prefix(3).contains { $0 > 1 } ? 255 : 1
    func hex(_ v: Double) -> String {
        let r = JS.round(JS.min(1, JS.max(0, v / k)) * 255)
        if r.isNaN { return "NaN" }
        let s = String(Int(r), radix: 16)
        return s.count < 2 ? "0" + s : s
    }
    return "#\(hex(at(c, 0) ?? 0))\(hex(at(c, 1) ?? 0))\(hex(at(c, 2) ?? 0))"
}

private struct LottieImportState {
    var frame: Double
    var notes: [String] = []
    var prefix: String
    var count = 0
    mutating func next() -> String {
        count += 1
        return "\(prefix)\(count)"
    }
}

/// A shape geometry item at `frame` as subpaths.
private func geometryOf(_ it: JSONValue, _ frame: Double, _ notes: inout [String]) -> [VectorSubpath] {
    switch jsTemplate(it["ty"]) {
    case "sh":
        return subpathOf(it["ks"], frame).map { [$0] } ?? []
    case "rc":
        let s = lottieValueAt(it["s"], frame), p = lottieValueAt(it["p"], frame)
        let (w, h) = (at(s, 0) ?? .nan, at(s, 1) ?? .nan)
        let (x, y) = (at(p, 0) ?? .nan, at(p, 1) ?? .nan)
        let r = at(lottieValueAt(it["r"], frame), 0) ?? 0
        return [rectSubpath(VectorBounds(x: x - w / 2, y: y - h / 2, width: w, height: h), JS.min(JS.min(r, w / 2), h / 2))]
    case "el":
        let s = lottieValueAt(it["s"], frame), p = lottieValueAt(it["p"], frame)
        let (w, h) = (at(s, 0) ?? .nan, at(s, 1) ?? .nan)
        let (x, y) = (at(p, 0) ?? .nan, at(p, 1) ?? .nan)
        return [ellipseSubpath(VectorBounds(x: x - w / 2, y: y - h / 2, width: w, height: h))]
    case "sr":
        let n = JS.max(3, JS.round(at(lottieValueAt(it["pt"], frame), 0) ?? 5))
        let c = lottieValueAt(it["p"], frame)
        let (cx, cy) = (at(c, 0) ?? .nan, at(c, 1) ?? .nan)
        let rot = ((at(lottieValueAt(it["r"], frame), 0) ?? 0) * Double.pi) / 180
        let or = at(lottieValueAt(it["or"], frame), 0) ?? 50
        let ir = at(lottieValueAt(it["ir"], frame), 0) ?? or / 2
        let star = jsNumberOf(nn(it["sy"]) ?? 1) != 2
        let os = at(lottieValueAt(it["os"], frame), 0) ?? 0, isv = at(lottieValueAt(it["is"], frame), 0) ?? 0
        if (os != 0 && !os.isNaN) || (isv != 0 && !isv.isNaN) { notes.append("Star and polygon roundness is not imported (sharp points used).") }
        var pts: [VectorAnchor] = []
        let count = star ? n * 2 : n
        var k = 0.0
        while k < count {
            let r = star && k.truncatingRemainder(dividingBy: 2) == 1 ? ir : or
            let a = rot - Double.pi / 2 + (k * 2 * Double.pi) / count
            pts.append(VectorAnchor(x: cx + r * JS.cos(a), y: cy + r * JS.sin(a)))
            k += 1
        }
        return [VectorSubpath(closed: true, anchors: pts)]
    default:
        return []
    }
}

/// A shape transform (`tr`) or layer transform (`ks`) at `frame` as a matrix, and its opacity 0–1.
private func transformOf(_ t: JSONValue?, _ frame: Double, _ notes: inout [String]) -> (m: VectorMatrix, opacity: Double) {
    guard let t, truthy(t) else { return (IDENTITY_MATRIX, 1) }
    let a = lottieValueAt(t["a"], frame)
    let (ax, ay) = (at(a, 0) ?? 0, at(a, 1) ?? 0)
    let pv = t["p"]
    let p: [Double] = pv.map(truthy) == true && pv?["s"] == .bool(true) ? [at(lottieValueAt(pv?["x"], frame), 0) ?? 0, at(lottieValueAt(pv?["y"], frame), 0) ?? 0] : lottieValueAt(t["p"], frame)
    let (px, py) = (at(p, 0) ?? 0, at(p, 1) ?? 0)
    let sv = lottieValueAt(t["s"], frame)
    let s = sv.isEmpty ? [100.0, 100] : sv
    let (sx, sy) = (at(s, 0) ?? 100, at(s, 1) ?? 100)
    let r = at(lottieValueAt(nn(t["r"]) ?? t["rz"], frame), 0) ?? 0
    let o = at(lottieValueAt(t["o"], frame), 0)
    if let sk = at(lottieValueAt(t["sk"], frame), 0), sk != 0, !sk.isNaN { notes.append("Skew is not imported.") }
    var m = translateMatrix(-ax, -ay)
    m = multiplyMatrices(m, scaleMatrix(sx / 100, sy / 100))
    m = multiplyMatrices(m, rotateMatrix(r))
    m = multiplyMatrices(m, translateMatrix(px, py))
    return (m, o.map { JS.min(1, JS.max(0, $0 / 100)) } ?? 1)
}

/// A gradient item at `frame` as our gradient (in user space).
private func gradientOf(_ it: JSONValue, _ frame: Double) -> JSONValue? {
    guard let g = it["g"], truthy(g) else { return nil }
    let n = jsNumberOf(nn(g["p"]) ?? 2)
    let flat = lottieValueAt(g["k"], frame)
    var stops: [(offset: Double, color: String, opacity: Double?)] = []
    var k = 0
    while Double(k) < n && k * 4 + 3 < flat.count {
        stops.append((JS.min(1, JS.max(0, flat[k * 4])), cssColor([flat[k * 4 + 1], flat[k * 4 + 2], flat[k * 4 + 3]]), nil))
        k += 1
    }
    // `flat.slice(n * 4)` as JavaScript reads it.
    let from: Int = {
        let s = n * 4
        if s.isNaN { return 0 }
        if s < 0 { return Swift.max(0, flat.count + Int(JS.max(-Double(flat.count), s.rounded(.towardZero)))) }
        return Int(JS.min(Double(flat.count), s.rounded(.towardZero)))
    }()
    let alphas = Array(flat[from...])
    if alphas.count >= 4 {
        for si in stops.indices {
            let off = stops[si].offset
            var a = alphas[1]
            var j = 0
            while j + 3 < alphas.count {
                if alphas[j] <= off && alphas[j + 2] >= off {
                    a = alphas[j + 1] + ((alphas[j + 3] - alphas[j + 1]) * (off - alphas[j])) / JS.max(1e-9, alphas[j + 2] - alphas[j])
                }
                j += 2
            }
            if a < 1 { stops[si].opacity = JS.max(0, a) }
        }
    }
    if stops.isEmpty { return nil }
    let s = lottieValueAt(it["s"], frame), e = lottieValueAt(it["e"], frame)
    let (sx, sy) = (at(s, 0) ?? .nan, at(s, 1) ?? .nan)
    let (ex, ey) = (at(e, 0) ?? .nan, at(e, 1) ?? .nan)
    let radial = jsNumberOf(nn(it["t"]) ?? 1) == 2
    var out = Json([
        ("type", .string(radial ? "radial" : "linear")),
        ("stops", .array(stops.map { s in
            var o = Json([("offset", num(s.offset)), ("color", .string(s.color))])
            if let op = s.opacity { o["opacity"] = num(op) }
            return .object(o)
        })),
        ("units", "userSpaceOnUse"), ("start", Vec2(sx, sy).json), ("end", Vec2(ex, ey).json),
    ])
    let h = at(lottieValueAt(it["h"], frame), 0) ?? 0
    if radial && h != 0 && !h.isNaN {
        let a = ((at(lottieValueAt(it["a"], frame), 0) ?? 0) * Double.pi) / 180 + JS.atan2(ey - sy, ex - sx)
        let r = (JS.hypot(ex - sx, ey - sy) * JS.max(-99, JS.min(99, h))) / 100
        out["focal"] = Vec2(sx + JS.cos(a) * r, sy + JS.sin(a) * r).json
    }
    return .object(out)
}

/// A modifier item at `frame` as our effect (centre `c` of what it acts on), or nil.
private func effectOf(_ it: JSONValue, _ frame: Double, _ c: Vec2, _ id: String) throws -> JSONObject? {
    func v(_ k: String) -> [Double] { lottieValueAt(it[k], frame) }
    func numv(_ k: String, _ d: Double = 0) -> Double { at(v(k), 0) ?? d }
    func pt(_ x: Double, _ y: Double) -> JSONValue { Vec2(x, y).json }
    var raw: (type: String, params: Json)?
    switch jsTemplate(it["ty"]) {
    case "tm":
        raw = ("trim", Json([("start", num(numv("s"))), ("end", num(numv("e", 100))), ("offset", num(numv("o"))), ("mode", jsNumberOf(it["m"]) == 2 ? "individual" : "simultaneous")]))
    case "rd":
        raw = ("roundCorners", Json([("radius", num(numv("r")))]))
    case "pb":
        raw = ("puckerBloat", Json([("amount", num(numv("a")))]))
    case "tw":
        let cv = v("c")
        let (x, y) = (at(cv, 0) ?? c.x, at(cv, 1) ?? c.y)
        raw = ("twist", Json([("angle", num(numv("a"))), ("center", pt(x - c.x, y - c.y))]))
    case "zz":
        raw = ("zigzag", Json([("size", num(numv("s"))), ("ridges", num(numv("r"))), ("smooth", .bool(numv("pt", 1) == 2))]))
    case "op":
        let joins = ["miter", "round", "bevel"]
        let ji = jsNumberOf(nn(it["lj"]) ?? 1) - 1
        let join = ji >= 0 && ji < 3 && ji == ji.rounded() ? joins[Int(ji)] : "miter"
        let ml = numv("ml", 4)
        raw = ("offset", Json([("amount", num(numv("a"))), ("join", .string(join)), ("miterLimit", num(ml != 0 && !ml.isNaN ? ml : 4))]))
    case "mm":
        let mi = jsNumberOf(nn(it["mm"]) ?? 1) - 1
        raw = ("merge", Json([("mode", .string(mi >= 0 && mi < 5 && mi == mi.rounded() ? LOTTIE_MERGE[Int(mi)] : "merge"))]))
    case "rp":
        let tr = nn(it["tr"]) ?? .object(Json())
        func atv(_ k: String, _ d: [Double]) -> [Double] {
            let r = lottieValueAt(tr[k], frame)
            return r.isEmpty ? d : r
        }
        let a = atv("a", [c.x, c.y]), p = atv("p", [0, 0]), s = atv("s", [100, 100])
        let (ax, ay) = (at(a, 0) ?? .nan, at(a, 1) ?? .nan)
        let (px, py) = (at(p, 0) ?? .nan, at(p, 1) ?? .nan)
        let (sx, sy) = (at(s, 0) ?? .nan, at(s, 1) ?? .nan)
        raw = ("repeater", Json([
            ("copies", num(numv("c", 1))), ("offset", num(numv("o"))), ("position", pt(px, py)), ("anchor", pt(ax - c.x, ay - c.y)), ("rotation", num(atv("r", [0])[0])),
            ("scale", pt(sx, sy)), ("startOpacity", num(atv("so", [100])[0])), ("endOpacity", num(atv("eo", [100])[0])), ("composite", jsNumberOf(it["m"]) == 1 ? "above" : "below"),
        ]))
    default:
        raw = nil
    }
    guard let raw else { return nil }
    var e = Json([("type", .string(raw.type)), ("params", .object(raw.params)), ("id", .string(id))])
    if it["hd"] == .bool(true) { e["enabled"] = false }
    return try sanitizeVectorEffects(.array([.object(e)])).first
}

private let PAINTS: Set<String> = ["fl", "st", "gf", "gs"]
private let MODIFIERS: Set<String> = ["tm", "rd", "pb", "tw", "zz", "op", "mm", "rp"]
private let GEOMETRY: Set<String> = ["sh", "rc", "el", "sr"]

/// Applies paint items (top first) to a path node as its fill and stroke stacks.
private func painted(_ node: VectorNode, _ paints: [JSONValue], _ s: inout LottieImportState) -> VectorNode {
    var fills: [Json] = []
    var strokes: [Json] = []
    var evenodd = false
    for it in paints {
        if it["hd"] == .bool(true) { continue }
        let o = (at(lottieValueAt(it["o"], s.frame), 0) ?? 100) / 100
        let bm = it["bm"] != nil ? LOTTIE_BLEND_BACK[jsString(jsNumberOf(it["bm"]))] : nil
        let ty = jsTemplate(it["ty"])
        let paint: JSONValue? = ty == "fl" || ty == "st" ? .string(cssColor(lottieValueAt(it["c"], s.frame))) : gradientOf(it, s.frame)
        guard let paint else { continue }
        var layer = Json([("paint", paint)])
        if o < 1 { layer["opacity"] = num(JS.max(0, o)) }
        if let bm, bm != "normal" { layer["blendMode"] = .string(bm) }
        if ty == "fl" || ty == "gf" {
            if jsNumberOf(it["r"]) == 2 { evenodd = true }
            fills.insert(layer, at: 0)
        } else {
            let dash: [Double] = (it["d"]?.arrayValue ?? []).filter { $0["n"] == "d" || $0["n"] == "g" }.map { at(lottieValueAt($0["v"], s.frame), 0) ?? 0 }
            var stroke = layer
            stroke["strokeWidth"] = num(at(lottieValueAt(it["w"], s.frame), 0) ?? 1)
            let caps = ["butt", "round", "square"], joins = ["miter", "round", "bevel"]
            let lc = jsNumberOf(nn(it["lc"]) ?? 1) - 1, lj = jsNumberOf(nn(it["lj"]) ?? 1) - 1
            stroke["strokeLinecap"] = .string(lc >= 0 && lc < 3 && lc == lc.rounded() ? caps[Int(lc)] : "butt")
            stroke["strokeLinejoin"] = .string(lj >= 0 && lj < 3 && lj == lj.rounded() ? joins[Int(lj)] : "miter")
            if !dash.isEmpty { stroke["strokeDasharray"] = .array(dash.map(num)) }
            strokes.insert(stroke, at: 0)
        }
    }
    let fill = fills.last
    let stroke = strokes.last
    var out = node
    if evenodd { out["fillRule"] = "evenodd" }
    out["fill"] = fill?["paint"] ?? .null
    out["stroke"] = stroke?["paint"] ?? .null
    if let stroke {
        out["strokeWidth"] = stroke["strokeWidth"]
        out["strokeLinecap"] = stroke["strokeLinecap"]
        out["strokeLinejoin"] = stroke["strokeLinejoin"]
        if let dash = stroke["strokeDasharray"] { out["strokeDasharray"] = dash }
    }
    if fills.count > 1 || (fill.map { $0["opacity"] != nil || truthy($0["blendMode"]) } ?? false) { out["fills"] = .array(fills.map { .object($0) }) }
    if strokes.count > 1 || (stroke.map { $0["opacity"] != nil || truthy($0["blendMode"]) } ?? false) { out["strokes"] = .array(strokes.map { .object($0) }) }
    return out
}

/// The blend mode a group's `bm` names, unless normal.
private func groupBlend(_ it: JSONValue) -> String? {
    guard it["bm"] != nil, let mode = LOTTIE_BLEND_BACK[jsString(jsNumberOf(it["bm"]))], mode != "normal" else { return nil }
    return mode
}

/**
 * Shape items as nodes, bottom to top. Lottie lists items top first; paints and modifiers act on
 * every shape above them in their group (nested groups included), so the shapes between two paint
 * items share one compound path with the paints and modifiers after them.
 */
private func itemsToNodes(_ items: [JSONValue], _ inherited: (paints: [JSONValue], modifiers: [JSONValue]), _ s: inout LottieImportState) throws -> [VectorNode] {
    var out: [VectorNode] = []
    func after(_ i: Int) -> (paints: [JSONValue], modifiers: [JSONValue]) {
        let rest = items[(i + 1)...].filter { $0["hd"] != .bool(true) }
        return (rest.filter { PAINTS.contains(jsTemplate($0["ty"])) } + inherited.paints, rest.filter { MODIFIERS.contains(jsTemplate($0["ty"])) } + inherited.modifiers)
    }
    var run: [VectorSubpath] = []
    var runEnd = -1
    func flush(_ s: inout LottieImportState) throws {
        if run.isEmpty { return }
        let scope = after(runEnd)
        let c = boxCentre(subpathsToBezier(run))
        let id = s.next()
        var node = VectorNode(props: JSONObject([("id", .string(id)), ("type", "path"), ("subpaths", .null), ("fill", .null), ("stroke", .null)]), subpaths: run)
        node = painted(node, scope.paints, &s)
        var effects: [JSONValue] = []
        for (k, it) in scope.modifiers.enumerated() { if let e = try effectOf(it, s.frame, c, "fx\(k + 1)") { effects.append(.object(e)) } }
        if !effects.isEmpty { node["effects"] = .array(effects) }
        if scope.paints.isEmpty { s.notes.append("Shapes without a fill or stroke after them are imported unpainted.") }
        out.append(node)
        run = []
    }
    for (i, it) in items.enumerated() {
        if it["hd"] == .bool(true) { continue }
        let ty = jsTemplate(it["ty"])
        if GEOMETRY.contains(ty) {
            run += geometryOf(it, s.frame, &s.notes)
            runEnd = i
        } else if ty == "gr" {
            try flush(&s)
            let list = it["it"]?.arrayValue ?? []
            let tr = list.first { $0["ty"] == "tr" }
            let (m, opacity) = transformOf(tr, s.frame, &s.notes)
            let children = try itemsToNodes(list.filter { $0["ty"] != "tr" }, after(i), &s)
            if children.isEmpty { continue }
            var props = JSONObject([("id", .string(s.next())), ("type", "group")])
            if let nm = it["nm"]?.stringValue { props["name"] = .string(nm) }
            var group = try transformVectorNode(VectorNode(props: props, children: children), m)
            if opacity < 1 { group["opacity"] = num(opacity) }
            if let bm = groupBlend(it) { group["blendMode"] = .string(bm) }
            out.append(group)
        } else if PAINTS.contains(ty) || MODIFIERS.contains(ty) {
            try flush(&s)
        } else if ty != "tr" {
            s.notes.append("Shape item \"\(ty)\" is not supported (skipped).")
        }
    }
    try flush(&s)
    // Lottie lists top first: ours are bottom first.
    return out.reversed()
}

/// Options of `parseVectorLottie` (`VectorLottieImportOptions`).
public struct VectorLottieImportOptions: Sendable {
    /// The frame to read (default the animation's in point).
    public var frame: Double?
    /// Id prefix of the new nodes (default `lt`).
    public var idPrefix: String?

    public init(frame: Double? = nil, idPrefix: String? = nil) {
        self.frame = frame
        self.idPrefix = idPrefix
    }
}

/// What `parseVectorLottie` returns: a document of the frame and what was approximated or skipped.
public struct VectorLottieImport: Sendable {
    public var document: VectorDocument
    public var notes: [String]
}

/**
 * One frame of a Lottie animation as a vector document (`parseVectorLottie`): shape layers (and
 * solids) become groups with their layer transform, parenting and opacity; precompositions are
 * read recursively; shape modifiers become live path effects. Image and text layers, mattes, masks
 * other than additive, expressions and effects are left out (see `notes`). Text input is parsed
 * with `JSONValue.parse`, whose error messages are not V8's.
 */
public func parseVectorLottie(_ input: JSONValue, _ options: VectorLottieImportOptions = VectorLottieImportOptions()) throws -> VectorLottieImport {
    let json: JSONValue = try input.stringValue.map { try JSONValue.parse($0) } ?? input
    guard let root = json.objectValue, let topLayers = root["layers"]?.arrayValue else { throw VectorImageError("Not a Lottie animation: it needs a layers array.") }
    var s = LottieImportState(frame: options.frame ?? jsNumberOf(nn(root["ip"]) ?? 0), prefix: options.idPrefix ?? "lt")
    var assets: [String: JSONValue] = [:]
    for a in root["assets"]?.arrayValue ?? [] { if let id = a["id"]?.stringValue { assets[id] = a } }
    func layersToNodes(_ layers: [JSONValue], _ frame: Double, _ depth: Int) throws -> [VectorNode] {
        var byIndex: [String: Int] = [:]
        for (k, l) in layers.enumerated() where l["ind"] != nil { byIndex[jsString(jsNumberOf(l["ind"]))] = k }
        // A layer's transform, then its parents' (a parent loop stops where it repeats).
        func worldOf(_ li: Int, _ seen: inout Set<Int>) -> VectorMatrix {
            let l = layers[li]
            let own = transformOf(l["ks"], frame, &s.notes).m
            let parent = l["parent"] != nil ? byIndex[jsString(jsNumberOf(l["parent"]))] : nil
            guard let parent, !seen.contains(parent) else { return own }
            seen.insert(li)
            return multiplyMatrices(own, worldOf(parent, &seen))
        }
        var out: [VectorNode] = []
        for (li, l) in layers.enumerated() {
            let ty = jsNumberOf(l["ty"])
            if l["hd"] == .bool(true) || frame < jsNumberOf(nn(l["ip"]) ?? .number(-.infinity)) || frame >= jsNumberOf(nn(l["op"]) ?? .number(.infinity)) { continue }
            let nm = jsTemplate(nn(l["nm"]) ?? "")
            if l["td"] == .number(1) || truthy(l["tt"]) { s.notes.append("Layer \"\(nm)\": track mattes are not imported.") }
            if truthy(l["ef"]) { s.notes.append("Layer \"\(nm)\": layer effects are not imported.") }
            if let ks = l["ks"], truthy(ks), ks.stringified().contains("\"x\":\"") { s.notes.append("Expressions are not evaluated (their stored values are used).") }
            var children: [VectorNode] = []
            if ty == 4 {
                children = try itemsToNodes(l["shapes"]?.arrayValue ?? [], ([], []), &s)
            } else if ty == 1 {
                let w = jsNumberOf(nn(l["sw"]) ?? 0)
                let h = jsNumberOf(nn(l["sh"]) ?? 0)
                let c = l["sc"]?.stringValue ?? "#000000"
                children = [VectorNode(props: JSONObject([("id", .string(s.next())), ("type", "path"), ("name", "Solid"), ("subpaths", .null), ("fill", .string(c)), ("stroke", .null)]),
                                       subpaths: [rectSubpath(VectorBounds(x: 0, y: 0, width: w, height: h))])]
            } else if ty == 0, let ref = l["refId"]?.stringValue, depth < 16 {
                let local = frame - jsNumberOf(nn(l["st"]) ?? 0)
                if let asset = assets[ref], let list = asset["layers"]?.arrayValue { children = try layersToNodes(list, local, depth + 1) }
            } else if ty != 3 {
                s.notes.append("Layer \"\(nm)\" (type \(jsString(ty))) is not supported (skipped).")
                continue
            }
            if children.isEmpty { continue }
            var seen = Set<Int>()
            let m = worldOf(li, &seen)
            let opacity = transformOf(l["ks"], frame, &s.notes).opacity
            var props = JSONObject([("id", .string(s.next())), ("type", "group")])
            if let name = l["nm"]?.stringValue { props["name"] = .string(name) }
            var group = try transformVectorNode(VectorNode(props: props, children: children), m)
            if opacity < 1 { group["opacity"] = num(opacity) }
            // Additive masks clip the layer.
            let all = l["masksProperties"]?.arrayValue
            let masks = (all ?? []).filter { mk in (nn(mk["mode"]) ?? "a") == "a" && !truthy(mk["inv"]) }
            if let all, masks.count != all.count { s.notes.append("Layer \"\(nm)\": only additive masks are imported.") }
            if !masks.isEmpty {
                let subpaths = masks.compactMap { subpathOf($0["pt"], frame) }
                let clip = try transformVectorNode(VectorNode(props: JSONObject([("id", .string(s.next())), ("type", "path"), ("name", "Mask"), ("subpaths", .null), ("fill", "#000000"), ("stroke", .null)]), subpaths: subpaths), m)
                var inner = group
                inner["transform"] = Optional<JSONValue>.none
                inner["opacity"] = Optional<JSONValue>.none
                var outer = JSONObject([("id", .string(s.next())), ("type", "group"), ("name", .string("\(group.name ?? "Layer") mask")), ("mask", .object(JSONObject([("type", "clip")])))])
                inner.id = s.next()
                outer["children"] = .null
                if let op = group["opacity"] { outer["opacity"] = op }
                group = VectorNode(props: outer, children: [clip, inner])
            }
            out.append(group)
        }
        return out.reversed()
    }
    let nodes = try layersToNodes(topLayers, s.frame, 0)
    let doc = VectorDocument(width: jsNumberOf(nn(root["w"]) ?? 512), height: jsNumberOf(nn(root["h"]) ?? 512), nodes: nodes)
    var seen = Set<String>()
    return VectorLottieImport(document: doc, notes: s.notes.filter { seen.insert($0).inserted })
}
