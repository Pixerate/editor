import Foundation
import PixerateCore
import PixerateRaster

public struct ChartTrendFit: Sendable {
    public var type: ChartTrendlineType
    public var coefficients: [Double]
    public var r2: Double?
    public var equation: String
    public var points: Int
    private let evaluator: @Sendable (Double) -> Double?

    public init(
        type: ChartTrendlineType,
        coefficients: [Double],
        r2: Double?,
        equation: String,
        points: Int,
        evaluate: @escaping @Sendable (Double) -> Double?
    ) {
        self.type = type
        self.coefficients = coefficients
        self.r2 = r2
        self.equation = equation
        self.points = points
        self.evaluator = evaluate
    }

    public func evaluate(_ x: Double) -> Double? {
        evaluator(x)
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("type", .string(type.rawValue)),
            ("coefficients", .array(coefficients.map(JSONValue.number))),
            ("r2", r2.map(JSONValue.number) ?? .null),
            ("equation", .string(equation)),
            ("points", .number(Double(points)))
        ]))
    }
}

private func degree(_ t: ChartTrendline) -> Int {
    t.type == .polynomial ? Swift.max(2, Swift.min(6, t.order ?? 2)) : 1
}

private func logX(_ type: ChartTrendlineType) -> Bool {
    type == .logarithmic || type == .power
}

private func logY(_ type: ChartTrendlineType) -> Bool {
    type == .exponential || type == .power
}

/// Fits `trendline` to the points. Returns `nil` for moving averages (see
/// `chartMovingAverage`) and degenerate data: too few usable points, all x equal, or a
/// singular system.
public func fitChartTrendline(_ trendline: ChartTrendline, _ points: [(Double, Double)]) -> ChartTrendFit? {
    let type = trendline.type
    if type == .movingAverage { return nil }
    let d = degree(trendline)
    let data: [(Double, Double)] = points.compactMap { x, y in
        guard x.isFinite && y.isFinite && (!logX(type) || x > 0) && (!logY(type) || y > 0) else { return nil }
        return (logX(type) ? Foundation.log(x) : x, logY(type) ? Foundation.log(y) : y)
    }
    if data.count < 2 || data.count <= d { return nil }
    var fixed: Double? = nil
    if let b = trendline.intercept, b.isFinite {
        if type == .linear || type == .polynomial {
            fixed = b
        } else if type == .exponential && b > 0 {
            fixed = Foundation.log(b)
        }
    }
    let n = data.count
    let center = fixed != nil ? 0.0 : data.reduce(0.0) { $0 + $1.0 } / Double(n)
    let scale = data.reduce(0.0) { Swift.max($0, abs($1.0 - center)) }
    if !(scale.isFinite && scale > 0) { return nil }
    let first = fixed != nil ? 1 : 0
    let b0 = fixed ?? 0.0
    let m = d + 1 - first
    var ata = Array(repeating: Array(repeating: 0.0, count: m), count: m)
    var aty = Array(repeating: 0.0, count: m)
    for (x, y) in data {
        let u = (x - center) / scale
        let pows = (0..<m).map { k in pow(u, Double(k + first)) }
        for i in 0..<m {
            aty[i] += pows[i] * (y - b0)
            for j in 0..<m {
                ata[i][j] += pows[i] * pows[j]
            }
        }
    }
    guard let sol = solve(ata, aty) else { return nil }
    var a = Array(repeating: b0, count: d + 1)
    for (k, v) in sol.enumerated() {
        a[k + first] = v
    }
    guard let coefficients = expand(a, center, scale) else { return nil }
    let aCopy = a
    @Sendable func poly(_ x: Double) -> Double {
        let u = (x - center) / scale
        var acc = 0.0
        for c in aCopy.reversed() {
            acc = acc * u + c
        }
        return acc
    }
    let mean = data.reduce(0.0) { $0 + $1.1 } / Double(n)
    var ssRes = 0.0
    var ssTot = 0.0
    for (x, y) in data {
        let diffRes = y - poly(x)
        ssRes += diffRes * diffRes
        let diffTot = fixed != nil ? (y - b0) : (y - mean)
        ssTot += diffTot * diffTot
    }
    let r2: Double? = ssTot > 0 && ssTot.isFinite && ssRes.isFinite ? 1.0 - ssRes / ssTot : nil
    return ChartTrendFit(
        type: type,
        coefficients: coefficients,
        r2: r2,
        equation: equationText(type, coefficients),
        points: n,
        evaluate: { x in
            var xx = x
            if logX(type) {
                if !(x > 0) { return nil }
                xx = Foundation.log(x)
            }
            let p = poly(xx)
            let y = logY(type) ? Foundation.exp(p) : p
            return y.isFinite ? y : nil
        }
    )
}

/// Gaussian elimination with partial pivoting; `nil` when (nearly) singular.
private func solve(_ aInput: [[Double]], _ bInput: [Double]) -> [Double]? {
    var a = aInput
    var b = bInput
    let n = b.count
    let big = a.flatMap { $0 }.reduce(0.0) { Swift.max($0, abs($1)) }
    if !(big.isFinite && big > 0) { return nil }
    for col in 0..<n {
        var piv = col
        for r in (col + 1)..<n {
            if abs(a[r][col]) > abs(a[piv][col]) {
                piv = r
            }
        }
        a.swapAt(col, piv)
        b.swapAt(col, piv)
        let p = a[col][col]
        if !p.isFinite || abs(p) <= big * 1e-13 { return nil }
        for r in (col + 1)..<n {
            let f = a[r][col] / p
            for c in col..<n {
                a[r][c] -= f * a[col][c]
            }
            b[r] -= f * b[col]
        }
    }
    var x = Array(repeating: 0.0, count: n)
    for r in stride(from: n - 1, through: 0, by: -1) {
        var s = 0.0
        for c in (r + 1)..<n {
            s += a[r][c] * x[c]
        }
        x[r] = (b[r] - s) / a[r][r]
    }
    return x.allSatisfy { $0.isFinite } ? x : nil
}

