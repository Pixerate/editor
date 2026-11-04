import Foundation

/// Curve lookup tables shared by Curves adjustments and layer-effect contours. The port of
/// `raster/curve.ts`; tables are `Float` (the TS `Float32Array`).

/// Entries of a curve LUT (input 0..1 in `size - 1` steps).
public let CURVE_LUT_SIZE = 4096

@inline(__always) private func clamp01(_ v: Double) -> Double { v <= 0 ? 0 : v >= 1 ? 1 : v }

/// A point of a curve (input → output, both 0..1).
public struct CurvePoint: Equatable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    public init(input: Double, output: Double) {
        self.input = input
        self.output = output
    }
}

/**
 * Photoshop curve: a natural cubic spline through the points (0..1 in and out; it may overshoot
 * between points, as Photoshop's does), constant outside the first / last point, clamped to
 * 0..1, sampled into a LUT. Fewer than two distinct points: the identity.
 */
public func curveLut(_ points: [CurvePoint], _ size: Int = CURVE_LUT_SIZE) -> [Float] {
    // A stable sort by input, as Array.prototype.sort.
    let pts = points.enumerated()
        .filter { $0.element.input.isFinite && $0.element.output.isFinite }
        .sorted { $0.element.input != $1.element.input ? $0.element.input < $1.element.input : $0.offset < $1.offset }
        .map { ($0.element.input, $0.element.output) }
    var dedup: [(Double, Double)] = []
    for p in pts {
        if let last = dedup.last, Swift.abs(last.0 - p.0) < 1e-6 { continue }
        dedup.append(p)
    }
    var out = [Float](repeating: 0, count: size)
    let n = dedup.count
    if n < 2 {
        for k in 0..<size { out[k] = Float(Double(k) / Double(size - 1)) }
        return out
    }
    let x = dedup.map(\.0)
    let y = dedup.map(\.1)
    // Second derivatives of the natural spline (tridiagonal solve).
    var m2 = [Double](repeating: 0, count: n)
    if n > 2 {
        var c = [Double](repeating: 0, count: n)
        var d = [Double](repeating: 0, count: n)
        for i in 1..<(n - 1) {
            let h0 = x[i] - x[i - 1]
            let h1 = x[i + 1] - x[i]
            let a = h0 / 6
            let b = (h0 + h1) / 3
            let cc = h1 / 6
            let r = (y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0
            let denom = b - a * c[i - 1]
            c[i] = cc / denom
            d[i] = (r - a * d[i - 1]) / denom
        }
        var i = n - 2
        while i >= 1 {
            m2[i] = d[i] - c[i] * m2[i + 1]
            i -= 1
        }
    }
    var seg = 0
    for k in 0..<size {
        let xv = Double(k) / Double(size - 1)
        if xv <= x[0] {
            out[k] = Float(clamp01(y[0]))
            continue
        }
        if xv >= x[n - 1] {
            out[k] = Float(clamp01(y[n - 1]))
            continue
        }
        while seg < n - 2 && xv > x[seg + 1] { seg += 1 }
        let x0 = x[seg], x1 = x[seg + 1]
        let h = x1 - x0
        let a = (x1 - xv) / h
        let b = (xv - x0) / h
        let v = a * y[seg] + b * y[seg + 1] + ((a * a * a - a) * m2[seg] + (b * b * b - b) * m2[seg + 1]) * (h * h) / 6
        out[k] = Float(clamp01(v))
    }
    return out
}
