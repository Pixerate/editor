import Foundation
import PixerateCore
import PixerateRaster

/**
 * Biopaint (`paint/culture.ts` and the controller's culture section): living mycelial ink that seeds
 * spores along a brush stroke, grows outward as branching hyphal threads, senses existing paint on
 * the layer (chemotaxis), digests what it crosses and transports the eaten colour downstream along
 * the network, and fuses (anastomosis) when threads meet.
 *
 * All simulation state and math (positions in 1/256 px fixed-point, headings 0..1023 via an
 * integer cosine table, 32-bit integer hashing, 8-bit pixel sensing, and permille parameters) are
 * integer-exact so TypeScript and Swift produce bit-identical pixels and tip states across ticks.
 */

public let CULTURE_SPECIES = ["mycelium"]
public let MAX_CULTURE_TIPS = 2000
public let MAX_CULTURE_SEGMENTS = 200_000
public let MAX_CATCH_UP_TICKS = 5000
public let CULTURE_TICKS_PER_SECOND = 24
public let CULTURE_FP = 256
public let CULTURE_ANGLE_STEPS = 1024
public let CULTURE_ANGLE_MASK = 1023

/// Brush `culture` facet settings.
public struct CultureSettings: Equatable, Sendable {
    public var species: String
    public var reach: Double
    public var branching: Double
    public var wander: Double
    public var appetite: Double
    public var digest: Double
    public var fuse: Double
    public var thickness: Double
    public var glow: Double

    public init(
        species: String = "mycelium",
        reach: Double = 12,
        branching: Double = 0.4,
        wander: Double = 0.35,
        appetite: Double = 0.5,
        digest: Double = 0.25,
        fuse: Double = 0.7,
        thickness: Double = 0.08,
        glow: Double = 0
    ) {
        self.species = species
        self.reach = reach
        self.branching = branching
        self.wander = wander
        self.appetite = appetite
        self.digest = digest
        self.fuse = fuse
        self.thickness = thickness
        self.glow = glow
    }

    public var json: JSONValue {
        [
            "species": .string(species),
            "reach": .number(reach),
            "branching": .number(branching),
            "wander": .number(wander),
            "appetite": .number(appetite),
            "digest": .number(digest),
            "fuse": .number(fuse),
            "thickness": .number(thickness),
            "glow": .number(glow),
        ]
    }
}

public let DEFAULT_CULTURE = CultureSettings()

private func round4(_ v: Double) -> Double {
    JS.round(v * 10000) / 10000
}

public func normalizeCulture(_ raw: JSONObject, _ base: CultureSettings = DEFAULT_CULTURE) -> CultureSettings {
    let sp = raw["species"]?.stringValue == "mycelium" ? "mycelium" : base.species
    return CultureSettings(
        species: sp,
        reach: round4(rangeValue(raw["reach"], 1, 100, base.reach)),
        branching: round4(unitValue(raw["branching"], base.branching)),
        wander: round4(unitValue(raw["wander"], base.wander)),
        appetite: round4(unitValue(raw["appetite"], base.appetite)),
        digest: round4(unitValue(raw["digest"], base.digest)),
        fuse: round4(unitValue(raw["fuse"], base.fuse)),
        thickness: round4(rangeValue(raw["thickness"], 0.02, 0.5, base.thickness)),
        glow: round4(unitValue(raw["glow"], base.glow))
    )
}

func readCulture(_ raw: JSONValue?, _ base: CultureSettings?) -> CultureSettings? {
    guard let raw else { return base }
    if raw == .null || raw == .bool(false) { return nil }
    guard let r = raw.objectValue else { return base }
    return normalizeCulture(r, base ?? DEFAULT_CULTURE)
}

/// One living hyphal tip.
public struct CultureTip: Equatable, Sendable {
    public var id: Int
    public var x: Int
    public var y: Int
    public var angle: Int
    public var energy: Int
    public var widthFp: Int
    public var r: Int
    public var g: Int
    public var b: Int
    public var age: Int
    public var seed: UInt32
    public var reachPx: Int
    public var branchPermille: Int
    public var wanderPermille: Int
    public var appetitePermille: Int
    public var digestPermille: Int
    public var fusePermille: Int
    public var glowPermille: Int

    public var json: JSONValue {
        [
            "id": .number(Double(id)),
            "x": .number(Double(x)),
            "y": .number(Double(y)),
            "angle": .number(Double(angle)),
            "energy": .number(Double(energy)),
            "widthFp": .number(Double(widthFp)),
            "r": .number(Double(r)),
            "g": .number(Double(g)),
            "b": .number(Double(b)),
            "age": .number(Double(age)),
            "seed": .number(Double(seed)),
            "reachPx": .number(Double(reachPx)),
            "branchPermille": .number(Double(branchPermille)),
            "wanderPermille": .number(Double(wanderPermille)),
            "appetitePermille": .number(Double(appetitePermille)),
            "digestPermille": .number(Double(digestPermille)),
            "fusePermille": .number(Double(fusePermille)),
            "glowPermille": .number(Double(glowPermille)),
        ]
    }
}

/// Per-layer culture state (`doc.cultures[layerId]`).
public struct LayerCultureState: Sendable {
    public var tick: Int
    public var nextId: Int
    public var tips: [CultureTip]
    public var occupancy: TiledSurface
    public var segmentsTotal: Int
    public var status: String

    public init(
        tick: Int = 0,
        nextId: Int = 1,
        tips: [CultureTip] = [],
        occupancy: TiledSurface = emptySurface(1, 0),
        segmentsTotal: Int = 0,
        status: String = "extinct"
    ) {
        self.tick = tick
        self.nextId = nextId
        self.tips = tips
        self.occupancy = occupancy
        self.segmentsTotal = segmentsTotal
        self.status = status
    }
}

public typealias LayerCulture = LayerCultureState

public struct CultureRecordedFade: Equatable, Sendable {
    public var x: Int
    public var y: Int
    public var radius: Int
    public var fadePermille: Int

    public var json: JSONValue {
        [
            "x": .number(Double(x)),
            "y": .number(Double(y)),
            "radius": .number(Double(radius)),
            "fadePermille": .number(Double(fadePermille)),
        ]
    }
}

public struct CultureRecordedSegment: Equatable, Sendable {
    public var x0: Int
    public var y0: Int
    public var x1: Int
    public var y1: Int
    public var widthFp: Int
    public var r: Int
    public var g: Int
    public var b: Int
    public var alpha: Int
    public var glowPermille: Int

    public var json: JSONValue {
        [
            "x0": .number(Double(x0)),
            "y0": .number(Double(y0)),
            "x1": .number(Double(x1)),
            "y1": .number(Double(y1)),
            "widthFp": .number(Double(widthFp)),
            "r": .number(Double(r)),
            "g": .number(Double(g)),
            "b": .number(Double(b)),
            "alpha": .number(Double(alpha)),
            "glowPermille": .number(Double(glowPermille)),
        ]
    }
}

public struct CultureGrowEventData: Equatable, Sendable {
    public var steps: Int
    public var fades: [CultureRecordedFade]
    public var segments: [CultureRecordedSegment]

    public var json: JSONObject {
        [
            "steps": .number(Double(steps)),
            "fades": .array(fades.map(\.json)),
            "segments": .array(segments.map(\.json)),
        ]
    }
}

public struct LayerCultureSummary: Equatable, Sendable {
    public var layerId: String
    public var tick: Int
    public var tips: Int
    public var segments: Int
    public var bounds: RasterRect?
    public var status: String

    public var json: JSONValue {
        [
            "layerId": .string(layerId),
            "tick": .number(Double(tick)),
            "tips": .number(Double(tips)),
            "segments": .number(Double(segments)),
            "bounds": rectJSON(bounds),
            "status": .string(status),
        ]
    }
}

// MARK: - Integer math & FastSurface

private let QUARTER_COS: [Int] = [
    256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 255, 255, 255, 255, 255,
    255, 255, 254, 254, 254, 254, 254, 253, 253, 253, 253, 252, 252, 252, 252, 251,
    251, 251, 250, 250, 250, 249, 249, 249, 248, 248, 248, 247, 247, 246, 246, 245,
    245, 245, 244, 244, 243, 243, 242, 242, 241, 241, 240, 239, 239, 238, 238, 237,
    237, 236, 235, 235, 234, 233, 233, 232, 231, 231, 230, 229, 229, 228, 227, 227,
    226, 225, 224, 224, 223, 222, 221, 220, 220, 219, 218, 217, 216, 215, 215, 214,
    213, 212, 211, 210, 209, 208, 207, 207, 206, 205, 204, 203, 202, 201, 200, 199,
    198, 197, 196, 195, 194, 193, 192, 191, 190, 189, 188, 186, 185, 184, 183, 182,
    181, 180, 179, 178, 177, 175, 174, 173, 172, 171, 170, 168, 167, 166, 165, 164,
    162, 161, 160, 159, 157, 156, 155, 154, 152, 151, 150, 149, 147, 146, 145, 144,
    142, 141, 140, 138, 137, 136, 134, 133, 132, 130, 129, 128, 126, 125, 123, 122,
    121, 119, 118, 117, 115, 114, 112, 111, 109, 108, 107, 105, 104, 102, 101, 99,
    98, 97, 95, 94, 92, 91, 89, 88, 86, 85, 83, 82, 80, 79, 77, 76,
    74, 73, 71, 70, 68, 67, 65, 64, 62, 61, 59, 58, 56, 55, 53, 51,
    50, 48, 47, 45, 44, 42, 41, 39, 38, 36, 34, 33, 31, 30, 28, 27,
    25, 24, 22, 20, 19, 17, 16, 14, 13, 11, 9, 8, 6, 5, 3, 2,
    0,
]

