import Foundation
import PixerateCore
import PixerateRaster

/**
 * Procedural brush engines (`paint-editor/procedural.ts`): marks made by small simulations driven
 * by the pen rather than by stamping the tip.
 *
 * - **Particle brushes** (`engine: "particle"`): particles follow the pen by their own rules
 *   (`string`, `spring`, `orbit`, `flow`, `elastic`, `fuzzy`), drawn as dots (round, or stamped
 *   with editor stamps), lines, sequences of beads, or ribbons filled between neighbours.
 * - **Bristle brushes** (`engine: "bristle"`): a tuft of bristles, each its own thin line that
 *   lags behind the tip by its stiffness and runs dry at its own pace.
 *
 * Both step by distance travelled (seeded, so a replay paints the same marks) and build a
 * `CoverageMap` like the dab engine. Numbers stored in the TS `Float32Array`s are stored as
 * `Float` at the same places (see GOTCHAS).
 */

/// What a coverage-building stroke engine gives the stroke session (`CoverageStroke`).
protocol CoverageStroke: AnyObject {
    var coverage: CoverageMap { get }
    var dabCount: Int { get }
    var film: FilmBuffer? { get set }
    func push(_ points: [PenPoint]) -> [RasterRect]
    func finish() -> [RasterRect]
}

extension DryStroke: CoverageStroke {}

/// Pixels of pen travel per simulation step.
private let STEP_PX = 1.5
/// Fuzzy strands always wave, by at least this fraction of the tip size.
private let FUZZY_AMPLITUDE = 0.12
/// Ms of travel per px for strokes without times.
private let NOMINAL_MS_PER_PX = 2.0
/// Ribbon fill: sub-rows per pixel row.
private let RIBBON_SUB = 4

@inline(__always) private func rand01(_ seed: Int, _ index: Int, _ stream: Int) -> Double { PixerateRandom.rand01(seed, index, stream) }

/// Coverage of an editor stamp at (u, v) in its unit square (`stampCoverage` in `stickers/stamps.ts`).
func stampCoverage(_ kind: String, _ u: Double, _ v: Double, _ t: Int) -> Double {
    let r = JS.hypot(u, v)
    let a = JS.atan2(v, u)
    func edge(_ d: Double) -> Double { Swift.min(1, Swift.max(0, d * 24 + 0.5)) }
    switch kind {
    case "dot": return edge(0.95 - r)
    case "ring": return edge(Swift.min(0.95 - r, r - 0.6))
    case "star":
        let f = (((a + Double.pi / 2) * 5) / (2 * Double.pi)).truncatingRemainder(dividingBy: 1)
        let g = f < 0 ? f + 1 : f
        let notch = Swift.min(g, 1 - g) * 2
        return edge(0.95 - 0.55 * notch - r)
    case "sparkle":
        let q = JS.pow(abs(u) / 0.95, 0.6) + JS.pow(abs(v) / 0.95, 0.6)
        return edge((1 - q) * 0.4)
    case "heart":
        let x = u * 1.1
        let y = -v * 1.1 + 0.15
        let q = x * x + y * y - 0.55
        return edge(-(q * q * q - x * x * y * y * y) * 3)
    case "leaf":
        let w = 0.42 * Swift.max(0, 1 - u * u).squareRoot()
        let inside = edge(w - abs(v + 0.15 * u * u))
        let rib = abs(v + 0.15 * u * u) < 0.03 && abs(u) < 0.85 ? 0.65 : 1
        return inside * rib
    case "flower":
        let petals = 0.6 + 0.35 * abs(JS.cos(2.5 * a))
        let body = edge(petals - r)
        return r < 0.22 ? Swift.max(body, 1) * 0.85 : body
    case "confetti":
        return edge(Swift.min(0.9 - abs(u), 0.35 - abs(v)))
    case "splat":
        var rr = 0.55
        for k in 1...3 { rr += 0.08 * JS.sin(a * Double(k + 2) + PixerateRandom.hash2(k, 1, t) * 6.28) / Double(k) }
        var c = edge(rr - r)
        for k in 0..<4 {
            let ang = PixerateRandom.hash2(k, 7, t) * Double.pi * 2
            let dist = 0.72 + 0.2 * PixerateRandom.hash2(k, 9, t)
            let dx = u - JS.cos(ang) * dist
            let dy = v - JS.sin(ang) * dist
            c = Swift.max(c, edge(0.08 + 0.06 * PixerateRandom.hash2(k, 11, t) - JS.hypot(dx, dy)))
        }
        return c
    default: return 0
    }
}

