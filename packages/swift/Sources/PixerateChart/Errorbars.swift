import Foundation
import PixerateCore

public let CHART_ERROR_BAR_TYPES: [ChartErrorBarType] = [.fixed, .percent, .stddev, .stderr, .custom]
public let CHART_ERROR_BAR_DIRECTIONS: [ChartErrorBarDirection] = [.both, .plus, .minus]

public let CHART_ERROR_BAR_LABELS: [ChartErrorBarType: String] = [
    .fixed: "Fixed amount",
    .percent: "Percentage",
    .stddev: "Standard deviation",
    .stderr: "Standard error",
    .custom: "Custom"
]

/// The default `value` per type (`fixed` 1, `percent` 5, `stddev` 1).
public func defaultChartErrorBarValue(_ type: ChartErrorBarType) -> Double? {
    switch type {
    case .fixed: return 1
    case .percent: return 5
    case .stddev: return 1
    case .stderr, .custom: return nil
    }
}

/// One point's error bar: where it is centred and how far it reaches each way (both 0 or more).
public struct ChartErrorAmount: Sendable, Equatable {
    public var center: Double
    public var plus: Double
    public var minus: Double

    public init(center: Double, plus: Double, minus: Double) {
        self.center = center
        self.plus = plus
        self.minus = minus
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("center", .number(center)),
            ("plus", .number(plus)),
            ("minus", .number(minus))
        ]))
    }
}

private func meanAndSd(_ values: [ChartValue]) -> (mean: Double, sd: Double, n: Int) {
    let xs = values.compactMap { v -> Double? in
        guard let v, v.isFinite else { return nil }
        return v
    }
    let n = xs.count
    if n == 0 { return (0, 0, 0) }
    let mean = xs.reduce(0.0, +) / Double(n)
    let sd: Double
    if n > 1 {
        let sumSq = xs.reduce(0.0) { $0 + ($1 - mean) * ($1 - mean) }
        sd = sqrt(sumSq / Double(n - 1))
    } else {
        sd = 0
    }
    return (mean, sd, n)
}

/// The error bar at each point of `values` (a series' values, or its x values for x error
/// bars), following Excel's error amount types: `fixed` and `percent` from `value`, `stddev`
/// around the series mean, `stderr` (sample standard deviation / √n) and `custom` amounts from
/// `plus` / `minus`. Gaps (and custom points without an amount) give `nil`.
public func chartErrorAmounts(_ bars: ChartErrorBars, _ values: [ChartValue]) -> [ChartErrorAmount?] {
    let direction = bars.direction ?? .both
    let up = direction != .minus
    let down = direction != .plus
    let stats = (bars.type == .stddev || bars.type == .stderr) ? meanAndSd(values) : nil
    let amount = bars.value ?? defaultChartErrorBarValue(bars.type) ?? 0
    return values.enumerated().map { i, v in
        guard let v, v.isFinite else { return nil }
        let plus: Double
        let minus: Double
        var center = v
        switch bars.type {
        case .fixed:
            let a = abs(amount)
            plus = a
            minus = a
        case .percent:
            let a = abs((v * amount) / 100)
            plus = a
            minus = a
        case .stddev:
            center = stats!.mean
            let a = abs(amount) * stats!.sd
            plus = a
            minus = a
        case .stderr:
            let a = stats!.n > 0 ? stats!.sd / sqrt(Double(stats!.n)) : 0
            plus = a
            minus = a
        case .custom:
            let p: Double? = (bars.plus != nil && i < bars.plus!.count) ? bars.plus![i] : nil
            let m: Double?
            if let minusArr = bars.minus {
                m = i < minusArr.count ? minusArr[i] : nil
            } else {
                m = p
            }
            let pValid = p != nil && p!.isFinite
            let mValid = m != nil && m!.isFinite
            if !pValid && !mValid { return nil }
            plus = pValid ? abs(p!) : 0
            minus = mValid ? abs(m!) : 0
        }
        return ChartErrorAmount(center: center, plus: up ? plus : 0, minus: down ? minus : 0)
    }
}

/// A one-line description of error bars ("±5% error bars", "±1 standard deviation error bars").
public func describeChartErrorBars(_ bars: ChartErrorBars) -> String {
    let sign = bars.direction == .plus ? "+" : bars.direction == .minus ? "−" : "±"
    let value = bars.value ?? defaultChartErrorBarValue(bars.type)
    let valStr = value.map(JSONValue.jsNumber) ?? "undefined"
    switch bars.type {
    case .fixed:
        return "\(sign)\(valStr) error bars"
    case .percent:
        return "\(sign)\(valStr)% error bars"
    case .stddev:
        return "\(sign)\(valStr) standard deviation\(value == 1 ? "" : "s") error bars"
    case .stderr:
        return "\(sign)standard error bars"
    case .custom:
        return "custom error bars"
    }
}

/// Error bars for a picker change: `nil` for none, else bars of `type` that keep the current
/// direction and caps. Switching to `custom` starts from the amounts the current bars (or ±1)
/// draw, so the picture does not jump. Shared by the React and Svelte inspectors.
public func chartErrorBarsOfType(
    _ type: ChartErrorBarType?,
    _ current: ChartErrorBars?,
    _ values: [ChartValue]
) -> ChartErrorBars? {
    guard let type else { return nil }
    let keepDirection = current?.direction
    let keepCap: Bool? = current?.cap == false ? false : nil
    if type != .custom {
        let keepValue: Double? = (current?.type == type) ? current?.value : nil
        return ChartErrorBars(type: type, value: keepValue, direction: keepDirection, cap: keepCap)
    }
    if current?.type == .custom { return current }
    var baseBars = current ?? ChartErrorBars(type: .fixed)
    baseBars.direction = .both
    let amounts = chartErrorAmounts(baseBars, values)
    func round4(_ n: Double) -> Double {
        Double(jsToPrecision(n, 4)) ?? n
    }
    let plus: [ChartValue] = amounts.map { a in a.map { round4($0.plus) } }
    let minus: [ChartValue] = amounts.map { a in a.map { round4($0.minus) } }
    return ChartErrorBars(
        type: .custom,
        plus: plus,
        minus: minus != plus ? minus : nil,
        direction: keepDirection,
        cap: keepCap
    )
}

/// Custom amounts as text for an input: "1, 2, -, 0.5" (`-` is a point without a bar).
public func formatChartAmountList(_ values: [ChartValue]?) -> String {
    (values ?? []).map { v in
        guard let v else { return "-" }
        return JSONValue.jsNumber(v)
    }.joined(separator: ", ")
}

/// Reads amounts typed as "1, 2, -, 0.5" (commas, semicolons or spaces; `-` or blank for none).
public func parseChartAmountList(_ text: String) -> [String?] {
    var parts: [String] = []
    var current = ""
    for ch in text {
        if ch == ";" || ch == "," || ch.isWhitespace {
            if !current.isEmpty {
                parts.append(current)
                current = ""
            }
        } else {
            current.append(ch)
        }
    }
    if !current.isEmpty {
        parts.append(current)
    }
    return parts.map { $0 == "-" ? nil : $0 }
}