@inline(__always)
public func cosFp(_ a: Int) -> Int {
    let q = a & CULTURE_ANGLE_MASK
    if q <= 256 { return QUARTER_COS[q] }
    if q <= 512 { return -QUARTER_COS[512 - q] }
    if q <= 768 { return -QUARTER_COS[q - 512] }
    return QUARTER_COS[1024 - q]
}

@inline(__always)
public func sinFp(_ a: Int) -> Int {
    cosFp((a - 256) & CULTURE_ANGLE_MASK)
}

@inline(__always)
func imul32(_ a: Int, _ b: UInt32) -> UInt32 {
    UInt32(truncatingIfNeeded: a) &* b
}

@inline(__always)
public func cultureHash32(_ x: UInt32) -> UInt32 {
    var h = x
    h = (h ^ (h >> 16)) &* 0x7feb_352d
    h = (h ^ (h >> 15)) &* 0x846c_a68b
    return h ^ (h >> 16)
}

@inline(__always)
public func cultureHash32(_ x: Int) -> UInt32 {
    cultureHash32(UInt32(truncatingIfNeeded: x))
}

@inline(__always)
public func paperGrainByte(_ paperSeed: Int, _ paperDepthPermille: Int, _ x: Int, _ y: Int) -> Int {
    if paperDepthPermille <= 0 { return 128 }
    let cellX = x >> 3
    let cellY = y >> 3
    let fx = (x & 7) * 32
    let fy = (y & 7) * 32
    let seedU = UInt32(truncatingIfNeeded: paperSeed)
    func corner(_ cx: Int, _ cy: Int) -> Int {
        Int(cultureHash32(seedU ^ imul32(cx, 0x9e37_79b1) ^ imul32(cy, 0x85eb_ca6b)) & 255)
    }
    let c00 = corner(cellX, cellY)
    let c10 = corner(cellX + 1, cellY)
    let c01 = corner(cellX, cellY + 1)
    let c11 = corner(cellX + 1, cellY + 1)
    let top = (c00 * (256 - fx) + c10 * fx) >> 8
    let bot = (c01 * (256 - fx) + c11 * fx) >> 8
    let raw = (top * (256 - fy) + bot * fy) >> 8
    return 128 + ((raw - 128) * paperDepthPermille) / 1000
}

@inline(__always)
public func isqrt(_ n: Int) -> Int {
    if n <= 0 { return 0 }
    var x = n
    var y = (x + 1) >> 1
    while y < x {
        x = y
        y = (x + n / x) >> 1
    }
    return x
}

private final class FastSurface {
    let base: TiledSurface
    private var copies: [TileKey: ByteTile] = [:]
    private var order: [TileKey] = []
    private var lastKey: TileKey = -1
    private var lastRead: ByteTile? = nil
    private var lastWriteKey: TileKey = -1
    private var lastWrite: ByteTile? = nil

    init(_ base: TiledSurface) {
        self.base = base
    }

    @inline(__always)
    private func peekTile(_ tx: Int, _ ty: Int) -> ByteTile? {
        let key = tileKey(tx, ty)
        if key == lastKey { return lastRead }
        let bt: ByteTile?
        if let c = copies[key] {
            bt = c
        } else if let src = base.tiles.get(key) {
            bt = ByteTile(src.data)
        } else {
            bt = nil
        }
        lastKey = key
        lastRead = bt
        return bt
    }

    @inline(__always)
    private func writeTile(_ tx: Int, _ ty: Int) -> ByteTile {
        let key = tileKey(tx, ty)
        if key == lastWriteKey, let w = lastWrite { return w }
        let bt: ByteTile
        if let c = copies[key] {
            bt = c
        } else {
            if let src = base.tiles.get(key) {
                bt = ByteTile(src.data)
            } else {
                bt = ByteTile([UInt8](repeating: UInt8(truncatingIfNeeded: base.defaultValue), count: TILE * TILE * base.channels))
            }
            copies[key] = bt
            order.append(key)
        }
        lastKey = key
        lastRead = bt
        lastWriteKey = key
        lastWrite = bt
        return bt
    }

    @inline(__always)
    func readByte(_ x: Int, _ y: Int) -> Int {
        guard let t = peekTile(x >> 8, y >> 8) else { return base.defaultValue }
        return Int(t.data[((y & 255) << 8) | (x & 255)])
    }

    @inline(__always)
    func writeByte(_ x: Int, _ y: Int, _ v: Int) {
        let t = writeTile(x >> 8, y >> 8)
        t.data[((y & 255) << 8) | (x & 255)] = UInt8(Swift.min(255, Swift.max(0, v)))
    }

    @inline(__always)
    func readRgba(_ x: Int, _ y: Int) -> (Int, Int, Int, Int) {
        guard let t = peekTile(x >> 8, y >> 8) else {
            let d = base.defaultValue
            return (d, d, d, d)
        }
        let i = (((y & 255) << 8) | (x & 255)) << 2
        return (Int(t.data[i]), Int(t.data[i + 1]), Int(t.data[i + 2]), Int(t.data[i + 3]))
    }

    @inline(__always)
    func readAlpha(_ x: Int, _ y: Int) -> Int {
        guard let t = peekTile(x >> 8, y >> 8) else { return base.defaultValue }
        let i = (((y & 255) << 8) | (x & 255)) << 2
        return Int(t.data[i + 3])
    }

    @inline(__always)
    func blendRgba(_ x: Int, _ y: Int, _ r: Int, _ g: Int, _ b: Int, _ a: Int, _ lockTransparency: Bool) {
        if a <= 0 { return }
        let t = writeTile(x >> 8, y >> 8)
        let i = (((y & 255) << 8) | (x & 255)) << 2
        let dstR = Int(t.data[i])
        let dstG = Int(t.data[i + 1])
        let dstB = Int(t.data[i + 2])
        let dstA = Int(t.data[i + 3])
        if lockTransparency {
            if dstA == 0 { return }
            t.data[i] = UInt8((r * a + dstR * (255 - a) + 127) / 255)
            t.data[i + 1] = UInt8((g * a + dstG * (255 - a) + 127) / 255)
            t.data[i + 2] = UInt8((b * a + dstB * (255 - a) + 127) / 255)
            return
        }
        if dstA == 0 {
            t.data[i] = UInt8(r)
            t.data[i + 1] = UInt8(g)
            t.data[i + 2] = UInt8(b)
            t.data[i + 3] = UInt8(a)
            return
        }
        let invA = 255 - a
        let outA = a + ((dstA * invA + 127) / 255)
        if outA <= 0 { return }
        let srcWeight = a * 255
        let dstWeight = dstA * invA
        let denom = srcWeight + dstWeight
        t.data[i] = UInt8((r * srcWeight + dstR * dstWeight + (denom >> 1)) / denom)
        t.data[i + 1] = UInt8((g * srcWeight + dstG * dstWeight + (denom >> 1)) / denom)
        t.data[i + 2] = UInt8((b * srcWeight + dstB * dstWeight + (denom >> 1)) / denom)
        t.data[i + 3] = UInt8(outA > 255 ? 255 : outA)
    }

    @inline(__always)
    @discardableResult
    func fadeAlpha(_ x: Int, _ y: Int, _ fadePermille: Int) -> Bool {
        if fadePermille <= 0 { return false }
        guard let t = peekTile(x >> 8, y >> 8) else { return false }
        let i = (((y & 255) << 8) | (x & 255)) << 2
        let dstA = Int(t.data[i + 3])
        if dstA == 0 { return false }
        let w = writeTile(x >> 8, y >> 8)
        let nextA = (dstA * (1000 - fadePermille)) / 1000
        w.data[i + 3] = UInt8(nextA)
        if nextA == 0 {
            w.data[i] = 0
            w.data[i + 1] = 0
            w.data[i + 2] = 0
        }
        return true
    }

    func commit() -> TiledSurface {
        if order.isEmpty { return base }
        var tiles = base.tiles
        let ch = base.channels
        let def = base.defaultValue
        for key in order {
            if let tile = finishTile(copies[key]!.data, ch, def) {
                tiles.set(key, tile)
            } else {
                _ = tiles.delete(key)
            }
        }
        return TiledSurface(channels: ch, tiles: tiles, defaultValue: def)
    }
}

// MARK: - LayerCulture lifecycle & rasterization

public func emptyLayerCulture() -> LayerCultureState {
    LayerCultureState()
}

