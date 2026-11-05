import Foundation
import PixerateCore
import PixerateRaster

// Variable-width stroke profiles (`vector/width.ts`): stroke widths at positions along a path
// (each subpath on its own), interpolated with a monotone cubic and held flat before the first
// and after the last point. Each point has a left and a right side scale (looking along the
// path on screen, y down). Profiles are stored in a node's `strokeWidthProfile` as
// `[{ t, left, right }]`; the generators (taper, wave, pressure) make points from parameters.

/// The most points a profile keeps.
public let VECTOR_WIDTH_PROFILE_MAX_POINTS = 64
/// The widest a side can be, as a multiple of the stroke width.
public let VECTOR_WIDTH_PROFILE_MAX_SCALE = 1000.0
/// Positions closer than this are the same place (the two sides of a discontinuous point).
public let VECTOR_WIDTH_SAME_T = 1e-6

/// One point of a width profile (`VectorWidthPoint`): position `t` (0–1 along the subpath) and
/// the side scales.
public struct VectorWidthPoint: Equatable, Sendable {
    public var t: Double
    public var left: Double
    public var right: Double
    public init(t: Double, left: Double, right: Double) {
        self.t = t
        self.left = left
        self.right = right
    }

    /// `{ t, left, right }`.
    public var json: JSONValue { .object(JSONObject([("t", .number(t)), ("left", .number(left)), ("right", .number(right))])) }

    subscript(side: Int) -> Double { side == 0 ? left : right }
}

/// A profile as JSON.
public func widthProfileJSON(_ points: [VectorWidthPoint]) -> JSONValue { .array(points.map(\.json)) }

private func sym(_ t: Double, _ s: Double) -> VectorWidthPoint { VectorWidthPoint(t: t, left: s, right: s) }

/// The built-in profiles in menu order (`VECTOR_WIDTH_PRESETS`): id, label and points. `uniform` is the plain stroke.
public let VECTOR_WIDTH_PRESETS: [(id: String, label: String, points: [VectorWidthPoint])] = [
    ("uniform", "Uniform", []),
    ("taperStart", "Taper start", [sym(0, 0), sym(1, 1)]),
    ("taperEnd", "Taper end", [sym(0, 1), sym(1, 0)]),
    ("taperBoth", "Taper both", [sym(0, 0), sym(0.5, 1), sym(1, 0)]),
    // Full width at the ends, swelling to twice the width in the middle.
    ("bulge", "Bulge", [sym(0, 1), sym(0.5, 2), sym(1, 1)]),
    // Full width at the ends, pinched to a quarter in the middle.
    ("pinch", "Pinch", [sym(0, 1), sym(0.5, 0.25), sym(1, 1)]),
    // A round head a fifth of the way along, then a long taper to the end.
    ("teardrop", "Teardrop", [sym(0, 0), sym(0.2, 1), sym(1, 0)]),
    // Two swells between narrow necks.
    ("wave", "Wave", [sym(0, 0.3), sym(0.25, 1), sym(0.5, 0.3), sym(0.75, 1), sym(1, 0.3)]),
    // A pen stroke: a quick press, a slow lift.
    ("pressure", "Pressure", [sym(0, 0.15), sym(0.12, 0.85), sym(0.45, 1), sym(0.8, 0.7), sym(1, 0.05)]),
]

public let VECTOR_WIDTH_PRESET_IDS: [String] = VECTOR_WIDTH_PRESETS.map(\.id)

/// `clean`: a finite number clamped to 0…max, else nil.
private func clean(_ v: Double?, _ max: Double) -> Double? {
    guard let v, v.isFinite else { return nil }
    return JS.min(JS.max(v, 0), max)
}

