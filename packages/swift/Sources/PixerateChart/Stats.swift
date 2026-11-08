import Foundation
import PixerateCore
import PixerateRaster

public struct ChartHistogramBin: Sendable, Equatable {
    public var from: Double
    public var to: Double
    public var count: Int

    public init(from: Double, to: Double, count: Int) {
        self.from = from
        self.to = to
        self.count = count
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("from", .number(from)),
            ("to", .number(to)),
            ("count", .number(Double(count)))
        ]))
    }
}

private func clean(_ n: Double) -> Double {
    if abs(n) < 1e-12 { return 0 }
    return Double(jsToPrecision(n, 12)) ?? n
}

/// Bins values into `bins` equal-width bins (default √n, from 1 to 100). Bins are
/// right-inclusive, the first closed on both sides, so a value on an edge belongs to the bin
/// that ends there. Gaps and non-finite values are ignored.
public func chartHistogram(_ values: [ChartValue], _ bins: Int? = nil) -> [ChartHistogramBin] {
    let vals = values.compactMap { v -> Double? in
        guard let v, v.isFinite else { return nil }
        return v
    }
    if vals.isEmpty { return [] }
    var lo = Double.infinity
    var hi = -Double.infinity
    for v in vals {
        lo = Swift.min(lo, v)
        hi = Swift.max(hi, v)
    }
    let span = hi - lo
    var count = bins ?? Swift.max(1, Swift.min(100, Int(ceil(sqrt(Double(vals.count))))))
    if !(span > 0) { count = 1 }
    let width = count == 1 && !(span > 0) ? 1.0 : span / Double(count)
    var edges: [Double] = []
    edges.reserveCapacity(count)
    for b in 0..<count {
        if b + 1 == count {
            edges.append(Swift.max(hi, lo + Double(b) * width))
        } else {
            edges.append(lo + Double(b + 1) * width)
        }
    }
    var counts = Array(repeating: 0, count: count)
    for v in vals {
        var a = 0
        var z = count
        while a < z {
            let mid = (a + z) >> 1
            if edges[mid] < v { a = mid + 1 }
            else { z = mid }
        }
        counts[Swift.min(a, count - 1)] += 1
    }
    return counts.enumerated().map { b, c in
        ChartHistogramBin(from: clean(lo + Double(b) * width), to: clean(edges[b]), count: c)
    }
}

/// The `q` quantile (0–1) of sorted values, interpolating linearly between ranks (`q·(n-1)`).
public func chartQuantile(_ sorted: [Double], _ q: Double) -> Double {
    let n = sorted.count
    if n == 0 { return 0 }
    let pos = q * Double(n - 1)
    let i = Int(floor(pos))
    let a = sorted[i]
    let b = i + 1 < n ? sorted[i + 1] : a
    return a + (b - a) * (pos - Double(i))
}

private func roundish(_ n: Double) -> Double {
    Double(jsToPrecision(n, 3)) ?? n
}

/// Starting points for a new reference line and band, from the visible values on the primary
/// axis: a line at their average and a band over their middle half (first to third quartile).
public func suggestChartReferences(_ spec: ChartSpec) -> (line: ChartReferenceLine, band: ChartReferenceBand) {
    return suggestChartReferences(series: spec.series)
}

public func suggestChartReferences(series: [ChartSeries]) -> (line: ChartReferenceLine, band: ChartReferenceBand) {
    let values = series
        .filter { !($0.hidden ?? false) && $0.axis != .secondary }
        .flatMap { $0.values }
        .compactMap { v -> Double? in
            guard let v, v.isFinite else { return nil }
            return v
        }
        .sorted()
    if values.isEmpty {
        return (
            line: ChartReferenceLine(value: 0, label: "Target"),
            band: ChartReferenceBand(from: 0, to: 1, label: "Target range")
        )
    }
    let mean = values.reduce(0, +) / Double(values.count)
    let lo = roundish(chartQuantile(values, 0.25))
    let hi = roundish(chartQuantile(values, 0.75))
    return (
        line: ChartReferenceLine(value: roundish(mean), label: "Average"),
        band: ChartReferenceBand(from: lo, to: hi > lo ? hi : lo + 1, label: "Middle half")
    )
}

public struct ChartBoxStats: Sendable, Equatable {
    public var min: Double
    public var max: Double
    public var q1: Double
    public var median: Double
    public var q3: Double
    public var mean: Double
    public var lowerWhisker: Double
    public var upperWhisker: Double
    public var outliers: [Double]
    public var count: Int