/// The editor stamp a texture ref names (`stampSampler` for editor stamps), or nil.
func editorStampKind(_ ref: String) -> String? { editorStampOf(ref.contains(":") ? ref : "editor:\(ref)") }

/// Shared plumbing of the procedural engines (`MarkStroke`): smoothing, the fine dab walk per copy, grain, gradient colour and laying marks.
class MarkStroke: CoverageStroke {
    let coverage = CoverageMap()
    var dabCount = 0
    let brush: PaintBrush
    let smoother: PenSmoother
    let copies: [StrokeCopy]
    let walkers: [PenDabWalker]
    let depth: Double
    let seed: Int
    let grain: PaperGrain?
    private var buf: [Float] = []
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?
    private let sampler: PaintGradientSampler?
    private let tipTable: [PaintGradientSample]?
    private var pen: PenDab?
    private var penColor = PaintGradientSample()
    /// Effect paint: each pixel of a mark takes its colour (and alpha) from these pixels.
    var effect: EffectPaintPixels?
    /// The art of image sources a textured dot can lay (`source:<id>`).
    var stampArt: StampArtLookup?
    /// Thin-film coat buffer for iridescent particle and bristle strokes.
    var film: FilmBuffer?
    private var field: [Float] = []
    private var limits: [Float] = []

    init(_ brush: PaintBrush, grain: PaperGrain?, paperDepth: Double, seed: Int, copies: [StrokeCopy], paint: PaintGradientSource?) {
        self.brush = brush
        self.grain = grain
        self.seed = seed
        sampler = paint.map { PaintGradientSampler($0, seed: seed) }
        tipTable = sampler?.acrossTip == true ? sampler!.tipTable(TIP_GRADIENT_STEPS) : nil
        smoother = PenSmoother(brush.tip.smoothing, brush.pressureSmoothing)
        self.copies = copies.isEmpty ? [IDENTITY_COPY] : copies
        // A fine walk (spacing a fraction of the tip): each walked dab is a simulation input.
        var fine = brush
        fine.tip.spacing = Swift.max(0.01, Swift.min(0.25, STEP_PX / Swift.max(1, brush.tip.size)))
        walkers = self.copies.enumerated().map { i, c in PenDabWalker(fine, Int(Int32(truncatingIfNeeded: seed + i * 7919)), c.linear) }
        depth = grain != nil && !grain!.flat ? Swift.min(1, Swift.max(0, paperDepth * brush.grain)) : 0
    }

    func push(_ points: [PenPoint]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for raw in points {
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (i, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                walkers[i].push(c.map(p), &dabs)
                for d in dabs { step(i, d, &rects) }
            }
        }
        return rects
    }

