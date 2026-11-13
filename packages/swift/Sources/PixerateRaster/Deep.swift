import Foundation

/**
 * High bit depth tiles: 16-bit and 32-bit float samples alongside the 8-bit tile data. The port
 * of `raster/deep.ts`.
 *
 * A tile may carry `deep` samples next to its `data`:
 *
 * - `.u16`: 16 bits per channel, 0..65535, the same sRGB encoding and straight alpha as the 8-bit
 *   data (`data = round(deep / 257)`).
 * - `.f32`: 32-bit float per channel in **linear light** (sRGB primaries), straight alpha, as
 *   Photoshop's 32-bit mode; colour may exceed 1 (`data` is the clamped sRGB encoding).
 *
 * `data` is always the 8-bit rendering of `deep`, so every 8-bit consumer keeps working unchanged:
 * it simply sees the 8-bit picture. A tile without `deep` holds 8-bit pixels; read at a higher
 * depth (`tileSamples16` / `tileSamples32`) they are converted exactly as a bit-depth conversion
 * would. Writers that only produce 8-bit data drop `deep` for the tiles they rewrite, and writers
 * that understand depth build tiles with `deepTile`.
 *
 * Masks (one channel) are coverage, not colour: their float samples are never linearised.
 */

/// Bits per channel: 8, 16 or 32 (float).
public typealias BitDepth = Int

public let BIT_DEPTHS: [BitDepth] = [8, 16, 32]

public func isBitDepth(_ v: Int) -> Bool { v == 8 || v == 16 || v == 32 }

// MARK: - Transfer functions

/// sRGB-encoded 0..1 to linear light.
public func srgbDecode(_ v: Double) -> Double {
    v <= 0.04045 ? v / 12.92 : JS.pow((v + 0.055) / 1.055, 2.4)
}

/// Linear light to sRGB-encoded (values above 1 extend the curve; below 0 clamp to 0).
public func srgbEncode(_ v: Double) -> Double {
    if !(v > 0) { return 0 }
    return v <= 0.0031308 ? v * 12.92 : 1.055 * JS.pow(v, 1 / 2.4) - 0.055
}

/// Linear light of every 8-bit code.
private let LIN8: [Float] = (0..<256).map { Float(srgbDecode(Double($0) / 255)) }
/// Linear light of every 16-bit code.
private let LIN16: [Float] = (0..<65536).map { Float(srgbDecode(Double($0) / 65535)) }

/// Linear `v` as a 16-bit sRGB code (clamped).
private func encode16(_ v: Double) -> UInt16 {
    if !(v > 0) { return 0 }
    if v >= 1 { return 65535 }
    return UInt16(JS.round(srgbEncode(v) * 65535))
}

/// Linear light (0..1 in 65536 steps, fine enough for 8 bits even near black) to an 8-bit sRGB code.
private let ENC8: [UInt8] = (0..<65536).map { UInt8(JS.round(srgbEncode(Double($0) / 65535) * 255)) }
private func encode8(_ v: Double) -> UInt8 {
    if !(v > 0) { return 0 }
    if v >= 1 { return 255 }
    return ENC8[Int(JS.round(v * 65535))]
}

// MARK: - Sample conversions (whole buffers, interleaved, `channels` per pixel)

/// 8-bit samples to 16-bit (`v × 257`, exact both ways).
public func to16From8(_ data: [UInt8]) -> [UInt16] {
    data.map { UInt16($0) * 257 }
}

/// 8-bit samples to 32-bit float (colour linearised; alpha and masks as is).
public func to32From8(_ data: [UInt8], _ channels: Int) -> [Float] {
    if channels == 1 { return data.map { Float(Double($0) / 255) } }
    var out = [Float](repeating: 0, count: data.count)
    var i = 0
    while i + 3 < data.count {
        out[i] = LIN8[Int(data[i])]
        out[i + 1] = LIN8[Int(data[i + 1])]
        out[i + 2] = LIN8[Int(data[i + 2])]
        out[i + 3] = Float(Double(data[i + 3]) / 255)
        i += 4
    }
    return out
}

