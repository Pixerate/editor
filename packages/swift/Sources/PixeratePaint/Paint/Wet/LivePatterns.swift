import Foundation
import PixerateCore
import PixerateRaster

/**
 * Live patterns (`paint/live-patterns.ts`): Gray-Scott reaction-diffusion fields `(U, V)` that grow
 * inside wet paint and freeze where the paint dries.
 *
 * Each wet layer with live patterns active holds a sparse set of half-resolution (`128 × 128`)
 * pattern tiles paired with the `256 × 256` tiles of `WetWorld`, outside the wet-media LBM kernel.
 * Every wet simulation step runs Gray-Scott substeps gated by the wet layer's water (`P_RHO` +
 * `P_SW > DRY_EPS`): where water remains, `U` and `V` react and diffuse into Turing spots,
 * stripes, coral dendrites, mazes or worms; where the paint has dried, the reaction and diffusion
 * rates drop to zero so the pattern freezes in place.
 */

/// Side length of one half-resolution pattern tile (`WET_TILE / 2`).
public let PATTERN_TILE = 128
/// Cells per pattern tile (`128 × 128`).
public let PATTERN_CELLS = PATTERN_TILE * PATTERN_TILE
/// Gray-Scott substeps run for each wet simulation step.
public let PATTERN_SUBSTEPS = 4
/// Threshold of `V` above which a cell counts as pattern-bearing in stats and relief.
public let PATTERN_V_EPS = 0.02

/// Named Gray-Scott Pearson pattern presets.
public let LIVE_PATTERN_KINDS = ["spots", "stripes", "coral", "maze", "worms"]

public struct LivePatternPresetInfo: Equatable, Sendable {
    public let kind: String
    public let label: String
    public let description: String
    public let feed: Double
    public let kill: Double

    public var json: JSONValue {
        ["kind": .string(kind), "label": .string(label), "description": .string(description), "feed": .number(feed), "kill": .number(kill)]
    }
}

/// Built-in Pearson (1993) feed / kill parameter presets.
public let LIVE_PATTERN_PRESETS: [String: LivePatternPresetInfo] = [
    "spots": LivePatternPresetInfo(kind: "spots", label: "Spots", description: "Dividing Turing spots (mitosis).", feed: 0.035, kill: 0.065),
    "stripes": LivePatternPresetInfo(kind: "stripes", label: "Stripes", description: "Labyrinthine Turing stripes.", feed: 0.042, kill: 0.06),
    "coral": LivePatternPresetInfo(kind: "coral", label: "Coral", description: "Branching coral dendrites.", feed: 0.0545, kill: 0.062),
    "maze": LivePatternPresetInfo(kind: "maze", label: "Maze", description: "Winding interconnected maze channels.", feed: 0.029, kill: 0.057),
    "worms": LivePatternPresetInfo(kind: "worms", label: "Worms", description: "Wiggling vermicular tracks.", feed: 0.058, kill: 0.065),
]

/// Resolved live-pattern parameters for a brush or wet layer.
public struct LivePatternsSettings: Equatable, Sendable {
    public var pattern: String
    public var feed: Double
    public var kill: Double
    public var scale: Double
    public var contrast: Double
    public var secondColor: String?
    public var relief: Double

    public init(pattern: String, feed: Double, kill: Double, scale: Double, contrast: Double, secondColor: String?, relief: Double) {
        self.pattern = pattern
        self.feed = feed
        self.kill = kill
        self.scale = scale
        self.contrast = contrast
        self.secondColor = secondColor
        self.relief = relief
    }

    public subscript(key: String) -> Double {
        get {
            switch key {
            case "feed": feed
            case "kill": kill
            case "scale": scale
            case "contrast": contrast
            default: relief
            }
        }
        set {
            switch key {
            case "feed": feed = newValue
            case "kill": kill = newValue
            case "scale": scale = newValue
            case "contrast": contrast = newValue
            default: relief = newValue
            }
        }
    }

    public var json: JSONValue {
        [
            "pattern": .string(pattern),
            "feed": .number(feed),
            "kill": .number(kill),
            "scale": .number(scale),
            "contrast": .number(contrast),
            "secondColor": secondColor.map { .string($0) } ?? .null,
            "relief": .number(relief),
        ]
    }
}

public typealias BrushLivePatterns = LivePatternsSettings

public let DEFAULT_LIVE_PATTERNS = LivePatternsSettings(
    pattern: "spots",
    feed: LIVE_PATTERN_PRESETS["spots"]!.feed,
    kill: LIVE_PATTERN_PRESETS["spots"]!.kill,
    scale: 1,
    contrast: 1,
    secondColor: nil,
    relief: 0
)

public func isLivePatternKind(_ v: String?) -> Bool {
    guard let v else { return false }
    return LIVE_PATTERN_KINDS.contains(v)
}

