import Foundation

/**
 * Showing a tiled surface in a pannable, zoomable view (an infinite canvas): world ↔ surface
 * mapping with a resolution policy, the surface rectangle a view can see, and drawing a surface
 * tile by tile with visible-tile culling and mip levels. The port of `raster/viewport.ts`; hosts
 * bring the image type and the drawing (a `CGContext`, a SwiftUI `GraphicsContext`, …) through
 * `ViewportDrawing`, so this stays Foundation only.
 *
 * Coordinates: **world** units are the host's. **Surface** pixels are the tiled surface's;
 * surface pixel (0, 0) sits at world `origin` and one world unit is `pixelsPerUnit` surface
 * pixels. **Screen** pixels follow the view: `screen = world × zoom + (x, y)`.
 */

/// Where a surface lies in the world.
public struct SurfaceMapping: Equatable, Sendable {
    /// World position of surface pixel (0, 0) (default 0, 0).
    public var origin: Vec2?
    /// Surface pixels per world unit (default 1).
    public var pixelsPerUnit: Double?
    public init(origin: Vec2? = nil, pixelsPerUnit: Double? = nil) {
        self.origin = origin
        self.pixelsPerUnit = pixelsPerUnit
    }
}

/// A pan / zoom view: `screen = world × zoom + (x, y)`.
public struct ViewTransform: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var zoom: Double
    public init(x: Double, y: Double, zoom: Double) {
        self.x = x
        self.y = y
        self.zoom = zoom
    }
}

private func ppuOf(_ m: SurfaceMapping) -> Double {
    if let p = m.pixelsPerUnit, p > 0 { return p }
    return 1
}

/// A world point in surface pixels.
public func worldToSurface(_ mapping: SurfaceMapping, _ x: Double, _ y: Double) -> Vec2 {
    let k = ppuOf(mapping)
    return Vec2(x: (x - (mapping.origin?.x ?? 0)) * k, y: (y - (mapping.origin?.y ?? 0)) * k)
}

/// A surface pixel position in world units.
public func surfaceToWorld(_ mapping: SurfaceMapping, _ x: Double, _ y: Double) -> Vec2 {
    let k = ppuOf(mapping)
    return Vec2(x: x / k + (mapping.origin?.x ?? 0), y: y / k + (mapping.origin?.y ?? 0))
}

/// A world rectangle as the whole surface pixels it touches.
public func worldRectToSurface(_ mapping: SurfaceMapping, _ rect: Box) -> RasterRect {
    let a = worldToSurface(mapping, rect.x, rect.y)
    let b = worldToSurface(mapping, rect.x + rect.width, rect.y + rect.height)
    let x = Int(JS.floor(JS.min(a.x, b.x)))
    let y = Int(JS.floor(JS.min(a.y, b.y)))
    return RasterRect(x: x, y: y, width: Int(JS.ceil(JS.max(a.x, b.x))) - x, height: Int(JS.ceil(JS.max(a.y, b.y))) - y)
}

/// A screen point (relative to the view's element) in world units.
public func screenToWorld(_ view: ViewTransform, _ x: Double, _ y: Double) -> Vec2 {
    let z = view.zoom > 0 ? view.zoom : 1
    return Vec2(x: (x - view.x) / z, y: (y - view.y) / z)
}

/// The world rectangle a `width × height` screen area shows.
public func visibleWorldRect(_ view: ViewTransform, _ width: Double, _ height: Double) -> Box {
    let a = screenToWorld(view, 0, 0)
    let z = view.zoom > 0 ? view.zoom : 1
    return Box(x: a.x, y: a.y, width: width / z, height: height / z)
}

/// The surface pixels a `width × height` screen area shows (pad by `margin` surface pixels).
public func visibleSurfaceRect(_ mapping: SurfaceMapping, _ view: ViewTransform, _ width: Double, _ height: Double, _ margin: Int = 0) -> RasterRect {
    let r = worldRectToSurface(mapping, visibleWorldRect(view, width, height))
    return RasterRect(x: r.x - margin, y: r.y - margin, width: r.width + 2 * margin, height: r.height + 2 * margin)
}