/// 16-bit samples to 32-bit float.
public func to32From16(_ data: [UInt16], _ channels: Int) -> [Float] {
    if channels == 1 { return data.map { Float(Double($0) / 65535) } }
    var out = [Float](repeating: 0, count: data.count)
    var i = 0
    while i + 3 < data.count {
        out[i] = LIN16[Int(data[i])]
        out[i + 1] = LIN16[Int(data[i + 1])]
        out[i + 2] = LIN16[Int(data[i + 2])]
        out[i + 3] = Float(Double(data[i + 3]) / 65535)
        i += 4
    }
    return out
}

@inline(__always) private func unit16(_ v: Double) -> UInt16 { v > 0 ? (v < 1 ? UInt16(JS.round(v * 65535)) : 65535) : 0 }

/// 32-bit float samples to 16-bit (colour encoded and clamped to 0..1).
public func to16From32(_ data: [Float], _ channels: Int) -> [UInt16] {
    if channels == 1 { return data.map { unit16(Double($0)) } }
    var out = [UInt16](repeating: 0, count: data.count)
    var i = 0
    while i + 3 < data.count {
        out[i] = encode16(Double(data[i]))
        out[i + 1] = encode16(Double(data[i + 1]))
        out[i + 2] = encode16(Double(data[i + 2]))
        out[i + 3] = unit16(Double(data[i + 3]))
        i += 4
    }
    return out
}

/// 16-bit samples to 8-bit (rounded).
public func to8From16(_ data: [UInt16]) -> [UInt8] {
    data.map { JS.u8c(JS.round(Double($0) / 257)) }
}

/// 32-bit float samples to 8-bit (colour encoded and clamped).
public func to8From32(_ data: [Float], _ channels: Int) -> [UInt8] {
    if channels == 1 { return data.map { JS.u8c(JS.round(Double($0) * 255)) } }
    var out = [UInt8](repeating: 0, count: data.count)
    var i = 0
    while i + 3 < data.count {
        out[i] = encode8(Double(data[i]))
        out[i + 1] = encode8(Double(data[i + 1]))
        out[i + 2] = encode8(Double(data[i + 2]))
        out[i + 3] = JS.u8c(JS.round(JS.min(1, JS.max(0, Double(data[i + 3]))) * 255))
        i += 4
    }
    return out
}

/// The 8-bit rendering of deep samples.
public func proxyOf(_ deep: DeepSamples, _ channels: Int) -> [UInt8] {
    switch deep {
    case .u16(let a): return to8From16(a)
    case .f32(let a): return to8From32(a, channels)
    }
}

/// The bit depth deep samples hold.
public func depthOf(_ deep: DeepSamples) -> Int {
    if case .u16 = deep { return 16 }
    return 32
}

// MARK: - Tiles

/**
 * A stored tile from deep samples (`TILE × TILE × channels`): `nil` when it renders as the
 * surface default and holds nothing finer, an 8-bit tile when 8 bits hold it exactly (16-bit
 * samples that are multiples of 257), else a tile with `deep` and its 8-bit rendering.
 */
public func deepTile(_ deep: DeepSamples, _ channels: Int, _ defaultValue: Int = 0) -> Tile? {
    let data = proxyOf(deep, channels)
    switch deep {
    case .u16(let a):
        if a.allSatisfy({ $0 % 257 == 0 }) { return finishTile(data, channels, defaultValue) }
    case .f32(let a):
        if channels == 4 && defaultValue == 0 {
            // A float layer tile that is transparent everywhere stores nothing.
            var empty = true
            var i = 3
            while i < a.count {
                if a[i] != 0 {
                    empty = false
                    break
                }
                i += 4
            }
            if empty { return nil }
        }
    }
    return Tile(data: data, uniform: nil, deep: deep)
}

