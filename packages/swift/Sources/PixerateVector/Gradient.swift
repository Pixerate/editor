import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Gradient paints as SVG paint servers (`vector/gradient.ts`, `vectorPaintToSvg` in `vector/svg.ts`):
// linear, radial and reflected gradients as gradient elements, conic and diamond ones as patterns
// of gradient tiles, stops expanded for midpoints, smoothness and linear / Oklab interpolation,
// spread periods, gradients laid along or across a stroke (`GradientStroke.swift`) and mesh /
// freeform fills (`Shading.swift`).

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

/// A `<pattern>` paint server in user space (`VectorSvgPatternDef`): draw `gradients` and then
/// each tile (`d` filled with `fill`) in order. The `viewBox` in `attrs` matches the tile.
public struct VectorSvgPatternDef: Equatable, Sendable {
    public var id: String
    public var attrs: JSONObject
    public var gradients: [SvgGradientDef]
    public var tiles: [(d: String, fill: String)]

    public init(id: String, attrs: JSONObject, gradients: [SvgGradientDef], tiles: [(d: String, fill: String)]) {
        self.id = id
        self.attrs = attrs
        self.gradients = gradients
        self.tiles = tiles
    }

    public static func == (a: Self, b: Self) -> Bool {
        a.id == b.id && a.attrs == b.attrs && a.gradients == b.gradients && a.tiles.count == b.tiles.count && zip(a.tiles, b.tiles).allSatisfy { $0.d == $1.d && $0.fill == $1.fill }
    }

    public var json: JSONValue {
        .object(JSONObject([
            ("id", .string(id)), ("type", "pattern"), ("attrs", .object(attrs)), ("gradients", .array(gradients.map(\.json))),
            ("tiles", .array(tiles.map { .object(JSONObject([("d", .string($0.d)), ("fill", .string($0.fill))])) })),
        ]))
    }
}

/// A paint server for `fill` / `stroke` (`VectorPaintDef`): a gradient element or a pattern of
/// gradient tiles.
public enum VectorPaintDef: Equatable, Sendable {
    case gradient(SvgGradientDef)
    case pattern(VectorSvgPatternDef)

    public var id: String {
        switch self {
        case let .gradient(g): return g.id
        case let .pattern(p): return p.id
        }
    }

    /// `linear`, `radial` or `pattern`.
    public var type: String {
        switch self {
        case let .gradient(g): return g.type
        case .pattern: return "pattern"
        }
    }

    public var json: JSONValue {
        switch self {
        case let .gradient(g): return g.json
        case let .pattern(p): return p.json
        }
    }
}

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

/// A plain gradient stop (no midpoint): what SVG draws (`VectorGradientStop` without `midpoint`).
public struct VectorGradientStop: Equatable, Sendable {
    public var offset: Double
    public var color: String
    public var opacity: Double?

    public init(offset: Double, color: String, opacity: Double? = nil) {
        self.offset = offset
        self.color = color
        self.opacity = opacity
    }

    public var json: JSONValue {
        var o = JSONObject([("offset", .number(offset)), ("color", .string(color))])
        if let opacity { o["opacity"] = .number(opacity) }
        return .object(o)
    }
}

/// Straight-alpha sRGB channels, 0–1 (`VectorRgba`).
public typealias VectorRgba = [Double]

// MARK: Colour spaces

/// `#rrggbb` of 0–1 channels (`rgbaToHex` with an opaque alpha).
func rgbHex(_ r: Double, _ g: Double, _ b: Double) -> String { "#\(hexByte(r))\(hexByte(g))\(hexByte(b))" }

private func toLinear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : JS.pow((c + 0.055) / 1.055, 2.4) }
private func toGamma(_ c: Double) -> Double {
    let v = clamp(c, 0, 1)
    return v <= 0.0031308 ? 12.92 * v : 1.055 * JS.pow(v, 1 / 2.4) - 0.055
}

/// `srgbToLinear` / `linearToSrgb` of `color/convert.ts` (they keep the sign).
private func jsSign(_ v: Double) -> Double { v.isNaN ? .nan : v > 0 ? 1 : v < 0 ? -1 : v }
private func srgbToLinearSigned(_ v: Double) -> Double {
    let a = abs(v)
    return jsSign(v) * (a <= 0.04045 ? a / 12.92 : JS.pow((a + 0.055) / 1.055, 2.4))
}
private func linearToSrgbSigned(_ v: Double) -> Double {
    let a = abs(v)
    return jsSign(v) * (a <= 0.0031308 ? 12.92 * a : 1.055 * JS.pow(a, 1 / 2.4) - 0.055)
}

