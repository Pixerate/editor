// Portions ported from photocraft-main/crates/compose/src/effects.rs and fill_layout.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation

/**
 * CPU renderer for layer effects. The port of `raster/effects/render.ts`.
 *
 * Render order, bottom to top (Photoshop's layer-style stack read upwards): drop shadows, outer
 * glows, then the layer itself (content at fill opacity) with pattern, gradient and colour
 * overlays, satin, inner glows, inner shadows, the inside part of strokes and inner bevels on
 * top. The outside part of strokes and outer bevels go beneath the layer, onto the backdrop.
 * Exterior effects blend straight into the backdrop with their own modes; the layer blends with
 * its mode and, in a mode other than Normal, is merged into the backdrop before the interior
 * effects paint over it (Photoshop's "Blend Interior Effects as Group" off). Emboss and pillow
 * emboss then shade the composited result. Layer opacity applies to the whole stack; fill
 * opacity only to the layer's own pixels.
 *
 * Every map depends only on the layer's shape (its alpha after the mask), the effect settings
 * and the global light, never on the backdrop. `buildEffectMaps` computes them once over the
 * layer's whole region; `compositeLayerEffects` paints any part of that region (a tile) from
 * them, pixel by pixel, so a tiled render equals a whole-image render.
 *
 * Distances: a stroke's outer edge uses the 5 × 5 chamfer below 20 px and an exact Euclidean
 * transform from there; inside strokes and spread / choke keep the chamfer; precise glows and
 * chiselled bevels use the exact transform. Soft falloffs are two box blurs (a tent).
 *
 * Maps are `Float` (the TS `Float32Array`); arithmetic between them is in `Double`, as in JS.
 */

public typealias EffectRect = RasterRect

/// Alpha above which a pixel belongs to the layer's shape (half an 8-bit step).
private let INSIDE_EPS = 0.5 / 255
private let INF = 1e20
private let FAR = 1e9
/// Outside stroke width from which the outer edge uses the exact Euclidean transform.
public let STROKE_CHAMFER_MAX = 20.0
/// Height below which an outer bevel pixel is off the bevel.
private let BEVEL_H_EPS = 1e-5

struct FMap {
    var w: Int
    var h: Int
    var v: [Float]
}

private func fmap(_ w: Int, _ h: Int, _ fill: Double = 0) -> FMap {
    FMap(w: w, h: h, v: [Float](repeating: Float(fill), count: w * h))
}

@inline(__always) private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { v < lo ? lo : v > hi ? hi : v }
@inline(__always) private func clamp01(_ v: Double) -> Double { v <= 0 ? 0 : v >= 1 ? 1 : v }

@inline(__always) private func mapGet(_ m: FMap, _ x: Int, _ y: Int) -> Double {
    x < 0 || y < 0 || x >= m.w || y >= m.h ? 0 : Double(m.v[y * m.w + x])
}

/// Bilinear shifted copy; reads outside the map give `outside`.
private func shifted(_ m: FMap, _ dxIn: Double, _ dyIn: Double, _ outside: Double) -> FMap {
    let reach = { (d: Double) in d.isFinite ? clamp(d, -1e9, 1e9) : 0 }
    let dx = reach(dxIn)
    let dy = reach(dyIn)
    let fx = Int(JS.floor(dx))
    let fy = Int(JS.floor(dy))
    let ax = dx - Double(fx)
    let ay = dy - Double(fy)
    let w = m.w, h = m.h
    let s = { (x: Int, y: Int) -> Double in x < 0 || y < 0 || x >= w || y >= h ? outside : Double(m.v[y * w + x]) }
    var out = fmap(w, h)
    for y in 0..<h {
        let sy = y - fy
        for x in 0..<w {
            let sx = x - fx
            let top = s(sx, sy) * (1 - ax) + s(sx - 1, sy) * ax
            let bot = s(sx, sy - 1) * (1 - ax) + s(sx - 1, sy - 1) * ax
            out.v[y * w + x] = Float(top * (1 - ay) + bot * ay)
        }
    }
    return out
}

private func mapped(_ m: FMap, _ f: (Double) -> Double) -> FMap {
    FMap(w: m.w, h: m.h, v: m.v.map { Float(f(Double($0))) })
}

// MARK: - Distance transforms

/// 1D squared distance transform (Felzenszwalb & Huttenlocher) with the nearest site.
private func dt1(_ f: [Double], _ n: Int, _ out: inout [Double], _ near: inout [Int], _ v: inout [Int], _ z: inout [Double]) {
    var k = 0
    v[0] = 0
    z[0] = -.infinity
    z[1] = .infinity
    if n > 1 {
        for q in 1..<n {
            while true {
                let p = v[k]
                let s = (f[q] + Double(q * q) - (f[p] + Double(p * p))) / Double(2 * q - 2 * p)
                if s <= z[k] && k > 0 {
                    k -= 1
                    continue
                }
                if s <= z[k] {
                    v[0] = q
                    z[0] = -.infinity
                    z[1] = .infinity
                    break
                }
                k += 1
                v[k] = q
                z[k] = s
                z[k + 1] = .infinity
                break
            }
        }
    }
    k = 0
    for q in 0..<n {
        while z[k + 1] < Double(q) { k += 1 }
        let p = v[k]
        let d = Double(q - p)
        out[q] = d * d + f[p]
        near[q] = p
    }
}

/// Exact Euclidean distance from every pixel to the nearest `inside` pixel, plus that pixel's index.
private func edtNearest(_ inside: [Bool], _ w: Int, _ h: Int) -> (d: [Float], near: [Int]) {
    let total = w * h
    let n = Swift.max(w, h)
    var f = [Double](repeating: 0, count: n)
    var o = [Double](repeating: 0, count: n)
    var nr = [Int](repeating: 0, count: n)
    var v = [Int](repeating: 0, count: n)
    var z = [Double](repeating: 0, count: n + 1)
    // Columns first: gc[x * h + y], nc = nearest row.
    var gc = [Double](repeating: 0, count: total)
    var nc = [Int](repeating: 0, count: total)
    for x in 0..<w {
        for y in 0..<h { f[y] = inside[y * w + x] ? 0 : INF }
        dt1(f, h, &o, &nr, &v, &z)
        for y in 0..<h {
            gc[x * h + y] = o[y]
            nc[x * h + y] = nr[y]
        }
    }
    var d = [Float](repeating: 0, count: total)
    var near = [Int](repeating: 0, count: total)
    for y in 0..<h {
        for x in 0..<w { f[x] = gc[x * h + y] }
        dt1(f, w, &o, &nr, &v, &z)
        for x in 0..<w {
            d[y * w + x] = Float(o[x].squareRoot())
            let px = nr[x]
            near[y * w + x] = nc[px * h + y] * w + px
        }
    }
    return (d, near)
}

private let S2 = 2.0.squareRoot()
private let S5 = 2.236068
private let FWD: [(Int, Int, Double)] = [(-1, 0, 1), (-1, -1, S2), (0, -1, 1), (1, -1, S2), (-1, -2, S5), (1, -2, S5), (-2, -1, S5), (2, -1, S5)]

/**
 * Chamfer distance with a 5 × 5 mask of exact step lengths (1, √2, √5) from per-pixel start
 * values (`INF` = not a seed): the minimum over seeds of start + path length. Photoshop's effect
 * distances follow this metric.
 */
private func chamferFrom(_ d: inout [Float], _ w: Int, _ h: Int) {
    for pass in 0..<2 {
        let sign = pass == 0 ? 1 : -1
        for yy in 0..<h {
            let y = pass == 0 ? yy : h - 1 - yy
            for xx in 0..<w {
                let x = pass == 0 ? xx : w - 1 - xx
                let i = y * w + x
                var best = Double(d[i])
                for (ox, oy, wt) in FWD {
                    let nx = x + ox * sign
                    let ny = y + oy * sign
                    if nx < 0 || ny < 0 || nx >= w || ny >= h { continue }
                    let c = Double(d[ny * w + nx]) + wt
                    if c < best { best = c }
                }
                d[i] = Float(best)
            }
        }
    }
}

/**
 * Distance from each pixel centre outside the shape to its edge; the edge inside the nearest
 * covered pixel is placed by its coverage. Inside pixels get -0.5.
 */
private func distOutside(_ s: FMap, _ chamfer: Bool) -> [Float] {
    let w = s.w, h = s.h, v = s.v
    let n = v.count
    var out = [Float](repeating: 0, count: n)
    if chamfer {
        var d = [Float](repeating: 0, count: n)
        for i in 0..<n { d[i] = Double(v[i]) > INSIDE_EPS ? Float(1 - JS.min(Double(v[i]), 1)) : Float(INF) }
        chamferFrom(&d, w, h)
        for i in 0..<n { out[i] = Double(v[i]) > INSIDE_EPS ? -0.5 : Float(Double(d[i]) - 0.5) }
        return out
    }
    let inside = v.map { Double($0) > INSIDE_EPS }
    let (d, near) = edtNearest(inside, w, h)
    for i in 0..<n { out[i] = inside[i] ? -0.5 : Float(Double(d[i]) - 0.5 + (1 - JS.min(Double(v[near[i]]), 1))) }
    return out
}

/// Alpha relative to its 3 × 3 neighbourhood maximum (edge coverage apart from the fill's own opacity).
private func localCoverage(_ s: FMap) -> FMap {
    var out = s
    for y in 0..<s.h {
        for x in 0..<s.w {
            let a = Double(s.v[y * s.w + x])
            if a <= INSIDE_EPS { continue }
            var mx = a
            for dy in -1...1 { for dx in -1...1 { mx = JS.max(mx, mapGet(s, x + dx, y + dy)) } }
            out.v[y * s.w + x] = Float(JS.min(a / mx, 1))
        }
    }
    return out
}

