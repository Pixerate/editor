import Foundation
import PixerateCore
import PixerateRaster

/**
 * `WetWorld` (`paint/wet/world.ts`): the wet-media simulation of one canvas. It holds up to
 * `MAX_WET_LANES` wet layers ("lanes"), each a sparse set of 256 px tile slots, and steps all of
 * them together with the TypeScript kernel's maths (`wetStepSlot`), on this thread.
 *
 * - **Determinism.** Time is counted in steps (`clock`). Batches never cross a multiple of
 *   `FREE_INTERVAL` and are at most `MAX_BATCH` steps, tiles wake up when anything alive comes
 *   within `STRIP` cells of their edge, and dry tiles are baked and freed only on multiples of
 *   `FREE_INTERVAL`, so the result depends only on the edits and the steps they were made at.
 * - **Edits** (dabs, water, drying, blowing, blending, smudging, blotting, re-wetting) run between
 *   steps.
 * - **Display.** Each lane has a `base` surface (the layer's pixels under the wet paint);
 *   `display` gives the base with every live tile shaded. Tiles that dry are baked into the base.
 * - **Light paint** is a fifth mass channel; `lightDisplay` shades the live light over the lane's
 *   light surface and drying bakes it in.
 *
 * The CPU (the TS core's authority) runs every step: tiles on several threads (`threads`), four
 * cells at a time (`wetStepSlotSIMD`), with the scalar kernel's bits. Metal can shade the display
 * (`attachGpu`). `backend()` still reports the TypeScript kernel on one thread, the words the
 * recorded scenarios expect.
 */

/// Wet layers a world can hold at once.
public let MAX_WET_LANES = 8
/// Tile slots at most. Water reaching a tile past this is lost.
public let MAX_WET_SLOTS = 328
/// Planes a snapshot keeps per slot: the current set and the deposit (pigment and light).
private let SNAP_PLANES = SET_PLANES + MASS_CHANNELS
private let S = SLOT_SIDE
private let PL = WET_PLANE

/// The paper as the simulation reads it.
public struct WetPaperInput {
    public var absorption: Double
    public var permeability: Double
    public var roughness: Double
    /// Paper colour, sRGB bytes.
    public var color: [Int]
    /// Grain height 0..1 at a document position (the paper's wet height map).
    public var heightAt: (Double, Double) -> Double
    var paper: WetPaper { WetPaper(absorption: absorption, permeability: permeability, roughness: roughness) }
}

/// The kernel in use, in the TS core's words (this port reports the TypeScript kernel on one thread, which recorded scenarios compare).
public struct WetBackendInfo: Equatable {
    public var kind: String
    public var threads: Int
    public var message: String?
    public var json: JSONValue { ["kind": .string(kind), "threads": .number(Double(threads)), "message": message.map { .string($0) } ?? .null] }
}

/// Totals for one wet layer.
public struct WetLaneStats {
    public var activeTiles = 0
    public var wetCells = 0
    public var water = 0.0
    public var pigment = 0.0
    public var wetBounds: RasterRect?
}

/// A copy of the whole simulation (for undo).
public final class WetSnapshot {
    let clock: Int
    let tilt: WetTilt
    let lanes: [SnapLane]
    /// Per active key: the current set and the deposit planes, and its last flags.
    let slots: [(key: Int, planes: [Float], last: UInt32)]
    /// Bytes held.
    public let bytes: Int

    struct SnapLane {
        var id: String
        var index: Int
        var params: WetParams
        var flow: WetFlowField?
        var flowStrength: Double
        var base: TiledSurface
        var light: TiledSurface
        var lit: Bool
    }

    init(clock: Int, tilt: WetTilt, lanes: [SnapLane], slots: [(key: Int, planes: [Float], last: UInt32)], bytes: Int) {
        self.clock = clock
        self.tilt = tilt
        self.lanes = lanes
        self.slots = slots
        self.bytes = bytes
    }
}

/// Thrown for bad arguments and for a world that is full.
public struct WetWorldError: Error, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

/// Bytes of a slot's allocation: whole pages, so Metal can use it in place (`makeBuffer(bytesNoCopy:)`).
let WET_SLOT_ALLOCATION: Int = {
    let page = Int(getpagesize())
    return (SLOT_FLOATS * 4 + page - 1) / page * page
}()

/// One tile slot: `SLOT_PLANES` planes of 258 × 258 f32, page-aligned.
final class WetSlot {
    let f: UnsafeMutablePointer<Float>
    /// The GPU's view of this memory (a Metal buffer over it), made on first use and dropped with the slot.
    var gpuBuffer: AnyObject?
    init() {
        let raw = UnsafeMutableRawPointer.allocate(byteCount: WET_SLOT_ALLOCATION, alignment: Int(getpagesize()))
        f = raw.initializeMemory(as: Float.self, repeating: 0, count: WET_SLOT_ALLOCATION / 4)
    }
    deinit {
        gpuBuffer = nil
        UnsafeMutableRawPointer(f).deallocate()
    }
    func clear() { f.update(repeating: 0, count: SLOT_FLOATS) }
}

final class WetLane {
    let id: String
    let index: Int
    var params: WetParams
    var flow: WetFlowField?
    var flowStrength: Double
    var base: TiledSurface
    /// Shaded display tiles by tile key (nil tile: transparent), with the slot stamp they show and
    /// the lane stamp when they were shaded. Slot stamps count each tile's own changes, so only the
    /// lane stamp says which of two tiles was shaded longer ago.
    var shaded = OrderedMap<TileKey, (stamp: Int, at: Int, tile: Tile?)>()
    /// Tile keys edited since they were last shaded.
    var urgent = Set<TileKey>()
    /// Changes whenever its pixels (display) may have changed.
    var stamp = 1
    var display: TiledSurface?
    /// Document rectangles of tiles freed since the last `display`: their pixels are the base's now.
    var freedRects: [RasterRect] = []
    var shadedVersion = 0
    var displayKey = ""
    var light: TiledSurface
    /// The lane has light (under it, or laid since): only then is light shaded.
    var lit: Bool
    var lightShaded = OrderedMap<TileKey, (stamp: Int, tile: Tile?)>()
    var lightDisplay: TiledSurface?
    var lightKey = -1
    var prm: [Float] = []

    init(id: String, index: Int, params: WetParams, flow: WetFlowField?, flowStrength: Double, base: TiledSurface, light: TiledSurface?) {
        self.id = id
        self.index = index
        self.params = params
        self.flow = flow
        self.flowStrength = flowStrength
        self.base = base
        let l = light ?? emptySurface(1, 0)
        self.light = l
        lit = !l.tiles.isEmpty
    }
}

private struct Layout {
    let width: Int
    let height: Int
    let tilesX: Int
    let tilesY: Int
    let perLane: Int
    let keys: Int
    init(_ width: Int, _ height: Int) {
        self.width = width
        self.height = height
        tilesX = Int(JS.ceil(Double(width) / Double(WET_TILE)))
        tilesY = Int(JS.ceil(Double(height) / Double(WET_TILE)))
        perLane = tilesX * tilesY
        keys = perLane * MAX_WET_LANES
    }
}

/// A rectangle in document pixels with the union of another.
private func unionRectWet(_ a: RasterRect?, _ b: RasterRect) -> RasterRect {
    guard let a else { return b }
    let x = Swift.min(a.x, b.x), y = Swift.min(a.y, b.y)
    return RasterRect(x: x, y: y, width: Swift.max(a.x + a.width, b.x + b.width) - x, height: Swift.max(a.y + a.height, b.y + b.height) - y)
}

/// Runs `body` for 0..<count on up to `workers` threads, in contiguous chunks (inline for one).
private func wetParallel(_ count: Int, _ workers: Int, _ body: (Int) -> Void) {
    if workers <= 1 || count <= 1 {
        for i in 0..<count { body(i) }
        return
    }
    let chunks = Swift.min(count, workers)
    withoutActuallyEscaping(body) { body in
        nonisolated(unsafe) let fn = body
        DispatchQueue.concurrentPerform(iterations: chunks) { c in
            for i in stride(from: c, to: count, by: chunks) { fn(i) }
        }
    }
}

/// Rounds a height to 1/65536 so tiny floating-point differences in the grain never reach the simulation.
private func quantizeHeight(_ v: Double) -> Float {
    Float(JS.round(Swift.min(1, Swift.max(0, v)) * 65536) / 65536)
}