/// sRGB → Oklab (`rgbToOklab` of `color/convert.ts`).
func vectorRgbToOklab(_ r: Double, _ g: Double, _ b: Double) -> [Double] {
    let lr = srgbToLinearSigned(r), lg = srgbToLinearSigned(g), lb = srgbToLinearSigned(b)
    let l = JS.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
    let m = JS.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
    let s = JS.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

/// Oklab → sRGB clamped into 0–1 (`oklabToRgb` of `animation/color.ts`).
func vectorOklabToRgb(_ L: Double, _ A: Double, _ B: Double) -> [Double] {
    let l_ = L + 0.3963377774 * A + 0.2158037573 * B
    let m_ = L - 0.1055613458 * A - 0.0638541728 * B
    let s_ = L - 0.0894841775 * A - 1.291485548 * B
    let l = JS.pow(l_, 3), m = JS.pow(m_, 3), s = JS.pow(s_, 3)
    return [
        clamp(linearToSrgbSigned(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), 0, 1),
        clamp(linearToSrgbSigned(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), 0, 1),
        clamp(linearToSrgbSigned(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), 0, 1),
    ]
}

private func intoSpace(_ space: String, _ c: [Double]) -> [Double] {
    if space == "linear" { return [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])] }
    if space == "oklab" { return vectorRgbToOklab(c[0], c[1], c[2]) }
    return [c[0], c[1], c[2]]
}

private func outOfSpace(_ space: String, _ v: [Double]) -> [Double] {
    if space == "linear" { return [toGamma(v[0]), toGamma(v[1]), toGamma(v[2])] }
    if space == "oklab" { return vectorOklabToRgb(v[0], v[1], v[2]) }
    return [clamp(v[0], 0, 1), clamp(v[1], 0, 1), clamp(v[2], 0, 1)]
}

// MARK: Ramps and expansion

private let MID_MIN = 0.01
private let MID_MAX = 0.99

/// Where relative position `u` of a segment lands once its midpoint is `m` (`gradientMidpointRemap`).
public func gradientMidpointRemap(_ u: Double, _ m: Double) -> Double {
    let mid = clamp(m, MID_MIN, MID_MAX)
    if abs(mid - 0.5) < 1e-6 { return u }
    return u <= mid ? (0.5 * u) / mid : 0.5 + (0.5 * (u - mid)) / (1 - mid)
}

/// A gradient's colour ramp, prepared for sampling (`VectorGradientRamp`).
public struct VectorGradientRamp: Sendable {
    fileprivate struct Point: Sendable {
        var t: Double
        var v: [Double]
        var a: Double
        var mid: Double
    }

    fileprivate let space: String
    fileprivate let smooth: Double
    fileprivate let pts: [Point]

    /// Straight-alpha sRGB at `t` (clamped to 0–1).
    public func sample(_ t: Double) -> VectorRgba {
        let n = pts.count
        if n == 0 { return [0, 0, 0, 0] }
        let first = pts[0]
        let last = pts[n - 1]
        func at(_ p: Point) -> VectorRgba { outOfSpace(space, p.v) + [p.a] }
        if !(t > first.t) || n < 2 { return at(first) }
        if t >= last.t { return at(last) }
        var i = 0
        while i + 2 < n && !(t >= pts[i].t && t <= pts[i + 1].t) { i += 1 }
        let p0 = pts[i]
        let p1 = pts[i + 1]
        let h = Swift.max(p1.t - p0.t, 1e-6)
        let u = gradientMidpointRemap((t - p0.t) / h, p0.mid)
        let alpha = p0.a + (p1.a - p0.a) * u
        if smooth <= 0 { return outOfSpace(space, (0 ..< 3).map { c in p0.v[c] + (p1.v[c] - p0.v[c]) * u }) + [alpha] }
        // Catmull-Rom tangents per unit t; the ends use half the chord slope.
        func tangent(_ k: Int) -> [Double] {
            let (a, b) = k == 0 ? (0, 1) : k == n - 1 ? (n - 2, n - 1) : (k - 1, k + 1)
            let d = Swift.max(pts[b].t - pts[a].t, 1e-6)
            let half = k == 0 || k == n - 1 ? 0.5 : 1
            return (0 ..< 3).map { c in ((pts[b].v[c] - pts[a].v[c]) / d) * half }
        }
        let m0 = tangent(i)
        let m1 = tangent(i + 1)
        let u2 = u * u
        let u3 = u2 * u
        let h00 = 2 * u3 - 3 * u2 + 1
        let h10 = u3 - 2 * u2 + u
        let h01 = -2 * u3 + 3 * u2
        let h11 = u3 - u2
        let v = (0 ..< 3).map { c -> Double in
            let linear = p0.v[c] + (p1.v[c] - p0.v[c]) * u
            let spline = h00 * p0.v[c] + h10 * h * m0[c] + h01 * p1.v[c] + h11 * h * m1[c]
            let value = linear + (spline - linear) * smooth
            return clamp(value, Swift.min(p0.v[c], p1.v[c]), Swift.max(p0.v[c], p1.v[c]))
        }
        return outOfSpace(space, v) + [alpha]
    }
}