public func translateLayerCulture(
    _ c: LayerCultureState,
    _ dx: Double,
    _ dy: Double,
    _ canvasWidth: Int,
    _ canvasHeight: Int
) -> LayerCultureState {
    let fdx = Int(JS.round(dx)) * CULTURE_FP
    let fdy = Int(JS.round(dy)) * CULTURE_FP
    let maxX = canvasWidth * CULTURE_FP
    let maxY = canvasHeight * CULTURE_FP
    let tips = c.tips.compactMap { t -> CultureTip? in
        var nt = t
        nt.x += fdx
        nt.y += fdy
        guard nt.x >= 0 && nt.y >= 0 && nt.x < maxX && nt.y < maxY else { return nil }
        return nt
    }
    let status = c.status == "capped" ? "capped" : !tips.isEmpty ? "growing" : "extinct"
    return LayerCultureState(
        tick: c.tick,
        nextId: c.nextId,
        tips: tips,
        occupancy: translateSurface(c.occupancy, dx, dy),
        segmentsTotal: c.segmentsTotal,
        status: status
    )
}

public func mergeLayerCultures(_ bottom: LayerCultureState?, _ top: LayerCultureState?) -> LayerCultureState? {
    if bottom == nil && top == nil { return nil }
    guard let bottom else { return top }
    guard let top else { return bottom }
    let occDraft = FastSurface(bottom.occupancy)
    for (key, tile) in top.occupancy.tiles {
        let (tx, ty) = tileCoord(key)
        let ox = tx * TILE
        let oy = ty * TILE
        let d = tile.data
        for y in 0..<TILE {
            let row = y * TILE
            for x in 0..<TILE {
                let v = Int(d[row + x])
                if v > occDraft.readByte(ox + x, oy + y) {
                    occDraft.writeByte(ox + x, oy + y, v)
                }
            }
        }
    }
    var nextId = Swift.max(bottom.nextId, top.nextId)
    var combinedTips = bottom.tips
    for var t in top.tips {
        t.id = nextId
        nextId += 1
        combinedTips.append(t)
    }
    if combinedTips.count > MAX_CULTURE_TIPS {
        combinedTips = Array(combinedTips.prefix(MAX_CULTURE_TIPS))
    }
    let segmentsTotal = Swift.min(MAX_CULTURE_SEGMENTS, bottom.segmentsTotal + top.segmentsTotal)
    let capped = bottom.status == "capped" || top.status == "capped" || combinedTips.count >= MAX_CULTURE_TIPS || segmentsTotal >= MAX_CULTURE_SEGMENTS
    return LayerCultureState(
        tick: Swift.max(bottom.tick, top.tick),
        nextId: nextId,
        tips: capped ? [] : combinedTips,
        occupancy: occDraft.commit(),
        segmentsTotal: segmentsTotal,
        status: capped ? "capped" : !combinedTips.isEmpty ? "growing" : "extinct"
    )
}

public func clearOccupancyUnderStroke(
    _ culture: LayerCultureState,
    _ beforeSurface: TiledSurface,
    _ afterSurface: TiledSurface
) -> LayerCultureState {
    if culture.occupancy.tiles.isEmpty { return culture }
    let occ = FastSurface(culture.occupancy)
    let before = FastSurface(beforeSurface)
    for (key, tile) in afterSurface.tiles {
        guard culture.occupancy.tiles.get(key) != nil else { continue }
        let (tx, ty) = tileCoord(key)
        let ox = tx * TILE
        let oy = ty * TILE
        let d = tile.data
        for y in 0..<TILE {
            let row = (y * TILE) << 2
            for x in 0..<TILE {
                let aAfter = Int(d[row + (x << 2) + 3])
                if aAfter == 0 { continue }
                let px = ox + x
                let py = oy + y
                if occ.readByte(px, py) >= 2 && aAfter >= before.readAlpha(px, py) {
                    occ.writeByte(px, py, 0)
                }
            }
        }
    }
    var next = culture
    next.occupancy = occ.commit()
    return next
}

private func rasterizeFadeDisk(
    _ layer: FastSurface,
    _ occ: FastSurface?,
    _ stencil: FastSurface?,
    _ cx: Int,
    _ cy: Int,
    _ radius: Int,
    _ fadePermille: Int,
    _ minX: Int,
    _ minY: Int,
    _ maxX: Int,
    _ maxY: Int
) {
    if fadePermille <= 0 || radius <= 0 { return }
    let r2 = radius * radius
    let x0 = Swift.max(minX, cx - radius)
    let y0 = Swift.max(minY, cy - radius)
    let x1 = Swift.min(maxX - 1, cx + radius)
    let y1 = Swift.min(maxY - 1, cy + radius)
    if x0 > x1 || y0 > y1 { return }
    for py in y0...y1 {
        let dy = py - cy
        for px in x0...x1 {
            let dx = px - cx
            let d2 = dx * dx + dy * dy
            if d2 > r2 { continue }
            if let stencil, stencil.readByte(px, py) < 128 { continue }
            if let occ, occ.readByte(px, py) != 0 { continue }
            let falloff = ((r2 - d2 + 1) * fadePermille) / (r2 + 1)
            if falloff > 0 { layer.fadeAlpha(px, py, falloff) }
        }
    }
}

private func rasterizeSegment(
    _ layer: FastSurface,
    _ occ: FastSurface?,
    _ light: FastSurface?,
    _ stencil: FastSurface?,
    _ seg: CultureRecordedSegment,
    _ minX: Int,
    _ minY: Int,
    _ maxX: Int,
    _ maxY: Int,
    _ lockTransparency: Bool
) {
    let x0 = seg.x0 >> 8
    let y0 = seg.y0 >> 8
    let x1 = seg.x1 >> 8
    let y1 = seg.y1 >> 8
    let radiusPx = Swift.max(0, (seg.widthFp - 128) >> 8)
    let subAlpha = seg.widthFp < 256 ? Swift.max(48, (seg.alpha * seg.widthFp) >> 8) : seg.alpha
    let glowA = seg.glowPermille > 0 ? Swift.min(255, (subAlpha * seg.glowPermille) / 1000) : 0

    let dx = abs(x1 - x0)
    let dy = abs(y1 - y0)
    let sx = x0 < x1 ? 1 : -1
    let sy = y0 < y1 ? 1 : -1
    var err = dx - dy
    var cx = x0
    var cy = y0

    while true {
        if radiusPx <= 0 {
            if cx >= minX && cy >= minY && cx < maxX && cy < maxY {
                if stencil == nil || stencil!.readByte(cx, cy) >= 128 {
                    layer.blendRgba(cx, cy, seg.r, seg.g, seg.b, subAlpha, lockTransparency)
                    if let occ, !lockTransparency || layer.readAlpha(cx, cy) > 0 {
                        occ.writeByte(cx, cy, 200)
                    }
                    if let light, glowA > 0, !lockTransparency || layer.readAlpha(cx, cy) > 0 {
                        let cur = light.readByte(cx, cy)
                        if glowA > cur { light.writeByte(cx, cy, glowA) }
                    }
                }
            }
        } else {
            let r2 = radiusPx * radiusPx
            let px0 = Swift.max(minX, cx - radiusPx)
            let py0 = Swift.max(minY, cy - radiusPx)
            let px1 = Swift.min(maxX - 1, cx + radiusPx)
            let py1 = Swift.min(maxY - 1, cy + radiusPx)
            if px0 <= px1 && py0 <= py1 {
                for py in py0...py1 {
                    let ody = py - cy
                    for px in px0...px1 {
                        let odx = px - cx
                        if odx * odx + ody * ody > r2 { continue }
                        if let stencil, stencil.readByte(px, py) < 128 { continue }
                        layer.blendRgba(px, py, seg.r, seg.g, seg.b, subAlpha, lockTransparency)
                        if let occ, !lockTransparency || layer.readAlpha(px, py) > 0 {
                            occ.writeByte(px, py, 200)
                        }
                        if let light, glowA > 0, !lockTransparency || layer.readAlpha(px, py) > 0 {
                            let cur = light.readByte(px, py)
                            if glowA > cur { light.writeByte(px, py, glowA) }
                        }
                    }
                }
            }
        }
        if cx == x1 && cy == y1 { break }
        let e2 = err << 1
        if e2 > -dy {
            err -= dy
            cx += sx
        }
        if e2 < dx {
            err += dx
            cy += sy
        }
    }
}