public struct ResolutionPolicy: Sendable {
    /// Screen pixel density (default 1).
    public var devicePixelRatio: Double?
    /// Fewest surface pixels per world unit (default 1/4).
    public var min: Double?
    /// Most surface pixels per world unit (default 8).
    public var max: Double?
    public init(devicePixelRatio: Double? = nil, min: Double? = nil, max: Double? = nil) {
        self.devicePixelRatio = devicePixelRatio
        self.min = min
        self.max = max
    }
}

/**
 * The surface density (pixels per world unit) for painting at `zoom`: the screen density rounded
 * up to a power of two and clamped, so strokes are never coarser than the screen and nearby
 * zooms share a density.
 */
public func surfaceResolutionForZoom(_ zoom: Double, _ policy: ResolutionPolicy = ResolutionPolicy()) -> Double {
    let s = zoom * ((policy.devicePixelRatio ?? 0) > 0 ? policy.devicePixelRatio! : 1)
    let mn = (policy.min ?? 0) > 0 ? policy.min! : 1.0 / 4
    let mx = (policy.max ?? 0) > 0 ? policy.max! : 8
    if !s.isFinite || s <= 0 { return JS.min(mx, JS.max(mn, 1)) }
    return JS.min(mx, JS.max(mn, JS.pow(2, JS.ceil(JS.log2(s) - 1e-9))))
}

/**
 * The mip level to draw a surface at: 0 at or above half a screen pixel per surface pixel, then
 * one level per halving (each level halves the resolution), at most `maxLevel`.
 */
public func surfaceMipLevel(_ screenPixelsPerSurfacePixel: Double, _ maxLevel: Int = 4) -> Int {
    let s = screenPixelsPerSurfacePixel
    if !(s > 0) || s >= 0.5 { return 0 }
    return Swift.min(maxLevel, Int(JS.floor(JS.log2(1 / s))))
}

// MARK: - Drawing

/// What `SurfaceViewportRenderer.draw` draws on (a 2D context, structurally).
public protocol ViewportDrawing {
    associatedtype Image: AnyObject
    /// Smooth scaling when drawing images.
    mutating func setImageSmoothing(_ enabled: Bool)
    mutating func drawImage(_ image: Image, _ dx: Int, _ dy: Int, _ dw: Int, _ dh: Int)
}

public struct DrawSurfaceOptions: Sendable {
    /// View area in screen pixels.
    public var width: Double
    public var height: Double
    /// Highest mip level (default 4: down to 1/16 resolution).
    public var maxMipLevel: Int?
    /// Smooth scaling (default: true when zoomed out, false when a surface pixel covers 2+ screen pixels).
    public var smoothing: Bool?
    public init(width: Double, height: Double, maxMipLevel: Int? = nil, smoothing: Bool? = nil) {
        self.width = width
        self.height = height
        self.maxMipLevel = maxMipLevel
        self.smoothing = smoothing
    }
}

public struct DrawSurfaceStats: Equatable, Sendable {
    public var level: Int
    /// Tiles drawn (at that level).
    public var drawn: Int
    /// Tile images made this call (the rest came from the cache).
    public var built: Int
}

/// Box-filters `n × n` blocks of straight-alpha RGBA (premultiplied while averaging) into `out` at (`ox`, `oy`).
public func downsampleInto(_ src: [UInt8], _ n: Int, _ out: inout [UInt8], _ ox: Int, _ oy: Int) {
    let side = TILE / n
    let area = Double(n * n)
    for y in 0..<side {
        for x in 0..<side {
            var r = 0.0, g = 0.0, b = 0.0, a = 0.0
            for dy in 0..<n {
                var i = ((y * n + dy) * TILE + x * n) * 4
                for _ in 0..<n {
                    let al = Double(src[i + 3])
                    r += Double(src[i]) * al
                    g += Double(src[i + 1]) * al
                    b += Double(src[i + 2]) * al
                    a += al
                    i += 4
                }
            }
            let o = ((oy + y) * TILE + ox + x) * 4
            if a > 0 {
                out[o] = JS.u8c(r / a)
                out[o + 1] = JS.u8c(g / a)
                out[o + 2] = JS.u8c(b / a)
                out[o + 3] = JS.u8c(a / area)
            }
        }
    }
}

