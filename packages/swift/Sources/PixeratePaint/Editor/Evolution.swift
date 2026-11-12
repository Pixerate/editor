import Foundation
import PixerateCore
import PixerateRaster

/**
 * Evolutionary strokes (`paint-editor/evolution.ts` and `paint-editor/evolution-tools.ts`):
 * breed and mutate stroke variants (`RecordedStroke` genomes) as pending paint proposals.
 */

public struct ResolvedMutationRates: Equatable, Sendable {
    public var geometry: Double = 0.35
    public var color: Double = 0.35
    public var brush: Double = 0.35
    public var seed: Double = 0.5

    public init(geometry: Double = 0.35, color: Double = 0.35, brush: Double = 0.35, seed: Double = 0.5) {
        self.geometry = geometry
        self.color = color
        self.brush = brush
        self.seed = seed
    }
}

public let DEFAULT_MUTATION_RATES = ResolvedMutationRates()

/// Why a stroke with `brush` can't be bred, or nil: the brushes a stroke layer refuses
/// (`liveStrokeRefusal`), and erasers, because a bred stroke is suggested as paint on a layer of
/// its own, where an eraser has nothing to erase.
public func evolutionStrokeRefusal(_ brush: PaintBrush) -> String? {
    if brush.engine == "eraser" { return "The \(brush.name) brush erases, and a bred stroke is suggested on a layer of its own where there is nothing to erase; breed painted strokes instead." }
    return liveStrokeRefusal(brush)
}

public func normalizeMutationRates(_ raw: JSONObject?) throws -> ResolvedMutationRates {
    var out = DEFAULT_MUTATION_RATES
    guard let raw else { return out }
    for key in ["geometry", "color", "brush", "seed"] {
        guard let v = raw[key], v != .null else { continue }
        guard let n = v.finite, n >= 0 && n <= 1 else {
            throw PaintEditorError("mutation.\(key) \(v.stringified()) is out of range; use 0..1.")
        }
        switch key {
        case "geometry": out.geometry = n
        case "color": out.color = n
        case "brush": out.brush = n
        case "seed": out.seed = n
        default: break
        }
    }
    return out
}

private func roundScale(_ v: Double, _ scale: Double) -> Double {
    let r = JS.round(v * scale) / scale
    return r == 0 ? 0 : r
}

private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
    v < lo ? lo : v > hi ? hi : v
}

public struct EvolutionBrushFacet: Sendable {
    public let facet: String
    public let engine: String
    public let engines: [String]
    public let min: Double
    public let max: Double
    public let span: Double
    public let scale: Double
    public let relative: Bool
    public let shapes: [String]?
    public let marks: [String]?

    public init(
        facet: String,
        engine: String,
        engines: [String],
        min: Double,
        max: Double,
        span: Double,
        scale: Double,
        relative: Bool = false,
        shapes: [String]? = nil,
        marks: [String]? = nil
    ) {
        self.facet = facet
        self.engine = engine
        self.engines = engines
        self.min = min
        self.max = max
        self.span = span
        self.scale = scale
        self.relative = relative
        self.shapes = shapes
        self.marks = marks
    }
}

private let LIVE_ENGINES = ["dab", "mixer", "particle", "bristle"]