public func seedCultureFromStroke(
    existing: LayerCultureState? = nil,
    points: [Point2],
    brushSize: Double,
    color: [Int],
    culture: CultureSettings,
    strokeSeed: Int,
    beforeSurface: TiledSurface,
    afterSurface: TiledSurface,
    canvasWidth: Int,
    canvasHeight: Int,
    offsetX: Int = 0,
    offsetY: Int = 0
) -> (culture: LayerCultureState, seedsAdded: Int) {
    let base = existing ?? emptyLayerCulture()
    let occ = FastSurface(base.occupancy)
    let before = FastSurface(beforeSurface)

    for (key, tile) in afterSurface.tiles {
        let (tx, ty) = tileCoord(key)
        let ox = tx * TILE
        let oy = ty * TILE
        let d = tile.data
        for y in 0..<TILE {
            let row = (y * TILE) << 2
            for x in 0..<TILE {
                let aAfter = Int(d[row + (x << 2) + 3])
                if aAfter == 0 { continue }
                let px = ox + x
                let py = oy + y
                if before.readAlpha(px, py) == 0 && occ.readByte(px, py) == 0 {
                    occ.writeByte(px, py, 1)
                }
            }
        }
    }

    if base.status == "capped" || base.tips.count >= MAX_CULTURE_TIPS || points.isEmpty {
        var next = base
        next.occupancy = occ.commit()
        return (next, 0)
    }

    let sizePx = Swift.max(1, Int(JS.round(brushSize)))
    let spacingFp = Swift.max(6, sizePx) * CULTURE_FP
    var stations: [(xFp: Int, yFp: Int)] = [
        (Int(JS.round(points[0].x * Double(CULTURE_FP))), Int(JS.round(points[0].y * Double(CULTURE_FP))))
    ]

    var accumFp = 0
    if points.count > 1 {
        for i in 1..<points.count {
            let a = points[i - 1]
            let b = points[i]
            let ax = Int(JS.round(a.x * Double(CULTURE_FP)))
            let ay = Int(JS.round(a.y * Double(CULTURE_FP)))
            let bx = Int(JS.round(b.x * Double(CULTURE_FP)))
            let by = Int(JS.round(b.y * Double(CULTURE_FP)))
            let dx = bx - ax
            let dy = by - ay
            let distFp = isqrt(dx * dx + dy * dy)
            if distFp <= 0 { continue }
            var cursor = spacingFp - accumFp
            while cursor <= distFp && stations.count < 128 {
                stations.append((ax + (dx * cursor) / distFp, ay + (dy * cursor) / distFp))
                cursor += spacingFp
            }
            accumFp = (accumFp + distFp) % spacingFp
        }
    }

    let c = normalizeCulture(culture.json.objectValue ?? [:])
    let reachBasePx = Swift.max(8, sizePx)
    let reachPx = Swift.max(4, Int(JS.round(c.reach * Double(reachBasePx))))
    let initialEnergy = reachPx * 10
    let widthFp = Swift.max(64, Int(JS.round(Swift.max(2, brushSize) * c.thickness * Double(CULTURE_FP))))
    let branchPermille = Int(JS.round(c.branching * 1000))
    let wanderPermille = Int(JS.round(c.wander * 1000))
    let appetitePermille = Int(JS.round(c.appetite * 1000))
    let digestPermille = Int(JS.round(c.digest * 1000))
    let fusePermille = Int(JS.round(c.fuse * 1000))
    let glowPermille = Int(JS.round(c.glow * 1000))
    let r = Swift.min(255, Swift.max(0, color[0]))
    let g = Swift.min(255, Swift.max(0, color[1]))
    let b = Swift.min(255, Swift.max(0, color[2]))

    let sporesPerStation = stations.count <= 2 ? 8 : 6
    let angleStep = CULTURE_ANGLE_STEPS / sporesPerStation
    let minX = -offsetX * CULTURE_FP
    let minY = -offsetY * CULTURE_FP
    let maxX = (canvasWidth - offsetX) * CULTURE_FP
    let maxY = (canvasHeight - offsetY) * CULTURE_FP

    var nextId = base.nextId
    var seedsAdded = 0
    var tips = base.tips
    let strokeSeedU = UInt32(truncatingIfNeeded: strokeSeed)

    for (s, st) in stations.enumerated() {
        if st.xFp < minX || st.yFp < minY || st.xFp >= maxX || st.yFp >= maxY { continue }
        for k in 0..<sporesPerStation {
            if tips.count >= MAX_CULTURE_TIPS { break }
            let id = nextId
            nextId += 1
            let tipSeed = cultureHash32(strokeSeedU ^ imul32(id, 0x9e37_79b1) ^ imul32(s + 1, 0x85eb_ca6b))
            let jitter = Int(tipSeed & 63) - 32
            let angle = (k * angleStep + jitter) & CULTURE_ANGLE_MASK
            tips.append(CultureTip(
                id: id,
                x: st.xFp,
                y: st.yFp,
                angle: angle,
                energy: initialEnergy,
                widthFp: widthFp,
                r: r,
                g: g,
                b: b,
                age: 0,
                seed: tipSeed,
                reachPx: reachPx,
                branchPermille: branchPermille,
                wanderPermille: wanderPermille,
                appetitePermille: appetitePermille,
                digestPermille: digestPermille,
                fusePermille: fusePermille,
                glowPermille: glowPermille
            ))
            seedsAdded += 1
        }
        if tips.count >= MAX_CULTURE_TIPS { break }
    }

    let capped = tips.count >= MAX_CULTURE_TIPS || base.segmentsTotal >= MAX_CULTURE_SEGMENTS
    return (
        LayerCultureState(
            tick: base.tick,
            nextId: nextId,
            tips: capped ? Array(tips.prefix(MAX_CULTURE_TIPS)) : tips,
            occupancy: occ.commit(),
            segmentsTotal: base.segmentsTotal,
            status: capped ? "capped" : !tips.isEmpty ? "growing" : "extinct"
        ),
        seedsAdded
    )
}

// MARK: - Tick-by-tick integer growth simulation

private let SENSOR_DISTANCES: [Int] = [6, 14, 26, 40, 56, 72]
private let SENSOR_WEIGHTS: [Int] = [8, 7, 6, 5, 4, 3]
private let STEP_FP = 384

public struct StepLayerCultureResult: Sendable {
    public var culture: LayerCultureState
    public var surface: TiledSurface
    public var lightSurface: TiledSurface?
    public var segmentsAdded: Int
    public var tipsAlive: Int
    public var status: String
    public var eventData: CultureGrowEventData
}