/// `s.opacity ?? 1` read as a number.
private func stopOpacity(_ s: JSONObject) -> Double {
    guard let v = s["opacity"], v != .null else { return 1 }
    return v.numberValue ?? .nan
}

/// The colour ramp of a gradient (midpoints, smoothness and interpolation space applied), or nil
/// when a stop colour is unreadable (`vectorGradientRamp`).
public func vectorGradientRamp(_ g: JSONObject) -> VectorGradientRamp? {
    let space = g["interpolation"]?.stringValue.flatMap { VECTOR_GRADIENT_INTERPOLATIONS.contains($0) ? $0 : nil } ?? "srgb"
    let smooth = clamp(finite(g, "smoothness") ?? 0, 0, 1)
    var pts: [VectorGradientRamp.Point] = []
    for s in sortedVectorGradientStops(g) {
        guard let c = parseVectorColor(s["color"]!.stringValue!) else { return nil }
        let mid = s["midpoint"].flatMap { $0 == .null ? nil : ($0.numberValue ?? .nan) } ?? 0.5
        pts.append(.init(t: s["offset"]!.numberValue!, v: intoSpace(space, c), a: c[3] * clamp(stopOpacity(s), 0, 1), mid: mid))
    }
    return VectorGradientRamp(space: space, smooth: smooth, pts: pts)
}

private func stopOf(_ offset: Double, _ c: VectorRgba) -> VectorGradientStop {
    let opacity = JS.round(c[3] * 1e4) / 1e4
    return VectorGradientStop(offset: offset, color: rgbHex(c[0], c[1], c[2]), opacity: opacity < 1 ? opacity : nil)
}

private func maxDiff(_ a: VectorRgba, _ b: VectorRgba) -> Double {
    Swift.max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]), abs(a[3] - b[3]))
}

private func lerpRgba(_ a: VectorRgba, _ b: VectorRgba, _ u: Double) -> VectorRgba { (0 ..< 4).map { c in a[c] + (b[c] - a[c]) * u } }