/// 16-bit samples of a tile (`nil`: the default tile), converting 8-bit or float data.
public func tileSamples16(_ tile: Tile?, _ channels: Int, _ defaultValue: Int = 0) -> [UInt16] {
    if let deep = tile?.deep {
        switch deep {
        case .u16(let a): return a
        case .f32(let a): return to16From32(a, channels)
        }
    }
    if let tile { return to16From8(tile.data) }
    return [UInt16](repeating: UInt16(truncatingIfNeeded: defaultValue * 257), count: TILE_PIXELS * channels)
}

/// 32-bit float samples of a tile (`nil`: the default tile), converting 8- or 16-bit data.
public func tileSamples32(_ tile: Tile?, _ channels: Int, _ defaultValue: Int = 0) -> [Float] {
    if let deep = tile?.deep {
        switch deep {
        case .f32(let a): return a
        case .u16(let a): return to32From16(a, channels)
        }
    }
    if let tile { return to32From8(tile.data, channels) }
    if defaultValue != 0 {
        if channels == 1 { return [Float](repeating: Float(Double(defaultValue) / 255), count: TILE_PIXELS) }
        return to32From8([UInt8](repeating: UInt8(truncatingIfNeeded: defaultValue), count: TILE_PIXELS * 4), 4)
    }
    return [Float](repeating: 0, count: TILE_PIXELS * channels)
}

/// Deep samples of a tile at `depth` (16 or 32).
public func tileSamples(_ tile: Tile?, _ channels: Int, _ depth: Int, _ defaultValue: Int = 0) -> DeepSamples {
    depth == 16 ? .u16(tileSamples16(tile, channels, defaultValue)) : .f32(tileSamples32(tile, channels, defaultValue))
}

// MARK: - Surfaces

/// The deepest samples any tile of a surface holds: 8, 16 or 32.
public func surfaceDepth(_ surface: TiledSurface) -> BitDepth {
    var d = 8
    for (_, t) in surface.tiles {
        if case .f32 = t.deep { return 32 }
        if t.deep != nil { d = 16 }
    }
    return d
}

/// Copies `rect` of a surface at 16 bits into a new buffer (`rect.width × rect.height × channels`).
public func readDeepRegion16(_ surface: TiledSurface, _ rect: RasterRect) -> [UInt16] {
    if case .u16(let a) = readDeepRegion(surface, rect, 16) { return a }
    return []
}

/// Copies `rect` of a surface at 32 bits into a new buffer (`rect.width × rect.height × channels`).
public func readDeepRegion32(_ surface: TiledSurface, _ rect: RasterRect) -> [Float] {
    if case .f32(let a) = readDeepRegion(surface, rect, 32) { return a }
    return []
}

/// Copies `rect` of a surface at `depth` into a new buffer (`rect.width × rect.height × channels`).
public func readDeepRegion(_ surface: TiledSurface, _ rect: RasterRect, _ depth: Int) -> DeepSamples {
    let ch = surface.channels
    let w = rect.width
    let h = rect.height
    let n = Swift.max(0, w * h * ch)
    let fill = surface.defaultValue != 0 ? tileSamples(nil, ch, depth, surface.defaultValue) : nil
    func copy<T: Numeric>(_ zero: T, _ fillSamples: [T]?, _ samplesOf: (Tile) -> [T]) -> [T] {
        var out = [T](repeating: zero, count: n)
        if let f = fillSamples {
            var i = 0
            while i < n {
                for c in 0..<ch { out[i + c] = f[c] }
                i += ch
            }
        }
        for (tx, ty) in tilesInRect(rect) {
            guard let tile = surface.tiles.get(tileKey(tx, ty)) else { continue }
            let src = samplesOf(tile)
            let ox = tx * TILE
            let oy = ty * TILE
            let x0 = Swift.max(rect.x, ox)
            let y0 = Swift.max(rect.y, oy)
            let x1 = Swift.min(rect.x + w, ox + TILE)
            let y1 = Swift.min(rect.y + h, oy + TILE)
            let span = (x1 - x0) * ch
            for yy in y0..<y1 {
                let s = ((yy - oy) * TILE + (x0 - ox)) * ch
                let d = ((yy - rect.y) * w + (x0 - rect.x)) * ch
                for k in 0..<span { out[d + k] = src[s + k] }
            }
        }
        return out
    }
    if depth == 16 {
        var f: [UInt16]? = nil
        if case .u16(let a) = fill { f = a }
        return .u16(copy(UInt16(0), f) { tileSamples16($0, ch, surface.defaultValue) })
    }
    var f: [Float]? = nil
    if case .f32(let a) = fill { f = a }
    return .f32(copy(Float(0), f) { tileSamples32($0, ch, surface.defaultValue) })
}

