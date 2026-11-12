import Foundation
import PixerateCore
import PixerateRaster

/**
 * The paint editor's dry-media stroke engine (`paint-editor/engine.ts`), on the shared brush
 * engine:
 *
 * - Pen input: pressure, tilt (`tiltX` / `tiltY` or `altitude` / `azimuth`), barrel rotation
 *   (`twist`) and time (for velocity). Position and pressure are smoothed separately.
 * - `PenDabWalker` walks the points into dabs at `spacing × diameter`, with every pen channel
 *   interpolated, and applies the brush's dynamics, rotation mode and jitter. Jitter is a pure
 *   hash of the stroke seed and the dab index, so a stroke replays exactly.
 * - `DryStroke` rasterizes each dab with the shared round tip, multiplies it by how much of it the
 *   paper grain catches (`grainCatch`), and builds it up in the shared `CoverageMap`.
 * - Symmetry: one stroke can paint several copies of its points, each with its own walker, into
 *   the same coverage.
 */

/// One pen sample in document pixels. Every channel but x and y is optional.
public struct PenPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var pressure: Double?
    public var t: Double?
    public var tiltX: Double?
    public var tiltY: Double?
    public var altitude: Double?
    public var azimuth: Double?
    public var twist: Double?

    public init(x: Double, y: Double, pressure: Double? = nil, t: Double? = nil, tiltX: Double? = nil, tiltY: Double? = nil, altitude: Double? = nil, azimuth: Double? = nil, twist: Double? = nil) {
        self.x = x
        self.y = y
        self.pressure = pressure
        self.t = t
        self.tiltX = tiltX
        self.tiltY = tiltY
        self.altitude = altitude
        self.azimuth = azimuth
        self.twist = twist
    }

    static let keys = ["pressure", "t", "tiltX", "tiltY", "altitude", "azimuth", "twist"]

    /// A point read from JSON (finite channels only), or nil without finite x and y.
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let x = o["x"]?.finite, let y = o["y"]?.finite else { return nil }
        self.init(x: x, y: y, pressure: o["pressure"]?.finite, t: o["t"]?.finite, tiltX: o["tiltX"]?.finite, tiltY: o["tiltY"]?.finite, altitude: o["altitude"]?.finite, azimuth: o["azimuth"]?.finite, twist: o["twist"]?.finite)
    }

    public var json: JSONValue {
        var o: JSONObject = ["x": .number(x), "y": .number(y)]
        if let pressure { o["pressure"] = .number(pressure) }
        if let t { o["t"] = .number(t) }
        if let tiltX { o["tiltX"] = .number(tiltX) }
        if let tiltY { o["tiltY"] = .number(tiltY) }
        if let altitude { o["altitude"] = .number(altitude) }
        if let azimuth { o["azimuth"] = .number(azimuth) }
        if let twist { o["twist"] = .number(twist) }
        return .object(o)
    }
}

/// A pen's lean as altitude and azimuth, or nil when the sample has no tilt.
func penOrientation(_ p: PenPoint) -> (altitude: Double, azimuth: Double)? {
    if let a = p.altitude, a.isFinite {
        return (Swift.min(Double.pi / 2, Swift.max(0, a)), p.azimuth.flatMap { $0.isFinite ? $0 : nil } ?? 0)
    }
    let hasX = p.tiltX?.isFinite == true
    let hasY = p.tiltY?.isFinite == true
    if !hasX && !hasY { return nil }
    return tiltToOrientation(hasX ? p.tiltX! : 0, hasY ? p.tiltY! : 0)
}

/// Pointer Events `tiltX` / `tiltY` (degrees) → altitude and azimuth (radians).
func tiltToOrientation(_ tiltX: Double, _ tiltY: Double) -> (altitude: Double, azimuth: Double) {
    let clampT = { (v: Double) in Swift.min(89.999, Swift.max(-89.999, v)) }
    let tx = jsTan((clampT(tiltX) * Double.pi) / 180)
    let ty = jsTan((clampT(tiltY) * Double.pi) / 180)
    let r = JS.hypot(tx, ty)
    if r < 1e-9 { return (Double.pi / 2, 0) }
    var azimuth = JS.atan2(ty, tx)
    if azimuth < 0 { azimuth += 2 * Double.pi }
    return (JS.atan(1 / r), azimuth)
}

/// `Math.tan` (sin / cos of V8's kernels agree with its tan to the last bit for these inputs).
func jsTan(_ x: Double) -> Double { Foundation.tan(x) }

