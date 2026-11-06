// Portions ported from photocraft/crates/raster/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation

/**
 * Tiled, sparse, copy-on-write pixel storage (photocraft's `Surface`): 256 px square tiles in a
 * map keyed by tile coordinate, a default value for every missing tile, and shared tiles.
 * The port of `raster/surface.ts`.
 *
 * - Pixels are 8-bit, straight alpha: RGBA for layers (4 channels, the same as `ImageData`), one
 *   byte for masks.
 * - A surface is never mutated. A write returns a new surface that shares every tile it did not
 *   touch, so undo history and caches can keep old surfaces by reference.
 * - A tile whose pixels all hold one value is a *uniform* tile; one instance per value is shared,
 *   so a solid fill or a "hide all" mask costs one tile however large it is.
 * - Coordinates are document pixels and may be negative or past the canvas (layers can extend
 *   beyond it, as PSD layer rects do).
 */

/// A pixel rectangle (`x`, `y` of the top-left corner, `width`, `height`).
public struct RasterRect: Equatable, Hashable, Sendable, CustomStringConvertible {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int
    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
    public var description: String { "{x: \(x), y: \(y), width: \(width), height: \(height)}" }
}

public let TILE = 256
public let TILE_SHIFT = 8
let TILE_PIXELS = TILE * TILE
private let KEY_OFFSET = 1 << 15
private let KEY_SPAN = 1 << 16

/// A tile coordinate packed into one number (tx, ty in −32768..32767).
public typealias TileKey = Int

public func tileKey(_ tx: Int, _ ty: Int) -> TileKey {
    (ty + KEY_OFFSET) * KEY_SPAN + (tx + KEY_OFFSET)
}

public func tileCoord(_ key: TileKey) -> (tx: Int, ty: Int) {
    (tx: (key % KEY_SPAN) - KEY_OFFSET, ty: Int((Double(key) / Double(KEY_SPAN)).rounded(.down)) - KEY_OFFSET)
}

/// A tile's pixel rectangle in document space.
public func tileRect(_ tx: Int, _ ty: Int) -> RasterRect {
    RasterRect(x: tx * TILE, y: ty * TILE, width: TILE, height: TILE)
}

/// `Math.floor(v / TILE)` for whole numbers.
@inline(__always) func tileOf(_ v: Int) -> Int { v >> TILE_SHIFT }

/// High bit depth samples of a tile (see `Deep.swift`): 16-bit encoded, or 32-bit linear float.
public enum DeepSamples: Equatable, Sendable {
    case u16([UInt16])
    case f32([Float])

    public var count: Int {
        switch self {
        case .u16(let a): return a.count
        case .f32(let a): return a.count
        }
    }

    /// Bytes the samples hold (`byteLength`).
    public var byteLength: Int {
        switch self {
        case .u16(let a): return a.count * 2
        case .f32(let a): return a.count * 4
        }
    }

    /// Sample `i` as a number.
    @inline(__always) public subscript(i: Int) -> Double {
        switch self {
        case .u16(let a): return Double(a[i])
        case .f32(let a): return Double(a[i])
        }
    }
}

/// One tile: TILE × TILE pixels of `channels` bytes. Its data is never changed after it is made.
public final class Tile: Sendable {
    public let data: [UInt8]
    /// The packed value of every pixel when the tile is uniform, else `nil`.
    public let uniform: UInt32?
    /**
     * High bit depth samples (see `Deep.swift`): 16-bit sRGB-encoded or 32-bit linear float, of
     * which `data` is the 8-bit rendering. Missing: the tile is 8-bit.
     */
    public let deep: DeepSamples?

    public init(data: [UInt8], uniform: UInt32?, deep: DeepSamples? = nil) {
        self.data = data
        self.uniform = uniform
        self.deep = deep
    }
}

private let nextSurfaceId = Locked(1)

/**
 * An immutable tiled surface. `channels` is 4 (RGBA) for layers and 1 for masks. Missing tiles
 * hold `defaultValue` in every byte (0: transparent black for layers; 0 or 255 for masks).
 */