public final class WetWorld {
    public let width: Int
    public let height: Int
    /// Steps simulated so far.
    public private(set) var clock = 0
    /// Messages for the user (slots ran out).
    public private(set) var warnings: [String] = []
    private let layout: Layout
    private var slots: [WetSlot] = []
    private var freeSlots: [Int] = []
    private var table: [Int]
    private var flags: [UInt32]
    private var last: [UInt32]
    private var slotStamp: [Int]
    private var active: [Int] = []
    private var parity = 0
    private var halosDirty = false
    private var lanes: [WetLane?] = Array(repeating: nil, count: MAX_WET_LANES)
    private var tilt = FLAT_TILT
    private var paper: WetPaperInput
    private var paperBytes: [Int]
    /// Threads that step tiles (1: the calling thread only). Any count gives the same bits.
    public var threads = Swift.max(1, ProcessInfo.processInfo.activeProcessorCount)
    /// Steps with the scalar reference kernel (`wetStepSlot`) instead of the SIMD one: tests only (same bits, slower).
    var scalarKernel = false
    // Metal shading (see `attachGpu`).
    private var gpu: WetMetalEngine?
    /// GPU shading starts at this many live tiles (all layers), and stops below half of it.
    public var gpuMinTiles = 16
    private var gpuLive = false
    /// Why the GPU stopped (a failed command buffer), or nil.
    public private(set) var gpuError: String?

    public init(width: Int, height: Int, paper: WetPaperInput) throws {
        if !(width >= 1 && height >= 1 && width <= 16384 && height <= 16384) { throw WetWorldError("A wet canvas must be 1..16384 pixels per side, not \(width)×\(height).") }
        self.width = width
        self.height = height
        self.paper = paper
        paperBytes = paper.color
        layout = Layout(width, height)
        table = Array(repeating: -1, count: layout.keys)
        flags = Array(repeating: 0, count: layout.keys)
        last = Array(repeating: 0, count: layout.keys)
        slotStamp = Array(repeating: 1, count: layout.keys)
    }

    /// The kernel in use and why it is not faster.
    public func backend() -> WetBackendInfo {
        WetBackendInfo(kind: "typescript", threads: 1, message: "Wet paint runs in plain JavaScript until the WebAssembly kernel has loaded.")
    }

    // MARK: - Lanes

    private func laneOf(_ id: String) throws -> WetLane {
        guard let l = lanes.first(where: { $0?.id == id }) ?? nil else { throw WetWorldError("There is no wet layer \"\(id)\".") }
        return l
    }

    public func hasLane(_ id: String) -> Bool { lanes.contains { $0?.id == id } }

    public func laneIds() -> [String] { lanes.compactMap { $0?.id } }

    /// Adds a wet layer (or updates it). Throws when `MAX_WET_LANES` are in use.
    public func ensureLane(_ id: String, params: JSONObject? = nil, base: TiledSurface? = nil, flow: WetFlowField? = nil, flowStrength: Double? = nil, light: TiledSurface? = nil) throws {
        if let existing = lanes.first(where: { $0?.id == id }) ?? nil {
            if let params { _ = try setParams(id, normalizeWetParams(params, existing.params)) }
            if let base { setBase(id, base) }
            if let light { setLight(id, light) }
            return
        }
        guard let index = lanes.firstIndex(where: { $0 == nil }) else { throw WetWorldError("At most \(MAX_WET_LANES) layers can hold wet paint at once; dry one (dry_paint) first.") }
        let lane = WetLane(id: id, index: index, params: normalizeWetParams(params ?? [:], DEFAULT_WET_PARAMS), flow: flow, flowStrength: flow != nil ? (flowStrength ?? 1) : 0, base: base ?? emptySurface(4), light: light)
        lanes[index] = lane
        pack(lane)
    }

    /// Adds a wet layer with settings (`ensureLane` with a `WetParams`).
    func ensureLane(_ id: String, params: WetParams, base: TiledSurface, light: TiledSurface?) throws {
        if hasLane(id) {
            _ = try setParams(id, params)
            setBase(id, base)
            if let light { setLight(id, light) }
            return
        }
        guard let index = lanes.firstIndex(where: { $0 == nil }) else { throw WetWorldError("At most \(MAX_WET_LANES) layers can hold wet paint at once; dry one (dry_paint) first.") }
        let lane = WetLane(id: id, index: index, params: params, flow: nil, flowStrength: 0, base: base, light: light)
        lanes[index] = lane
        pack(lane)
    }

    /// Drops a wet layer and its wet paint (nothing is baked).
    public func removeLane(_ id: String) throws {
        let lane = try laneOf(id)
        for key in active where laneIndexOf(key) == lane.index { free(key) }
        lanes[lane.index] = nil
    }

    public func getParams(_ id: String) throws -> WetParams { try laneOf(id).params }

    public func setParams(_ id: String, _ params: WetParams) throws -> WetParams {
        let lane = try laneOf(id)
        lane.params = params
        pack(lane)
        return lane.params
    }

    public func getTilt() -> WetTilt { tilt }

    public func setTilt(_ t: WetTilt) -> WetTilt {
        tilt = t
        for l in lanes { if let l { pack(l) } }
        return tilt
    }

    /// Changes the paper: heights of live tiles are refilled, rates repacked.
    public func setPaper(_ p: WetPaperInput) {
        paper = p
        paperBytes = p.color
        for key in active {
            fillPaper(key)
            slotStamp[key] += 1
        }
        for l in lanes {
            guard let l else { continue }
            pack(l)
            l.stamp += 1
        }
        refreshHalos()
    }

    /// Sets a layer's flow map (nil removes it).
    public func setFlow(_ id: String, _ flow: WetFlowField?, strength: Double = 1) throws {
        let lane = try laneOf(id)
        lane.flow = flow
        lane.flowStrength = flow != nil ? strength : 0
        pack(lane)
        for key in active where laneIndexOf(key) == lane.index { fillFlow(key) }
    }

    public func hasFlow(_ id: String) throws -> Bool { try laneOf(id).flow != nil }

    /// The pixels under a layer's wet paint.
    public func getBase(_ id: String) throws -> TiledSurface { try laneOf(id).base }

    /// Replaces the pixels under a layer's wet paint.
    public func setBase(_ id: String, _ base: TiledSurface) {
        guard let lane = try? laneOf(id), base !== lane.base else { return }
        let old = lane.base
        lane.base = base
        for tk in Array(lane.shaded.keys) where old.tiles.get(tk) !== base.tiles.get(tk) {
            _ = lane.shaded.delete(tk)
            lane.urgent.insert(tk)
        }
        lane.shadedVersion += 1
        lane.stamp += 1
    }

    /// The light paint under a layer's wet paint (one channel).
    public func getLight(_ id: String) throws -> TiledSurface { try laneOf(id).light }

    /// Whether a layer has light paint, under its wet paint or in it.
    public func isLit(_ id: String) -> Bool { (try? laneOf(id).lit) ?? false }

    /// Replaces the light paint under a layer's wet paint.
    public func setLight(_ id: String, _ light: TiledSurface) {
        guard let lane = try? laneOf(id), light !== lane.light else { return }
        let old = lane.light
        lane.light = light
        if !light.tiles.isEmpty { lane.lit = true }
        for tk in Array(lane.lightShaded.keys) where old.tiles.get(tk) !== light.tiles.get(tk) {
            _ = lane.lightShaded.delete(tk)
        }
        lane.stamp += 1
    }

    private func pack(_ lane: WetLane) {
        lane.prm = packWetParams(lane.params, paper.paper, tilt, lane.flowStrength)
    }

    // MARK: - Slots

    @inline(__always) private func laneIndexOf(_ key: Int) -> Int { key / layout.perLane }
    @inline(__always) private func slotOf(_ key: Int) -> Int { table[key] }
    @inline(__always) private func slotPtr(_ slot: Int) -> UnsafeMutablePointer<Float> { slots[slot].f }

    /// Sorts the active list (the TS core keeps it sorted for the kernels).
    private func syncList() { active.sort() }