/// Distance from each pixel centre inside the shape to its edge (-0.5 outside).
private func distInside(_ s: FMap, _ chamfer: Bool) -> [Float] {
    let w = s.w, h = s.h, v = s.v
    let n = v.count
    var out = [Float](repeating: 0, count: n)
    if chamfer {
        // Partly covered edge pixels are seeds starting at their coverage.
        let cov = localCoverage(s)
        var d = [Float](repeating: 0, count: n)
        for i in 0..<n { d[i] = Double(v[i]) <= INSIDE_EPS ? 0 : Double(cov.v[i]) < 1 - INSIDE_EPS ? cov.v[i] : Float(INF) }
        chamferFrom(&d, w, h)
        for i in 0..<n { out[i] = Double(v[i]) <= INSIDE_EPS ? -0.5 : Float(Double(d[i]) - 0.5) }
        return out
    }
    let outside = v.map { Double($0) <= INSIDE_EPS }
    let (d, _) = edtNearest(outside, w, h)
    for i in 0..<n { out[i] = outside[i] ? -0.5 : Float(Double(d[i]) - 0.5) }
    return out
}

/**
 * Signed distances to the shape's edge for chiselled bevels, measured to the straight edge through
 * the nearest edge pixel: the edge's normal is the coverage gradient there and its position the
 * pixel's coverage. Beyond `reach` the plain distances are used. `din` is ≤ -0.5 outside the
 * shape, `dout` ≤ -0.5 inside it (with partly covered pixels between).
 */
private func edgeDistances(_ s: FMap, _ reach: Double) -> (din: [Float], dout: [Float]) {
    let w = s.w, h = s.h, v = s.v
    let n = v.count
    var edge = [Bool](repeating: false, count: n)
    var inside = [Bool](repeating: false, count: n)
    for y in 0..<h {
        for x in 0..<w {
            let i = y * w + x
            let a = Double(v[i])
            if a <= INSIDE_EPS { continue }
            inside[i] = true
            if a < 1 - INSIDE_EPS || mapGet(s, x - 1, y) <= INSIDE_EPS || mapGet(s, x + 1, y) <= INSIDE_EPS || mapGet(s, x, y - 1) <= INSIDE_EPS || mapGet(s, x, y + 1) <= INSIDE_EPS { edge[i] = true }
        }
    }
    let (d, near) = edtNearest(edge, w, h)
    var din = [Float](repeating: 0, count: n)
    var dout = [Float](repeating: 0, count: n)
    for y in 0..<h {
        for x in 0..<w {
            let i = y * w + x
            let q = near[i]
            let di = Double(d[i])
            var sd: Double
            if di > reach || di >= INF / 2 {
                // Far from the edge: plain distance to the nearest edge pixel's centre.
                sd = inside[i] ? -(di + 0.5) : di - 0.5
            } else {
                let qx = q % w
                let qy = (q - qx) / w
                // Outward normal: against the coverage gradient (Sobel) at the edge pixel.
                let g = { (dx: Int, dy: Int) in mapGet(s, qx + dx, qy + dy) }
                var nx = -(g(1, -1) + 2 * g(1, 0) + g(1, 1) - g(-1, -1) - 2 * g(-1, 0) - g(-1, 1))
                var ny = -(g(-1, 1) + 2 * g(0, 1) + g(1, 1) - g(-1, -1) - 2 * g(0, -1) - g(1, -1))
                let len = JS.hypot(nx, ny)
                if len > 1e-6 {
                    nx /= len
                    ny /= len
                } else if di > 0 {
                    nx = Double(x - qx) / di
                    ny = Double(y - qy) / di
                } else {
                    nx = 1
                    ny = 0
                }
                // The edge crosses q at (coverage - ½) along the normal (an axis-aligned edge's offset).
                sd = Double(x - qx) * nx + Double(y - qy) * ny - (JS.min(Double(v[q]), 1) - 0.5)
            }
            din[i] = inside[i] ? Float(JS.max(-sd, inside[i] && !edge[i] ? 0.5 : -0.5)) : -0.5
            dout[i] = inside[i] && !edge[i] ? -0.5 : Float(JS.max(sd, -0.5))
        }
    }
    return (din, dout)
}

/// Grows the shape by `r` px (anti-aliased, chamfer metric), keeping its soft edge.
private func dilate(_ s: FMap, _ r: Double) -> FMap {
    if !(r > 0) { return s }
    let d = distOutside(s, true)
    var out = s
    for i in 0..<d.count {
        let o = Double(out.v[i])
        out.v[i] = Float(d[i] < 0 ? JS.min(o + r, 1) : JS.max(o, clamp01(r + 0.5 - Double(d[i]))))
    }
    return out
}

// MARK: - Tent blur (two box passes of a fractional width)

private func boxWidth(_ w: Double) -> Double {
    w.isNaN ? 1 : clamp(w, 1, MAX_EFFECT_REACH)
}

/// (r, end-tap weight, 1 / width) of a box of fractional width.
private func boxGeom(_ bwIn: Double) -> (r: Int, f: Double, norm: Double) {
    let bw = boxWidth(bwIn)
    let half = bw / 2
    let r = JS.max(0, JS.ceil(half - 0.5))
    let f = clamp01(half - (r - 0.5))
    return (Int(r), f, 1 / bw)
}

/// One box pass over `src` (zero outside it) evaluated at `x0 .. x0 + dst.count`, as a running sum.
private func boxLine(_ src: [Double], _ srcCount: Int, _ x0: Int, _ dst: inout [Double], _ dstCount: Int, _ bw: Double) {
    let n = srcCount
    let (r, f, norm) = boxGeom(bw)
    let at = { (i: Int) -> Double in i >= 0 && i < n ? src[i] : 0 }
    if r == 0 {
        for k in 0..<dstCount { dst[k] = at(x0 + k) }
        return
    }
    var inner = 0.0
    if r >= 1 {
        var i = x0 - (r - 1)
        while i <= x0 + (r - 1) {
            inner += at(i)
            i += 1
        }
    }
    for k in 0..<dstCount {
        let x = x0 + k
        dst[k] = (inner + f * (at(x - r) + at(x + r))) * norm
        inner += at(x + r) - at(x - r + 1)
    }
}

/// Values a running-sum blur leaves where it should be zero (float residue) are flushed below this.
private let BLUR_EPS = 1e-7
/**
 * Fixed-point scale of the blur's running sums. Inputs are rounded to multiples of 1 / BLUR_FIX, so
 * the sums are of integers and exact (|sum| stays far below 2^53): a value does not depend on where
 * the line starts, which lets effect maps be rebuilt over a window and patched in.
 */
private let BLUR_FIX = 4_294_967_296.0

private func tentLine(_ src: inout [Double], _ dst: inout [Double], _ bw: Double, _ mid: inout [Double]) {
    let r = boxGeom(bw).r
    let mlen = src.count + 2 * r
    for i in 0..<src.count { src[i] = JS.round(src[i] * BLUR_FIX) }
    boxLine(src, src.count, -r, &mid, mlen, bw)
    for i in 0..<mlen { mid[i] = JS.round(mid[i]) }
    boxLine(mid, mlen, r, &dst, dst.count, bw)
    // Flush what would read as coverage at a float's noise level (noise would speckle it).
    for i in 0..<dst.count {
        let v = dst[i] / BLUR_FIX
        dst[i] = Swift.abs(v) < BLUR_EPS ? 0 : v
    }
}

/// Two box passes of width `w` along each axis, zero outside the map.
private func tent(_ m: inout FMap, _ w: Double) {
    if !w.isFinite || m.v.isEmpty { return }
    // A box of radius 0 is the identity.
    let r = boxGeom(w).r
    if r == 0 { return }
    let mw = m.w, mh = m.h
    var mid = [Double](repeating: 0, count: Swift.max(mw, mh) + 2 * r)
    var row = [Double](repeating: 0, count: mw)
    var rowOut = [Double](repeating: 0, count: mw)
    for y in 0..<mh {
        for x in 0..<mw { row[x] = Double(m.v[y * mw + x]) }
        tentLine(&row, &rowOut, w, &mid)
        for x in 0..<mw { m.v[y * mw + x] = Float(rowOut[x]) }
    }
    var col = [Double](repeating: 0, count: mh)
    var colOut = [Double](repeating: 0, count: mh)
    for x in 0..<mw {
        for y in 0..<mh { col[y] = Double(m.v[y * mw + x]) }
        tentLine(&col, &colOut, w, &mid)
        for y in 0..<mh { m.v[y * mw + x] = Float(colOut[y]) }
    }
}

private func blur(_ m: inout FMap, _ size: Double) {
    if size.isFinite { tent(&m, size) }
}

// MARK: - Contours

private let lutCache = Locked([EffectContour: [Float]?]())