public let EVOLUTION_BRUSH_FACETS: [EvolutionBrushFacet] = [
    EvolutionBrushFacet(facet: "tip.size", engine: "tip.size", engines: LIVE_ENGINES, min: 1, max: 512, span: 0.35, scale: 10, relative: true),
    EvolutionBrushFacet(facet: "tip.hardness", engine: "tip.hardness", engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100),
    EvolutionBrushFacet(facet: "tip.spacing", engine: "tip.spacing", engines: LIVE_ENGINES, min: 0.02, max: 2, span: 0.3, scale: 100, relative: true),
    EvolutionBrushFacet(facet: "tip.roundness", engine: "tip.roundness", engines: LIVE_ENGINES, min: 0.05, max: 1, span: 0.25, scale: 100),
    EvolutionBrushFacet(facet: "tip.opacity", engine: "tip.opacity", engines: LIVE_ENGINES, min: 0.1, max: 1, span: 0.2, scale: 100),
    EvolutionBrushFacet(facet: "tip.flow", engine: "tip.flow", engines: LIVE_ENGINES, min: 0.1, max: 1, span: 0.2, scale: 100),
    EvolutionBrushFacet(facet: "dynamics.sizeJitter", engine: "dynamics.sizeJitter", engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100),
    EvolutionBrushFacet(facet: "dynamics.angleJitter", engine: "dynamics.angleJitter", engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100),
    EvolutionBrushFacet(facet: "dynamics.opacityJitter", engine: "dynamics.opacityJitter", engines: LIVE_ENGINES, min: 0, max: 1, span: 0.2, scale: 100),
    EvolutionBrushFacet(facet: "dynamics.scatter", engine: "dynamics.scatter", engines: LIVE_ENGINES, min: 0, max: 2, span: 0.3, scale: 100),
    EvolutionBrushFacet(facet: "behaviour.grain", engine: "grain", engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100),
    EvolutionBrushFacet(facet: "tip.bristle.count", engine: "bristle.count", engines: ["bristle"], min: 3, max: 128, span: 16, scale: 1, shapes: ["bristle"]),
    EvolutionBrushFacet(facet: "tip.bristle.stiffness", engine: "bristle.stiffness", engines: ["bristle"], min: 0, max: 1, span: 0.25, scale: 100, shapes: ["bristle"]),
    EvolutionBrushFacet(facet: "tip.bristle.splay", engine: "bristle.splay", engines: ["bristle"], min: 0, max: 1, span: 0.25, scale: 100, shapes: ["bristle"]),
    EvolutionBrushFacet(facet: "tip.bristle.load", engine: "bristle.load", engines: ["bristle"], min: 0.1, max: 1, span: 0.25, scale: 100, shapes: ["bristle"]),
    EvolutionBrushFacet(facet: "tip.bristle.jitter", engine: "bristle.jitter", engines: ["bristle"], min: 0, max: 1, span: 0.25, scale: 100, shapes: ["bristle"]),
    EvolutionBrushFacet(facet: "marks.count", engine: "particle.count", engines: ["particle"], min: 1, max: 64, span: 8, scale: 1, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.size", engine: "particle.size", engines: ["particle"], min: 0.01, max: 1, span: 0.2, scale: 100, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.spread", engine: "particle.spread", engines: ["particle"], min: 0, max: 1, span: 0.25, scale: 100, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.stiffness", engine: "particle.stiffness", engines: ["particle"], min: 0, max: 1, span: 0.25, scale: 100, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.damping", engine: "particle.damping", engines: ["particle"], min: 0, max: 1, span: 0.25, scale: 100, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.speed", engine: "particle.speed", engines: ["particle"], min: 0, max: 1, span: 0.25, scale: 100, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.waveAmplitude", engine: "particle.waveAmplitude", engines: ["particle"], min: 0, max: 1, span: 0.25, scale: 100, marks: ["particles"]),
    EvolutionBrushFacet(facet: "marks.density", engine: "spray.density", engines: ["dab"], min: 0.05, max: 1, span: 0.25, scale: 100, marks: ["scatter"]),
    EvolutionBrushFacet(facet: "marks.size", engine: "spray.size", engines: ["dab"], min: 0.02, max: 1, span: 0.2, scale: 100, marks: ["scatter"]),
    EvolutionBrushFacet(facet: "behaviour.exchange.mix", engine: "mixer.mix", engines: ["mixer"], min: 0, max: 1, span: 0.25, scale: 100),
    EvolutionBrushFacet(facet: "behaviour.exchange.reservoir.load", engine: "mixer.load", engines: ["mixer"], min: 0.05, max: 1, span: 0.25, scale: 100),
]

private func getEngineNumber(_ brushJSON: JSONValue, _ path: String) -> Double {
    getPath(brushJSON, path)?.numberValue ?? 0
}

/// Seeded, smoothed point jitter along a stroke path.
public func jitterStrokePoints(_ points: [PenPoint], _ amount: Double, _ seed: Int) -> [PenPoint] {
    let n = points.count
    if !(amount > 0) || n == 0 { return points }
    let bounds = strokeBounds(points)
    let span = JS.max(12, JS.hypot(bounds.width, bounds.height))
    let amp = amount * JS.min(48, JS.max(3, span * 0.12))
    let p1x = PixerateRandom.rand01(seed, 0, 101) * Double.pi * 2
    let p1y = PixerateRandom.rand01(seed, 1, 101) * Double.pi * 2
    let p2x = PixerateRandom.rand01(seed, 2, 101) * Double.pi * 2
    let p2y = PixerateRandom.rand01(seed, 3, 101) * Double.pi * 2
    func smoothNoise(_ i: Int, _ stream: Int) -> Double {
        let prev = Swift.max(0, i - 1)
        let next = Swift.min(n - 1, i + 1)
        return (PixerateRandom.randSigned(seed, prev, stream) + 2 * PixerateRandom.randSigned(seed, i, stream) + PixerateRandom.randSigned(seed, next, stream)) * 0.25
    }
    return points.enumerated().map { i, p in
        let u = n > 1 ? Double(i) / Double(n - 1) : 0
        let dx = amp * (0.55 * JS.sin(u * Double.pi * 2 + p1x) + 0.25 * JS.sin(u * Double.pi * 4 + p2x) + 0.2 * smoothNoise(i, 102))
        let dy = amp * (0.55 * JS.cos(u * Double.pi * 2 + p1y) + 0.25 * JS.cos(u * Double.pi * 4 + p2y) + 0.2 * smoothNoise(i, 103))
        let dp = amount * 0.18 * (0.6 * JS.sin(u * Double.pi * 2 + p1x) + 0.4 * smoothNoise(i, 104))
        let pressure = roundScale(clamp((p.pressure ?? 0.7) + dp, 0.05, 1), 1000)
        var out = p
        out.x = roundScale(p.x + dx, 100)
        out.y = roundScale(p.y + dy, 100)
        out.pressure = pressure
        return out
    }
}