/**
 * Writes `rect.width × rect.height` interleaved deep samples at `rect` and returns the new
 * surface. Partly covered tiles keep their other pixels, converted to the samples' depth.
 */
public func writeDeepRegion(_ surface: TiledSurface, _ rect: RasterRect, _ samples: DeepSamples) -> TiledSurface {
    let ch = surface.channels
    let w = rect.width
    let h = rect.height
    if w <= 0 || h <= 0 { return surface }
    precondition(samples.count >= w * h * ch, "writeDeepRegion: expected \(w * h * ch) samples, got \(samples.count)")
    var tiles = surface.tiles
    func place<T: Numeric>(_ t: inout [T], _ src: [T], _ ox: Int, _ oy: Int, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
        let span = (x1 - x0) * ch
        for yy in y0..<y1 {
            let s = ((yy - rect.y) * w + (x0 - rect.x)) * ch
            let d = ((yy - oy) * TILE + (x0 - ox)) * ch
            for k in 0..<span { t[d + k] = src[s + k] }
        }
    }
    for (tx, ty) in tilesInRect(rect) {
        let key = tileKey(tx, ty)
        let ox = tx * TILE
        let oy = ty * TILE
        let x0 = Swift.max(rect.x, ox)
        let y0 = Swift.max(rect.y, oy)
        let x1 = Swift.min(rect.x + w, ox + TILE)
        let y1 = Swift.min(rect.y + h, oy + TILE)
        let full = x0 == ox && y0 == oy && x1 == ox + TILE && y1 == oy + TILE
        let next: DeepSamples
        switch samples {
        case .u16(let src):
            var t = full ? [UInt16](repeating: 0, count: TILE_PIXELS * ch) : tileSamples16(surface.tiles.get(key), ch, surface.defaultValue)
            place(&t, src, ox, oy, x0, y0, x1, y1)
            next = .u16(t)
        case .f32(let src):
            var t = full ? [Float](repeating: 0, count: TILE_PIXELS * ch) : tileSamples32(surface.tiles.get(key), ch, surface.defaultValue)
            place(&t, src, ox, oy, x0, y0, x1, y1)
            next = .f32(t)
        }
        if let tile = deepTile(next, ch, surface.defaultValue) { tiles.set(key, tile) } else { tiles.delete(key) }
    }
    return TiledSurface(channels: ch, tiles: tiles, defaultValue: surface.defaultValue)
}

/// Thrown by `writeDeepRegionUnchecked` where the TS core's typed arrays throw.
public struct DeepRegionError: Error, CustomStringConvertible {
    public let description: String
}

/// `subarray`'s relative index: truncated toward zero (NaN 0), counted from the end when negative, clamped to `count`.
private func subarrayIndex(_ v: Double, _ count: Int) -> Int {
    let t: Double = v.isNaN ? 0 : v.rounded(.towardZero)
    if t < 0 { return Int(Swift.max(Double(count) + t, 0)) }
    return Int(Swift.min(t, Double(count)))
}

