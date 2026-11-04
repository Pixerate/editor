// Portions ported from photocraft/crates/algo/src/selection_blur.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import Foundation

/// Separable Gaussian blur of single-channel float planes (mask feather, selection feather). The
/// port of `raster/blur.ts`; planes are `Float` (the TS `Float32Array`).

/// Normalised Gaussian kernel of σ, truncated at ⌈3σ⌉.
private func gaussianKernel(_ sigma: Double) -> [Float] {
    let r = Int(JS.ceil(sigma * 3))
    var k = [Float](repeating: 0, count: 2 * r + 1)
    var s = 0.0
    for i in -r...r {
        let v = JS.exp(-Double(i * i) / (2 * sigma * sigma))
        k[i + r] = Float(v)
        s += v
    }
    for i in 0..<k.count { k[i] = Float(Double(k[i]) / s) }
    return k
}

/// Above this σ a Gaussian is approximated by three box passes (cost independent of σ).
public let DIRECT_GAUSSIAN_MAX_SIGMA = 8.0

/// Box sizes of three passes whose combined variance matches σ² (Kovesi).
private func boxRadii(_ sigma: Double) -> [Int] {
    let n = 3.0
    let wIdeal = ((12 * sigma * sigma) / n + 1).squareRoot()
    var wl = Int(JS.floor(wIdeal))
    if wl % 2 == 0 { wl -= 1 }
    let wu = wl + 2
    let wld = Double(wl)
    let mIdeal = (12 * sigma * sigma - n * wld * wld - 4 * n * wld - 3 * n) / (-4 * wld - 4)
    let m = JS.round(mIdeal)
    return [0, 1, 2].map { i in ((Double(i) < m ? wl : wu) - 1) / 2 }
}

/// How a blur treats pixels beyond the image: `zero`, or `clamp` (replicate the border).
public enum BlurEdge: String, Sendable {
    case zero
    case clamp
}

private func convolveLine(_ src: [Float], _ off: Int, _ stride: Int, _ len: Int, _ k: [Float], _ edge: BlurEdge, _ dst: inout [Float]) {
    let r = (k.count - 1) / 2
    for i in 0..<len {
        var a = 0.0
        let lo = i - r
        for j in 0..<k.count {
            var x = lo + j
            if x < 0 || x >= len {
                if edge == .zero { continue }
                x = x < 0 ? 0 : len - 1
            }
            a += Double(src[off + x * stride]) * Double(k[j])
        }
        dst[i] = Float(a)
    }
}

/**
 * Three box passes along one line, run on the line padded by the passes' total reach (zeros or
 * replicated ends), so the result equals one convolution with the combined kernel over the
 * same outside values — clipping between passes would lose the mass that spilled out.
 */
private func boxesLine(_ src: [Float], _ off: Int, _ stride: Int, _ len: Int, _ radii: [Int], _ edge: BlurEdge, _ a: inout [Float], _ b: inout [Float], _ dst: inout [Float]) {
    let pad = radii.reduce(0, +)
    let plen = len + 2 * pad
    for i in 0..<plen {
        let j = i - pad
        a[i] = j < 0 ? (edge == .zero ? 0 : src[off]) : j >= len ? (edge == .zero ? 0 : src[off + (len - 1) * stride]) : src[off + j * stride]
    }
    var fromA = true
    for r in radii {
        // Window clipped to the padded line; the padding is wide enough that the clip never
        // reaches the part that is kept.
        func pass(_ from: [Float], _ to: inout [Float]) {
            var sum = 0.0
            for i in 0...Swift.min(r, plen - 1) { sum += Double(from[i]) }
            let k = Double(2 * r + 1)
            for i in 0..<plen {
                to[i] = Float(sum / k)
                let add = i + r + 1
                let drop = i - r
                if add < plen { sum += Double(from[add]) }
                if drop >= 0 { sum -= Double(from[drop]) }
            }
        }
        if fromA { pass(a, &b) } else { pass(b, &a) }
        fromA.toggle()
    }
    let from = fromA ? a : b
    for i in 0..<len { dst[i] = from[i + pad] }
}

/**
 * Separable Gaussian blur of a single-channel float image. `edge` `zero` treats pixels beyond
 * the image as 0 (selection feather), `clamp` replicates the border (mask refinement). σ up to
 * `DIRECT_GAUSSIAN_MAX_SIGMA` is convolved directly; wider blurs use three box passes, so the
 * cost per pixel never grows with σ.
 */
public func gaussianBlur(_ src: [Float], _ w: Int, _ h: Int, _ sigma: Double, _ edge: BlurEdge = .zero) -> [Float] {
    var out = src
    if !(sigma >= 0.1) || w <= 0 || h <= 0 { return out }
    // Far beyond the image a wider blur changes nothing but cost.
    let s = JS.min(sigma, Double(4 * Swift.max(w, h)))
    var line = [Float](repeating: 0, count: Swift.max(w, h))
    let pass: (_ buf: [Float], _ off: Int, _ stride: Int, _ len: Int, _ line: inout [Float]) -> Void
    if s <= DIRECT_GAUSSIAN_MAX_SIGMA {
        let k = gaussianKernel(s)
        pass = { buf, off, stride, len, line in convolveLine(buf, off, stride, len, k, edge, &line) }
    } else {
        let radii = boxRadii(s)
        let plen = Swift.max(w, h) + 2 * radii.reduce(0, +)
        var a = [Float](repeating: 0, count: plen)
        var b = [Float](repeating: 0, count: plen)
        pass = { buf, off, stride, len, line in boxesLine(buf, off, stride, len, radii, edge, &a, &b, &line) }
    }
    for y in 0..<h {
        pass(out, y * w, 1, w, &line)
        for x in 0..<w { out[y * w + x] = line[x] }
    }
    for x in 0..<w {
        pass(out, x, w, h, &line)
        for y in 0..<h { out[y * w + x] = line[y] }
    }
    return out
}