/// Whole-stroke `ReplayOptions` variation derived from a seed and geometry mutation rate (`0..1`).
public func seededStrokeVariation(_ amount: Double, _ seed: Int, _ index: Int = 0) -> ReplayOptions {
    if !(amount > 0) {
        return ReplayOptions(strokeIds: [], dx: 0, dy: 0, scale: 1, rotate: 0, pressureScale: 1)
    }
    let base = index * 8
    return ReplayOptions(
        strokeIds: [],
        dx: roundScale(PixerateRandom.randSigned(seed, base + 0, 110) * amount * 18, 100),
        dy: roundScale(PixerateRandom.randSigned(seed, base + 1, 110) * amount * 18, 100),
        scale: roundScale(1 + PixerateRandom.randSigned(seed, base + 2, 110) * amount * 0.22, 1000),
        rotate: roundScale(PixerateRandom.randSigned(seed, base + 3, 110) * amount * 24, 100),
        pressureScale: roundScale(1 + PixerateRandom.randSigned(seed, base + 4, 110) * amount * 0.2, 1000)
    )
}

// MARK: - OKLab / OKLCH (`color/convert.ts`)

private func srgbToLinear(_ c: Double) -> Double {
    c <= 0.04045 ? c / 12.92 : JS.pow((c + 0.055) / 1.055, 2.4)
}

private func linearToSrgb(_ c: Double) -> Double {
    c <= 0.0031308 ? 12.92 * c : 1.055 * JS.pow(c, 1.0 / 2.4) - 0.055
}

private func rgbToOklab(_ rIn: Double, _ gIn: Double, _ bIn: Double) -> (l: Double, a: Double, b: Double) {
    let r = srgbToLinear(rIn)
    let g = srgbToLinear(gIn)
    let b = srgbToLinear(bIn)
    let l = JS.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = JS.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = JS.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return (
        l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    )
}

private func oklabToRgb(_ labL: Double, _ labA: Double, _ labB: Double) -> (r: Double, g: Double, b: Double) {
    let l_ = labL + 0.3963377774 * labA + 0.2158037573 * labB
    let m_ = labL - 0.1055613458 * labA - 0.0638541728 * labB
    let s_ = labL - 0.0894841775 * labA - 1.291485548 * labB
    let l = l_ * l_ * l_
    let m = m_ * m_ * m_
    let s = s_ * s_ * s_
    let r = linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
    let g = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
    let b = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    return (r, g, b)
}

private func oklabToOklch(_ lab: (l: Double, a: Double, b: Double)) -> (l: Double, c: Double, h: Double) {
    let c = JS.hypot(lab.a, lab.b)
    var h = (JS.atan2(lab.b, lab.a) * 180) / Double.pi
    if h < 0 { h += 360 }
    return (l: lab.l, c: c, h: c < 1e-4 ? 0 : h)
}

private func oklchToOklab(_ l: Double, _ c: Double, _ h: Double) -> (l: Double, a: Double, b: Double) {
    let rad = (h * Double.pi) / 180
    return (l: l, a: c * JS.cos(rad), b: c * JS.sin(rad))
}

private func oklchToHexGamut(_ l: Double, _ c: Double, _ h: Double) -> String {
    func at(_ ch: Double) -> (r: Double, g: Double, b: Double) {
        let lab = oklchToOklab(l, ch, h)
        return oklabToRgb(lab.l, lab.a, lab.b)
    }
    func inGamut(_ o: (r: Double, g: Double, b: Double)) -> Bool {
        [o.r, o.g, o.b].allSatisfy { $0 >= -1e-4 && $0 <= 1 + 1e-4 }
    }
    var out = at(c)
    if !inGamut(out) {
        var lo = 0.0
        var hi = c
        for _ in 0..<12 {
            let mid = (lo + hi) / 2
            if inGamut(at(mid)) { lo = mid } else { hi = mid }
        }
        out = at(lo)
    }
    return "#" + [out.r, out.g, out.b].map { String(Int(JS.round(clamp($0, 0, 1) * 255)), radix: 16).leftPad(2) }.joined()
}

/// Drifts a `#rrggbb` colour in OKLCH lightness, chroma and hue.
public func driftColorOklch(_ hex: String, _ amount: Double, _ seed: Int, _ index: Int = 0) -> String {
    let rgb = hexToRgb8(hex)
    let norm = "#" + rgb.map { String($0, radix: 16).leftPad(2) }.joined()
    if !(amount > 0) { return norm }
    let lch = oklabToOklch(rgbToOklab(Double(rgb[0]) / 255, Double(rgb[1]) / 255, Double(rgb[2]) / 255))
    let l = clamp(lch.l + PixerateRandom.randSigned(seed, index, 201) * amount * 0.22, 0.02, 0.98)
    let c = clamp(lch.c + PixerateRandom.randSigned(seed, index, 202) * amount * 0.1, 0, 0.37)
    let h = lch.h + PixerateRandom.randSigned(seed, index, 203) * amount * 90
    return oklchToHexGamut(l, c, h)
}