/// A profile as the outline uses it (`sanitizeWidthProfile`): finite points only, `t` in 0–1, side
/// scales in 0–1000, sorted by `t` (stable, so a step keeps its order), at most 64 points. Points
/// missing a side take the other side's scale. Anything but an array is no profile.
public func sanitizeWidthProfile(_ value: JSONValue?) -> [VectorWidthPoint] {
    guard let list = value?.arrayValue else { return [] }
    var out: [VectorWidthPoint] = []
    for p in list {
        guard let o = p.objectValue else { continue }
        let t = clean(o["t"]?.numberValue, 1)
        let l = clean(o["left"]?.numberValue, VECTOR_WIDTH_PROFILE_MAX_SCALE)
        let r = clean(o["right"]?.numberValue, VECTOR_WIDTH_PROFILE_MAX_SCALE)
        guard let t, l != nil || r != nil else { continue }
        out.append(VectorWidthPoint(t: t, left: l ?? r!, right: r ?? l!))
        if out.count >= VECTOR_WIDTH_PROFILE_MAX_POINTS { break }
    }
    return sortedByT(out)
}

/// `sanitizeWidthProfile` of points already typed.
public func sanitizeWidthProfile(_ points: [VectorWidthPoint]) -> [VectorWidthPoint] {
    sanitizeWidthProfile(widthProfileJSON(points))
}

private func sortedByT(_ points: [VectorWidthPoint]) -> [VectorWidthPoint] {
    jsSortedIndexed(points) { a, b in a.t - b.t }
}

/// A stable sort by `compare`, ties kept in order (`[p, i]` pairs sorted by `t` then index in TS).
private func jsSortedIndexed<T>(_ items: [T], _ compare: (T, T) -> Double) -> [T] {
    items.enumerated().sorted { x, y in
        let c = compare(x.element, y.element)
        return c < 0 || (!(c > 0) && x.offset < y.offset)
    }.map(\.element)
}

/// True when the profile draws a plain stroke: no points, or every side at scale 1.
public func isUniformWidthProfile(_ points: [VectorWidthPoint]?) -> Bool {
    guard let points, !points.isEmpty else { return true }
    return points.allSatisfy { $0.left == 1 && $0.right == 1 }
}

/// Slope of side `k` from point `i` to `i + 1` (0 when they share a position).
private func secant(_ pts: [VectorWidthPoint], _ i: Int, _ k: Int) -> Double {
    guard pts.indices.contains(i), pts.indices.contains(i + 1) else { return 0 }
    let a = pts[i], b = pts[i + 1]
    return b.t - a.t > 1e-12 ? (b[k] - a[k]) / (b.t - a.t) : 0
}

/// Fritsch–Carlson tangent: one-sided at the ends, the harmonic mean of the slopes inside, flat at local extremes.
private func tangent(_ pts: [VectorWidthPoint], _ i: Int, _ k: Int) -> Double {
    let last = pts.count - 1
    if i <= 0 { return secant(pts, 0, k) }
    if i >= last { return secant(pts, last - 1, k) }
    let d0 = secant(pts, i - 1, k)
    let d1 = secant(pts, i, k)
    return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1)
}

private func interp(_ pts: [VectorWidthPoint], _ t: Double, _ k: Int) -> Double {
    let first = pts[0]
    let last = pts[pts.count - 1]
    if !(t > first.t) { return first[k] }
    if t >= last.t { return last[k] }
    // The last point at or before t (the second of a step at exactly t).
    var i = 0
    while i + 1 < pts.count && pts[i + 1].t <= t { i += 1 }
    let a = pts[i]
    let b = pts[i + 1]
    let h = b.t - a.t
    if h <= 1e-12 { return b[k] }
    let u = (t - a.t) / h
    let u2 = u * u
    let u3 = u2 * u
    let w0 = (2 * u3 - 3 * u2 + 1) * a[k]
    let w1 = (u3 - 2 * u2 + u) * h * tangent(pts, i, k)
    let w2 = (3 * u2 - 2 * u3) * b[k]
    let w3 = (u3 - u2) * h * tangent(pts, i + 1, k)
    return JS.max(0, w0 + w1 + w2 + w3)
}

/// The left and right side scales at `t` (0–1 along the subpath by length), each side
/// interpolated on its own with a monotone cubic; a profile without points is uniform (1, 1).
public func widthProfileAt(_ points: [VectorWidthPoint]?, _ t: Double) -> (left: Double, right: Double) {
    guard let points, !points.isEmpty else { return (1, 1) }
    return (interp(points, t, 0), interp(points, t, 1))
}