public func stepLayerCulture(
    culture: LayerCultureState,
    surface: TiledSurface,
    lightSurface: TiledSurface? = nil,
    stencilMask: TiledSurface? = nil,
    lockTransparency: Bool = false,
    paperSeed: Int,
    paperDepthPermille: Int,
    canvasWidth: Int,
    canvasHeight: Int,
    offsetX: Int = 0,
    offsetY: Int = 0,
    steps stepsIn: Int
) -> StepLayerCultureResult {
    let steps = Swift.max(0, stepsIn)
    if steps == 0 || culture.status != "growing" || culture.tips.isEmpty {
        let status = culture.status == "capped" ? "capped" : !culture.tips.isEmpty ? "growing" : "extinct"
        var c = culture
        c.status = status
        return StepLayerCultureResult(
            culture: c,
            surface: surface,
            lightSurface: lightSurface,
            segmentsAdded: 0,
            tipsAlive: culture.tips.count,
            status: status,
            eventData: CultureGrowEventData(steps: 0, fades: [], segments: [])
        )
    }

    let minX = -offsetX
    let minY = -offsetY
    let maxX = canvasWidth - offsetX
    let maxY = canvasHeight - offsetY

    let layer = FastSurface(surface)
    let occ = FastSurface(culture.occupancy)
    let stencil = stencilMask.map(FastSurface.init)
    var light = lightSurface.map(FastSurface.init)

    var recordedFades: [CultureRecordedFade] = []
    var recordedSegments: [CultureRecordedSegment] = []

    var tick = culture.tick
    var nextId = culture.nextId
    var segmentsTotal = culture.segmentsTotal
    var segmentsAdded = 0
    var tips = culture.tips
    var capped = false

    func isBarrier(_ px: Int, _ py: Int) -> Bool {
        if px < minX || py < minY || px >= maxX || py >= maxY { return true }
        if let stencil, stencil.readByte(px, py) < 128 { return true }
        if lockTransparency && layer.readAlpha(px, py) == 0 { return true }
        return false
    }

    func effectiveOcc(_ px: Int, _ py: Int) -> Int {
        if px < minX || py < minY || px >= maxX || py >= maxY { return 255 }
        if layer.readAlpha(px, py) == 0 { return 0 }
        return occ.readByte(px, py)
    }

    func senseRay(_ originXFp: Int, _ originYFp: Int, _ rayAngle: Int, _ appetitePermille: Int) -> Int {
        let ca = cosFp(rayAngle)
        let sa = sinFp(rayAngle)
        var score = 0

        for d in [3, 6] {
            let sx = (originXFp + ca * d) >> 8
            let sy = (originYFp + sa * d) >> 8
            if isBarrier(sx, sy) {
                score -= 40000
            } else {
                let eo = effectiveOcc(sx, sy)
                if eo >= 2 { score -= eo * 14 }
                let grain = paperGrainByte(paperSeed, paperDepthPermille, sx, sy) - 128
                score += grain * 2
            }
        }

        if appetitePermille > 0 {
            for i in 0..<SENSOR_DISTANCES.count {
                let d = SENSOR_DISTANCES[i]
                let w = SENSOR_WEIGHTS[i]
                let sx = (originXFp + ca * d) >> 8
                let sy = (originYFp + sa * d) >> 8
                if sx < minX || sy < minY || sx >= maxX || sy >= maxY { continue }
                if let stencil, stencil.readByte(sx, sy) < 128 { break }
                if occ.readByte(sx, sy) == 0 {
                    let fa = layer.readAlpha(sx, sy)
                    if fa > 0 {
                        score += (fa * appetitePermille * w) >> 7
                    }
                }
            }
        }
        return score
    }

    for _ in 0..<steps {
        if tips.isEmpty || capped { break }
        tick += 1
        var nextTips: [CultureTip] = []

        for ti in 0..<tips.count {
            if segmentsTotal >= MAX_CULTURE_SEGMENTS {
                capped = true
                break
            }
            let tip = tips[ti]
            let x0 = tip.x >> 8
            let y0 = tip.y >> 8
            if x0 < minX || y0 < minY || x0 >= maxX || y0 >= maxY { continue }

            let leftAngle = (tip.angle - 112) & CULTURE_ANGLE_MASK
            let rightAngle = (tip.angle + 112) & CULTURE_ANGLE_MASK
            var leftScore = senseRay(tip.x, tip.y, leftAngle, tip.appetitePermille)
            let centerScore = senseRay(tip.x, tip.y, tip.angle, tip.appetitePermille)
            var rightScore = senseRay(tip.x, tip.y, rightAngle, tip.appetitePermille)

            if tip.appetitePermille > 0 {
                let wideLeft = senseRay(tip.x, tip.y, (tip.angle - 224) & CULTURE_ANGLE_MASK, tip.appetitePermille)
                let wideRight = senseRay(tip.x, tip.y, (tip.angle + 224) & CULTURE_ANGLE_MASK, tip.appetitePermille)
                if wideLeft > leftScore { leftScore = (leftScore + wideLeft) >> 1 }
                if wideRight > rightScore { rightScore = (rightScore + wideRight) >> 1 }
                if leftScore <= 0 && centerScore <= 0 && rightScore <= 0 {
                    let backLeft = senseRay(tip.x, tip.y, (tip.angle - 352) & CULTURE_ANGLE_MASK, tip.appetitePermille)
                    let backRight = senseRay(tip.x, tip.y, (tip.angle + 352) & CULTURE_ANGLE_MASK, tip.appetitePermille)
                    if backLeft > leftScore { leftScore = backLeft >> 1 }
                    if backRight > rightScore { rightScore = backRight >> 1 }
                }
            }

            let h = cultureHash32(tip.seed ^ imul32(tick, 0x85eb_ca6b) ^ imul32(tip.id, 0xc2b2_ae35))

            var steerDelta = 0
            if leftScore > centerScore || rightScore > centerScore {
                if leftScore > rightScore {
                    let diff = leftScore - centerScore
                    steerDelta = -Swift.min(96, 16 + (diff >> 5))
                } else if rightScore > leftScore {
                    let diff = rightScore - centerScore
                    steerDelta = Swift.min(96, 16 + (diff >> 5))
                } else {
                    steerDelta = (h & 1) != 0 ? 24 : -24
                }
            }

            let maxFoodScore = Swift.max(leftScore, Swift.max(centerScore, rightScore))
            let rawWander = Int(h & 255) - 128
            var wanderDelta = (rawWander * tip.wanderPermille) / 1400
            if maxFoodScore > 300 && tip.appetitePermille > 300 {
                wanderDelta >>= 1
            }

            var nextAngle = (tip.angle + steerDelta + wanderDelta) & CULTURE_ANGLE_MASK
            var nx = tip.x + ((cosFp(nextAngle) * STEP_FP) >> 8)
            var ny = tip.y + ((sinFp(nextAngle) * STEP_FP) >> 8)
            var x1 = nx >> 8
            var y1 = ny >> 8

            if x1 < minX || y1 < minY || x1 >= maxX || y1 >= maxY { continue }

            if isBarrier(x1, y1) {
                let alt1 = (tip.angle + (leftScore >= rightScore ? -224 : 224)) & CULTURE_ANGLE_MASK
                let alt2 = (tip.angle + (leftScore >= rightScore ? 224 : -224)) & CULTURE_ANGLE_MASK
                let alt3 = (tip.angle + 512) & CULTURE_ANGLE_MASK
                var found = false
                for cand in [alt1, alt2, alt3] {
                    let cnx = tip.x + ((cosFp(cand) * STEP_FP) >> 8)
                    let cny = tip.y + ((sinFp(cand) * STEP_FP) >> 8)
                    let cx1 = cnx >> 8
                    let cy1 = cny >> 8
                    if !isBarrier(cx1, cy1) {
                        nextAngle = cand
                        nx = cnx
                        ny = cny
                        x1 = cx1
                        y1 = cy1
                        found = true
                        break
                    }
                }
                if !found { continue }
            }

            let foraging = maxFoodScore > 300 && tip.appetitePermille > 0
            let ax = (nx + cosFp(nextAngle) * 2) >> 8
            let ay = (ny + sinFp(nextAngle) * 2) >> 8
            if !foraging && tip.age >= 3 && ax >= minX && ay >= minY && ax < maxX && ay < maxY && !isBarrier(ax, ay) {
                let aheadOcc = effectiveOcc(ax, ay)
                let hereOcc = (x1 != x0 || y1 != y0) ? effectiveOcc(x1, y1) : 0
                if aheadOcc >= 80 || hereOcc >= 160 {
                    let fuseRoll = Int((h >> 8) & 0xffff) % 1000
                    if fuseRoll < tip.fusePermille {
                        let bridgeSeg = CultureRecordedSegment(
                            x0: tip.x,
                            y0: tip.y,
                            x1: ax << 8,
                            y1: ay << 8,
                            widthFp: tip.widthFp,
                            r: tip.r,
                            g: tip.g,
                            b: tip.b,
                            alpha: 205,
                            glowPermille: tip.glowPermille
                        )
                        if tip.glowPermille > 0 && light == nil { light = FastSurface(emptySurface(1, 0)) }
                        rasterizeSegment(layer, occ, light, stencil, bridgeSeg, minX, minY, maxX, maxY, lockTransparency)
                        recordedSegments.append(bridgeSeg)
                        segmentsTotal += 1
                        segmentsAdded += 1
                        continue
                    } else {
                        let deflect = (nextAngle + (leftScore >= rightScore ? -192 : 192)) & CULTURE_ANGLE_MASK
                        let dnx = tip.x + ((cosFp(deflect) * STEP_FP) >> 8)
                        let dny = tip.y + ((sinFp(deflect) * STEP_FP) >> 8)
                        let dx1 = dnx >> 8
                        let dy1 = dny >> 8
                        if dx1 >= minX && dy1 >= minY && dx1 < maxX && dy1 < maxY && !isBarrier(dx1, dy1) {
                            nextAngle = deflect
                            nx = dnx
                            ny = dny
                            x1 = dx1
                            y1 = dy1
                        }
                    }
                }
            }

            var tipR = tip.r
            var tipG = tip.g
            var tipB = tip.b
            var energyGain = 0
            var onFood = false

            if occ.readByte(x1, y1) == 0 {
                let (fr, fg, fb, fa) = layer.readRgba(x1, y1)
                if fa > 0 {
                    onFood = true
                    tipR = (tipR * 650 + fr * 350 + 500) / 1000
                    tipG = (tipG * 650 + fg * 350 + 500) / 1000
                    tipB = (tipB * 650 + fb * 350 + 500) / 1000
                    energyGain = 14 + ((fa * 16) >> 8)
                    if tip.digestPermille > 0 {
                        let feedRadius = Swift.max(3, ((tip.widthFp + 255) >> 8) + 2)
                        let fadePermille = (tip.digestPermille * 450) / 1000
                        rasterizeFadeDisk(layer, occ, stencil, x1, y1, feedRadius, fadePermille, minX, minY, maxX, maxY)
                        recordedFades.append(CultureRecordedFade(x: x1, y: y1, radius: feedRadius, fadePermille: fadePermille))
                    }
                }
            }

            let segAlpha = onFood && tip.digestPermille > 0 ? 180 : 215
            let seg = CultureRecordedSegment(
                x0: tip.x,
                y0: tip.y,
                x1: nx,
                y1: ny,
                widthFp: tip.widthFp,
                r: tipR,
                g: tipG,
                b: tipB,
                alpha: segAlpha,
                glowPermille: tip.glowPermille
            )
            if tip.glowPermille > 0 && light == nil { light = FastSurface(emptySurface(1, 0)) }
            rasterizeSegment(layer, occ, light, stencil, seg, minX, minY, maxX, maxY, lockTransparency)
            recordedSegments.append(seg)
            segmentsTotal += 1
            segmentsAdded += 1

            let maxEnergy = tip.reachPx * 15
            let moveCost = foraging ? 6 : 10
            let nextEnergy = Swift.min(maxEnergy, tip.energy - moveCost + energyGain)
            if nextEnergy <= 0 { continue }

            let nextAge = tip.age + 1
            var parentWidthFp = tip.widthFp
            var parentAngle = nextAngle

            if tip.branchPermille > 0 && nextAge >= 3 && tip.widthFp >= 64 {
                let branchChance = (tip.branchPermille * (onFood ? 140 : foraging ? 90 : 55)) / 1000
                let branchRoll = Int((h >> 16) & 0xffff) % 1000
                if branchRoll < branchChance {
                    let remaining = tips.count - 1 - ti
                    if nextTips.count + 1 + remaining >= MAX_CULTURE_TIPS {
                        capped = true
                    } else {
                        let sign = (h & 1) != 0 ? 1 : -1
                        let spread = 112 + Int((h >> 24) & 31)
                        let childAngle = (nextAngle + sign * spread) & CULTURE_ANGLE_MASK
                        parentAngle = (nextAngle - sign * 48) & CULTURE_ANGLE_MASK
                        let childWidthFp = Swift.max(52, (tip.widthFp * 78) / 100)
                        parentWidthFp = Swift.max(52, (tip.widthFp * 92) / 100)
                        let childId = nextId
                        nextId += 1
                        nextTips.append(CultureTip(
                            id: childId,
                            x: nx,
                            y: ny,
                            angle: childAngle,
                            energy: Swift.max(10, (nextEnergy * 80) / 100),
                            widthFp: childWidthFp,
                            r: tipR,
                            g: tipG,
                            b: tipB,
                            age: 0,
                            seed: cultureHash32(tip.seed ^ imul32(childId, 0x9e37_79b1)),
                            reachPx: tip.reachPx,
                            branchPermille: tip.branchPermille,
                            wanderPermille: tip.wanderPermille,
                            appetitePermille: tip.appetitePermille,
                            digestPermille: tip.digestPermille,
                            fusePermille: tip.fusePermille,
                            glowPermille: tip.glowPermille
                        ))
                    }
                }
            }

            if nextTips.count < MAX_CULTURE_TIPS {
                var updated = tip
                updated.x = nx
                updated.y = ny
                updated.angle = parentAngle
                updated.energy = nextEnergy
                updated.widthFp = parentWidthFp
                updated.r = tipR
                updated.g = tipG
                updated.b = tipB
                updated.age = nextAge
                nextTips.append(updated)
            } else {
                capped = true
            }
        }

        tips = capped ? [] : nextTips
        if segmentsTotal >= MAX_CULTURE_SEGMENTS {
            capped = true
            tips = []
        }
    }

    let status = capped ? "capped" : !tips.isEmpty ? "growing" : "extinct"
    return StepLayerCultureResult(
        culture: LayerCultureState(
            tick: tick,
            nextId: nextId,
            tips: tips,
            occupancy: occ.commit(),
            segmentsTotal: segmentsTotal,
            status: status
        ),
        surface: layer.commit(),
        lightSurface: light?.commit() ?? lightSurface,
        segmentsAdded: segmentsAdded,
        tipsAlive: tips.count,
        status: status,
        eventData: CultureGrowEventData(steps: steps, fades: recordedFades, segments: recordedSegments)
    )
}

