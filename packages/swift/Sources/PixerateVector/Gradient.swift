import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Gradient paints as SVG paint servers (`vector/gradient.ts`, `vectorPaintToSvg` in `vector/svg.ts`):
// linear and radial gradients, reflected ones with a reflect spread, plain stops. Conic and
// diamond gradients, reflected ones with a pad or repeat spread, stops that need expanding
// (midpoints, smoothness, linear or Oklab interpolation), gradients laid along or across a stroke
// and mesh / freeform fills throw `VectorNotPorted` (#624).

public let VECTOR_GRADIENT_SPREADS = ["pad", "reflect", "repeat"]
public let VECTOR_GRADIENT_INTERPOLATIONS = ["srgb", "linear", "oklab"]
public let VECTOR_STROKE_GRADIENT_MODES = ["within", "along", "across"]

/// A gradient stop of an SVG paint server (`SvgGradientStop`).
public struct SvgGradientStop: Equatable, Sendable {
    /// `"50%"`.
    public var offset: String
    public var stopColor: String
    public var stopOpacity: Double?

    public var json: JSONValue {
        var o = JSONObject([("offset", .string(offset)), ("stopColor", .string(stopColor))])
        if let op = stopOpacity { o["stopOpacity"] = .number(op) }
        return .object(o)
    }
}

/// A `<linearGradient>` / `<radialGradient>` paint server (`SvgGradientDef`); `attrs` keep their
/// JS types (numbers or strings) and order.
public struct SvgGradientDef: Equatable, Sendable {
    public var id: String
    /// `linear` or `radial`.
    public var type: String
    public var attrs: JSONObject
    public var stops: [SvgGradientStop]

    public var json: JSONValue {
        .object(JSONObject([("id", .string(id)), ("type", .string(type)), ("attrs", .object(attrs)), ("stops", .array(stops.map(\.json)))]))
    }
}

/// A paint server for `fill` / `stroke` (`VectorPaintDef`). Patterns (conic and diamond
/// gradients, stroke modes, meshes) are not ported yet, so every def is a gradient element.
public typealias VectorPaintDef = SvgGradientDef

@inline(__always) private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

private func finitePoint(_ p: JSONValue?) -> Bool {
    guard let x = p?["x"]?.numberValue, let y = p?["y"]?.numberValue else { return false }
    return x.isFinite && y.isFinite
}

private func point(_ p: JSONValue?) -> Vec2 { Vec2(p?["x"]?.numberValue ?? .nan, p?["y"]?.numberValue ?? .nan) }

/// A finite number member, or nil (`Number.isFinite(g[k])`).
private func finite(_ g: JSONObject, _ k: String) -> Double? { g[k]?.numberValue.flatMap { $0.isFinite ? $0 : nil } }

/// `fmt` of `gradient.ts`: rounded to `digits` decimals, as a JS string (`-0` is `"0"`).
func gradientFmt(_ n: Double, _ digits: Int = 4) -> String {
    let k = Foundation.pow(10, Double(digits))
    let v = JS.round(n * k) / k
    return v == 0 ? "0" : JSONValue.jsNumber(v)
}

private func fmtMatrix(_ m: VectorMatrix) -> String { "matrix(\([m.a, m.b, m.c, m.d, m.e, m.f].map { gradientFmt($0, 6) }.joined(separator: " ")))" }

private func isExactIdentity(_ m: VectorMatrix) -> Bool { m.a == 1 && m.b == 0 && m.c == 0 && m.d == 1 && m.e == 0 && m.f == 0 }

/// CSS angle (0° up, clockwise) to SVG `x1 y1 x2 y2` in the unit box (`angleToSvgLinearCoords`).
public func angleToSvgLinearCoords(_ angleDeg: Double = 180) -> (x1: Double, y1: Double, x2: Double, y2: Double) {
    let rad = ((90 - angleDeg) * Double.pi) / 180
    let dx = JS.cos(rad)
    let dy = -JS.sin(rad)
    let half = 0.5
    func r(_ v: Double) -> Double { JS.round(v * 1000) / 1000 }
    return (r(half - dx * half), r(half - dy * half), r(half + dx * half), r(half + dy * half))
}

