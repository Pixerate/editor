import Foundation
import PixerateCore
import PixerateRaster

/**
 * Wet media in the paint editor (`paint-editor/wet.ts`): a layer painted with a wet brush gets a
 * wet layer in the document's `WetWorld`, and its pixels are the world's display of it until the
 * paint dries.
 *
 * - **Wet brushes** (`engine: "wet"`) run through `WetStrokeDriver`: the same pen input as dry
 *   media, each dab's tip coverage (quantised to 1/4096) applied by the brush's wet tool. `paint`
 *   goes through the shared pick-up / mix exchange over a `WetMedium`.
 * - **Time** is the world's step clock. A host calls `tick` every frame; it steps at `speed` steps
 *   per second unless paused. Agents call `advance` or `dry`.
 * - **Drying.** Tiles that have dried are baked into the layer's pixels by the world; when a whole
 *   layer is dry its wet layer is dropped. Saving and exporting use the deterministic bake of
 *   everything still wet.
 * - **Undo.** Each wet step of history keeps a snapshot of the world before and after it, within
 *   `undoMemory` bytes; older snapshots are dropped, and undoing past them leaves that paint dry.
 *
 * The CPU engine (the TS core's TypeScript kernel) is the authority. With `gpu: "auto"`, Metal
 * shades the display once at least `gpuMinTiles` tiles are wet (`WetMetal.swift`), as WebGPU does
 * on the web; there is no WebAssembly engine, and the GPU never steps (see `WetMetalEngine`).
 */

/// Water depth a stroke lays at the tip's centre at `water` 1.
private let STROKE_WATER = 0.9
/// Pigment mass a stroke lays at the tip's centre at `pigment` 1.
private let STROKE_MASS = PIGMENT_UNIT * 2.5
/// Light paint mass a stroke lays at the tip's centre at `light.amount` 1.
private let STROKE_LIGHT = 1.5
/// Coverage quantum.
private let COVERAGE_STEPS = 4096.0

/// The paper as the wet simulation reads it.
func wetPaperInput(_ paper: PaperSettings) -> WetPaperInput {
    let grain = PaperGrain(paper, media: "wet")
    let flat = grain.flat
    return WetPaperInput(absorption: paper.absorption, permeability: paper.permeability, roughness: flat ? 0 : paper.roughness, color: hexToRgb8(paper.color), heightAt: flat ? { _, _ in 0.5 } : { x, y in grain.at(x, y) })
}

/// The effect's colour at one point into `out` (unchanged off the effect), and its alpha (`sampleEffectAt` in TS).
private func sampleEffectInto(_ img: EffectPaintPixels, _ x: Double, _ y: Double, _ out: inout [Double], _ d: PenDab) -> Double {
    if img.map == nil {
        let px = Int(JS.floor(x)), py = Int(JS.floor(y))
        if px < 0 || py < 0 || px >= img.width || py >= img.height { return 0 }
    }
    let e = sampleEffectAt(img, x, y, EffectDabPlace(d))
    out = e.rgb
    return e.alpha
}

/// Effect paint per pixel, shifted by what the brush picks up (`effectDabField`): writes `field` and scales `cov` by the effect's alpha.
func effectDabField(_ img: EffectPaintPixels, _ rect: RasterRect, _ cov: inout [Float], _ centre: [Double], _ mixed: [Double], _ field: inout [Float], _ steps: Double, _ d: PenDab?) {
    sampleEffectField(img, rect, &cov, &field, d.map(EffectDabPlace.init))
    let d0 = mixed[0] - centre[0], d1 = mixed[1] - centre[1], d2 = mixed[2] - centre[2]
    for k in 0..<(rect.width * rect.height) {
        if steps > 0 { cov[k] = Float(JS.round(Double(cov[k]) * steps) / steps) }
        let f = k * 3
        field[f] = Float(Swift.min(1, Swift.max(0, Double(field[f]) + d0)))
        field[f + 1] = Float(Swift.min(1, Swift.max(0, Double(field[f + 1]) + d1)))
        field[f + 2] = Float(Swift.min(1, Swift.max(0, Double(field[f + 2]) + d2)))
    }
}

struct WetStrokeInit {
    var world: WetWorld
    var laneId: String
    var brush: PaintBrush
    /// Paint colour, sRGB 0..1.
    var color: [Double]
    var load: MixerLoad
    var grain: PaperGrain?
    var paperDepth: Double
    var paperColor: [Int]
    var seed: Int
    var copies: [StrokeCopy]
    /// Where paint may land (the stencils' mask), or none.
    var mask: PaintSelection?
    var paint: PaintGradientSource?
    var effect: EffectPaintPixels?
    var film: FilmBuffer? = nil
    var speed: Double?
}

private final class WetCopyState {
    let walker: PenDabWalker
    let exchange: PaintExchange?
    var last: PenDab?
    init(walker: PenDabWalker, exchange: PaintExchange?) {
        self.walker = walker
        self.exchange = exchange
    }
}

/// One wet-brush stroke: pen samples → dabs → wet tool edits.
final class WetStrokeDriver {
    var dabCount = 0
    var bounds: RasterRect?
    var vortexSummary: VortexStrokeSummary? = nil
    /// The world's clock at which each raw point was applied (recorded with the stroke).
    private(set) var steps: [Int] = []
    let initValues: WetStrokeInit
    private let smoother: PenSmoother
    private let states: [WetCopyState]
    private let medium: WetMedium
    private let copies: [StrokeCopy]
    private var vortexPoints: [PenPoint] = []
    private let depth: Double
    private let lightBase: Double
    private let sampler: PaintGradientSampler?
    private var paintColor = [0.0, 0.0, 0.0]
    private var centre = [0.0, 0.0, 0.0]
    private var lastRaw: PenPoint?
    private var lastFed: PenPoint?
    private(set) var done = false