public final class TiledSurface: @unchecked Sendable {
    /// Unique per instance: a cache key that changes whenever the pixels can have changed.
    public let id: Int
    public let channels: Int
    public let tiles: OrderedMap<TileKey, Tile>
    public let defaultValue: Int
    private let boundsCache = Locked<RasterRect??>(nil)
    fileprivate let contentBoundsCache = Locked<RasterRect??>(nil)

    public init(channels: Int, tiles: OrderedMap<TileKey, Tile>, defaultValue: Int = 0) {
        precondition(channels == 1 || channels == 4, "channels must be 1 or 4")
        self.id = nextSurfaceId.with { v in defer { v += 1 }; return v }
        self.channels = channels
        self.tiles = tiles
        self.defaultValue = defaultValue
    }

    /// Bounds of the stored (non-default) tiles, tile-aligned; `nil` when there are none.
    public var bounds: RasterRect? {
        boundsCache.with { cache in
            if let c = cache { return c }
            let b = tileUnion(tiles.keys)
            cache = .some(b)
            return b
        }
    }

    public var tileCount: Int { tiles.count }

    public func getTile(_ tx: Int, _ ty: Int) -> Tile? { tiles.get(tileKey(tx, ty)) }
}

public typealias PixelSurface = TiledSurface
public typealias MaskSurface = TiledSurface

private func tileUnion(_ keys: [TileKey]) -> RasterRect? {
    guard !keys.isEmpty else { return nil }
    var x0 = Int.max, y0 = Int.max, x1 = Int.min, y1 = Int.min
    for key in keys {
        let (tx, ty) = tileCoord(key)
        if tx < x0 { x0 = tx }
        if ty < y0 { y0 = ty }
        if tx > x1 { x1 = tx }
        if ty > y1 { y1 = ty }
    }
    return RasterRect(x: x0 * TILE, y: y0 * TILE, width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE)
}

// MARK: - Uniform tiles

private let uniformTiles = Locked(OrderedMap<String, Tile>())
private let UNIFORM_LIMIT = 64

/// Packs one pixel (`channels` bytes from `data` at `offset`) into a number.
@inline(__always) func packPixel(_ data: [UInt8], _ offset: Int, _ channels: Int) -> UInt32 {
    channels == 1
        ? UInt32(data[offset])
        : (UInt32(data[offset]) << 24) | (UInt32(data[offset + 1]) << 16) | (UInt32(data[offset + 2]) << 8) | UInt32(data[offset + 3])
}

/// The shared tile whose every pixel is `value` (packed RGBA, or one byte for masks).
public func uniformTile(_ channels: Int, _ value: UInt32) -> Tile {
    let key = "\(channels):\(value)"
    return uniformTiles.with { cache in
        if let tile = cache.get(key) { return tile }
        var data = [UInt8](repeating: 0, count: TILE_PIXELS * channels)
        if channels == 1 {
            if value != 0 { data = [UInt8](repeating: UInt8(truncatingIfNeeded: value), count: TILE_PIXELS) }
        } else if value != 0 {
            let r = UInt8(value >> 24), g = UInt8((value >> 16) & 255), b = UInt8((value >> 8) & 255), a = UInt8(value & 255)
            var i = 0
            while i < data.count {
                data[i] = r
                data[i + 1] = g
                data[i + 2] = b
                data[i + 3] = a
                i += 4
            }
        }
        let tile = Tile(data: data, uniform: value)
        if cache.count >= UNIFORM_LIMIT, let oldest = cache.first { cache.delete(oldest.key) }
        cache.set(key, tile)
        return tile
    }
}

/// Packs an RGBA colour (0..255 each) the way uniform tiles store it.
public func packRgba(_ r: Int, _ g: Int, _ b: Int, _ a: Int) -> UInt32 {
    UInt32(truncatingIfNeeded: (r << 24) | (g << 16) | (b << 8) | a)
}

func defaultPacked(_ channels: Int, _ defaultValue: Int) -> UInt32 {
    channels == 1 ? UInt32(defaultValue) : packRgba(defaultValue, defaultValue, defaultValue, defaultValue)
}