    /// Activates a tile of a lane. Returns false when no slot can be had.
    @discardableResult
    private func activate(_ key: Int) -> Bool {
        if slotOf(key) >= 0 { return true }
        var slot: Int
        if let s = freeSlots.popLast() {
            slot = s
            slots[slot].clear()
        } else {
            if slots.count >= MAX_WET_SLOTS {
                let msg = "Wet paint reached its memory limit (\(MAX_WET_SLOTS) tiles of 256 px); water spreading further is lost. Dry some paint (dry_paint) to free memory."
                if !warnings.contains(msg) { warnings.append(msg) }
                return false
            }
            slot = slots.count
            slots.append(WetSlot())
        }
        table[key] = slot
        flags[key] = 0
        last[key] = 0
        slotStamp[key] += 1
        active.append(key)
        fillPaper(key)
        fillFlow(key)
        return true
    }

    private func free(_ key: Int) {
        let slot = slotOf(key)
        if slot < 0 { return }
        table[key] = -1
        freeSlots.append(slot)
        if let i = active.firstIndex(of: key) { active.remove(at: i) }
        if let lane = lanes[laneIndexOf(key)] {
            let tk = tileKeyOf(key)
            if lane.shaded.delete(tk) { lane.shadedVersion += 1 }
            _ = lane.lightShaded.delete(tk)
            lane.urgent.remove(tk)
            lane.stamp += 1
            let (tx, ty) = tileXY(key)
            lane.freedRects.append(RasterRect(x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE))
        }
    }

    private func tileXY(_ key: Int) -> (Int, Int) {
        let t = key % layout.perLane
        return (t % layout.tilesX, t / layout.tilesX)
    }

    private func tileKeyOf(_ key: Int) -> TileKey {
        let (tx, ty) = tileXY(key)
        return tileKey(tx, ty)
    }

    private func fillPaper(_ key: Int) {
        let (tx, ty) = tileXY(key)
        let h = slotPtr(slotOf(key)) + P_H * PL
        for y in 0..<S {
            let gy = ty * WET_TILE + y - 1
            for x in 0..<S {
                let gx = tx * WET_TILE + x - 1
                h[y * S + x] = gx < 0 || gy < 0 || gx >= width || gy >= height ? -1 : quantizeHeight(paper.heightAt(Double(gx) + 0.5, Double(gy) + 0.5))
            }
        }
    }

    private func fillFlow(_ key: Int) {
        guard let lane = lanes[laneIndexOf(key)] else { return }
        let (tx, ty) = tileXY(key)
        let b = slotPtr(slotOf(key))
        let fx = b + P_FX * PL
        let fy = b + P_FY * PL
        for y in 1...WET_TILE {
            for x in 1...WET_TILE {
                if let flow = lane.flow {
                    let v = flow(Double(tx * WET_TILE + x - 1) + 0.5, Double(ty * WET_TILE + y - 1) + 0.5)
                    fx[y * S + x] = Float(v.0)
                    fy[y * S + x] = Float(v.1)
                } else {
                    fx[y * S + x] = 0
                    fy[y * S + x] = 0
                }
            }
        }
    }

    /// Activates every tile of a lane within `STRIP` cells of a document rectangle.
    private func wake(_ lane: WetLane, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
        let tx0 = Swift.max(0, Int(JS.floor(Double(x0 - STRIP) / Double(WET_TILE))))
        let ty0 = Swift.max(0, Int(JS.floor(Double(y0 - STRIP) / Double(WET_TILE))))
        let tx1 = Swift.min(layout.tilesX - 1, Int(JS.floor(Double(x1 + STRIP) / Double(WET_TILE))))
        let ty1 = Swift.min(layout.tilesY - 1, Int(JS.floor(Double(y1 + STRIP) / Double(WET_TILE))))
        var added = false
        if ty0 <= ty1 && tx0 <= tx1 {
            for ty in ty0...ty1 { for tx in tx0...tx1 { added = activate(lane.index * layout.perLane + ty * layout.tilesX + tx) || added } }
        }
        if added { syncList() }
    }

    /// Fills one slot's halo in set `set` from its neighbours.
    private func halo(_ key: Int, _ set: Int) {
        let laneBase = laneIndexOf(key) * layout.perLane
        let (tx, ty) = tileXY(key)
        func nb(_ dx: Int, _ dy: Int) -> UnsafeMutablePointer<Float>? {
            let x = tx + dx, y = ty + dy
            if x < 0 || y < 0 || x >= layout.tilesX || y >= layout.tilesY { return nil }
            let s = slotOf(laneBase + y * layout.tilesX + x)
            return s >= 0 ? slotPtr(s) : nil
        }
        let off = set * SET_PLANES * PL
        let me = slotPtr(slotOf(key)) + off
        let n = nb(0, -1), s = nb(0, 1), w = nb(-1, 0), e = nb(1, 0)
        let nw = nb(-1, -1), ne = nb(1, -1), sw = nb(-1, 1), se = nb(1, 1)
        for k in 0..<SET_PLANES {
            let mp = me + k * PL
            let o = off + k * PL
            if let n { (mp + 1).update(from: n + o + 256 * S + 1, count: 256) }
            if let s { (mp + 257 * S + 1).update(from: s + o + S + 1, count: 256) }
            if let w { for y in 1...256 { mp[y * S] = w[o + y * S + 256] } }
            if let e { for y in 1...256 { mp[y * S + 257] = e[o + y * S + 1] } }
            if let nw { mp[0] = nw[o + 256 * S + 256] }
            if let ne { mp[257] = ne[o + 256 * S + 1] }
            if let sw { mp[257 * S] = sw[o + S + 256] }
            if let se { mp[257 * S + 257] = se[o + S + 1] }
        }
    }

    /// Marks live slots' halos dirty (flushed before stepping or taking a snapshot).
    private func refreshHalos() {
        halosDirty = true
    }

    private func ensureHalos() {
        guard halosDirty else { return }
        halosDirty = false
        let keys = active
        wetParallel(keys.count, Swift.min(threads, keys.count)) { i in self.halo(keys[i], self.parity) }
    }

    // MARK: - Stepping

    /// Whether anything is being simulated (in `id`, or any layer).
    public func isActive(_ id: String? = nil) -> Bool {
        guard let id else { return !active.isEmpty }
        guard let lane = try? laneOf(id) else { return false }
        return active.contains { laneIndexOf($0) == lane.index }
    }

    private func batchSize(_ want: Int) -> Int {
        let toFree = FREE_INTERVAL - (clock % FREE_INTERVAL)
        return Swift.max(1, Swift.min(want, MAX_BATCH, toFree))
    }

    /**
     * Runs `n` steps of every live tile. Within a step each tile reads only its own slot (current
     * set, halo included) and writes only its own next set and deposits, and each halo is filled
     * from the neighbours' interiors after every tile has stepped, so tiles run on several threads
     * (`threads`) and give the same bits as one.
     */
    private func runHere(_ n: Int) {
        ensureHalos()
        let keys = active
        let slotPtrs = keys.map { slotPtr(slotOf($0)) }
        let prms = keys.map { lanes[laneIndexOf($0)]?.prm }
        var stepped = [UInt32](repeating: 0, count: keys.count)
        let workers = Swift.min(threads, keys.count)
        let scalar = scalarKernel
        for _ in 0..<n {
            let par = parity
            stepped.withUnsafeMutableBufferPointer { out in
                wetParallel(keys.count, workers) { i in
                    if let prm = prms[i] { out[i] = scalar ? wetStepSlot(slotPtrs[i], par, prm) : wetStepSlotSIMD(slotPtrs[i], par, prm) }
                }
            }
            for (i, key) in keys.enumerated() where prms[i] != nil {
                if last[key] != 0 || stepped[i] != 0 { slotStamp[key] += 1 }
                flags[key] |= stepped[i]
                last[key] = stepped[i]
            }
            wetParallel(keys.count, workers) { i in self.halo(keys[i], 1 - par) }
            parity = 1 - parity
        }
    }