/// A contour as a 0..1 LUT (corner points split the spline), or `nil` for linear.
public func contourLut(_ c: EffectContour?) -> [Float]? {
    guard let c else { return nil }
    if let cached = lutCache.with({ $0[c] }) { return cached }
    let pts = c.points
    let linear = pts.count == 2 && pts[0].input == 0 && pts[0].output == 0 && pts[1].input == 1 && pts[1].output == 1
    var lut: [Float]? = nil
    let curve = { (p: [ContourPoint]) in curveLut(p.map { CurvePoint(input: $0.input, output: $0.output) }) }
    if pts.count >= 2 && !linear {
        if !pts.contains(where: { $0.corner == true }) {
            lut = curve(pts)
        } else {
            let sorted = pts.enumerated().sorted { $0.element.input != $1.element.input ? $0.element.input < $1.element.input : $0.offset < $1.offset }.map(\.element)
            var start = 0
            for i in 1..<sorted.count {
                if !(sorted[i].corner == true || i == sorted.count - 1) { continue }
                let seg = Array(sorted[start...i])
                let from = seg[0].input
                let part = curve(seg)
                if lut == nil {
                    lut = part
                } else {
                    for k in 0..<part.count where Double(k) / Double(part.count - 1) >= from { lut![k] = part[k] }
                }
                start = i
            }
            if lut == nil { lut = curve(pts) }
        }
    }
    lutCache.with { cache in
        if cache.count >= 256 { cache.removeAll() }
        cache[c] = .some(lut)
    }
    return lut
}

private func lutAt(_ l: [Float], _ v: Double) -> Double {
    let x = clamp01(v) * Double(l.count - 1)
    let i = Int(JS.floor(x))
    let j = Swift.min(i + 1, l.count - 1)
    return Double(l[i]) + (Double(l[j]) - Double(l[i])) * (x - Double(i))
}

private func applyLut(_ m: FMap, _ l: [Float]?) -> FMap {
    guard let l else { return m }
    return mapped(m) { lutAt(l, $0) }
}

/// A contour applied over a Range (`contour(min(v / range, 1))`), `nil` for the identity.
private func rangedLut(_ c: EffectContour?, _ range: Double) -> [Float]? {
    let base = contourLut(c)
    let r = range.isFinite ? clamp(range, 0.01, 1) : 1
    if r >= 0.999 { return base }
    let n = 4096
    var out = [Float](repeating: 0, count: n)
    for k in 0..<n {
        let v = JS.min(Double(k) / Double(n - 1) / r, 1)
        out[k] = Float(base.map { lutAt($0, v) } ?? v)
    }
    return out
}

/// Satin's transfer: the contour read from its far end, `|c(1 − v) − c(1)|`.
private func satinLut(_ c: EffectContour?) -> [Float]? {
    guard let lut = contourLut(c) else { return nil }
    let end = Double(lut[lut.count - 1])
    return (0..<lut.count).map { Float(Swift.abs(Double(lut[lut.count - 1 - $0]) - end)) }
}

/// Monochrome speckle in the coverage (Noise), hashed from document coordinates.
private func noise(_ m: inout FMap, _ amount: Double, _ x0: Int, _ y0: Int) {
    if !amount.isFinite || amount <= 0 { return }
    for y in 0..<m.h {
        for x in 0..<m.w {
            let i = y * m.w + x
            if Double(m.v[i]) <= BLUR_EPS { continue }
            m.v[i] = Float(clamp01(Double(m.v[i]) + (hashNoise(Double(x0 + x), Double(y0 + y)) - 0.5) * 2 * amount))
        }
    }
}

/// Offset of an effect lit from `angle` at `distance` (falls away from the light), in whole pixels.
private func lightOffset(_ angle: Double, _ distance: Double) -> (Double, Double) {
    let a = (angle * Double.pi) / 180
    return (JS.round(-JS.cos(a) * distance), JS.round(JS.sin(a) * distance))
}

/// (dilation radius, blur width) of a spread / choke.
private func spreadSplit(_ size: Double, _ spread: Double) -> (Double, Double) {
    (JS.round(size * spread), size * (1 - spread))
}

// MARK: - Effect maps

private struct ShadowLike {
    var angle: Double
    var useGlobalLight: Bool
    var distance: Double
    var size: Double
    var contour: EffectContour?
    var noise: Double
}

private func shadowMap(_ shape: FMap, _ s: ShadowLike, _ spread: Double, _ light: GlobalLight, _ inner: Bool, _ ox: Int, _ oy: Int) -> FMap {
    let angle = s.useGlobalLight ? light.angle : s.angle
    let (dx, dy) = lightOffset(angle, s.distance)
    let src = inner ? mapped(shape) { 1 - $0 } : shape
    var m = shifted(src, dx, dy, inner ? 1 : 0)
    let (r, bw) = spreadSplit(s.size, spread)
    m = dilate(m, r)
    blur(&m, bw)
    m = applyLut(m, contourLut(s.contour))
    noise(&m, s.noise, ox, oy)
    if inner { for i in 0..<m.v.count { m.v[i] = Float(Double(m.v[i]) * Double(shape.v[i])) } }
    return m
}

private struct GlowLike {
    var inner: Bool
    var spread: Double
    var technique: GlowTechnique
    var size: Double
    var contour: EffectContour?
    var range: Double
    var noise: Double
    var center: Bool
}

private func glowMap(_ shape: FMap, _ g: GlowLike, _ ox: Int, _ oy: Int) -> FMap {
    let inner = g.inner
    let spread = g.spread
    let src = inner ? mapped(shape) { 1 - $0 } : shape
    var m: FMap
    if g.technique == .precise {
        // Coverage falls linearly from 0.5 at the edge to 0 at `size + 1` px, solid within the spread.
        let d = inner ? distInside(shape, false) : distOutside(src, false)
        let solid = g.size * spread
        let soft = JS.max(g.size + 1 - solid, 1e-3)
        m = fmap(shape.w, shape.h)
        for i in 0..<d.count {
            let di = Double(d[i]) + 0.5
            m.v[i] = Float(di <= solid ? 1 : 0.5 * clamp01(1 - (di - solid) / soft))
        }
    } else {
        let (r, bw) = spreadSplit(g.size, spread)
        m = dilate(src, r)
        blur(&m, bw)
    }
    m = applyLut(m, rangedLut(g.contour, g.range))
    if inner && g.center { m = mapped(m) { 1 - $0 } }
    noise(&m, g.noise, ox, oy)
    if inner { for i in 0..<m.v.count { m.v[i] = Float(Double(m.v[i]) * Double(shape.v[i])) } }
    return m
}

private func satinMap(_ shape: FMap, _ s: SatinEffect) -> FMap {
    let (dx, dy) = lightOffset(s.angle, JS.max(1, s.distance))
    var a = shifted(shape, dx, dy, 0)
    var b = shifted(shape, -dx, -dy, 0)
    tent(&a, s.size)
    tent(&b, s.size)
    var m = fmap(shape.w, shape.h)
    for i in 0..<m.v.count { m.v[i] = Float(Swift.abs(Double(a.v[i]) - Double(b.v[i]))) }
    if s.invert { m = mapped(m) { 1 - $0 } }
    m = applyLut(m, satinLut(s.contour))
    for i in 0..<m.v.count { m.v[i] = Float(Double(m.v[i]) * Double(shape.v[i])) }
    return m
}

/// Where a bevel paints: inside the shape, outside it, or both (emboss styles).
public enum BevelPaint: String, Sendable {
    case inner, outer, both
}

private struct BevelGeom {
    var paint: BevelPaint
    var width: Double
    var depth: Double
    var pillow: Bool
    var chiselSoft: Double
}

private func bevelGeom(_ b: BevelEmbossEffect) -> BevelGeom {
    let size = JS.max(b.size, 1)
    let emboss = b.style == .emboss || b.style == .pillowEmboss
    let paint: BevelPaint = b.style == .outerBevel ? .outer : emboss ? .both : .inner
    // Emboss styles straddle the edge with half the size, rounded up to whole pixels.
    let width = emboss ? JS.ceil(size / 2) : size
    let smooth = b.technique == .smooth
    let sign = b.direction == "up" ? 1.0 : -1.0
    return BevelGeom(
        paint: paint,
        width: width,
        depth: b.depth * (smooth ? width : size / 2) * sign,
        pillow: b.style == .pillowEmboss,
        chiselSoft: b.technique == .chiselSoft ? JS.max(size / 4, 1) : 0
    )
}

/// Chiselled height from the inside / outside distances.
private func bevelChiselH(_ paint: BevelPaint, _ size: Double, _ din: Double, _ dout: Double, _ soft: Bool) -> Double {
    let ramp = size + 1
    if paint == .outer && !soft {
        let top = (size + 2) / ramp
        return dout > 0 ? clamp((size + 1.5 - dout) / ramp, 0, top) : top
    }
    if paint == .outer { return dout > 0 ? 1 - clamp01((dout + 0.5) / ramp) : (size + 2) / ramp }
    if paint == .both {
        let half = size / 2 + 0.5
        return din > 0 ? 0.5 + 0.5 * clamp01(din / half) : 0.5 - 0.5 * clamp01(dout / half)
    }
    if soft { return din > 0 ? clamp((din + 1.5) / ramp, 0, (size + 2) / ramp) : 0 }
    return din > 0 ? clamp01((din + 0.5) / ramp) : 0
}

public struct EffectContext {
    public var light: GlobalLight
    /// A pattern tile by id, or `nil` when missing (pattern effects then paint nothing).
    public var pattern: (String) -> PatternTile?
    public init(light: GlobalLight, pattern: @escaping (String) -> PatternTile?) {
        self.light = light
        self.pattern = pattern
    }
}