    init(_ i: WetStrokeInit) {
        initValues = i
        let brush = i.brush
        smoother = PenSmoother(brush.tip.smoothing, brush.pressureSmoothing)
        copies = i.copies.isEmpty ? [IDENTITY_COPY] : i.copies
        let wet = brush.wet
        let vortex = brushVortex(brush)
        let vortexHasInk = wet.tool == "vortex" && vortex.ink > 0
        let spacing = Swift.max(0.02, brush.tip.spacing)
        let perDab = Swift.min(1, spacing * 1.2)
        let thin = wet.thinner
        let body = wet.body * (1 - thin)
        let pigRate = wet.tool == "vortex" ? Swift.max(wet.pigment, vortex.ink) * vortex.ink : wet.pigment
        medium = WetMedium(i.world, i.laneId, WetMedium.Options(
            water: STROKE_WATER * Swift.min(1, wet.water * (1 + thin)) * perDab,
            mass: STROKE_MASS * pigRate * (1 - 0.6 * thin) * perDab,
            body: body,
            light: 0
        ))
        if (wet.tool == "paint" || vortexHasInk), let ghost = brush.ghost, pigRate > 0 {
            let one = pigmentOf(i.color, body)
            try? i.world.startGhost(i.laneId, pigment: one, linger: ghost.linger, stepsPerSecond: i.speed ?? 120, trigger: ghost.trigger ?? "immediate")
        }
        lightBase = (wet.tool == "paint" || vortexHasInk) ? STROKE_LIGHT * brush.light.amount * (1 - 0.6 * thin) * perDab : 0
        let rates = exchangeRates(brush.behavior.pickup, brush.behavior.mix, wet.load, brush.behavior.mixing)
        states = copies.enumerated().map { k, c in
            WetCopyState(walker: PenDabWalker(brush, Int(Int32(truncatingIfNeeded: i.seed + k * 7919)), c.linear), exchange: (wet.tool == "paint" || vortexHasInk) ? PaintExchange(rates, i.load) : nil)
        }
        depth = i.grain != nil && !i.grain!.flat ? Swift.min(1, Swift.max(0, i.paperDepth * brush.grain)) : 0
        if var g = i.paint {
            // Across the tip makes no sense for one wet dab: the colour follows the dab instead.
            if g.map.by == "across-tip" { g.map = PaintGradientMapping(by: "distance", length: 300, repeat: "mirror") }
            sampler = PaintGradientSampler(g, seed: i.seed)
        } else {
            sampler = nil
        }
    }

    /// What copy 0's brush carries after the dabs so far.
    var load: MixerLoad? { states[0].exchange?.load }

    /// Adds raw points and applies them. Returns where pixels changed.
    func push(_ points: [PenPoint]) throws -> [RasterRect] {
        var rects: [RasterRect] = []
        if done { return rects }
        if initValues.brush.wet.tool == "vortex" {
            for raw in points {
                steps.append(initValues.world.clock)
                vortexPoints.append(raw)
            }
            return rects
        }
        for raw in points {
            steps.append(initValues.world.clock)
            lastRaw = raw
            let p = smoother.push(raw)
            lastFed = p
            for (k, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                states[k].walker.push(c.map(p), &dabs)
                try applyDabs(k, dabs, &rects)
            }
        }
        for r in rects { bounds = unionRect(bounds, r) }
        return rects
    }

