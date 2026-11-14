// Portions ported from photocraft/crates/algo/src/transform.rs and crates/algo/src/warp.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation

/**
 * Resampling tiled surfaces through geometric maps: Free Transform (scale, rotate, skew, distort,
 * perspective: one projective map) and Warp (any forward map, such as a Bézier mesh). The port of
 * `raster/transform.ts`.
 *
 * - Inverse mapping per destination tile: each destination tile reads only the source window its
 *   pixels map into, and the result is a new copy-on-write surface (an identity or a whole-pixel
 *   move returns the source, or shares its tiles).
 * - Nearest, bilinear and Photoshop's Bicubic (the Keys cubic at a = −0.75). Colour is sampled
 *   premultiplied by alpha, so partially transparent edges don't pick up the colour of the
 *   transparent pixels around them; outside the source everything is transparent.
 * - Large reductions with Bicubic are pre-filtered: the source is box-averaged by whole factors
 *   first and the cubic widened by the rest, so shrinking a layer doesn't alias.
 * - Masks (one channel) are warped as "value + inside": outside the source and outside the warped
 *   area they read as the surface's default value.
 * - A Distort dragged past the horizon draws only the side of the horizon most of the source maps
 *   to (no mirrored copy wrapped round infinity).
 */

/// Resampling of a transform (Photoshop's interpolation menu).
public enum Interpolation: String, Sendable, CaseIterable {
    case nearest, bilinear, bicubic
}

public let INTERPOLATIONS: [Interpolation] = [.nearest, .bilinear, .bicubic]

public func isInterpolation(_ value: String?) -> Bool { value.flatMap { Interpolation(rawValue: $0) } != nil }

/**
 * The largest result (pixels) one resample may build: about 11 600 × 11 600. Only the size of the
 * result counts, not where it lands. A scale past it is refused rather than clipped.
 */
public let MAX_TRANSFORM_PIXELS = 1 << 27

/// A transform whose result would be too large; the message gives the size and the limit.
public struct TransformTooLargeError: Error, CustomStringConvertible, Equatable {
    public let message: String
    public var description: String { message }
}

public struct ResampleOptions {
    /// Default `bicubic`.
    public var interpolation: Interpolation?
    /// The source region to transform (default: the surface's content bounds). Pixels outside it are not moved.
    public var source: RasterRect?
    /// Keep only destination pixels inside this rectangle (a preview of the visible area).
    public var clip: RasterRect?
    /**
     * Preview speed-up: sample once per `step × step` block of destination pixels and fill the
     * block (a power of two, 1..64; default 1, every pixel).
     */
    public var step: Double?
    public init(interpolation: Interpolation? = nil, source: RasterRect? = nil, clip: RasterRect? = nil, step: Double? = nil) {
        self.interpolation = interpolation
        self.source = source
        self.clip = clip
        self.step = step
    }
}

// MARK: - Kernels

private let KEYS_A = -0.75

/**
 * Photoshop's Bicubic: the Keys cubic at a = −0.75 (Catmull-Rom is −0.5). Measured on Photoshop
 * 27.11's Free Transform by photocraft: a 200 % step edge matches within 0.5 levels.
 */
public func keysWeight(_ xIn: Double) -> Double {
    let x = Swift.abs(xIn)
    if x < 1 { return ((KEYS_A + 2) * x - (KEYS_A + 3)) * x * x + 1 }
    if x < 2 { return KEYS_A * (((x - 5) * x + 8) * x - 4) }
    return 0
}

/// Snaps a sample position within float noise of the pixel grid onto it, so an identity is exact.
private func snap(_ t: Double) -> Double { Swift.abs(t - JS.round(t)) < 1e-7 ? JS.round(t) : t }

/// Most taps of a widened cubic along one axis (the residual widening is below 4 after pre-reduction).
private let MAX_TAPS = 20

/// Taps of the cubic at `u` (pixel-index units), widened by `s` ≥ 1: fills `w` with normalised
/// weights and returns the first tap index and the tap count.
private func cubicTaps(_ u: Double, _ s: Double, _ w: inout [Double]) -> (i0: Int, n: Int) {
    if s <= 1.0001 {
        let f = JS.floor(u)
        let t = u - f
        w[0] = keysWeight(1 + t)
        w[1] = keysWeight(t)
        w[2] = keysWeight(1 - t)
        w[3] = keysWeight(2 - t)
        return (Int(f) - 1, 4)
    }
    let r = 2 * s
    let i0 = Int(JS.ceil(u - r))
    let n = Swift.min(MAX_TAPS, Int(JS.floor(u + r)) - i0 + 1)
    var sum = 0.0
    for k in 0..<Swift.max(0, n) {
        let v = keysWeight((Double(i0 + k) - u) / s)
        w[k] = v
        sum += v
    }
    if sum != 0 { for k in 0..<Swift.max(0, n) { w[k] /= sum } }
    return (i0, n)
}

// MARK: - Source windows

/**
 * A float copy of part of a source: premultiplied RGBA (colour 0..255 × alpha, alpha 0..1) for
 * layers, `[value, inside]` for one-channel masks (inside is 1 within the source region). Zero
 * outside the source region.
 */
private struct Window {
    var x: Int
    var y: Int
    var w: Int
    var h: Int
    /// Values per pixel: 4 (RGBA) or 2 (mask value, inside).
    var n: Int
    var data: [Float]
}

private func intersect(_ a: RasterRect, _ b: RasterRect) -> RasterRect? {
    let x = Swift.max(a.x, b.x)
    let y = Swift.max(a.y, b.y)
    let x1 = Swift.min(a.x + a.width, b.x + b.width)
    let y1 = Swift.min(a.y + a.height, b.y + b.height)
    return x1 > x && y1 > y ? RasterRect(x: x, y: y, width: x1 - x, height: y1 - y) : nil
}

private func hasTilesIn(_ src: TiledSurface, _ r: RasterRect) -> Bool {
    for (tx, ty) in tilesInRect(r) where src.getTile(tx, ty) != nil { return true }
    return false
}