/// The packed value when every pixel of `data` is the same, else `nil`.
private func uniformValue(_ data: [UInt8], _ channels: Int) -> UInt32? {
    if data.isEmpty { return nil }
    if channels == 1 {
        let v = data[0]
        let ok = data.withUnsafeBytes { raw -> Bool in
            let w = UInt64(v) &* 0x0101_0101_0101_0101
            var i = 0
            while i + 8 <= raw.count {
                if raw.loadUnaligned(fromByteOffset: i, as: UInt64.self) != w { return false }
                i += 8
            }
            while i < raw.count {
                if raw[i] != v { return false }
                i += 1
            }
            return true
        }
        return ok ? UInt32(v) : nil
    }
    let a = data[0], b = data[1], c = data[2], d = data[3]
    let ok = data.withUnsafeBytes { raw -> Bool in
        let first = raw.loadUnaligned(as: UInt32.self)
        let pair = UInt64(first) | (UInt64(first) << 32)
        var i = 0
        while i + 8 <= raw.count {
            if raw.loadUnaligned(fromByteOffset: i, as: UInt64.self) != pair { return false }
            i += 8
        }
        if i + 4 <= raw.count, raw.loadUnaligned(fromByteOffset: i, as: UInt32.self) != first { return false }
        return true
    }
    return ok ? ((UInt32(a) << 24) | (UInt32(b) << 16) | (UInt32(c) << 8) | UInt32(d)) : nil
}

/**
 * Turns freshly written tile data into a stored tile: `nil` when it equals the surface default
 * (the tile is dropped), the shared uniform tile when it is uniform, else a tile owning `data`.
 */
public func finishTile(_ data: [UInt8], _ channels: Int, _ defaultValue: Int) -> Tile? {
    guard let u = uniformValue(data, channels) else { return Tile(data: data, uniform: nil) }
    if u == defaultPacked(channels, defaultValue) { return nil }
    return uniformTile(channels, u)
}

// MARK: - Construction

/// An empty surface (every pixel is `defaultValue`).
public func emptySurface(_ channels: Int = 4, _ defaultValue: Int = 0) -> TiledSurface {
    TiledSurface(channels: channels, tiles: OrderedMap(), defaultValue: defaultValue)
}

/// A surface filled with one value over `rect` (packed RGBA for layers, a byte for masks).
public func solidSurface(_ channels: Int, _ rect: RasterRect, _ value: UInt32, _ defaultValue: Int = 0) -> TiledSurface {
    var bytes = [UInt8](repeating: 0, count: channels)
    if channels == 1 {
        bytes[0] = UInt8(truncatingIfNeeded: value)
    } else {
        bytes[0] = UInt8(value >> 24)
        bytes[1] = UInt8((value >> 16) & 255)
        bytes[2] = UInt8((value >> 8) & 255)
        bytes[3] = UInt8(value & 255)
    }
    return fillRect(emptySurface(channels, defaultValue), rect, bytes)
}

/**
 * A surface holding `width × height` interleaved pixels placed at (`x`, `y`) in document space.
 * Tiles equal to the default are left out; uniform tiles are shared.
 */
public func surfaceFromPixels(width: Int, height: Int, data: [UInt8], channels: Int = 4, x: Int = 0, y: Int = 0, defaultValue: Int = 0) -> TiledSurface {
    writeRegion(emptySurface(channels, defaultValue), RasterRect(x: x, y: y, width: width, height: height), data)
}

// MARK: - Reading

/// Tile coordinates covering `rect`, row by row.
public func tilesInRect(_ rect: RasterRect) -> [(tx: Int, ty: Int)] {
    var out: [(tx: Int, ty: Int)] = []
    if rect.width <= 0 || rect.height <= 0 { return out }
    let tx0 = tileOf(rect.x)
    let ty0 = tileOf(rect.y)
    let tx1 = tileOf(rect.x + rect.width - 1)
    let ty1 = tileOf(rect.y + rect.height - 1)
    for ty in ty0...ty1 { for tx in tx0...tx1 { out.append((tx, ty)) } }
    return out
}

