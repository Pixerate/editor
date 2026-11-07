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

/// Per-wet-layer Gray-Scott reaction-diffusion field `(U, V)` stored in `128 × 128` tiles.
public final class LivePatternField {
    public var width: Int
    public var height: Int
    public var tilesX: Int
    public var tilesY: Int
    public var settings: LivePatternsSettings = DEFAULT_LIVE_PATTERNS
    public var enabled = false
    public var tiles = OrderedMap<TileKey, LivePatternTileState>()

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
            tiles.set(key, LivePatternTileState(
                u: [Double](repeating: 1, count: PATTERN_CELLS),
                v: [Double](repeating: 0, count: PATTERN_CELLS),
                bakedV: [Double](repeating: 0, count: PATTERN_CELLS)
            ))
        }
        return key
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
                        tiles.set(key, tile)
                        seeded += 1
                    } else if tile.v[idx] == 0 && tile.u[idx] == 1 {
                        tile.u[idx] = 0.99 - 0.02 * fine * s
                        tile.bakedV[idx] = 0
                        tiles.set(key, tile)
                    }
                }
            }
        }
        return seeded
    }

    /**
     * Advances the Gray-Scott reaction-diffusion field for `wetSteps` wet simulation steps.
     * Only cells where `isWetCell(tx, ty, lx, ly)` is true update; dry cells have zero rate and freeze.
     */
    @discardableResult
    public func step(_ wetSteps: Int, isWetCell: WetCellPredicate, canWakeTile: ((Int, Int) -> Bool)? = nil) -> Bool {
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
            for i in 0..<PATTERN_TILE {
                if tile.v[i] > PATTERN_V_EPS || tile.v[PATTERN_TILE + i] > PATTERN_V_EPS { top = true }
                if tile.v[(PATTERN_TILE - 1) * PATTERN_TILE + i] > PATTERN_V_EPS || tile.v[(PATTERN_TILE - 2) * PATTERN_TILE + i] > PATTERN_V_EPS { bottom = true }
                if tile.v[i * PATTERN_TILE] > PATTERN_V_EPS || tile.v[i * PATTERN_TILE + 1] > PATTERN_V_EPS { left = true }
                if tile.v[i * PATTERN_TILE + PATTERN_TILE - 1] > PATTERN_V_EPS || tile.v[i * PATTERN_TILE + PATTERN_TILE - 2] > PATTERN_V_EPS { right = true }
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

        final class StepEntry {
            let key: TileKey
            let tx: Int
            let ty: Int
            var u: [Double]
            var v: [Double]
            var nextU: [Double]
            var nextV: [Double]
            let wet: [UInt8]
            let hasWet: Bool

            init(key: TileKey, tx: Int, ty: Int, u: [Double], v: [Double], wet: [UInt8], hasWet: Bool) {
                self.key = key
                self.tx = tx
                self.ty = ty
                self.u = u
                self.v = v
                self.nextU = u
                self.nextV = v
                self.wet = wet
                self.hasWet = hasWet
            }
        }

        var entries: [StepEntry] = []
        var byKey: [TileKey: StepEntry] = [:]
        var anyWet = false
        let maxHalfW = Int(JS.ceil(Double(width) * 0.5))
        let maxHalfH = Int(JS.ceil(Double(height) * 0.5))

        for (key, tile) in tiles {
            let (tx, ty) = tileCoord(key)
            var wet = [UInt8](repeating: 0, count: PATTERN_CELLS)
            var hasWet = false
            let tileW = Swift.min(PATTERN_TILE, maxHalfW - tx * PATTERN_TILE)
            let tileH = Swift.min(PATTERN_TILE, maxHalfH - ty * PATTERN_TILE)
            if tileH > 0 && tileW > 0 {
                for ly in 0..<tileH {
                    for lx in 0..<tileW {
                        if isWetCell(tx, ty, lx, ly) {
                            wet[ly * PATTERN_TILE + lx] = 1
                            hasWet = true
                            anyWet = true
                        }
                    }
                }
            }
            let e = StepEntry(key: key, tx: tx, ty: ty, u: tile.u, v: tile.v, wet: wet, hasWet: hasWet)
            entries.append(e)
            byKey[key] = e
        }

        if !anyWet { return false }

        func sampleUV(_ entry: StepEntry, _ lx: Int, _ ly: Int) -> (Double, Double) {
            if lx >= 0 && lx < PATTERN_TILE && ly >= 0 && ly < PATTERN_TILE {
                let idx = ly * PATTERN_TILE + lx
                return (entry.u[idx], entry.v[idx])
            }
            var ntx = entry.tx
            var nty = entry.ty
            var nlx = lx
            var nly = ly
            if nlx < 0 {
                ntx -= 1
                nlx += PATTERN_TILE
            } else if nlx >= PATTERN_TILE {
                ntx += 1
                nlx -= PATTERN_TILE
            }
            if nly < 0 {
                nty -= 1
                nly += PATTERN_TILE
            } else if nly >= PATTERN_TILE {
                nty += 1
                nly -= PATTERN_TILE
            }
            guard let nb = byKey[tileKey(ntx, nty)] else {
                let cx = Swift.min(PATTERN_TILE - 1, Swift.max(0, lx))
                let cy = Swift.min(PATTERN_TILE - 1, Swift.max(0, ly))
                let idx = cy * PATTERN_TILE + cx
                return (entry.u[idx], entry.v[idx])
            }
            let idx = nly * PATTERN_TILE + nlx
            return (nb.u[idx], nb.v[idx])
        }

        for _ in 0..<totalSubsteps {
            for e in entries where e.hasWet {
                for ly in 0..<PATTERN_TILE {
                    let row = ly * PATTERN_TILE
                    let interiorY = ly > 0 && ly < PATTERN_TILE - 1
                    for lx in 0..<PATTERN_TILE {
                        let idx = row + lx
                        if e.wet[idx] == 0 {
                            e.nextU[idx] = e.u[idx]
                            e.nextV[idx] = e.v[idx]
                            continue
                        }
                        let uc = e.u[idx]
                        let vc = e.v[idx]
                        var lapU = -uc
                        var lapV = -vc
                        if interiorY && lx > 0 && lx < PATTERN_TILE - 1 {
                            let n = idx - PATTERN_TILE
                            let so = idx + PATTERN_TILE
                            lapU += 0.2 * (e.u[idx - 1] + e.u[idx + 1] + e.u[n] + e.u[so]) +
                                0.05 * (e.u[n - 1] + e.u[n + 1] + e.u[so - 1] + e.u[so + 1])
                            lapV += 0.2 * (e.v[idx - 1] + e.v[idx + 1] + e.v[n] + e.v[so]) +
                                0.05 * (e.v[n - 1] + e.v[n + 1] + e.v[so - 1] + e.v[so + 1])
                        } else {
                            let (uW, vW) = sampleUV(e, lx - 1, ly)
                            lapU += 0.2 * uW; lapV += 0.2 * vW
                            let (uE, vE) = sampleUV(e, lx + 1, ly)
                            lapU += 0.2 * uE; lapV += 0.2 * vE
                            let (uN, vN) = sampleUV(e, lx, ly - 1)
                            lapU += 0.2 * uN; lapV += 0.2 * vN
                            let (uS, vS) = sampleUV(e, lx, ly + 1)
                            lapU += 0.2 * uS; lapV += 0.2 * vS
                            let (uNW, vNW) = sampleUV(e, lx - 1, ly - 1)
                            lapU += 0.05 * uNW; lapV += 0.05 * vNW
                            let (uNE, vNE) = sampleUV(e, lx + 1, ly - 1)
                            lapU += 0.05 * uNE; lapV += 0.05 * vNE
                            let (uSW, vSW) = sampleUV(e, lx - 1, ly + 1)
                            lapU += 0.05 * uSW; lapV += 0.05 * vSW
                            let (uSE, vSE) = sampleUV(e, lx + 1, ly + 1)
                            lapU += 0.05 * uSE; lapV += 0.05 * vSE
                        }
                        let uvv = uc * vc * vc
                        let nu = uc + Du * lapU - uvv + F * (1 - uc)
                        let nv = vc + Dv * lapV + uvv - fk * vc
                        e.nextU[idx] = nu < 0 ? 0 : nu > 1 ? 1 : nu
                        e.nextV[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv
                    }
                }
            }
            for e in entries where e.hasWet {
                e.u = e.nextU
                e.v = e.nextV
            }
        }

        for e in entries where e.hasWet {
            if var tile = tiles.get(e.key) {
                tile.u = e.u
                tile.v = e.v
                tiles.set(e.key, tile)
            }
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
            tiles.set(key, tile)
        }
    }

    /// When `settings.relief > 0`, writes pattern `V` ridges into a 1-channel thick height surface.
    public func applyReliefHeight(_ currentHeight: TiledSurface) -> TiledSurface {
        let relief = settings.relief
        if !enabled || relief <= 0 || tiles.isEmpty { return currentHeight }
        var nextTiles: OrderedMap<TileKey, Tile>? = nil
        for (key, pTile) in tiles {
            let (tx, ty) = tileCoord(key)
            let w = Swift.min(TILE, width - tx * TILE)
            let h = Swift.min(TILE, height - ty * TILE)
            if w <= 0 || h <= 0 { continue }
            var maxTileV = 0.0
            for i in 0..<PATTERN_CELLS where pTile.v[i] > maxTileV { maxTileV = pTile.v[i] }
            if maxTileV < PATTERN_V_EPS { continue }
            let existing = currentHeight.tiles.get(key)
            var buf: [UInt8]
            if let existing {
                buf = !existing.data.isEmpty ? existing.data : [UInt8](repeating: UInt8(truncatingIfNeeded: existing.uniform ?? 0), count: TILE * TILE)
            } else {
                buf = [UInt8](repeating: 0, count: TILE * TILE)
            }
            var tileChanged = false
            for y in 0..<h {
                let ly = y >> 1
                let row = ly * PATTERN_TILE
                for x in 0..<w {
                    let vVal = pTile.v[row + (x >> 1)]
                    if vVal < PATTERN_V_EPS { continue }
                    let ridge = JS.u8c(Swift.min(255, JS.round(Swift.min(1, vVal * 2.2) * relief * 255)))
                    let p = y * TILE + x
                    if ridge > buf[p] {
                        buf[p] = ridge
                        tileChanged = true
                    }
                }
            }
            if tileChanged {
                if nextTiles == nil { nextTiles = currentHeight.tiles }
                if let finished = finishTile(buf, 1, 0) {
                    nextTiles!.set(key, finished)
                } else {
                    _ = nextTiles!.delete(key)
                }
            }
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