    private func afterBatch(_ n: Int) {
        clock += n
        let tilesX = layout.tilesX, tilesY = layout.tilesY, perLane = layout.perLane
        var wakeups: [Int] = []
        for key in active {
            let fl = flags[key]
            flags[key] = 0
            if fl & FLAG_ALIVE == 0 { continue }
            let laneBase = laneIndexOf(key) * perLane
            let (tx, ty) = tileXY(key)
            let L = fl & FLAG_LEFT != 0, R = fl & FLAG_RIGHT != 0, T = fl & FLAG_TOP != 0, B = fl & FLAG_BOTTOM != 0
            func push(_ x: Int, _ y: Int) {
                if x >= 0 && y >= 0 && x < tilesX && y < tilesY && slotOf(laneBase + y * tilesX + x) < 0 { wakeups.append(laneBase + y * tilesX + x) }
            }
            if L { push(tx - 1, ty) }
            if R { push(tx + 1, ty) }
            if T { push(tx, ty - 1) }
            if B { push(tx, ty + 1) }
            if L && T { push(tx - 1, ty - 1) }
            if R && T { push(tx + 1, ty - 1) }
            if L && B { push(tx - 1, ty + 1) }
            if R && B { push(tx + 1, ty + 1) }
        }
        var woke = false
        for key in wakeups { woke = activate(key) || woke }
        if clock % FREE_INTERVAL == 0 {
            let dead = active.filter { key in
                if last[key] & FLAG_ALIVE != 0 { return false }
                let laneBase = laneIndexOf(key) * perLane
                let (tx, ty) = tileXY(key)
                for dy in -1...1 {
                    for dx in -1...1 {
                        let x = tx + dx, y = ty + dy
                        if (dx != 0 || dy != 0) && x >= 0 && y >= 0 && x < tilesX && y < tilesY {
                            let nk = laneBase + y * tilesX + x
                            if slotOf(nk) >= 0 && last[nk] & FLAG_ALIVE != 0 { return false }
                        }
                    }
                }
                return true
            }
            for key in dead {
                bakeKey(key, false)
                free(key)
            }
            if !dead.isEmpty { woke = true }
        }
        if woke {
            syncList()
            refreshHalos()
        }
        for lane in lanes { lane?.stamp += 1 }
    }

    /// Steps the simulation `steps` times. Returns the clock.
    @discardableResult
    public func step(_ steps: Int) -> Int {
        var left = Swift.max(0, steps)
        while left > 0 {
            if active.isEmpty {
                clock += left
                break
            }
            let n = batchSize(left)
            runHere(n)
            afterBatch(n)
            left -= n
        }
        if gpu != nil { _ = gpuDecide() }
        return clock
    }

    // MARK: - Edits

    /// The pointer to a cell's plane-0 value in the current set, or nil (inactive / off the canvas).
    private func cell(_ lane: WetLane, _ x: Int, _ y: Int) -> UnsafeMutablePointer<Float>? {
        if x < 0 || y < 0 || x >= width || y >= height { return nil }
        let slot = slotOf(lane.index * layout.perLane + (y >> 8) * layout.tilesX + (x >> 8))
        if slot < 0 { return nil }
        return slotPtr(slot) + parity * SET_PLANES * PL + ((y & 255) + 1) * S + (x & 255) + 1
    }

    /// The same cell in the single (deposit, height, flow) planes.
    @inline(__always) private func single(_ c: UnsafeMutablePointer<Float>) -> UnsafeMutablePointer<Float> { c - parity * SET_PLANES * PL }

    /// Runs `fn` for every cell of a footprint (`cov` over `rect`), waking the tiles around it first, then refreshes halos.
    private func footprint(_ id: String, _ rect: RasterRect, _ cov: [Float]?, wake doWake: Bool = true, _ fn: (UnsafeMutablePointer<Float>, Double, Int, Int) -> Void) throws {
        let lane = try laneOf(id)
        let x0 = Swift.max(0, rect.x), y0 = Swift.max(0, rect.y)
        let x1 = Swift.min(width, rect.x + rect.width), y1 = Swift.min(height, rect.y + rect.height)
        if x1 <= x0 || y1 <= y0 { return }
        if doWake { wake(lane, x0, y0, x1 - 1, y1 - 1) }
        for y in y0..<y1 {
            for x in x0..<x1 {
                let w = cov.map { Double($0[(y - rect.y) * rect.width + (x - rect.x)]) } ?? 1
                if !(w > 0) { continue }
                if let c = cell(lane, x, y) { fn(c, w, x, y) }
            }
        }
        markEdited(lane, x0, y0, x1, y1)
        refreshHalos()
    }

    private func markEdited(_ lane: WetLane, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
        if x1 > x0 && y1 > y0 {
            for ty in (y0 >> 8)...((y1 - 1) >> 8) {
                for tx in (x0 >> 8)...((x1 - 1) >> 8) {
                    let tk = tileKey(tx, ty)
                    lane.urgent.insert(tk)
                    _ = lane.lightShaded.delete(tk)
                }
            }
        }
        lane.stamp += 1
    }

    /// Adds water (depth units) at rest.
    @inline(__always) private func addWaterAt(_ c: UnsafeMutablePointer<Float>, _ dw: Float) {
        let d = Double(dw)
        c[0] = Float(Double(c[0]) + (4.0 / 9.0) * d)
        let w1 = (1.0 / 9.0) * d
        c[1 * PL] = Float(Double(c[1 * PL]) + w1)
        c[2 * PL] = Float(Double(c[2 * PL]) + w1)
        c[3 * PL] = Float(Double(c[3 * PL]) + w1)
        c[4 * PL] = Float(Double(c[4 * PL]) + w1)
        let w5 = (1.0 / 36.0) * d
        c[5 * PL] = Float(Double(c[5 * PL]) + w5)
        c[6 * PL] = Float(Double(c[6 * PL]) + w5)
        c[7 * PL] = Float(Double(c[7 * PL]) + w5)
        c[8 * PL] = Float(Double(c[8 * PL]) + w5)
        c[P_RHO * PL] = Float(Double(c[P_RHO * PL]) + d)
    }

    /**
     * Lays paint: `water` depth and pigment mass `pigment` (K r, g, b, S) per unit of coverage, or
     * per pixel from `field` (4 values per pixel of `rect`), and `light` per unit of coverage.
     * Pigment and light without water land straight in the paper (settled).
     */
    public func paint(_ id: String, _ rect: RasterRect, _ cov: [Float]?, water: Double, pigment: [Double]?, field: [Float]? = nil, light: Double = 0) throws {
        if !(water >= 0) { throw WetWorldError("water \(jsText(water)) must be 0 or more.") }
        if !(light >= 0) { throw WetWorldError("light \(jsText(light)) must be 0 or more.") }
        if light > 0 { try laneOf(id).lit = true }
        let p0 = pigment?[0] ?? 0, p1 = pigment?[1] ?? 0, p2 = pigment?[2] ?? 0, p3 = pigment?[3] ?? 0
        let hasPigment = pigment != nil
        try footprint(id, rect, cov) { c, w, x, y in
            let dw = Float(water * w)
            if dw > 0 { addWaterAt(c, dw) }
            let into = dw > 0 ? c + P_P0 * PL : single(c) + P_D0 * PL
            if let field {
                let o = ((y - rect.y) * rect.width + (x - rect.x)) * 4
                for q in 0..<4 { into[q * PL] = Float(Double(into[q * PL]) + Double(field[o + q]) * w) }
            } else if hasPigment {
                into[0] = Float(Double(into[0]) + p0 * w)
                into[PL] = Float(Double(into[PL]) + p1 * w)
                into[2 * PL] = Float(Double(into[2 * PL]) + p2 * w)
                into[3 * PL] = Float(Double(into[3 * PL]) + p3 * w)
            }
            if light > 0 { into[4 * PL] = Float(Double(into[4 * PL]) + light * w) }
        }
    }

    /// Damp paper: fills the paper's water towards its capacity by `amount` × coverage, plus a thin film of surface water.
    public func wetPaper(_ id: String, _ rect: RasterRect, _ cov: [Float]?, amount: Double) throws {
        try footprint(id, rect, cov) { c, w, _, _ in
            let a = Swift.min(1, Swift.max(0, amount * w))
            let s = c + P_SW * PL
            s[0] = Swift.max(s[0], Float(PAPER_CAPACITY * a))
            addWaterAt(c, Float(0.03 * a))
        }
    }