/// Normalizes a hex colour string (`#rgb` or `#rrggbb`) to lowercase `#rrggbb`, or `nil`.
public func normalizePatternHexColor(_ v: JSONValue?, _ fallback: String? = nil) -> String? {
    guard let v else { return fallback }
    if v == .null { return nil }
    guard let raw = v.stringValue else { return fallback }
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if s.range(of: "^#[0-9a-f]{6}$", options: .regularExpression) != nil { return s }
    if s.range(of: "^#[0-9a-f]{3}$", options: .regularExpression) != nil {
        let chars = Array(s)
        return "#\(chars[1])\(chars[1])\(chars[2])\(chars[2])\(chars[3])\(chars[3])"
    }
    return fallback
}

/// Parses a `#rrggbb` colour to `[r, g, b]` bytes, or `nil`.
public func parsePatternHexColor(_ hex: String?) -> [Int]? {
    guard let hex, hex.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return nil }
    return hexToRgb8(hex)
}

private func round4(_ n: Double) -> Double {
    JS.round(n * 10000) / 10000
}

/// Clamps and fills a `LivePatternsSettings` value from partial JSON input.
public func normalizeLivePatterns(_ raw: JSONObject = [:], _ base: LivePatternsSettings = DEFAULT_LIVE_PATTERNS) -> LivePatternsSettings {
    let rawPattern = raw["pattern"]?.stringValue
    let hasExplicitPattern = isLivePatternKind(rawPattern)
    let pattern = hasExplicitPattern ? rawPattern! : base.pattern
    let preset = LIVE_PATTERN_PRESETS[pattern] ?? LIVE_PATTERN_PRESETS["spots"]!
    func num(_ v: JSONValue?, _ d: Double, _ lo: Double, _ hi: Double) -> Double {
        guard let n = v?.finite else { return d }
        return Swift.min(hi, Swift.max(lo, n))
    }
    let defaultFeed = hasExplicitPattern ? preset.feed : base.feed
    let defaultKill = hasExplicitPattern ? preset.kill : base.kill
    let secondColor: String? = raw.keys.contains("secondColor") ? normalizePatternHexColor(raw["secondColor"], base.secondColor) : base.secondColor
    return LivePatternsSettings(
        pattern: pattern,
        feed: round4(num(raw["feed"], defaultFeed, 0.01, 0.1)),
        kill: round4(num(raw["kill"], defaultKill, 0.03, 0.08)),
        scale: round4(num(raw["scale"], base.scale, 0.5, 4)),
        contrast: round4(num(raw["contrast"], base.contrast, 0, 2)),
        secondColor: secondColor,
        relief: round4(num(raw["relief"], base.relief, 0, 1))
    )
}

/// Deterministic 32-bit integer hash in `[0, 1)` shared between TypeScript and Swift.
public func patternNoise(_ gx: Int, _ gy: Int, _ seed: Int) -> Double {
    let x = Int32(truncatingIfNeeded: gx) &* 374_761_393
    let y = Int32(truncatingIfNeeded: gy) &* 668_265_263
    let s = Int32(truncatingIfNeeded: seed) &* 1_442_695_041
    var u = UInt32(bitPattern: x &+ y &+ s)
    u = (u ^ (u >> 13)) &* 1_274_126_177
    u = u ^ (u >> 16)
    return Double(u) / 4_294_967_296.0
}

/// Summary statistics for one wet layer's Gray-Scott field.
public struct LivePatternStats: Equatable {
    public var enabled: Bool
    public var settings: LivePatternsSettings
    public var activeTiles: Int
    public var patternCells: Int
    public var wetPatternCells: Int
    public var meanV: Double
    public var maxV: Double
    public var bounds: RasterRect?
}

public struct LivePatternTileState {
    public var u: [Double]
    public var v: [Double]
    public var bakedV: [Double]
}

public struct LivePatternFieldSnapshot {
    public let settings: LivePatternsSettings
    public let enabled: Bool
    public let tiles: OrderedMap<TileKey, LivePatternTileState>
    public let bytes: Int
}

public typealias WetCellPredicate = (_ tx: Int, _ ty: Int, _ lx: Int, _ ly: Int) -> Bool

/**
 * `WetCellPredicate` for a whole pattern tile at once: sets `mask[ly * PATTERN_TILE + lx]` to 1 for
 * every wet cell with `lx < width` and `ly < height` (the mask starts as zeros) and returns whether
 * any cell is wet. It must agree with the predicate cell for cell, and `step` may call it for
 * several tiles at once, each on its own thread.
 */
public typealias WetTileMask = (_ tx: Int, _ ty: Int, _ width: Int, _ height: Int, _ mask: UnsafeMutablePointer<UInt8>) -> Bool