    func finish() -> [RasterRect] {
        var rects: [RasterRect] = []
        for (i, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                walkers[i].push(c.map(q), &dabs)
            }
            walkers[i].finish(&dabs)
            for d in dabs { step(i, d, &rects) }
        }
        return rects
    }

    private func step(_ copy: Int, _ d: PenDab, _ rects: inout [RasterRect]) {
        pen = d
        if let sampler, tipTable == nil { penColor = sampler.dab(d.params) }
        advance(copy, d, &rects)
    }

    /// One simulation step of copy `copy` with the pen at dab `d`.
    func advance(_ copy: Int, _ d: PenDab, _ rects: inout [RasterRect]) {}

    private func markColor(_ x: Double, _ y: Double) -> PaintGradientSample? {
        guard sampler != nil, let d = pen else { return nil }
        guard let table = tipTable else { return penColor }
        let u = ((x - d.dab.x) * JS.sin(d.direction) + (y - d.dab.y) * JS.cos(d.direction)) / Swift.max(0.5, d.dab.radius)
        let last = table.count - 1
        return table[Swift.min(last, Swift.max(0, Int(JS.round(((u + 1) / 2) * Double(last)))))]
    }

    /// A zeroed scratch buffer of at least `n` values.
    func scratch(_ n: Int) -> [Float] {
        if buf.count < n { buf = [Float](repeating: 0, count: n) } else { for k in 0..<n { buf[k] = 0 } }
        let out = buf
        buf = []
        return out
    }

    func giveBack(_ b: [Float]) { buf = b }

    /// Stamps one round mark of radius `r` at (x, y) with flow `alpha` towards `opacity`.
    func mark(_ x: Double, _ y: Double, _ r: Double, _ alpha: Double, _ opacity: Double, _ pressure: Double, _ rects: inout [RasterRect]) {
        if !(r > 0.05) || !(alpha > 0) { return }
        let dab = Dab(x: x, y: y, radius: Swift.max(0.5, r), alpha: Swift.min(1, alpha), opacity: Swift.min(1, opacity), angle: 0, roundness: 1)
        let hardness = brush.tip.hardness
        let rect = dabRect(dab, hardness)
        let n = rect.width * rect.height
        if n <= 0 { return }
        var vals = scratch(n)
        rasterizeDab(dab, hardness, rect, &vals)
        lay(rect, &vals, dab.opacity, pressure, x, y, &rects)
        giveBack(vals)
    }

    /// Stamps an editor stamp or an image source over a square of half-size `r`, turned `rotation` radians clockwise (round without art).
    func stamp(_ x: Double, _ y: Double, _ r: Double, _ kind: String, _ rotation: Double, _ seed: Int, _ alpha: Double, _ opacity: Double, _ pressure: Double, _ rects: inout [RasterRect]) {
        if !(r > 0.05) || !(alpha > 0) { return }
        guard let sample = stampSampler(kind, stampArt) else { return mark(x, y, r, alpha, opacity, pressure, &rects) }
        let reach = Swift.max(0.5, r) * 2.0.squareRoot() + 1
        let rx = Int(JS.floor(x - reach)), ry = Int(JS.floor(y - reach))
        let rect = RasterRect(x: rx, y: ry, width: Int(JS.ceil(x + reach)) - rx, height: Int(JS.ceil(y + reach)) - ry)
        let n = rect.width * rect.height
        var vals = scratch(n)
        let ss = r < 10 ? 3 : 1
        let c = JS.cos(rotation), s = JS.sin(rotation)
        let inv = 1 / Swift.max(0.5, r)
        let a = Swift.min(1, alpha)
        var idx = 0
        for yy in 0..<rect.height {
            for xx in 0..<rect.width {
                var sum = 0.0
                for sy in 0..<ss {
                    for sx in 0..<ss {
                        let dx = Double(rect.x + xx) + (Double(sx) + 0.5) / Double(ss) - x
                        let dy = Double(rect.y + yy) + (Double(sy) + 0.5) / Double(ss) - y
                        sum += sample((dx * c + dy * s) * inv, (dy * c - dx * s) * inv, seed)
                    }
                }
                vals[idx] = Float((sum / Double(ss * ss)) * a)
                idx += 1
            }
        }
        lay(rect, &vals, Swift.min(1, opacity), pressure, x, y, &rects)
        giveBack(vals)
    }

    /// Lays coverage `vals` over `rect` towards `opacity`: paper grain, then the mark's gradient colour.
    func lay(_ rect: RasterRect, _ vals: inout [Float], _ opacity: Double, _ pressure: Double, _ x: Double, _ y: Double, _ rects: inout [RasterRect]) {
        let n = rect.width * rect.height
        if n <= 0 { return }
        if depth > 0, let grain {
            var k = 0
            for yy in 0..<rect.height {
                for xx in 0..<rect.width {
                    if vals[k] > 0 { vals[k] = Float(Double(vals[k]) * grainCatch(grain.at(Double(rect.x + xx) + 0.5, Double(rect.y + yy) + 0.5), depth, pressure)) }
                    k += 1
                }
            }
        }
        if let effect {
            if field.count < n * 3 { field = [Float](repeating: 0, count: n * 3) }
            if limits.count < n { limits = [Float](repeating: 0, count: n) }
            limits.withUnsafeMutableBufferPointer { l in
                sampleEffectField(effect, rect, &vals, &field, pen.map(EffectDabPlace.init), limits: l.baseAddress)
            }
            coverage.accumulate(rect, vals, opacity, field: field, limits: limits)
        } else {
            let color = markColor(x, y)
            if let color, color.alpha < 1 { for k in 0..<n { vals[k] = Float(Double(vals[k]) * color.alpha) } }
            coverage.accumulate(rect, vals, opacity, color: color?.rgb)
        }
        if let film, let ir = brush.iridescence {
            film.deposit(rect, vals, opacity * brush.tip.opacity, pressure, ir)
        }
        rects.append(rect)
        dabCount += 1
    }

    /// Marks along a segment, spaced by a fraction of the radius.
    func segment(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, _ r: Double, _ alpha: Double, _ opacity: Double, _ pressure: Double, _ rects: inout [RasterRect]) {
        let len = JS.hypot(x1 - x0, y1 - y0)
        let step = Swift.max(0.35, r * 0.5)
        let n = Swift.max(1, Int(JS.ceil(len / step)))
        for i in 1...n { mark(x0 + ((x1 - x0) * Double(i)) / Double(n), y0 + ((y1 - y0) * Double(i)) / Double(n), r, alpha, opacity, pressure, &rects) }
    }
}