/**
 * Draws tiled surfaces, keeping a cache of tile images: level-0 images by tile identity (tiles are
 * copy-on-write, so an edited tile is a new object), mip images by the tiles they were built from.
 * One renderer per surface you show; `clear` drops the cache.
 */
public final class SurfaceViewportRenderer<C: AnyObject> {
    private let base = IdentityCache<Tile, C>()
    private var mips: [String: (sources: [Tile?], canvas: C)] = [:]
    private var uniform: [UInt32: C] = [:]
    private let createImage: ([UInt8], Int, Int) -> C?

    /// `createImage(rgba, 256, 256)` makes a tile image (straight RGBA bytes).
    public init(createImage: @escaping (_ data: [UInt8], _ width: Int, _ height: Int) -> C?) {
        self.createImage = createImage
    }

    public func clear() {
        mips.removeAll()
        uniform.removeAll()
    }

    private func image(_ data: [UInt8]) -> C? { createImage(data, TILE, TILE) }

    private func tileImage(_ tile: Tile) -> C? {
        if let c = base.get(tile) { return c }
        guard let c = image(tile.data) else { return nil }
        base.set(tile, c)
        return c
    }

    private func uniformImage(_ value: UInt32) -> C? {
        if let c = uniform[value] { return c }
        guard let c = image(defaultTileData(value)) else { return nil }
        uniform[value] = c
        return c
    }

    private func mipImage(_ surface: TiledSurface, _ level: Int, _ mx: Int, _ my: Int) -> C? {
        let n = 1 << level
        var sources: [Tile?] = []
        for dy in 0..<n { for dx in 0..<n { sources.append(surface.tiles.get(tileKey(mx * n + dx, my * n + dy))) } }
        if sources.allSatisfy({ $0 == nil }) { return nil }
        let key = "\(level):\(mx):\(my)"
        if let hit = mips[key], hit.sources.count == sources.count, zip(hit.sources, sources).allSatisfy({ $0 === $1 }) { return hit.canvas }
        var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
        let side = TILE / n
        let blank = surface.defaultValue != 0 ? defaultTileData(UInt32(surface.defaultValue)) : nil
        for (i, t) in sources.enumerated() {
            if let src = t?.data ?? blank, src.count == TILE * TILE * 4 { downsampleInto(src, n, &out, (i % n) * side, (i / n) * side) }
        }
        guard let canvas = image(out) else { return nil }
        mips[key] = (sources, canvas)
        return canvas
    }

    private func defaultTileData(_ value: UInt32) -> [UInt8] {
        var data = [UInt8](repeating: 0, count: TILE * TILE * 4)
        var i = 0
        while i < data.count {
            data[i] = UInt8((value >> 24) & 255)
            data[i + 1] = UInt8((value >> 16) & 255)
            data[i + 2] = UInt8((value >> 8) & 255)
            data[i + 3] = UInt8(value & 255)
            i += 4
        }
        return data
    }