private func readWindow(_ src: TiledSurface, _ srcRect: RasterRect, _ rect: RasterRect, _ depth: Int?) -> Window {
    let n = src.channels == 4 ? 4 : 2
    var win = Window(x: rect.x, y: rect.y, w: rect.width, h: rect.height, n: n, data: [Float](repeating: 0, count: rect.width * rect.height * n))
    guard let r = intersect(rect, srcRect) else { return win }
    let px: [Double]
    if let depth { px = readScaled(src, r, depth).map { Double($0) } } else { px = readRegion(src, r).map { Double($0) } }
    for y in 0..<r.height {
        var s = y * r.width * src.channels
        var d = ((r.y - rect.y + y) * rect.width + (r.x - rect.x)) * n
        if n == 4 {
            for _ in 0..<r.width {
                let a = px[s + 3] / 255
                win.data[d] = Float(px[s] * a)
                win.data[d + 1] = Float(px[s + 1] * a)
                win.data[d + 2] = Float(px[s + 2] * a)
                win.data[d + 3] = Float(a)
                s += 4
                d += 4
            }
        } else {
            for _ in 0..<r.width {
                win.data[d] = Float(px[s])
                win.data[d + 1] = 1
                s += 1
                d += 2
            }
        }
    }
    return win
}

/**
 * One sample of the window at pixel-index position (`u`, `v`) (pixel centres at integers) into
 * `acc` (premultiplied). `su`, `sv`: widening of the cubic along each source axis (≥ 1).
 */
private func sample(_ win: Window, _ interp: Interpolation, _ uIn: Double, _ vIn: Double, _ su: Double, _ sv: Double, _ acc: inout [Double], _ wx: inout [Double], _ wy: inout [Double]) {
    let n = win.n
    let d = win.data
    for c in 0..<n { acc[c] = 0 }
    if interp == .nearest {
        let ix = Int(JS.floor(uIn + 0.5)) - win.x
        let iy = Int(JS.floor(vIn + 0.5)) - win.y
        if ix < 0 || iy < 0 || ix >= win.w || iy >= win.h { return }
        let o = (iy * win.w + ix) * n
        for c in 0..<n { acc[c] = Double(d[o + c]) }
        return
    }
    if interp == .bilinear {
        let fx = JS.floor(uIn)
        let fy = JS.floor(vIn)
        let tx = uIn - fx
        let ty = vIn - fy
        for j in 0..<2 {
            let iy = Int(fy) + j - win.y
            if iy < 0 || iy >= win.h { continue }
            let kyw = j != 0 ? ty : 1 - ty
            if kyw == 0 { continue }
            for i in 0..<2 {
                let ix = Int(fx) + i - win.x
                if ix < 0 || ix >= win.w { continue }
                let k = (i != 0 ? tx : 1 - tx) * kyw
                if k == 0 { continue }
                let o = (iy * win.w + ix) * n
                for c in 0..<n { acc[c] += Double(d[o + c]) * k }
            }
        }
        return
    }
    let u = snap(uIn)
    let v = snap(vIn)
    let tu = cubicTaps(u, su, &wx)
    let x0 = tu.i0 - win.x
    let nu = tu.n
    let tv = cubicTaps(v, sv, &wy)
    let y0 = tv.i0 - win.y
    let nv = tv.n
    let W = win.w
    if n == 4 && nu == 4 && nv == 4 && x0 >= 0 && y0 >= 0 && x0 + 4 <= W && y0 + 4 <= win.h {
        // The common case: a plain 4 × 4 cubic fully inside the window.
        var r = 0.0, g = 0.0, b = 0.0, a = 0.0
        let w0 = wx[0], w1 = wx[1], w2 = wx[2], w3 = wx[3]
        for j in 0..<4 {
            let kyw = wy[j]
            if kyw == 0 { continue }
            let o = ((y0 + j) * W + x0) * 4
            let r0 = Double(d[o]) * w0 + Double(d[o + 4]) * w1 + Double(d[o + 8]) * w2 + Double(d[o + 12]) * w3
            let g0 = Double(d[o + 1]) * w0 + Double(d[o + 5]) * w1 + Double(d[o + 9]) * w2 + Double(d[o + 13]) * w3
            let b0 = Double(d[o + 2]) * w0 + Double(d[o + 6]) * w1 + Double(d[o + 10]) * w2 + Double(d[o + 14]) * w3
            let a0 = Double(d[o + 3]) * w0 + Double(d[o + 7]) * w1 + Double(d[o + 11]) * w2 + Double(d[o + 15]) * w3
            r += r0 * kyw
            g += g0 * kyw
            b += b0 * kyw
            a += a0 * kyw
        }
        acc[0] = r
        acc[1] = g
        acc[2] = b
        acc[3] = a
        return
    }
    for j in 0..<Swift.max(0, nv) {
        let kyw = wy[j]
        if kyw == 0 { continue }
        let iy = y0 + j
        if iy < 0 || iy >= win.h { continue }
        let row = iy * W
        for i in 0..<Swift.max(0, nu) {
            let k = wx[i] * kyw
            if k == 0 { continue }
            let ix = x0 + i
            if ix < 0 || ix >= W { continue }
            let o = (row + ix) * n
            if n == 4 {
                acc[0] += Double(d[o]) * k
                acc[1] += Double(d[o + 1]) * k
                acc[2] += Double(d[o + 2]) * k
                acc[3] += Double(d[o + 3]) * k
            } else {
                acc[0] += Double(d[o]) * k
                acc[1] += Double(d[o + 1]) * k
            }
        }
    }
}

/**
 * Writes one premultiplied sample into a tile buffer at byte offset `o`: straight RGBA for layers,
 * the value flattened onto the default for masks. False when it adds nothing.
 */
private func store(_ out: inout [UInt8], _ o: Int, _ acc: [Double], _ ch: Int, _ def: Int) -> Bool {
    if ch == 4 {
        let al = acc[3] > 1 ? 1 : acc[3]
        if !(al > 1e-6) { return false }
        out[o] = JS.u8c(acc[0] / al)
        out[o + 1] = JS.u8c(acc[1] / al)
        out[o + 2] = JS.u8c(acc[2] / al)
        out[o + 3] = JS.u8c(al * 255)
        return true
    }
    let inside = acc[1] > 1 ? 1 : acc[1]
    if !(inside > 1e-6) { return false }
    out[o] = JS.u8c(acc[0] + Double(def) * (1 - inside))
    return true
}

// MARK: - High bit depth

