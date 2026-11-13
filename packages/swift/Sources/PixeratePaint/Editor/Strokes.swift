import Foundation
import PixerateCore
import PixerateRaster

/**
 * Strokes as data (`paint-editor/strokes.ts`). Every committed stroke is recorded with the brush,
 * colour, raw pen samples, jitter seed and symmetry copies it was painted with, so it replays to
 * the same pixels. In memory a stroke keeps its brush as the engine painted it; saved, the brush
 * is a facet brush (`strokeToJSON`).
 */

/// An affine map [a, b, c, d, e, f]: (x, y) → (a·x + b·y + e, c·x + d·y + f).
public typealias Affine = [Double]

public let IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0]

private let nextStrokeKey = Locked(1)

/// A key per stroke object: the TS core keys painted bounds and live-layer membership by object identity.
func newStrokeKey() -> Int { nextStrokeKey.with { v -> Int in defer { v += 1 }; return v } }

public struct RecordedStroke {
    /// Which stroke object this is (a changed stroke is another object, with another key).
    public var key = newStrokeKey()
    public var id: String
    public var layerId: String
    public var brush: PaintBrush
    /// #rrggbb
    public var color: String
    /// Raw pen samples in document pixels, before smoothing.
    public var points: [PenPoint]
    public var seed: Int
    /// Extra copies painted with the stroke (mirror / kaleidoscope), as affine maps of the points.
    public var copies: [Affine]?
    /// What the brush carried at the start (Mixer Brush and wet-capable brushes).
    public var load: MixerLoad?
    /// The mask stencils it was painted through (so a replay keeps to them).
    public var stencils: [Stencil]?
    /// Gradient paint, with concrete colours.
    public var paint: PaintGradientSource?
    /// Effect paint (recorded instead of `paint`): strokes replay with the effect's pixels.
    public var effect: PaintEffectPaint?
    /// Wet brushes: the wet simulation's clock (steps) at which each point was applied.
    public var steps: [Int]?
    /// Antimatter brushes: the layer ids in stack order that were visible when the stroke was painted.
    public var targets: [String]?
    /// Scraper strokes: the layers it cut through, top to bottom, so a replay cuts the same ones
    /// whatever is hidden or locked when it runs (strokes without it derive them again).
    public var scrapeLayerIds: [String]?
    /// The light / dark pair the colour came from (both #rrggbb), when it came from one (`dualColor`).
    public var dualColor: PaintDualColor?
}

/// A colour for each scheme, both #rrggbb (`DualColor` of `color/dual.ts`, as strokes keep it).
public struct PaintDualColor: Equatable, Sendable {
    public var light: String
    public var dark: String

    public init(light: String, dark: String) {
        self.light = light
        self.dark = dark
    }

    public var json: JSONValue { ["light": .string(light), "dark": .string(dark)] }

    /// The colour for a scheme (`dual[scheme]`): `dark`, else the light side.
    public func side(_ scheme: String) -> String { scheme == "dark" ? dark : light }
}

func applyAffine(_ m: Affine, _ x: Double, _ y: Double) -> (x: Double, y: Double) {
    (m[0] * x + m[1] * y + m[4], m[2] * x + m[3] * y + m[5])
}

/// `a ∘ b` (b first).
func composeAffine(_ a: Affine, _ b: Affine) -> Affine {
    [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[0] * b[4] + a[1] * b[5] + a[4], a[2] * b[4] + a[3] * b[5] + a[5]]
}

func invertAffine(_ m: Affine) throws -> Affine {
    let det = m[0] * m[3] - m[1] * m[2]
    if abs(det) < 1e-12 { throw PaintEditorError("The transform is not invertible (scale 0?).") }
    let a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det
    return [a, b, c, d, -(a * m[4] + b * m[5]), -(c * m[4] + d * m[5])]
}

/// The pen sample mapped by `m` (tilt and twist are kept: they describe the pen, not the path).
func mapPenPoint(_ m: Affine, _ p: PenPoint) -> PenPoint {
    let q = applyAffine(m, p.x, p.y)
    var out = p
    out.x = q.x
    out.y = q.y
    return out
}

/// An affine copy as the engine's `StrokeCopy`.
func affineCopy(_ m: Affine) -> StrokeCopy {
    StrokeCopy(map: { mapPenPoint(m, $0) }, linear: [m[0], m[1], m[2], m[3]])
}

func loadJSON(_ l: MixerLoad) -> JSONValue {
    ["reservoir": l.reservoir.map { .array($0.map { .number($0) }) } ?? .null, "amount": .number(l.amount), "pickup": l.pickup.map { .array($0.map { .number($0) }) } ?? .null]
}