// MARK: - Particle brushes

/// A particle brush's settings, read from the brush's `particle` block.
struct ParticleSettings {
    var kind: String, render: String, count: Int, size: Double, spread: Double, stiffness: Double, damping: Double, speed: Double, gravity: Double, life: Double, interval: Double
    var ribbonFill: Double, ribbonPairs: String, waveAmplitude: Double, waveLength: Double, waveSpeed: Double, wavePhaseJitter: Double
    var dotTextures: [String], dotTextureOrder: String, dotRotation: String

    init(_ o: JSONObject) {
        func n(_ k: String) -> Double { o[k]?.numberValue ?? DEFAULT_PARTICLE[k]?.numberValue ?? 0 }
        func s(_ k: String) -> String { o[k]?.stringValue ?? DEFAULT_PARTICLE[k]?.stringValue ?? "" }
        kind = s("kind"); render = s("render"); count = Int(n("count")); size = n("size"); spread = n("spread"); stiffness = n("stiffness"); damping = n("damping")
        speed = n("speed"); gravity = n("gravity"); life = n("life"); interval = n("interval"); ribbonFill = n("ribbonFill"); ribbonPairs = s("ribbonPairs")
        waveAmplitude = n("waveAmplitude"); waveLength = n("waveLength"); waveSpeed = n("waveSpeed"); wavePhaseJitter = n("wavePhaseJitter")
        dotTextures = (o["dotTextures"]?.arrayValue ?? []).compactMap(\.stringValue); dotTextureOrder = s("dotTextureOrder"); dotRotation = s("dotRotation")
    }
}

private struct Mass { var x: Double, y: Double, vx = 0.0, vy = 0.0 }

private final class Particle {
    var x: Double, y: Double, vx = 0.0, vy = 0.0
    var ox: Double, oy: Double, k: Double, phase: Double
    var age = 0.0, run = 0.0, bead = 0
    var alive = true
    var strand: [Mass]?
    var wavePhase: Double, waveScale: Double
    var dx: Double, dy: Double
    var px = Double.nan, py = Double.nan
    var fade = 1.0
    init(x: Double, y: Double, ox: Double, oy: Double, k: Double, phase: Double, wavePhase: Double, waveScale: Double) {
        self.x = x; self.y = y; self.ox = ox; self.oy = oy; self.k = k; self.phase = phase
        self.wavePhase = wavePhase; self.waveScale = waveScale; dx = x; dy = y
    }
}

/// Velocity kept per step by a mass in a strand with spring `k` (`chainDamp`).
private func chainDamp(_ damp: Double, _ k: Double) -> Double {
    let q = 1 + 0.8 * Swift.max(0, k).squareRoot()
    return Swift.min(damp, 1 / (q * q))
}

/// Adds the area polygon `pts` covers in each pixel of `rect`, times `weight`, to `out` (`addPolygonArea`).
func addPolygonArea(_ pts: [Double], _ rect: RasterRect, _ out: inout [Float], _ weight: Double = 1) {
    let n = pts.count >> 1
    if n < 3 { return }
    var y0 = Double.infinity, y1 = -Double.infinity
    for i in stride(from: 1, to: pts.count, by: 2) {
        if pts[i] < y0 { y0 = pts[i] }
        if pts[i] > y1 { y1 = pts[i] }
    }
    let r0 = Swift.max(0, Int(JS.floor(y0)) - rect.y)
    let r1 = Swift.min(rect.height - 1, Int(JS.floor(y1)) - rect.y)
    if r0 > r1 { return }
    var xs: [Double] = []
    let w = weight / Double(RIBBON_SUB)
    for row in r0...r1 {
        let base = row * rect.width
        for sub in 0..<RIBBON_SUB {
            let y = Double(rect.y + row) + (Double(sub) + 0.5) / Double(RIBBON_SUB)
            xs.removeAll(keepingCapacity: true)
            var j = n - 1
            for i in 0..<n {
                let yi = pts[i * 2 + 1], yj = pts[j * 2 + 1]
                if (yi <= y) != (yj <= y) { xs.append(pts[i * 2] + ((y - yi) / (yj - yi)) * (pts[j * 2] - pts[i * 2])) }
                j = i
            }
            if xs.count < 2 { continue }
            xs.sort()
            var k = 0
            while k + 1 < xs.count {
                let a = Swift.max(Double(rect.x), xs[k])
                let b = Swift.min(Double(rect.x + rect.width), xs[k + 1])
                k += 2
                if !(b > a) { continue }
                var px = JS.floor(a)
                while px < b {
                    let cover = Swift.min(b, px + 1) - Swift.max(a, px)
                    if cover > 0 {
                        let o = base + Int(px) - rect.x
                        out[o] = Float(Double(out[o]) + cover * w)
                    }
                    px += 1
                }
            }
        }
    }
}