/**
 * Copies `rect` of the surface into `out` (or a new buffer), `rect.width × rect.height`
 * interleaved pixels; missing tiles read as the default.
 */
public func readRegion(_ surface: TiledSurface, _ rect: RasterRect) -> [UInt8] {
    let ch = surface.channels
    let w = rect.width
    let h = rect.height
    var dst = [UInt8](repeating: UInt8(truncatingIfNeeded: surface.defaultValue), count: Swift.max(0, w * h * ch))
    for (tx, ty) in tilesInRect(rect) {
        guard let tile = surface.getTile(tx, ty) else { continue }
        let ox = tx * TILE
        let oy = ty * TILE
        let x0 = Swift.max(rect.x, ox)
        let y0 = Swift.max(rect.y, oy)
        let x1 = Swift.min(rect.x + w, ox + TILE)
        let y1 = Swift.min(rect.y + h, oy + TILE)
        let span = (x1 - x0) * ch
        tile.data.withUnsafeBufferPointer { src in
            dst.withUnsafeMutableBufferPointer { d in
                for yy in y0..<y1 {
                    let s = ((yy - oy) * TILE + (x0 - ox)) * ch
                    let o = ((yy - rect.y) * w + (x0 - rect.x)) * ch
                    for k in 0..<span { d[o + k] = src[s + k] }
                }
            }
        }
    }
    return dst
}

/// One pixel's bytes (RGBA or the mask byte).
public func readPixel(_ surface: TiledSurface, _ x: Int, _ y: Int) -> [Int] {
    let ch = surface.channels
    guard let tile = surface.getTile(tileOf(x), tileOf(y)) else { return [Int](repeating: surface.defaultValue, count: ch) }
    let i = (((y & (TILE - 1)) * TILE) + (x & (TILE - 1))) * ch
    return (0..<ch).map { Int(tile.data[i + $0]) }
}

/**
 * Exact bounds of the pixels that differ from the default (for a layer: non-transparent), or
 * `nil`. Scans the stored tiles; uniform tiles count whole.
 */
public func contentBounds(_ surface: TiledSurface) -> RasterRect? {
    surface.contentBoundsCache.with { cache in
        if let c = cache { return c }
        let b = computeContentBounds(surface)
        cache = .some(b)
        return b
    }
}

private func computeContentBounds(_ surface: TiledSurface) -> RasterRect? {
    let ch = surface.channels
    let def = UInt8(truncatingIfNeeded: surface.defaultValue)
    var x0 = Int.max, y0 = Int.max, x1 = Int.min, y1 = Int.min
    for (key, tile) in surface.tiles {
        let (tx, ty) = tileCoord(key)
        let ox = tx * TILE
        let oy = ty * TILE
        if tile.uniform != nil {
            if ox < x0 { x0 = ox }
            if oy < y0 { y0 = oy }
            if ox + TILE - 1 > x1 { x1 = ox + TILE - 1 }
            if oy + TILE - 1 > y1 { y1 = oy + TILE - 1 }
            continue
        }
        tile.data.withUnsafeBufferPointer { d in
            let ptr = d.baseAddress!
            for y in 0..<TILE {
                var first = -1
                var last = -1
                let row = y * TILE * ch
                for x in 0..<TILE {
                    let i = row + x * ch
                    let differs: Bool
                    if ch == 4 {
                        differs = ptr[i] != def || ptr[i + 1] != def || ptr[i + 2] != def || ptr[i + 3] != def
                    } else {
                        differs = ptr[i] != def
                    }
                    if differs {
                        if first < 0 { first = x }
                        last = x
                    }
                }
                if first < 0 { continue }
                if ox + first < x0 { x0 = ox + first }
                if ox + last > x1 { x1 = ox + last }
                if oy + y < y0 { y0 = oy + y }
                if oy + y > y1 { y1 = oy + y }
            }
        }
    }
    if x0 == Int.max { return nil }
    return RasterRect(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1)
}