// MARK: - High-resolution replay, summaries & JSON serialization

public func applyCultureGrowReplay(
    surface: TiledSurface,
    lightSurface: TiledSurface? = nil,
    stencilMask: TiledSurface? = nil,
    lockTransparency: Bool = false,
    data: CultureGrowEventData,
    scale: Double,
    canvasWidth: Int,
    canvasHeight: Int
) -> (surface: TiledSurface, lightSurface: TiledSurface?) {
    let layer = FastSurface(surface)
    let stencil = stencilMask.map(FastSurface.init)
    var light = lightSurface.map(FastSurface.init)

    for f in data.fades {
        rasterizeFadeDisk(
            layer,
            nil,
            stencil,
            Int(JS.round(Double(f.x) * scale)),
            Int(JS.round(Double(f.y) * scale)),
            Swift.max(1, Int(JS.round(Double(f.radius) * scale))),
            f.fadePermille,
            0,
            0,
            canvasWidth,
            canvasHeight
        )
    }

    for s in data.segments {
        if s.glowPermille > 0 && light == nil { light = FastSurface(emptySurface(1, 0)) }
        let scaled = CultureRecordedSegment(
            x0: Int(JS.round(Double(s.x0) * scale)),
            y0: Int(JS.round(Double(s.y0) * scale)),
            x1: Int(JS.round(Double(s.x1) * scale)),
            y1: Int(JS.round(Double(s.y1) * scale)),
            widthFp: Swift.max(64, Int(JS.round(Double(s.widthFp) * scale))),
            r: s.r,
            g: s.g,
            b: s.b,
            alpha: s.alpha,
            glowPermille: s.glowPermille
        )
        rasterizeSegment(layer, nil, light, stencil, scaled, 0, 0, canvasWidth, canvasHeight, lockTransparency)
    }

    return (layer.commit(), light?.commit() ?? lightSurface)
}

public func layerCultureSummary(_ layerId: String, _ culture: LayerCultureState?) -> LayerCultureSummary {
    guard let culture else {
        return LayerCultureSummary(layerId: layerId, tick: 0, tips: 0, segments: 0, bounds: nil, status: "extinct")
    }
    return LayerCultureSummary(
        layerId: layerId,
        tick: culture.tick,
        tips: culture.tips.count,
        segments: culture.segmentsTotal,
        bounds: contentBounds(culture.occupancy),
        status: culture.status
    )
}

func cultureToJSON(_ c: LayerCultureState) -> JSONValue {
    var o: JSONObject = [
        "tick": .number(Double(c.tick)),
        "nextId": .number(Double(c.nextId)),
        "tips": .array(c.tips.map(\.json)),
        "segmentsTotal": .number(Double(c.segmentsTotal)),
        "status": .string(c.status),
    ]
    if let b = c.occupancy.bounds {
        o["occupancyRect"] = b.json
        o["occupancy"] = .string(pngDataUrl(b.width, b.height, readRegion(c.occupancy, b), 1))
    }
    return .object(o)
}

func cultureGrowEventDataFromJSON(_ raw: JSONObject) -> CultureGrowEventData {
    let steps = Int(raw["steps"]?.numberValue ?? 0)
    let fades: [CultureRecordedFade] = (raw["fades"]?.arrayValue ?? []).compactMap { v in
        guard let o = v.objectValue,
              let x = o["x"]?.numberValue,
              let y = o["y"]?.numberValue,
              let radius = o["radius"]?.numberValue,
              let fadePermille = o["fadePermille"]?.numberValue else { return nil }
        return CultureRecordedFade(x: Int(x), y: Int(y), radius: Int(radius), fadePermille: Int(fadePermille))
    }
    let segments: [CultureRecordedSegment] = (raw["segments"]?.arrayValue ?? []).compactMap { v in
        guard let o = v.objectValue,
              let x0 = o["x0"]?.numberValue,
              let y0 = o["y0"]?.numberValue,
              let x1 = o["x1"]?.numberValue,
              let y1 = o["y1"]?.numberValue,
              let widthFp = o["widthFp"]?.numberValue,
              let r = o["r"]?.numberValue,
              let g = o["g"]?.numberValue,
              let b = o["b"]?.numberValue,
              let alpha = o["alpha"]?.numberValue,
              let glowPermille = o["glowPermille"]?.numberValue else { return nil }
        return CultureRecordedSegment(
            x0: Int(x0), y0: Int(y0), x1: Int(x1), y1: Int(y1),
            widthFp: Int(widthFp), r: Int(r), g: Int(g), b: Int(b),
            alpha: Int(alpha), glowPermille: Int(glowPermille)
        )
    }
    return CultureGrowEventData(steps: steps, fades: fades, segments: segments)
}

// MARK: - PaintDocumentState & PaintEditorController integration

extension PaintDocumentState {
    func settingCulture(_ id: String, _ state: LayerCultureState?) {
        var next = cultures ?? OrderedMap()
        if let state, state.tips.count > 0 || state.segmentsTotal > 0 || !state.occupancy.tiles.isEmpty || state.tick > 0 {
            next.set(id, state)
        } else {
            _ = next.delete(id)
        }
        cultures = next.isEmpty ? nil : next
    }

    func removingCultures(_ ids: [String]) {
        guard var next = cultures else { return }
        for id in ids { _ = next.delete(id) }
        cultures = next.isEmpty ? nil : next
    }
}

public struct PaintCulturesStateInfo: Equatable, Sendable {
    public var layers: [LayerCultureSummary]
    public var growWhileClosed: Bool
    public var pendingCatchUpTicks: Int
    public var paused: Bool
    public var speed: Double
    public var growing: Bool

    public var json: JSONValue {
        [
            "layers": .array(layers.map(\.json)),
            "growWhileClosed": .bool(growWhileClosed),
            "pendingCatchUpTicks": .number(Double(pendingCatchUpTicks)),
            "paused": .bool(paused),
            "speed": .number(speed),
            "growing": .bool(growing),
        ]
    }
}

public struct GrowCulturesLayerResult: Equatable, Sendable {
    public var layerId: String
    public var segmentsAdded: Int
    public var tipsAlive: Int
    public var bounds: RasterRect?
    public var status: String

    public var json: JSONValue {
        [
            "layerId": .string(layerId),
            "segmentsAdded": .number(Double(segmentsAdded)),
            "tipsAlive": .number(Double(tipsAlive)),
            "bounds": rectJSON(bounds),
            "status": .string(status),
        ]
    }
}

public struct GrowCulturesResult: Equatable, Sendable {
    public var steps: Int
    public var segmentsAdded: Int
    public var tipsAlive: Int
    public var bounds: RasterRect?
    public var status: String
    public var layers: [GrowCulturesLayerResult]

