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
    if let copies = s.copies { o["copies"] = .array(copies.map { .array($0.map { .number($0) }) }) }
    if let load = s.load { o["load"] = loadJSON(load) }
    if let steps = s.steps { o["steps"] = .array(steps.map { .number(Double($0)) }) }
    if let stencils = s.stencils { o["stencils"] = .array(stencils.map { .object($0.json) }) }
    if let paint = s.paint { o["paint"] = paint.json }
    if let effect = s.effect { o["paint"] = effect.json }
    o["brush"] = .object(migrateBrushV1(s.brush))
    return .object(o)
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
    let det = abs(m[0] * m[3] - m[1] * m[2]).squareRoot()
    let s = abs(det - 1) < 1e-9 ? 1 : det
    var out = stroke
    out.key = newStrokeKey()
    out.points = stroke.points.map { p in
        var q = mapPenPoint(m, p)
        if pressureScale != 1 { q.pressure = Swift.min(1, Swift.max(0, (p.pressure ?? 1) * pressureScale)) }
        return q
    }
    if s != 1 {
        var tip = stroke.brush.tip.json.objectValue!
        tip["size"] = .number(stroke.brush.tip.size * s)
        var raw = stroke.brush.json()
        raw["tip"] = .object(tip)
        out.brush = normalizePaintBrush(raw)
        if let paint = stroke.paint, paint.map.by == "distance", paint.map.unit != "dabs" {
            var p = paint
            p.map.length = Swift.min(100000, Swift.max(1, (paint.map.length ?? 300) * s))
            out.paint = p
        }
    }
    // A stroke-mapped effect keeps its pattern the same size relative to the stroke.
    if s != 1, var e = stroke.effect, var map = e.map {
        map.length = Int(Swift.min(4096, Swift.max(16, JS.round(Double(map.length) * s))))
        e.map = map
        out.effect = e
    }
    if let copies = stroke.copies, !copies.isEmpty, let inv = try? invertAffine(m) {
        out.copies = copies.map { composeAffine(m, composeAffine($0, inv)) }
    }
    return out
}