    /// Ends the stroke.
    func finish() throws -> [RasterRect] {
        var rects: [RasterRect] = []
        if done { return rects }
        if initValues.brush.wet.tool == "vortex" {
            try applyVortex(&rects)
            done = true
            for r in rects { bounds = unionRect(bounds, r) }
            return rects
        }
        for (k, c) in copies.enumerated() {
            var dabs: [PenDab] = []
            if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                var q = raw
                q.pressure = fed.pressure
                states[k].walker.push(c.map(q), &dabs)
            }
            states[k].walker.finish(&dabs)
            try applyDabs(k, dabs, &rects)
        }
        done = true
        for r in rects { bounds = unionRect(bounds, r) }
        return rects
    }

    private func applyVortex(_ rects: inout [RasterRect]) throws {
        let world = initValues.world
        let laneId = initValues.laneId
        let brush = initValues.brush
        let mask = initValues.mask
        let vortex = brushVortex(brush)
        if vortexPoints.isEmpty {
            vortexSummary = VortexStrokeSummary(shape: "point", maxDisplacement: 0)
            return
        }
        if vortex.ink > 0 {
            for raw in vortexPoints {
                lastRaw = raw
                let p = smoother.push(raw)
                lastFed = p
                for (k, c) in copies.enumerated() {
                    var dabs: [PenDab] = []
                    states[k].walker.push(c.map(p), &dabs)
                    try applyDabs(k, dabs, &rects)
                }
            }
            for (k, c) in copies.enumerated() {
                var dabs: [PenDab] = []
                if let raw = lastRaw, let fed = lastFed, raw.x != fed.x || raw.y != fed.y {
                    var q = raw
                    q.pressure = fed.pressure
                    states[k].walker.push(c.map(q), &dabs)
                }
                states[k].walker.finish(&dabs)
                try applyDabs(k, dabs, &rects)
            }
        }

        let primaryClass = classifyVortexShape(
            vortexPoints,
            brush.tip.size,
            brush.tip.smoothing,
            brush.pressureSmoothing
        )
        let speedScale = Swift.min(
            0.1,
            Swift.max(0.03, (0.045 + 0.015 * vortex.turns) * Swift.max(0.3, brush.wet.strength))
        )
        let rewetAmount = Swift.max(0.2, brush.wet.rewet * 0.45)

        var anySwirled = false
        // What the swirl itself moved wet paint by at once (px), not the dry vortex's integrated warp:
        // the water keeps turning after that under the layer's fading swirl.
        var maxDisplacement = 0.0
        for copy in copies {
            let mapped = vortexPoints.map { copy.map($0) }
            let spinSign = resolveVortexSpinSign(vortex.direction, primaryClass.shape, primaryClass.signedArea, copy)
            let (velocity, _) = buildVortexVelocityField(mapped, brush, spinSignOverride: spinSign)
            if velocity.maxSpeed <= 1e-5 { continue }
            let k = speedScale / velocity.maxSpeed
            var vx = [Float](repeating: 0, count: velocity.vx.count)
            var vy = [Float](repeating: 0, count: velocity.vy.count)
            for r in 0..<velocity.rows {
                let gy = Double(velocity.rect.y + r * velocity.step)
                for c in 0..<velocity.cols {
                    let gx = Double(velocity.rect.x + c * velocity.step)
                    let idx = r * velocity.cols + c
                    var m = 1.0
                    if let mask {
                        let mx = Int(JS.round(gx))
                        let my = Int(JS.round(gy))
                        m = (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height)
                            ? Double(mask.data[my * mask.width + mx]) / 255.0
                            : 0.0
                    }
                    vx[idx] = Float(Double(velocity.vx[idx]) * k * m)
                    vy[idx] = Float(Double(velocity.vy[idx]) * k * m)
                }
            }
            let clipX0 = Swift.max(0, velocity.rect.x)
            let clipY0 = Swift.max(0, velocity.rect.y)
            let clipX1 = Swift.min(world.width, velocity.rect.x + velocity.rect.width)
            let clipY1 = Swift.min(world.height, velocity.rect.y + velocity.rect.height)
            if clipX1 <= clipX0 || clipY1 <= clipY0 { continue }
            let clipRect = RasterRect(x: clipX0, y: clipY0, width: clipX1 - clipX0, height: clipY1 - clipY0)
            let gridField = VelocityGridField(rect: velocity.rect, step: velocity.step, cols: velocity.cols, rows: velocity.rows, vx: vx, vy: vy, maxSpeed: speedScale)
            let shift = try world.swirl(laneId, clipRect, gridField, rewetAmount: rewetAmount)
            if shift > maxDisplacement { maxDisplacement = shift }
            rects.append(clipRect)
            anySwirled = true
        }

        let hasWetOrInk = try (vortex.ink > 0 || world.stats(laneId).wetCells > 0)
        if anySwirled && hasWetOrInk {
            dabCount = Swift.max(1, vortexPoints.count)
            vortexSummary = VortexStrokeSummary(shape: primaryClass.shape, maxDisplacement: JS.round(maxDisplacement * 100) / 100)
        } else {
            vortexSummary = VortexStrokeSummary(shape: primaryClass.shape, maxDisplacement: 0)
        }
    }

    private func applyDabs(_ copy: Int, _ dabs: [PenDab], _ rects: inout [RasterRect]) throws {
        for d in dabs {
            let rect = dabRect(d.dab, initValues.brush.tip.hardness)
            if rect.width <= 0 || rect.height <= 0 { continue }
            try dab(copy, d, rect)
            rects.append(rect)
            dabCount += 1
        }
    }

    /// The tip's coverage over `rect`, with the grain, quantised.
    private func coverage(_ d: PenDab, _ rect: RasterRect) -> (tip: [Float], cov: [Float]) {
        let n = rect.width * rect.height
        var tip = [Float](repeating: 0, count: n)
        var cov = [Float](repeating: 0, count: n)
        var flat = d.dab
        flat.alpha = 1
        rasterizeDab(flat, initValues.brush.tip.hardness, rect, &tip)
        let grain = depth > 0 ? initValues.grain : nil
        let mask = initValues.mask
        let dVal = depth
        let pr = d.pressure
        let rx = rect.x, ry = rect.y, rw = rect.width, rh = rect.height
        tip.withUnsafeMutableBufferPointer { tipBuf in
            cov.withUnsafeMutableBufferPointer { covBuf in
                guard let tipPtr = tipBuf.baseAddress, let covPtr = covBuf.baseAddress else { return }
                var k = 0
                for yy in 0..<rh {
                    for xx in 0..<rw {
                        var t = Double(tipPtr[k])
                        if t > 0 {
                            if let mask {
                                let mx = rx + xx, my = ry + yy
                                let m = mx >= 0 && my >= 0 && mx < mask.width && my < mask.height ? Double(mask.data[my * mask.width + mx]) / 255 : 0
                                t *= m
                            }
                            var v = t
                            if v > 0, let grain { v *= grainCatch(grain.at(Double(rx + xx) + 0.5, Double(ry + yy) + 0.5), dVal, pr) }
                            tipPtr[k] = Float(JS.round(t * COVERAGE_STEPS) / COVERAGE_STEPS)
                            covPtr[k] = Float(JS.round(v * COVERAGE_STEPS) / COVERAGE_STEPS)
                        }
                        k += 1
                    }
                }
            }
        }
        return (tip, cov)
    }

    private func dab(_ copy: Int, _ d: PenDab, _ rect: RasterRect) throws {
        let world = initValues.world, laneId = initValues.laneId, brush = initValues.brush
        let wet = brush.wet
        let st = states[copy]
        let (tip, cov) = coverage(d, rect)
        // How hard this dab works: flow, pressure (pressureOpacity) and the tip's opacity.
        let k = JS.round(Swift.min(1, d.dab.alpha * d.dab.opacity * brush.tip.opacity) * COVERAGE_STEPS) / COVERAGE_STEPS
        if !(k > 0) { return }
        switch wet.tool {
        case "paint", "vortex":
            if let ghost = brush.ghost {
                let smear = ghost.smear
                if wet.pigment > 0 {
                    medium.options.light = medium.options.mass
                    try medium.deposit(rect, cov, k, initValues.color)
                } else {
                    medium.options.light = 0
                    try world.paint(laneId, rect, cov, water: medium.options.water * k * (wet.water > 0 ? 1 : 0), pigment: nil)
                }
                if smear > 0 {
                    let rw = Swift.max(wet.rewet, 0.6) * smear
                    if rw > 0 { try world.rewet(laneId, rect, cov, amount: rw * k * 0.5, paper: initValues.paperColor, suspend: true) }
                    if let last = st.last { try world.drag(laneId, rect, tip, dx: d.dab.x - last.dab.x, dy: d.dab.y - last.dab.y, strength: smear * k) }
                }
                break
            }
            let ex = st.exchange!
            medium.options.light = lightBase * (brush.light.pressure ? d.pressure : 1)
            var flow = 1.0
            let effect = initValues.effect
            if let effect {
                _ = sampleEffectInto(effect, d.dab.x, d.dab.y, &centre, d)
                ex.setReservoirColor(centre[0], centre[1], centre[2])
            } else if let sampler {
                let g = sampler.dab(d.params)
                ex.setReservoirColor(g.rgb[0], g.rgb[1], g.rgb[2])
                flow = g.alpha
            }
            ex.pickUp(try medium.sample(rect, tip))
            let total = ex.paint(&paintColor)
            if total > 0 && flow > 0, let effect {
                var ec = cov
                var field = [Float](repeating: 0, count: ec.count * 3)
                effectDabField(effect, rect, &ec, centre, paintColor, &field, COVERAGE_STEPS, d)
                try medium.deposit(rect, ec, Swift.min(1, total) * k, paintColor, field: field)
            } else if total > 0 && flow > 0 {
                try medium.deposit(rect, cov, Swift.min(1, total) * k * flow, paintColor)
            } else {
                try world.paint(laneId, rect, cov, water: medium.options.water * k, pigment: nil)
            }
            ex.drain()
            if let film = initValues.film, let ir = brush.iridescence, total > 0 && flow > 0 {
                film.deposit(rect, cov, Swift.min(1, total) * k * flow, d.pressure, ir)
            }
            if wet.rewet > 0 { try world.rewet(laneId, rect, cov, amount: wet.rewet * k * 0.15, paper: initValues.paperColor) }
            if let lp = brush.livePatterns {
                let dabSeed = Int(Int32(truncatingIfNeeded: initValues.seed &+ dabCount &* 131 &+ copy &* 997))
                _ = try world.seedLivePatterns(
                    laneId,
                    d.dab.x,
                    d.dab.y,
                    Swift.max(2, d.dab.radius),
                    dabSeed,
                    Swift.max(0.65, d.pressure),
                    lp
                )
            }
        case "water":
            try world.paint(laneId, rect, cov, water: medium.options.water * k * (wet.water > 0 ? 1 : 0), pigment: nil)
            if wet.rewet > 0 { try world.rewet(laneId, rect, cov, amount: wet.rewet * k * 0.15, paper: initValues.paperColor) }
        case "dry":
            try world.remove(laneId, rect, cov, water: wet.strength * 0.35 * k, suspended: 0, settled: 0, paperWater: wet.strength * 0.35 * k)
        case "blow":
            // Along the direction of travel (dab directions are counter-clockwise with y up).
            let s = wet.strength * 0.08 * k
            try world.push(laneId, rect, cov, ux: JS.cos(d.direction) * s, uy: -JS.sin(d.direction) * s)
        case "blend":
            try world.blend(laneId, rect, cov, strength: wet.strength * k)
        case "smudge":
            if let last = st.last { try world.drag(laneId, rect, cov, dx: d.dab.x - last.dab.x, dy: d.dab.y - last.dab.y, strength: wet.strength * k) }
        case "blot":
            try world.remove(laneId, rect, cov, water: wet.strength * 0.8 * k, suspended: wet.strength * 0.6 * k, settled: wet.strength * 0.15 * k, paperWater: wet.strength * 0.5 * k)
        default:
            break
        }
        st.last = d
    }
}

