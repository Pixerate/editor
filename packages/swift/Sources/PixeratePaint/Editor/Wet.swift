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
    /// The world's clock at which each raw point was applied (recorded with the stroke).
    private(set) var steps: [Int] = []
    let initValues: WetStrokeInit
    private let smoother: PenSmoother
    private let states: [WetCopyState]
    private let medium: WetMedium
    private let copies: [StrokeCopy]
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
        let spacing = Swift.max(0.02, brush.tip.spacing)
        let perDab = Swift.min(1, spacing * 1.2)
        let thin = wet.thinner
        medium = WetMedium(i.world, i.laneId, WetMedium.Options(
            water: STROKE_WATER * Swift.min(1, wet.water * (1 + thin)) * perDab,
            mass: STROKE_MASS * wet.pigment * (1 - 0.6 * thin) * perDab,
            body: wet.body * (1 - thin),
            light: 0
        ))
        lightBase = wet.tool == "paint" ? STROKE_LIGHT * brush.light.amount * (1 - 0.6 * thin) * perDab : 0
        let rates = exchangeRates(brush.behavior.pickup, brush.behavior.mix, wet.load, brush.behavior.mixing)
        states = copies.enumerated().map { k, c in
            WetCopyState(walker: PenDabWalker(brush, Int(Int32(truncatingIfNeeded: i.seed + k * 7919)), c.linear), exchange: wet.tool == "paint" ? PaintExchange(rates, i.load) : nil)
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
        case "paint":
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
            if wet.rewet > 0 { try world.rewet(laneId, rect, cov, amount: wet.rewet * k * 0.15, paper: initValues.paperColor) }
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

    public var json: JSONValue {
        ["layerId": .string(layerId), "wet": .bool(wet), "wetCells": .number(Double(wetCells)), "wetBounds": rectJSON(wetBounds), "activeTiles": .number(Double(activeTiles)), "params": params.json, "flow": flow.json]
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

    public var json: JSONValue {
        var o: JSONObject = ["clock": .number(Double(clock))]
        if let at { o["at"] = .number(Double(at)) }
        o["kind"] = .string(kind)
        if let layerId { o["layerId"] = .string(layerId) }
        if let data { o["data"] = data }
        return .object(o)
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
        let s = WetLayerSettings(params: normalizeWetParams(WET_MEDIUM_PARAMS[medium] ?? [:], DEFAULT_WET_PARAMS), flow: DEFAULT_FLOW)
        settings.set(layerId, s)
        return s
    }

    /// Puts a layer in the world (its current pixels become the base under the wet paint).
    func ensureLane(_ layerId: String, _ medium: String? = nil) throws -> WetWorld {
        let w = try ensureWorld()
        if !w.hasLane(layerId) {
            let base = host.layerSurface(layerId) ?? emptySurface(4)
            let s = settingsOf(layerId, medium ?? "watercolor")
            try w.ensureLane(layerId, params: s.params, base: base, light: host.layerLight(layerId))
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

    func setTilt(angle: Double?, direction: Double?) -> WetTilt {
        tilt = normalizeTilt(angle: angle, direction: direction, tilt)
        _ = world?.setTilt(tilt)
        return tilt
    }

    /// The paper changed.
    func paperChanged() { world?.setPaper(wetPaperInput(host.paper())) }

    /// A layer as tools describe it.
    func info(_ layerId: String) -> WetLayerInfo {
        let s = settingsOf(layerId)
        let st: WetLaneStats? = world.flatMap { $0.hasLane(layerId) ? try? $0.stats(layerId) : nil }
        return WetLayerInfo(layerId: layerId, wet: (st?.wetCells ?? 0) > 0, wetCells: st?.wetCells ?? 0, wetBounds: st?.wetBounds, activeTiles: st?.activeTiles ?? 0, params: s.params, flow: s.flow)
    }

    func backend() -> WetBackendInfo? { world?.backend() }

    /// Shows the current wet pixels (at most `maxTiles` reshaded per layer).
    @discardableResult
    func syncDisplays(_ maxTiles: Int = Int.max) -> [RasterRect] {
        guard let w = world else { return [] }
        var surfaces = OrderedMap<String, TiledSurface>()
        var rects: [RasterRect] = []
        for id in w.laneIds() {
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
        guard let w = world else { return [] }
        var surfaces = OrderedMap<String, TiledSurface>()
        var rects: [RasterRect] = []
        for id in w.laneIds() {
            guard let d = try? w.displayGpu(id, maxCpuTiles: maxCpuTiles) else { continue }
            if host.layerSurface(id) !== d.surface { surfaces.set(id, d.surface) }
            rects += d.changed
        }
        syncLights()
        if !surfaces.isEmpty || !rects.isEmpty { host.updateSurfaces(surfaces, rects) }
        return rects
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
        guard let w = world, !w.laneIds().isEmpty else { return nil }
        return w.snapshot()
    }

    /// Puts a snapshot back (nil: no wet layers).
    func restore(_ snap: WetSnapshot?) throws {
        guard let snap else {
            if let w = world { for id in w.laneIds() { try? w.removeLane(id) } }
            return
        }
        let c = host.canvas()
        if let w = world, w.width != c.width || w.height != c.height { dropWorld() }
        try ensureWorld().restore(snap)
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