@inline(__always) func pressureOf(_ p: PenPoint) -> Double {
    guard let v = p.pressure, v.isFinite else { return 1 }
    return Swift.min(1, Swift.max(0, v))
}

/// Exponential smoothing of position and of pressure, each by its own amount (0..0.95).
final class PenSmoother {
    private var pos: (x: Double, y: Double)?
    private var pressure: Double?
    private let a: Double
    private let ap: Double

    init(_ position: Double, _ pressure: Double) {
        a = 1 - Swift.min(0.95, Swift.max(0, position))
        ap = 1 - Swift.min(0.95, Swift.max(0, pressure))
    }

    func push(_ p: PenPoint) -> PenPoint {
        let pr = pressureOf(p)
        guard let cur = pos else {
            pos = (p.x, p.y)
            pressure = pr
            return p
        }
        pos = (cur.x + (p.x - cur.x) * a, cur.y + (p.y - cur.y) * a)
        pressure = pressure! + (pr - pressure!) * ap
        var q = p
        q.x = pos!.x
        q.y = pos!.y
        q.pressure = pressure
        return q
    }
}

/// A linear map of document vectors `[a, b, c, d]`.
typealias Linear2 = [Double]

/// How one copy of a stroke maps the input: a point map and its linear part (for dab angles).
struct StrokeCopy: Sendable {
    let map: @Sendable (PenPoint) -> PenPoint
    let linear: Linear2
}

let IDENTITY_COPY = StrokeCopy(map: { $0 }, linear: [1, 0, 0, 1])

/// A dab with the pen state it was made at.
struct PenDab {
    var dab: Dab
    var pressure: Double
    /// Direction of travel at the dab, radians counter-clockwise with y up.
    var direction: Double
    var index: Int
    var travel: Double
    var time: Double?
    var lean: Double
    var speed: Double?
    /// Mirrored across the tip's x axis (bit 1) and y axis (bit 2), from `dynamics.flip`; 0: not mirrored.
    var flip = 0

    var params: PaintDabParams { PaintDabParams(travel: travel, index: index, pressure: pressure, lean: lean, speed: speed, direction: direction, time: time) }
}

private enum Stream {
    static let size = 1
    static let angle = 2
    static let opacity = 3
    static let scatter = 4
    static let flipX = 5
    static let flipY = 6
}

private struct Sample {
    var x: Double
    var y: Double
    var pressure: Double
    var lean: Double
    var azimuth: Double
    var twist: Double?
    var speed: Double?
    var travel: Double
    var time: Double?
}

/// Speed (px/ms) at which velocity dynamics reach their full effect.
private let FULL_SPEED = 2.5

/// Walks pen samples into dabs, incrementally (any chunking gives the same dabs).
final class PenDabWalker {
    let brush: PaintBrush
    private let seed: Int
    private let linear: Linear2
    private var last: Sample?
    private var nextAt = 0.0
    private var pendingFirst: Sample?
    private var index = 0
    private var dir = 0.0
    private var lastT: Double?
    private var firstT: Double?
    private var speed: Double?
    private var travelled = 0.0
    /// Path distance of the last dab laid (nil before the first).
    private var lastLaid: Double?

    init(_ brush: PaintBrush, _ seed: Int = 0, _ linear: Linear2 = [1, 0, 0, 1]) {
        self.brush = brush
        self.seed = seed
        self.linear = linear
    }

    private func sample(_ p: PenPoint) -> Sample {
        let o = penOrientation(p)
        var speedOut: Double? = nil
        var time: Double? = nil
        if let last { travelled += JS.hypot(p.x - last.x, p.y - last.y) }
        if let t = p.t, t.isFinite {
            if firstT == nil { firstT = t }
            time = t - firstT!
            if let last, let lastT, t > lastT {
                let v = JS.hypot(p.x - last.x, p.y - last.y) / (t - lastT)
                speed = speed == nil ? v : speed! + (v - speed!) * 0.35
            }
            lastT = t
            speedOut = speed ?? 0
        }
        return Sample(x: p.x, y: p.y, pressure: pressureOf(p), lean: o.map { 1 - $0.altitude / (Double.pi / 2) } ?? 0, azimuth: o?.azimuth ?? 0, twist: p.twist.flatMap { $0.isFinite ? $0 : nil }, speed: speedOut, travel: travelled, time: time)
    }