/// A recorded stroke as saved: plain JSON with its brush as a facet brush.
func strokeToJSON(_ s: RecordedStroke) -> JSONValue {
    var o: JSONObject = ["id": .string(s.id), "layerId": .string(s.layerId), "color": .string(s.color), "points": .array(s.points.map(\.json)), "seed": .number(Double(s.seed))]
    if let dual = s.dualColor { o["dualColor"] = dual.json }
    if let copies = s.copies { o["copies"] = .array(copies.map { .array($0.map { .number($0) }) }) }
    if let load = s.load { o["load"] = loadJSON(load) }
    if let steps = s.steps { o["steps"] = .array(steps.map { .number(Double($0)) }) }
    if let targets = s.targets { o["targets"] = .array(targets.map { .string($0) }) }
    if let stencils = s.stencils { o["stencils"] = .array(stencils.map { .object($0.json) }) }
    if let paint = s.paint { o["paint"] = paint.json }
    if let effect = s.effect { o["paint"] = effect.json }
    if let ids = s.scrapeLayerIds { o["scrapeLayerIds"] = .array(ids.map { .string($0) }) }
    o["brush"] = .object(migrateBrushV1(s.brush))
    return .object(o)
}

// MARK: - Reading

/// `readAffine`: six finite numbers, or nil.
private func readAffine(_ raw: JSONValue) -> Affine? {
    guard let a = raw.arrayValue, a.count == 6 else { return nil }
    let ns = a.compactMap(\.finite)
    return ns.count == 6 ? ns : nil
}

/// `readRgb`: three finite numbers clamped to 0..1, or nil.
private func readRgb(_ raw: JSONValue?) -> [Double]? {
    guard let a = raw?.arrayValue, a.count == 3 else { return nil }
    let ns = a.compactMap(\.finite)
    return ns.count == 3 ? ns.map { Swift.min(1, Swift.max(0, $0)) } : nil
}

/// `readLoad`: what the brush carried, or nil when it carried nothing.
private func readLoad(_ raw: JSONValue?) -> MixerLoad? {
    guard let r = raw?.objectValue else { return nil }
    let reservoir = readRgb(r["reservoir"])
    let pickup = readRgb(r["pickup"])
    if reservoir == nil && pickup == nil { return nil }
    let amount = reservoir != nil ? r["amount"]?.finite.map { Swift.min(1, Swift.max(0, $0)) } ?? 0 : 0
    return MixerLoad(reservoir: reservoir, amount: amount, pickup: pickup)
}

/// A saved stroke's brush: a facet brush (version 2), else the flat engine brush of version 1 (`readStrokeBrush`).
func readStrokeBrush(_ raw: JSONValue?) -> PaintBrush {
    if let o = raw?.objectValue, o.contains("kind"), !o.contains("engine") {
        var problems: [String] = []
        if let spec = try? normalizeBrushSpec(.object(o), &problems) { return resolveBrush(spec) }
        // Not a facet brush after all: read it as a flat one.
    }
    return normalizePaintBrush(raw?.objectValue ?? [:])
}

/**
 * `normalizeDualColor` for the colours strokes keep: `{ light, dark }`, `light-dark(a, b)` or one
 * colour for both, each side any CSS colour the TS core reads (hex, named, `rgb()`, `hsl()`,
 * `oklab()`, `oklch()`, `color()`) as lowercase hex. Sides with alpha below 1 keep it (`#rrggbbaa`).
 */
func normalizePaintDualColor(_ raw: JSONValue?) -> PaintDualColor? {
    guard let dual = normalizeCssDualColor(raw) else { return nil }
    return PaintDualColor(light: dual.light, dark: dual.dark)
}

private func isHex6(_ s: String) -> Bool { s.range(of: "^#[0-9a-f]{6}$", options: .regularExpression) != nil }