/// Mixes two `#rrggbb` colours perceptually in OKLab/OKLCH at weight `t` (`0..1`).
public func mixColorOklch(_ hexA: String, _ hexB: String, _ t: Double) -> String {
    let ra = hexToRgb8(hexA)
    let rb = hexToRgb8(hexB)
    let u = clamp(t, 0, 1)
    let labA = rgbToOklab(Double(ra[0]) / 255, Double(ra[1]) / 255, Double(ra[2]) / 255)
    let labB = rgbToOklab(Double(rb[0]) / 255, Double(rb[1]) / 255, Double(rb[2]) / 255)
    let lch = oklabToOklch((
        l: labA.l + (labB.l - labA.l) * u,
        a: labA.a + (labB.a - labA.a) * u,
        b: labA.b + (labB.b - labA.b) * u
    ))
    return oklchToHexGamut(clamp(lch.l, 0, 1), JS.max(0, lch.c), lch.h)
}

/// Drifts a brush's numeric facets within their schema ranges (`EVOLUTION_BRUSH_FACETS`).
public func driftBrushFacets(_ brush: PaintBrush, _ amount: Double, _ seed: Int, _ index: Int = 0) -> PaintBrush {
    if !(amount > 0) { return brush }
    var facetSpec = migrateBrushV1(brush)
    let base = resolveBrush(facetSpec)
    let baseJSON = JSONValue.object(base.json())
    let shape = facetSpec.path("tip.shape")?.stringValue ?? "round"
    let marksKind = facetSpec.path("marks.kind")?.stringValue ?? "continuous"
    for (fi, f) in EVOLUTION_BRUSH_FACETS.enumerated() {
        if !f.engines.contains(base.engine) { continue }
        if let shapes = f.shapes, !shapes.contains(shape) { continue }
        if let marks = f.marks, !marks.contains(marksKind) { continue }
        let gate = PixerateRandom.rand01(seed, index * 32 + fi, 301)
        if fi > 0 && gate >= 0.35 + 0.65 * amount { continue }
        let cur = getEngineNumber(baseJSON, f.engine)
        let r = PixerateRandom.randSigned(seed, index * 32 + fi, 302)
        let raw = f.relative ? cur * (1 + r * amount * f.span) : cur + r * amount * f.span
        let next = roundScale(clamp(raw, f.min, f.max), f.scale)
        if next != roundScale(cur, f.scale) {
            setPath(&facetSpec, f.facet, .number(next))
        }
    }
    var problems: [String] = []
    let norm = (try? normalizeBrushSpec(.object(facetSpec), &problems)) ?? facetSpec
    var resolved = resolveBrush(norm)
    resolved.builtin = nil
    return resolved
}

/// Rerolls a stroke seed deterministically when `amount > 0`; keeps `strokeSeed` when `amount <= 0`.
public func rerollStrokeSeed(_ strokeSeed: Int, _ amount: Double, _ seed: Int, _ index: Int = 0) -> Int {
    if !(amount > 0) { return strokeSeed }
    let s32 = Int32(truncatingIfNeeded: seed)
    let idxMul = Int32(truncatingIfNeeded: index) &* 7919
    let amt32 = JS.i32(JS.round(amount * 1000))
    let sum = Double(s32) + Double(idxMul) + Double(amt32)
    let salt = PixerateRandom.mix32(JS.u32(sum))
    let strokeU32 = UInt32(bitPattern: Int32(truncatingIfNeeded: strokeSeed))
    let mixed = Int(PixerateRandom.mix32(strokeU32 ^ salt) & 0x7FFF_FFFF)
    return mixed == 0 ? 1 : mixed
}

/// Resamples a stroke's points by arc length to `count` evenly spaced samples.
public func resampleStrokePoints(_ points: [PenPoint], _ count: Int) -> [PenPoint] {
    let m = points.count
    if m == 0 { return [] }
    let n = Swift.max(1, count)
    if m == 1 || n == 1 {
        var p0 = points[0]
        p0.x = roundScale(p0.x, 100)
        p0.y = roundScale(p0.y, 100)
        if let pr = p0.pressure { p0.pressure = roundScale(pr, 1000) }
        return Array(repeating: p0, count: n)
    }
    var cum = [Double](repeating: 0, count: m)
    for i in 1..<m {
        cum[i] = cum[i - 1] + JS.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    }
    let total = cum[m - 1]
    var out: [PenPoint] = []
    out.reserveCapacity(n)
    var seg = 0
    for k in 0..<n {
        let u = Double(k) / Double(n - 1)
        let idx: Int
        let t: Double
        if total <= 1e-6 {
            let pos = u * Double(m - 1)
            idx = Swift.min(m - 2, Int(JS.floor(pos)))
            t = pos - Double(idx)
        } else {
            let target = u * total
            while seg < m - 2 && cum[seg + 1] < target { seg += 1 }
            idx = seg
            let segLen = cum[idx + 1] - cum[idx]
            t = segLen > 1e-9 ? clamp((target - cum[idx]) / segLen, 0, 1) : 0
        }
        let a = points[idx]
        let b = points[idx + 1]
        let pa = a.pressure ?? 0.7
        let pb = b.pressure ?? 0.7
        var pt = PenPoint(
            x: roundScale(a.x + (b.x - a.x) * t, 100),
            y: roundScale(a.y + (b.y - a.y) * t, 100),
            pressure: roundScale(pa + (pb - pa) * t, 1000)
        )
        if a.tiltX != nil || b.tiltX != nil {
            pt.tiltX = roundScale((a.tiltX ?? 0) + ((b.tiltX ?? 0) - (a.tiltX ?? 0)) * t, 10)
        }
        if a.tiltY != nil || b.tiltY != nil {
            pt.tiltY = roundScale((a.tiltY ?? 0) + ((b.tiltY ?? 0) - (a.tiltY ?? 0)) * t, 10)
        }
        out.append(pt)
    }
    return out
}