/**
 * The depth a layer surface is resampled at: 16 or 32 when it holds deep tiles (RGBA, transparent
 * default, full-resolution output), else `nil` (the 8-bit path). The kernels run unchanged on
 * samples scaled to 0..255 floats, so a 16-bit layer keeps its precision and a 32-bit one is
 * resampled in linear light with colour above 1 kept.
 */
private func resampleDepth(_ src: TiledSurface, _ step: Int) -> Int? {
    if src.channels != 4 || src.defaultValue != 0 || step != 1 { return nil }
    let d = surfaceDepth(src)
    return d == 8 ? nil : d
}

/// `rect` of a deep surface as 0..255-scaled floats (RGBA, straight alpha).
private func readScaled(_ src: TiledSurface, _ rect: RasterRect, _ depth: Int) -> [Float] {
    let d = readDeepRegion(src, rect, depth)
    let k = depth == 16 ? 1.0 / 257 : 255
    return (0..<d.count).map { Float(d[$0] * k) }
}

/// 0..255-scaled floats back to deep samples (16-bit rounds and clamps; 32-bit keeps colour above 1).
private func fromScaled(_ v: [Float], _ depth: Int) -> DeepSamples {
    if depth == 16 {
        return .u16(v.map { f in
            let x = JS.round(Double(f) * 257)
            return x <= 0 ? 0 : x >= 65535 ? 65535 : UInt16(x)
        })
    }
    return .f32(v.enumerated().map { i, f in
        let x = Double(f) / 255
        return Float((i & 3) == 3 ? (x <= 0 ? 0 : x >= 1 ? 1 : x) : x)
    })
}

/// `store` into 0..255-scaled floats, without the 8-bit clamp.
private func storeScaled(_ out: inout [Float], _ o: Int, _ acc: [Double]) -> Bool {
    let al = acc[3] > 1 ? 1 : acc[3]
    if !(al > 1e-6) { return false }
    out[o] = Float(acc[0] / al)
    out[o + 1] = Float(acc[1] / al)
    out[o + 2] = Float(acc[2] / al)
    out[o + 3] = Float(al * 255)
    return true
}

// MARK: - Pre-reduction (Bicubic shrinking)

/**
 * The source box-averaged by `kx × ky` blocks aligned to multiples of the factors (premultiplied
 * for RGBA), so reduced pixel (i, j) covers source pixels [i·kx, (i+1)·kx) × [j·ky, (j+1)·ky).
 * Returns the reduced surface and the reduced source rectangle. Works in strips of about one tile
 * row, so memory stays bounded.
 */
private func boxReduce(_ src: TiledSurface, _ srcRect: RasterRect, _ kx: Int, _ ky: Int, _ depth: Int?) -> (surface: TiledSurface, rect: RasterRect) {
    let ch = src.channels
    let rx0 = Int(JS.floor(Double(srcRect.x) / Double(kx)))
    let ry0 = Int(JS.floor(Double(srcRect.y) / Double(ky)))
    let rx1 = Int(JS.ceil(Double(srcRect.x + srcRect.width) / Double(kx)))
    let ry1 = Int(JS.ceil(Double(srcRect.y + srcRect.height) / Double(ky)))
    let rw = rx1 - rx0
    let rect = RasterRect(x: rx0, y: ry0, width: rw, height: ry1 - ry0)
    var out = emptySurface(ch, src.defaultValue)
    let rowsPer = Swift.max(1, TILE / ky)
    let area = Double(kx * ky)
    var ry = ry0
    while ry < ry1 {
        defer { ry += rowsPer }
        let rows = Swift.min(rowsPer, ry1 - ry)
        let strip = RasterRect(x: rx0 * kx, y: ry * ky, width: rw * kx, height: rows * ky)
        let px: [Double] = depth.map { readScaled(src, strip, $0).map { Double($0) } } ?? readRegion(src, strip).map { Double($0) }
        var red = [Double](repeating: 0, count: rw * rows * ch)
        for j in 0..<rows {
            for i in 0..<rw {
                if ch == 4 {
                    var a = 0.0, r = 0.0, g = 0.0, b = 0.0
                    for y in 0..<ky {
                        var s = ((j * ky + y) * strip.width + i * kx) * 4
                        for _ in 0..<kx {
                            let al = px[s + 3]
                            a += al
                            r += px[s] * al
                            g += px[s + 1] * al
                            b += px[s + 2] * al
                            s += 4
                        }
                    }
                    let o = (j * rw + i) * 4
                    if a > 0 {
                        red[o] = r / a
                        red[o + 1] = g / a
                        red[o + 2] = b / a
                        red[o + 3] = a / area
                    }
                } else {
                    var v = 0.0
                    for y in 0..<ky {
                        let s = (j * ky + y) * strip.width + i * kx
                        for x in 0..<kx { v += px[s + x] }
                    }
                    red[j * rw + i] = v / area
                }
            }
        }
        let region = RasterRect(x: rx0, y: ry, width: rw, height: rows)
        if let depth {
            out = writeDeepRegion(out, region, fromScaled(red.map { Float($0) }, depth))
        } else {
            out = writeRegion(out, region, red.map { JS.u8c($0) })
        }
    }
    return (out, rect)
}

/**
 * The surface box-averaged by `factor` (a whole number ≥ 1) in both directions: reduced pixel
 * (i, j) covers pixels [i·factor, (i+1)·factor) of each axis. For previews.
 */
public func reduceSurface(_ src: TiledSurface, _ factor: Double) -> TiledSurface {
    let k = Swift.max(1, Int(JS.floor(factor)))
    guard k != 1, let b = contentBounds(src) else { return src }
    return boxReduce(src, b, k, k, nil).surface
}

/// Source pixels per destination pixel along each source axis at destination point (X, Y), for `inv` (destination → source).
private func inverseStretch(_ inv: Homography, _ X: Double, _ Y: Double) -> (Double, Double) {
    let w = inv[6] * X + inv[7] * Y + inv[8]
    if !(Swift.abs(w) > 1e-12) { return (1, 1) }
    let U = (inv[0] * X + inv[1] * Y + inv[2]) / w
    let V = (inv[3] * X + inv[4] * Y + inv[5]) / w
    let ux = (inv[0] - U * inv[6]) / w
    let uy = (inv[1] - U * inv[7]) / w
    let vx = (inv[3] - V * inv[6]) / w
    let vy = (inv[4] - V * inv[7]) / w
    return (JS.hypot(ux, uy), JS.hypot(vx, vy))
}