/// A recorded stroke read from JSON (its brush version 1 or 2), or nil when it is not one (`normalizeBrushStroke`).
func normalizeBrushStroke(_ raw: JSONValue) -> RecordedStroke? {
    guard let r = raw.objectValue, let id = r["id"]?.stringValue, let layerId = r["layerId"]?.stringValue, let rawPoints = r["points"]?.arrayValue else { return nil }
    let points = rawPoints.compactMap { PenPoint(json: $0) }
    if points.isEmpty { return nil }
    let colorRaw = r["color"]?.stringValue
    let color = colorRaw.flatMap { $0.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil ? $0.lowercased() : nil } ?? "#000000"
    var out = RecordedStroke(id: id, layerId: layerId, brush: readStrokeBrush(r["brush"]), color: color, points: points, seed: r["seed"]?.finite.map { Int(JS.i32($0)) } ?? 0)
    if let raw = r["dualColor"], let dual = normalizePaintDualColor(raw), isHex6(dual.light), isHex6(dual.dark) { out.dualColor = dual }
    let copies = (r["copies"]?.arrayValue ?? []).compactMap(readAffine)
    if !copies.isEmpty { out.copies = copies }
    if let load = readLoad(r["load"]) { out.load = load }
    if let list = r["stencils"]?.arrayValue {
        var st: [Stencil] = []
        for item in list {
            // An unreadable stencil is dropped.
            guard let o = item.objectValue, let s = try? normalizeStencil(o, o["id"]?.stringValue ?? "stencil") else { continue }
            st.append(s)
        }
        if !st.isEmpty { out.stencils = st }
    }
    if let effect = readPaintEffectPaint(r["paint"]) {
        out.effect = effect
    } else if case .gradient(let g)? = readPaintSource(r["paint"]) {
        out.paint = g
    }
    if let ids = r["scrapeLayerIds"]?.arrayValue {
        let strings = ids.compactMap(\.stringValue)
        if strings.count == ids.count { out.scrapeLayerIds = strings }
    }
    if let steps = r["steps"]?.arrayValue, steps.count == points.count {
        let ints = steps.compactMap { v -> Int? in
            guard let n = v.finite, n >= 0, n == n.rounded(.towardZero), n <= 9_007_199_254_740_991 else { return nil }
            return Int(n)
        }
        if ints.count == steps.count { out.steps = ints }
    }
    if let list = r["targets"]?.arrayValue {
        let targets = list.compactMap { $0.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
        if !targets.isEmpty { out.targets = targets }
    }
    return out
}

/// A recorded stroke as plain JSON with its engine brush (`JSON.parse(JSON.stringify(stroke))`), as paint events keep it.
func recordedStrokeJSON(_ s: RecordedStroke) -> JSONValue {
    var o = strokeToJSON(s).objectValue!
    o["brush"] = .object(s.brush.json(builtin: false))
    return .object(o)
}

/// The bounding box of points.
func strokeBounds(_ points: [PenPoint]) -> (x: Double, y: Double, width: Double, height: Double) {
    guard let first = points.first else { return (0, 0, 0, 0) }
    var x0 = first.x, y0 = first.y, x1 = first.x, y1 = first.y
    for p in points {
        x0 = Swift.min(x0, p.x)
        y0 = Swift.min(y0, p.y)
        x1 = Swift.max(x1, p.x)
        y1 = Swift.max(y1, p.y)
    }
    return (x0, y0, x1 - x0, y1 - y0)
}

/// A stroke moved by `m` (the brush scaled with it).
func varyStroke(_ stroke: RecordedStroke, _ m: Affine, pressureScale: Double = 1) -> RecordedStroke {
    // A pure rotation or flip has determinant 1 up to rounding: keep the brush size exact then.
    let detSigned = m[0] * m[3] - m[1] * m[2]
    let det = abs(detSigned).squareRoot()
    let s = abs(det - 1) < 1e-9 ? 1 : det
    var out = stroke
    out.key = newStrokeKey()
    out.points = stroke.points.map { p in
        var q = mapPenPoint(m, p)
        if pressureScale != 1 { q.pressure = Swift.min(1, Swift.max(0, (p.pressure ?? 1) * pressureScale)) }
        return q
    }
    let flipVortexDir = detSigned < 0 && (stroke.brush.engine == "vortex" || (stroke.brush.engine == "wet" && stroke.brush.wet.tool == "vortex"))
    if s != 1 || flipVortexDir {
        var raw = stroke.brush.json()
        if s != 1 {
            var tip = stroke.brush.tip.json.objectValue!
            tip["size"] = .number(stroke.brush.tip.size * s)
            raw["tip"] = .object(tip)
        }
        if flipVortexDir {
            let curV = brushVortex(stroke.brush)
            if curV.direction == "cw" || curV.direction == "ccw" {
                var v = curV
                v.direction = curV.direction == "cw" ? "ccw" : "cw"
                raw["vortex"] = v.json
            }
        }
        out.brush = normalizePaintBrush(raw)
        if s != 1, let paint = stroke.paint, paint.map.by == "distance", paint.map.unit != "dabs" {
            var p = paint
            p.map.length = Swift.min(100000, Swift.max(1, (paint.map.length ?? 300) * s))
            out.paint = p
        }
    }
    // A stroke-mapped effect keeps its pattern the same size relative to the stroke;
    // a path-mapped effect follows the moved points in canvas pixels.
    if var e = stroke.effect {
        if e.map?.by == "path" {
            out.effect = withStrokePath(e, out.points)
        } else if s != 1, var map = e.map, map.by == "stroke" {
            map.length = Int(Swift.min(4096, Swift.max(16, JS.round(Double(map.length) * s))))
            e.map = map
            out.effect = e
        }
    }
    if let copies = stroke.copies, !copies.isEmpty, let inv = try? invertAffine(m) {
        out.copies = copies.map { composeAffine(m, composeAffine($0, inv)) }
    }
    return out
}