    public var json: JSONValue {
        [
            "steps": .number(Double(steps)),
            "segmentsAdded": .number(Double(segmentsAdded)),
            "tipsAlive": .number(Double(tipsAlive)),
            "bounds": rectJSON(bounds),
            "status": .string(status),
            "layers": .array(layers.map(\.json)),
        ]
    }
}

extension PaintEditorController {
    func applyStrokeCulture(
        _ doc: PaintDocumentState,
        _ s: PaintStrokeSession,
        _ layer: PaintLayer,
        _ afterSurface: TiledSurface,
        _ result: inout PaintStrokeResult
    ) -> OrderedMap<String, LayerCultureState>? {
        let brush = s.initValues.brush
        let existing = doc.cultures?.get(layer.id)
        guard let cultureSettings = brush.culture else {
            guard let existing else { return doc.cultures }
            let cleared = clearOccupancyUnderStroke(existing, layer.pixelSurface, afterSurface)
            var next = doc.cultures ?? OrderedMap()
            next.set(layer.id, cleared)
            return next
        }
        let copies = [IDENTITY_AFFINE] + s.initValues.affineCopies
        var current = existing
        var totalSeeds = 0
        let ox = layer.pixelOffset.x
        let oy = layer.pixelOffset.y
        for (ci, m) in copies.enumerated() {
            let copyPoints = s.points.map { p -> Point2 in
                let tx = m[0] * p.x + m[2] * p.y + m[4]
                let ty = m[1] * p.x + m[3] * p.y + m[5]
                return Point2(x: tx - Double(ox), y: ty - Double(oy))
            }
            let seeded = seedCultureFromStroke(
                existing: current,
                points: copyPoints,
                brushSize: brush.tip.size,
                color: [s.initValues.color[0], s.initValues.color[1], s.initValues.color[2]],
                culture: cultureSettings,
                strokeSeed: s.initValues.seed &+ ci &* 7919,
                beforeSurface: ci == 0 ? layer.pixelSurface : afterSurface,
                afterSurface: afterSurface,
                canvasWidth: doc.canvas.width,
                canvasHeight: doc.canvas.height,
                offsetX: ox,
                offsetY: oy
            )
            current = seeded.culture
            totalSeeds += seeded.seedsAdded
        }
        result.culture = totalSeeds
        culturePaused = false
        guard let current else { return doc.cultures }
        var next = doc.cultures ?? OrderedMap()
        next.set(layer.id, current)
        return next
    }

    public func getCultures(now: Double = Date().timeIntervalSince1970 * 1000) -> PaintCulturesStateInfo {
        var layers: [LayerCultureSummary] = []
        var growing = false
        for l in flattenLayers(doc.layers) where l.isPixel {
            guard let c = doc.cultures?.get(l.id) else { continue }
            var sum = layerCultureSummary(l.id, c)
            if let b = sum.bounds, (l.pixelOffset.x != 0 || l.pixelOffset.y != 0) {
                sum.bounds = RasterRect(x: b.x + l.pixelOffset.x, y: b.y + l.pixelOffset.y, width: b.width, height: b.height)
            }
            if sum.tips > 0 && sum.status == "growing" { growing = true }
            layers.append(sum)
        }
        let growWhileClosed = doc.growWhileClosed == true
        var pendingCatchUpTicks = 0
        if growWhileClosed, growing, let lastGrownAt = doc.lastGrownAt, lastGrownAt.isFinite, now > lastGrownAt {
            let elapsedSec = (now - lastGrownAt) / 1000
            pendingCatchUpTicks = Swift.min(MAX_CATCH_UP_TICKS, Swift.max(0, Int(JS.floor(elapsedSec * Double(CULTURE_TICKS_PER_SECOND)))))
        }
        return PaintCulturesStateInfo(
            layers: layers,
            growWhileClosed: growWhileClosed,
            pendingCatchUpTicks: pendingCatchUpTicks,
            paused: culturePaused,
            speed: cultureSpeed,
            growing: growing
        )
    }

    private func stepCulturesInternal(_ targetLayerIds: [String], _ steps: Int) -> (
        nextDoc: PaintDocumentState,
        layerResults: [GrowCulturesLayerResult],
        events: [(String, CultureGrowEventData)],
        dirty: [RasterRect]
    ) {
        var currentDoc = doc
        let width = currentDoc.canvas.width
        let height = currentDoc.canvas.height
        let maskSel = stencilSelection()
        let stencilSurface: TiledSurface? = maskSel.map { sel in
            surfaceFromPixels(width: sel.width, height: sel.height, data: sel.data, channels: 1)
        }
        let paperDepthPermille = Int(JS.round(currentDoc.paper.depth * 1000))
        let paperSeed = currentDoc.paper.seed
        var layerResults: [GrowCulturesLayerResult] = []
        var events: [(String, CultureGrowEventData)] = []
        var dirty: [RasterRect] = []

        for layerId in targetLayerIds {
            guard let l = findLayer(currentDoc.layers, layerId)?.layer, l.isPixel else { continue }
            guard let c = currentDoc.cultures?.get(layerId) else {
                layerResults.append(GrowCulturesLayerResult(layerId: layerId, segmentsAdded: 0, tipsAlive: 0, bounds: nil, status: "extinct"))
                continue
            }
            let ox = l.pixelOffset.x
            let oy = l.pixelOffset.y
            let layerStencil = (stencilSurface != nil && (ox != 0 || oy != 0))
                ? translateSurface(stencilSurface!, Double(-ox), Double(-oy))
                : stencilSurface
            let stepped = stepLayerCulture(
                culture: c,
                surface: l.pixelSurface,
                lightSurface: currentDoc.light?.get(layerId),
                stencilMask: layerStencil,
                lockTransparency: isLayerLocked(l.locks, .transparency),
                paperSeed: paperSeed,
                paperDepthPermille: paperDepthPermille,
                canvasWidth: width,
                canvasHeight: height,
                offsetX: ox,
                offsetY: oy,
                steps: steps
            )
            if stepped.segmentsAdded > 0 || stepped.culture.tick != c.tick || stepped.culture.status != c.status || stepped.culture.tips.count != c.tips.count {
                currentDoc = currentDoc.with { d in
                    d.layers = mapLayer(d.layers, layerId) { $0.withSurface(stepped.surface) }
                    d.settingCulture(layerId, stepped.culture)
                    if let ls = stepped.lightSurface { d.settingLight(layerId, ls) }
                }
            }
            if stepped.segmentsAdded > 0 {
                if ox != 0 || oy != 0 {
                    let dxFp = ox * 256
                    let dyFp = oy * 256
                    events.append((
                        layerId,
                        CultureGrowEventData(
                            steps: stepped.eventData.steps,
                            fades: stepped.eventData.fades.map { f in
                                CultureRecordedFade(x: f.x + ox, y: f.y + oy, radius: f.radius, fadePermille: f.fadePermille)
                            },
                            segments: stepped.eventData.segments.map { s in
                                CultureRecordedSegment(
                                    x0: s.x0 + dxFp, y0: s.y0 + dyFp, x1: s.x1 + dxFp, y1: s.y1 + dyFp,
                                    widthFp: s.widthFp, r: s.r, g: s.g, b: s.b, alpha: s.alpha, glowPermille: s.glowPermille
                                )
                            }
                        )
                    ))
                } else {
                    events.append((layerId, stepped.eventData))
                }
            }
            let sum = layerCultureSummary(layerId, stepped.culture)
            let bounds = sum.bounds.map { RasterRect(x: $0.x + ox, y: $0.y + oy, width: $0.width, height: $0.height) }
            if let bounds { dirty.append(bounds) }
            layerResults.append(GrowCulturesLayerResult(
                layerId: layerId,
                segmentsAdded: stepped.segmentsAdded,
                tipsAlive: stepped.tipsAlive,
                bounds: bounds,
                status: stepped.status
            ))
        }
        return (currentDoc, layerResults, events, dirty)
    }