/// The wet settings each medium gives a layer the first time it holds wet paint.
let WET_MEDIUM_PARAMS: [String: JSONObject] = [
    "watercolor": [:],
    "gouache": ["viscosity": 0.45, "evaporation": 0.1, "edgeDarkening": 0.15, "granulation": 0.1, "bloom": 0.1, "bleed": 0.15, "pickup": 0.5, "pigmentWeight": 0.5],
    "oil": ["viscosity": 0.95, "evaporation": 0.03, "edgeDarkening": 0, "granulation": 0, "bloom": 0, "bleed": 0.08, "pickup": 0.6, "fixture": 0.02, "pigmentWeight": 0.8],
]

/// Settings of one wet layer (saved with the document).
public struct WetLayerSettings: Equatable {
    public var params: WetParams
    public var flow: WetFlowSpec
    public var livePatterns: LivePatternsSettings? = nil
    public var ghost: WetGhostState? = nil
}

/// One wet layer as tools describe it.
public struct WetLayerInfo {
    public var layerId: String
    public var wet: Bool
    public var wetCells: Int
    public var wetBounds: RasterRect?
    public var activeTiles: Int
    public var params: WetParams
    public var flow: WetFlowSpec
    public var livePatterns: LivePatternsSettings? = nil
    public var ghostRemaining: Double? = nil

    public var json: JSONValue {
        var o: JSONObject = ["layerId": .string(layerId), "wet": .bool(wet), "wetCells": .number(Double(wetCells)), "wetBounds": rectJSON(wetBounds), "activeTiles": .number(Double(activeTiles)), "params": params.json, "flow": flow.json, "livePatterns": livePatterns?.json ?? .null]
        if let ghostRemaining { o["ghost"] = ["remaining": .number(ghostRemaining)] }
        return .object(o)
    }
}

/// An event recorded with the clock it happened at, for replays.
public struct WetEvent: Equatable {
    public var clock: Int
    /// How many strokes were recorded before it.
    public var at: Int?
    public var kind: String
    public var layerId: String?
    public var data: JSONValue?
    /// The object a saved event was read from: TS keeps saved events verbatim (fields this struct
    /// does not model, an `at` that is not an integer), so it is written back with only the fields
    /// changed since (a canvas resize moving `data`) set over it, as `{ ...e, data }` does.
    var saved: JSONObject?
    /// Which event object this is (the TS core tells logged events apart by object identity: a scheme replay's log).
    var key = newStrokeKey()

    /// Equal when they save the same (a saved event equals one built with the same fields and nothing else).
    public static func == (a: WetEvent, b: WetEvent) -> Bool { a.json == b.json }

    /// Where a replay puts it among the strokes (`event.at ?? 0`, used as a number): a saved `at`
    /// that is not an integer (1.5, `"2"`) keeps its own value, as the TS replay reads it.
    var replayAt: Double {
        if let saved, let base = WetEvent(json: .object(saved)), base.at == at {
            guard let raw = saved["at"], raw != .null else { return 0 }
            return jsToNumber(raw)
        }
        return Double(at ?? 0)
    }

    public var json: JSONValue {
        if let saved, let base = WetEvent(json: .object(saved)) {
            var o = saved
            if clock != base.clock { o["clock"] = .number(Double(clock)) }
            if at != base.at { o["at"] = at.map { .number(Double($0)) } ?? Optional<JSONValue>.none }
            if kind != base.kind { o["kind"] = .string(kind) }
            if layerId != base.layerId { o["layerId"] = layerId.map { .string($0) } ?? Optional<JSONValue>.none }
            if data != base.data { o["data"] = data ?? Optional<JSONValue>.none }
            return .object(o)
        }
        var o: JSONObject = ["clock": .number(Double(clock))]
        if let at { o["at"] = .number(Double(at)) }
        o["kind"] = .string(kind)
        if let layerId { o["layerId"] = .string(layerId) }
        if let data { o["data"] = data }
        return .object(o)
    }
}

/// `Number.isInteger(v)` as an `Int` (nil for anything else, or past what `Int` holds).
func savedInteger(_ v: JSONValue?) -> Int? {
    guard let n = v?.finite, n.rounded(.towardZero) == n else { return nil }
    return Int(exactly: n)
}

/// `Number.isInteger(v)` as an `Int`, clamped to what `Int` holds (nil for anything else): a saved
/// event with a huge integer still loads, as in TS, and is written back verbatim.
func savedWholeNumber(_ v: JSONValue?) -> Int? {
    guard let n = v?.finite, n.rounded(.towardZero) == n else { return nil }
    return Int(exactly: n) ?? (n > 0 ? Int.max : Int.min)
}

extension WetEvent {
    /// A saved wet event as `readDocument` keeps it: an integer `clock` and a string `kind`; nil otherwise.
    public init?(json raw: JSONValue) {
        guard let r = raw.objectValue, let clock = savedWholeNumber(r["clock"]), let kind = r["kind"]?.stringValue else { return nil }
        self.init(clock: clock, at: savedInteger(r["at"]), kind: kind, layerId: r["layerId"]?.stringValue, data: r["data"])
        saved = r
    }
}

/// Engine B as panels and tools show it. This port has no GPU engine: `auto` stays `not-started`.
public struct WetEngineInfo {
    public var mode: String
    public var state: String
    public var reason: String?
    public var adapter: String?
    public var maxTiles: Int
    public var minTiles: Int
    public var activeTiles: Int
    public var cpu: WetBackendInfo?