/// Curl of a value-noise field (a swirling, divergence-free flow), deterministic.
private func curl(_ x: Double, _ y: Double, _ seed: Int) -> (Double, Double) {
    func n(_ u: Double, _ v: Double) -> Double {
        let x0 = JS.floor(u), y0 = JS.floor(v)
        let fx = u - x0, fy = v - y0
        let sx = fx * fx * (3 - 2 * fx)
        let sy = fy * fy * (3 - 2 * fy)
        func h(_ a: Double, _ b: Double) -> Double { rand01(seed, Int(a * 73856093 + b * 19349663), 41) }
        let a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1)
        return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
    }
    let e = 0.01
    return ((n(x, y + e) - n(x, y - e)) / (2 * e), -(n(x + e, y) - n(x - e, y)) / (2 * e))
}

/// A particle-brush stroke (`ParticleStroke`).
final class ParticleStroke: MarkStroke {
    private var sets: [[Particle]]
    private var orders: [[Int]]
    private let s: ParticleSettings
    private var spawn = 0.0
    private var dots: [Int]
    /// Ribbon fill: the area each pixel has had so far this stroke.
    private var filled: [TileKey: [Float]] = [:]

    override init(_ brush: PaintBrush, grain: PaperGrain?, paperDepth: Double, seed: Int, copies: [StrokeCopy], paint: PaintGradientSource?) {
        s = ParticleSettings(brush.particle)
        let n = copies.isEmpty ? 1 : copies.count
        sets = Array(repeating: [], count: n)
        orders = Array(repeating: [], count: n)
        dots = Array(repeating: 0, count: n)
        super.init(brush, grain: grain, paperDepth: paperDepth, seed: seed, copies: copies, paint: paint)
    }

    private var strands: Bool { s.kind == "string" || s.kind == "elastic" || s.kind == "fuzzy" }

    private func newParticle(_ x: Double, _ y: Double, _ ox: Double, _ oy: Double, _ k: Double, _ phase: Double, _ i: Int, _ copy: Int) -> Particle {
        let fuzzy = s.kind == "fuzzy"
        let jitter = fuzzy ? 1 : s.wavePhaseJitter
        return Particle(
            x: x, y: y, ox: ox, oy: oy, k: k, phase: phase,
            wavePhase: jitter > 0 ? jitter * Double.pi * 2 * rand01(seed, i, 43 + copy) : 0,
            waveScale: fuzzy ? 0.6 + 0.8 * rand01(seed, i, 47 + copy) : 1
        )
    }

    private func initCopy(_ copy: Int, _ d: PenDab) {
        let size = Swift.max(1, d.dab.radius * 2)
        var list = sets[copy]
        for i in 0..<(s.kind == "flow" ? 0 : s.count) {
            let r = rand01(seed, i, 3 + copy) * s.spread * size * 0.5
            let a = rand01(seed, i, 5 + copy) * Double.pi * 2
            let ox = JS.cos(a) * r, oy = JS.sin(a) * r
            let p = newParticle(d.dab.x + ox, d.dab.y + oy, ox, oy, 0.6 + 0.8 * rand01(seed, i, 7), a, i, copy)
            if strands { p.strand = Array(repeating: Mass(x: d.dab.x + ox, y: d.dab.y + oy), count: 6) }
            if s.kind == "orbit" {
                p.ox = Swift.max(1, r + size * 0.15)
                p.oy = 0
            }
            list.append(p)
        }
        sets[copy] = list
        orders[copy] = list.indices.sorted { i, j in list[i].phase != list[j].phase ? list[i].phase < list[j].phase : i < j }
    }

    /// The sideways wave of particle `p` at pen dab `d`.
    private func wave(_ p: Particle, _ d: PenDab, _ size: Double) -> Double {
        let amp = s.kind == "fuzzy" ? Swift.max(FUZZY_AMPLITUDE, s.waveAmplitude) : s.waveAmplitude
        if !(amp > 0) { return 0 }
        let ms = d.time ?? d.travel * NOMINAL_MS_PER_PX
        let phase = (2 * Double.pi * d.travel) / (s.waveLength * p.waveScale) - s.waveSpeed * 0.025 * ms + p.wavePhase
        return amp * size * JS.sin(phase)
    }