    public func growCultures(layerId: String? = nil, steps stepsIn: Int? = nil) throws -> GrowCulturesResult {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before growing cultures.") }
        let steps = stepsIn ?? 40
        if !(steps >= 1 && steps <= 2000) {
            throw PaintEditorError("steps \(steps) is out of range; use a whole number 1..2000.")
        }
        var targetIds: [String] = []
        if let layerId {
            let l = try requireLayer(layerId)
            if !l.isPixel { throw PaintEditorError("Layer \"\(l.name)\" is a group; grow cultures on a pixel layer.") }
            if doc.liveStrokes?.get(l.id) != nil { throw PaintEditorError("Layer \"\(l.name)\" is a stroke layer; biopaint cultures only grow on pixel layers.") }
            if doc.effectLayers?.get(l.id) != nil { throw PaintEditorError("Layer \"\(l.name)\" is an effect layer; rasterize it first (rasterize_effect_layer) or grow cultures on a pixel layer.") }
            if wet.wetLayerIds().contains(l.id) { throw PaintEditorError("Layer \"\(l.name)\" holds wet paint; dry it first (dry_paint) before growing cultures on it.") }
            if isLayerLocked(l.locks, .pixels) { throw PaintEditorError("Layer \"\(l.name)\" has its pixels locked; unlock it first.") }
            if !l.visible { throw PaintEditorError("Layer \"\(l.name)\" is hidden; show it first.") }
            targetIds = [l.id]
        } else {
            targetIds = flattenLayers(doc.layers).compactMap { l -> String? in
                guard l.isPixel,
                      l.visible,
                      !isLayerLocked(l.locks, .pixels),
                      doc.liveStrokes?.get(l.id) == nil,
                      doc.effectLayers?.get(l.id) == nil,
                      let c = doc.cultures?.get(l.id),
                      !c.tips.isEmpty else { return nil }
                return l.id
            }
            for id in targetIds where wet.wetLayerIds().contains(id) {
                let l = try requireLayer(id)
                throw PaintEditorError("Layer \"\(l.name)\" holds wet paint; dry it first (dry_paint) before growing cultures on it.")
            }
            if targetIds.isEmpty, let activeId = doc.activeLayerId, let active = getLayer(activeId), active.isPixel {
                if doc.liveStrokes?.get(active.id) != nil { throw PaintEditorError("Layer \"\(active.name)\" is a stroke layer; biopaint cultures only grow on pixel layers.") }
                if doc.effectLayers?.get(active.id) != nil { throw PaintEditorError("Layer \"\(active.name)\" is an effect layer; rasterize it first (rasterize_effect_layer) or grow cultures on a pixel layer.") }
                if wet.wetLayerIds().contains(active.id) { throw PaintEditorError("Layer \"\(active.name)\" holds wet paint; dry it first (dry_paint) before growing cultures on it.") }
                targetIds = [active.id]
            }
        }

        let before = doc
        culturePaused = false
        let (nextDoc, layerResults, events, _) = stepCulturesInternal(targetIds, steps)
        var finalDoc = nextDoc
        for (lid, data) in events {
            finalDoc = withPaintEvent(finalDoc, kind: "culture-grow", layerId: lid, data: data.json)
        }
        if finalDoc !== before {
            commit("Grow culture", finalDoc, before: before)
        } else {
            emit([])
        }
        var segmentsAdded = 0
        var tipsAlive = 0
        var bounds: RasterRect? = nil
        var status = "extinct"
        for r in layerResults {
            segmentsAdded += r.segmentsAdded
            tipsAlive += r.tipsAlive
            bounds = unionRectOpt(bounds, r.bounds)
            if r.status == "capped" { status = "capped" }
            else if r.status == "growing" && status != "capped" { status = "growing" }
        }
        return GrowCulturesResult(steps: steps, segmentsAdded: segmentsAdded, tipsAlive: tipsAlive, bounds: bounds, status: status, layers: layerResults)
    }

    public func removeCultures(_ layerId: String? = nil) throws -> JSONObject {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before removing cultures.") }
        let l = try paintTarget(layerId, "remove the cultures of")
        guard let c = doc.cultures?.get(l.id), (!c.tips.isEmpty || c.status == "growing") else {
            let st = doc.cultures?.get(l.id)?.status ?? "extinct"
            return ["layerId": .string(l.id), "removedTips": .number(0), "status": .string(st)]
        }
        let removedTips = c.tips.count
        var nextCulture = c
        nextCulture.tips = []
        nextCulture.status = "extinct"
        commit("Kill culture", doc.with { d in
            d.settingCulture(l.id, nextCulture)
        })
        return ["layerId": .string(l.id), "removedTips": .number(Double(removedTips)), "status": .string("extinct")]
    }

    public func setCultureOptions(growWhileClosed: Bool) -> JSONObject {
        doc = doc.with { d in
            d.growWhileClosed = growWhileClosed ? true : nil
            if !growWhileClosed { d.lastGrownAt = nil }
        }
        return ["growWhileClosed": .bool(growWhileClosed)]
    }

    public func setCulturePaused(_ paused: Bool) -> Bool {
        culturePaused = paused
        emit([])
        return culturePaused
    }

    public func setCultureSpeed(_ speed: Double) throws -> Double {
        if !(speed.isFinite && speed >= 0.25 && speed <= 4) {
            throw PaintEditorError("speed \(jsText(speed)) is out of range; use 0.25..4.")
        }
        cultureSpeed = speed
        emit([])
        return cultureSpeed
    }

    @discardableResult
    public func catchUpCultures(now: Double = Date().timeIntervalSince1970 * 1000) throws -> GrowCulturesResult? {
        if liveStroke != nil { throw PaintEditorError("A stroke is in progress; end or cancel it before catching up cultures.") }
        let state = getCultures(now: now)
        let ticks = state.pendingCatchUpTicks
        if ticks <= 0 { return nil }
        let targetIds = flattenLayers(doc.layers).compactMap { l -> String? in
            guard l.isPixel,
                  l.visible,
                  !isLayerLocked(l.locks, .pixels),
                  doc.liveStrokes?.get(l.id) == nil,
                  doc.effectLayers?.get(l.id) == nil,
                  !wet.wetLayerIds().contains(l.id),
                  let c = doc.cultures?.get(l.id),
                  !c.tips.isEmpty else { return nil }
            return l.id
        }
        if targetIds.isEmpty { return nil }
        let before = doc
        let (nextDoc, layerResults, events, _) = stepCulturesInternal(targetIds, ticks)
        var finalDoc = nextDoc.with { $0.lastGrownAt = JS.round(now) }
        for (lid, data) in events {
            finalDoc = withPaintEvent(finalDoc, kind: "culture-grow", layerId: lid, data: data.json)
        }
        if finalDoc !== before {
            commit("Growth while closed", finalDoc, before: before)
        }
        var segmentsAdded = 0
        var tipsAlive = 0
        var bounds: RasterRect? = nil
        var status = "extinct"
        for r in layerResults {
            segmentsAdded += r.segmentsAdded
            tipsAlive += r.tipsAlive
            bounds = unionRectOpt(bounds, r.bounds)
            if r.status == "capped" { status = "capped" }
            else if r.status == "growing" && status != "capped" { status = "growing" }
        }
        return GrowCulturesResult(steps: ticks, segmentsAdded: segmentsAdded, tipsAlive: tipsAlive, bounds: bounds, status: status, layers: layerResults)
    }

    func applyCultureGrowEvent(_ layerId: String, _ rawData: JSONObject, scale s: Double) throws {
        guard let l = findLayer(doc.layers, layerId)?.layer, l.isPixel else { return }
        let eventData = cultureGrowEventDataFromJSON(rawData)
        if eventData.fades.isEmpty && eventData.segments.isEmpty { return }
        let maskSel = stencilSelection()
        let stencilSurface: TiledSurface? = maskSel.map { sel in
            surfaceFromPixels(width: sel.width, height: sel.height, data: sel.data, channels: 1)
        }
        let replayed = applyCultureGrowReplay(
            surface: l.pixelSurface,
            lightSurface: doc.light?.get(layerId),
            stencilMask: stencilSurface,
            lockTransparency: isLayerLocked(l.locks, .transparency),
            data: eventData,
            scale: s,
            canvasWidth: doc.canvas.width,
            canvasHeight: doc.canvas.height
        )
        commit("Grow culture", doc.with { d in
            d.layers = mapLayer(d.layers, layerId) { $0.withSurface(replayed.surface, offset: LayerOffset(x: 0, y: 0)) }
            if let ls = replayed.lightSurface { d.settingLight(layerId, ls) }
        })
    }

    func culturesJSON() -> JSONObject {
        var out = JSONObject()
        var layers = JSONObject()
        if let cultures = doc.cultures {
            for (id, c) in cultures where findLayer(doc.layers, id) != nil {
                if !c.tips.isEmpty || c.segmentsTotal > 0 || !c.occupancy.tiles.isEmpty || c.tick > 0 {
                    layers[id] = cultureToJSON(c)
                }
            }
        }
        let hasLayers = !layers.isEmpty
        let growWhileClosed = doc.growWhileClosed == true
        let lastGrownAt = doc.lastGrownAt.flatMap { $0.isFinite ? JS.round($0) : nil }
        if !hasLayers && !growWhileClosed && lastGrownAt == nil { return out }
        var ext = JSONObject()
        if hasLayers { ext["layers"] = .object(layers) }
        if growWhileClosed { ext["growWhileClosed"] = .bool(true) }
        if let lastGrownAt { ext["lastGrownAt"] = .number(lastGrownAt) }
        out["cultures"] = .object(ext)
        return out
    }
}

func paintCultureHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["get_cultures"] = { _ in
        c.getCultures().json
    }
    h["grow_cultures"] = { a in
        let x = try GrowCulturesArguments(a)
        return try c.growCultures(layerId: x.layerId, steps: x.steps).json
    }
    h["remove_cultures"] = { a in
        let x = try RemoveCulturesArguments(a)
        return .object(try c.removeCultures(x.layerId))
    }
    h["set_culture_options"] = { a in
        let x = try SetCultureOptionsArguments(a)
        return .object(c.setCultureOptions(growWhileClosed: x.growWhileClosed))
    }
    return h
}
