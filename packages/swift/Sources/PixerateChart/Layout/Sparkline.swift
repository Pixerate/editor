// Ported from gridcraft-main/crates/chart/src/sparkline.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore
import PixerateRaster

public enum ChartSparklineKind: String, CaseIterable, Sendable, Equatable {
    case line
    case column
    case winLoss = "win-loss"
}

public struct ChartSparklineOptions: Sendable, Equatable {
    public var kind: ChartSparklineKind?
    public var width: Double
    public var height: Double
    public var color: String?
    public var negativeColor: String?
    public var markers: Bool?
    public var highLow: Bool?
    public var min: Double?
    public var max: Double?
    public var ariaLabel: String?

    public init(
        kind: ChartSparklineKind? = nil,
        width: Double,
        height: Double,
        color: String? = nil,
        negativeColor: String? = nil,
        markers: Bool? = nil,
        highLow: Bool? = nil,
        min: Double? = nil,
        max: Double? = nil,
        ariaLabel: String? = nil
    ) {
        self.kind = kind
        self.width = width
        self.height = height
        self.color = color
        self.negativeColor = negativeColor
        self.markers = markers
        self.highLow = highLow
        self.min = min
        self.max = max
        self.ariaLabel = ariaLabel
    }

    public init(json: JSONValue) {
        let obj = json.objectValue ?? JSONObject()
        self.kind = obj["kind"]?.stringValue.flatMap(ChartSparklineKind.init(rawValue:))
        self.width = obj["width"]?.doubleValue ?? 64
        self.height = obj["height"]?.doubleValue ?? 20
        self.color = obj["color"]?.stringValue
        self.negativeColor = obj["negativeColor"]?.stringValue
        self.markers = obj["markers"]?.boolValue
        self.highLow = obj["highLow"]?.boolValue
        self.min = obj["min"]?.doubleValue
        self.max = obj["max"]?.doubleValue
        self.ariaLabel = obj["ariaLabel"]?.stringValue
    }
}

private let MAX_SPARKLINE_POINTS = 100_000