private func bevelHeight(_ shape: FMap, _ b: BevelEmbossEffect, _ g: BevelGeom, _ rect: EffectRect, _ anchor: EffectPoint, _ ctx: EffectContext) -> FMap {
    let size = JS.max(b.size, 1)
    var h: FMap
    if b.technique == .smooth {
        h = shape
        tent(&h, g.width)
    } else {
        let (din, dout) = edgeDistances(shape, size + 2)
        h = fmap(shape.w, shape.h)
        let soft = g.chiselSoft > 0
        for i in 0..<h.v.count { h.v[i] = Float(bevelChiselH(g.paint, size, Double(din[i]), Double(dout[i]), soft)) }
        if soft && g.paint == .both { tent(&h, g.chiselSoft) }
    }
    if let ce = b.contourElement { h = applyLut(h, contourLut(ce.contour) ?? identityLut) }
    if let t = b.texture, let tile = ctx.pattern(t.pattern.patternId) {
        let unit = Swift.abs(b.depth) > 1e-6 ? JS.max(Swift.abs(g.depth / b.depth), 1e-3) : JS.max(g.width, 1)
        let place = PatternPlacement(anchor: anchor, link: t.pattern.link ?? true, phase: t.pattern.phase ?? EffectPoint(x: 0, y: 0), scale: t.pattern.scale, angle: 0)
        let k = t.depth / unit
        var uv = [0.0, 0.0]
        var p = [0.0, 0.0, 0.0, 0.0]
        for y in 0..<h.h {
            for x in 0..<h.w {
                place.map(Double(rect.x + x) + 0.5, Double(rect.y + y) + 0.5, &uv)
                tile.sample(uv[0], uv[1], &p)
                let l = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) * p[3]
                h.v[y * h.w + x] = Float(Double(h.v[y * h.w + x]) + k * (t.invert ? 1 - l : l))
            }
        }
    }
    if b.soften >= 1 { tent(&h, b.soften) }
    return h
}

private let identityLut: [Float] = (0..<4096).map { Float(Double($0) / 4095) }

/// Bevel highlight and shadow maps (`[hi, sh]`) and where they paint.
private func bevelMaps(_ shape: FMap, _ b: BevelEmbossEffect, _ rect: EffectRect, _ anchor: EffectPoint, _ ctx: EffectContext) -> (maps: [FMap], paint: BevelPaint) {
    let g = bevelGeom(b)
    let hmap = bevelHeight(shape, b, g, rect, anchor, ctx)
    let angle = b.useGlobalLight ? ctx.light.angle : b.angle
    let altitude = b.useGlobalLight ? ctx.light.altitude : b.altitude
    let sa = JS.sin((angle * Double.pi) / 180)
    let ca = JS.cos((angle * Double.pi) / 180)
    let se = JS.sin((altitude * Double.pi) / 180)
    let ce = JS.cos((altitude * Double.pi) / 180)
    let lx = ca * ce
    let ly = -sa * ce
    let lz = se
    let reachPast = g.paint == .both || (g.paint == .outer && b.technique != .smooth)
    let onBevel = { (x: Int, y: Int) -> Bool in
        mapGet(hmap, x, y) > BEVEL_H_EPS
            || (reachPast && (mapGet(hmap, x + 1, y) > BEVEL_H_EPS || mapGet(hmap, x - 1, y) > BEVEL_H_EPS || mapGet(hmap, x, y + 1) > BEVEL_H_EPS || mapGet(hmap, x, y - 1) > BEVEL_H_EPS))
    }
    let gloss = contourLut(b.glossContour)
    let shadeInto = { (depth: Double, outside: Bool) -> (FMap, FMap) in
        var hi = fmap(shape.w, shape.h)
        var sh = fmap(shape.w, shape.h)
        for y in 0..<shape.h {
            for x in 0..<shape.w {
                let i = y * shape.w + x
                let gx = (mapGet(hmap, x + 1, y) - mapGet(hmap, x - 1, y)) * 0.5 * depth
                let gy = (mapGet(hmap, x, y + 1) - mapGet(hmap, x, y - 1)) * 0.5 * depth
                let len = (gx * gx + gy * gy + 1).squareRoot()
                let shade = (-gx * lx - gy * ly + lz) / len
                let sv = Double(shape.v[i])
                let region = outside ? (sv < 1 - INSIDE_EPS && onBevel(x, y) ? 1 : 0) : sv
                let k = shade - se
                if k > 0 { hi.v[i] = Float(clamp01(k / JS.max(1 - se, 1e-3)) * region) }
                else { sh.v[i] = Float(clamp01(-k / JS.max(se, 1e-3)) * region) }
            }
        }
        return (applyLut(hi, gloss), applyLut(sh, gloss))
    }
    if g.paint != .both {
        let (hi, sh) = shadeInto(g.depth, g.paint == .outer)
        return ([hi, sh], g.paint)
    }
    // One map per colour over the whole bevel: the inside half where the shape is, the outside half
    // (pillow: facing the other way) for the rest of each pixel.
    let (hi, sh) = shadeInto(g.depth, false)
    let (ho, so) = shadeInto(g.pillow ? -g.depth : g.depth, true)
    let mix = { (a: FMap, o: FMap) -> FMap in
        var out = fmap(a.w, a.h)
        for i in 0..<out.v.count {
            let s = Double(shape.v[i])
            out.v[i] = Float((s > INSIDE_EPS ? Double(a.v[i]) : 0) + Double(o.v[i]) * (1 - JS.min(s, 1)))
        }
        return out
    }
    return ([mix(hi, ho), mix(sh, so)], .both)
}

/// (inside width, outside width) of a stroke.
private func strokeWidths(_ s: StrokeEffect) -> (Double, Double) {
    switch s.position {
    case .outside: return (0, s.size)
    case .inside: return (s.size, 0)
    case .center: return (s.size / 2, s.size / 2)
    }
}

/// Effect maps of one layer over its region: see `buildEffectMaps`.
public struct EffectMaps {
    /// The region the maps cover (document space).
    public var rect: EffectRect
    /// The enabled effects, Scale Effects applied, in list order.
    public var items: [LayerEffect]
    /// Pixel bounds of the shape (alpha above half a step), or `nil` when the shape is empty.
    public var bounds: EffectRect?
    public var shape: [Float]
    /// Per item: the maps it paints through.
    public var per: [[[Float]]]
    public var bevelPaint: [BevelPaint?]
    public var din: [Float]?
    public var dout: [Float]?
    public var doutExact: [Float]?
    /// Frames of gradient strokes by item index.
    public var frames: [Int: EffectRect]
    /// Approximate size in bytes (cache budgeting).
    public var bytes: Int
}

/// The enabled effects of `effects` with Scale Effects applied (empty when the master switch is off).
public func activeEffectItems(_ effects: LayerEffects?) -> [LayerEffect] {
    guard let effects, hasActiveEffects(effects) else { return [] }
    let s = effectsScale(effects)
    return effects.items.filter(\.enabled).map { scaleLayerEffect($0, s) }
}

/**
 * Whether every map pixel of `items` depends only on the shape within the effects' margin, so a
 * tile is unchanged while the layer is unchanged within its margin. Not local: anything laid out
 * over the layer's bounds (aligned gradient overlays, gradient strokes, linked patterns) and noise.
 */
public func effectsAreLocal(_ items: [LayerEffect]) -> Bool {
    let linked = { (p: EffectPatternRef) in p.link != false }
    return items.allSatisfy { e in
        switch e {
        case .gradientOverlay(let x): return !x.gradient.align
        case .patternOverlay(let x): return !linked(x.pattern)
        case .stroke(let x):
            switch x.fill {
            case .color: return true
            case .pattern(let p): return !linked(p)
            case .gradient: return false
            }
        case .dropShadow(let x): return x.noise <= 0
        case .innerShadow(let x): return x.noise <= 0
        case .outerGlow(let x): return x.noise <= 0
        case .innerGlow(let x): return x.noise <= 0
        case .bevelEmboss(let x): return x.texture == nil || !linked(x.texture!.pattern)
        default: return true
        }
    }
}

/// Pixel bounds (document space) of the alpha above half a step in `shape` over `rect`, or `nil`.
private func shapeBounds(_ shape: [Float], _ rect: EffectRect) -> EffectRect? {
    let w = rect.width, h = rect.height
    let rowHit = { (y: Int) -> Bool in
        var i = y * w
        for _ in 0..<w {
            if Double(shape[i]) > INSIDE_EPS { return true }
            i += 1
        }
        return false
    }
    var y0 = 0
    while y0 < h && !rowHit(y0) { y0 += 1 }
    if y0 == h { return nil }
    var y1 = h - 1
    while !rowHit(y1) { y1 -= 1 }
    // Columns: each row only needs scanning outside the columns found so far.
    var x0 = w
    var x1 = -1
    for y in y0...y1 {
        let o = y * w
        var x = 0
        while x < x0 {
            if Double(shape[o + x]) > INSIDE_EPS {
                x0 = x
                break
            }
            x += 1
        }
        x = w - 1
        while x > x1 {
            if Double(shape[o + x]) > INSIDE_EPS {
                x1 = x
                break
            }
            x -= 1
        }
    }
    return EffectRect(x: rect.x + x0, y: rect.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1)
}

/**
 * Builds every map `items` paints through from the layer's alpha `shape` (0..1) over `rect`.
 * `rect` should cover the layer's shape plus the effects' margin.
 */