    public var json: JSONValue {
        ["mode": .string(mode), "adapter": adapter.map { .string($0) } ?? .null, "maxTiles": .number(Double(maxTiles)), "minTiles": .number(Double(minTiles)), "activeTiles": .number(Double(activeTiles)), "cpu": cpu?.json ?? .null, "state": .string(state), "reason": reason.map { .string($0) } ?? .null]
    }
}

public let WET_GPU_MODES = ["auto", "off"]

/// Tiles reshaded per frame at most (the rest catch up over the next frames).
let DISPLAY_TILES_PER_TICK = 24

/// What the wet layers need from their editor.
struct PaintWetHost {
    var canvas: () -> PaintCanvas
    var paper: () -> PaperSettings
    /// The layer's current pixels (nil when it is not a pixel layer).
    var layerSurface: (String) -> TiledSurface?
    /// Shows new pixels for wet layers (not an undo step).
    var updateSurfaces: (OrderedMap<String, TiledSurface>, [RasterRect]) -> Void
    /// The layer's light paint, or nil.
    var layerLight: (String) -> TiledSurface?
    /// Shows new light paint for wet layers (not an undo step).
    var updateLights: (OrderedMap<String, TiledSurface>) -> Void
    /// The layer's thick height map (one channel), or nil.
    var layerHeight: ((String) -> TiledSurface?)? = nil
    /// Shows new thick height maps for wet layers with live pattern relief (not an undo step).
    var updateHeights: ((OrderedMap<String, TiledSurface>) -> Void)? = nil
    /// The paint dried while time passed.
    var changed: () -> Void
}

/// Wet-media options of an editor (`PaintWetOptions`): only the CPU engine exists here.
public struct PaintWetOptions: Sendable {
    /// Steps per second while time runs (default 120).
    public var speed: Double?
    /// Bytes of wet snapshots kept for undo (default 512 MB).
    public var undoMemory: Int?
    /// `auto` (default) or `off`: whether a GPU engine may run (this port has none, so the CPU always does).
    public var gpu: String?
    /// Live 256 px tiles at which a GPU would take over (default 16).
    public var gpuMinTiles: Int?
    public init(speed: Double? = nil, undoMemory: Int? = nil, gpu: String? = nil, gpuMinTiles: Int? = nil) {
        self.speed = speed
        self.undoMemory = undoMemory
        self.gpu = gpu
        self.gpuMinTiles = gpuMinTiles
    }
}

/// The paint editor's wet layers (`PaintWetLayers`): one `WetWorld` per canvas, its settings and time.
public final class PaintWetLayers {
    public private(set) var world: WetWorld?
    public internal(set) var tilt = FLAT_TILT
    var settings = OrderedMap<String, WetLayerSettings>()
    var patterns = OrderedMap<String, LivePatternField>()
    public internal(set) var paused = false
    /// Wet strokes dry as soon as they end.
    public internal(set) var instantDry = false
    public internal(set) var speed: Double
    public internal(set) var overlay = false
    public let undoMemory: Int
    /// The live wet stroke, if any.
    var driver: WetStrokeDriver?
    private var lastTick: Double?
    private var stepsOwed = 0.0
    public internal(set) var gpuMode = "auto"
    public internal(set) var gpuMinTiles = 16
    private var gpu: WetMetalEngine?
    private var gpuSupport: WetGpuSupport?
    private let host: PaintWetHost

    init(_ host: PaintWetHost, _ options: PaintWetOptions = PaintWetOptions()) {
        self.host = host
        speed = Swift.max(1, Swift.min(2000, options.speed ?? 120))
        undoMemory = Swift.max(0, options.undoMemory ?? 512 * 1024 * 1024)
        gpuMode = options.gpu == "off" ? "off" : "auto"
        gpuMinTiles = Swift.max(1, options.gpuMinTiles ?? 16)
    }

    // MARK: Metal shading

    /// Starts the GPU engine for `world` (once; it may turn out unavailable).
    private func startGpu(_ world: WetWorld) {
        if gpuMode == "off" || gpu != nil || gpuSupport != nil { return }
        let (engine, support) = WetMetalEngine.shared()
        gpuSupport = support
        guard let engine else { return }
        gpu = engine
        world.gpuMinTiles = gpuMinTiles
        world.attachGpu(engine)
    }

    /// `auto`: use the GPU for large wet areas when there is one; `off`: the CPU only.
    func setGpu(_ mode: String, minTiles: Int?) -> WetEngineInfo {
        if let minTiles {
            gpuMinTiles = Swift.max(1, minTiles)
            world?.gpuMinTiles = gpuMinTiles
        }
        if mode == gpuMode { return engineInfo() }
        gpuMode = mode
        if mode == "off" {
            world?.attachGpu(nil)
            gpu = nil
            gpuSupport = nil
        } else if let world {
            startGpu(world)
        }
        return engineInfo()
    }

    public func engineInfo() -> WetEngineInfo {
        let w = world
        var out = WetEngineInfo(mode: gpuMode, state: "off", reason: nil, adapter: gpuSupport?.adapter, maxTiles: gpuSupport?.maxSlots ?? 0, minTiles: gpuMinTiles, activeTiles: w?.activeTiles() ?? 0, cpu: backend())
        if gpuMode == "off" {
            out.reason = "Forced to the CPU."
        } else if let error = w?.gpuError {
            out.state = "failed"
            out.reason = error
        } else if let s = gpuSupport, !s.supported {
            out.state = "unavailable"
            out.reason = s.reason
        } else if gpu == nil {
            out.state = "not-started"
            out.reason = "Starts with the first wet stroke."
        } else if w?.gpuActive == true {
            out.state = "active"
        } else {
            out.state = "standby"
            out.reason = "The GPU takes over at \(gpuMinTiles) wet tiles (256 px)."
        }
        return out
    }

    /// The world (made on first use, at the canvas size).
    func ensureWorld() throws -> WetWorld {
        let c = host.canvas()
        if let w = world, w.width != c.width || w.height != c.height {
            if !w.laneIds().isEmpty { throw PaintEditorError("The wet world is the wrong size; dry the paint before resizing the canvas.") }
            dropWorld()
        }
        if world == nil { world = try makeWorld(c.width, c.height, host.paper()) }
        return world!
    }

    private func makeWorld(_ width: Int, _ height: Int, _ paper: PaperSettings) throws -> WetWorld {
        let w = try WetWorld(width: width, height: height, paper: wetPaperInput(paper))
        _ = w.setTilt(tilt)
        w.gpuMinTiles = gpuMinTiles
        if let gpu { w.attachGpu(gpu) } else { startGpu(w) }
        return w
    }

    /// Whether `extend` can keep the wet paint when the canvas grows by `left` / `top`.
    func canExtend(_ left: Int, _ top: Int) -> Bool { left % WET_TILE == 0 && top % WET_TILE == 0 && driver == nil }

