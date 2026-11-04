import Foundation
import PixerateRaster

/**
 * Blending tools on raster tiles, dab by dab (`paint/blending.ts`):
 *
 * - **Blender** (`blenderDab`): every pixel under the tip moves towards the mix of the paint
 *   within `distance` of it, so neighbouring colours run together (through the pigment model by
 *   default, so blue next to yellow blends into green).
 * - **Smudge** (`SmudgeTip`): a finger that carries a patch of paint, lays it over the pixels under
 *   the tip and picks up some of the paint that was there.
 *
 * Both blend alpha too. A transparency-locked layer keeps its alpha. Pure data in, pixels out.
 */

/// Blender options.
public struct BlenderSettings: Equatable, Sendable {
    public var strength: Double
    public var distance: Double
    public var mixing: String
}

public let DEFAULT_BLENDER = BlenderSettings(strength: 0.5, distance: 0.35, mixing: "pigment")

/// Smudge options.
public struct SmudgeSettings: Equatable, Sendable {
    public var strength: Double
    public var length: Double
    public var mixing: String
}

public let DEFAULT_SMUDGE = SmudgeSettings(strength: 0.7, length: 0.85, mixing: "rgb")

/// The neighbourhood radius in pixels of a blender dab of `radius`.
public func blendRadius(_ settings: BlenderSettings, _ radius: Double) -> Int {
    Swift.max(1, Int(JS.round(settings.distance * 2 * radius)))
}

/// Reusable buffers for `blenderDab` (one per stroke).
public final class BlenderScratch {
    var sums: [Double] = []
    let mix: Pigment = createPigment([0, 0, 0])
    var out = [0.0, 0.0, 0.0]
    public init() {
        mix.strength = 1
        mix.scatter = 1
        mix.ks = [Float](repeating: 0, count: PIGMENT_BANDS)
    }
}

/**
 * One blender dab: `cov` is the tip's coverage over `rect` (document space, 0..1), `opacity` the
 * dab's (pressure) opacity, `radius` its radius in pixels. Reads the neighbourhood as it was
 * before the dab, then writes every covered pixel.
 */