public func buildEffectMaps(_ items: [LayerEffect], _ shape: [Float], _ rect: EffectRect, _ ctx: EffectContext) -> EffectMaps {
    let w = rect.width
    let h = rect.height
    let s = FMap(w: w, h: h, v: shape)
    let bounds = shapeBounds(shape, rect)
    let anchor = bounds.map { EffectPoint(x: Double($0.x), y: Double($0.y)) } ?? EffectPoint(x: Double(rect.x), y: Double(rect.y))
    var per: [[[Float]]] = []
    var bevelPaint: [BevelPaint?] = []
    var frames: [Int: EffectRect] = [:]
    var bytes = shape.count * 4
    for (i, e) in items.enumerated() {
        var maps: [FMap] = []
        var paint: BevelPaint? = nil
        switch e {
        case .dropShadow(let x):
            maps = [shadowMap(s, ShadowLike(angle: x.angle, useGlobalLight: x.useGlobalLight, distance: x.distance, size: x.size, contour: x.contour, noise: x.noise), x.spread, ctx.light, false, rect.x, rect.y)]
        case .innerShadow(let x):
            maps = [shadowMap(s, ShadowLike(angle: x.angle, useGlobalLight: x.useGlobalLight, distance: x.distance, size: x.size, contour: x.contour, noise: x.noise), x.choke, ctx.light, true, rect.x, rect.y)]
        case .outerGlow(let x):
            maps = [glowMap(s, GlowLike(inner: false, spread: x.spread, technique: x.technique, size: x.size, contour: x.contour, range: x.range, noise: x.noise, center: false), rect.x, rect.y)]
        case .innerGlow(let x):
            maps = [glowMap(s, GlowLike(inner: true, spread: x.choke, technique: x.technique, size: x.size, contour: x.contour, range: x.range, noise: x.noise, center: x.source == "center"), rect.x, rect.y)]
        case .satin(let x):
            maps = [satinMap(s, x)]
        case .bevelEmboss(let x):
            let r = bevelMaps(s, x, rect, anchor, ctx)
            maps = r.maps
            paint = r.paint
        case .stroke(let x):
            if case .gradient = x.fill, let bounds {
                let grow = Swift.max(0, Int(JS.ceil(JS.min(strokeWidths(x).1, MAX_EFFECT_REACH))) - 1)
                frames[i] = EffectRect(x: bounds.x - grow, y: bounds.y - grow, width: bounds.width + 2 * grow, height: bounds.height + 2 * grow)
            }
        default:
            break
        }
        per.append(maps.map(\.v))
        bevelPaint.append(paint)
        for m in maps { bytes += m.v.count * 4 }
    }
    let strokes: [StrokeEffect] = items.compactMap { if case .stroke(let x) = $0 { return x }; return nil }
    let outW = strokes.map { strokeWidths($0).1 }.filter { $0 > 0 }
    let din = strokes.isEmpty ? nil : distInside(s, true)
    let dout = outW.contains { $0 < STROKE_CHAMFER_MAX } ? distOutside(s, true) : nil
    let doutExact = outW.contains { $0 >= STROKE_CHAMFER_MAX } ? distOutside(s, false) : nil
    for d in [din, dout, doutExact] { if let d { bytes += d.count * 4 } }
    return EffectMaps(rect: rect, items: items, bounds: bounds, shape: shape, per: per, bevelPaint: bevelPaint, din: din, dout: dout, doutExact: doutExact, frames: frames, bytes: bytes)
}

private func rectArea(_ r: EffectRect) -> Int { r.width * r.height }

private func clipRect(_ a: EffectRect, _ b: EffectRect) -> EffectRect? {
    let x0 = Swift.max(a.x, b.x)
    let y0 = Swift.max(a.y, b.y)
    let x1 = Swift.min(a.x + a.width, b.x + b.width)
    let y1 = Swift.min(a.y + a.height, b.y + b.height)
    return x1 > x0 && y1 > y0 ? EffectRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0) : nil
}

private func growRect(_ r: EffectRect, _ m: Int) -> EffectRect {
    EffectRect(x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m)
}

private func unionRect(_ a: EffectRect, _ b: EffectRect) -> EffectRect {
    let x0 = Swift.min(a.x, b.x)
    let y0 = Swift.min(a.y, b.y)
    return EffectRect(x: x0, y: y0, width: Swift.max(a.x + a.width, b.x + b.width) - x0, height: Swift.max(a.y + a.height, b.y + b.height) - y0)
}

/// The parts of `r` outside `cut`, as up to four rectangles.
private func rectMinus(_ r: EffectRect, _ cut: EffectRect) -> [EffectRect] {
    guard let i = clipRect(r, cut) else { return [r] }
    let parts = [
        EffectRect(x: r.x, y: r.y, width: r.width, height: i.y - r.y),
        EffectRect(x: r.x, y: i.y + i.height, width: r.width, height: r.y + r.height - (i.y + i.height)),
        EffectRect(x: r.x, y: i.y, width: i.x - r.x, height: i.height),
        EffectRect(x: i.x + i.width, y: i.y, width: r.x + r.width - (i.x + i.width), height: i.height),
    ]
    return parts.filter { $0.width > 0 && $0.height > 0 }
}

/// Copies the part `a` of `src` (over `from`) into `dst` (over `to`).
private func pasteMap(_ dst: inout [Float], _ to: EffectRect, _ src: [Float], _ from: EffectRect, _ a: EffectRect) {
    for y in a.y..<(a.y + a.height) {
        let s = (y - from.y) * from.width + (a.x - from.x)
        let d = (y - to.y) * to.width + (a.x - to.x)
        for k in 0..<a.width { dst[d + k] = src[s + k] }
    }
}

/**
 * `prev` brought up to date for a shape over `rect` that differs from the one it was built from only
 * inside `changed` (document rects), or `nil` when a full `buildEffectMaps` is the better deal (the
 * change covers much of the region) or the effects are not local (`effectsAreLocal`). `items` must
 * be the ones `prev` was built with, reaching at most `margin` px, and `shapeOver(r)` returns the new
 * shape over `r`.
 *
 * Every map pixel within `margin` of a change, or outside `prev.rect`, is rebuilt from the shape
 * within `margin` of it (a window of the change grown by twice the margin) and pasted in; the rest
 * is kept. A local map pixel depends only on the shape within the margin and the blur sums exactly,
 * so the result paints exactly what a full build over `rect` would.
 */
public func patchEffectMaps(_ prev: EffectMaps, _ items: [LayerEffect], _ rect: EffectRect, _ changed: [EffectRect], _ margin: Int, _ shapeOver: (EffectRect) -> [Float], _ ctx: EffectContext) -> EffectMaps? {
    if !effectsAreLocal(items) || rectArea(rect) <= 0 { return nil }
    // Map pixels to rebuild: within the margin of a change, and new parts of the region.
    var areas: [EffectRect] = []
    for c in changed { if let a = clipRect(growRect(c, margin), rect) { areas.append(a) } }
    areas.append(contentsOf: rectMinus(rect, prev.rect))
    // One window for areas whose windows overlap.
    var merged = true
    while merged {
        merged = false
        var i = 0
        while i < areas.count && !merged {
            var j = i + 1
            while j < areas.count {
                if clipRect(growRect(areas[i], 2 * margin), areas[j]) != nil {
                    areas[i] = unionRect(areas[i], areas[j])
                    areas.remove(at: j)
                    merged = true
                    break
                }
                j += 1
            }
            i += 1
        }
    }
    let windows = areas.map { clipRect(growRect($0, margin), rect)! }
    if Double(windows.reduce(0) { $0 + rectArea($1) }) > Double(rectArea(rect)) / 2 { return nil }

    let same = rect == prev.rect
    let take = { (v: [Float]) in same ? v : crop(v, prev.rect, rect, 0) }
    var shape = take(prev.shape)
    var per = prev.per.map { $0.map(take) }
    var din = prev.din.map(take)
    var dout = prev.dout.map(take)
    var doutExact = prev.doutExact.map(take)
    for (k, a) in areas.enumerated() {
        let w = windows[k]
        let part = buildEffectMaps(items, shapeOver(w), w, ctx)
        pasteMap(&shape, rect, part.shape, w, a)
        for i in 0..<per.count { for j in 0..<per[i].count { pasteMap(&per[i][j], rect, part.per[i][j], w, a) } }
        if din != nil { pasteMap(&din!, rect, part.din!, w, a) }
        if dout != nil { pasteMap(&dout!, rect, part.dout!, w, a) }
        if doutExact != nil { pasteMap(&doutExact!, rect, part.doutExact!, w, a) }
    }
    var bytes = shape.count * 4
    for maps in per { for m in maps { bytes += m.count * 4 } }
    for d in [din, dout, doutExact] { if let d { bytes += d.count * 4 } }
    return EffectMaps(rect: rect, items: items, bounds: shapeBounds(shape, rect), shape: shape, per: per, bevelPaint: prev.bevelPaint, din: din, dout: dout, doutExact: doutExact, frames: [:], bytes: bytes)
}

// MARK: - Painting

/// Composites straight `src` (alpha `sa`) onto `dst[i..i+3]` with `mode` (the formula `blendTile` uses).
private func compositeAt(_ dst: inout [Float], _ i: Int, _ mode: BlendMode, _ separable: Bool, _ sr: Double, _ sg: Double, _ sb: Double, _ sa: Double) {
    if !(sa > 0) { return }
    let ab = Double(dst[i + 3])
    let ao = sa + ab * (1 - sa)
    if ao <= 0 {
        dst[i] = 0
        dst[i + 1] = 0
        dst[i + 2] = 0
        dst[i + 3] = 0
        return
    }
    let b0 = Double(dst[i])
    let b1 = Double(dst[i + 1])
    let b2 = Double(dst[i + 2])
    if mode == .pigment {
        // Not B(Cb, Cs): the colours mix like paint by amount, `sa / ao` of the source (as blendTile).
        let m = mixPigmentRgb([b0, b1, b2], [sr, sg, sb], sa / ao)
        dst[i] = Float(m[0])
        dst[i + 1] = Float(m[1])
        dst[i + 2] = Float(m[2])
        dst[i + 3] = Float(ao)
        return
    }
    let m0: Double, m1: Double, m2: Double
    if mode == .normal {
        m0 = sr
        m1 = sg
        m2 = sb
    } else if separable {
        m0 = blendChannel(mode, b0, sr)
        m1 = blendChannel(mode, b1, sg)
        m2 = blendChannel(mode, b2, sb)
    } else {
        let m = blendRgb(mode, [b0, b1, b2], [sr, sg, sb])
        m0 = m[0]
        m1 = m[1]
        m2 = m[2]
    }
    let wb = (1 - sa) * ab
    let ws = (1 - ab) * sa
    let wm = sa * ab
    dst[i] = Float((wb * b0 + ws * sr + wm * m0) / ao)
    dst[i + 1] = Float((wb * b1 + ws * sg + wm * m1) / ao)
    dst[i + 2] = Float((wb * b2 + ws * sb + wm * m2) / ao)
    dst[i + 3] = Float(ao)
}