    /// Keeps the wet paint while the canvas grows (`canExtend` must hold).
    func extend(_ width: Int, _ height: Int, _ left: Int, _ top: Int, _ paper: PaperSettings) throws {
        if !canExtend(left, top) { throw PaintEditorError("Wet paint only moves by whole 256 px tiles, between strokes.") }
        for (id, s) in settings {
            if let c = s.flow.center { var n = s; n.flow.center = (c.x + Double(left), c.y + Double(top)); settings.set(id, n) }
        }
        let tx0 = left / WET_TILE
        let ty0 = top / WET_TILE
        for (id, f) in patterns {
            let moved = moveLivePatternSnapshot(f.snapshot(), to: (width: width, height: height), tx0: tx0, ty0: ty0)
            let next = LivePatternField(width: width, height: height)
            next.restore(moved)
            patterns.set(id, next)
        }
        let old = world
        let snap = old.flatMap { $0.laneIds().isEmpty ? nil : $0.snapshot() }
        dropWorld()
        lastTick = nil
        stepsOwed = 0
        guard let old, let snap else { return }
        let moved = try WetWorld.moveSnapshot(snap, from: (old.width, old.height), to: (width, height), dx: left, dy: top) { l in
            let flow = self.settings.get(l.id)?.flow
            let f: WetFlowField?? = l.flow != nil && flow != nil && flow!.kind != "none" ? .some(flowField(flow!, width, height)) : nil
            return (translateSurface(l.base, Double(left), Double(top)), translateSurface(l.light, Double(left), Double(top)), f)
        }
        world = try makeWorld(width, height, paper)
        world!.restore(moved)
        for id in world!.laneIds() {
            if let f = try? world!.livePatternField(id) { patterns.set(id, f) }
        }
    }

    /// Whether any layer (or `layerId`) has wet paint.
    public func isWet(_ layerId: String? = nil) -> Bool {
        guard let w = world else { return false }
        if let layerId { return w.hasLane(layerId) && w.isActive(layerId) }
        return w.laneIds().contains { w.isActive($0) }
    }

    /// Layers holding a wet layer (wet or drying).
    public func wetLayerIds() -> [String] { world?.laneIds() ?? [] }

    func settingsOf(_ layerId: String, _ medium: String = "watercolor") -> WetLayerSettings {
        if let s = settings.get(layerId) { return s }
        let s = WetLayerSettings(params: normalizeWetParams(WET_MEDIUM_PARAMS[medium] ?? [:], DEFAULT_WET_PARAMS), flow: DEFAULT_FLOW, livePatterns: nil)
        settings.set(layerId, s)
        return s
    }

    func patternFieldOf(_ layerId: String) -> LivePatternField {
        let c = host.canvas()
        if let f = patterns.get(layerId) {
            if f.width != c.width || f.height != c.height { f.resize(c.width, c.height) }
            return f
        }
        let f = LivePatternField(width: c.width, height: c.height)
        if let lp = settings.get(layerId)?.livePatterns { f.configure(lp) }
        patterns.set(layerId, f)
        return f
    }

    /// Puts a layer in the world (its current pixels become the base under the wet paint).
    func ensureLane(_ layerId: String, _ medium: String? = nil) throws -> WetWorld {
        let w = try ensureWorld()
        let lp = patternFieldOf(layerId)
        if !w.hasLane(layerId) {
            let base = host.layerSurface(layerId) ?? emptySurface(4)
            let s = settingsOf(layerId, medium ?? "watercolor")
            try w.ensureLane(layerId, params: s.params, base: base, light: host.layerLight(layerId), ghost: s.ghost, livePatterns: lp)
            let c = host.canvas()
            if s.flow.kind != "none" { try w.setFlow(layerId, flowField(s.flow, c.width, c.height), strength: s.flow.strength) }
        }
        return w
    }

    func setParams(_ layerId: String, _ update: JSONObject) throws -> WetParams {
        var s = settingsOf(layerId)
        s.params = normalizeWetParams(update, s.params)
        settings.set(layerId, s)
        if let w = world, w.hasLane(layerId) { _ = try w.setParams(layerId, s.params) }
        return s.params
    }

    func setFlow(_ layerId: String, _ update: JSONObject) throws -> WetFlowSpec {
        var s = settingsOf(layerId)
        s.flow = normalizeFlow(update, s.flow)
        settings.set(layerId, s)
        if let w = world, w.hasLane(layerId) {
            let c = host.canvas()
            try w.setFlow(layerId, flowField(s.flow, c.width, c.height), strength: s.flow.strength)
        }
        return s.flow
    }

    @discardableResult
    func setLivePatterns(_ layerId: String, _ update: JSONObject?) throws -> LivePatternsSettings? {
        var s = settingsOf(layerId)
        let f = patternFieldOf(layerId)
        guard let update else {
            f.clear()
            s.livePatterns = nil
            settings.set(layerId, s)
            if let w = world, w.hasLane(layerId) { syncDisplays() }
            return nil
        }
        let next: LivePatternsSettings
        if let w = world, w.hasLane(layerId) {
            next = try w.setLivePatterns(layerId, update)
        } else {
            next = f.configure(update)
        }
        s.livePatterns = next
        settings.set(layerId, s)
        syncDisplays()
        return next
    }

    func seedLivePatterns(_ layerId: String, points: [(x: Double, y: Double, strength: Double?)], radius: Double, seed: Int = 1, settings update: JSONObject? = nil) throws -> (seededCells: Int, stats: LivePatternStats) {
        var s = settingsOf(layerId)
        let f = patternFieldOf(layerId)
        if let update {
            let next: LivePatternsSettings
            if let w = world, w.hasLane(layerId) {
                next = try w.setLivePatterns(layerId, update)
            } else {
                next = f.configure(update)
            }
            s.livePatterns = next
            settings.set(layerId, s)
        } else if !f.enabled {
            let next: LivePatternsSettings
            if let w = world, w.hasLane(layerId) {
                if let existing = s.livePatterns {
                    next = try w.setLivePatterns(layerId, existing)
                } else {
                    next = try w.setLivePatterns(layerId, [:])
                }
            } else {
                if let existing = s.livePatterns {
                    next = f.configure(existing)
                } else {
                    next = f.configure([:])
                }
            }
            s.livePatterns = next
            settings.set(layerId, s)
        }
        var seededCells = 0
        let hasLane = world?.hasLane(layerId) ?? false
        for (i, p) in points.enumerated() {
            let str = p.strength ?? 1
            let ptSeed = Int(Int32(truncatingIfNeeded: seed &+ i &* 7919))
            if hasLane, let w = world {
                seededCells += try w.seedLivePatterns(layerId, p.x, p.y, radius, ptSeed, str)
            } else {
                seededCells += f.seedDisc(cx: p.x, cy: p.y, radius: radius, seed: ptSeed, strength: str)
            }
        }
        syncDisplays()
        return (seededCells, livePatternStats(layerId))
    }