/// `t.set(src.subarray(begin, end), d)` (throws "offset is out of bounds" where `set` does).
private func setSubarray<T>(_ t: inout [T], _ src: [T], _ s: Double, _ span: Double, _ d: Double) throws {
    let begin = subarrayIndex(s, src.count)
    let end = subarrayIndex(s + span, src.count)
    let count = Swift.max(end - begin, 0)
    let offset: Double = d.isNaN ? 0 : d.rounded(.towardZero)
    if offset < 0 || Double(count) + offset > Double(t.count) { throw DeepRegionError(description: "offset is out of bounds") }
    let o = Int(offset)
    for k in 0 ..< count { t[o + k] = src[begin + k] }
}

/**
 * `writeDeepRegion` with a rect read unchecked from a saved document, in JavaScript arithmetic:
 * `width` / `height` are the numbers the multiplications see, `xEnd` / `yEnd` are what
 * `rect.x + rect.width` / `rect.y + rect.height` give (a text width concatenates), a fractional
 * size copies the rows typed-array `subarray` truncates to, and far-off tiles share the keys TS
 * rounds them to (`jsTileKey`). Throws where `writeDeepRegion` would.
 */
public func writeDeepRegionUnchecked(_ surface: TiledSurface, x: Double, y: Double, width w: Double, height h: Double, xEnd: Double, yEnd: Double, _ samples: DeepSamples) throws -> TiledSurface {
    let ch = surface.channels
    let c = Double(ch)
    if w <= 0 || h <= 0 { return surface }
    let need: Double = w * h * c
    if Double(samples.count) < need { throw DeepRegionError(description: "writeDeepRegion: expected \(need) samples, got \(samples.count)") }
    var tiles = surface.tiles
    let T = Double(TILE)
    let tx0 = JS.floor(x / T), ty0 = JS.floor(y / T)
    let tx1 = JS.floor((xEnd - 1) / T), ty1 = JS.floor((yEnd - 1) / T)
    var ty = ty0
    while ty <= ty1 {
        var tx = tx0
        while tx <= tx1 {
            let key = jsTileKey(tx, ty)
            let ox: Double = tx * T
            let oy: Double = ty * T
            let x0 = JS.max(x, ox), y0 = JS.max(y, oy)
            let x1 = JS.min(xEnd, ox + T), y1 = JS.min(yEnd, oy + T)
            let full: Bool = x0 == ox && y0 == oy && x1 == ox + T && y1 == oy + T
            let span: Double = (x1 - x0) * c
            let next: DeepSamples
            switch samples {
            case .u16(let src):
                var t = full ? [UInt16](repeating: 0, count: TILE_PIXELS * ch) : tileSamples16(surface.tiles.get(key), ch, surface.defaultValue)
                var yy = y0
                while yy < y1 {
                    let s: Double = ((yy - y) * w + (x0 - x)) * c
                    let d: Double = ((yy - oy) * T + (x0 - ox)) * c
                    try setSubarray(&t, src, s, span, d)
                    yy += 1
                }
                next = .u16(t)
            case .f32(let src):
                var t = full ? [Float](repeating: 0, count: TILE_PIXELS * ch) : tileSamples32(surface.tiles.get(key), ch, surface.defaultValue)
                var yy = y0
                while yy < y1 {
                    let s: Double = ((yy - y) * w + (x0 - x)) * c
                    let d: Double = ((yy - oy) * T + (x0 - ox)) * c
                    try setSubarray(&t, src, s, span, d)
                    yy += 1
                }
                next = .f32(t)
            }
            if let tile = deepTile(next, ch, surface.defaultValue) { tiles.set(key, tile) } else { tiles.delete(key) }
            tx += 1
        }
        ty += 1
    }
    return TiledSurface(channels: ch, tiles: tiles, defaultValue: surface.defaultValue)
}

/// A surface holding `width × height` deep samples placed at (`x`, `y`).
public func surfaceFromDeepPixels(width: Int, height: Int, data: DeepSamples, channels: Int = 4, x: Int = 0, y: Int = 0, defaultValue: Int = 0) -> TiledSurface {
    writeDeepRegion(emptySurface(channels, defaultValue), RasterRect(x: x, y: y, width: width, height: height), data)
}