/// Composite `color(i) × coverage` into `dst`. `color` fills `c` with straight RGBA.
private func paint(_ dst: inout [Float], _ m: [Float], _ color: (Int, inout [Double]) -> Void, _ mode: BlendMode, _ opacity: Double) {
    let sep = mode != .normal && isSeparableBlendMode(mode)
    var c = [0.0, 0.0, 0.0, 1.0]
    for i in 0..<m.count {
        let a = Double(m[i]) * opacity
        if !(a > 0) { continue }
        color(i, &c)
        compositeAt(&dst, i * 4, mode, sep, c[0], c[1], c[2], c[3] * JS.min(a, 1))
    }
}

private func rgbOf(_ hex: String) -> [Double] {
    parseEffectColor(hex) ?? [0, 0, 0]
}

private func paintColor(_ dst: inout [Float], _ m: [Float], _ hex: String, _ mode: BlendMode, _ opacity: Double) {
    let rgb = rgbOf(hex)
    paint(&dst, m, { _, c in
        c[0] = rgb[0]
        c[1] = rgb[1]
        c[2] = rgb[2]
        c[3] = 1
    }, mode, opacity)
}

/// Gradient colour + opacity stops prepared for sampling.
private struct PreparedGradient {
    let color: [[Double]]
    let alpha: [[Double]]
    init(_ g: EffectGradient) {
        color = g.stops.enumerated().sorted { $0.element.position != $1.element.position ? $0.element.position < $1.element.position : $0.offset < $1.offset }.map { [$0.element.position] + rgbOf($0.element.color) }
        alpha = (g.opacityStops ?? []).enumerated().sorted { $0.element.position != $1.element.position ? $0.element.position < $1.element.position : $0.offset < $1.offset }.map { [$0.element.position, $0.element.opacity] }
    }
    func sample(_ t: Double, _ out: inout [Double]) {
        let c = color
        if c.isEmpty {
            out[0] = t
            out[1] = t
            out[2] = t
        } else if c.count == 1 || t <= c[0][0] {
            out[0] = c[0][1]
            out[1] = c[0][2]
            out[2] = c[0][3]
        } else {
            var done = false
            for k in 0..<(c.count - 1) {
                let a = c[k]
                let b = c[k + 1]
                if t <= b[0] {
                    let f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0
                    out[0] = a[1] + (b[1] - a[1]) * f
                    out[1] = a[2] + (b[2] - a[2]) * f
                    out[2] = a[3] + (b[3] - a[3]) * f
                    done = true
                    break
                }
            }
            if !done {
                let l = c[c.count - 1]
                out[0] = l[1]
                out[1] = l[2]
                out[2] = l[3]
            }
        }
        let a = alpha
        if a.isEmpty { out[3] = 1 }
        else if a.count == 1 || t <= a[0][0] { out[3] = a[0][1] }
        else {
            out[3] = a[a.count - 1][1]
            for k in 0..<(a.count - 1) where t <= a[k + 1][0] {
                let f = a[k + 1][0] > a[k][0] ? (t - a[k][0]) / (a[k + 1][0] - a[k][0]) : 0
                out[3] = a[k][1] + (a[k + 1][1] - a[k][1]) * f
                break
            }
        }
    }
}

/// Lengths a 100 % gradient at `angle` spans in a `w × h` frame: the chord and the ellipse-norm length.
private func gradientUnits(_ angle: Double, _ w: Double, _ h: Double) -> (Double, Double) {
    let a = (angle * Double.pi) / 180
    let s = JS.sin(a)
    let c = JS.cos(a)
    let len = JS.max((JS.pow(c * w, 2) + JS.pow(s * h, 2)).squareRoot(), 1)
    let chord = JS.max(JS.min(w / JS.max(Swift.abs(c), 1e-6), h / JS.max(Swift.abs(s), 1e-6)), 1)
    return (chord, len)
}

/// Gradient parameter `t` (0..1) at pixel centre `(x, y)` of a gradient laid out in `frame`.
public func gradientT(_ style: GradientStyle, _ angle: Double, _ scale: Double, _ reverse: Bool, _ offset: EffectPoint, _ frame: EffectRect, _ x: Double, _ y: Double) -> Double {
    let w = Double(Swift.max(frame.width, 1))
    let h = Double(Swift.max(frame.height, 1))
    let cx = Double(frame.x) + w / 2 + offset.x * w
    let cy = Double(frame.y) + h / 2 + offset.y * h
    let a = (angle * Double.pi) / 180
    let s = JS.sin(a)
    let c = JS.cos(a)
    let dx = x - cx
    let dy = y - cy
    let along = dx * c - dy * s
    let across = dx * s + dy * c
    var (chord, len) = gradientUnits(angle, w, h)
    chord *= JS.max(scale, 1e-3)
    len *= JS.max(scale, 1e-3)
    let corner = 0.5 * (c - s)
    var t: Double
    switch style {
    case .linear: t = (along - corner) / chord + 0.5
    case .reflected: t = Swift.abs((along - corner) / (chord / 2))
    case .radial: t = (dx * dx + dy * dy).squareRoot() / (len / 2)
    case .diamond: t = (Swift.abs(along) + Swift.abs(across)) / (len / 2)
    case .angle:
        let turn = (a - JS.atan2(-dy, dx)) / (2 * Double.pi)
        t = turn - JS.floor(turn)
    }
    t = clamp01(t)
    return reverse ? 1 - t : t
}

/// Snaps a linear / reflected gradient's end points to the pixel grid, as Photoshop lays effect gradients out.
private func gradientLayout(_ style: GradientStyle, _ angle: Double, _ scale: Double, _ offset: EffectPoint, _ frame: EffectRect) -> (Double, Double, EffectPoint) {
    let unchanged = (angle, scale, offset)
    if (style != .linear && style != .reflected) || ![angle, scale, offset.x, offset.y].allSatisfy(\.isFinite) { return unchanged }
    let w = Double(Swift.max(frame.width, 1))
    let h = Double(Swift.max(frame.height, 1))
    let cx = Double(frame.x) + w / 2 + offset.x * w
    let cy = Double(frame.y) + h / 2 + offset.y * h
    let chordOf = { (r: Double) in JS.max(JS.min(w / JS.max(Swift.abs(JS.cos(r)), 1e-6), h / JS.max(Swift.abs(JS.sin(r)), 1e-6)), 1) }
    let a = (angle * Double.pi) / 180
    let half = (chordOf(a) * JS.max(scale, 1e-3)) / 2
    let dx = JS.cos(a) * half
    let dy = -JS.sin(a) * half
    let snap = { (v: Double) in JS.floor(v + 1e-4) }
    let end = [snap(cx + dx), snap(cy + dy)]
    let start: [Double]
    let mid: [Double]
    if style == .reflected {
        start = [cx, cy]
        mid = [cx, cy]
    } else {
        start = [snap(cx - dx), snap(cy - dy)]
        mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
    }
    let v = [end[0] - start[0], end[1] - start[1]]
    let len = JS.hypot(v[0], v[1])
    if len < 0.5 { return unchanged }
    let a2 = JS.atan2(-v[1], v[0])
    let span = style == .reflected ? 2 * len : len
    return ((a2 * 180) / Double.pi, span / chordOf(a2), EffectPoint(x: offset.x + (mid[0] - cx) / w, y: offset.y + (mid[1] - cy) / h))
}

private struct PaintEnv {
    var rect: EffectRect
    /// Frame gradients align with (the layer's bounds) and the canvas (unaligned gradients).
    var bounds: EffectRect
    var canvas: EffectRect
    var anchor: EffectPoint
    var ctx: EffectContext
}

private func paintGradient(_ dst: inout [Float], _ m: [Float], _ g: EffectGradient, _ frame: EffectRect, _ env: PaintEnv, _ mode: BlendMode, _ opacity: Double) {
    let prepared = PreparedGradient(g)
    let (angle, scale, offset) = gradientLayout(g.style, g.angle, g.scale, g.offset, frame)
    let rx = env.rect.x, ry = env.rect.y, w = env.rect.width
    paint(&dst, m, { i, c in
        prepared.sample(gradientT(g.style, angle, scale, g.reverse, offset, frame, Double(rx + i % w) + 0.5, Double(ry + i / w) + 0.5), &c)
    }, mode, opacity)
}

private func paintPattern(_ dst: inout [Float], _ m: [Float], _ p: EffectPatternRef, _ env: PaintEnv, _ mode: BlendMode, _ opacity: Double) {
    guard let tile = env.ctx.pattern(p.patternId) else { return }
    let place = PatternPlacement(anchor: env.anchor, link: p.link ?? true, phase: p.phase ?? EffectPoint(x: 0, y: 0), scale: p.scale, angle: p.angle ?? 0)
    let rx = env.rect.x, ry = env.rect.y, w = env.rect.width
    var uv = [0.0, 0.0]
    paint(&dst, m, { i, c in
        place.map(Double(rx + i % w) + 0.5, Double(ry + i / w) + 0.5, &uv)
        tile.sample(uv[0], uv[1], &c)
    }, mode, opacity)
}