/// Whole reduction factor for a stretch: the largest power of two ≤ `s` (1..64).
private func reduction(_ s: Double) -> Int {
    s >= 2 && s.isFinite ? Int(JS.min(64, JS.pow(2, JS.floor(JS.log2(s))))) : 1
}

// MARK: - Projective transforms

private func normalizeStep(_ step: Double?) -> Int {
    guard let step, step != 0, step > 1 else { return 1 }
    return Int(JS.min(64, JS.pow(2, JS.floor(JS.log2(step)))))
}

private func checkBudget(_ dst: RasterRect, _ what: String = "result") throws {
    if dst.width * dst.height > MAX_TRANSFORM_PIXELS {
        throw TransformTooLargeError(message: "The transformed \(what) would be \(dst.width) × \(dst.height) px, more than the \(MAX_TRANSFORM_PIXELS) px limit; use a smaller scale.")
    }
}

/// The new surface from `tiles` written over an empty one (default value kept).
private func assemble(_ src: TiledSurface, _ tiles: OrderedMap<TileKey, Tile>) -> TiledSurface {
    TiledSurface(channels: src.channels, tiles: tiles, defaultValue: src.defaultValue)
}

/// The destination rectangle `transformSurface` fills for `source` under `h`, or `nil` when it is empty or unbounded.
public func transformedBounds(_ source: RasterRect, _ h: Homography) -> RasterRect? {
    if !(source.width > 0 && source.height > 0) || invertHomography(h) == nil { return nil }
    let pts = boxQuad(Box(source)).compactMap { applyHomography(h, $0) }
    if pts.count != 4 { return nil }
    return cornerBounds(pts)
}

/**
 * The surface's content inside `options.source` (default: all of it) warped by `h` (source →
 * destination, both in the surface's pixel space). Pixels outside the warped area are the default
 * (transparent for layers). Throws `TransformTooLargeError` past `MAX_TRANSFORM_PIXELS`.
 */