    func livePatternStats(_ layerId: String) -> LivePatternStats {
        let f = patterns.get(layerId)
        if let f, f.enabled {
            var s = settingsOf(layerId)
            if s.livePatterns == nil {
                s.livePatterns = f.settings
                settings.set(layerId, s)
            }
        }
        if let w = world, w.hasLane(layerId), let st = try? w.livePatternStats(layerId) {
            return st
        }
        if let f {
            return f.stats { _, _, _, _ in false }
        }
        let cfg = settings.get(layerId)?.livePatterns
        return LivePatternStats(
            enabled: cfg != nil,
            settings: cfg ?? DEFAULT_LIVE_PATTERNS,
            activeTiles: 0,
            patternCells: 0,
            wetPatternCells: 0,
            meanV: 0,
            maxV: 0,
            bounds: nil
        )
    }

    func setTilt(angle: Double?, direction: Double?) -> WetTilt {
        tilt = normalizeTilt(angle: angle, direction: direction, tilt)
        _ = world?.setTilt(tilt)
        return tilt
    }

    /// Releases a held (`trigger: "agent"`) ghost on a layer so its fade starts counting down on the simulation clock over `linger` seconds.
    func releaseGhost(_ layerId: String, linger: Double? = nil) {
        if let w = world, w.hasLane(layerId) {
            try? w.releaseGhost(layerId, linger: linger, stepsPerSecond: speed)
            if var s = settings.get(layerId) {
                s.ghost = w.getGhost(layerId)
                settings.set(layerId, s)
            }
        } else if var s = settings.get(layerId), var g = s.ghost {
            let l = linger ?? g.linger
            let total = Swift.max(1, Int(JS.round((l * speed) / Double(FREE_INTERVAL))))
            g.remaining = total
            g.total = total
            g.linger = l
            g.trigger = nil
            s.ghost = g
            settings.set(layerId, s)
        }
    }

    /// Drops a ghost lane's tracer without subtracting its pigment, so an unclaimed or declined wet mutation stroke stays as ordinary wet paint.
    func keepGhost(_ layerId: String) {
        if let w = world, w.hasLane(layerId) { try? w.keepGhost(layerId) }
        if var s = settings.get(layerId), s.ghost != nil {
            s.ghost = nil
            settings.set(layerId, s)
        }
    }

    /// The paper changed.
    func paperChanged() { world?.setPaper(wetPaperInput(host.paper())) }

    /// A layer as tools describe it.
    func info(_ layerId: String) -> WetLayerInfo {
        var s = settingsOf(layerId)
        if let f = patterns.get(layerId), f.enabled, s.livePatterns == nil {
            s.livePatterns = f.settings
            settings.set(layerId, s)
        }
        let st: WetLaneStats? = world.flatMap { $0.hasLane(layerId) ? try? $0.stats(layerId) : nil }
        let g: WetGhostState? = world != nil && world!.hasLane(layerId) ? world!.getGhost(layerId) : s.ghost
        let rem = g.map { JS.round(((Double($0.remaining) * Double(FREE_INTERVAL)) / speed) * 100) / 100 }
        return WetLayerInfo(layerId: layerId, wet: (st?.wetCells ?? 0) > 0, wetCells: st?.wetCells ?? 0, wetBounds: st?.wetBounds, activeTiles: st?.activeTiles ?? 0, params: s.params, flow: s.flow, livePatterns: s.livePatterns, ghostRemaining: rem)
    }

    func backend() -> WetBackendInfo? { world?.backend() }

    /// Shows the current wet pixels (at most `maxTiles` reshaded per layer).
    @discardableResult
    func syncDisplays(_ maxTiles: Int = Int.max) -> [RasterRect] {
        syncHeights()
        guard let w = world else { return [] }
        var surfaces = OrderedMap<String, TiledSurface>()
        var rects: [RasterRect] = []
        for id in w.laneIds() {
            if let f = patterns.get(id), f.enabled {
                var s = settingsOf(id)
                s.livePatterns = f.settings
                settings.set(id, s)
            }
            guard let d = try? w.display(id, maxTiles: maxTiles) else { continue }
            if host.layerSurface(id) !== d.surface { surfaces.set(id, d.surface) }
            rects += d.changed
        }
        syncLights()
        if !surfaces.isEmpty || !rects.isEmpty { host.updateSurfaces(surfaces, rects) }
        return rects
    }

    /// Like `syncDisplays`, shading on the GPU when it is active (all stale tiles at once).
    @discardableResult
    func syncDisplaysGpu(_ maxCpuTiles: Int = Int.max) -> [RasterRect] {
        syncHeights()
        guard let w = world else { return [] }
        var surfaces = OrderedMap<String, TiledSurface>()
        var rects: [RasterRect] = []
        for id in w.laneIds() {
            if let f = patterns.get(id), f.enabled {
                var s = settingsOf(id)
                s.livePatterns = f.settings
                settings.set(id, s)
            }
            guard let d = try? w.displayGpu(id, maxCpuTiles: maxCpuTiles) else { continue }
            if host.layerSurface(id) !== d.surface { surfaces.set(id, d.surface) }
            rects += d.changed
        }
        syncLights()
        if !surfaces.isEmpty || !rects.isEmpty { host.updateSurfaces(surfaces, rects) }
        return rects
    }

    /// Updates thick height maps for any layers with live pattern relief (`relief > 0`).
    private func syncHeights() {
        guard let layerHeight = host.layerHeight, let updateHeights = host.updateHeights else { return }
        var heights = OrderedMap<String, TiledSurface>()
        for (id, f) in patterns {
            if !f.enabled || !(f.settings.relief > 0) || f.tiles.isEmpty { continue }
            let cur = layerHeight(id) ?? emptySurface(1, 0)
            let next = f.applyReliefHeight(cur)
            if next !== cur { heights.set(id, next) }
        }
        if !heights.isEmpty { updateHeights(heights) }
    }

    /// Shows each wet layer's live light paint.
    private func syncLights() {
        guard let w = world else { return }
        var lights = OrderedMap<String, TiledSurface>()
        for id in w.laneIds() {
            if let l = try? w.lightDisplay(id), host.layerLight(id) !== l { lights.set(id, l) }
        }
        if !lights.isEmpty { host.updateLights(lights) }
    }