    override func advance(_ copy: Int, _ d: PenDab, _ rects: inout [RasterRect]) {
        if d.index == 0 && sets[copy].isEmpty { initCopy(copy, d) }
        var list = sets[copy]
        let size = Swift.max(1, d.dab.radius * 2)
        let markR = Swift.max(0.5, (size * s.size) / 2)
        let k = 0.02 + 0.3 * s.stiffness
        let damp = 0.6 + 0.38 * (1 - s.damping)
        let g = s.gravity * 0.15
        let op = d.dab.opacity
        let al = Swift.max(0.05, d.dab.alpha)
        let nx = JS.sin(d.direction), ny = JS.cos(d.direction)
        if s.kind == "flow" {
            spawn += Double(s.count) / 8
            while spawn >= 1 {
                spawn -= 1
                let i = dabCount + list.count * 31 + d.index
                let a = rand01(seed, i, 11 + copy) * Double.pi * 2
                let r = rand01(seed, i, 13 + copy) * s.spread * size * 0.5
                list.append(newParticle(d.dab.x + JS.cos(a) * r, d.dab.y + JS.sin(a) * r, 0, 0, 1, a, i, copy))
            }
            sets[copy] = list
        }
        let lifeSteps = 8 + 120 * s.life
        for (i, p) in list.enumerated() {
            if !p.alive { continue }
            switch s.kind {
            case "spring":
                p.vx = (p.vx + (d.dab.x + p.ox - p.x) * k * p.k) * damp
                p.vy = (p.vy + (d.dab.y + p.oy - p.y) * k * p.k + g) * damp
                p.x += p.vx
                p.y += p.vy
            case "string", "fuzzy":
                var strand = p.strand!
                let dm = s.kind == "fuzzy" ? chainDamp(damp, k * p.k) : damp
                var ax = d.dab.x + p.ox, ay = d.dab.y + p.oy
                for m in strand.indices {
                    strand[m].vx = (strand[m].vx + (ax - strand[m].x) * k * p.k + 0) * dm
                    strand[m].vy = (strand[m].vy + (ay - strand[m].y) * k * p.k + g) * dm
                    strand[m].x += strand[m].vx
                    strand[m].y += strand[m].vy
                    ax = strand[m].x
                    ay = strand[m].y
                }
                p.strand = strand
                p.x = strand[strand.count - 1].x
                p.y = strand[strand.count - 1].y
            case "elastic":
                var strand = p.strand!
                let rest = size * 0.12
                let ke = Swift.min(0.9, (0.1 + 0.6 * s.stiffness) * p.k)
                let dm = chainDamp(damp, ke)
                var ax = d.dab.x + p.ox, ay = d.dab.y + p.oy
                for m in strand.indices {
                    let ex = ax - strand[m].x, ey = ay - strand[m].y
                    let len = JS.hypot(ex, ey)
                    let pull = len > rest ? (len - rest) / len : 0
                    strand[m].vx = (strand[m].vx + ex * pull * ke) * dm
                    strand[m].vy = (strand[m].vy + ey * pull * ke + g) * dm
                    strand[m].x += strand[m].vx
                    strand[m].y += strand[m].vy
                    ax = strand[m].x
                    ay = strand[m].y
                }
                p.strand = strand
                p.x = strand[strand.count - 1].x
                p.y = strand[strand.count - 1].y
            case "orbit":
                p.phase += (0.05 + 0.3 * s.speed) * (i % 2 != 0 ? -1 : 1) * (0.7 + 0.6 * rand01(seed, i, 17))
                p.x = d.dab.x + JS.cos(p.phase) * p.ox
                p.y = d.dab.y + JS.sin(p.phase) * p.ox + g * p.ox
            case "flow":
                let cell = Swift.max(8, size * 1.5)
                let (fx, fy) = curl(p.x / cell, p.y / cell, seed)
                let push = size * 0.012 * (0.3 + 1.5 * s.speed)
                let h = JS.hypot(fx, fy)
                let fl = h != 0 && !h.isNaN ? h : 1
                p.vx = p.vx * 0.8 + (fx / fl) * push
                p.vy = p.vy * 0.8 + (fy / fl) * push + g * 0.2
                p.x += p.vx
                p.y += p.vy
                p.age += 1
                if p.age > lifeSteps { p.alive = false }
            default:
                break
            }
            // Where it is drawn: its place, moved sideways by its wave.
            let w = wave(p, d, size)
            let qx = w != 0 ? p.x + nx * w : p.x
            let qy = w != 0 ? p.y + ny * w : p.y
            let px = p.dx, py = p.dy
            p.px = p.dx
            p.py = p.dy
            p.dx = qx
            p.dy = qy
            let fade = s.kind == "flow" ? 1 - p.age / lifeSteps : 1
            p.fade = fade
            let moved = JS.hypot(qx - px, qy - py)
            if d.index == 0 && s.kind != "flow" { continue }
            if s.render == "dot" { dot(copy, qx, qy, qx - px, qy - py, markR * fade, al * fade, op, d, &rects) } else if s.render == "line" || s.render == "ribbon" { segment(px, py, qx, qy, markR * fade, al * fade, op, d.pressure, &rects) } else {
                p.run += moved
                let gap = Swift.max(markR * 2, size * (0.05 + s.interval))
                while p.run >= gap {
                    p.run -= gap
                    p.bead += 1
                    let t = moved > 0 ? 1 - p.run / Swift.max(moved, 1e-6) : 1
                    let bx = px + (qx - px) * Swift.min(1, Swift.max(0, t))
                    let by = py + (qy - py) * Swift.min(1, Swift.max(0, t))
                    dot(copy, bx, by, qx - px, qy - py, markR * (0.7 + 0.6 * (Double(p.bead % 3) / 2)) * fade, al * fade, op, d, &rects)
                }
            }
        }
        if s.render == "ribbon" && !(d.index == 0 && s.kind != "flow") { ribbon(copy, list, op, al, d, &rects) }
        if s.kind == "flow" && list.count > 512 { sets[copy] = list.filter(\.alive) }
    }