// MARK: - Sanitizing

/// A gradient from untrusted input (agent commands, SVG data attributes), or nil when it is not
/// one (`sanitizeVectorGradient`): unknown fields dropped, numbers clamped, at least one stop.
public func sanitizeVectorGradient(_ input: JSONValue?) -> JSONObject? {
    guard let r = input?.objectValue, let type = r["type"]?.stringValue, VECTOR_GRADIENT_TYPES.contains(type), let raw = r["stops"]?.arrayValue else { return nil }
    var stops: [JSONValue] = []
    for s in raw {
        guard let x = s.objectValue, let color = x["color"]?.stringValue, let offset = x["offset"]?.numberValue, offset.isFinite else { continue }
        var stop = JSONObject([("offset", .number(clamp(offset, 0, 1))), ("color", .string(String(decoding: color.utf16.prefix(100), as: UTF16.self)))])
        if let o = x["opacity"]?.numberValue, o.isFinite, o != 1 { stop["opacity"] = .number(clamp(o, 0, 1)) }
        if let m = x["midpoint"]?.numberValue, m.isFinite, abs(m - 0.5) > 1e-6 { stop["midpoint"] = .number(clamp(m, 0.05, 0.95)) }
        stops.append(.object(stop))
    }
    if stops.isEmpty { return nil }
    var g = JSONObject([("type", .string(type)), ("stops", .array(stops))])
    for k in ["angle", "cx", "cy", "r"] { if let v = finite(r, k) { g[k] = .number(v) } }
    if finitePoint(r["start"]) && finitePoint(r["end"]) {
        g["start"] = point(r["start"]).json
        g["end"] = point(r["end"]).json
        if finitePoint(r["width"]) { g["width"] = point(r["width"]).json }
        if let u = r["units"]?.stringValue, u == "userSpaceOnUse" || u == "objectBoundingBox" { g["units"] = .string(u) }
    }
    if finitePoint(r["focal"]) && type == "radial" { g["focal"] = point(r["focal"]).json }
    if let fr = r["focalRadius"]?.numberValue, fr > 0, type == "radial" { g["focalRadius"] = .number(clamp(fr, 0, 0.99)) }
    if let s = r["spread"]?.stringValue, VECTOR_GRADIENT_SPREADS.contains(s), s != "pad" { g["spread"] = .string(s) }
    if let s = r["interpolation"]?.stringValue, VECTOR_GRADIENT_INTERPOLATIONS.contains(s), s != "srgb" { g["interpolation"] = .string(s) }
    if let s = r["smoothness"]?.numberValue, s > 0 { g["smoothness"] = .number(clamp(s, 0, 1)) }
    if let s = r["strokeMode"]?.stringValue, VECTOR_STROKE_GRADIENT_MODES.contains(s), s != "within" { g["strokeMode"] = .string(s) }
    return g
}

// MARK: - Stops

/// The stops sorted by offset (stable), offsets clamped, unreadable ones dropped (`sortedVectorGradientStops`).
func sortedVectorGradientStops(_ g: JSONObject) -> [JSONObject] {
    let stops = (g["stops"]?.arrayValue ?? []).compactMap(\.objectValue).filter { s in
        guard let o = s["offset"]?.numberValue, o.isFinite, s["color"]?.stringValue != nil else { return false }
        return true
    }.map { s -> JSONObject in
        var c = s
        c["offset"] = .number(clamp(s["offset"]!.numberValue!, 0, 1))
        return c
    }
    return jsSorted(stops) { $0["offset"]!.numberValue! - $1["offset"]!.numberValue! }
}

private func hasMidpoint(_ s: JSONObject) -> Bool {
    guard let m = s["midpoint"]?.numberValue, m.isFinite else { return false }
    return abs(m - 0.5) > 1e-3
}