public func transformSurface(_ src: TiledSurface, _ h: Homography, _ options: ResampleOptions = ResampleOptions()) throws -> TiledSurface {
    let interp = options.interpolation ?? .bicubic
    let ch = src.channels
    let def = src.defaultValue
    let empty = emptySurface(ch, def)
    let given = options.source
    let step = normalizeStep(options.step)
    let depth = resampleDepth(src, step)
    if isIdentityHomography(h, 1e-12) && given == nil && options.clip == nil { return src }
    // A whole-pixel move is exact and shares tiles when it is a multiple of the tile size.
    let dx = h[2] / h[8]
    let dy = h[5] / h[8]
    if given == nil && options.clip == nil && isIdentityHomography([h[0], h[1], 0, h[3], h[4], 0, h[6], h[7], h[8]], 1e-12) && Swift.abs(dx - JS.round(dx)) < 1e-9 && Swift.abs(dy - JS.round(dy)) < 1e-9 {
        let mx = Int(JS.round(dx))
        let my = Int(JS.round(dy))
        if let depth, let b = src.bounds, mx % TILE != 0 || my % TILE != 0 {
            return writeDeepRegion(emptySurface(ch, def), RasterRect(x: b.x + mx, y: b.y + my, width: b.width, height: b.height), readDeepRegion(src, b, depth))
        }
        return translateSurface(src, Double(mx), Double(my))
    }
    guard var srcRect = given.map({ intersect($0, $0) }) ?? contentBounds(src) else { return empty }
    var H = h
    var S = src
    // Pre-reduce for large downscales (bicubic alone aliases below ~50 %): box-average by whole
    // factors so the cubic, widened by the rest, samples at most about 2:1.
    if interp == .bicubic {
        if let inv0 = invertHomography(H), let c = applyHomography(H, Vec2(x: Double(srcRect.x) + Double(srcRect.width) / 2, y: Double(srcRect.y) + Double(srcRect.height) / 2)) {
            let (su, sv) = inverseStretch(inv0, c.x, c.y)
            let kx = reduction(su)
            let ky = reduction(sv)
            if kx > 1 || ky > 1 {
                let red = boxReduce(src, srcRect, kx, ky, depth)
                S = red.surface
                srcRect = red.rect
                H = multiplyHomographies([Double(kx), 0, 0, 0, Double(ky), 0, 0, 0, 1], H)
            }
        }
    }
    guard let inv = invertHomography(H) else { return empty }
    let sr = srcRect
    let srx = Double(sr.x), sry = Double(sr.y), srw = Double(sr.width), srh = Double(sr.height)
    // While the forward w keeps one sign over the source (plus the margin the sampler reads), every
    // sampled pixel lies at least `wLo` from the inverse horizon, so clipping a tile there keeps its
    // footprint exact and bounded even when a steep Distort brings that horizon into the tile.
    let fwd = [Vec2(x: srx - 1, y: sry - 1), Vec2(x: srx + srw + 1, y: sry - 1), Vec2(x: srx + srw + 1, y: sry + srh + 1), Vec2(x: srx - 1, y: sry + srh + 1)].map { homographyW(H, $0) }
    let side = fwd.allSatisfy { $0 > 0 } ? 1 : fwd.allSatisfy { $0 < 0 } ? -1 : 0
    let wLo = 1 / fwd.reduce(0) { JS.max($0, Swift.abs($1)) }
    // A source straddling the horizon draws only its front side.
    let front = side == 0 ? homographyFrontSide(H, Box(sr)) : 0
    let corners = boxQuad(Box(sr)).compactMap { applyHomography(H, $0) }
    let bounds = corners.count == 4 ? cornerBounds(corners) : nil
    let dstOpt: RasterRect?
    if let clip = options.clip, let bounds, side != 0 { dstOpt = intersect(bounds, clip) } else { dstOpt = options.clip ?? bounds }
    guard let dst = dstOpt else { return empty }
    if options.clip == nil { try checkBudget(dst) }
    let affine = Swift.abs(inv[6]) < 1e-15 && Swift.abs(inv[7]) < 1e-15
    let (su0, sv0) = inverseStretch(inv, Double(dst.x) + Double(dst.width) / 2, Double(dst.y) + Double(dst.height) / 2)
    let widen = { (s: Double) in interp == .bicubic ? JS.min(4, JS.max(1, s)) : 1 }
    let maxWiden = interp == .bicubic ? 4.0 : 1
    let pad = 3 + Int(JS.ceil(2 * maxWiden))
    let margin = interp == .bicubic ? JS.max(1, JS.max(widen(su0), widen(sv0))) : 1
    var tiles = OrderedMap<TileKey, Tile>()
    var acc = [0.0, 0.0, 0.0, 0.0]
    var wx = [Double](repeating: 0, count: MAX_TAPS)
    var wy = [Double](repeating: 0, count: MAX_TAPS)
    let sx0 = srx, sy0 = sry, sx1 = srx + srw - 1, sy1 = sry + srh - 1
    for (tx, ty) in tilesInRect(dst) {
        guard let t = intersect(RasterRect(x: tx * TILE, y: ty * TILE, width: TILE, height: TILE), dst) else { continue }
        // Source footprint of this tile (inverse-mapped corners of its sampled part), padded for the filter.
        let tc = [Vec2(x: Double(t.x), y: Double(t.y)), Vec2(x: Double(t.x + t.width), y: Double(t.y)), Vec2(x: Double(t.x + t.width), y: Double(t.y + t.height)), Vec2(x: Double(t.x), y: Double(t.y + t.height))]
        let wc = tc.map { homographyW(inv, $0) }
        var poly = tc
        if side != 0 {
            // Sutherland-Hodgman against side · w ≥ wLo.
            let dd = wc.map { Double(side) * $0 - wLo }
            poly = []
            for i in 0..<4 {
                let p = tc[i]
                let q = tc[(i + 1) % 4]
                let dp = dd[i]
                let dq = dd[(i + 1) % 4]
                if dp >= 0 { poly.append(p) }
                if (dp >= 0) != (dq >= 0) {
                    let k = dp / (dp - dq)
                    poly.append(Vec2(x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k))
                }
            }
        }
        if poly.isEmpty { continue }
        let straddles = side == 0 && wc.contains { $0 <= 0 } && wc.contains { $0 >= 0 }
        var foot: RasterRect?
        if straddles {
            foot = sr
        } else {
            let fp = poly.compactMap { applyHomography(inv, $0) }
            if fp.count != poly.count {
                foot = sr
            } else {
                let xs = fp.map(\.x)
                let ys = fp.map(\.y)
                let fx0 = Int(JS.floor(xs.reduce(Double.infinity) { JS.min($0, $1) })) - pad
                let fy0 = Int(JS.floor(ys.reduce(Double.infinity) { JS.min($0, $1) })) - pad
                let fx1 = Int(JS.ceil(xs.reduce(-Double.infinity) { JS.max($0, $1) })) + pad
                let fy1 = Int(JS.ceil(ys.reduce(-Double.infinity) { JS.max($0, $1) })) + pad
                foot = intersect(RasterRect(x: fx0, y: fy0, width: fx1 - fx0, height: fy1 - fy0), RasterRect(x: sr.x - pad, y: sr.y - pad, width: sr.width + 2 * pad, height: sr.height + 2 * pad))
            }
        }
        guard let foot else { continue }
        guard let readable = intersect(foot, sr), hasTilesIn(S, readable) else { continue }
        let win = readWindow(S, sr, foot, depth)
        var out = [UInt8](repeating: UInt8(truncatingIfNeeded: def), count: TILE * TILE * ch)
        var deepOut: [Float]? = depth != nil ? [Float](repeating: 0, count: TILE * TILE * 4) : nil
        var any = false
        let ox = tx * TILE
        let oy = ty * TILE
        var su = widen(su0)
        var sv = widen(sv0)
        let ystart = t.y - (((t.y - oy) % step) + step) % step
        let xstart = t.x - (((t.x - ox) % step) + step) % step
        let blocks = Int(JS.ceil(Double(t.x + t.width - xstart) / Double(step)))
        // One block row of samples, then copied down the rows of the block.
        var rowVals = [[UInt8]](repeating: [0, 0, 0, 0], count: blocks)
        var rowSet = [Bool](repeating: false, count: blocks)
        var scratch: [UInt8] = [0, 0, 0, 0]
        var y = ystart
        while y < t.y + t.height {
            defer { y += step }
            let Y = Double(y) + Double(step) / 2
            var anyInRow = false
            var x = xstart
            for bi in 0..<blocks {
                defer { x += step }
                rowSet[bi] = false
                let X = Double(x) + Double(step) / 2
                let w = inv[6] * X + inv[7] * Y + inv[8]
                if front != 0 && Double(front) * w <= 0 { continue }
                let u = (inv[0] * X + inv[1] * Y + inv[2]) / w - 0.5
                let v = (inv[3] * X + inv[4] * Y + inv[5]) / w - 0.5
                if !(u >= sx0 - margin && v >= sy0 - margin && u <= sx1 + margin && v <= sy1 + margin) { continue }
                if !affine && interp == .bicubic {
                    let s = inverseStretch(inv, X, Y)
                    su = widen(s.0)
                    sv = widen(s.1)
                }
                sample(win, interp, u, v, su, sv, &acc, &wx, &wy)
                if deepOut != nil {
                    // Full resolution (step 1): one pixel per block, written straight into the deep tile.
                    if storeScaled(&deepOut!, ((y - oy) * TILE + (x - ox)) * 4, acc) { any = true }
                    continue
                }
                if !store(&scratch, 0, acc, ch, def) { continue }
                rowSet[bi] = true
                rowVals[bi] = scratch
                anyInRow = true
            }
            if !anyInRow { continue }
            any = true
            let y0 = Swift.max(y, t.y)
            let y1 = Swift.min(y + step, t.y + t.height)
            for yy in y0..<y1 {
                let row = (yy - oy) * TILE - ox
                var x = xstart
                for bi in 0..<blocks {
                    defer { x += step }
                    if !rowSet[bi] { continue }
                    let x0 = Swift.max(x, t.x)
                    let x1 = Swift.min(x + step, t.x + t.width)
                    let val = rowVals[bi]
                    for xx in x0..<x1 { for c in 0..<ch { out[(row + xx) * ch + c] = val[c] } }
                }
            }
        }
        if !any { continue }
        let tile = deepOut.map { deepTile(fromScaled($0, depth!), 4, def) } ?? finishTile(out, ch, def)
        if let tile { tiles.set(tileKey(tx, ty), tile) }
    }
    return assemble(src, tiles)
}