    /**
     * Draws the part of an RGBA `surface` (placed by `mapping`) that `view` shows onto `ctx`, tile
     * by tile: only visible tiles, at the mip level the zoom calls for, at whole screen pixels so
     * tiles meet without seams. Does not clear `ctx` first.
     */
    public func draw<D: ViewportDrawing>(_ ctx: inout D, _ surface: TiledSurface, _ mapping: SurfaceMapping, _ view: ViewTransform, _ options: DrawSurfaceOptions) -> DrawSurfaceStats where D.Image == C {
        precondition(surface.channels == 4, "drawSurfaceToViewport draws RGBA surfaces (4 channels).")
        let ppu = ppuOf(mapping)
        let zoom = view.zoom > 0 ? view.zoom : 1
        let screenPerPixel = zoom / ppu
        let level = surfaceMipLevel(screenPerPixel, options.maxMipLevel ?? 4)
        let span = TILE << level // surface pixels per drawn tile
        let visible = visibleSurfaceRect(mapping, view, options.width, options.height)
        let tx0 = Int(JS.floor(Double(visible.x) / Double(span)))
        let ty0 = Int(JS.floor(Double(visible.y) / Double(span)))
        let tx1 = Int(JS.floor(Double(visible.x + visible.width - 1) / Double(span)))
        let ty1 = Int(JS.floor(Double(visible.y + visible.height - 1) / Double(span)))
        ctx.setImageSmoothing(options.smoothing ?? (screenPerPixel < 2))
        let ox = (mapping.origin?.x ?? 0) * zoom + view.x
        let oy = (mapping.origin?.y ?? 0) * zoom + view.y
        var drawn = 0
        var built = 0
        // Visit the grid cells in view, or (zoomed far out over sparse paint) only the cells that hold tiles.
        var keys: [(Int, Int)] = []
        if surface.defaultValue == 0 && surface.tiles.count < (tx1 - tx0 + 1) * (ty1 - ty0 + 1) {
            var seen = Set<String>()
            for key in surface.tiles.keys {
                let c = tileCoord(key)
                let mx = Int(JS.floor(Double(c.tx) / Double(1 << level)))
                let my = Int(JS.floor(Double(c.ty) / Double(1 << level)))
                if mx < tx0 || mx > tx1 || my < ty0 || my > ty1 || seen.contains("\(mx),\(my)") { continue }
                seen.insert("\(mx),\(my)")
                keys.append((mx, my))
            }
        } else if ty1 >= ty0 && tx1 >= tx0 {
            for ty in ty0...ty1 { for tx in tx0...tx1 { keys.append((tx, ty)) } }
        }
        for (tx, ty) in keys {
            var canvas: C? = nil
            if level == 0 {
                if let tile = surface.tiles.get(tileKey(tx, ty)) {
                    let had = base.has(tile)
                    canvas = tileImage(tile)
                    if !had && canvas != nil { built += 1 }
                } else if surface.defaultValue != 0 {
                    canvas = uniformImage(UInt32(surface.defaultValue))
                }
            } else {
                let before = mips.count
                let prev = mips["\(level):\(tx):\(ty)"]?.canvas
                canvas = mipImage(surface, level, tx, ty)
                if let c = canvas, mips.count != before || c !== prev { built += 1 }
                if canvas == nil && surface.defaultValue != 0 { canvas = uniformImage(UInt32(surface.defaultValue)) }
            }
            guard let canvas else { continue }
            let sx0 = Int(JS.round(ox + (Double(tx * span) * zoom) / ppu))
            let sy0 = Int(JS.round(oy + (Double(ty * span) * zoom) / ppu))
            let sx1 = Int(JS.round(ox + (Double((tx + 1) * span) * zoom) / ppu))
            let sy1 = Int(JS.round(oy + (Double((ty + 1) * span) * zoom) / ppu))
            if sx1 <= sx0 || sy1 <= sy0 { continue }
            ctx.drawImage(canvas, sx0, sy0, sx1 - sx0, sy1 - sy0)
            drawn += 1
        }
        return DrawSurfaceStats(level: level, drawn: drawn, built: built)
    }
}

/**
 * Draws the visible part of an RGBA `surface` onto `ctx` with a `SurfaceViewportRenderer` (pass
 * the same renderer every frame to reuse its tile images). See `SurfaceViewportRenderer.draw`.
 */
public func drawSurfaceToViewport<D: ViewportDrawing>(_ ctx: inout D, _ surface: TiledSurface, _ mapping: SurfaceMapping, _ view: ViewTransform, _ options: DrawSurfaceOptions, renderer: SurfaceViewportRenderer<D.Image>) -> DrawSurfaceStats {
    renderer.draw(&ctx, surface, mapping, view, options)
}