/**
 * The surface converted to `depth`: 8 drops every tile's deep samples (keeping their 8-bit
 * rendering); 16 or 32 converts the deep samples tiles already hold. Tiles without deep samples
 * are left alone (they read at any depth by conversion), so going up from 8 bits costs nothing.
 * Returns the same surface when nothing changes.
 */
public func convertSurfaceDepth(_ surface: TiledSurface, _ depth: BitDepth) -> TiledSurface {
    var changed = false
    var tiles = surface.tiles
    let ch = surface.channels
    for (key, tile) in surface.tiles {
        guard let deep = tile.deep, depthOf(deep) != depth else { continue }
        changed = true
        let next: Tile?
        if depth == 8 {
            next = finishTile(tile.data, ch, surface.defaultValue)
        } else {
            switch deep {
            case .f32(let a): next = deepTile(.u16(to16From32(a, ch)), ch, surface.defaultValue)
            case .u16(let a): next = deepTile(.f32(to32From16(a, ch)), ch, surface.defaultValue)
            }
        }
        if let next { tiles.set(key, next) } else { tiles.delete(key) }
    }
    return changed ? TiledSurface(channels: ch, tiles: tiles, defaultValue: surface.defaultValue) : surface
}

/// Bytes held by deep samples (in addition to `surfaceBytes`).
public func deepBytes(_ surface: TiledSurface) -> Int {
    var n = 0
    for (_, t) in surface.tiles { if let d = t.deep { n += d.byteLength } }
    return n
}

/**
 * `after` (a surface an 8-bit operation rewrote from `before`) with the deep samples kept where
 * the operation left a pixel's 8-bit value alone: a rewritten tile of a deep surface becomes deep
 * again, its unchanged pixels taking `before`'s samples and its changed ones the 8-bit result
 * lifted to the depth. The result renders exactly as `after` does, so it is never worse than the
 * 8-bit path, and an untouched area of a filtered, smudged or cloned 16-bit layer keeps 16 bits.
 */
public func keepDeepSamples(_ before: TiledSurface, _ after: TiledSurface) -> TiledSurface {
    if before === after || before.channels != after.channels || before.defaultValue != after.defaultValue { return after }
    let depth = surfaceDepth(before)
    if depth == 8 { return after }
    let ch = after.channels
    var tiles: OrderedMap<TileKey, Tile>? = nil
    for (key, ta) in after.tiles {
        if ta.deep != nil { continue }
        guard let tb = before.tiles.get(key), let deep = tb.deep, tb !== ta else { continue }
        let a = ta.data
        let b = tb.data
        var kept = false
        func keep<T>(_ out: inout [T], _ src: (Int) -> T) {
            var i = 0
            while i < a.count {
                var same = true
                for c in 0..<ch where a[i + c] != b[i + c] { same = false }
                if same {
                    for c in 0..<ch { out[i + c] = src(i + c) }
                    kept = true
                }
                i += ch
            }
        }
        // As in TS, a shallower deep tile of a mixed-depth surface is copied by value (the typed
        // array store converts it: a float into a Uint16Array truncates).
        let out: DeepSamples
        switch tileSamples(ta, ch, depth, after.defaultValue) {
        case .u16(var o):
            keep(&o) { JS.u16(deep[$0]) }
            out = .u16(o)
        case .f32(var o):
            keep(&o) { Float(deep[$0]) }
            out = .f32(o)
        }
        if !kept { continue }
        let tile = deepTile(out, ch, after.defaultValue)
        if tiles == nil { tiles = after.tiles }
        if let tile { tiles!.set(key, tile) } else { tiles!.delete(key) }
    }
    if let tiles { return TiledSurface(channels: ch, tiles: tiles, defaultValue: after.defaultValue) }
    return after
}