/// Mixes two brushes by blending their applicable numeric facets onto a dominant parent's skeleton.
public func crossoverBrushes(_ brushA: PaintBrush, _ brushB: PaintBrush, _ seed: Int, _ index: Int = 0) -> PaintBrush {
    let fa = migrateBrushV1(brushA)
    let fb = migrateBrushV1(brushB)
    let pickB = PixerateRandom.rand01(seed, index, 400) >= 0.5
    var domFacet = pickB ? fb : fa
    let ra = resolveBrush(fa)
    let rb = resolveBrush(fb)
    let rDom = pickB ? rb : ra
    let jsa = JSONValue.object(ra.json())
    let jsb = JSONValue.object(rb.json())
    let jsDom = JSONValue.object(rDom.json())
    let shape = domFacet.path("tip.shape")?.stringValue ?? "round"
    let marksKind = domFacet.path("marks.kind")?.stringValue ?? "continuous"
    for (fi, f) in EVOLUTION_BRUSH_FACETS.enumerated() {
        if !f.engines.contains(rDom.engine) { continue }
        if let shapes = f.shapes, !shapes.contains(shape) { continue }
        if let marks = f.marks, !marks.contains(marksKind) { continue }
        let va = getEngineNumber(jsa, f.engine)
        let vb = getEngineNumber(jsb, f.engine)
        let vDom = roundScale(getEngineNumber(jsDom, f.engine), f.scale)
        let w = 0.2 + 0.6 * PixerateRandom.rand01(seed, index * 32 + fi, 401)
        let mixed = roundScale(clamp(va + (vb - va) * w, f.min, f.max), f.scale)
        if mixed != vDom {
            setPath(&domFacet, f.facet, .number(mixed))
        }
    }
    var problems: [String] = []
    let norm = (try? normalizeBrushSpec(.object(domFacet), &problems)) ?? domFacet
    var resolved = resolveBrush(norm)
    resolved.builtin = nil
    return resolved
}

/// Crosses two parent strokes over.
public func crossoverStrokes(_ a: RecordedStroke, _ b: RecordedStroke, _ seed: Int, _ index: Int = 0) -> RecordedStroke {
    let count = a.points.count <= 1 && b.points.count <= 1 ? 1 : Swift.max(2, Int(JS.round(Double(a.points.count + b.points.count) / 2.0)))
    let pa = resampleStrokePoints(a.points, count)
    let pb = resampleStrokePoints(b.points, count)
    let w = 0.25 + 0.5 * PixerateRandom.rand01(seed, index, 410)
    let points: [PenPoint] = pa.enumerated().map { i, p in
        let q = pb[i]
        var pt = PenPoint(
            x: roundScale(p.x + (q.x - p.x) * w, 100),
            y: roundScale(p.y + (q.y - p.y) * w, 100),
            pressure: roundScale((p.pressure ?? 0.7) + ((q.pressure ?? 0.7) - (p.pressure ?? 0.7)) * w, 1000)
        )
        if p.tiltX != nil || q.tiltX != nil {
            pt.tiltX = roundScale((p.tiltX ?? 0) + ((q.tiltX ?? 0) - (p.tiltX ?? 0)) * w, 10)
        }
        if p.tiltY != nil || q.tiltY != nil {
            pt.tiltY = roundScale((p.tiltY ?? 0) + ((q.tiltY ?? 0) - (p.tiltY ?? 0)) * w, 10)
        }
        return pt
    }
    let color = mixColorOklch(a.color, b.color, w)
    let brush = crossoverBrushes(a.brush, b.brush, seed, index)
    let bSeed32 = Int32(truncatingIfNeeded: b.seed)
    let seed32 = Int32(truncatingIfNeeded: seed)
    let innerU32 = JS.u32(Double(bSeed32) + Double(seed32) + Double(index))
    let innerMix = PixerateRandom.mix32(innerU32)
    let aSeedU32 = UInt32(bitPattern: Int32(truncatingIfNeeded: a.seed))
    let outerMix = Int(PixerateRandom.mix32(aSeedU32 ^ innerMix) & 0x7FFF_FFFF)
    let childSeed = outerMix == 0 ? 1 : outerMix
    let dom = w >= 0.5 ? b : a
    var effect = dom.effect
    if let e = effect, e.map?.by == "path" {
        effect = withStrokePath(e, points)
    }
    var load = dom.load
    if var l = load, l.reservoir != nil {
        l.reservoir = hexToRgb8(color).map { Double($0) / 255.0 }
        load = l
    }
    return RecordedStroke(
        id: a.id,
        layerId: a.layerId,
        brush: brush,
        color: color,
        points: points,
        seed: childSeed,
        copies: dom.copies,
        load: load,
        stencils: dom.stencils,
        paint: dom.paint,
        effect: effect
    )
}