private func paintFill(_ dst: inout [Float], _ m: [Float], _ f: EffectFill, _ frame: EffectRect, _ env: PaintEnv, _ mode: BlendMode, _ opacity: Double) {
    switch f {
    case .color(let c): paintColor(&dst, m, c, mode, opacity)
    case .gradient(let g): paintGradient(&dst, m, g, g.align ? frame : env.canvas, env, mode, opacity)
    case .pattern(let p): paintPattern(&dst, m, p, env, mode, opacity)
    }
}

/**
 * The colours an effect fill paints over `rect`, as straight float RGBA (0..1, `width × height`
 * pixels, row by row): a solid colour, a gradient laid out in `frame` (when aligned with the layer)
 * or `canvas`, or a pattern tiled from `anchor` (when linked). Shape layers paint with it, so their
 * fills and strokes match the overlays of layer effects.
 */
public func effectFillColors(_ fill: EffectFill, _ rect: EffectRect, _ frame: EffectRect, _ canvas: EffectRect, _ anchor: EffectPoint, _ ctx: EffectContext) -> [Float] {
    let n = rect.width * rect.height
    var out = [Float](repeating: 0, count: n * 4)
    var c = [0.0, 0.0, 0.0, 1.0]
    let rx = rect.x, ry = rect.y, w = rect.width
    switch fill {
    case .color(let hex):
        let rgb = rgbOf(hex)
        for i in 0..<n {
            out[i * 4] = Float(rgb[0])
            out[i * 4 + 1] = Float(rgb[1])
            out[i * 4 + 2] = Float(rgb[2])
            out[i * 4 + 3] = 1
        }
        return out
    case .gradient(let gr):
        let f = gr.align ? frame : canvas
        let prepared = PreparedGradient(gr)
        let (angle, scale, offset) = gradientLayout(gr.style, gr.angle, gr.scale, gr.offset, f)
        for i in 0..<n {
            prepared.sample(gradientT(gr.style, angle, scale, gr.reverse, offset, f, Double(rx + i % w) + 0.5, Double(ry + i / w) + 0.5), &c)
            for k in 0..<4 { out[i * 4 + k] = Float(c[k]) }
        }
        return out
    case .pattern(let p):
        guard let tile = ctx.pattern(p.patternId) else { return out }
        let place = PatternPlacement(anchor: anchor, link: p.link ?? true, phase: p.phase ?? EffectPoint(x: 0, y: 0), scale: p.scale, angle: p.angle ?? 0)
        var uv = [0.0, 0.0]
        for i in 0..<n {
            place.map(Double(rx + i % w) + 0.5, Double(ry + i / w) + 0.5, &uv)
            tile.sample(uv[0], uv[1], &c)
            for k in 0..<4 { out[i * 4 + k] = Float(c[k]) }
        }
        return out
    }
}

private struct GlowPaint {
    var fill: EffectFill
    var range: Double
    var blend: BlendMode
    var opacity: Double
}

/// A glow's paint: a gradient runs along the glow (colour at `1 − v`), opaque from strength `range²`.
private func paintGlow(_ dst: inout [Float], _ m: [Float], _ g: GlowPaint, _ env: PaintEnv) {
    if case .color(let c) = g.fill { return paintColor(&dst, m, c, g.blend, g.opacity) }
    guard case .gradient(let gradient) = g.fill else { return }
    let prepared = PreparedGradient(gradient)
    let r = g.range.isFinite ? clamp(g.range, 0.01, 1) : 1
    let gain = 1 / (r * r)
    let strength = m.map { Float(JS.min(Double($0) * gain, 1)) }
    paint(&dst, strength, { i, c in prepared.sample(1 - clamp01(Double(m[i])), &c) }, g.blend, g.opacity)
}

/// Crops `v` (over `from`) to `to`, filling outside with `fill`.
private func crop(_ v: [Float], _ from: EffectRect, _ to: EffectRect, _ fill: Double) -> [Float] {
    var out = [Float](repeating: Float(fill), count: to.width * to.height)
    let ix0 = Swift.max(from.x, to.x)
    let iy0 = Swift.max(from.y, to.y)
    let ix1 = Swift.min(from.x + from.width, to.x + to.width)
    let iy1 = Swift.min(from.y + from.height, to.y + to.height)
    if ix1 <= ix0 || iy1 <= iy0 { return out }
    let n = ix1 - ix0
    for y in iy0..<iy1 {
        let s = (y - from.y) * from.width + (ix0 - from.x)
        let d = (y - to.y) * to.width + (ix0 - to.x)
        for k in 0..<n { out[d + k] = v[s + k] }
    }
    return out
}

/// Straight RGBA samples: bytes, or (high bit depth) floats 0..1 sRGB-encoded.
public enum EffectSamples {
    case bytes([UInt8])
    case floats([Float])

    public var bytes: [UInt8]? { if case .bytes(let b) = self { return b }; return nil }
    public var floats: [Float]? { if case .floats(let f) = self { return f }; return nil }
}

public struct EffectCompositeInput {
    /**
     * The accumulator (straight RGBA over `rect`); receives the layer and its effects. Bytes, or
     * (high bit depth) floats 0..1 sRGB-encoded, written back unrounded.
     */
    public var backdrop: EffectSamples
    /// The layer's pixels over `rect` (straight RGBA, mask applied to alpha, clipped layers applied); bytes or floats 0..1 as `backdrop`.
    public var content: EffectSamples
    public var rect: EffectRect
    public var maps: EffectMaps
    public var blend: BlendMode
    /// Layer opacity: the whole stack.
    public var opacity: Double
    /// Fill opacity: the layer's own pixels only.
    public var fillOpacity: Double
    /// The canvas (unaligned gradients span it).
    public var canvas: EffectRect
    public var ctx: EffectContext

    public init(backdrop: EffectSamples, content: EffectSamples, rect: EffectRect, maps: EffectMaps, blend: BlendMode, opacity: Double, fillOpacity: Double, canvas: EffectRect, ctx: EffectContext) {
        self.backdrop = backdrop
        self.content = content
        self.rect = rect
        self.maps = maps
        self.blend = blend
        self.opacity = opacity
        self.fillOpacity = fillOpacity
        self.canvas = canvas
        self.ctx = ctx
    }
}