public func blenderDab(_ medium: TileMedium, _ rect: RasterRect, _ cov: [Float], _ opacity: Double, _ radius: Double, _ settings: BlenderSettings, _ scratch: BlenderScratch) {
    let N = PIGMENT_BANDS
    let R = blendRadius(settings, radius)
    let W = rect.width + 2 * R
    let H = rect.height + 2 * R
    let pigment = settings.mixing == "pigment"
    // Channels per pixel: pigment: S·a·K/S per band, S·a, a; rgb: r·a, g·a, b·a, a.
    let C = pigment ? N + 2 : 4
    let stride = (W + 1) * C
    let size = stride * (H + 1)
    if scratch.sums.count < size { scratch.sums = [Double](repeating: 0, count: size) }
    for k in 0..<size { scratch.sums[k] = 0 }
    medium.reset()
    // Summed-area table over the region (row 0 and column 0 stay zero).
    var row = [Double](repeating: 0, count: C)
    scratch.sums.withUnsafeMutableBufferPointer { I in
        for y in 0..<H {
            for c in 0..<C { row[c] = 0 }
            let dy = rect.y - R + y
            for x in 0..<W {
                let dx = rect.x - R + x
                let i = medium.locate(dx, dy, false)
                if i >= 0 {
                    let px = medium.pixels.data
                    let a = Double(px[i + 3]) / 255
                    if a > 0 {
                        if pigment {
                            let p = pigment8(Int(px[i]), Int(px[i + 1]), Int(px[i + 2]))
                            let sa = p.scatter * p.strength * a
                            for k in 0..<N { row[k] += sa * Double(p.ks[k]) }
                            row[N] += sa
                            row[N + 1] += a
                        } else {
                            row[0] += (Double(px[i]) / 255) * a
                            row[1] += (Double(px[i + 1]) / 255) * a
                            row[2] += (Double(px[i + 2]) / 255) * a
                            row[3] += a
                        }
                    }
                }
                let o = (y + 1) * stride + (x + 1) * C
                let up = y * stride + (x + 1) * C
                for c in 0..<C { I[o + c] = I[up + c] + row[c] }
            }
        }
    }
    let area = Double((2 * R + 1) * (2 * R + 1))
    let strength = settings.strength * opacity
    let lock = medium.target.lockTransparency
    let mixPig = scratch.mix
    let I = scratch.sums
    func sum(_ c: Int, _ x1: Int, _ y1: Int, _ x2: Int, _ y2: Int) -> Double {
        I[y2 * stride + x2 * C + c] - I[y1 * stride + x2 * C + c] - I[y2 * stride + x1 * C + c] + I[y1 * stride + x1 * C + c]
    }
    let w = rect.width
    medium.reset()
    for yy in 0..<rect.height {
        for xx in 0..<w {
            let k = Double(cov[yy * w + xx])
            if k <= 0 { continue }
            let dx = rect.x + xx
            let dy = rect.y + yy
            var t = strength * k * medium.selectionAt(dx, dy)
            if t <= 0 { continue }
            if t > 1 { t = 1 }
            let x1 = xx, y1 = yy, x2 = xx + 2 * R + 1, y2 = yy + 2 * R + 1
            let asum = sum(pigment ? N + 1 : 3, x1, y1, x2, y2)
            let ri = medium.locate(dx, dy, false)
            let a = ri < 0 ? 0 : Double(medium.pixels.data[ri + 3]) / 255
            if lock && a <= 0 { continue }
            let avgA = asum / area
            let na = lock ? a : (1 - t) * a + t * avgA
            if asum <= 1e-9 {
                // Only bare canvas nearby: the paint thins out (edges soften).
                if lock || a <= 0 { continue }
                let i = medium.locate(dx, dy, true)
                put255(medium.pixels, i + 3, na)
                continue
            }
            // The neighbourhood's share of the paint in the result.
            let share = lock ? t : na > 0 ? (t * avgA) / na : 1
            let i = medium.locate(dx, dy, true)
            let px = medium.pixels
            if pigment {
                let sa = sum(N, x1, y1, x2, y2)
                for c in 0..<N { mixPig.ks[c] = Float(sum(c, x1, y1, x2, y2) / sa) }
                mixPig.scatter = sa / asum
                if a <= 0 || share >= 1 { lerpPigmentInto(mixPig, mixPig, 0, &scratch.out, 0) } else { lerpPigmentInto(pigment8(Int(px.data[i]), Int(px.data[i + 1]), Int(px.data[i + 2])), mixPig, share, &scratch.out, 0) }
            } else {
                for c in 0..<3 {
                    let m = sum(c, x1, y1, x2, y2) / asum
                    let cur = Double(px.data[i + c]) / 255
                    scratch.out[c] = a <= 0 || share >= 1 ? m : cur + (m - cur) * share
                }
            }
            put255(px, i, scratch.out[0])
            put255(px, i + 1, scratch.out[1])
            put255(px, i + 2, scratch.out[2])
            if !lock { put255(px, i + 3, na) }
        }
    }
}

/// A dab as the smudge needs it: centre, radius (px) and pressure opacity.
public struct SmudgeDab {
    public var x: Double
    public var y: Double
    public var radius: Double
    public var opacity: Double
}

/**
 * A smudging finger: carries a patch of paint (straight RGBA, `size × size` cells over the tip,
 * in canvas orientation) from dab to dab. The first dab only picks the patch up.
 */
public final class SmudgeTip {
    public let settings: SmudgeSettings
    private let size: Int
    private var patch: [Float]
    private var loaded = false
    private var out = [0.0, 0.0, 0.0]

    /// `diameter`: the largest tip diameter of the stroke, in pixels (the patch resolution).
    public init(_ settings: SmudgeSettings, _ diameter: Double) {
        self.settings = settings
        size = Swift.max(2, Swift.min(512, Int(JS.ceil(diameter))))
        patch = [Float](repeating: 0, count: size * size * 4)
    }

    private func cell(_ d: SmudgeDab, _ px: Double, _ py: Double) -> Int {
        let s = size
        let r = Swift.max(0.5, d.radius)
        let bx = Swift.min(s - 1, Swift.max(0, Int(JS.floor((((px - d.x) / r + 1) / 2) * Double(s)))))
        let by = Swift.min(s - 1, Swift.max(0, Int(JS.floor((((py - d.y) / r + 1) / 2) * Double(s)))))
        return (by * s + bx) * 4
    }