/// Whether the gradient needs extra stops to look the same in SVG (`vectorGradientNeedsExpansion`).
func vectorGradientNeedsExpansion(_ g: JSONObject) -> Bool {
    (g["interpolation"]?.stringValue ?? "srgb") != "srgb" || (g["smoothness"]?.numberValue ?? 0) > 0 || (g["stops"]?.arrayValue ?? []).compactMap(\.objectValue).contains(where: hasMidpoint)
}

/// The stops SVG draws (`expandVectorGradientStops`): the stops as they are when nothing needs expanding.
func expandVectorGradientStops(_ g: JSONObject) throws -> [(offset: Double, color: String, opacity: Double?)] {
    // not ported yet: stop expansion for midpoints, smoothness and other spaces (vectorGradientRamp) (#624)
    if vectorGradientNeedsExpansion(g) { throw VectorNotPorted("gradients with midpoints, smoothness or linear / Oklab interpolation") }
    return sortedVectorGradientStops(g).map { s in
        let op = s["opacity"]?.numberValue
        return (s["offset"]!.numberValue!, s["color"]!.stringValue!, op != nil && op != 1 ? op : nil)
    }
}

// MARK: - Geometry

/// The gradient's frame points in its units (`vectorGradientPoints`).
struct VectorGradientPoints {
    var start: Vec2
    var end: Vec2
    var width: Vec2
    var focal: Vec2?
    var focalRadius: Double
    var userSpace: Bool
}

@inline(__always) private func sub(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x - b.x, a.y - b.y) }
@inline(__always) private func add(_ a: Vec2, _ b: Vec2) -> Vec2 { Vec2(a.x + b.x, a.y + b.y) }
@inline(__always) private func scale(_ a: Vec2, _ k: Double) -> Vec2 { Vec2(a.x * k, a.y * k) }
@inline(__always) private func dot(_ a: Vec2, _ b: Vec2) -> Double { a.x * b.x + a.y * b.y }
@inline(__always) private func perp(_ v: Vec2) -> Vec2 { Vec2(-v.y, v.x) }

private func shorthandPoints(_ g: JSONObject) -> (start: Vec2, end: Vec2, width: Vec2) {
    let type = g["type"]?.stringValue ?? ""
    if type == "linear" || type == "reflected" {
        let c = angleToSvgLinearCoords(finite(g, "angle") ?? 180)
        let start = type == "linear" ? Vec2(c.x1, c.y1) : Vec2(0.5, 0.5)
        let end = Vec2(c.x2, c.y2)
        return (start, end, add(start, perp(sub(end, start))))
    }
    let start = Vec2(finite(g, "cx") ?? 0.5, finite(g, "cy") ?? 0.5)
    let r = finite(g, "r") ?? 0.5
    if type == "radial" { return (start, Vec2(start.x + r, start.y), Vec2(start.x, start.y + r)) }
    let a = ((finite(g, "angle") ?? 90) * Double.pi) / 180
    let dir = Vec2(JS.sin(a), -JS.cos(a))
    return (start, add(start, scale(dir, r)), add(start, scale(perp(dir), r)))
}

func vectorGradientPoints(_ g: JSONObject) -> VectorGradientPoints {
    let explicit = finitePoint(g["start"]) && finitePoint(g["end"])
    let base = shorthandPoints(g)
    let start = explicit ? point(g["start"]) : base.start
    let end = explicit ? point(g["end"]) : base.end
    let width = explicit ? (finitePoint(g["width"]) ? point(g["width"]) : add(start, perp(sub(end, start)))) : base.width
    let radial = g["type"] == "radial"
    return VectorGradientPoints(
        start: start, end: end, width: width,
        focal: radial && finitePoint(g["focal"]) ? point(g["focal"]) : nil,
        focalRadius: radial ? clamp(finite(g, "focalRadius") ?? 0, 0, 0.99) : 0,
        userSpace: explicit && g["units"] == "userSpaceOnUse"
    )
}