/// Runs `body` for 0..<count on up to `workers` threads (inline for one).
private func patternParallel(_ count: Int, _ workers: Int, _ body: (Int) -> Void) {
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

/**
 * One pattern tile's ridges over a height tile (`w` × `h` pixels of it are on the canvas): the
 * height tile's bytes with every ridge that is higher written in, or nil when none is. A pattern
 * cell covers 2 × 2 pixels, so its ridge is worked out once.
 */
private func reliefTile(_ v: [Double], _ existing: Tile?, _ w: Int, _ h: Int, _ relief: Double) -> [UInt8]? {
    var maxTileV = 0.0
    for i in 0..<PATTERN_CELLS where v[i] > maxTileV { maxTileV = v[i] }
    if maxTileV < PATTERN_V_EPS { return nil }
    var buf: [UInt8]
    if let existing {
        buf = !existing.data.isEmpty ? existing.data : [UInt8](repeating: UInt8(truncatingIfNeeded: existing.uniform ?? 0), count: TILE * TILE)
    } else {
        buf = [UInt8](repeating: 0, count: TILE * TILE)
    }
    var tileChanged = false
    v.withUnsafeBufferPointer { v in
        buf.withUnsafeMutableBufferPointer { buf in
            for ly in 0..<((h + 1) >> 1) {
                let row = ly * PATTERN_TILE
                for lx in 0..<((w + 1) >> 1) {
                    let vVal = v[row + lx]
                    if vVal < PATTERN_V_EPS { continue }
                    let ridge = JS.u8c(Swift.min(255, JS.round(Swift.min(1, vVal * 2.2) * relief * 255)))
                    for y in (ly * 2)..<Swift.min(h, ly * 2 + 2) {
                        for x in (lx * 2)..<Swift.min(w, lx * 2 + 2) {
                            let p = y * TILE + x
                            if ridge > buf[p] {
                                buf[p] = ridge
                                tileChanged = true
                            }
                        }
                    }
                }
            }
        }
    }
    return tileChanged ? buf : nil
}

/// Per-wet-layer Gray-Scott reaction-diffusion field `(U, V)` stored in `128 × 128` tiles.
public final class LivePatternField {
    public var width: Int
    public var height: Int
    public var tilesX: Int
    public var tilesY: Int
    public var settings: LivePatternsSettings = DEFAULT_LIVE_PATTERNS
    public var enabled = false
    public var tiles = OrderedMap<TileKey, LivePatternTileState>() { didSet { if !ownEdit { reliefAll = true } } }
    /// Set while the field edits `tiles` itself (it notes what changed); any other change makes every tile's relief stale.
    private var ownEdit = false
    /// Tiles whose `V` changed since `applyReliefHeight` last read them.
    private var reliefChanged = Set<TileKey>()
    /// Every tile's relief may be stale (the tiles were replaced, or the relief settings or the canvas changed).
    private var reliefAll = true
    /// The relief amount and canvas size `reliefSeen` was made with.
    private var reliefKey: (relief: Double, width: Int, height: Int) = (0, 0, 0)
    /// Per tile, the height tile `applyReliefHeight` last left (nil: none): writing the same `V` into it again changes nothing.
    private var reliefSeen: [TileKey: Tile?] = [:]
    /// The tiles the last `step` advanced (those with wet cells): only their pattern can have changed.
    public private(set) var steppedTiles: [TileKey] = []

    public init(width: Int, height: Int, settings: JSONObject? = nil) {
        self.width = Swift.max(1, width)
        self.height = Swift.max(1, height)
        self.tilesX = Int(JS.ceil(Double(self.width) / Double(TILE)))
        self.tilesY = Int(JS.ceil(Double(self.height) / Double(TILE)))
        if let settings {
            self.settings = normalizeLivePatterns(settings, self.settings)
            self.enabled = true
        }
    }

    public func resize(_ width: Int, _ height: Int) {
        self.width = Swift.max(1, width)
        self.height = Swift.max(1, height)
        self.tilesX = Int(JS.ceil(Double(self.width) / Double(TILE)))
        self.tilesY = Int(JS.ceil(Double(self.height) / Double(TILE)))
    }

    @discardableResult
    public func configure(_ raw: JSONObject) -> LivePatternsSettings {
        settings = normalizeLivePatterns(raw, settings)
        enabled = true
        return settings
    }

    @discardableResult
    public func configure(_ next: LivePatternsSettings) -> LivePatternsSettings {
        settings = next
        enabled = true
        return settings
    }

    public func clear() {
        enabled = false
        tiles = OrderedMap()
    }

    private func ensureTile(_ tx: Int, _ ty: Int) -> TileKey? {
        if tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY { return nil }
        let key = tileKey(tx, ty)
        if !tiles.has(key) {
            setTile(key, LivePatternTileState(
                u: [Double](repeating: 1, count: PATTERN_CELLS),
                v: [Double](repeating: 0, count: PATTERN_CELLS),
                bakedV: [Double](repeating: 0, count: PATTERN_CELLS)
            ), vChanged: true)
        }
        return key
    }

    /// Stores a tile, noting whether its `V` (what the relief reads) changed.
    private func setTile(_ key: TileKey, _ tile: LivePatternTileState, vChanged: Bool) {
        ownEdit = true
        tiles.set(key, tile)
        ownEdit = false
        if vChanged { reliefChanged.insert(key) }
    }

    /// Seeds Gray-Scott reagent `V` inside a circle at document coordinates `(cx, cy)` with document `radius` (pixels).
    @discardableResult
    public func seedDisc(cx: Double, cy: Double, radius: Double, seed: Int = 1, strength: Double = 1) -> Int {
        enabled = true
        let s = Swift.min(1, Swift.max(0.05, strength))
        let rDoc = Swift.max(2, radius)
        let px = cx * 0.5
        let py = cy * 0.5
        let pr = Swift.max(1, rDoc * 0.5)
        let maxGx = Int(JS.ceil(Double(width) * 0.5))
        let maxGy = Int(JS.ceil(Double(height) * 0.5))
        let gx0 = Swift.max(0, Int(JS.floor(px - pr)))
        let gy0 = Swift.max(0, Int(JS.floor(py - pr)))
        let gx1 = Swift.min(maxGx - 1, Int(JS.ceil(px + pr)))
        let gy1 = Swift.min(maxGy - 1, Int(JS.ceil(py + pr)))
        let r2 = pr * pr
        var seeded = 0

        if gy0 <= gy1 && gx0 <= gx1 {
            for gy in gy0...gy1 {
                let dy = Double(gy) + 0.5 - py
                for gx in gx0...gx1 {
                    let dx = Double(gx) + 0.5 - px
                    let d2 = dx * dx + dy * dy
                    if d2 > r2 { continue }
                    let tx = Int(JS.floor(Double(gx) / Double(PATTERN_TILE)))
                    let ty = Int(JS.floor(Double(gy) / Double(PATTERN_TILE)))
                    guard let key = ensureTile(tx, ty), var tile = tiles.get(key) else { continue }
                    let lx = gx - tx * PATTERN_TILE
                    let ly = gy - ty * PATTERN_TILE
                    let idx = ly * PATTERN_TILE + lx
                    let coarse = patternNoise(gx >> 1, gy >> 1, seed)
                    let fine = patternNoise(gx, gy, seed + 101)
                    let nearCenter = d2 <= Swift.max(2.5, r2 * 0.08)
                    if nearCenter || (d2 <= r2 * 0.65 && coarse > 0.72) {
                        let falloff = 1 - (d2 / r2) * 0.2
                        let targetV = (0.45 + 0.12 * fine) * s * falloff
                        if targetV > tile.v[idx] {
                            tile.v[idx] = targetV
                            tile.u[idx] = Swift.min(tile.u[idx], 0.5)
                        }
                        tile.bakedV[idx] = 0
                        setTile(key, tile, vChanged: true)
                        seeded += 1
                    } else if tile.v[idx] == 0 && tile.u[idx] == 1 {
                        tile.u[idx] = 0.99 - 0.02 * fine * s
                        tile.bakedV[idx] = 0
                        setTile(key, tile, vChanged: false)
                    }
                }
            }
        }
        return seeded
    }

    /**
     * Advances the Gray-Scott reaction-diffusion field for `wetSteps` wet simulation steps.
     * Only cells where `isWetCell(tx, ty, lx, ly)` is true update; dry cells have zero rate and freeze.
     *
     * `wetTile`, when given, answers `isWetCell` for a whole tile at once (see `WetTileMask`).
     * Within a substep each tile reads the fields as they were before it (its own and its
     * neighbours') and writes only its own next fields, so tiles run on up to `threads` threads
     * and give the same bits as one. `steppedTiles` then lists the tiles that had wet cells.
     */
    @discardableResult
    public func step(_ wetSteps: Int, isWetCell: WetCellPredicate, canWakeTile: ((Int, Int) -> Bool)? = nil, wetTile: WetTileMask? = nil, threads: Int = Swift.max(1, ProcessInfo.processInfo.activeProcessorCount)) -> Bool {
        steppedTiles = []
        if !enabled || tiles.isEmpty || wetSteps <= 0 { return false }
        let totalSubsteps = Swift.max(1, wetSteps) * PATTERN_SUBSTEPS
        let F = settings.feed
        let k = settings.kill
        let fk = F + k
        let scaleClamped = Swift.min(2.2, Swift.max(0.4, settings.scale))
        let Du = 0.16 * scaleClamped
        let Dv = 0.08 * scaleClamped

        // Wake neighboring pattern tiles if active reagent reaches within 2 cells of a tile edge.
        let initialEntries = Array(tiles)
        for (key, tile) in initialEntries {
            let (tx, ty) = tileCoord(key)
            var top = false, bottom = false, left = false, right = false
            tile.v.withUnsafeBufferPointer { v in
                for i in 0..<PATTERN_TILE {
                    if v[i] > PATTERN_V_EPS || v[PATTERN_TILE + i] > PATTERN_V_EPS { top = true }
                    if v[(PATTERN_TILE - 1) * PATTERN_TILE + i] > PATTERN_V_EPS || v[(PATTERN_TILE - 2) * PATTERN_TILE + i] > PATTERN_V_EPS { bottom = true }
                    if v[i * PATTERN_TILE] > PATTERN_V_EPS || v[i * PATTERN_TILE + 1] > PATTERN_V_EPS { left = true }
                    if v[i * PATTERN_TILE + PATTERN_TILE - 1] > PATTERN_V_EPS || v[i * PATTERN_TILE + PATTERN_TILE - 2] > PATTERN_V_EPS { right = true }
                }
            }
            func wake(_ nx: Int, _ ny: Int) {
                if nx < 0 || ny < 0 || nx >= tilesX || ny >= tilesY { return }
                if let canWakeTile, !canWakeTile(nx, ny) { return }
                _ = ensureTile(nx, ny)
            }
            if top { wake(tx, ty - 1) }
            if bottom { wake(tx, ty + 1) }
            if left { wake(tx - 1, ty) }
            if right { wake(tx + 1, ty) }
        }

        // Which cells are wet, tile by tile (the same for every substep).
        let count = tiles.count
        let keys = tiles.keys
        let coords = keys.map(tileCoord)
        let masks = UnsafeMutablePointer<UInt8>.allocate(capacity: count * PATTERN_CELLS)
        masks.initialize(repeating: 0, count: count * PATTERN_CELLS)
        defer { masks.deallocate() }
        var hasWet = [Bool](repeating: false, count: count)
        let anyWet: Bool
        let maxHalfW = Int(JS.ceil(Double(width) * 0.5))
        let maxHalfH = Int(JS.ceil(Double(height) * 0.5))
        hasWet.withUnsafeMutableBufferPointer { hasWet in
            nonisolated(unsafe) let hasWet = hasWet
            nonisolated(unsafe) let masks = masks
            // The tile reader fills each tile's own mask: on every thread. The cell predicate is asked in order.
            patternParallel(count, wetTile != nil ? Swift.min(threads, count) : 1) { i in
                let (tx, ty) = coords[i]
                let tileW = Swift.min(PATTERN_TILE, maxHalfW - tx * PATTERN_TILE)
                let tileH = Swift.min(PATTERN_TILE, maxHalfH - ty * PATTERN_TILE)
                if tileH <= 0 || tileW <= 0 { return }
                let mask = masks + i * PATTERN_CELLS
                if let wetTile {
                    hasWet[i] = wetTile(tx, ty, tileW, tileH, mask)
                } else {
                    for ly in 0..<tileH {
                        for lx in 0..<tileW where isWetCell(tx, ty, lx, ly) {
                            mask[ly * PATTERN_TILE + lx] = 1
                            hasWet[i] = true
                        }
                    }
                }
            }
        }
        anyWet = hasWet.contains(true)

        if !anyWet { return false }

        // Each tile's fields, `U` then `V`: the current ones, and for a tile with wet cells the
        // next ones too. The two swap after every substep. A dry cell never changes, so both hold
        // its value from the start and a substep writes the wet cells only.
        let fieldSize = 2 * PATTERN_CELLS
        var current: [UnsafeMutablePointer<Double>] = []
        var next = [UnsafeMutablePointer<Double>?](repeating: nil, count: count)
        current.reserveCapacity(count)
        var index: [TileKey: Int] = [:]
        for i in 0..<count {
            let tile = tiles.get(keys[i])!
            let cur = UnsafeMutablePointer<Double>.allocate(capacity: fieldSize)
            tile.u.withUnsafeBufferPointer { cur.initialize(from: $0.baseAddress!, count: PATTERN_CELLS) }
            tile.v.withUnsafeBufferPointer { (cur + PATTERN_CELLS).initialize(from: $0.baseAddress!, count: PATTERN_CELLS) }
            current.append(cur)
            if hasWet[i] {
                let n = UnsafeMutablePointer<Double>.allocate(capacity: fieldSize)
                n.initialize(from: cur, count: fieldSize)
                next[i] = n
            }
            index[keys[i]] = i
        }
        defer {
            for c in current { c.deallocate() }
            for n in next { n?.deallocate() }
        }
        // The eight tiles around each tile (row by row, itself in the middle), or -1.
        var around = [Int](repeating: -1, count: count * 9)
        for i in 0..<count {
            let (tx, ty) = coords[i]
            for dy in -1...1 {
                for dx in -1...1 {
                    around[i * 9 + (dy + 1) * 3 + dx + 1] = index[tileKey(tx + dx, ty + dy)] ?? -1
                }
            }
        }
        let wetEntries = (0..<count).filter { hasWet[$0] }
        let workers = Swift.max(1, Swift.min(threads, wetEntries.count))
        let last = PATTERN_TILE - 1

        for _ in 0..<totalSubsteps {
            current.withUnsafeBufferPointer { current in
                next.withUnsafeBufferPointer { next in
                    around.withUnsafeBufferPointer { around in
                        nonisolated(unsafe) let masks = masks
                        patternParallel(wetEntries.count, workers) { w in
                            let i = wetEntries[w]
                            let u = UnsafePointer(current[i]), v = u + PATTERN_CELLS
                            let nextU = next[i]!, nextV = nextU + PATTERN_CELLS
                            let wet = masks + i * PATTERN_CELLS
                            let nb = around.baseAddress! + i * 9
                            // `U` and `V` at a cell that may lie in a neighbouring tile (the tile's own edge cell where there is none).
                            func sampleUV(_ lx: Int, _ ly: Int) -> (Double, Double) {
                                let dx = lx < 0 ? -1 : lx > last ? 1 : 0
                                let dy = ly < 0 ? -1 : ly > last ? 1 : 0
                                if dx == 0 && dy == 0 {
                                    let idx = ly * PATTERN_TILE + lx
                                    return (u[idx], v[idx])
                                }
                                let n = nb[(dy + 1) * 3 + dx + 1]
                                if n < 0 {
                                    let cx = Swift.min(last, Swift.max(0, lx))
                                    let cy = Swift.min(last, Swift.max(0, ly))
                                    let idx = cy * PATTERN_TILE + cx
                                    return (u[idx], v[idx])
                                }
                                let nu = UnsafePointer(current[n])
                                let idx = (ly - dy * PATTERN_TILE) * PATTERN_TILE + (lx - dx * PATTERN_TILE)
                                return (nu[idx], nu[PATTERN_CELLS + idx])
                            }
                            for ly in 0..<PATTERN_TILE {
                                let row = ly * PATTERN_TILE
                                let interiorY = ly > 0 && ly < last
                                for lx in 0..<PATTERN_TILE {
                                    let idx = row + lx
                                    if wet[idx] == 0 { continue }
                                    let uc = u[idx]
                                    let vc = v[idx]
                                    var lapU = -uc
                                    var lapV = -vc
                                    if interiorY && lx > 0 && lx < last {
                                        let n = idx - PATTERN_TILE
                                        let so = idx + PATTERN_TILE
                                        lapU += 0.2 * (u[idx - 1] + u[idx + 1] + u[n] + u[so]) +
                                            0.05 * (u[n - 1] + u[n + 1] + u[so - 1] + u[so + 1])
                                        lapV += 0.2 * (v[idx - 1] + v[idx + 1] + v[n] + v[so]) +
                                            0.05 * (v[n - 1] + v[n + 1] + v[so - 1] + v[so + 1])
                                    } else {
                                        let (uW, vW) = sampleUV(lx - 1, ly)
                                        lapU += 0.2 * uW; lapV += 0.2 * vW
                                        let (uE, vE) = sampleUV(lx + 1, ly)
                                        lapU += 0.2 * uE; lapV += 0.2 * vE
                                        let (uN, vN) = sampleUV(lx, ly - 1)
                                        lapU += 0.2 * uN; lapV += 0.2 * vN
                                        let (uS, vS) = sampleUV(lx, ly + 1)
                                        lapU += 0.2 * uS; lapV += 0.2 * vS
                                        let (uNW, vNW) = sampleUV(lx - 1, ly - 1)
                                        lapU += 0.05 * uNW; lapV += 0.05 * vNW
                                        let (uNE, vNE) = sampleUV(lx + 1, ly - 1)
                                        lapU += 0.05 * uNE; lapV += 0.05 * vNE
                                        let (uSW, vSW) = sampleUV(lx - 1, ly + 1)
                                        lapU += 0.05 * uSW; lapV += 0.05 * vSW
                                        let (uSE, vSE) = sampleUV(lx + 1, ly + 1)
                                        lapU += 0.05 * uSE; lapV += 0.05 * vSE
                                    }
                                    let uvv = uc * vc * vc
                                    let nu = uc + Du * lapU - uvv + F * (1 - uc)
                                    let nv = vc + Dv * lapV + uvv - fk * vc
                                    nextU[idx] = nu < 0 ? 0 : nu > 1 ? 1 : nu
                                    nextV[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv
                                }
                            }
                        }
                    }
                }
            }
            for i in wetEntries {
                let c = current[i]
                current[i] = next[i]!
                next[i] = c
            }
        }

        for i in wetEntries {
            if var tile = tiles.get(keys[i]) {
                tile.u = [Double](UnsafeBufferPointer(start: current[i], count: PATTERN_CELLS))
                tile.v = [Double](UnsafeBufferPointer(start: current[i] + PATTERN_CELLS, count: PATTERN_CELLS))
                setTile(keys[i], tile, vChanged: true)
            }
            steppedTiles.append(keys[i])
        }
        return true
    }

    private func sampleUnbakedV(_ tile: LivePatternTileState, _ x: Int, _ y: Int) -> Double {
        let fx = Swift.min(Double(PATTERN_TILE - 1), Swift.max(0, (Double(x) + 0.5) * 0.5 - 0.5))
        let fy = Swift.min(Double(PATTERN_TILE - 1), Swift.max(0, (Double(y) + 0.5) * 0.5 - 0.5))
        let x0 = Int(JS.floor(fx))
        let y0 = Int(JS.floor(fy))
        let x1 = Swift.min(PATTERN_TILE - 1, x0 + 1)
        let y1 = Swift.min(PATTERN_TILE - 1, y0 + 1)
        let tx = fx - Double(x0)
        let ty = fy - Double(y0)
        func at(_ ix: Int, _ iy: Int) -> Double {
            let idx = iy * PATTERN_TILE + ix
            let val = tile.v[idx] - tile.bakedV[idx]
            return val > 0 ? val : 0
        }
        let v00 = at(x0, y0)
        let v10 = at(x1, y0)
        let v01 = at(x0, y1)
        let v11 = at(x1, y1)
        let top = v00 + (v10 - v00) * tx
        let bot = v01 + (v11 - v01) * tx
        return top + (bot - top) * ty
    }

    /// Blends the pattern's `V` concentration into a shaded `256 × 256` RGBA wet tile `out`.
    public func shadeTile(_ tx: Int, _ ty: Int, _ out: inout [UInt8], _ w: Int, _ h: Int) -> Bool {
        if !enabled || settings.contrast <= 0 { return false }
        guard let tile = tiles.get(tileKey(tx, ty)) else { return false }
        let second = parsePatternHexColor(settings.secondColor)
        let contrast = settings.contrast
        var changed = false

        for y in 0..<h {
            for x in 0..<w {
                let i = (y * TILE + x) * 4
                let a = Double(out[i + 3])
                if a == 0 { continue }
                let vVal = sampleUnbakedV(tile, x, y)
                if vVal <= 1e-4 { continue }
                let t = Swift.min(1, vVal * 2.2 * contrast)
                if t <= 1e-3 { continue }
                let r0 = Double(out[i]), g0 = Double(out[i + 1]), b0 = Double(out[i + 2])
                if let second {
                    out[i] = JS.u8c(JS.round(r0 + (Double(second[0]) - r0) * t))
                    out[i + 1] = JS.u8c(JS.round(g0 + (Double(second[1]) - g0) * t))
                    out[i + 2] = JS.u8c(JS.round(b0 + (Double(second[2]) - b0) * t))
                    out[i + 3] = JS.u8c(Swift.min(255, JS.round(a + (255 - a) * t * 0.35)))
                } else {
                    let lum = (Int(out[i]) * 77 + Int(out[i + 1]) * 150 + Int(out[i + 2]) * 29) >> 8
                    if lum < 48 {
                        out[i] = JS.u8c(JS.round(r0 + (220 - r0) * 0.4 * t))
                        out[i + 1] = JS.u8c(JS.round(g0 + (220 - g0) * 0.4 * t))
                        out[i + 2] = JS.u8c(JS.round(b0 + (220 - b0) * 0.4 * t))
                    } else {
                        let scale = 1 - 0.45 * t
                        out[i] = JS.u8c(JS.round(r0 * scale))
                        out[i + 1] = JS.u8c(JS.round(g0 * scale))
                        out[i + 2] = JS.u8c(JS.round(b0 * scale))
                    }
                    out[i + 3] = JS.u8c(Swift.min(255, JS.round(a + (255 - a) * t * 0.28)))
                }
                changed = true
            }
        }
        return changed
    }

    /// Marks a tile's current `V` values as baked into the layer's base surface so they are not baked twice.
    public func markBaked(_ tx: Int, _ ty: Int) {
        let key = tileKey(tx, ty)
        if var tile = tiles.get(key) {
            tile.bakedV = tile.v
            setTile(key, tile, vChanged: false)
        }
    }

    /**
     * When `settings.relief > 0`, writes pattern `V` ridges into a 1-channel thick height surface.
     *
     * A ridge only ever raises the height, so writing a tile's `V` into the height tile the last
     * call left changes nothing: tiles whose `V` has not changed since, and whose height tile is
     * still that object, are skipped. The rest are written on every core (each reads its own
     * pattern tile and height tile only).
     */
    public func applyReliefHeight(_ currentHeight: TiledSurface) -> TiledSurface {
        let relief = settings.relief
        if !enabled || relief <= 0 || tiles.isEmpty { return currentHeight }
        if reliefAll || reliefKey != (relief, width, height) {
            reliefSeen = [:]
            reliefChanged = []
            reliefAll = false
            reliefKey = (relief, width, height)
        }
        var work: [(key: TileKey, pattern: LivePatternTileState, existing: Tile?, w: Int, h: Int)] = []
        for (key, pTile) in tiles {
            let (tx, ty) = tileCoord(key)
            let w = Swift.min(TILE, width - tx * TILE)
            let h = Swift.min(TILE, height - ty * TILE)
            if w <= 0 || h <= 0 { continue }
            let existing = currentHeight.tiles.get(key)
            if !reliefChanged.contains(key), let seen = reliefSeen[key], seen === existing { continue }
            work.append((key, pTile, existing, w, h))
        }
        reliefChanged = []
        if work.isEmpty { return currentHeight }
        // Per tile: nil when the tile stays as it is, else its new bytes.
        var raised = [[UInt8]?](repeating: nil, count: work.count)
        raised.withUnsafeMutableBufferPointer { out in
            nonisolated(unsafe) let out = out
            paintParallel(work.count) { i in out[i] = reliefTile(work[i].pattern.v, work[i].existing, work[i].w, work[i].h, relief) }
        }
        var nextTiles: OrderedMap<TileKey, Tile>? = nil
        for (i, item) in work.enumerated() {
            guard let buf = raised[i] else {
                reliefSeen[item.key] = .some(item.existing)
                continue
            }
            if nextTiles == nil { nextTiles = currentHeight.tiles }
            let finished = finishTile(buf, 1, 0)
            if let finished {
                nextTiles!.set(item.key, finished)
            } else {
                _ = nextTiles!.delete(item.key)
            }
            reliefSeen[item.key] = .some(finished)
        }
        return nextTiles.map { TiledSurface(channels: 1, tiles: $0, defaultValue: 0) } ?? currentHeight
    }

    /// Computes summary statistics of the layer's live pattern field.
    public func stats(_ isWetCell: WetCellPredicate? = nil) -> LivePatternStats {
        if !enabled || tiles.isEmpty {
            return LivePatternStats(
                enabled: enabled,
                settings: settings,
                activeTiles: 0,
                patternCells: 0,
                wetPatternCells: 0,
                meanV: 0,
                maxV: 0,
                bounds: nil
            )
        }
        var activeTiles = 0
        var patternCells = 0
        var wetPatternCells = 0
        var sumV = 0.0
        var maxV = 0.0
        var bx0 = Int.max, by0 = Int.max, bx1 = Int.min, by1 = Int.min
        let maxHalfW = Int(JS.ceil(Double(width) * 0.5))
        let maxHalfH = Int(JS.ceil(Double(height) * 0.5))

        for (key, tile) in tiles {
            let (tx, ty) = tileCoord(key)
            let tileW = Swift.min(PATTERN_TILE, maxHalfW - tx * PATTERN_TILE)
            let tileH = Swift.min(PATTERN_TILE, maxHalfH - ty * PATTERN_TILE)
            var tileHasCells = false
            if tileH > 0 && tileW > 0 {
                for ly in 0..<tileH {
                    let row = ly * PATTERN_TILE
                    for lx in 0..<tileW {
                        let val = tile.v[row + lx]
                        if val > maxV { maxV = val }
                        if val >= PATTERN_V_EPS {
                            tileHasCells = true
                            patternCells += 1
                            sumV += val
                            if let isWetCell, isWetCell(tx, ty, lx, ly) { wetPatternCells += 1 }
                            let gx0 = (tx * PATTERN_TILE + lx) * 2
                            let gy0 = (ty * PATTERN_TILE + ly) * 2
                            let gx1 = Swift.min(width, gx0 + 2)
                            let gy1 = Swift.min(height, gy0 + 2)
                            if gx0 < bx0 { bx0 = gx0 }
                            if gy0 < by0 { by0 = gy0 }
                            if gx1 > bx1 { bx1 = gx1 }
                            if gy1 > by1 { by1 = gy1 }
                        }
                    }
                }
            }
            if tileHasCells { activeTiles += 1 }
        }

        return LivePatternStats(
            enabled: enabled,
            settings: settings,
            activeTiles: activeTiles,
            patternCells: patternCells,
            wetPatternCells: wetPatternCells,
            meanV: patternCells > 0 ? round4(sumV / Double(patternCells)) : 0,
            maxV: round4(maxV),
            bounds: patternCells > 0 ? RasterRect(x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0) : nil
        )
    }

    public func snapshot() -> LivePatternFieldSnapshot {
        var copy = OrderedMap<TileKey, LivePatternTileState>()
        var bytes = 0
        for (key, t) in tiles {
            copy.set(key, LivePatternTileState(u: t.u, v: t.v, bakedV: t.bakedV))
            bytes += (t.u.count + t.v.count + t.bakedV.count) * 8
        }
        return LivePatternFieldSnapshot(settings: settings, enabled: enabled, tiles: copy, bytes: bytes)
    }

    public func restore(_ snap: LivePatternFieldSnapshot) {
        settings = snap.settings
        enabled = snap.enabled
        var copy = OrderedMap<TileKey, LivePatternTileState>()
        for (key, t) in snap.tiles {
            copy.set(key, LivePatternTileState(u: t.u, v: t.v, bakedV: t.bakedV))
        }
        tiles = copy
    }
}

/// Shifts a `LivePatternFieldSnapshot` by `(tx0, ty0)` whole wet tiles for a resized canvas `to`.
public func moveLivePatternSnapshot(_ snap: LivePatternFieldSnapshot, to: (width: Int, height: Int), tx0: Int, ty0: Int) -> LivePatternFieldSnapshot {
    let maxTilesX = Int(JS.ceil(Double(to.width) / Double(TILE)))
    let maxTilesY = Int(JS.ceil(Double(to.height) / Double(TILE)))
    var moved = OrderedMap<TileKey, LivePatternTileState>()
    var bytes = 0
    for (key, t) in snap.tiles {
        let (tx, ty) = tileCoord(key)
        let ntx = tx + tx0
        let nty = ty + ty0
        if ntx < 0 || nty < 0 || ntx >= maxTilesX || nty >= maxTilesY { continue }
        moved.set(tileKey(ntx, nty), t)
        bytes += (t.u.count + t.v.count + t.bakedV.count) * 8
    }
    return LivePatternFieldSnapshot(settings: snap.settings, enabled: snap.enabled, tiles: moved, bytes: bytes)
}