    private func diameter(_ s: Sample) -> Double {
        let tip = brush.tip
        let dyn = brush.dynamics
        var d = tip.size
        if tip.pressureSize { d *= dyn.minSize + (1 - dyn.minSize) * s.pressure }
        d *= 1 + dyn.tiltSize * s.lean * 1.5
        if let sp = s.speed, dyn.velocitySize != 0 { d *= Swift.max(0.05, 1 + dyn.velocitySize * Swift.min(1, sp / FULL_SPEED) * (dyn.velocitySize < 0 ? 0.85 : 1)) }
        return d
    }

    private func stepLen(_ s: Sample) -> Double {
        Swift.max(0.5, Swift.max(1, diameter(s)) * Swift.max(0.01, brush.tip.spacing))
    }

    /// A rasterizer angle (CCW, y up) mapped through this copy's linear part.
    private func mapAngle(_ theta: Double) -> Double {
        let a = linear[0], b = linear[1], c = linear[2], d = linear[3]
        if a == 1 && b == 0 && c == 0 && d == 1 { return theta }
        let vx = JS.cos(theta)
        let vy = -JS.sin(theta)
        return JS.atan2(-(c * vx + d * vy), a * vx + b * vy)
    }

    private func dab(_ s: Sample) -> PenDab {
        let tip = brush.tip, dyn = brush.dynamics, rotation = brush.rotation
        let i = index
        index += 1
        var diameter = self.diameter(s)
        if dyn.sizeJitter != 0 { diameter *= Swift.max(0.05, 1 + dyn.sizeJitter * PixerateRandom.randSigned(seed, i, Stream.size)) }
        let base = (tip.angle * Double.pi) / 180
        var angle: Double
        if rotation == "stroke" { angle = dir + base } else if rotation == "barrel", let tw = s.twist { angle = mapAngle(base - (tw * Double.pi) / 180) } else if dyn.tiltRoundness > 0 && s.lean > 0.02 { angle = mapAngle(base - s.azimuth) } else { angle = mapAngle(base) }
        if dyn.angleJitter != 0 { angle += dyn.angleJitter * Double.pi * PixerateRandom.randSigned(seed, i, Stream.angle) }
        var opacity = tip.pressureOpacity ? s.pressure : 1
        opacity *= 1 - dyn.tiltOpacity * s.lean * 0.8
        if let sp = s.speed, dyn.velocityOpacity != 0 { opacity *= Swift.max(0, 1 + dyn.velocityOpacity * (Swift.min(1, sp / FULL_SPEED) - 0.5)) }
        if dyn.opacityJitter != 0 { opacity *= 1 - dyn.opacityJitter * (PixerateRandom.randSigned(seed, i, Stream.opacity) * 0.5 + 0.5) }
        let flow = tip.flow * (1 - dyn.pressureFlow + dyn.pressureFlow * s.pressure)
        var x = s.x, y = s.y
        if dyn.scatter != 0 {
            let off = dyn.scatter * diameter * PixerateRandom.randSigned(seed, i, Stream.scatter)
            // Across the stroke: the direction of travel turned a quarter (document y points down).
            x += JS.sin(dir) * off
            y += JS.cos(dir) * off
        }
        var flip = 0
        if let f = dyn.flip, f != "none" {
            if f != "y" && PixerateRandom.rand01(seed, i, Stream.flipX) < 0.5 { flip |= 1 }
            if f != "x" && PixerateRandom.rand01(seed, i, Stream.flipY) < 0.5 { flip |= 2 }
        }
        let d = Dab(x: x, y: y, radius: Swift.max(0.5, diameter / 2), alpha: Swift.min(1, Swift.max(0, flow)), opacity: Swift.min(1, Swift.max(0, opacity)), angle: angle, roundness: Swift.min(1, Swift.max(0.01, tip.roundness * (1 - dyn.tiltRoundness * s.lean * 0.8))))
        return PenDab(dab: d, pressure: s.pressure, direction: dir, index: i, travel: s.travel, time: s.time, lean: s.lean, speed: s.speed, flip: flip)
    }