/// The largest side scale (the interpolation never exceeds its points); 1 without a profile.
public func widthProfileMaxScale(_ points: [VectorWidthPoint]?) -> Double {
    guard let points, !points.isEmpty else { return 1 }
    return points.reduce(0) { JS.max(JS.max($0, $1.left), $1.right) }
}

/// The points of a preset (empty for `uniform`), or nil for an unknown id.
public func widthProfilePreset(_ id: String) -> [VectorWidthPoint]? {
    VECTOR_WIDTH_PRESETS.first { $0.id == id }?.points
}

/// The preset a profile matches: `uniform` without one (or all at scale 1), `custom` when none matches.
public func widthProfilePresetId(_ points: [VectorWidthPoint]?) -> String {
    if isUniformWidthProfile(points) { return "uniform" }
    let pts = points!
    func same(_ a: [VectorWidthPoint], _ b: [VectorWidthPoint]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { p, q in abs(p.t - q.t) < 1e-9 && abs(p.left - q.left) < 1e-9 && abs(p.right - q.right) < 1e-9 }
    }
    return VECTOR_WIDTH_PRESETS.first { !$0.points.isEmpty && same(pts, $0.points) }?.id ?? "custom"
}

/// The profile of the reversed path: positions mirrored and the sides swapped.
public func reverseWidthProfile(_ points: [VectorWidthPoint]) -> [VectorWidthPoint] {
    points.map { VectorWidthPoint(t: 1 - $0.t, left: $0.right, right: $0.left) }.reversed()
}

/// The profile of a mirrored path (it runs the same way, but its sides swap).
public func mirrorWidthProfile(_ points: [VectorWidthPoint]) -> [VectorWidthPoint] {
    points.map { VectorWidthPoint(t: $0.t, left: $0.right, right: $0.left) }
}

/// The points a profile edit starts from: the profile, or a uniform one with a point at each end.
private func editable(_ points: [VectorWidthPoint]?) -> [VectorWidthPoint] {
    if let points, !points.isEmpty { return points }
    return [sym(0, 1), sym(1, 1)]
}

/// Adds a width point at `t` (side scales `left` / `right`, default: as wide as the stroke is
/// there) and returns the new profile and the point's index. Inserting at the position of an
/// existing point replaces it, unless `step` is set (which makes a discontinuous point).
public func insertWidthPoint(_ points: [VectorWidthPoint]?, _ t: Double, left: Double? = nil, right: Double? = nil, step: Bool = false) -> (points: [VectorWidthPoint], index: Int) {
    var pts = editable(points)
    let tt = JS.min(JS.max(t.isFinite ? t : 0, 0), 1)
    let here = widthProfileAt(points?.isEmpty == false ? points : nil, tt)
    let p = VectorWidthPoint(t: tt, left: clean(left, VECTOR_WIDTH_PROFILE_MAX_SCALE) ?? here.left, right: clean(right, VECTOR_WIDTH_PROFILE_MAX_SCALE) ?? here.right)
    if let same = pts.firstIndex(where: { abs($0.t - tt) <= VECTOR_WIDTH_SAME_T }), !step {
        pts[same] = VectorWidthPoint(t: pts[same].t, left: p.left, right: p.right)
        return (pts, same)
    }
    var i = 0
    while i < pts.count && pts[i].t <= tt { i += 1 }
    if pts.count >= VECTOR_WIDTH_PROFILE_MAX_POINTS { return (pts, Swift.max(0, i - 1)) }
    pts.insert(p, at: i)
    return (pts, i)
}

/// Changes point `index`: moves it to `t` (kept between its neighbours, so indices stay put)
/// and / or sets its side scales. Out-of-range indices leave the profile as it is.
public func setWidthPoint(_ points: [VectorWidthPoint], _ index: Int, t: Double? = nil, left: Double? = nil, right: Double? = nil) -> [VectorWidthPoint] {
    var pts = points
    guard pts.indices.contains(index) else { return pts }
    if let t, t.isFinite {
        let lo = index > 0 ? pts[index - 1].t : 0
        let hi = index < pts.count - 1 ? pts[index + 1].t : 1
        pts[index].t = JS.min(JS.max(t, lo), JS.max(hi, lo))
    }
    if let l = clean(left, VECTOR_WIDTH_PROFILE_MAX_SCALE) { pts[index].left = l }
    if let r = clean(right, VECTOR_WIDTH_PROFILE_MAX_SCALE) { pts[index].right = r }
    return pts
}