/// Plain stops (no midpoints) that SVG's sRGB interpolation turns into the gradient's colours
/// (`expandVectorGradientStops`): the stops as they are when nothing needs expanding, one extra
/// stop per off-centre midpoint for plain sRGB, else stops placed adaptively until linear
/// interpolation is within `tolerance` (default half a level) of the true ramp.
public func expandVectorGradientStops(_ g: JSONObject, tolerance: Double? = nil) -> [VectorGradientStop] {
    let stops = sortedVectorGradientStops(g)
    func plain() -> [VectorGradientStop] {
        stops.map { s in
            let op = s["opacity"]?.numberValue
            return VectorGradientStop(offset: s["offset"]!.numberValue!, color: s["color"]!.stringValue!, opacity: op != nil && op != 1 ? op : nil)
        }
    }
    if !vectorGradientNeedsExpansion(g) { return plain() }
    guard let ramp = vectorGradientRamp(g), stops.count >= 2 else { return plain() }
    let tol = tolerance ?? 0.5 / 255
    let sRgbOnly = (g["interpolation"]?.stringValue ?? "srgb") == "srgb" && !((g["smoothness"]?.numberValue ?? 0) > 0)
    func own(_ s: JSONObject) -> VectorRgba {
        let c = parseVectorColor(s["color"]!.stringValue!)!
        return [c[0], c[1], c[2], c[3] * clamp(stopOpacity(s), 0, 1)]
    }
    var out: [VectorGradientStop] = []
    func push(_ offset: Double, _ c: VectorRgba) { out.append(stopOf(offset, c)) }
    for i in stops.indices {
        let a = stops[i]
        let ao = a["offset"]!.numberValue!
        push(ao, own(a))
        guard i + 1 < stops.count else { continue }
        let b = stops[i + 1]
        let bo = b["offset"]!.numberValue!
        if bo - ao < 1e-9 { continue }
        var knots = [ao]
        if hasMidpoint(a) { knots.append(ao + (bo - ao) * clamp(a["midpoint"]!.numberValue!, MID_MIN, MID_MAX)) }
        knots.append(bo)
        // Samples just inside the segment (the ramp at its ends is the neighbouring segment's).
        func inside(_ t: Double) -> VectorRgba { ramp.sample(clamp(t, ao + 1e-9, bo - 1e-9)) }
        for k in 0 ..< knots.count - 1 {
            let t0 = knots[k]
            let t1 = knots[k + 1]
            if k > 0 { push(t0, inside(t0)) }
            if sRgbOnly { continue }
            func refine(_ x0: Double, _ c0: VectorRgba, _ x1: Double, _ c1: VectorRgba, _ depth: Int) {
                let xm = (x0 + x1) / 2
                let cm = inside(xm)
                // Checked near the ends too: gamma curves bend hardest next to a black channel.
                let good = depth >= 8 || [0.03, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97].allSatisfy { f in maxDiff(inside(x0 + (x1 - x0) * f), lerpRgba(c0, c1, f)) <= tol }
                if good { return }
                refine(x0, c0, xm, cm, depth + 1)
                push(xm, cm)
                refine(xm, cm, x1, c1, depth + 1)
            }
            refine(t0, inside(t0), t1, inside(t1), 0)
        }
    }
    return out
}

/// What the gradient paints at `t` (0–1 along its stops): `#rrggbb` and opacity (`sampleVectorGradient`).
public func sampleVectorGradient(_ g: JSONObject, _ t: Double) -> (color: String, opacity: Double) {
    if let ramp = vectorGradientRamp(g) {
        let c = ramp.sample(t)
        return (rgbHex(c[0], c[1], c[2]), c[3])
    }
    let stops = sortedVectorGradientStops(g)
    guard let s = stops.reversed().first(where: { $0["offset"]!.numberValue! <= t }) ?? stops.first else { return ("#000000", 0) }
    return (s["color"]!.stringValue!, s["opacity"]?.numberValue ?? 1)
}

/// Linear interpolation between plain stops (what SVG draws from them), straight alpha (`samplePlainStops`).
public func samplePlainStops(_ stops: [VectorGradientStop], _ t: Double) -> VectorRgba {
    let parsed = stops.map { s -> (t: Double, c: VectorRgba) in
        let c = parseVectorColor(s.color) ?? [0, 0, 0, 1]
        return (s.offset, [c[0], c[1], c[2], c[3] * (s.opacity ?? 1)])
    }
    guard let first = parsed.first else { return [0, 0, 0, 0] }
    if t <= first.t { return first.c }
    for i in 0 ..< parsed.count - 1 {
        let a = parsed[i]
        let b = parsed[i + 1]
        if t <= b.t { return b.t - a.t < 1e-12 ? b.c : lerpRgba(a.c, b.c, (t - a.t) / (b.t - a.t)) }
    }
    return parsed[parsed.count - 1].c
}