    /// Takes water (and suspended and settled pigment) away: fractions 0..1 × coverage.
    public func remove(_ id: String, _ rect: RasterRect, _ cov: [Float]?, water: Double, suspended: Double, settled: Double, paperWater: Double? = nil) throws {
        let paperWater = paperWater ?? water
        try footprint(id, rect, cov, wake: false) { c, w, _, _ in
            let kw = 1 - Swift.min(1, Swift.max(0, water * w))
            let kp = 1 - Swift.min(1, Swift.max(0, suspended * w))
            let kd = 1 - Swift.min(1, Swift.max(0, settled * w))
            let ks = 1 - Swift.min(1, Swift.max(0, paperWater * w))
            if kw < 1 {
                for k in 0..<9 { c[k * PL] = Float(Double(c[k * PL]) * kw) }
                c[P_RHO * PL] = Float(Double(c[P_RHO * PL]) * kw)
            }
            if ks < 1 { c[P_SW * PL] = Float(Double(c[P_SW * PL]) * ks) }
            if kp < 1 { for q in 0..<MASS_CHANNELS { c[(P_P0 + q) * PL] = Float(Double(c[(P_P0 + q) * PL]) * kp) } }
            if kd < 1 {
                let d = single(c) + P_D0 * PL
                for q in 0..<MASS_CHANNELS { d[q * PL] = Float(Double(d[q * PL]) * kd) }
            }
        }
    }

    /// Pushes the water: adds velocity (`ux`, `uy` cells per step, each at most 0.1) × coverage.
    public func push(_ id: String, _ rect: RasterRect, _ cov: [Float]?, ux uxIn: Double, uy uyIn: Double) throws {
        let cap = 0.1
        var ux = uxIn, uy = uyIn
        let sp = JS.hypot(ux, uy)
        if sp > cap {
            ux *= cap / sp
            uy *= cap / sp
        }
        try footprint(id, rect, cov, wake: false) { c, w, _, _ in
            let rho = Double(c[P_RHO * PL])
            if !(rho >= DRY_EPS) { return }
            for k in 1..<9 {
                let eu = WET_EX[k] * ux * w + WET_EY[k] * uy * w
                c[k * PL] = Float(Swift.max(0, Double(c[k * PL]) + 3 * W9[k] * rho * eu))
            }
        }
    }

    /// Blends wet paint: each wet cell's suspended pigment (and light) moves `strength` × coverage towards the footprint's mean.
    public func blend(_ id: String, _ rect: RasterRect, _ cov: [Float]?, strength: Double) throws {
        let lane = try laneOf(id)
        var sums = [0.0, 0.0, 0.0, 0.0, 0.0]
        var wsum = 0.0
        var cells: [(UnsafeMutablePointer<Float>, Double)] = []
        try footprint(id, rect, cov, wake: false) { c, w, _, _ in
            if !(Double(c[P_RHO * PL]) >= DRY_EPS) { return }
            cells.append((c, w))
            wsum += w
            for q in 0..<MASS_CHANNELS { sums[q] += Double(c[(P_P0 + q) * PL]) * w }
        }
        if !(wsum > 0) { return }
        let k = Swift.min(1, Swift.max(0, strength))
        for (c, w) in cells {
            for q in 0..<MASS_CHANNELS {
                let i = c + (P_P0 + q) * PL
                i[0] = Float(Double(i[0]) + k * w * (sums[q] / wsum - Double(i[0])))
            }
        }
        lane.stamp += 1
        refreshHalos()
    }

    /// Drags wet paint by (`dx`, `dy`) cells: each footprint cell takes `strength` × coverage of the cell it came from.
    public func drag(_ id: String, _ rect: RasterRect, _ cov: [Float]?, dx: Double, dy: Double, strength: Double) throws {
        let lane = try laneOf(id)
        let sx = Int(JS.round(dx)), sy = Int(JS.round(dy))
        if sx == 0 && sy == 0 { return }
        var moves: [(UnsafeMutablePointer<Float>, UnsafeMutablePointer<Float>, Double)] = []
        try footprint(id, rect, cov, wake: true) { c, w, x, y in
            guard let from = cell(lane, x - sx, y - sy) else { return }
            moves.append((from, c, Swift.min(1, Swift.max(0, strength * w))))
        }
        // Take from the sources first (so a chain of moves never moves paint twice), then lay it down.
        let taken: [[Float]] = moves.map { from, _, a in
            var t = [Float](repeating: 0, count: 10 + MASS_CHANNELS)
            for k in 0..<9 {
                t[k] = Float(Double(from[k * PL]) * a)
                from[k * PL] = from[k * PL] - t[k]
            }
            t[9] = Float(Double(from[P_RHO * PL]) * a)
            from[P_RHO * PL] = from[P_RHO * PL] - t[9]
            for q in 0..<MASS_CHANNELS {
                t[10 + q] = Float(Double(from[(P_P0 + q) * PL]) * a)
                from[(P_P0 + q) * PL] = from[(P_P0 + q) * PL] - t[10 + q]
            }
            return t
        }
        for (i, m) in moves.enumerated() {
            let to = m.1, t = taken[i]
            for k in 0..<9 { to[k * PL] = to[k * PL] + t[k] }
            to[P_RHO * PL] = to[P_RHO * PL] + t[9]
            for q in 0..<MASS_CHANNELS { to[(P_P0 + q) * PL] = to[(P_P0 + q) * PL] + t[10 + q] }
        }
        let sx0 = Swift.max(0, rect.x - sx), sy0 = Swift.max(0, rect.y - sy)
        let sx1 = Swift.min(width, rect.x + rect.width - sx), sy1 = Swift.min(height, rect.y + rect.height - sy)
        markEdited(lane, sx0, sy0, sx1, sy1)
        refreshHalos()
    }

    /**
     * Re-wetting: lifts `amount` × coverage of the dried paint in the layer's pixels (`base`) back
     * into the paper as settled pigment, and the same share of its light paint as settled light.
     * Only where there is surface water.
     */
    public func rewet(_ id: String, _ rect: RasterRect, _ cov: [Float]?, amount: Double, paper: [Int]) throws {
        let lane = try laneOf(id)
        var tiles = lane.base.tiles
        var written = Set<TileKey>()
        var writtenOrder: [TileKey] = []
        var work: [TileKey: [UInt8]] = [:]
        var lightTiles: OrderedMap<TileKey, Tile>? = lane.lit ? lane.light.tiles : nil
        var lightWork: [TileKey: [UInt8]] = [:]
        var lightOrder: [TileKey] = []
        var scratch = [UInt8](repeating: 0, count: 4)
        let clear: [UInt8] = [0, 0, 0, 0]
        try footprint(id, rect, cov, wake: false) { c, w, x, y in
            if !(Double(c[P_RHO * PL]) >= DRY_EPS) { return }
            let a = Swift.min(1, Swift.max(0, amount * w))
            if !(a > 0) { return }
            let key = tileKey(x >> 8, y >> 8)
            let li = (y & 255) * TILE + (x & 255)
            if lightTiles != nil, let lt = lightTiles!.get(key), (lt.uniform ?? 1) != 0 || lightWork[key] != nil {
                if lightWork[key] == nil {
                    lightWork[key] = lt.data
                    lightOrder.append(key)
                }
                let lv = Double(lightWork[key]![li])
                if lv > 0 {
                    let lifted = JS.round(lv * a)
                    lightWork[key]![li] = JS.u8c(lv - lifted)
                    let dl = single(c) + P_DL * PL
                    dl[0] = Float(Double(dl[0]) + Double(Float(lifted / 255)))
                }
            }
            guard let tile = tiles.get(key) else { return }
            if !written.contains(key) {
                work[key] = tile.data
                written.insert(key)
                writtenOrder.append(key)
            }
            let i = ((y & 255) * TILE + (x & 255)) * 4
            if work[key]![i + 3] == 0 { return }
            let pig = pixelPigment(work[key]!, i, paper)
            if !(pig[0] > 0 || pig[1] > 0 || pig[2] > 0) { return }
            filmPixel(pig[0] * (1 - a), pig[1] * (1 - a), pig[2] * (1 - a), 0, clear, 0, paper, 0, &scratch, 0)
            for j in 0..<4 { work[key]![i + j] = scratch[j] }
            let d = single(c) + P_D0 * PL
            for q in 0..<3 { d[q * PL] = Float(Double(d[q * PL]) + Double(Float(pig[q] * a))) }
        }
        if !writtenOrder.isEmpty {
            for key in writtenOrder {
                if let t = finishTile(work[key]!, 4, 0) { tiles.set(key, t) } else { _ = tiles.delete(key) }
            }
            setBase(id, TiledSurface(channels: 4, tiles: tiles, defaultValue: 0))
        }
        if !lightOrder.isEmpty {
            for key in lightOrder {
                if let t = finishTile(lightWork[key]!, 1, 0) { lightTiles!.set(key, t) } else { _ = lightTiles!.delete(key) }
            }
            setLight(id, TiledSurface(channels: 1, tiles: lightTiles!, defaultValue: 0))
        }
    }