/// Coefficients in X of `Σ aₖ·((X - c) / s)ᵏ` (binomial expansion).
private func expand(_ a: [Double], _ c: Double, _ s: Double) -> [Double]? {
    var out = Array(repeating: 0.0, count: a.count)
    for (k, ak) in a.enumerated() {
        let lead = ak / pow(s, Double(k))
        var binom = 1.0
        for j in 0...k {
            out[j] += lead * binom * pow(-c, Double(k - j))
            binom = (binom * Double(k - j)) / Double(j + 1)
        }
    }
    return out.allSatisfy { $0.isFinite } ? out : nil
}

private let POWERS = ["", "x", "x²", "x³", "x⁴", "x⁵", "x⁶"]

private func equationText(_ type: ChartTrendlineType, _ coef: [Double]) -> String {
    let c0 = coef.first ?? 0
    let c1 = coef.count > 1 ? coef[1] : 0
    if type == .exponential {
        return "y = \(trendNumberText(Foundation.exp(c0)))e^(\(trendNumberText(c1))x)"
    }
    if type == .power {
        return "y = \(trendNumberText(Foundation.exp(c0)))x^\(trendNumberText(c1))"
    }
    if type == .logarithmic {
        return terms([(c1, "ln(x)"), (c0, "")])
    }
    let parts: [(Double, String)] = coef.enumerated().map { k, c in
        (c, k < POWERS.count ? POWERS[k] : "x")
    }.reversed()
    return terms(parts)
}

private func terms(_ parts: [(Double, String)]) -> String {
    var s = "y = "
    var first = true
    for (c, t) in parts {
        let txt = trendNumberText(abs(c))
        if txt == "0" { continue }
        let neg = c < 0
        if first {
            s += neg ? "-" : ""
        } else {
            s += neg ? " - " : " + "
        }
        if txt != "1" || t.isEmpty {
            s += txt
        }
        s += t
        first = false
    }
    return first ? "\(s)0" : s
}

/// A coefficient as trendline labels show it: up to four decimals, scientific when tiny or huge.
public func trendNumberText(_ v: Double) -> String {
    if !v.isFinite { return "#NUM!" }
    let a = abs(v)
    if a == 0 { return "0" }
    if a < 1e-4 || a >= 1e11 {
        let expStr = jsToExponential(v, 4)
        let parts = expStr.split(separator: "e", maxSplits: 1).map(String.init)
        let mant = parts[0]
        let e = Int(parts.count > 1 ? parts[1] : "0") ?? 0
        let absE = String(abs(e))
        let paddedE = absE.count < 2 ? String(repeating: "0", count: 2 - absE.count) + absE : absE
        return "\(trimZeros(mant))E\(e < 0 ? "-" : "+")\(paddedE)"
    }
    let s = trimZeros(jsToFixed(v, 4))
    return s == "-0" ? "0" : s
}

private func trimZeros(_ s: String) -> String {
    guard s.contains(".") else { return s }
    var chars = Array(s)
    while chars.last == "0" {
        chars.removeLast()
    }
    if chars.last == "." {
        chars.removeLast()
    }
    return String(chars)
}

/// Moving average of `period` consecutive points in plotted order: point `i` (from
/// `period - 1`) is `(xᵢ, mean(yᵢ₋ₚ₊₁ … yᵢ))`. Empty when there are fewer points than `period`.
public func chartMovingAverage(_ points: [(Double, Double)], _ period: Double) -> [(Double, Double)] {
    let rounded = JS.round(period)
    let pInt = rounded.isFinite && rounded != 0 ? Int(rounded) : 2
    let p = Swift.max(2, Swift.min(1000, pInt))
    let pts = points.filter { $0.0.isFinite && $0.1.isFinite }
    var out: [(Double, Double)] = []
    var sum = 0.0
    for (i, pt) in pts.enumerated() {
        sum += pt.1
        if i >= p { sum -= pts[i - p].1 }
        if i >= p - 1 { out.append((pt.0, sum / Double(p))) }
    }
    return out
}

/// The legend name spreadsheets give a trendline, e.g. `Linear (Sales)`.
public func chartTrendlineName(_ trendline: ChartTrendline, _ seriesName: String) -> String {
    if let name = trendline.name, !name.isEmpty { return name }
    let kind: String
    switch trendline.type {
    case .linear: kind = "Linear"
    case .exponential: kind = "Expon."
    case .logarithmic: kind = "Log."
    case .polynomial: kind = "Poly."
    case .power: kind = "Power"
    case .movingAverage: kind = "\(Swift.max(2, trendline.period ?? 2)) per. Mov. Avg."
    }
    return "\(kind) (\(seriesName))"
}

/// Whether trendlines can be drawn for this chart type and stacking (unstacked cartesian and xy charts).
public func chartSupportsTrendlines(_ type: String, _ stacking: String) -> Bool {
    (type == "bar" || type == "line" || type == "area" || type == "scatter" || type == "bubble") && stacking == "none"
}