    public init(
        min: Double,
        max: Double,
        q1: Double,
        median: Double,
        q3: Double,
        mean: Double,
        lowerWhisker: Double,
        upperWhisker: Double,
        outliers: [Double],
        count: Int
    ) {
        self.min = min
        self.max = max
        self.q1 = q1
        self.median = median
        self.q3 = q3
        self.mean = mean
        self.lowerWhisker = lowerWhisker
        self.upperWhisker = upperWhisker
        self.outliers = outliers
        self.count = count
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("min", .number(min)),
            ("max", .number(max)),
            ("q1", .number(q1)),
            ("median", .number(median)),
            ("q3", .number(q3)),
            ("mean", .number(mean)),
            ("lowerWhisker", .number(lowerWhisker)),
            ("upperWhisker", .number(upperWhisker)),
            ("outliers", .array(outliers.map(JSONValue.number))),
            ("count", .number(Double(count)))
        ]))
    }
}

/// Box-and-whisker statistics (Tukey fences at 1.5 × IQR); `nil` without values.
public func chartBoxStats(_ values: [ChartValue]) -> ChartBoxStats? {
    let v = values.compactMap { x -> Double? in
        guard let x, x.isFinite else { return nil }
        return x
    }.sorted()
    if v.isEmpty { return nil }
    let q1 = chartQuantile(v, 0.25)
    let median = chartQuantile(v, 0.5)
    let q3 = chartQuantile(v, 0.75)
    let iqr = q3 - q1
    let lo = q1 - 1.5 * iqr
    let hi = q3 + 1.5 * iqr
    return ChartBoxStats(
        min: v[0],
        max: v[v.count - 1],
        q1: q1,
        median: median,
        q3: q3,
        mean: v.reduce(0, +) / Double(v.count),
        lowerWhisker: v.first(where: { $0 >= lo }) ?? q1,
        upperWhisker: v.reversed().first(where: { $0 <= hi }) ?? q3,
        outliers: v.filter { $0 < lo || $0 > hi },
        count: v.count
    )
}

/// Squarified treemap (Bruls et al.): positive `values` packed into `rect`, largest first.
/// Returns one rect per input index (zero-size for values ≤ 0).
public func chartSquarify(_ values: [Double], _ rect: ChartRect) -> [ChartRect] {
    var out = values.map { _ in ChartRect(x: rect.x, y: rect.y, width: 0, height: 0) }
    var items: [(Int, Double)] = []
    for (i, v) in values.enumerated() {
        if v > 0 && v.isFinite {
            items.append((i, v))
        }
    }
    items.sort { $0.1 > $1.1 }
    let total = items.reduce(0.0) { $0 + $1.1 }
    let area = rect.width * rect.height
    if !(total > 0 && area > 0) { return out }
    let scale = area / total
    var rem = rect
    var row: [(Int, Double)] = []
    func worst(_ r: [Double], _ side: Double) -> Double {
        let s = r.reduce(0.0, +)
        if s <= 0 || side <= 0 { return .infinity }
        let mn = r.min() ?? .infinity
        let mx = r.max() ?? -.infinity
        return Swift.max((side * side * mx) / (s * s), (s * s) / (side * side * mn))
    }
    func layoutRow(_ r: [(Int, Double)]) {
        let s = r.reduce(0.0) { $0 + $1.1 }
        if s <= 0 { return }
        if rem.width >= rem.height {
            let cw = s / Swift.max(1e-6, rem.height)
            var y = rem.y
            for (j, a) in r {
                let h = a / Swift.max(1e-6, cw)
                out[j] = ChartRect(x: rem.x, y: y, width: cw, height: h)
                y += h
            }
            rem.x += cw
            rem.width = Swift.max(0, rem.width - cw)
        } else {
            let rh = s / Swift.max(1e-6, rem.width)
            var x = rem.x
            for (j, a) in r {
                let w = a / Swift.max(1e-6, rh)
                out[j] = ChartRect(x: x, y: rem.y, width: w, height: rh)
                x += w
            }
            rem.y += rh
            rem.height = Swift.max(0, rem.height - rh)
        }
    }
    var i = 0
    while i < items.count {
        let (j, v) = items[i]
        let a = v * scale
        let side = Swift.min(rem.width, rem.height)
        let cur = row.map { $0.1 }
        if row.isEmpty || worst(cur + [a], side) <= worst(cur, side) {
            row.append((j, a))
            i += 1
        } else {
            layoutRow(row)
            row = []
        }
    }
    if !row.isEmpty { layoutRow(row) }
    return out
}

public protocol ChartXYPoint {
    var x: Double { get }
    var y: Double { get }
}

public struct ChartPoint2D: ChartXYPoint, Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("x", .number(x)),
            ("y", .number(y))
        ]))
    }
}