/// The part of the gradient from `from` to `to` (either order) as plain stops over 0–1
/// (`spanVectorGradientStops`).
public func spanVectorGradientStops(_ g: JSONObject, _ from: Double, _ to: Double, _ expandedIn: [VectorGradientStop]? = nil) -> [VectorGradientStop] {
    let expanded = expandedIn ?? expandVectorGradientStops(g)
    if to < from {
        return spanVectorGradientStops(g, to, from, expanded).map { x in
            var y = x
            y.offset = 1 - x.offset
            return y
        }.reversed()
    }
    let d = to - from
    var out = [stopOf(0, samplePlainStops(expanded, from))]
    if d > 1e-9 {
        for s in expanded where s.offset > from && s.offset < to {
            var y = s
            y.offset = (s.offset - from) / d
            out.append(y)
        }
    }
    out.append(stopOf(1, samplePlainStops(expanded, to)))
    return out
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

/// The gradient's units → node space (`vectorGradientUnitsMatrix`).
func vectorGradientUnitsMatrix(_ g: JSONObject, _ bounds: VectorBounds?) -> VectorMatrix {
    vectorGradientPoints(g).userSpace ? IDENTITY_MATRIX : vectorBoxMatrix(bounds)
}

/// The gradient's unit frame → node space (`vectorGradientMatrix`).
func vectorGradientMatrix(_ g: JSONObject, _ bounds: VectorBounds?) -> VectorMatrix {
    multiplyMatrices(framePointsMatrix(vectorGradientPoints(g)), vectorGradientUnitsMatrix(g, bounds))
}

/// A gradient after its node's geometry goes through a non-affine map `f` (`mapVectorGradient`):
/// `userSpaceOnUse` handles are mapped point by point; box gradients follow the new bounds.
public func mapVectorGradient(_ g: JSONObject, _ f: (Vec2) -> Vec2) -> JSONObject {
    if !hasExplicitGradientGeometry(g) || g["units"] != "userSpaceOnUse" { return g }
    let p = vectorGradientPoints(g)
    var out = g
    out["start"] = f(p.start).json
    out["end"] = f(p.end).json
    out["width"] = f(p.width).json
    if let focal = p.focal { out["focal"] = f(focal).json }
    return out
}

/// A paint after its node's geometry goes through a non-affine map `f` (`mapVectorPaint`).
public func mapVectorPaint(_ paint: JSONValue?, _ f: (Vec2) -> Vec2) -> JSONValue? {
    if isVectorShadedPaint(paint), let o = paint?.objectValue { return .object(mapVectorShadedPaint(o, f)) }
    if isVectorGradient(paint), let o = paint?.objectValue { return .object(mapVectorGradient(o, f)) }
    return paint
}

// MARK: - Spread as stop periods

/// Most periods a spread is expanded to (`VECTOR_GRADIENT_MAX_PERIODS`).
public let VECTOR_GRADIENT_MAX_PERIODS = 64

/// The stops of one period, from 0 to 1, the end colours held out to the ends (`wholePeriod`).
private func wholePeriod(_ stops: [VectorGradientStop]) -> [VectorGradientStop] {
    var out = stops
    if let first = out.first, first.offset > 0 {
        var s = first
        s.offset = 0
        out.insert(s, at: 0)
    }
    if let last = out.last, last.offset < 1 {
        var s = last
        s.offset = 1
        out.append(s)
    }
    return out
}

/// Plain stops reversed (`reverseVectorGradient` of stops without midpoints).
private func reversedPlainStops(_ stops: [VectorGradientStop]) -> [VectorGradientStop] {
    let sorted = jsSorted(stops.map { s -> VectorGradientStop in
        var c = s
        c.offset = clamp(s.offset, 0, 1)
        return c
    }) { $0.offset - $1.offset }
    return sorted.reversed().map { s in
        var c = s
        c.offset = 1 - s.offset
        return c
    }
}

/// Stops repeating plain stops over periods `lo` … `hi`, period `k` mirrored when `mirrored(k)`
/// (`periodicVectorGradientStops`).
public func periodicVectorGradientStops(_ stops: [VectorGradientStop], _ lo: Double, _ hi: Double, _ mirrored: (Double) -> Bool) -> [VectorGradientStop] {
    let period = wholePeriod(stops)
    let back = reversedPlainStops(period)
    let n = Swift.max(1, hi - lo)
    var out: [VectorGradientStop] = []
    var j = 0.0
    while j < n {
        defer { j += 1 }
        for s in mirrored(lo + j) ? back : period {
            var c = s
            c.offset = (j + s.offset) / n
            out.append(c)
        }
    }
    return out
}

private func boxCorners(_ b: VectorBounds) -> [Vec2] {
    [Vec2(b.x, b.y), Vec2(b.x + b.width, b.y), Vec2(b.x + b.width, b.y + b.height), Vec2(b.x, b.y + b.height)]
}

/// A linear or reflected gradient's spread as stop periods over `area` (`expandVectorGradientSpread`),
/// or nil when a linear gradient pads.
public func expandVectorGradientSpread(_ g: JSONObject, _ bounds: VectorBounds?, _ area: VectorBounds) -> (start: Vec2, end: Vec2, from: Double, to: Double, matrix: VectorMatrix, stops: [VectorGradientStop], capped: Bool)? {
    let m = vectorGradientMatrix(g, bounds)
    let spread = g["spread"]?.stringValue ?? "pad"
    let reflected = g["type"] == "reflected"
    guard let inv = invertOrNil(m), reflected || spread != "pad" else { return nil }
    func odd(_ k: Double) -> Bool { (k.truncatingRemainder(dividingBy: 2) + 2).truncatingRemainder(dividingBy: 2) == 1 }
    let stops = expandVectorGradientStops(g)
    func along(_ a: Double, _ b: Double, _ mirrored: (Double) -> Bool, _ capped: Bool = false) -> (start: Vec2, end: Vec2, from: Double, to: Double, matrix: VectorMatrix, stops: [VectorGradientStop], capped: Bool) {
        (applyMatrix(m, Vec2(a, 0)), applyMatrix(m, Vec2(b, 0)), a, b, m, periodicVectorGradientStops(stops, a, b, mirrored), capped)
    }
    if reflected && spread == "pad" { return along(-1, 1) { $0 < 0 } }
    let us = boxCorners(area).map { applyMatrix(inv, $0).x }
    var lo = Foundation.floor(us.min()!)
    var hi = Foundation.ceil(us.max()!)
    if reflected {
        lo = Swift.min(lo, -1)
        hi = Swift.max(hi, 1)
    }
    hi = Swift.max(hi, lo + 1)
    if !reflected && lo >= 0 && hi <= 1 { return nil }
    let maxP = Double(VECTOR_GRADIENT_MAX_PERIODS)
    let capped = hi - lo > maxP
    if capped {
        lo = Swift.max(lo, -maxP / 2)
        hi = lo + maxP
    }
    // Period k covers u in [k, k + 1]. A reflected gradient runs |u|: before the start, periods run backwards.
    let mirrored: (Double) -> Bool = reflected
        ? { k in
            let j = k >= 0 ? k : -k - 1
            let own = spread == "reflect" && odd(j)
            return k < 0 ? !own : own
        }
        : { k in spread == "reflect" && odd(k) }
    return along(lo, hi, mirrored, capped)
}

// MARK: - SVG paint servers

func toSvgStops(_ stops: [VectorGradientStop]) -> [SvgGradientStop] {
    stops.map { s in
        SvgGradientStop(offset: "\(gradientFmt(s.offset * 100, 3))%", stopColor: s.color, stopOpacity: s.opacity.flatMap { $0 != 1 ? JS.round($0 * 1e4) / 1e4 : nil })
    }
}

func polygonD(_ pts: [Vec2], _ precision: Int) -> String {
    "M" + pts.map { "\(gradientFmt($0.x, precision)) \(gradientFmt($0.y, precision))" }.joined(separator: "L") + "Z"
}

func padBounds(_ b: VectorBounds, _ pad: Double) -> VectorBounds {
    VectorBounds(x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad)
}

/// The area a gradient on a shape with box `bounds` paints: the box padded by 1 (`vectorGradientArea`).
public func vectorGradientArea(_ bounds: VectorBounds?) -> VectorBounds { padBounds(bounds ?? VectorBounds(x: 0, y: 0, width: 1, height: 1), 1) }

/// Smallest stretch of a matrix (`minScale`).
private func minScale(_ m: VectorMatrix) -> Double {
    let p = m.a * m.a + m.b * m.b
    let q = m.c * m.c + m.d * m.d
    let r = m.a * m.c + m.b * m.d
    return Foundation.sqrt(Swift.max(0, (p + q - Foundation.sqrt(JS.pow(p - q, 2) + 4 * r * r)) / 2))
}

/// A user-space pattern tile over `area` with the matching `viewBox` (`patternAttrs`).
public func patternAttrs(_ area: VectorBounds) -> JSONObject {
    let v = [area.x, area.y, Swift.max(area.width, 1e-3), Swift.max(area.height, 1e-3)].map { gradientFmt($0, 3) }
    return JSONObject([
        ("patternUnits", "userSpaceOnUse"), ("x", .string(v[0])), ("y", .string(v[1])), ("width", .string(v[2])), ("height", .string(v[3])),
        ("viewBox", .string(v.joined(separator: " "))),
    ])
}

private func patternDef(_ id: String, _ area: VectorBounds, _ gradients: [SvgGradientDef], _ tiles: [(d: String, fill: String)]) -> VectorPaintDef {
    .pattern(VectorSvgPatternDef(id: id, attrs: patternAttrs(area), gradients: gradients, tiles: tiles))
}

/// The SVG paint servers of a gradient on a shape whose own-space box is `bounds`
/// (`vectorGradientSvgDefs`): the first def's id is `id`. `area` is what the paint must cover
/// (default `bounds` padded by 1), `wedges` the conic wedges (default 72).
public func vectorGradientSvgDefs(_ g: JSONObject, _ id: String, bounds: VectorBounds?, area areaIn: VectorBounds? = nil, wedges: Double? = nil, precision: Int? = nil) -> [VectorPaintDef] {
    let precision = precision ?? 3
    let area = areaIn ?? vectorGradientArea(bounds)
    let type = g["type"]?.stringValue ?? ""
    let spread = g["spread"]?.stringValue.flatMap { VECTOR_GRADIENT_SPREADS.contains($0) ? $0 : nil } ?? "pad"
    let stops = expandVectorGradientStops(g)
    let p = vectorGradientPoints(g)
    let unitsM = vectorGradientUnitsMatrix(g, bounds)
    let frameM = multiplyMatrices(framePointsMatrix(p), unitsM)
    var attrs = JSONObject([("gradientUnits", "userSpaceOnUse")])
    switch type {
    case "linear", "reflected":
        if type == "reflected" && spread != "reflect" {
            // Pad: mirrored stops over [2·start − end, end]; repeat: periods over the area, the ones before the start mirrored.
            let ex = expandVectorGradientSpread(g, bounds, area)
            let (a, b) = ex.map { ($0.from, $0.to) } ?? (-1, 1)
            let st = ex?.stops ?? periodicVectorGradientStops(stops, -1, 1) { $0 < 0 }
            attrs["x1"] = .number(a)
            attrs["y1"] = 0
            attrs["x2"] = .number(b)
            attrs["y2"] = 0
            attrs["gradientTransform"] = .string(fmtMatrix(frameM))
            return [.gradient(SvgGradientDef(id: id, type: "linear", attrs: attrs, stops: toSvgStops(st)))]
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
        return [.gradient(SvgGradientDef(id: id, type: "linear", attrs: attrs, stops: toSvgStops(stops)))]
    case "radial":
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
        return [.gradient(SvgGradientDef(id: id, type: "radial", attrs: attrs, stops: toSvgStops(stops)))]
    case "diamond":
        guard let inv = invertOrNil(frameM) else { return [patternDef(id, area, [], [(polygonD(boxCorners(area), precision), stops.last?.color ?? "none")])] }
        let reach = 2 * boxCorners(area).map { c -> Double in
            let q = applyMatrix(inv, c)
            return abs(q.x) + abs(q.y)
        }.reduce(-Double.infinity, Swift.max) + 1
        // Each quadrant overlaps its neighbours by about 0.75 units, hiding anti-aliasing seams.
        let delta = Swift.min(0.05 * reach, 0.75 / Swift.max(minScale(frameM), 1e-9))
        var gradients: [SvgGradientDef] = []
        var tiles: [(d: String, fill: String)] = []
        for (k, sxy) in [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)].enumerated() {
            let (sx, sy) = sxy
            let gid = "\(id)-q\(k)"
            var a = attrs
            a["x1"] = 0
            a["y1"] = 0
            a["x2"] = .number(sx / 2)
            a["y2"] = .number(sy / 2)
            a["gradientTransform"] = .string(fmtMatrix(frameM))
            if spread != "pad" { a["spreadMethod"] = .string(spread) }
            gradients.append(SvgGradientDef(id: gid, type: "linear", attrs: a, stops: toSvgStops(stops)))
            let quad = [Vec2(-delta * sx, -delta * sy), Vec2(reach * sx, -delta * sy), Vec2(-delta * sx, reach * sy)].map { applyMatrix(frameM, $0) }
            tiles.append((polygonD(quad, precision), "url(#\(gid))"))
        }
        return [patternDef(id, area, gradients, tiles)]
    case "conic":
        return [conicPattern(id, frameM, stops, area, wedges ?? 72, precision)]
    default:
        return []
    }
}

/// A conic gradient as thin wedges round the centre, each with a linear gradient across it (`conicPattern`).
private func conicPattern(_ id: String, _ frameM: VectorMatrix, _ stops: [VectorGradientStop], _ area: VectorBounds, _ wedges: Double, _ precision: Int) -> VectorPaintDef {
    let n = Int(Swift.max(8, Swift.min(720, JS.round(wedges))))
    let half = Double.pi / Double(n)
    guard let inv = invertOrNil(frameM), !stops.isEmpty else { return patternDef(id, area, [], [(polygonD(boxCorners(area), precision), stops.first?.color ?? "none")]) }
    let reach = (boxCorners(area).map { c -> Double in
        let q = applyMatrix(inv, c)
        return JS.hypot(q.x, q.y)
    }.reduce(-Double.infinity, Swift.max) + 1) / JS.cos(half)
    let overlap = Swift.min(half, 0.002)
    var gradients: [SvgGradientDef] = []
    var tiles: [(d: String, fill: String)] = []
    for k in 0 ..< n {
        let a0 = (2 * Double.pi * Double(k)) / Double(n)
        let a1 = (2 * Double.pi * Double(k + 1)) / Double(n)
        let mid = (a0 + a1) / 2
        let tau = Vec2(-JS.sin(mid), JS.cos(mid))
        let s = JS.sin(half)
        func at(_ angle: Double) -> Double { (JS.sin(angle - mid) / s + 1) / 2 }
        let t0 = Double(k) / Double(n)
        let t1 = Double(k + 1) / Double(n)
        var own = [stopOf(0, samplePlainStops(stops, t0))]
        for st in stops where st.offset > t0 && st.offset < t1 {
            var c = st
            c.offset = at(st.offset * 2 * Double.pi)
            own.append(c)
        }
        own.append(stopOf(1, samplePlainStops(stops, t1)))
        let gid = "\(id)-w\(k)"
        let attrs = JSONObject([
            ("gradientUnits", "userSpaceOnUse"), ("x1", .string(gradientFmt(-s * tau.x, 6))), ("y1", .string(gradientFmt(-s * tau.y, 6))),
            ("x2", .string(gradientFmt(s * tau.x, 6))), ("y2", .string(gradientFmt(s * tau.y, 6))), ("gradientTransform", .string(fmtMatrix(frameM))),
        ])
        gradients.append(SvgGradientDef(id: gid, type: "linear", attrs: attrs, stops: toSvgStops(own)))
        let from = a0 - (k == 0 ? 0 : overlap)
        let pts = [Vec2(0, 0), Vec2(reach * JS.cos(from), reach * JS.sin(from)), Vec2(reach * JS.cos(a1), reach * JS.sin(a1))].map { applyMatrix(frameM, $0) }
        tiles.append((polygonD(pts, precision), "url(#\(gid))"))
    }
    return patternDef(id, area, gradients, tiles)
}

/// The box of a path's drawn outline in its own space (`vectorPathLocalBounds`).
public func vectorPathLocalBounds(_ node: VectorNode) -> VectorBounds? {
    guard let b = bezierPathBounds(.commands(subpathsToBezier(node.subpaths))) else { return nil }
    return VectorBounds(x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY)
}

/// A paint as an SVG attribute value plus the paint servers it needs (`vectorPaintToSvg`):
/// `url(#id)` refers to the first. `node` is the path painted; `role` is `fill` or `stroke`
/// (a stroke lays `along` / `across` gradients on the stroke and covers its reach).
public func vectorPaintToSvg(_ paint: JSONValue?, _ gradientId: String, node: VectorNode? = nil, role: String = "fill", precision: Int? = nil) -> (value: String, defs: [VectorPaintDef]) {
    if !hasPaint(paint) { return ("none", []) }
    if let s = paint?.stringValue { return (s, []) }
    let shaded = isVectorShadedPaint(paint)
    guard shaded || isVectorGradient(paint), let g = paint?.objectValue else { return ("none", []) }
    let bounds = node.flatMap(vectorPathLocalBounds)
    let reach = node != nil && role == "stroke" ? vectorStrokeReach(node!) + 1 : 1
    let area = bounds.map { padBounds($0, reach) }
    if shaded { return ("url(#\(gradientId))", vectorShadedSvgDefs(g, gradientId, bounds: bounds, area: area, precision: precision ?? 3)) }
    if let node, role == "stroke", let mode = g["strokeMode"]?.stringValue, mode == "along" || mode == "across" {
        return ("url(#\(gradientId))", vectorStrokeGradientDefs(g, gradientId, node, bounds: bounds, area: area, precision: precision ?? 3))
    }
    return ("url(#\(gradientId))", vectorGradientSvgDefs(g, gradientId, bounds: bounds, area: area, precision: precision ?? 3))
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