/// The unit box → `bounds` matrix of `objectBoundingBox` gradients (`vectorBoxMatrix`).
func vectorBoxMatrix(_ bounds: VectorBounds?) -> VectorMatrix {
    guard let b = bounds else { return IDENTITY_MATRIX }
    var (x, y, w, h) = (b.x, b.y, b.width, b.height)
    let fallback = Swift.max(w, h, 1e-9) > 1e-9 ? Swift.max(w, h) : 1
    if !(w > 1e-9) {
        x -= fallback / 2 - w / 2
        w = fallback
    }
    if !(h > 1e-9) {
        y -= fallback / 2 - h / 2
        h = fallback
    }
    return VectorMatrix(w, 0, 0, h, x, y)
}

private func framePointsMatrix(_ p: VectorGradientPoints) -> VectorMatrix {
    VectorMatrix(p.end.x - p.start.x, p.end.y - p.start.y, p.width.x - p.start.x, p.width.y - p.start.y, p.start.x, p.start.y)
}

/// `invert` of `gradient.ts`: nil for a singular matrix.
private func invertOrNil(_ m: VectorMatrix) -> VectorMatrix? {
    let det = m.a * m.d - m.b * m.c
    if !det.isFinite || abs(det) < 1e-18 { return nil }
    return VectorMatrix(m.d / det, -m.b / det, -m.c / det, m.a / det, (m.c * m.f - m.d * m.e) / det, (m.b * m.e - m.a * m.f) / det)
}

/// The focal point in the unit frame, pulled inside the circle (`unitFocal`).
private func unitFocal(_ g: JSONObject) -> (f: Vec2, fr: Double)? {
    let p = vectorGradientPoints(g)
    if p.focal == nil && !(p.focalRadius > 0) { return nil }
    guard let inv = invertOrNil(framePointsMatrix(p)) else { return nil }
    var f = p.focal.map { applyMatrix(inv, $0) } ?? Vec2(0, 0)
    let reach = 0.99 * (1 - p.focalRadius)
    let r = JS.hypot(f.x, f.y)
    if r > reach { f = scale(f, reach / r) }
    return (f, p.focalRadius)
}

// MARK: - SVG paint servers

/// The SVG paint servers of a gradient on a shape whose own-space box is `bounds`
/// (`vectorGradientSvgDefs`): the first def's id is `id`.
public func vectorGradientSvgDefs(_ g: JSONObject, _ id: String, bounds: VectorBounds?) throws -> [VectorPaintDef] {
    let type = g["type"]?.stringValue ?? ""
    let spread = g["spread"]?.stringValue.flatMap { VECTOR_GRADIENT_SPREADS.contains($0) ? $0 : nil } ?? "pad"
    // not ported yet: conic and diamond patterns, reflected pad / repeat periods (expandVectorGradientSpread) (#624)
    if type == "conic" || type == "diamond" { throw VectorNotPorted("\(type) gradients") }
    if type == "reflected" && spread != "reflect" { throw VectorNotPorted("reflected gradients with a pad or repeat spread") }
    let stops = try expandVectorGradientStops(g).map { s in
        SvgGradientStop(offset: "\(gradientFmt(s.offset * 100, 3))%", stopColor: s.color, stopOpacity: s.opacity.map { JS.round($0 * 1e4) / 1e4 })
    }
    let p = vectorGradientPoints(g)
    let unitsM = p.userSpace ? IDENTITY_MATRIX : vectorBoxMatrix(bounds)
    let frameM = multiplyMatrices(framePointsMatrix(p), unitsM)
    var attrs = JSONObject([("gradientUnits", "userSpaceOnUse")])
    if type == "radial" {
        attrs["cx"] = 0
        attrs["cy"] = 0
        attrs["r"] = 1
        attrs["gradientTransform"] = .string(fmtMatrix(frameM))
        if spread != "pad" { attrs["spreadMethod"] = .string(spread) }
        if let f = unitFocal(g) {
            if abs(f.f.x) > 1e-9 || abs(f.f.y) > 1e-9 {
                attrs["fx"] = .string(gradientFmt(f.f.x, 6))
                attrs["fy"] = .string(gradientFmt(f.f.y, 6))
            }
            if f.fr > 0 { attrs["fr"] = .string(gradientFmt(f.fr, 6)) }
        }
        return [SvgGradientDef(id: id, type: "radial", attrs: attrs, stops: stops)]
    }
    let u = sub(p.end, p.start)
    let w = sub(p.width, p.start)
    let square = abs(dot(u, w)) <= 1e-9 * Swift.max(dot(u, u), dot(w, w), 1e-18)
    if square {
        attrs["x1"] = .string(gradientFmt(p.start.x, 6))
        attrs["y1"] = .string(gradientFmt(p.start.y, 6))
        attrs["x2"] = .string(gradientFmt(p.end.x, 6))
        attrs["y2"] = .string(gradientFmt(p.end.y, 6))
        if !isExactIdentity(unitsM) { attrs["gradientTransform"] = .string(fmtMatrix(unitsM)) }
    } else {
        attrs["x1"] = 0
        attrs["y1"] = 0
        attrs["x2"] = 1
        attrs["y2"] = 0
        attrs["gradientTransform"] = .string(fmtMatrix(frameM))
    }
    if spread != "pad" { attrs["spreadMethod"] = .string(spread) }
    return [SvgGradientDef(id: id, type: "linear", attrs: attrs, stops: stops)]
}