/// Mutates one stroke genome with `rates`.
public func mutateStroke(
    _ stroke: RecordedStroke,
    _ rates: ResolvedMutationRates,
    _ seed: Int,
    _ index: Int = 0,
    group: (origin: (x: Double, y: Double), variation: ReplayOptions)? = nil
) -> RecordedStroke {
    var out = stroke
    out.key = newStrokeKey()
    let baseSize = stroke.brush.tip.size
    if rates.geometry > 0 {
        let b = strokeBounds(out.points)
        let origin = group?.origin ?? (b.x + b.width / 2, b.y + b.height / 2)
        let v = group?.variation ?? seededStrokeVariation(rates.geometry, seed, index)
        let m = variationAffine(v, origin)
        out = varyStroke(out, m, pressureScale: v.pressureScale ?? 1)
        if rates.brush == 0 {
            out.brush.tip.size = baseSize
        } else {
            out.brush.tip.size = roundScale(out.brush.tip.size, 10)
        }
        let jitterSeed = Int(JS.i32(Double(Int32(truncatingIfNeeded: seed)) + Double(Int32(truncatingIfNeeded: index) &* 997)))
        let jittered = jitterStrokePoints(out.points, rates.geometry, jitterSeed)
        out.points = jittered
        if let e = out.effect, e.map?.by == "path" {
            out.effect = withStrokePath(e, jittered)
        }
    }
    if rates.color > 0 {
        let nextColor = driftColorOklch(out.color, rates.color, seed, index)
        if var g = out.paint {
            g.stops = g.stops.enumerated().map { si, st in
                var s = st
                s.color = driftColorOklch(st.color, rates.color, seed, index * 16 + si + 1)
                return s
            }
            out.color = g.stops.first?.color ?? nextColor
            out.paint = g
        } else {
            out.color = nextColor
        }
        if var l = out.load, l.reservoir != nil, out.color != stroke.color {
            l.reservoir = hexToRgb8(out.color).map { Double($0) / 255.0 }
            out.load = l
        }
    }
    if rates.brush > 0 {
        out.brush = driftBrushFacets(out.brush, rates.brush, seed, index)
    }
    if rates.seed > 0 {
        out.seed = rerollStrokeSeed(out.seed, rates.seed, seed, index)
    }
    return out
}

public func mutateGenome(_ strokes: [RecordedStroke], _ rates: ResolvedMutationRates, _ variantSeed: Int) -> [RecordedStroke] {
    let b = strokeBounds(strokes.flatMap(\.points))
    let origin = (b.x + b.width / 2, b.y + b.height / 2)
    let variation = seededStrokeVariation(rates.geometry, variantSeed, 0)
    return strokes.enumerated().map { k, s in mutateStroke(s, rates, variantSeed, k, group: (origin, variation)) }
}

public func crossoverGenomes(
    _ genomeA: [RecordedStroke],
    _ genomeB: [RecordedStroke],
    _ rates: ResolvedMutationRates,
    _ variantSeed: Int
) -> [RecordedStroke] {
    let len = Swift.max(genomeA.count, genomeB.count)
    var crossed: [RecordedStroke] = []
    crossed.reserveCapacity(len)
    for k in 0..<len {
        let a = genomeA[k % genomeA.count]
        let b = genomeB[k % genomeB.count]
        crossed.append(crossoverStrokes(a, b, variantSeed, k))
    }
    return mutateGenome(crossed, rates, Int(JS.i32(Double(variantSeed) + 3571)))
}