/// Lays out a word-sized chart (a sparkline) as marks: a line broken at gaps, columns
/// (negatives in `negativeColor`) or win/loss bars of equal height.
public func layoutSparkline(_ values: [ChartValue], _ options: ChartSparklineOptions) -> ChartScene {
    let kind = options.kind ?? .line
    let w = options.width.isFinite ? Swift.max(1.0, options.width) : 1.0
    let h = options.height.isFinite ? Swift.max(1.0, options.height) : 1.0
    let color = options.color ?? "#4269d0"
    let negative = options.negativeColor ?? "#e5484d"
    var theme = DEFAULT_CHART_THEME
    theme.background = "transparent"
    var marks: [ChartMark] = []
    let baseScene = ChartScene(
        width: w,
        height: h,
        plot: ChartRect(x: 0, y: 0, width: w, height: h),
        marks: [],
        percent: false,
        theme: theme,
        warnings: []
    )
    let vals: [Double?] = values.prefix(MAX_SPARKLINE_POINTS).map { vOpt in
        guard let v = vOpt, v.isFinite else { return nil }
        return Swift.max(-1e300, Swift.min(1e300, v))
    }
    let n = vals.count
    if n == 0 { return baseScene }
    let pad = Swift.max(0.5, Swift.min(2.0, h * 0.1))
    let x0 = pad
    let y0 = pad
    let iw = Swift.max(0.5, w - 2.0 * pad)
    let ih = Swift.max(0.5, h - 2.0 * pad)
    var lo = Double.infinity
    var hi = -Double.infinity
    for vOpt in vals {
        if let v = vOpt {
            lo = Swift.min(lo, v)
            hi = Swift.max(hi, v)
        }
    }
    if !lo.isFinite { return baseScene }
    if let optMin = options.min, optMin.isFinite { lo = optMin }
    if let optMax = options.max, optMax.isFinite { hi = optMax }
    var hiAt = -1
    var loAt = -1
    for (i, vOpt) in vals.enumerated() {
        guard let v = vOpt else { continue }
        if hiAt < 0 || v > vals[hiAt]! { hiAt = i }
        if loAt < 0 || v < vals[loAt]! { loAt = i }
    }
    if kind == .line {
        let span = hi - lo
        func fy(_ v: Double) -> Double {
            y0 + ih - (span > 0 ? (v - lo) / span : 0.5) * ih
        }
        func fx(_ j: Int) -> Double {
            n > 1 ? x0 + (Double(j) / Double(n - 1)) * iw : x0 + iw / 2.0
        }
        var d = ""
        var run: [(Double, Double)] = []
        func flush() {
            if run.count >= 2 {
                let step = run.count > 4000 ? (run.count / 2000 + 1) : 1
                let pts = run.count > 4000
                    ? run.enumerated().compactMap { i, p in i % step == 0 ? p : nil }
                    : run
                d += pts.enumerated().map { i, pt in
                    "\(i > 0 ? "L" : "M")\(r2s(pt.0)),\(r2s(pt.1))"
                }.joined()
            }
            run.removeAll(keepingCapacity: true)
        }
        for (j, vOpt) in vals.enumerated() {
            if let v = vOpt {
                run.append((fx(j), fy(v)))
            } else {
                flush()
            }
        }
        flush()
        if !d.isEmpty {
            marks.append(.path(
                key: "sparkline",
                role: .line,
                d: d,
                fill: "none",
                stroke: color,
                strokeWidth: 1.25
            ))
        }
        let r = Swift.max(1.0, Swift.min(3.0, h * 0.08))
        if (options.markers == true) || n == 1 {
            let step = Swift.max(1, n / 500)
            for (j, vOpt) in vals.enumerated() {
                if let v = vOpt, j % step == 0 {
                    marks.append(.circle(
                        key: "point-\(j)",
                        role: .point,
                        cx: fx(j),
                        cy: fy(v),
                        r: r,
                        fill: color
                    ))
                }
            }
        }
        if (options.highLow == true) && n > 1 {
            if hiAt >= 0 {
                marks.append(.circle(
                    key: "high",
                    role: .point,
                    cx: fx(hiAt),
                    cy: fy(vals[hiAt]!),
                    r: r + 0.5,
                    fill: color
                ))
            }
            if loAt >= 0 && loAt != hiAt {
                marks.append(.circle(
                    key: "low",
                    role: .point,
                    cx: fx(loAt),
                    cy: fy(vals[loAt]!),
                    r: r + 0.5,
                    fill: negative
                ))
            }
        }
        var out = baseScene
        out.marks = marks
        return out
    }
    let slot = iw / Double(n)
    let bw = Swift.max(0.25, slot * 0.8)
    let win = kind == .winLoss
    let lo0 = win ? -1.0 : Swift.min(lo, 0.0)
    let hi0 = win ? 1.0 : Swift.max(hi, 0.0)
    let span = hi0 - lo0
    func fy(_ v: Double) -> Double {
        span > 0 ? y0 + ih - ((v - lo0) / span) * ih : y0 + ih
    }
    let base = fy(0)
    for (j, rawOpt) in vals.enumerated() {
        guard let raw = rawOpt else { continue }
        let v: Double = win ? (raw > 0 ? 1.0 : (raw < 0 ? -1.0 : 0.0)) : raw
        if win && v == 0 { continue }
        let top = fy(v)
        let highlight = (options.highLow == true) && !win && (j == hiAt || j == loAt)
        marks.append(.rect(
            key: "bar-\(j)",
            role: .bar,
            x: x0 + Double(j) * slot + (slot - bw) / 2.0,
            y: Swift.min(top, base),
            width: bw,
            height: Swift.max(0.5, abs(top - base)),
            fill: v < 0 ? negative : color,
            opacity: ((options.highLow == true) && !win && !highlight) ? 0.6 : nil
        ))
    }
    var out = baseScene
    out.marks = marks
    return out
}

/// Renders a sparkline as a standalone SVG string.
public func sparklineToSvg(
    _ values: [ChartValue],
    _ options: ChartSparklineOptions
) -> String {
    return chartSceneToSvg(
        layoutSparkline(values, options),
        ChartSvgOptions(ariaLabel: options.ariaLabel)
    )
}