// MARK: - Mesh warps (any forward map)

/// Grid cell size (source px) used to approximate the map.
private let CELL = 4
/// Most cells along one axis (bounds memory and time on huge layers).
private let MAX_CELLS = 512
/// Most subsamples per axis when a warp shrinks the source.
private let MAX_SS = 8.0

/**
 * The surface's content inside `options.source` (default: all of it) warped through the forward
 * map `f` (source → destination pixel space; `nil` where it is undefined).
 *
 * The source rectangle is subdivided into a fine grid whose vertices are mapped forward; each
 * cell's two triangles are rasterized in destination space with the source position interpolated
 * barycentrically, then the source is sampled there. Where the warp shrinks the source, each pixel
 * instead averages a grid of bilinear subsamples over its source footprint, so thin lines don't
 * alias. Where the warp folds over itself the later (lower-right) cell wins.
 */
public func warpSurface(_ src: TiledSurface, _ f: (Vec2) -> Vec2?, _ options: ResampleOptions = ResampleOptions()) throws -> TiledSurface {
    let interp = options.interpolation ?? .bicubic
    let ch = src.channels
    let def = src.defaultValue
    let empty = emptySurface(ch, def)
    guard let sr = options.source.map({ intersect($0, $0) }) ?? contentBounds(src) else { return empty }
    let step = normalizeStep(options.step)
    let depth = resampleDepth(src, step)
    let nx = Swift.min(MAX_CELLS, Swift.max(1, Int(JS.ceil(Double(sr.width) / Double(CELL)))))
    let ny = Swift.min(MAX_CELLS, Swift.max(1, Int(JS.ceil(Double(sr.height) / Double(CELL)))))
    let w1 = nx + 1
    // Forward-mapped vertices: destination x, y and source x, y.
    let nv = w1 * (ny + 1)
    var dvx = [Double](repeating: 0, count: nv)
    var dvy = [Double](repeating: 0, count: nv)
    var svx = [Double](repeating: 0, count: nv)
    var svy = [Double](repeating: 0, count: nv)
    var x0 = Double.infinity, y0 = Double.infinity, x1 = -Double.infinity, y1 = -Double.infinity
    for j in 0...ny {
        for i in 0...nx {
            let k = j * w1 + i
            let sx = Double(sr.x) + (Double(sr.width) * Double(i)) / Double(nx)
            let sy = Double(sr.y) + (Double(sr.height) * Double(j)) / Double(ny)
            guard let d = f(Vec2(x: sx, y: sy)), d.x.isFinite, d.y.isFinite else { return empty }
            dvx[k] = d.x
            dvy[k] = d.y
            svx[k] = sx
            svy[k] = sy
            if d.x < x0 { x0 = d.x }
            if d.y < y0 { y0 = d.y }
            if d.x > x1 { x1 = d.x }
            if d.y > y1 { y1 = d.y }
        }
    }
    let lim = Double(1 << 20)
    let bx0 = Int(JS.floor(JS.max(-lim, x0))) - 1
    let by0 = Int(JS.floor(JS.max(-lim, y0))) - 1
    let full = RasterRect(x: bx0, y: by0, width: Int(JS.ceil(JS.min(lim, x1))) + 1 - bx0, height: Int(JS.ceil(JS.min(lim, y1))) + 1 - by0)
    guard let dst = options.clip.map({ intersect(full, $0) }) ?? full else { return empty }
    if options.clip == nil { try checkBudget(dst) }
    // Triangles (vertex indices, in draw order), binned per destination tile.
    let triCount = nx * ny * 2
    var tris = [Int](repeating: 0, count: triCount * 3)
    var t3 = 0
    for j in 0..<ny {
        for i in 0..<nx {
            let a = j * w1 + i
            tris[t3] = a; tris[t3 + 1] = a + 1; tris[t3 + 2] = a + w1 + 1
            tris[t3 + 3] = a; tris[t3 + 4] = a + w1 + 1; tris[t3 + 5] = a + w1
            t3 += 6
        }
    }
    let tx0 = tileOf(dst.x)
    let ty0 = tileOf(dst.y)
    let cols = tileOf(dst.x + dst.width - 1) - tx0 + 1
    let rows = tileOf(dst.y + dst.height - 1) - ty0 + 1
    var bins = [[Int]](repeating: [], count: cols * rows)
    for k in 0..<triCount {
        let a = tris[3 * k], b = tris[3 * k + 1], c = tris[3 * k + 2]
        let tminx = JS.floor(JS.min(dvx[a], JS.min(dvx[b], dvx[c])))
        let tminy = JS.floor(JS.min(dvy[a], JS.min(dvy[b], dvy[c])))
        let tmaxx = JS.ceil(JS.max(dvx[a], JS.max(dvx[b], dvx[c])))
        let tmaxy = JS.ceil(JS.max(dvy[a], JS.max(dvy[b], dvy[c])))
        let cx0 = Swift.max(0, Int(JS.floor(JS.max(tminx, Double(dst.x)) / Double(TILE))) - tx0)
        let cy0 = Swift.max(0, Int(JS.floor(JS.max(tminy, Double(dst.y)) / Double(TILE))) - ty0)
        let cx1 = Swift.min(cols - 1, Int(JS.floor(JS.min(tmaxx, Double(dst.x + dst.width - 1)) / Double(TILE))) - tx0)
        let cy1 = Swift.min(rows - 1, Int(JS.floor(JS.min(tmaxy, Double(dst.y + dst.height - 1)) / Double(TILE))) - ty0)
        if cy1 < cy0 || cx1 < cx0 { continue }
        for cy in cy0...cy1 { for cx in cx0...cx1 { bins[cy * cols + cx].append(k) } }
    }
    var tiles = OrderedMap<TileKey, Tile>()
    var acc = [0.0, 0.0, 0.0, 0.0]
    var one = [0.0, 0.0, 0.0, 0.0]
    var wx = [Double](repeating: 0, count: MAX_TAPS)
    var wy = [Double](repeating: 0, count: MAX_TAPS)
    let n = ch == 4 ? 4 : 2
    let count = { (jx: Double, jy: Double) -> Int in interp == .nearest ? 1 : Int(JS.min(MAX_SS, JS.max(1, JS.round(JS.hypot(jx, jy))))) }
    for cy in 0..<rows {
        for cx in 0..<cols {
            let list = bins[cy * cols + cx]
            if list.isEmpty { continue }
            let ttx = tx0 + cx
            let tty = ty0 + cy
            // A tile past the surface range is dropped (as `tilesInRect` does), never keyed onto another.
            if !tileInRange(ttx, tty) { continue }
            guard let t = intersect(RasterRect(x: ttx * TILE, y: tty * TILE, width: TILE, height: TILE), dst) else { continue }
            let tw = t.width
            let th = t.height
            // Source position per destination pixel (NaN = not covered) and the triangle it came from.
            var us = [Double](repeating: .nan, count: tw * th)
            var vs = [Double](repeating: 0, count: tw * th)
            var owner = [Int](repeating: 0, count: tw * th)
            // Per triangle: the inverse map's Jacobian (source step per destination pixel along x and y) and subsample counts.
            var jac = [Double](repeating: 0, count: list.count * 4)
            var ssx = [Int](repeating: 0, count: list.count)
            var ssy = [Int](repeating: 0, count: list.count)
            for (li, k) in list.enumerated() {
                let a = tris[3 * k], b = tris[3 * k + 1], c = tris[3 * k + 2]
                let p0x = dvx[a], p0y = dvy[a], p1x = dvx[b], p1y = dvy[b], p2x = dvx[c], p2y = dvy[c]
                let det = (p1x - p0x) * (p2y - p0y) - (p2x - p0x) * (p1y - p0y)
                ssx[li] = 1
                ssy[li] = 1
                if Swift.abs(det) < 1e-12 { continue }
                let d1x = svx[b] - svx[a]
                let d1y = svy[b] - svy[a]
                let d2x = svx[c] - svx[a]
                let d2y = svy[c] - svy[a]
                let l1x = (p2y - p0y) / det
                let l1y = (p0x - p2x) / det
                let l2x = (p0y - p1y) / det
                let l2y = (p1x - p0x) / det
                // Capped, so a sliver triangle can't ask for an unbounded footprint.
                let cap = { (vx: Double, vy: Double) -> (Double, Double) in
                    let l = JS.hypot(vx, vy)
                    return l > MAX_SS ? ((vx * MAX_SS) / l, (vy * MAX_SS) / l) : (vx, vy)
                }
                let jx = cap(l1x * d1x + l2x * d2x, l1x * d1y + l2x * d2y)
                let jy = cap(l1y * d1x + l2y * d2x, l1y * d1y + l2y * d2y)
                let cnx = count(jx.0, jx.1)
                let cny = count(jy.0, jy.1)
                if cnx * cny > 1 {
                    jac[li * 4] = jx.0
                    jac[li * 4 + 1] = jx.1
                    jac[li * 4 + 2] = jy.0
                    jac[li * 4 + 3] = jy.1
                    ssx[li] = cnx
                    ssy[li] = cny
                }
                let rx0 = Swift.max(t.x, Int(JS.floor(JS.min(p0x, JS.min(p1x, p2x)) - 0.5)))
                let ry0 = Swift.max(t.y, Int(JS.floor(JS.min(p0y, JS.min(p1y, p2y)) - 0.5)))
                let rx1 = Swift.min(t.x + tw, Int(JS.ceil(JS.max(p0x, JS.max(p1x, p2x)) + 0.5)))
                let ry1 = Swift.min(t.y + th, Int(JS.ceil(JS.max(p0y, JS.max(p1y, p2y)) + 0.5)))
                let eps = -1e-9
                // A preview rasterizes only each block's first pixel (blocks are aligned to the tile).
                let ay0 = step == 1 ? ry0 : ry0 + (((t.y - ry0) % step) + step) % step
                let ax0 = step == 1 ? rx0 : rx0 + (((t.x - rx0) % step) + step) % step
                var y = ay0
                while y < ry1 {
                    defer { y += step }
                    let py = Double(y) + 0.5
                    var x = ax0
                    while x < rx1 {
                        defer { x += step }
                        let px = Double(x) + 0.5
                        let l1 = ((px - p0x) * (p2y - p0y) - (p2x - p0x) * (py - p0y)) / det
                        let l2 = ((p1x - p0x) * (py - p0y) - (px - p0x) * (p1y - p0y)) / det
                        let l0 = 1 - l1 - l2
                        if l0 < eps || l1 < eps || l2 < eps { continue }
                        let o = (y - t.y) * tw + (x - t.x)
                        us[o] = l0 * svx[a] + l1 * svx[b] + l2 * svx[c]
                        vs[o] = l0 * svy[a] + l1 * svy[b] + l2 * svy[c]
                        owner[o] = li
                    }
                }
            }
            // Source footprint of the covered pixels, including the spread of their subsamples.
            var fx0 = Double.infinity, fy0 = Double.infinity, fx1 = -Double.infinity, fy1 = -Double.infinity
            for o in 0..<us.count {
                let u = us[o]
                if u.isNaN { continue }
                let li = owner[o]
                let ex = 0.5 * (Swift.abs(jac[li * 4]) + Swift.abs(jac[li * 4 + 2]))
                let ey = 0.5 * (Swift.abs(jac[li * 4 + 1]) + Swift.abs(jac[li * 4 + 3]))
                if u - ex < fx0 { fx0 = u - ex }
                if vs[o] - ey < fy0 { fy0 = vs[o] - ey }
                if u + ex > fx1 { fx1 = u + ex }
                if vs[o] + ey > fy1 { fy1 = vs[o] + ey }
            }
            if fx0 > fx1 { continue }
            guard let foot = intersect(RasterRect(x: Int(JS.floor(fx0)) - 3, y: Int(JS.floor(fy0)) - 3, width: Int(JS.ceil(fx1)) - Int(JS.floor(fx0)) + 6, height: Int(JS.ceil(fy1)) - Int(JS.floor(fy0)) + 6), sr), hasTilesIn(src, foot) else { continue }
            let win = readWindow(src, sr, foot, depth)
            var out = [UInt8](repeating: UInt8(truncatingIfNeeded: def), count: TILE * TILE * ch)
            var deepOut: [Float]? = depth != nil ? [Float](repeating: 0, count: TILE * TILE * 4) : nil
            var any = false
            let ox = ttx * TILE
            let oy = tty * TILE
            let pointAt = { (o: Int, into: inout [Double]) in
                let li = owner[o]
                let cnx = ssx[li]
                let cny = ssy[li]
                if cnx * cny == 1 {
                    sample(win, interp, us[o] - 0.5, vs[o] - 0.5, 1, 1, &into, &wx, &wy)
                    return
                }
                for c in 0..<n { into[c] = 0 }
                let j0 = jac[li * 4], j1 = jac[li * 4 + 1], j2 = jac[li * 4 + 2], j3 = jac[li * 4 + 3]
                for sy in 0..<cny {
                    let tt = (Double(sy) + 0.5) / Double(cny) - 0.5
                    for sx in 0..<cnx {
                        let s = (Double(sx) + 0.5) / Double(cnx) - 0.5
                        sample(win, .bilinear, us[o] + s * j0 + tt * j2 - 0.5, vs[o] + s * j1 + tt * j3 - 0.5, 1, 1, &one, &wx, &wy)
                        for c in 0..<n { into[c] += one[c] }
                    }
                }
                let k = 1 / Double(cnx * cny)
                for c in 0..<n { into[c] *= k }
            }
            if step == 1 {
                for o in 0..<us.count {
                    if us[o].isNaN { continue }
                    pointAt(o, &acc)
                    let x = t.x + o % tw
                    let y = t.y + o / tw
                    let o4 = ((y - oy) * TILE + (x - ox)) * ch
                    if deepOut != nil ? storeScaled(&deepOut!, o4, acc) : store(&out, o4, acc, ch, def) { any = true }
                }
            } else {
                // Preview: the sample at each block's first pixel fills the block.
                var by = 0
                while by < th {
                    defer { by += step }
                    var bx = 0
                    while bx < tw {
                        defer { bx += step }
                        let o = by * tw + bx
                        if us[o].isNaN { continue }
                        pointAt(o, &acc)
                        let first = ((t.y + by - oy) * TILE + (t.x + bx - ox)) * ch
                        if !store(&out, first, acc, ch, def) { continue }
                        any = true
                        for yy in by..<Swift.min(th, by + step) {
                            let row = ((t.y + yy - oy) * TILE + (t.x - ox)) * ch
                            for xx in bx..<Swift.min(tw, bx + step) { for c in 0..<ch { out[row + xx * ch + c] = out[first + c] } }
                        }
                    }
                }
            }
            if !any { continue }
            let tile = deepOut.map { deepTile(fromScaled($0, depth!), 4, def) } ?? finishTile(out, ch, def)
            if let tile { tiles.set(tileKey(ttx, tty), tile) }
        }
    }
    return assemble(src, tiles)
}