/// Removes the points at `indices`.
public func removeWidthPoints(_ points: [VectorWidthPoint], _ indices: [Int]) -> [VectorWidthPoint] {
    let drop = Set(indices)
    return points.enumerated().filter { !drop.contains($0.offset) }.map(\.element)
}

// MARK: - Generators

/// effectcraft's ease from the tip (`u = 0`) to full width (`u = 1`): linear at 0, a quarter circle at 1.
private func ease(_ u: Double, _ e: Double) -> Double {
    let x = JS.min(JS.max(u, 0), 1)
    let round = JS.sqrt(JS.max(0, 1 - (1 - x) * (1 - x)))
    return x + (round - x) * JS.min(JS.max(e, 0), 1)
}

/// A parametric taper (effectcraft's Stroke Taper), lengths as fractions of the path (`VectorTaperOptions`).
public struct VectorTaperOptions: Sendable {
    public var startLength: Double?
    public var endLength: Double?
    public var startWidth: Double?
    public var endWidth: Double?
    public var startEase: Double?
    public var endEase: Double?
    public init(startLength: Double? = nil, endLength: Double? = nil, startWidth: Double? = nil, endWidth: Double? = nil, startEase: Double? = nil, endEase: Double? = nil) {
        self.startLength = startLength
        self.endLength = endLength
        self.startWidth = startWidth
        self.endWidth = endWidth
        self.startEase = startEase
        self.endEase = endEase
    }

    /// From `{ startLength, … }` (non-numbers ignored).
    public init(json: JSONObject) {
        self.init(startLength: json["startLength"]?.numberValue, endLength: json["endLength"]?.numberValue, startWidth: json["startWidth"]?.numberValue, endWidth: json["endWidth"]?.numberValue, startEase: json["startEase"]?.numberValue, endEase: json["endEase"]?.numberValue)
    }
}

/// A width wave (effectcraft's Stroke Wave): the width swings between `1 − amount` and 1 (`VectorWaveOptions`).
public struct VectorWaveOptions: Sendable {
    public var amount: Double?
    public var cycles: Double?
    public var phase: Double?
    public init(amount: Double? = nil, cycles: Double? = nil, phase: Double? = nil) {
        self.amount = amount
        self.cycles = cycles
        self.phase = phase
    }

    public init(json: JSONObject) {
        self.init(amount: json["amount"]?.numberValue, cycles: json["cycles"]?.numberValue, phase: json["phase"]?.numberValue)
    }
}

/// The width factor at fraction `t` of a taper and / or a wave (effectcraft `width_factor`).
public func taperWaveFactor(_ t: Double, _ taper: VectorTaperOptions?, _ wave: VectorWaveOptions?) -> Double {
    var k = 1.0
    if let taper {
        var ls = JS.max(0, taper.startLength ?? 0)
        var le = JS.max(0, taper.endLength ?? 0)
        // Overlapping tapers share the path in proportion.
        if ls + le > 1 {
            let f = 1 / (ls + le)
            ls *= f
            le *= f
        }
        let sw = JS.min(JS.max(taper.startWidth ?? 0, 0), 1)
        let ew = JS.min(JS.max(taper.endWidth ?? 0, 0), 1)
        if ls > 0 && t < ls { k = JS.min(k, sw + (1 - sw) * ease(t / ls, taper.startEase ?? 0)) }
        if le > 0 && t > 1 - le { k = JS.min(k, ew + (1 - ew) * ease((1 - t) / le, taper.endEase ?? 0)) }
    }
    if let wave {
        let cycles = wave.cycles ?? 4
        let amount = JS.min(JS.max(wave.amount ?? 0.5, 0), 1)
        if cycles > 0 && amount > 0 {
            let ph = 2 * Double.pi * t * cycles + ((wave.phase ?? 0) * Double.pi) / 180
            k *= 1 - amount * (0.5 - 0.5 * JS.cos(ph))
        }
    }
    return k
}