/// The box of a path's drawn outline in its own space (`vectorPathLocalBounds`).
public func vectorPathLocalBounds(_ node: VectorNode) -> VectorBounds? {
    guard let b = bezierPathBounds(.commands(subpathsToBezier(node.subpaths))) else { return nil }
    return VectorBounds(x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY)
}

/// A paint as an SVG attribute value plus the paint servers it needs (`vectorPaintToSvg`):
/// `url(#id)` refers to the first. `node` is the path painted; `role` is `fill` or `stroke`.
public func vectorPaintToSvg(_ paint: JSONValue?, _ gradientId: String, node: VectorNode? = nil, role: String = "fill") throws -> (value: String, defs: [VectorPaintDef]) {
    if !hasPaint(paint) { return ("none", []) }
    if let s = paint?.stringValue { return (s, []) }
    // not ported yet: mesh and freeform fills (vectorShadedSvgDefs) (#624)
    if isVectorShadedPaint(paint) { throw VectorNotPorted("mesh and freeform gradients") }
    guard isVectorGradient(paint), let g = paint?.objectValue else { return ("none", []) }
    if role == "stroke", node != nil, let mode = g["strokeMode"]?.stringValue, mode == "along" || mode == "across" {
        // not ported yet: gradients along or across a stroke (vectorStrokeGradientDefs) (#624)
        throw VectorNotPorted("gradients along or across a stroke")
    }
    let bounds = node.flatMap(vectorPathLocalBounds)
    return ("url(#\(gradientId))", try vectorGradientSvgDefs(g, gradientId, bounds: bounds))
}

// MARK: - Colours

/// `hex2` of `tokens/color.ts`: a 0–1 channel as two hex digits.
private func hexByte(_ v: Double) -> String {
    let n = Int(JS.round(clamp(v, 0, 1) * 255))
    return (n < 16 ? "0" : "") + String(n, radix: 16)
}