    func push(_ p: PenPoint, _ out: inout [PenDab]) {
        let a = last
        let s = sample(p)
        guard let a else {
            last = s
            pendingFirst = s
            nextAt = stepLen(s)
            return
        }
        let dx = s.x - a.x
        let dy = s.y - a.y
        let len = JS.hypot(dx, dy)
        if len > 1e-9 { dir = JS.atan2(-dy, dx) }
        if let pf = pendingFirst {
            lay(pf, &out)
            pendingFirst = nil
        }
        if len > 1e-9 {
            while nextAt <= len + 1e-9 {
                let f = Swift.min(1, nextAt / len)
                func lerp(_ u: Double, _ v: Double) -> Double { u + (v - u) * f }
                let q = Sample(
                    x: a.x + dx * f,
                    y: a.y + dy * f,
                    pressure: lerp(a.pressure, s.pressure),
                    lean: lerp(a.lean, s.lean),
                    azimuth: lerpAngle(a.azimuth, s.azimuth, f),
                    twist: a.twist != nil && s.twist != nil ? lerpDegrees(a.twist!, s.twist!, f) : s.twist,
                    speed: a.speed != nil && s.speed != nil ? lerp(a.speed!, s.speed!) : s.speed,
                    travel: a.travel + nextAt,
                    time: a.time != nil && s.time != nil ? lerp(a.time!, s.time!) : s.time
                )
                lay(q, &out)
                nextAt += stepLen(q)
            }
            nextAt -= len
        }
        last = s
    }

    func finish(_ out: inout [PenDab]) {
        if let pf = pendingFirst {
            lay(pf, &out)
            pendingFirst = nil
        }
    }

    /// The dabs of one spacing step: `dynamics.count` of them, each with its own index and so its own jitter.
    /**
     * Lays a dab at the last point fed when the path has gone at least `fraction` of a spacing
     * step past the last dab, so a stroke ends with a mark at its end. Call after `finish`.
     */
    func layEnd(_ out: inout [PenDab], _ fraction: Double = 0.5) {
        guard let s = last, let laid = lastLaid else { return }
        if s.travel - laid >= fraction * stepLen(s) - 1e-9 { lay(s, &out) }
    }

    private func lay(_ s: Sample, _ out: inout [PenDab]) {
        lastLaid = s.travel
        for _ in 0..<(brush.dynamics.count ?? 1) { out.append(dab(s)) }
    }
}

private func lerpAngle(_ a: Double, _ b: Double, _ t: Double) -> Double {
    var d = b - a
    while d > Double.pi { d -= 2 * Double.pi }
    while d < -Double.pi { d += 2 * Double.pi }
    return a + d * t
}

private func lerpDegrees(_ a: Double, _ b: Double, _ t: Double) -> Double {
    var d = b - a
    while d > 180 { d -= 360 }
    while d < -180 { d += 360 }
    return a + d * t
}

/**
 * Spray marks: the droplets of dab `d`, spread evenly over its disc, each a fraction `size` of
 * the tip (with ±40% variation) and turned at random. Seeded by the stroke `seed`, the dab's
 * index and its travel, so replays lay the same droplets.
 */
func sprayDroplets(_ d: PenDab, _ spray: SpraySettings, _ seed: Int) -> [PenDab] {
    let count = 1 + Int(JS.round(spray.density * 31))
    let key = d.index * 131 + Int(JS.round(d.travel * 8))
    var out: [PenDab] = []
    for i in 0..<count {
        let n = key * 64 + i
        let a = PixerateRandom.rand01(seed, n, 61) * Double.pi * 2
        let rr = PixerateRandom.rand01(seed, n, 67).squareRoot() * d.dab.radius
        var drop = d
        drop.dab.x = d.dab.x + JS.cos(a) * rr
        drop.dab.y = d.dab.y + JS.sin(a) * rr
        drop.dab.radius = Swift.max(0.5, d.dab.radius * spray.size * (0.6 + 0.8 * PixerateRandom.rand01(seed, n, 71)))
        drop.dab.roundness = 1
        drop.dab.angle = PixerateRandom.rand01(seed, n, 73) * Double.pi * 2
        out.append(drop)
    }
    return out
}

/// Refuses brushes whose marks this port does not draw yet (provider stickers have no art here).
struct UnportedBrushError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/**
 * One dab-engine stroke (dab and eraser brushes): smoothing, the dab walk of every copy, grain and
 * build-up in a shared coverage map.
 */
final class DryStroke {
    let coverage = CoverageMap()
    var dabCount = 0
    let brush: PaintBrush
    private let grain: PaperGrain?
    private let seed: Int
    private let smoother: PenSmoother
    private let walkers: [PenDabWalker]
    private let copies: [StrokeCopy]
    private let depth: Double
    private var buf: [Float] = []
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?
    /// Effect paint: each pixel's colour (and alpha) from these pixels.
    private let effect: EffectPaintPixels?
    private var field: [Float] = []
    private var limits: [Float] = []
    /// The stamp tip's shape, or nil for the round computed tip.
    private let stamp: StampSampler?
    /// The tip's own grain, or nil.
    private let tipGrain: TipGrain?
    /// Thin-film coat buffer (deposit for iridescent brushes, erase for erasers).
    var film: FilmBuffer? = nil