    /// Fills the patch from the pixels under the dab.
    private func load(_ medium: TileMedium, _ d: SmudgeDab) {
        let s = size
        let r = Swift.max(0.5, d.radius)
        medium.reset()
        for by in 0..<s {
            for bx in 0..<s {
                let dx = Int(JS.floor(d.x + (((Double(bx) + 0.5) / Double(s)) * 2 - 1) * r))
                let dy = Int(JS.floor(d.y + (((Double(by) + 0.5) / Double(s)) * 2 - 1) * r))
                let i = medium.locate(dx, dy, false)
                let c = (by * s + bx) * 4
                if i < 0 {
                    for k in c..<(c + 4) { patch[k] = 0 }
                    continue
                }
                let px = medium.pixels.data
                patch[c] = Float(Double(px[i]) / 255)
                patch[c + 1] = Float(Double(px[i + 1]) / 255)
                patch[c + 2] = Float(Double(px[i + 2]) / 255)
                patch[c + 3] = Float(Double(px[i + 3]) / 255)
            }
        }
        loaded = true
    }

    /// `a` mixed `t` of the way to `b` (both 0..1).
    private func mix(_ a0: Double, _ a1: Double, _ a2: Double, _ b0: Double, _ b1: Double, _ b2: Double, _ t: Double) -> [Double] {
        if settings.mixing == "pigment" {
            mixPigment8(Int(JS.round(a0 * 255)), Int(JS.round(a1 * 255)), Int(JS.round(a2 * 255)), Int(JS.round(b0 * 255)), Int(JS.round(b1 * 255)), Int(JS.round(b2 * 255)), t, &out)
        } else {
            out[0] = a0 + (b0 - a0) * t
            out[1] = a1 + (b1 - a1) * t
            out[2] = a2 + (b2 - a2) * t
        }
        return out
    }

    /// One dab: lays the carried patch over the tip's footprint (`cov` over `rect`), then picks up.
    public func dab(_ medium: TileMedium, _ d: SmudgeDab, _ rect: RasterRect, _ cov: [Float]) {
        if !loaded {
            load(medium, d)
            return
        }
        let strength = settings.strength, length = settings.length
        let lock = medium.target.lockTransparency
        let w = rect.width
        medium.reset()
        for yy in 0..<rect.height {
            for xx in 0..<w {
                let cv = Double(cov[yy * w + xx])
                if cv <= 0 { continue }
                let dx = rect.x + xx
                let dy = rect.y + yy
                var k = strength * cv * d.opacity * medium.selectionAt(dx, dy)
                if k <= 0 { continue }
                if k > 1 { k = 1 }
                let c = cell(d, Double(dx) + 0.5, Double(dy) + 0.5)
                let ba = Double(patch[c + 3])
                let ri = medium.locate(dx, dy, false)
                let a = ri < 0 ? 0 : Double(medium.pixels.data[ri + 3]) / 255
                if lock && a <= 0 { continue }
                // The pixel as it was: what the finger lays paint over, and what it picks up afterwards.
                let px0 = ri >= 0 ? medium.pixels.data : nil
                let o0 = px0 != nil ? Double(px0![ri]) / 255 : 0
                let o1 = px0 != nil ? Double(px0![ri + 1]) / 255 : 0
                let o2 = px0 != nil ? Double(px0![ri + 2]) / 255 : 0
                if a > 0 || ba > 0 {
                    let na = lock ? a : a + (ba - a) * k
                    let share = lock ? k * ba : na > 0 ? (k * ba) / na : 0
                    var r = o0, g = o1, b = o2
                    if a <= 0 || share >= 1 {
                        r = Double(patch[c])
                        g = Double(patch[c + 1])
                        b = Double(patch[c + 2])
                    } else if share > 0 {
                        let m = mix(o0, o1, o2, Double(patch[c]), Double(patch[c + 1]), Double(patch[c + 2]), share)
                        r = m[0]
                        g = m[1]
                        b = m[2]
                    }
                    let i = medium.locate(dx, dy, true)
                    let out = medium.pixels
                    put255(out, i, r)
                    put255(out, i + 1, g)
                    put255(out, i + 2, b)
                    put255(out, i + 3, na)
                }
                // Pick up: the patch takes `1 − length` of the paint that was under it (alpha-weighted).
                let pick = (1 - length) * Swift.min(1, cv * d.opacity)
                if pick > 0 {
                    let pa = ba + (a - ba) * pick
                    let s = pa > 0 ? (a * pick) / pa : 0
                    if s > 0 {
                        let m = ba <= 0 || s >= 1 ? [o0, o1, o2] : mix(Double(patch[c]), Double(patch[c + 1]), Double(patch[c + 2]), o0, o1, o2, s)
                        patch[c] = Float(m[0])
                        patch[c + 1] = Float(m[1])
                        patch[c + 2] = Float(m[2])
                    }
                    patch[c + 3] = Float(pa)
                }
            }
        }
    }
}