    /// Drops the wet layers whose paint has all dried (they become ordinary pixel layers).
    func retireDry() {
        guard let w = world else { return }
        for id in w.laneIds() {
            if w.isActive(id) || driver?.initValues.laneId == id { continue }
            guard let base = try? w.getBase(id) else { continue }
            let light = w.isLit(id) ? try? w.getLight(id) : nil
            try? w.removeLane(id)
            if var s = settings.get(id), s.ghost != nil { s.ghost = nil; settings.set(id, s) }
            if let light, host.layerLight(id) !== light { var m = OrderedMap<String, TiledSurface>(); m.set(id, light); host.updateLights(m) }
            var m = OrderedMap<String, TiledSurface>()
            m.set(id, base)
            host.updateSurfaces(m, [])
        }
    }

    /**
     * Advances time by the wall clock (`now` in ms): `speed` steps per second, at most `maxSteps`
     * per call. Call it every frame; it does nothing while paused or dry. Returns the steps run.
     */
    @discardableResult
    func tick(_ now: Double, maxSteps: Int = 8) -> Int {
        let previous = lastTick
        lastTick = now
        guard let w = world, !paused, let previous else { return 0 }
        if !w.isActive() {
            retireDry()
            return 0
        }
        stepsOwed = Swift.min(Double(maxSteps * 4), stepsOwed + ((now - previous) / 1000) * speed)
        let n = Swift.min(maxSteps, Int(JS.floor(stepsOwed)))
        if n < 1 { return 0 }
        stepsOwed -= Double(n)
        w.step(n)
        let rects = syncDisplaysGpu(DISPLAY_TILES_PER_TICK)
        retireDry()
        if rects.isEmpty { host.changed() }
        return n
    }

    /// Steps `steps` times now (agents, tests). Returns the steps run.
    func advance(_ steps: Int) -> Int {
        guard let w = world else { return 0 }
        let start = w.clock
        w.step(Swift.max(0, steps))
        syncDisplaysGpu()
        retireDry()
        return w.clock - start
    }

    /// Dries at once, on one layer or all, optionally only in a rectangle. Returns the layers and rectangles that dried.
    func dry(_ layerId: String? = nil, _ rect: RasterRect? = nil) throws -> [(layerId: String, bounds: RasterRect?)] {
        guard let w = world else { return [] }
        let ids = layerId.map { w.hasLane($0) ? [$0] : [] } ?? w.laneIds()
        var out: [(layerId: String, bounds: RasterRect?)] = []
        for id in ids { out.append((id, try w.dry(id, rect))) }
        syncDisplaysGpu()
        retireDry()
        return out
    }

    /// The layer's light paint with all its wet paint dried (nil without a wet layer or light).
    func bakedLight(_ layerId: String) -> TiledSurface? {
        guard let w = world, w.hasLane(layerId), w.isLit(layerId) else { return nil }
        return try? w.bakedLight(layerId)
    }

    /// The layer's pixels with all its wet paint dried, without changing anything.
    func bakedSurface(_ layerId: String) -> TiledSurface? {
        guard let w = world, w.hasLane(layerId) else { return nil }
        return try? w.bakedSurface(layerId)
    }

    /// A snapshot of the world for undo (nil when there is none).
    func snapshot() -> WetSnapshot? {
        let w = world
        var patSnaps = OrderedMap<String, LivePatternFieldSnapshot>()
        var patternBytes = 0
        for (id, f) in patterns {
            if !f.enabled && f.tiles.isEmpty { continue }
            let ps = f.snapshot()
            patSnaps.set(id, ps)
            patternBytes += ps.bytes
        }
        guard let w, !w.laneIds().isEmpty else {
            if patSnaps.isEmpty { return nil }
            return WetSnapshot(clock: w?.clock ?? 0, tilt: tilt, lanes: [], slots: [], patterns: patSnaps, bytes: patternBytes)
        }
        let snap = w.snapshot()
        if patSnaps.isEmpty { return snap }
        return WetSnapshot(clock: snap.clock, tilt: snap.tilt, lanes: snap.lanes, slots: snap.slots, patterns: patSnaps, bytes: snap.bytes)
    }

    /// Puts a snapshot back (nil: no wet layers).
    func restore(_ snap: WetSnapshot?) throws {
        patterns = OrderedMap()
        for (id, var s) in settings {
            s.livePatterns = nil
            settings.set(id, s)
        }
        guard let snap else {
            if let w = world { for id in w.laneIds() { try? w.removeLane(id) } }
            return
        }
        let c = host.canvas()
        if let w = world, w.width != c.width || w.height != c.height { dropWorld() }
        if let sp = snap.patterns {
            for (id, ps) in sp {
                let f = LivePatternField(width: c.width, height: c.height)
                f.restore(ps)
                patterns.set(id, f)
                var s = settingsOf(id)
                s.livePatterns = f.enabled ? f.settings : nil
                settings.set(id, s)
            }
        }
        if !snap.lanes.isEmpty {
            let w = try ensureWorld()
            w.restore(snap)
            for id in w.laneIds() {
                if let f = try? w.livePatternField(id) {
                    patterns.set(id, f)
                    var s = settingsOf(id)
                    s.livePatterns = f.enabled ? f.settings : nil
                    settings.set(id, s)
                }
            }
        } else if let w = world {
            for id in w.laneIds() { try? w.removeLane(id) }
        }
        syncDisplays()
    }

    private func dropWorld() {
        world = nil
        driver = nil
    }

    /// Forgets everything wet (a new canvas, a resize, opening a document).
    func reset() {
        world = nil
        driver = nil
        settings = OrderedMap()
        patterns = OrderedMap()
        lastTick = nil
        stepsOwed = 0
    }

    /// Water overlay tiles (RGBA) over a document rectangle, for the view.
    public func waterOverlay(_ rect: RasterRect) -> [(tx: Int, ty: Int, data: [UInt8])] {
        guard let w = world else { return [] }
        var out: [(tx: Int, ty: Int, data: [UInt8])] = []
        let tx0 = Swift.max(0, Int(JS.floor(Double(rect.x) / Double(TILE))))
        let ty0 = Swift.max(0, Int(JS.floor(Double(rect.y) / Double(TILE))))
        let tx1 = Int(JS.floor(Double(rect.x + rect.width - 1) / Double(TILE)))
        let ty1 = Int(JS.floor(Double(rect.y + rect.height - 1) / Double(TILE)))
        if ty1 < ty0 || tx1 < tx0 { return [] }
        for ty in ty0...ty1 {
            for tx in tx0...tx1 {
                var merged: [UInt8]? = nil
                for id in w.laneIds() {
                    guard let t = w.waterOverlay(id, tx, ty) else { continue }
                    if merged == nil { merged = t } else { for i in stride(from: 3, to: t.count, by: 4) { merged![i] = Swift.max(merged![i], t[i]) } }
                }
                if let merged { out.append((tx, ty, merged)) }
            }
        }
        return out
    }
}