public func describeGenomeDiff(
    _ parents: [RecordedStroke],
    _ children: [RecordedStroke],
    crossover: Bool = false
) -> (diff: String, changes: JSONObject) {
    var geometry = false
    var colors: [(from: String, to: String)] = []
    var facetOrder: [String] = []
    var facets: [String: (from: Double, to: Double)] = [:]
    var seedChanged = false

    for i in 0..<children.count {
        let p = parents[i % parents.count]
        let c = children[i]
        if p.points.count != c.points.count || c.points.enumerated().contains(where: { k, pt in
            pt.x != p.points[k].x || pt.y != p.points[k].y || (pt.pressure ?? 0.7) != (p.points[k].pressure ?? 0.7)
        }) {
            geometry = true
        }
        let pCol = p.color.lowercased()
        let cCol = c.color.lowercased()
        if pCol != cCol && !colors.contains(where: { $0.from == pCol && $0.to == cCol }) {
            colors.append((from: pCol, to: cCol))
        }
        let fp = migrateBrushV1(p.brush)
        let fc = migrateBrushV1(c.brush)
        let rp = resolveBrush(fp)
        let rc = resolveBrush(fc)
        let jsp = JSONValue.object(rp.json())
        let jsc = JSONValue.object(rc.json())
        let shape = fc.path("tip.shape")?.stringValue ?? "round"
        let marksKind = fc.path("marks.kind")?.stringValue ?? "continuous"
        for f in EVOLUTION_BRUSH_FACETS {
            if !f.engines.contains(rc.engine) { continue }
            if let shapes = f.shapes, !shapes.contains(shape) { continue }
            if let marks = f.marks, !marks.contains(marksKind) { continue }
            let vp = roundScale(getEngineNumber(jsp, f.engine), f.scale)
            let vc = roundScale(getEngineNumber(jsc, f.engine), f.scale)
            if vp != vc && facets[f.facet] == nil {
                facetOrder.append(f.facet)
                facets[f.facet] = (from: vp, to: vc)
            }
        }
        if p.seed != c.seed { seedChanged = true }
    }

    var parts: [String] = []
    if crossover { parts.append("crossover") }
    if geometry { parts.append("geometry") }
    for col in colors.prefix(2) { parts.append("color \(col.from) → \(col.to)") }
    for k in facetOrder.prefix(3) {
        let v = facets[k]!
        parts.append("\(k) \(jsText(v.from)) → \(jsText(v.to))")
    }
    if facetOrder.count > 3 { parts.append("+\(facetOrder.count - 3) facets") }
    if seedChanged { parts.append("seed") }

    var facetsJSON = JSONObject()
    for k in facetOrder {
        let v = facets[k]!
        facetsJSON[k] = ["from": .number(v.from), "to": .number(v.to)]
    }
    let changes: JSONObject = [
        "geometry": .bool(geometry),
        "colors": .array(colors.map { ["from": .string($0.from), "to": .string($0.to)] }),
        "facets": .object(facetsJSON),
        "seedChanged": .bool(seedChanged),
        "crossover": .bool(crossover),
    ]
    return (parts.isEmpty ? "unchanged" : parts.joined(separator: ", "), changes)
}