    private func dot(_ copy: Int, _ x: Double, _ y: Double, _ mx: Double, _ my: Double, _ r: Double, _ alpha: Double, _ opacity: Double, _ d: PenDab, _ rects: inout [RasterRect]) {
        let textures = s.dotTextures
        if textures.isEmpty { return mark(x, y, r, alpha, opacity, d.pressure, &rects) }
        let n = dots[copy]
        dots[copy] += 1
        let pick = s.dotTextureOrder == "random" ? Swift.min(textures.count - 1, Int(JS.floor(rand01(seed, n, 31 + copy) * Double(textures.count)))) : n % textures.count
        let rotation: Double
        if s.dotRotation == "random" { rotation = rand01(seed, n, 37 + copy) * Double.pi * 2 } else if s.dotRotation == "follow" { rotation = mx != 0 || my != 0 ? JS.atan2(my, mx) : -d.direction } else { rotation = (-brush.tip.angle * Double.pi) / 180 }
        let stampSeed = Int(UInt32(truncatingIfNeeded: seed &+ n &* 2_654_435_761))
        stamp(x, y, r, textures[pick], rotation, stampSeed, alpha, opacity, d.pressure, &rects)
    }

    private func ribbon(_ copy: Int, _ list: [Particle], _ opacity: Double, _ alpha: Double, _ d: PenDab, _ rects: inout [RasterRect]) {
        if !(s.ribbonFill > 0) { return }
        func live(_ p: Particle) -> Bool { p.alive && !p.px.isNaN }
        let order: [Particle] = s.kind == "flow" ? list.filter(live) : orders[copy].map { list[$0] }.filter(live)
        if order.count < 2 { return }
        var pairs: [(Particle, Particle)] = []
        if s.ribbonPairs == "first-last" { pairs.append((order[0], order[order.count - 1])) } else { for i in 0..<(order.count - 1) { pairs.append((order[i], order[i + 1])) } }
        let ceil = Swift.min(1, opacity * s.ribbonFill)
        for (a, b) in pairs {
            let pts = [a.px, a.py, a.dx, a.dy, b.dx, b.dy, b.px, b.py]
            var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
            for i in stride(from: 0, to: 8, by: 2) {
                x0 = Swift.min(x0, pts[i]); x1 = Swift.max(x1, pts[i])
                y0 = Swift.min(y0, pts[i + 1]); y1 = Swift.max(y1, pts[i + 1])
            }
            let fx0 = Int(JS.floor(x0)), fy0 = Int(JS.floor(y0))
            let rect = RasterRect(x: fx0, y: fy0, width: Int(JS.floor(x1)) - fx0 + 1, height: Int(JS.floor(y1)) - fy0 + 1)
            var area = scratch(rect.width * rect.height)
            addPolygonArea(pts, rect, &area, Swift.min(a.fade, b.fade) * alpha)
            if telescope(rect, &area) { lay(rect, &area, ceil, d.pressure, (a.dx + b.dx) / 2, (a.dy + b.dy) / 2, &rects) }
            giveBack(area)
        }
    }