/// Thins a long polyline (sorted by x) to the first, lowest, highest and last point of each
/// pixel column, which draws identically. Returns the input when it has `max` points or fewer.
public func decimateChartPoints<T: ChartXYPoint>(_ points: [T], _ max: Int = 2000) -> [T] {
    if points.count <= max { return points }
    var out: [T] = []
    var i = 0
    while i < points.count {
        let col = floor(points[i].x)
        let start = i
        var mn = i
        var mx = i
        var k = i + 1
        while k < points.count && floor(points[k].x) == col {
            if points[k].y < points[mn].y { mn = k }
            if points[k].y > points[mx].y { mx = k }
            k += 1
        }
        let end = k - 1
        let indices = Array(Set([start, mn, mx, end])).sorted()
        for idx in indices {
            out.append(points[idx])
        }
        i = k
    }
    return out
}

public enum ChartSeriesTrend: String, CaseIterable, Sendable, Equatable {
    case rising
    case falling
    case flat
}

public struct ChartSeriesSummary: Sendable, Equatable {
    public var id: String
    public var name: String
    public var count: Int
    public var gaps: Int
    public var min: Double?
    public var max: Double?
    public var mean: Double?
    public var sum: Double?
    public var minAt: String?
    public var maxAt: String?
    public var trend: ChartSeriesTrend?
    public var change: Double?

    public init(
        id: String,
        name: String,
        count: Int,
        gaps: Int,
        min: Double? = nil,
        max: Double? = nil,
        mean: Double? = nil,
        sum: Double? = nil,
        minAt: String? = nil,
        maxAt: String? = nil,
        trend: ChartSeriesTrend? = nil,
        change: Double? = nil
    ) {
        self.id = id
        self.name = name
        self.count = count
        self.gaps = gaps
        self.min = min
        self.max = max
        self.mean = mean
        self.sum = sum
        self.minAt = minAt
        self.maxAt = maxAt
        self.trend = trend
        self.change = change
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("id", .string(id)),
            ("name", .string(name)),
            ("count", .number(Double(count))),
            ("gaps", .number(Double(gaps))),
            ("min", min.map(JSONValue.number) ?? .null),
            ("max", max.map(JSONValue.number) ?? .null),
            ("mean", mean.map(JSONValue.number) ?? .null),
            ("sum", sum.map(JSONValue.number) ?? .null),
            ("minAt", minAt.map(JSONValue.string) ?? .null),
            ("maxAt", maxAt.map(JSONValue.string) ?? .null),
            ("trend", trend.map { .string($0.rawValue) } ?? .null),
            ("change", change.map(JSONValue.number) ?? .null)
        ]))
    }
}

private func round6(_ n: Double) -> Double {
    Double(jsToPrecision(n, 6)) ?? n
}

/// Numbers about one series, for agents that check a chart without looking at it.
public func summarizeChartSeries(
    _ series: ChartSeries,
    _ categories: [String]
) -> ChartSeriesSummary {
    return summarizeChartSeries(id: series.id, name: series.name, values: series.values, categories: categories)
}

public func summarizeChartSeries(
    id: String,
    name: String,
    values: [ChartValue],
    categories: [String]
) -> ChartSeriesSummary {
    let present: [(Int, Double)] = values.enumerated().compactMap { i, v in
        guard let v, v.isFinite else { return nil }
        return (i, v)
    }
    var base = ChartSeriesSummary(
        id: id,
        name: name,
        count: present.count,
        gaps: values.count - present.count
    )
    if present.isEmpty { return base }
    var lo = present[0]
    var hi = present[0]
    var sum = 0.0
    for p in present {
        if p.1 < lo.1 { lo = p }
        if p.1 > hi.1 { hi = p }
        sum += p.1
    }
    let mean = sum / Double(present.count)
    var trend: ChartSeriesTrend? = nil
    if present.count >= 2 {
        let mx = present.reduce(0.0) { $0 + Double($1.0) } / Double(present.count)
        var sxy = 0.0
        var sxx = 0.0
        for (i, v) in present {
            let dx = Double(i) - mx
            sxy += dx * (v - mean)
            sxx += dx * dx
        }
        let slope = sxx != 0 ? sxy / sxx : 0
        let spread = hi.1 - lo.1
        let travel = abs(slope * Double(present[present.count - 1].0 - present[0].0))
        if spread == 0 || travel < spread * 0.05 {
            trend = .flat
        } else {
            trend = slope > 0 ? .rising : .falling
        }
    }
    let first = present[0].1
    let last = present[present.count - 1].1
    base.min = round6(lo.1)
    base.max = round6(hi.1)
    base.mean = round6(mean)
    base.sum = round6(sum)
    base.minAt = lo.0 < categories.count ? categories[lo.0] : String(lo.0)
    base.maxAt = hi.0 < categories.count ? categories[hi.0] : String(hi.0)
    base.trend = trend
    base.change = present.count >= 2 && first != 0 ? round6((last - first) / abs(first)) : nil
    return base
}