/// The colour as normalised hex (`#rrggbb`, `#rrggbbaa` when not opaque), or nil when it is not a
/// colour the token parser reads (`normalizeTokenColor` for strings: hex, `rgb()` / `rgba()`,
/// `transparent`, `black`, `white`).
func normalizeTokenColor(_ input: String) -> String? {
    let text = input.jsTrimmed
    if text.utf16.count > 200 { return nil }
    let lower = text.jsLowercased
    if lower == "transparent" { return "#00000000" }
    if lower == "black" { return "#000000" }
    if lower == "white" { return "#ffffff" }
    let hexDigits = Set("0123456789abcdefABCDEF")
    if text.hasPrefix("#") {
        let digits = text.dropFirst()
        guard [3, 4, 6, 8].contains(digits.count), digits.allSatisfy({ hexDigits.contains($0) }) else { return nil }
        var d = digits.lowercased()
        if d.count <= 4 { d = d.map { "\($0)\($0)" }.joined() }
        if d.count == 8 && d.hasSuffix("ff") { d = String(d.prefix(6)) }
        return "#\(d)"
    }
    guard lower.hasPrefix("rgb(") || lower.hasPrefix("rgba("), text.hasSuffix(")") else { return nil }
    let open = text.firstIndex(of: "(")!
    let inner = String(text[text.index(after: open) ..< text.index(before: text.endIndex)])
    if inner.contains("(") || inner.contains(")") { return nil }
    let halves = inner.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    let colour = halves[0]
    var parts = colour.split { $0 == " " || $0 == "," || $0 == "\t" || $0 == "\n" || $0 == "\r" || $0 == "\u{0C}" }.map(String.init)
    var alpha: String? = halves.count > 1 ? halves[1].jsTrimmed : nil
    if parts.count == 4 && alpha == nil { alpha = parts.removeLast() }
    if parts.count != 3 { return nil }
    func channel(_ part: String, _ scale: Double) -> Double? {
        let pct = part.hasSuffix("%")
        let n = (pct ? String(part.dropLast()) : part).jsToNumber
        if !n.isFinite { return nil }
        return pct ? n / 100 : n / scale
    }
    let channels = parts.map { channel($0, 255) }
    let a = alpha == nil || alpha == "" ? 1 : channel(alpha!, 1)
    guard let r = channels[0], let g = channels[1], let b = channels[2], let a else { return nil }
    let head = "#\(hexByte(r))\(hexByte(g))\(hexByte(b))"
    let ab = hexByte(a)
    return ab == "ff" ? head : head + ab
}

/// A CSS colour as 0–1 channels `[r, g, b, a]` (hex, `rgb()`, `transparent`, `black`, `white`),
/// or nil (`parseVectorColor`).
public func parseVectorColor(_ color: String) -> [Double]? {
    guard let hex = normalizeTokenColor(color) else { return nil }
    let chars = Array(hex.utf8)
    func n(_ i: Int) -> Double { Double(Int(String(decoding: chars[i ..< i + 2], as: UTF8.self), radix: 16)!) / 255 }
    return [n(1), n(3), n(5), chars.count == 9 ? n(7) : 1]
}

// MARK: - Editing gradients

/// Whether the gradient has explicit `start` and `end` points (`hasExplicitGradientGeometry`).
func hasExplicitGradientGeometry(_ g: JSONObject) -> Bool { finitePoint(g["start"]) && finitePoint(g["end"]) }

/// Whether the style is centred (radial, conic, diamond).
func isCentredVectorGradient(_ type: String) -> Bool { type == "radial" || type == "conic" || type == "diamond" }

/// The gradient with its stops reversed, each midpoint measured from the other side (`reverseVectorGradient`).
func reverseVectorGradient(_ g: JSONObject) -> JSONObject {
    let stops = Array(sortedVectorGradientStops(g).reversed())
    let next = stops.enumerated().map { i, s -> JSONValue in
        let following = i + 1 < stops.count ? stops[i + 1] : nil
        let mid = following.map { 1 - ($0["midpoint"]?.numberValue ?? 0.5) } ?? 0.5
        var rest = s
        rest["midpoint"] = Optional<JSONValue>.none
        rest["offset"] = .number(1 - s["offset"]!.numberValue!)
        if abs(mid - 0.5) > 1e-6 { rest["midpoint"] = .number(mid) }
        return .object(rest)
    }
    var out = g
    out["stops"] = .array(next)
    return out
}