    /**
     * Dries wet paint at once (everything settles where it is, the water goes): in `rect`, or the
     * whole layer. Whole tiles that end up dry are baked into the base and freed. Returns the
     * document rectangle that changed, or nil.
     */
    public func dry(_ id: String, _ rect: RasterRect? = nil) throws -> RasterRect? {
        let lane = try laneOf(id)
        let keys = active.filter { laneIndexOf($0) == lane.index }
        if keys.isEmpty { return nil }
        var bounds: RasterRect? = nil
        let area = rect ?? RasterRect(x: 0, y: 0, width: width, height: height)
        for key in keys {
            let (tx, ty) = tileXY(key)
            let tr = RasterRect(x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE)
            let x0 = Swift.max(area.x, tr.x), y0 = Swift.max(area.y, tr.y)
            let x1 = Swift.min(area.x + area.width, tr.x + tr.width, width)
            let y1 = Swift.min(area.y + area.height, tr.y + tr.height, height)
            if x1 <= x0 || y1 <= y0 { continue }
            let whole = x0 == tr.x && y0 == tr.y && x1 >= Swift.min(tr.x + WET_TILE, width) && y1 >= Swift.min(tr.y + WET_TILE, height)
            if whole {
                if bakeKey(key, true) { bounds = unionRectWet(bounds, RasterRect(x: tr.x, y: tr.y, width: Swift.min(WET_TILE, width - tr.x), height: Swift.min(WET_TILE, height - tr.y))) }
                free(key)
                continue
            }
            for y in y0..<y1 {
                for x in x0..<x1 {
                    guard let c = cell(lane, x, y) else { continue }
                    let d = single(c) + P_D0 * PL
                    for q in 0..<MASS_CHANNELS {
                        d[q * PL] = d[q * PL] + c[(P_P0 + q) * PL]
                        c[(P_P0 + q) * PL] = 0
                    }
                    for k in 0..<9 { c[k * PL] = 0 }
                    c[P_RHO * PL] = 0
                    c[P_UX * PL] = 0
                    c[P_UY * PL] = 0
                    c[P_SW * PL] = 0
                }
            }
            bounds = unionRectWet(bounds, RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
            markEdited(lane, x0, y0, x1, y1)
        }
        syncList()
        refreshHalos()
        lane.stamp += 1
        return bounds
    }

    /// Bakes a slot's pigment into its lane's base (settling suspended pigment too when `all`). Returns whether any pixel changed.
    @discardableResult
    private func bakeKey(_ key: Int, _ all: Bool) -> Bool {
        guard let lane = lanes[laneIndexOf(key)] else { return false }
        let tk = tileKeyOf(key)
        // Light first: its dimming reads the pigment over it, which the colour bake leaves in place.
        var lightChanged = false
        if lane.lit, let lout = shadeLightSlot(key, lane.light.tiles.get(tk), all ? .bakeAll : .bake) {
            var tiles = lane.light.tiles
            if let t = finishTile(lout, 1, 0) { tiles.set(tk, t) } else { _ = tiles.delete(tk) }
            setLight(lane.id, TiledSurface(channels: 1, tiles: tiles, defaultValue: 0))
            lightChanged = true
        }
        let src = lane.base.tiles.get(tk)?.data
        guard let out = shadeSlot(key, src, all ? .bakeAll : .bake) else { return lightChanged }
        var tiles = lane.base.tiles
        if let t = finishTile(out, 4, 0) { tiles.set(tk, t) } else { _ = tiles.delete(tk) }
        setBase(lane.id, TiledSurface(channels: 4, tiles: tiles, defaultValue: 0))
        return true
    }

    private enum ShadeMode { case display, bake, bakeAll }

    private func shadeLightSlot(_ key: Int, _ src: Tile?, _ mode: ShadeMode) -> [UInt8]? {
        let (tx, ty) = tileXY(key)
        let b = slotPtr(slotOf(key))
        let cur = parity * SET_PLANES * PL
        let full = src?.data
        var out = full ?? [UInt8](repeating: 0, count: TILE * TILE)
        let w = Swift.min(WET_TILE, width - tx * WET_TILE)
        let h = Swift.min(WET_TILE, height - ty * WET_TILE)
        let live = mode != .bake
        let changed = shadeLightTile(b, P_D0 * PL, live ? cur + P_P0 * PL : -1, P_DL * PL, live ? cur + P_L * PL : -1, full, &out, w, h)
        return changed ? out : nil
    }

    private func shadeSlot(_ key: Int, _ src: [UInt8]?, _ mode: ShadeMode) -> [UInt8]? {
        let (tx, ty) = tileXY(key)
        let b = slotPtr(slotOf(key))
        let cur = parity * SET_PLANES * PL
        var out = src ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
        let w = Swift.min(WET_TILE, width - tx * WET_TILE)
        let h = Swift.min(WET_TILE, height - ty * WET_TILE)
        let lit = lanes[laneIndexOf(key)]!.lit
        let changed = shadeTile(
            b, P_D0 * PL, mode == .bake ? -1 : cur + P_P0 * PL, mode == .display ? cur + P_RHO * PL : -1, cur + P_SW * PL, src, &out, w, h, paperBytes,
            lit ? P_DL * PL : -1, lit && mode != .bake ? cur + P_L * PL : -1
        )
        return changed ? out : nil
    }

    /// The layer's pixels with all its wet paint dried where it is (the bake of "dry on save"); changes nothing.
    public func bakedSurface(_ id: String) throws -> TiledSurface {
        let lane = try laneOf(id)
        var tiles = lane.base.tiles
        for key in active where laneIndexOf(key) == lane.index {
            let tk = tileKeyOf(key)
            guard let out = shadeSlot(key, lane.base.tiles.get(tk)?.data, .bakeAll) else { continue }
            if let t = finishTile(out, 4, 0) { tiles.set(tk, t) } else { _ = tiles.delete(tk) }
        }
        return TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
    }

    /// The layer's light paint with all its wet paint dried where it is; changes nothing.
    public func bakedLight(_ id: String) throws -> TiledSurface {
        let lane = try laneOf(id)
        if !lane.lit { return lane.light }
        var tiles = lane.light.tiles
        for key in active where laneIndexOf(key) == lane.index {
            let tk = tileKeyOf(key)
            guard let out = shadeLightSlot(key, lane.light.tiles.get(tk), .bakeAll) else { continue }
            if let t = finishTile(out, 1, 0) { tiles.set(tk, t) } else { _ = tiles.delete(tk) }
        }
        return TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
    }

    // MARK: - Reading

    /// Sums over a footprint of a lane, weighted by coverage.
    public func sample(_ id: String, _ rect: RasterRect, _ cov: [Float]?) throws -> (weight: Double, water: Double, wet: Double, pigment: [Double], settled: [Double]) {
        let lane = try laneOf(id)
        var weight = 0.0, water = 0.0, wet = 0.0
        var p0 = 0.0, p1 = 0.0, p2 = 0.0, p3 = 0.0
        var s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0
        let x0 = Swift.max(0, rect.x), y0 = Swift.max(0, rect.y)
        let x1 = Swift.min(width, rect.x + rect.width), y1 = Swift.min(height, rect.y + rect.height)
        if x1 > x0 && y1 > y0 {
            for y in y0..<y1 {
                for x in x0..<x1 {
                    let w = cov.map { Double($0[(y - rect.y) * rect.width + (x - rect.x)]) } ?? 1
                    if !(w > 0) { continue }
                    weight += w
                    guard let c = cell(lane, x, y) else { continue }
                    let rho = Double(c[P_RHO * PL])
                    water += rho * w
                    if rho >= DRY_EPS { wet += w }
                    let d = single(c) + P_D0 * PL
                    p0 += Double(c[P_P0 * PL]) * w
                    p1 += Double(c[(P_P0 + 1) * PL]) * w
                    p2 += Double(c[(P_P0 + 2) * PL]) * w
                    p3 += Double(c[(P_P0 + 3) * PL]) * w
                    s0 += Double(d[0]) * w
                    s1 += Double(d[PL]) * w
                    s2 += Double(d[2 * PL]) * w
                    s3 += Double(d[3 * PL]) * w
                }
            }
        }
        return (weight, water, wet, [p0, p1, p2, p3], [s0, s1, s2, s3])
    }

    /// Surface water depth at a document cell (0 where nothing is simulated).
    public func waterAt(_ id: String, _ x: Double, _ y: Double) -> Double {
        guard let lane = try? laneOf(id), let c = cell(lane, Int(JS.floor(x)), Int(JS.floor(y))) else { return 0 }
        return Double(c[P_RHO * PL])
    }

    /// Totals for a layer (scans its live tiles).
    public func stats(_ id: String) throws -> WetLaneStats {
        let lane = try laneOf(id)
        var out = WetLaneStats()
        var bx0 = Int.max, by0 = Int.max, bx1 = Int.min, by1 = Int.min
        for key in active where laneIndexOf(key) == lane.index {
            out.activeTiles += 1
            let (tx, ty) = tileXY(key)
            let b = slotPtr(slotOf(key))
            let cur = b + parity * SET_PLANES * PL
            for y in 1...256 {
                for x in 1...256 {
                    let c = y * S + x
                    let rho = Double(cur[P_RHO * PL + c])
                    out.water += rho + Double(cur[P_SW * PL + c])
                    for q in 0..<4 { out.pigment += Double(cur[(P_P0 + q) * PL + c]) + Double(b[(P_D0 + q) * PL + c]) }
                    if rho >= DRY_EPS {
                        out.wetCells += 1
                        let gx = tx * WET_TILE + x - 1, gy = ty * WET_TILE + y - 1
                        if gx < bx0 { bx0 = gx }
                        if gy < by0 { by0 = gy }
                        if gx > bx1 { bx1 = gx }
                        if gy > by1 { by1 = gy }
                    }
                }
            }
        }
        if out.wetCells > 0 { out.wetBounds = RasterRect(x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1) }
        return out
    }

    /// Whether a layer (or any) has surface water anywhere.
    public func isWet(_ id: String? = nil) -> Bool {
        let ids = id.map { [$0] } ?? laneIds()
        return ids.contains { isActive($0) }
    }

    /// Document rectangles of a layer's live tiles.
    public func activeRects(_ id: String) throws -> [RasterRect] {
        let lane = try laneOf(id)
        return active.filter { laneIndexOf($0) == lane.index }.map { k in
            let (tx, ty) = tileXY(k)
            return RasterRect(x: tx * WET_TILE, y: ty * WET_TILE, width: Swift.min(WET_TILE, width - tx * WET_TILE), height: Swift.min(WET_TILE, height - ty * WET_TILE))
        }
    }

    /// Live tiles across all layers.
    public func activeTiles() -> Int { active.count }

    // MARK: - Display

    /// A number that changes whenever a layer's display may have changed.
    public func stamp(_ id: String) -> Int { (try? laneOf(id).stamp) ?? 0 }

    /**
     * The layer's pixels with its wet paint shaded in: the base with each live tile shaded over it.
     * At most `maxTiles` stale tiles are reshaded per call (edited tiles first). Returns the
     * surface, the tiles reshaded and how many are still stale.
     */
    public func display(_ id: String, maxTiles: Int = Int.max) throws -> (surface: TiledSurface, changed: [RasterRect], pending: Int) {
        let lane = try laneOf(id)
        let keys = active.filter { laneIndexOf($0) == lane.index }
        let stale = keys.filter {
            let tk = tileKeyOf($0)
            return lane.urgent.contains(tk) || lane.shaded.get(tk)?.stamp != slotStamp[$0]
        }
        // A stable sort: edited tiles first, then the longest unshaded.
        let ordered = stale.enumerated().sorted { a, b in
            let ua = lane.urgent.contains(tileKeyOf(a.element)), ub = lane.urgent.contains(tileKeyOf(b.element))
            if ua != ub { return ua }
            let sa = lane.shaded.get(tileKeyOf(a.element))?.at ?? 0, sb = lane.shaded.get(tileKeyOf(b.element))?.at ?? 0
            if sa != sb { return sa < sb }
            return a.offset < b.offset
        }.map(\.element)
        let toShade = Array(ordered.prefix(Swift.max(0, maxTiles)))
        var shadedTiles = [Tile?](repeating: nil, count: toShade.count)
        let baseTiles = lane.base.tiles
        if !toShade.isEmpty {
            shadedTiles.withUnsafeMutableBufferPointer { buf in
                wetParallel(toShade.count, Swift.min(threads, toShade.count)) { i in
                    let key = toShade[i]
                    let tk = self.tileKeyOf(key)
                    let srcTile = baseTiles.get(tk)
                    let out = self.shadeSlot(key, srcTile?.data, .display)
                    buf[i] = out != nil ? finishTile(out!, 4, 0) : srcTile
                }
            }
        }
        var changed: [RasterRect] = []
        let done = toShade.count
        for (i, key) in toShade.enumerated() {
            let tk = tileKeyOf(key)
            lane.shaded.set(tk, (slotStamp[key], lane.stamp, shadedTiles[i]))
            lane.shadedVersion += 1
            lane.urgent.remove(tk)
            let (tx, ty) = tileXY(key)
            changed.append(RasterRect(x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE))
        }
        changed += lane.freedRects
        lane.freedRects.removeAll()
        // Shaded tiles of freed slots are gone; drop leftovers.
        let live = Set(keys.map(tileKeyOf))
        for tk in lane.shaded.keys where !live.contains(tk) {
            if lane.shaded.delete(tk) { lane.shadedVersion += 1 }
        }
        let displayKey = "\(lane.base.id):\(lane.shadedVersion)"
        if let d = lane.display, lane.displayKey == displayKey { return (d, changed, stale.count - done) }
        var tiles = lane.base.tiles
        for (tk, v) in lane.shaded {
            if let t = v.tile { tiles.set(tk, t) } else { _ = tiles.delete(tk) }
        }
        let surface = TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
        lane.display = surface
        lane.displayKey = displayKey
        return (surface, changed, stale.count - done)
    }

    /// The layer's light paint with its live light shaded in (nil when the layer has none).
    public func lightDisplay(_ id: String) throws -> TiledSurface? {
        let lane = try laneOf(id)
        if !lane.lit { return nil }
        let keys = active.filter { laneIndexOf($0) == lane.index }
        var changed = false
        var live = Set<TileKey>()
        for key in keys {
            let tk = tileKeyOf(key)
            live.insert(tk)
            if !lane.urgent.contains(tk) && lane.lightShaded.get(tk)?.stamp == slotStamp[key] { continue }
            let src = lane.light.tiles.get(tk)
            let out = shadeLightSlot(key, src, .display)
            lane.lightShaded.set(tk, (slotStamp[key], out != nil ? finishTile(out!, 1, 0) : src))
            changed = true
        }
        for tk in lane.lightShaded.keys where !live.contains(tk) {
            if lane.lightShaded.delete(tk) { changed = true }
        }
        if !changed, let d = lane.lightDisplay, lane.lightKey == lane.light.id { return d }
        var tiles = lane.light.tiles
        for (tk, v) in lane.lightShaded {
            if let t = v.tile { tiles.set(tk, t) } else { _ = tiles.delete(tk) }
        }
        let surface = TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
        lane.lightDisplay = surface
        lane.lightKey = lane.light.id
        return surface
    }

    /// The water as an overlay tile (RGBA, blue, alpha from surface depth and damp paper), or nil where nothing is wet.
    public func waterOverlay(_ id: String, _ tx: Int, _ ty: Int) -> [UInt8]? {
        guard let lane = try? laneOf(id) else { return nil }
        if tx < 0 || ty < 0 || tx >= layout.tilesX || ty >= layout.tilesY { return nil }
        let slot = slotOf(lane.index * layout.perLane + ty * layout.tilesX + tx)
        if slot < 0 { return nil }
        let cur = slotPtr(slot) + parity * SET_PLANES * PL
        var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
        var any = false
        for y in 0..<WET_TILE {
            for x in 0..<WET_TILE {
                let c = (y + 1) * S + x + 1
                let rho = Double(cur[P_RHO * PL + c])
                let sw = Double(cur[P_SW * PL + c])
                let a = Swift.min(1, rho * 2.5) * 0.7 + Swift.min(1, sw * 4) * 0.2
                if a <= 0.004 { continue }
                let i = (y * TILE + x) * 4
                out[i] = 40
                out[i + 1] = 120
                out[i + 2] = 255
                out[i + 3] = JS.u8c(JS.round(a * 255))
                any = true
            }
        }
        return any ? out : nil
    }

    // MARK: - Metal shading

    /**
     * Attaches a Metal engine (or nil to detach). From then on, whenever at least `gpuMinTiles`
     * tiles are live, `displayGpu` shades on it. The CPU stays the authority.
     */
    public func attachGpu(_ engine: WetMetalEngine?) {
        gpu = engine
        gpuLive = false
        gpuError = nil
    }

    /// The attached engine, if any.
    public var gpuEngine: WetMetalEngine? { gpu }

    /// Whether the GPU shades now (an engine is attached and the wet area is large).
    public var gpuActive: Bool { gpuLive }

    private func gpuStop(_ reason: String?) {
        gpuLive = false
        guard let reason else { return }
        gpuError = reason
        gpu = nil
        if !warnings.contains(reason) { warnings.append(reason) }
    }

    /// Turns GPU shading on or off for the current wet area. Returns whether it is on.
    private func gpuDecide() -> Bool {
        // On at gpuMinTiles, off below half of it (so it does not flip at the threshold).
        let want = gpu != nil && active.count >= (gpuLive ? (gpuMinTiles + 1) / 2 : gpuMinTiles)
        if want && !gpuLive {
            if let lost = gpu!.lostReason {
                gpuStop("The GPU was lost (\(lost)); wet paint runs on the CPU.")
                return false
            }
            gpuLive = true
        } else if !want && gpuLive {
            gpuStop(nil)
        }
        return gpuLive
    }

    /**
     * Like `display`, but shades every stale tile on the GPU at once when GPU shading is on
     * (otherwise, or when the GPU fails, it is `display(id, maxTiles: maxCpuTiles)`).
     */
    public func displayGpu(_ id: String, maxCpuTiles: Int = Int.max) throws -> (surface: TiledSurface, changed: [RasterRect], pending: Int, gpu: Bool) {
        func cpu() throws -> (surface: TiledSurface, changed: [RasterRect], pending: Int, gpu: Bool) {
            let d = try display(id, maxTiles: maxCpuTiles)
            return (d.surface, d.changed, d.pending, false)
        }
        guard let engine = gpu, gpuDecide() else { return try cpu() }
        let lane = try laneOf(id)
        let stale = active.filter {
            guard laneIndexOf($0) == lane.index else { return false }
            let tk = tileKeyOf($0)
            return lane.urgent.contains(tk) || lane.shaded.get(tk)?.stamp != slotStamp[$0]
        }
        if stale.isEmpty {
            let d = try display(id, maxTiles: 0)
            return (d.surface, d.changed, d.pending, true)
        }
        let jobs = stale.map { key -> WetShadeJob in
            let (tx, ty) = tileXY(key)
            return WetShadeJob(slot: slots[slotOf(key)], width: Swift.min(WET_TILE, width - tx * WET_TILE), height: Swift.min(WET_TILE, height - ty * WET_TILE), src: lane.base.tiles.get(tileKeyOf(key))?.data)
        }
        let tiles: [[UInt8]]
        do {
            tiles = try engine.shade(jobs, parity: parity, paper: paperBytes)
        } catch {
            gpuStop("Wet paint stopped using the GPU (\(error.localizedDescription)).")
            return try cpu()
        }
        var changed: [RasterRect] = []
        for (i, key) in stale.enumerated() {
            let tk = tileKeyOf(key)
            lane.shaded.set(tk, (slotStamp[key], lane.stamp, finishTile(tiles[i], 4, 0)))
            lane.urgent.remove(tk)
            let (tx, ty) = tileXY(key)
            changed.append(RasterRect(x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE))
        }
        lane.shadedVersion += 1
        let d = try display(id, maxTiles: 0)
        return (d.surface, changed + d.changed, 0, true)
    }

    // MARK: - Snapshots

    /// A copy of everything (for undo): live slots, layers, clock and tilt.
    public func snapshot() -> WetSnapshot {
        ensureHalos()
        var out: [(key: Int, planes: [Float], last: UInt32)] = []
        var bytes = 0
        for key in active {
            let b = slotPtr(slotOf(key))
            var planes = [Float](repeating: 0, count: SNAP_PLANES * PL)
            planes.withUnsafeMutableBufferPointer { p in
                p.baseAddress!.update(from: b + parity * SET_PLANES * PL, count: SET_PLANES * PL)
                (p.baseAddress! + SET_PLANES * PL).update(from: b + P_D0 * PL, count: MASS_CHANNELS * PL)
            }
            out.append((key, planes, last[key]))
            bytes += planes.count * 4
        }
        let ls = lanes.compactMap { $0 }.map { l in WetSnapshot.SnapLane(id: l.id, index: l.index, params: l.params, flow: l.flow, flowStrength: l.flowStrength, base: l.base, light: l.light, lit: l.lit) }
        return WetSnapshot(clock: clock, tilt: tilt, lanes: ls, slots: out, bytes: bytes)
    }

    /// Puts a snapshot back exactly (the simulation then continues as it would have).
    public func restore(_ snap: WetSnapshot) {
        for key in active { free(key) }
        lanes = Array(repeating: nil, count: MAX_WET_LANES)
        tilt = snap.tilt
        for l in snap.lanes {
            let lane = WetLane(id: l.id, index: l.index, params: l.params, flow: l.flow, flowStrength: l.flowStrength, base: l.base, light: l.light)
            lane.lit = lane.lit || l.lit
            lanes[l.index] = lane
            pack(lane)
        }
        for s in snap.slots {
            if !activate(s.key) { continue }
            let b = slotPtr(slotOf(s.key))
            s.planes.withUnsafeBufferPointer { p in
                (b + parity * SET_PLANES * PL).update(from: p.baseAddress!, count: SET_PLANES * PL)
                (b + P_D0 * PL).update(from: p.baseAddress! + SET_PLANES * PL, count: MASS_CHANNELS * PL)
            }
            last[s.key] = s.last
        }
        clock = snap.clock
        syncList()
        refreshHalos()
    }

    /// `snap`, taken from a world `from` in size, moved by whole tiles (`dx`, `dy` pixels) for a world `to` in size.
    static func moveSnapshot(_ snap: WetSnapshot, from: (Int, Int), to: (Int, Int), dx: Int, dy: Int, lane: (WetSnapshot.SnapLane) -> (base: TiledSurface?, light: TiledSurface?, flow: WetFlowField??)) throws -> WetSnapshot {
        if dx % WET_TILE != 0 || dy % WET_TILE != 0 { throw WetWorldError("Wet paint moves by whole \(WET_TILE) px tiles, not (\(dx), \(dy)).") }
        let a = Layout(from.0, from.1), b = Layout(to.0, to.1)
        let tx0 = dx / WET_TILE, ty0 = dy / WET_TILE
        var slots: [(key: Int, planes: [Float], last: UInt32)] = []
        var bytes = 0
        for s in snap.slots {
            let index = s.key / a.perLane
            let t = s.key % a.perLane
            let tx = t % a.tilesX + tx0, ty = t / a.tilesX + ty0
            if tx < 0 || ty < 0 || tx >= b.tilesX || ty >= b.tilesY { continue }
            slots.append((index * b.perLane + ty * b.tilesX + tx, s.planes, s.last))
            bytes += s.planes.count * 4
        }
        let lanes = snap.lanes.map { l -> WetSnapshot.SnapLane in
            let m = lane(l)
            var out = l
            if let base = m.base { out.base = base }
            if let light = m.light { out.light = light }
            if let flow = m.flow { out.flow = flow }
            return out
        }
        return WetSnapshot(clock: snap.clock, tilt: snap.tilt, lanes: lanes, slots: slots, bytes: bytes)
    }
}