// MARK: - Compositing a moved region back

/**
 * `top` (RGBA, straight alpha) composited over `base` with the Normal blend. A one-channel `base`
 * (a mask) takes `top`'s red channel as the value, weighted by its alpha: that is how a moved part
 * of a mask travels (value and coverage) and lands. Only tiles `top` stores are touched, so every
 * other tile of `base` stays shared.
 */
public func compositeSurfaceOver(_ base: TiledSurface, _ top: TiledSurface) -> TiledSurface {
    precondition(top.channels == 4, "compositeSurfaceOver: top must be RGBA")
    if top.tiles.isEmpty { return base }
    let ch = base.channels
    var tiles = base.tiles
    let bd = ch == 4 && base.defaultValue == 0 ? Swift.max(surfaceDepth(base), surfaceDepth(top)) : 8
    let depth: Int? = bd == 8 ? nil : bd
    for (key, t) in top.tiles {
        let under = base.tiles.get(key)
        if under == nil && ch == 4 {
            tiles.set(key, t)
            continue
        }
        if let depth {
            // Over in the deep samples (straight alpha; linear light at 32 bits).
            let k = depth == 16 ? 65535.0 : 1
            let sd = tileSamples(t, 4, depth, 0)
            func over<T>(_ d: inout [T], _ get: (T) -> Double, _ put: (Double) -> T) {
                var i = 0
                while i < d.count {
                    defer { i += 4 }
                    let ta = JS.min(1, sd[i + 3] / k)
                    if ta <= 0 { continue }
                    let da = get(d[i + 3]) / k
                    let oa = ta + da * (1 - ta)
                    for c in 0..<3 {
                        let v = (sd[i + c] * ta + get(d[i + c]) * da * (1 - ta)) / oa
                        d[i + c] = put(depth == 16 ? JS.round(v) : v)
                    }
                    d[i + 3] = put(depth == 16 ? JS.round(oa * k) : oa)
                }
            }
            let next: DeepSamples
            switch tileSamples(under, 4, depth, 0) {
            case .u16(var d):
                over(&d, { Double($0) }, { JS.u16($0) })
                next = .u16(d)
            case .f32(var d):
                over(&d, { Double($0) }, { Float($0) })
                next = .f32(d)
            }
            if let tile = deepTile(next, 4, 0) { tiles.set(key, tile) } else { tiles.delete(key) }
            continue
        }
        var d = under?.data ?? [UInt8](repeating: UInt8(truncatingIfNeeded: base.defaultValue), count: TILE * TILE * ch)
        let s = t.data
        if ch == 4 {
            var i = 0
            while i < d.count {
                defer { i += 4 }
                let ta = Double(s[i + 3]) / 255
                if ta <= 0 { continue }
                if ta >= 1 {
                    d[i] = s[i]
                    d[i + 1] = s[i + 1]
                    d[i + 2] = s[i + 2]
                    d[i + 3] = 255
                    continue
                }
                let da = Double(d[i + 3]) / 255
                let oa = ta + da * (1 - ta)
                for c in 0..<3 { d[i + c] = JS.u8c((Double(s[i + c]) * ta + Double(d[i + c]) * da * (1 - ta)) / oa) }
                d[i + 3] = JS.u8c(oa * 255)
            }
        } else {
            var p = 0, i = 0
            while p < d.count {
                let ta = Double(s[i + 3]) / 255
                if ta > 0 { d[p] = JS.u8c(Double(s[i]) * ta + Double(d[p]) * (1 - ta)) }
                p += 1
                i += 4
            }
        }
        if let tile = finishTile(d, ch, base.defaultValue) { tiles.set(key, tile) } else { tiles.delete(key) }
    }
    return TiledSurface(channels: ch, tiles: tiles, defaultValue: base.defaultValue)
}