// MARK: - Writing (copy-on-write)

/**
 * A private, mutable copy of the tiles a write touches. `tile(tx, ty)` copies the tile on first
 * use; `commit()` returns a new surface sharing every untouched tile. Use it for strokes:
 * edit through the draft while the pointer moves and commit once at pointer-up.
 */
public final class SurfaceDraft {
    private var copies = OrderedMap<TileKey, TileBuffer>()
    public let base: TiledSurface

    public init(_ base: TiledSurface) { self.base = base }

    public var channels: Int { base.channels }

    /// The writable data of tile (tx, ty), copied from the base on first use.
    public func tile(_ tx: Int, _ ty: Int) -> TileBuffer {
        let key = tileKey(tx, ty)
        if let d = copies.get(key) { return d }
        let data: [UInt8]
        if let src = base.tiles.get(key) {
            data = src.data
        } else {
            data = [UInt8](repeating: UInt8(truncatingIfNeeded: base.defaultValue), count: TILE_PIXELS * base.channels)
        }
        let buf = TileBuffer(data)
        copies.set(key, buf)
        return buf
    }

    /// Replaces a whole tile with `data` (owned by the draft from now on).
    public func replace(_ tx: Int, _ ty: Int, _ data: [UInt8]) {
        copies.set(tileKey(tx, ty), TileBuffer(data))
    }

    /// The current data of a tile without copying it (base tile, draft copy or `nil` for default).
    public func peek(_ tx: Int, _ ty: Int) -> [UInt8]? {
        let key = tileKey(tx, ty)
        return copies.get(key)?.data ?? base.tiles.get(key)?.data
    }

    /// Keys of the tiles changed so far.
    public var touched: [TileKey] { copies.keys }

    /// A new surface with the draft's tiles; the draft must not be used afterwards.
    public func commit() -> TiledSurface {
        if copies.isEmpty { return base }
        var tiles = base.tiles
        for (key, buf) in copies {
            if let tile = finishTile(buf.data, base.channels, base.defaultValue) { tiles.set(key, tile) } else { tiles.delete(key) }
        }
        return TiledSurface(channels: base.channels, tiles: tiles, defaultValue: base.defaultValue)
    }
}

/// A draft's writable tile data (the TS draft hands out its typed array; this is the reference to it).
public final class TileBuffer {
    public var data: [UInt8]
    public init(_ data: [UInt8]) { self.data = data }
}

/// Writes `rect.width × rect.height` interleaved pixels at `rect`; returns the new surface.
public func writeRegion(_ surface: TiledSurface, _ rect: RasterRect, _ data: [UInt8]) -> TiledSurface {
    let ch = surface.channels
    let w = rect.width
    let h = rect.height
    if w <= 0 || h <= 0 { return surface }
    precondition(data.count >= w * h * ch, "writeRegion: expected \(w * h * ch) bytes, got \(data.count)")
    let draft = SurfaceDraft(surface)
    for (tx, ty) in tilesInRect(rect) {
        let ox = tx * TILE
        let oy = ty * TILE
        let x0 = Swift.max(rect.x, ox)
        let y0 = Swift.max(rect.y, oy)
        let x1 = Swift.min(rect.x + w, ox + TILE)
        let y1 = Swift.min(rect.y + h, oy + TILE)
        let full = x0 == ox && y0 == oy && x1 == ox + TILE && y1 == oy + TILE
        let buf = full ? TileBuffer([UInt8](repeating: 0, count: TILE_PIXELS * ch)) : draft.tile(tx, ty)
        let span = (x1 - x0) * ch
        data.withUnsafeBufferPointer { src in
            buf.data.withUnsafeMutableBufferPointer { tb in
                for yy in y0..<y1 {
                    let s = ((yy - rect.y) * w + (x0 - rect.x)) * ch
                    let d = ((yy - oy) * TILE + (x0 - ox)) * ch
                    for k in 0..<span { tb[d + k] = src[s + k] }
                }
            }
        }
        if full { draft.replace(tx, ty, buf.data) }
    }
    return draft.commit()
}