/// Samples a taper and / or wave into profile points (symmetric), simplified to within
/// `tolerance` of the factor (default 0.01).
public func generateWidthProfile(taper: VectorTaperOptions? = nil, wave: VectorWaveOptions? = nil, samples: Int? = nil, tolerance: Double? = nil) -> [VectorWidthPoint] {
    let cycles = wave.map { JS.max(0, $0.cycles ?? 4) } ?? 0
    let n = Swift.max(8, Swift.min(VECTOR_WIDTH_PROFILE_MAX_POINTS * 4, samples ?? Int(JS.ceil(32 + cycles * 16))))
    var raw: [(Double, Double)] = []
    for i in 0...n { raw.append((Double(i) / Double(n), taperWaveFactor(Double(i) / Double(n), taper, wave))) }
    // Keep the taper ends exactly.
    let ts: [Double?] = [taper?.startLength, taper?.endLength.map { 1 - $0 }]
    for t in ts { if let t, t > 0 && t < 1 { raw.append((t, taperWaveFactor(t, taper, wave))) } }
    raw = jsSortedIndexed(raw) { a, b in a.0 - b.0 }
    return simplifySamples(raw, tolerance ?? 0.01, VECTOR_WIDTH_PROFILE_MAX_POINTS).map { sym($0.0, $0.1) }
}

/// Douglas–Peucker on (t, value) samples (vertical distance), then thinned to at most `max`.
private func simplifySamples(_ samples: [(Double, Double)], _ tolerance: Double, _ max: Int) -> [(Double, Double)] {
    if samples.count <= 2 { return samples }
    var keep = [Bool](repeating: false, count: samples.count)
    keep[0] = true
    keep[samples.count - 1] = true
    var stack: [(Int, Int)] = [(0, samples.count - 1)]
    while let range = stack.popLast() {
        let (a, b) = range
        let (ta, va) = samples[a]
        let (tb, vb) = samples[b]
        var worst = -1
        var err = tolerance
        if a + 1 < b {
            for i in (a + 1)..<b {
                let (t, v) = samples[i]
                let lin = tb - ta > 1e-12 ? va + ((vb - va) * (t - ta)) / (tb - ta) : va
                let e = abs(v - lin)
                if e > err {
                    err = e
                    worst = i
                }
            }
        }
        if worst >= 0 {
            keep[worst] = true
            stack.append((a, worst))
            stack.append((worst, b))
        }
    }
    var out = samples.enumerated().filter { keep[$0.offset] }.map(\.element)
    while out.count > max {
        let count = out.count
        out = out.enumerated().filter { $0.offset == 0 || $0.offset == count - 1 || $0.offset % 2 == 0 }.map(\.element)
    }
    return out
}

/// Pen pressure that draws the stroke's own width (a mouse reports 0.5 while a button is down).
public let VECTOR_PRESSURE_NOMINAL = 0.5

/// A profile from pen pressure recorded along a stroke: `(t, pressure 0–1)` samples in order. The
/// width scale is pressure ÷ 0.5, at least 0.05; the samples are simplified to within `tolerance`
/// (default 0.02). Empty (uniform) when every sample is the same.
public func pressureWidthProfile(_ samples: [(t: Double, pressure: Double)], tolerance: Double? = nil) -> [VectorWidthPoint] {
    let raw: [(Double, Double)] = samples.filter { $0.t.isFinite && $0.pressure.isFinite }.map {
        (JS.min(JS.max($0.t, 0), 1), JS.max(0.05, JS.min(1, JS.max(0, $0.pressure)) / VECTOR_PRESSURE_NOMINAL))
    }
    if raw.count < 2 { return [] }
    if raw.allSatisfy({ abs($0.1 - raw[0].1) < 1e-6 }) { return [] }
    return simplifySamples(raw, tolerance ?? 0.02, VECTOR_WIDTH_PROFILE_MAX_POINTS).map { sym($0.0, JS.round($0.1 * 1000) / 1000) }
}