    /// Turns newly filled area into coverage towards the fill's ceiling (`telescope`).
    private func telescope(_ rect: RasterRect, _ area: inout [Float]) -> Bool {
        var any = false
        var k = 0
        for yy in 0..<rect.height {
            let gy = rect.y + yy
            let ty = floorDiv(gy, TILE)
            for xx in 0..<rect.width {
                defer { k += 1 }
                let add = Double(area[k])
                if !(add > 0) { continue }
                let gx = rect.x + xx
                let tx = floorDiv(gx, TILE)
                // Past the surface range the fill is not tracked (each band lays its area afresh).
                let key = tileKeyIn(tx, ty)
                if key < 0 {
                    any = true
                    continue
                }
                if filled[key] == nil { filled[key] = [Float](repeating: 0, count: TILE * TILE) }
                let ti = (gy - ty * TILE) * TILE + (gx - tx * TILE)
                let before = Double(filled[key]![ti])
                let after = Swift.min(1, before + add)
                filled[key]![ti] = Float(after)
                area[k] = before < 1 ? Float((after - before) / (1 - before)) : 0
                any = true
            }
        }
        return any
    }
}

@inline(__always) private func floorDiv(_ a: Int, _ b: Int) -> Int { a >= 0 ? a / b : -((-a + b - 1) / b) }

// MARK: - Bristle brushes

private struct Bristle {
    var u: Double, v: Double, x = 0.0, y = 0.0, paint: Double, thirst: Double, w: Double, started = false
}

/// A bristle-brush stroke: every bristle draws its own line (`BristleStroke`).
final class BristleStroke: MarkStroke {
    private var tufts: [[Bristle]] = []
    private let count: Int, stiffness: Double, splay: Double, thickness: Double, load: Double, jitter: Double

    override init(_ brush: PaintBrush, grain: PaperGrain?, paperDepth: Double, seed: Int, copies: [StrokeCopy], paint: PaintGradientSource?) {
        let o = brush.bristle
        func n(_ k: String) -> Double { o[k]?.numberValue ?? DEFAULT_BRISTLE[k]!.numberValue! }
        count = Int(n("count")); stiffness = n("stiffness"); splay = n("splay"); thickness = n("thickness"); load = n("load"); jitter = n("jitter")
        super.init(brush, grain: grain, paperDepth: paperDepth, seed: seed, copies: copies, paint: paint)
        tufts = self.copies.indices.map { c in
            (0..<count).map { i in
                let a = rand01(seed, i, 21 + c) * Double.pi * 2
                let r = rand01(seed, i, 23 + c).squareRoot()
                return Bristle(
                    u: JS.cos(a) * r, v: JS.sin(a) * r,
                    paint: 1 - jitter * 0.4 * rand01(seed, i, 25 + c),
                    thirst: 1 + jitter * (rand01(seed, i, 27 + c) * 2 - 1),
                    w: 1 + jitter * 0.6 * (rand01(seed, i, 29 + c) - 0.5)
                )
            }
        }
    }

    override func advance(_ copy: Int, _ d: PenDab, _ rects: inout [RasterRect]) {
        let dab = d.dab
        let spread = dab.radius * (0.55 + 0.9 * splay * d.pressure)
        let ca = JS.cos(dab.angle), sa = JS.sin(dab.angle)
        let ro = Swift.max(0.15, dab.roundness)
        let tx = JS.cos(d.direction), ty = -JS.sin(d.direction)
        let follow = 0.15 + 0.85 * stiffness
        let bend = dab.radius * (1 - stiffness) * d.pressure * 0.8
        let lineR = Swift.max(0.5, dab.radius * 2 * thickness * 0.5)
        let dryRate = 0.004 * (1 - load)
        for i in tufts[copy].indices {
            var b = tufts[copy][i]
            let lu = b.u * spread
            let lv = b.v * spread * ro
            let ox = lu * ca - lv * sa
            let oy = -(lu * sa + lv * ca)
            let lag = bend * (1 - 0.5 * b.v)
            let wx = dab.x + ox - tx * lag
            let wy = dab.y + oy - ty * lag
            if !b.started {
                b.x = wx
                b.y = wy
                b.started = true
                tufts[copy][i] = b
                continue
            }
            let nx = b.x + (wx - b.x) * follow
            let ny = b.y + (wy - b.y) * follow
            let paint = Swift.max(0, b.paint)
            if paint > 0.02 { segment(b.x, b.y, nx, ny, lineR * b.w * (0.6 + 0.4 * d.pressure), dab.alpha * Swift.min(1, paint * 1.4), dab.opacity, d.pressure, &rects) }
            b.paint -= dryRate * b.thirst * JS.hypot(nx - b.x, ny - b.y)
            b.x = nx
            b.y = ny
            tufts[copy][i] = b
        }
    }
}