public func proposalGenomeStrokes(_ controller: PaintEditorController, _ proposal: PaintProposal) -> [RecordedStroke] {
    if let g = proposal.strokeGenome, !g.isEmpty { return g }
    var out: [RecordedStroke] = []
    for op in proposal.ops {
        switch op["kind"]?.stringValue {
        case "stroke":
            let brushId = op["brushId"]?.stringValue
            var brush = (brushId.flatMap { controller.getBrush($0) }) ?? controller.brush
            if let size = op["size"]?.numberValue {
                brush.tip.size = size
            }
            let color = (op["color"]?.stringValue ?? controller.color).lowercased()
            let points = (op["points"]?.arrayValue ?? []).compactMap(PenPoint.init(json:))
            out.append(RecordedStroke(
                id: proposal.id,
                layerId: controller.doc.activeLayerId ?? "layer-1",
                brush: brush,
                color: color,
                points: points,
                seed: 1
            ))
        case "echo":
            let ids = op["strokeIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
            let picked = ids.compactMap { id in controller.doc.strokes.first { $0.id == id } }
            if !picked.isEmpty {
                let b = strokeBounds(picked.flatMap(\.points))
                let o = op["origin"]?.objectValue
                let origin = o.map { ($0["x"]?.numberValue ?? 0, $0["y"]?.numberValue ?? 0) } ?? (b.x + b.width / 2, b.y + b.height / 2)
                let v = ReplayOptions(
                    strokeIds: ids, dx: op["dx"]?.numberValue, dy: op["dy"]?.numberValue,
                    scale: op["scale"]?.numberValue, rotate: op["rotate"]?.numberValue, flipX: op["flipX"]?.boolValue,
                    origin: origin
                )
                let step = variationAffine(v, origin)
                for s in picked { out.append(varyStroke(s, step)) }
            }
        default:
            break
        }
    }
    return out
}

extension PaintEditorController {
    public func breedStrokes(
        strokeIds: [String],
        count: Double? = nil,
        mutation: JSONObject? = nil,
        seed: Double? = nil,
        origin: String? = nil
    ) throws -> JSONObject {
        if strokeIds.isEmpty || strokeIds.count > 16 {
            throw PaintEditorError("strokeIds must have 1..16 stroke ids (got \(strokeIds.count)); call list_strokes for the ids.")
        }
        let c = count ?? 4
        if !(c.rounded() == c && c >= 2 && c <= 12) {
            throw PaintEditorError("count \(jsText(c)) is out of range; use a whole number in 2..12.")
        }
        let s = seed ?? 1
        if !(s.rounded() == s && s >= 0) {
            throw PaintEditorError("seed \(jsText(s)) must be a whole number of 0 or more.")
        }
        let rates = try normalizeMutationRates(mutation)
        let parents: [RecordedStroke] = try strokeIds.map { id in
            guard let st = doc.strokes.first(where: { $0.id == id }) else {
                throw PaintEditorError("Unknown stroke \"\(id)\". Call list_strokes for the ids.")
            }
            if let refusal = evolutionStrokeRefusal(st.brush) {
                throw PaintEditorError(refusal)
            }
            return st
        }
        let n = Int(c)
        let baseSeed = Int(s)
        var proposalIds: [JSONValue] = []
        var list: [JSONValue] = []
        for i in 0..<n {
            let variantSeed = Int(JS.i32(Double(baseSeed) + Double(i * 7919)))
            let children = mutateGenome(parents, rates, variantSeed)
            let (diff, changes) = describeGenomeDiff(parents, children)
            let prop = try proposals.proposeStrokes(title: "Variant \(i + 1)", rationale: diff, origin: origin, strokes: children)
            proposalIds.append(.string(prop.id))
            list.append([
                "proposalId": .string(prop.id),
                "title": .string(prop.title),
                "seed": .number(Double(variantSeed)),
                "bounds": rectJSON(prop.bounds),
                "diff": .string(diff),
                "changes": .object(changes),
            ])
        }
        return ["proposalIds": .array(proposalIds), "proposals": .array(list)]
    }

    public func breedProposal(
        proposalIds: [String],
        count: Double? = nil,
        mutation: JSONObject? = nil,
        seed: Double? = nil,
        origin: String? = nil
    ) throws -> JSONObject {
        if proposalIds.isEmpty || proposalIds.count > 2 {
            throw PaintEditorError("proposalIds must have 1 or 2 proposal ids (1 to mutate, 2 to cross over; got \(proposalIds.count)); call list_paint_proposals for the ids.")
        }
        let c = count ?? 4
        if !(c.rounded() == c && c >= 2 && c <= 12) {
            throw PaintEditorError("count \(jsText(c)) is out of range; use a whole number in 2..12.")
        }
        let s = seed ?? 1
        if !(s.rounded() == s && s >= 0) {
            throw PaintEditorError("seed \(jsText(s)) must be a whole number of 0 or more.")
        }
        let rates = try normalizeMutationRates(mutation)
        let parentProps: [PaintProposal] = try proposalIds.map { id in
            guard let p = proposals.get(id) else {
                throw PaintEditorError("No pending paint proposal \"\(id)\". Call list_paint_proposals for the ids.")
            }
            return p
        }
        let parentGenomes: [[RecordedStroke]] = try parentProps.map { p in
            let strokes = proposalGenomeStrokes(self, p)
            if strokes.isEmpty {
                throw PaintEditorError("Proposal \"\(p.id)\" has no stroke genome to breed from.")
            }
            for st in strokes {
                if let refusal = evolutionStrokeRefusal(st.brush) {
                    throw PaintEditorError(refusal)
                }
            }
            return strokes
        }
        let isCrossover = parentGenomes.count == 2
        let n = Int(c)
        let baseSeed = Int(s)
        var outIds: [JSONValue] = []
        var list: [JSONValue] = []
        for i in 0..<n {
            let variantSeed = Int(JS.i32(Double(baseSeed) + Double(i * 7919)))
            let children = isCrossover
                ? crossoverGenomes(parentGenomes[0], parentGenomes[1], rates, variantSeed)
                : mutateGenome(parentGenomes[0], rates, variantSeed)
            let (diff, changes) = describeGenomeDiff(parentGenomes[0], children, crossover: isCrossover)
            let title = isCrossover
                ? "Crossover \(i + 1) (\(parentProps[0].id) × \(parentProps[1].id))"
                : "Variant \(i + 1) of \(parentProps[0].id)"
            let prop = try proposals.proposeStrokes(title: title, rationale: diff, origin: origin, strokes: children)
            outIds.append(.string(prop.id))
            list.append([
                "proposalId": .string(prop.id),
                "title": .string(prop.title),
                "seed": .number(Double(variantSeed)),
                "bounds": rectJSON(prop.bounds),
                "diff": .string(diff),
                "changes": .object(changes),
            ])
        }
        return ["proposalIds": .array(outIds), "proposals": .array(list)]
    }

    public func getProposalGenome(_ proposalId: String) throws -> JSONObject {
        guard let p = proposals.get(proposalId) else {
            throw PaintEditorError("No pending paint proposal \"\(proposalId)\". Call list_paint_proposals for the ids.")
        }
        let strokes = proposalGenomeStrokes(self, p)
        if strokes.isEmpty {
            throw PaintEditorError("Proposal \"\(proposalId)\" has no stroke genome.")
        }
        return [
            "proposalId": .string(p.id),
            "title": .string(p.title),
            "bounds": rectJSON(p.bounds),
            "strokes": .array(strokes.map(strokeToJSON)),
        ]
    }
}

func paintEvolutionHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["breed_strokes"] = { a in
        let ids = a["strokeIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return .object(try c.breedStrokes(strokeIds: ids, count: a["count"]?.numberValue, mutation: a["mutation"]?.objectValue, seed: a["seed"]?.numberValue))
    }
    h["breed_proposal"] = { a in
        let ids = a["proposalIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return .object(try c.breedProposal(proposalIds: ids, count: a["count"]?.numberValue, mutation: a["mutation"]?.objectValue, seed: a["seed"]?.numberValue))
    }
    h["get_proposal_genome"] = { a in
        .object(try c.getProposalGenome(a["proposalId"]?.stringValue ?? ""))
    }
    return h
}