/// Fills `rect` with one pixel value (`bytes`, `channels` long).
public func fillRect(_ surface: TiledSurface, _ rect: RasterRect, _ bytes: [UInt8]) -> TiledSurface {
    let ch = surface.channels
    if rect.width <= 0 || rect.height <= 0 { return surface }
    var tiles = surface.tiles
    let draft = SurfaceDraft(surface)
    let value = packPixel(bytes, 0, ch)
    let isDefault = value == defaultPacked(ch, surface.defaultValue)
    for (tx, ty) in tilesInRect(rect) {
        let ox = tx * TILE
        let oy = ty * TILE
        let x0 = Swift.max(rect.x, ox)
        let y0 = Swift.max(rect.y, oy)
        let x1 = Swift.min(rect.x + rect.width, ox + TILE)
        let y1 = Swift.min(rect.y + rect.height, oy + TILE)
        let key = tileKey(tx, ty)
        if x0 == ox && y0 == oy && x1 == ox + TILE && y1 == oy + TILE {
            if isDefault { tiles.delete(key) } else { tiles.set(key, uniformTile(ch, value)) }
            continue
        }
        let t = draft.tile(tx, ty)
        for yy in y0..<y1 {
            var d = ((yy - oy) * TILE + (x0 - ox)) * ch
            for _ in x0..<x1 {
                for c in 0..<ch { t.data[d + c] = bytes[c] }
                d += ch
            }
        }
        if let tile = finishTile(t.data, ch, surface.defaultValue) { tiles.set(key, tile) } else { tiles.delete(key) }
    }
    return TiledSurface(channels: ch, tiles: tiles, defaultValue: surface.defaultValue)
}

/// A copy of the surface moved by an integer offset (re-tiles; layers normally move by `offset`).
public func translateSurface(_ surface: TiledSurface, _ dxIn: Double, _ dyIn: Double) -> TiledSurface {
    let dx = Int(JS.round(dxIn))
    let dy = Int(JS.round(dyIn))
    if dx == 0 && dy == 0 { return surface }
    if dx % TILE == 0 && dy % TILE == 0 {
        var tiles = OrderedMap<TileKey, Tile>()
        for (key, tile) in surface.tiles {
            let (tx, ty) = tileCoord(key)
            tiles.set(tileKey(tx + dx / TILE, ty + dy / TILE), tile)
        }
        return TiledSurface(channels: surface.channels, tiles: tiles, defaultValue: surface.defaultValue)
    }
    guard let b = surface.bounds else { return surface }
    let data = readRegion(surface, b)
    return writeRegion(emptySurface(surface.channels, surface.defaultValue), RasterRect(x: b.x + dx, y: b.y + dy, width: b.width, height: b.height), data)
}

// MARK: - Memory

/// Bytes held by a surface's non-uniform tiles (uniform tiles are shared and nearly free).
public func surfaceBytes(_ surface: TiledSurface) -> Int {
    var n = 0
    for (_, tile) in surface.tiles where tile.uniform == nil { n += tile.data.count }
    return n
}

/// Adds every non-uniform tile of `surface` to `into` (for counting bytes shared across states).
public func collectTiles(_ surface: TiledSurface, _ into: inout Set<ObjectIdentifier>) {
    for (_, tile) in surface.tiles where tile.uniform == nil { into.insert(ObjectIdentifier(tile)) }
}

/// True when two surfaces hold the same pixels (cheap when they share tiles).
public func surfacesEqual(_ a: TiledSurface, _ b: TiledSurface) -> Bool {
    if a === b { return true }
    if a.channels != b.channels || a.defaultValue != b.defaultValue || a.tiles.count != b.tiles.count { return false }
    for (key, ta) in a.tiles {
        guard let tb = b.tiles.get(key) else { return false }
        if ta === tb { continue }
        if ta.uniform != nil || tb.uniform != nil {
            if ta.uniform != tb.uniform { return false }
            continue
        }
        if ta.data != tb.data { return false }
    }
    return true
}