    /// `stampArt`: the art of image sources (stamp tips and tip grain); without it such a tip paints round, and the grain is left out.
    init(_ brush: PaintBrush, grain: PaperGrain?, paperDepth: Double, seed: Int, copies: [StrokeCopy], effect: EffectPaintPixels? = nil, stampArt: StampArtLookup? = nil) {
        self.brush = brush
        self.effect = effect
        stamp = brush.stamp.flatMap { stampSampler($0, stampArt, brush.tip.hardness) }
        tipGrain = TipGrain.create(brush.tipGrain, stampArt)
        self.grain = grain
        self.seed = seed
        smoother = PenSmoother(brush.tip.smoothing, brush.pressureSmoothing)
        self.copies = copies.isEmpty ? [IDENTITY_COPY] : copies
        walkers = self.copies.enumerated().map { i, c in PenDabWalker(brush, Int(Int32(truncatingIfNeeded: seed + i * 7919)), c.linear) }
        depth = grain != nil && !grain!.flat ? Swift.min(1, Swift.max(0, paperDepth * brush.grain)) : 0
    }

    /// Feeds raw pen samples; returns the document rectangles the new dabs touched.
    func push(_ points: [PenPoint]) -> [RasterRect] {
        var dabs: [PenDab] = []
        for raw in points {
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (i, c) in copies.enumerated() { walkers[i].push(c.map(p), &dabs) }
        }
        return paint(dabs)
    }

    /// Ends the stroke: the smoothed path catches up with the last raw sample; a single tap paints one dab.
    func finish() -> [RasterRect] {
        var dabs: [PenDab] = []
        if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
            var q = raw
            q.pressure = fed.pressure
            for (i, c) in copies.enumerated() { walkers[i].push(c.map(q), &dabs) }
        }
        for w in walkers { w.finish(&dabs) }
        return paint(dabs)
    }

    private func paint(_ dabs: [PenDab]) -> [RasterRect] {
        var rects: [RasterRect] = []
        for d in dabs {
            guard let spray = brush.spray else {
                mark(d.dab, d, &rects)
                continue
            }
            // Spray: droplets spread evenly over the tip's disc (seeded per dab, so replays match).
            for drop in sprayDroplets(d, spray, seed) { mark(drop.dab, d, &rects) }
        }
        return rects
    }

    /// Lays one mark (a dab, or a spray droplet of dab `d`): the round tip or the stamp, the tip grain, the paper grain, effect paint.
    private func mark(_ m: Dab, _ d: PenDab, _ rects: inout [RasterRect]) {
        let hardness = brush.tip.hardness
        let rect = stamp != nil ? stampDabRect(m) : dabRect(m, hardness)
        let n = rect.width * rect.height
        if buf.count < n { buf = [Float](repeating: 0, count: n) }
        if let stamp { rasterizeStampDab(m, d.flip, stamp, d.index, rect, &buf) } else { rasterizeDab(m, hardness, rect, &buf) }
        // The tip's grain turns with the mark (a spray droplet's own angle) and rolls with the dab's travel.
        tipGrain?.apply(&buf, rect, x: m.x, y: m.y, angle: m.angle, travel: d.travel)
        if depth > 0, let grain {
            var k = 0
            for yy in 0..<rect.height {
                let y = Double(rect.y + yy) + 0.5
                for xx in 0..<rect.width {
                    if buf[k] > 0 { buf[k] = Float(Double(buf[k]) * grainCatch(grain.at(Double(rect.x + xx) + 0.5, y), depth, d.pressure)) }
                    k += 1
                }
            }
        }
        var fieldArg: [Float]? = nil
        var limitsArg: [Float]? = nil
        if let effect {
            if field.count < n * 3 { field = [Float](repeating: 0, count: n * 3) }
            if limits.count < n { limits = [Float](repeating: 0, count: n) }
            limits.withUnsafeMutableBufferPointer { l in
                sampleEffectField(effect, rect, &buf, &field, EffectDabPlace(d), limits: l.baseAddress)
            }
            fieldArg = field
            limitsArg = limits
        }
        coverage.accumulate(rect, buf, m.opacity, field: fieldArg, limits: limitsArg)
        if let film {
            if brush.engine == "eraser" {
                film.erase(rect, buf, m.opacity * brush.tip.opacity)
            } else if let ir = brush.iridescence {
                film.deposit(rect, buf, m.opacity * brush.tip.opacity, d.pressure, ir)
            }
        }
        rects.append(rect)
        dabCount += 1
    }
}