/// The gradient with explicit points (in its units) replacing the shorthand (`explicitVectorGradient`).
func explicitVectorGradient(_ g: JSONObject) -> JSONObject {
    let p = vectorGradientPoints(g)
    var rest = g
    for k in ["angle", "cx", "cy", "r"] { rest[k] = Optional<JSONValue>.none }
    rest["start"] = p.start.json
    rest["end"] = p.end.json
    rest["width"] = p.width.json
    if let f = p.focal { rest["focal"] = f.json }
    rest["units"] = .string(p.userSpace ? "userSpaceOnUse" : "objectBoundingBox")
    return rest
}

/// A gradient changed to style `type`, keeping its stops, colour settings and placement (`convertVectorGradient`).
func convertVectorGradient(_ g: JSONObject, _ type: String) -> JSONObject {
    let from = g["type"]?.stringValue ?? ""
    if from == type { return g }
    var next = g
    next["type"] = .string(type)
    if type != "radial" {
        next["focal"] = Optional<JSONValue>.none
        next["focalRadius"] = Optional<JSONValue>.none
    }
    if !hasExplicitGradientGeometry(g) && isCentredVectorGradient(type) != isCentredVectorGradient(from) {
        for k in ["angle", "cx", "cy", "r"] { next[k] = Optional<JSONValue>.none }
    }
    return next
}

/// A default gradient for a paint that was a colour (or nothing): the colour fading to white (`defaultVectorGradient`).
func defaultVectorGradient(_ type: String = "linear", _ from: JSONValue? = nil) -> JSONObject {
    if isVectorGradient(from), let g = from?.objectValue { return convertVectorGradient(g, type) }
    let colour = from?.stringValue.flatMap { parseVectorColor($0) != nil ? $0 : nil } ?? "#000000"
    return JSONObject([("type", .string(type)), ("stops", [["offset": 0, "color": .string(colour)], ["offset": 1, "color": "#ffffff"]])])
}

/// `g` with `patch` applied (`applyVectorGradientPatch`): any gradient field (`null` removes it),
/// `aspect` and `reverse`; a style change converts it first. Nil when the result is not a gradient.
func applyVectorGradientPatch(_ g: JSONObject, _ patch: JSONObject) -> JSONObject? {
    var fields = patch
    let aspect = patch["aspect"]?.numberValue
    let reverse = patch["reverse"]?.boolValue ?? false
    let type = patch["type"]?.stringValue
    for k in ["aspect", "reverse", "type"] { fields[k] = Optional<JSONValue>.none }
    var next = type != nil && type != g["type"]?.stringValue ? convertVectorGradient(g, type!) : g
    for (k, v) in fields {
        if v == .null { next[k] = Optional<JSONValue>.none } else { next[k] = v }
    }
    // Explicit points replace the shorthand (and the other way round).
    if (truthy(fields["start"]) || truthy(fields["end"])) && !hasExplicitGradientGeometry(next) {
        var bare = g
        bare["start"] = Optional<JSONValue>.none
        bare["end"] = Optional<JSONValue>.none
        let p = vectorGradientPoints(bare)
        if next["start"] == nil { next["start"] = p.start.json }
        if next["end"] == nil { next["end"] = p.end.json }
    }
    if let aspect, aspect.isFinite {
        let e = explicitVectorGradient(next)
        let s = point(e["start"])
        let u = sub(point(e["end"]), s)
        let a = abs(aspect) < 0.01 ? (aspect < 0 ? -0.01 : 0.01) : aspect
        next = e
        next["width"] = add(s, scale(perp(u), a)).json
    }
    if reverse { next = reverseVectorGradient(next) }
    guard var clean = sanitizeVectorGradient(.object(next)) else { return nil }
    clean["stops"] = .array(sortedVectorGradientStops(clean).map { .object($0) })
    return clean
}