/// Composites a layer's content and its effects onto `input.backdrop` in place (see the module comment for the order).
public func compositeLayerEffects(_ input: inout EffectCompositeInput) {
    let rect = input.rect
    let maps = input.maps
    let ctx = input.ctx
    let items = maps.items
    let n = rect.width * rect.height
    // Floats (16 / 32 bits) are already 0..1; bytes scale by 1/255.
    let cs = 1.0 / 255
    let content: (Int) -> Double
    switch input.content {
    case .bytes(let b): content = { Double(b[$0]) * cs }
    case .floats(let f): content = { Double(f[$0]) }
    }
    var shape = [Float](repeating: 0, count: n)
    for i in 0..<n { shape[i] = Float(content(i * 4 + 3)) }
    var before = [Float](repeating: 0, count: n * 4)
    switch input.backdrop {
    case .bytes(let b): for i in 0..<(n * 4) { before[i] = Float(Double(b[i]) * cs) }
    case .floats(let f): for i in 0..<(n * 4) { before[i] = f[i] }
    }
    var work = before
    let fx = { (i: Int, k: Int) in crop(maps.per[i][k], maps.rect, rect, 0) }
    let bounds = maps.bounds ?? rect
    let env = PaintEnv(rect: rect, bounds: bounds, canvas: input.canvas, anchor: EffectPoint(x: Double(bounds.x), y: Double(bounds.y)), ctx: ctx)
    let fill = clamp01(input.fillOpacity)
    let inside = { (a: Float) in Double(a) > INSIDE_EPS }
    // The first listed instance of a kind is on top: paint in reverse.
    let rev = Array((0..<items.count).reversed())

    let knockOut = { (m: inout [Float], fillOpacity: Double) in
        let seeThrough = 1 - clamp01(fillOpacity)
        for i in 0..<n { m[i] = Float(Double(m[i]) * (1 - Double(shape[i]) * seeThrough)) }
    }
    let normalLike = input.blend == .normal
    for i in rev {
        guard case .dropShadow(let e) = items[i] else { continue }
        var m = fx(i, 0)
        // The layer hides the shadow beneath its see-through fill, and wholly in a mode that blends with it.
        if e.knocksOut { knockOut(&m, normalLike ? fill : 0) }
        paintColor(&work, m, e.color, e.blend, e.opacity)
    }
    for i in rev {
        guard case .outerGlow(let e) = items[i] else { continue }
        var m = fx(i, 0)
        knockOut(&m, fill)
        paintGlow(&work, m, GlowPaint(fill: e.fill, range: e.range, blend: e.blend, opacity: e.opacity), env)
    }

    // The layer: content at fill opacity, then the interior effects, relative to the shape.
    var lay = [Float](repeating: 0, count: n * 4)
    for i in 0..<n {
        lay[i * 4] = Float(content(i * 4))
        lay[i * 4 + 1] = Float(content(i * 4 + 1))
        lay[i * 4 + 2] = Float(content(i * 4 + 2))
        lay[i * 4 + 3] = inside(shape[i]) ? Float(fill) : 0
    }
    let premerge = !normalLike
    if premerge {
        let sep = isSeparableBlendMode(input.blend)
        for i in 0..<n {
            let p = i * 4
            let sr = Double(lay[p]), sg = Double(lay[p + 1]), sb = Double(lay[p + 2]), sa = Double(lay[p + 3])
            lay[p] = work[p]
            lay[p + 1] = work[p + 1]
            lay[p + 2] = work[p + 2]
            lay[p + 3] = work[p + 3]
            compositeAt(&lay, p, input.blend, sep, sr, sg, sb, sa)
        }
    }
    let rel = { (m: [Float]) -> [Float] in
        var m = m
        for i in 0..<n { m[i] = inside(shape[i]) ? Float(JS.min(Double(m[i]) / Double(shape[i]), 1)) : 0 }
        return m
    }
    let full = shape.map { inside($0) ? Float(1) : 0 }
    for i in rev { if case .patternOverlay(let e) = items[i] { paintPattern(&lay, full, e.pattern, env, e.blend, e.opacity) } }
    for i in rev { if case .gradientOverlay(let e) = items[i] { paintGradient(&lay, full, e.gradient, e.gradient.align ? bounds : input.canvas, env, e.blend, e.opacity) } }
    for i in rev { if case .colorOverlay(let e) = items[i] { paintColor(&lay, full, e.color, e.blend, e.opacity) } }
    for i in rev { if case .satin(let e) = items[i] { paintColor(&lay, rel(fx(i, 0)), e.color, e.blend, e.opacity) } }
    for i in rev { if case .innerGlow(let e) = items[i] { paintGlow(&lay, rel(fx(i, 0)), GlowPaint(fill: e.fill, range: e.range, blend: e.blend, opacity: e.opacity), env) } }
    for i in rev { if case .innerShadow(let e) = items[i] { paintColor(&lay, rel(fx(i, 0)), e.color, e.blend, e.opacity) } }
    // Strokes: inside parts over the layer (bottom instance first).
    let strokeIdx = items.indices.filter { if case .stroke = items[$0] { return true }; return false }
    let din = !strokeIdx.isEmpty ? maps.din.map { crop($0, maps.rect, rect, 0) } : nil
    let frameOf = { (i: Int) in maps.frames[i] ?? bounds }
    for k in strokeIdx.indices.reversed() {
        guard case .stroke(let st) = items[strokeIdx[k]] else { continue }
        let inW = strokeWidths(st).0
        guard inW > 0, let din else { continue }
        var m = [Float](repeating: 0, count: n)
        for i in 0..<n { m[i] = inside(shape[i]) ? Float(clamp01(inW + 0.5 - Double(din[i]))) : 0 }
        paintFill(&lay, m, st.fill, frameOf(strokeIdx[k]), env, st.blend, st.opacity)
    }
    for i in rev {
        guard case .bevelEmboss(let e) = items[i], maps.bevelPaint[i] == .inner else { continue }
        paintColor(&lay, rel(fx(i, 0)), e.highlightColor, e.highlightBlend, e.highlightOpacity)
        paintColor(&lay, rel(fx(i, 1)), e.shadowColor, e.shadowBlend, e.shadowOpacity)
    }
    // The shape's own alpha.
    for i in 0..<n { lay[i * 4 + 3] = Float(Double(lay[i * 4 + 3]) * JS.min(Double(shape[i]), 1)) }

    // Outside parts of strokes lie beneath the layer; a higher stroke covers the ones below it.
    let outside = strokeIdx.filter { if case .stroke(let st) = items[$0] { return strokeWidths(st).1 > 0 }; return false }
    if !outside.isEmpty {
        let dout = maps.dout.map { crop($0, maps.rect, rect, FAR) }
        let doutExact = maps.doutExact.map { crop($0, maps.rect, rect, FAR) }
        let base = work
        var acc = [Float](repeating: 0, count: n * 4)
        var cover = [Float](repeating: 0, count: n)
        for si in outside {
            guard case .stroke(let st) = items[si] else { continue }
            let outW = strokeWidths(st).1
            let d = (outW >= STROKE_CHAMFER_MAX ? doutExact : dout) ?? [Float](repeating: Float(FAR), count: n)
            var share = [Float](repeating: 0, count: n)
            var ones = [Float](repeating: 0, count: n)
            for i in 0..<n {
                let band = clamp01(outW + 0.5 - Double(d[i]))
                let k: Double
                if inside(shape[i]) {
                    // Beneath the layer the stroke shows only through the part of the pixel the shape leaves.
                    let c = clamp01(Double(lay[i * 4 + 3]))
                    k = c >= 1 ? 1 : clamp01((1 - clamp01(Double(shape[i]))) / (1 - c))
                } else {
                    k = band
                }
                share[i] = Float(k * st.opacity * (1 - Double(cover[i])))
                cover[i] = Float(Double(cover[i]) + Double(share[i]))
                ones[i] = share[i] > 0 ? 1 : 0
            }
            var blended = base
            paintFill(&blended, ones, st.fill, frameOf(si), env, st.blend, 1)
            for i in 0..<n {
                let s = Double(share[i])
                if !(s > 0) { continue }
                let p = i * 4
                let ba = Double(blended[p + 3])
                acc[p] = Float(Double(acc[p]) + s * Double(blended[p]) * ba)
                acc[p + 1] = Float(Double(acc[p + 1]) + s * Double(blended[p + 1]) * ba)
                acc[p + 2] = Float(Double(acc[p + 2]) + s * Double(blended[p + 2]) * ba)
                acc[p + 3] = Float(Double(acc[p + 3]) + s * ba)
            }
        }
        for i in 0..<n {
            let c = Double(cover[i])
            if c <= 0 { continue }
            let p = i * 4
            let k = 1 - JS.min(c, 1)
            let a = Double(work[p + 3]) * k + Double(acc[p + 3])
            if a > 0 {
                work[p] = Float((Double(work[p]) * Double(work[p + 3]) * k + Double(acc[p])) / a)
                work[p + 1] = Float((Double(work[p + 1]) * Double(work[p + 3]) * k + Double(acc[p + 1])) / a)
                work[p + 2] = Float((Double(work[p + 2]) * Double(work[p + 3]) * k + Double(acc[p + 2])) / a)
                work[p + 3] = Float(JS.min(a, 1))
            }
        }
    }
    for i in rev {
        guard case .bevelEmboss(let e) = items[i], maps.bevelPaint[i] == .outer else { continue }
        paintColor(&work, fx(i, 0), e.highlightColor, e.highlightBlend, e.highlightOpacity)
        paintColor(&work, fx(i, 1), e.shadowColor, e.shadowBlend, e.shadowOpacity)
    }
    // The layer (with its interior effects) onto the exterior result.
    let mode: BlendMode = premerge ? .normal : input.blend
    let sep = isSeparableBlendMode(mode)
    for i in 0..<n {
        let p = i * 4
        if lay[p + 3] > 0 { compositeAt(&work, p, mode, sep, Double(lay[p]), Double(lay[p + 1]), Double(lay[p + 2]), Double(lay[p + 3])) }
    }
    // Emboss styles shade the composited result.
    for i in rev {
        guard case .bevelEmboss(let e) = items[i], maps.bevelPaint[i] == .both else { continue }
        paintColor(&work, fx(i, 0), e.highlightColor, e.highlightBlend, e.highlightOpacity)
        paintColor(&work, fx(i, 1), e.shadowColor, e.shadowBlend, e.shadowOpacity)
    }
    // Layer opacity applies to the whole stack (premultiplied mix with what was there).
    let op = clamp01(input.opacity)
    switch input.backdrop {
    case .floats(var out):
        for i in 0..<n {
            let p = i * 4
            let aa = Double(before[p + 3])
            let ba = Double(work[p + 3])
            let alpha = aa + (ba - aa) * op
            if alpha <= 0 {
                for c in 0..<4 { out[p + c] = 0 }
                continue
            }
            for c in 0..<3 { out[p + c] = Float((Double(before[p + c]) * aa + (Double(work[p + c]) * ba - Double(before[p + c]) * aa) * op) / alpha) }
            out[p + 3] = Float(alpha)
        }
        input.backdrop = .floats(out)
    case .bytes(var out):
        for i in 0..<n {
            let p = i * 4
            let aa = Double(before[p + 3])
            let ba = Double(work[p + 3])
            let alpha = aa + (ba - aa) * op
            if alpha <= 0 {
                for c in 0..<4 { out[p + c] = 0 }
                continue
            }
            for c in 0..<3 { out[p + c] = JS.u8c(JS.round(((Double(before[p + c]) * aa + (Double(work[p + c]) * ba - Double(before[p + c]) * aa) * op) / alpha) * 255)) }
            out[p + 3] = JS.u8c(JS.round(alpha * 255))
        }
        input.backdrop = .bytes(out)
    }
}

/**
 * Renders one layer with its effects over a whole region in one pass (no tiles): the reference
 * the per-tile compositor is checked against, and a convenience for one-off renders.
 */
public func renderLayerEffects(_ effects: LayerEffects, content: [UInt8], rect: EffectRect, blend: BlendMode, opacity: Double, fillOpacity: Double? = nil, backdrop: inout [UInt8], canvas: EffectRect, ctx: EffectContext) {
    let items = activeEffectItems(effects)
    let n = rect.width * rect.height
    var shape = [Float](repeating: 0, count: n)
    for i in 0..<n { shape[i] = Float(Double(content[i * 4 + 3]) / 255) }
    let maps = buildEffectMaps(items, shape, rect, ctx)
    var input = EffectCompositeInput(backdrop: .bytes(backdrop), content: .bytes(content), rect: rect, maps: maps, blend: blend, opacity: opacity, fillOpacity: fillOpacity ?? 1, canvas: canvas, ctx: ctx)
    compositeLayerEffects(&input)
    backdrop = input.backdrop.bytes!
}
