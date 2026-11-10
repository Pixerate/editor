import Foundation
import PixerateCore
import PixerateRaster

/// A "nice" step (1, 2, 2.5 or 5 × 10ⁿ) for about `count` intervals over `span`.
public func niceStep(_ span: Double, _ count: Double) -> Double {
    if !(span > 0) || !(count > 0) { return 1 }
    let raw = span / count
    let power = pow(10.0, floor(log10(raw)))
    let fraction = raw / power
    let nice: Double = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
    return nice * power
}

private func clean(_ n: Double) -> Double {
    if abs(n) < 1e-12 { return 0 }
    return Double(jsToPrecision(n, 12)) ?? n
}

public struct NiceScale: Sendable, Equatable {
    public var min: Double
    public var max: Double
    public var step: Double
    public var ticks: [Double]

    public init(min: Double, max: Double, step: Double, ticks: [Double]) {
        self.min = min
        self.max = max
        self.step = step
        self.ticks = ticks
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("min", .number(min)),
            ("max", .number(max)),
            ("step", .number(step)),
            ("ticks", .array(ticks.map(JSONValue.number)))
        ]))
    }
}

/// Extends `[min, max]` to round numbers and lists the ticks between them. Fixed ends
/// (`fixedMin` / `fixedMax`) are kept exactly; ticks then start at the first nice value
/// inside them.
public func niceScale(
    _ min: Double,
    _ max: Double,
    _ count: Double = 5,
    _ fixedMinInput: Double? = nil,
    _ fixedMaxInput: Double? = nil
) -> NiceScale {
    var fixedMin = fixedMinInput
    var fixedMax = fixedMaxInput
    if let fm = fixedMin, !fm.isFinite { fixedMin = nil }
    if let fx = fixedMax, !fx.isFinite { fixedMax = nil }
    var lo = fixedMin ?? min
    var hi = fixedMax ?? max
    if !lo.isFinite || !hi.isFinite {
        fixedMin = nil
        fixedMax = nil
        lo = 0
        hi = 1
    }
    if lo > hi {
        let tmp = lo
        lo = hi
        hi = tmp
    }
    if lo == hi {
        let pad = lo == 0 ? 1 : abs(lo) * 0.1
        if fixedMin == nil && lo != 0 { lo -= pad }
        if fixedMax == nil || lo == hi { hi += pad }
    }
    let span = hi - lo
    let step = span.isFinite ? niceStep(span, count) : niceStep(hi / 2 - lo / 2, count) * 2
    func finiteOr(_ n: Double, _ fallback: Double) -> Double {
        n.isFinite ? n : fallback
    }
    let niceMin = fixedMin ?? finiteOr(snap(floor(lo / step + 1e-9) * step, step), lo)
    let niceMax = fixedMax ?? finiteOr(snap(ceil(hi / step - 1e-9) * step, step), hi)
    let firstIndex = ceil(niceMin / step - 1e-9)
    let lastIndex = floor(niceMax / step + 1e-9)
    let n = Int(Swift.min(999.0, Swift.max(-1.0, lastIndex - firstIndex)))
    var ticks: [Double] = []
    if n >= 0 {
        for i in 0...n {
            let t = snap((firstIndex + Double(i)) * step, step)
            if t.isFinite && t != ticks.last {
                ticks.append(t)
            }
        }
    }
    return NiceScale(min: niceMin, max: niceMax, step: step, ticks: ticks)
}

private func snap(_ n: Double, _ step: Double) -> Double {
    let c = clean(n)
    return abs(c - n) <= step * 1e-6 ? c : n
}

/// Decimals needed to write ticks `step` apart exactly: 1 → 0, 2.5 → 1, 0.25 → 2 (at most 6).
public func stepDecimals(_ step: Double) -> Int {
    if !(step > 0) || !step.isFinite { return 0 }
    for d in 0..<6 {
        let scaled = step * pow(10.0, Double(d))
        if abs(scaled - JS.round(scaled)) < 1e-9 { return d }
    }
    return 6
}

private func magnitudeDecimals(_ value: Double) -> Int {
    if !(value > 0) || value >= 1 { return 0 }
    return Swift.min(6, Swift.max(0, Int(ceil(-log10(value) - 1e-9))))
}

private let COMPACT: [(value: Double, suffix: String)] = [
    (1e12, "T"),
    (1e9, "B"),
    (1e6, "M"),
    (1e3, "K")
]

private func addThousandsCommas(_ intPart: String) -> String {
    let chars = Array(intPart)
    guard chars.count > 3 else { return intPart }
    var out: [Character] = []
    out.reserveCapacity(chars.count + chars.count / 3)
    for (i, ch) in chars.enumerated() {
        if i > 0 && (chars.count - i) % 3 == 0 {
            out.append(",")
        }
        out.append(ch)
    }
    return String(out)
}

private func grouped(_ value: Double, _ decimals: Int) -> String {
    let fixed = jsToFixed(abs(value), decimals)
    let parts = fixed.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    let intPart = parts.first ?? "0"
    let fracPart = parts.count > 1 ? parts[1] : ""
    let withCommas = addThousandsCommas(intPart)
    let isNonZero = (Double(fixed) ?? 0) != 0
    let sign = value < 0 && isNonZero ? "-" : ""
    let fracSuffix = !fracPart.isEmpty ? ".\(fracPart)" : ""
    return "\(sign)\(withCommas)\(fracSuffix)"
}

private let CURRENCY_SYMBOLS: [String: String] = [
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "JPY": "¥",
    "CNY": "¥",
    "INR": "₹",
    "AUD": "A$",
    "CAD": "C$"
]

private func isJSInteger(_ v: Double) -> Bool {
    v.isFinite && floor(v) == v
}

private func trimTrailingZerosAfterDot(_ s: String) -> String {
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

/// Writes a number for a chart label. Locale-independent (so labels and tests are the same
/// everywhere): `,` thousands, `.` decimals. `decimals` defaults to `fallbackDecimals`
/// (e.g. from the tick step), else up to 2 trimmed.
public func formatChartNumber(
    _ value: Double?,
    _ format: ChartNumberFormat = ChartNumberFormat(),
    _ fallbackDecimals: Int? = nil
) -> String {
    guard let value, value.isFinite else { return "" }
    if let code = format.code, !code.isEmpty {
        return "\(format.prefix ?? "")\(formatChartValueWithCode(value, code))\(format.suffix ?? "")"
    }
    let style = format.style ?? .number
    let body: String
    func decimalsFor(_ v: Double) -> Int {
        if let d = format.decimals { return d }
        if let fb = fallbackDecimals { return fb }
        if isJSInteger(v) { return 0 }
        if abs(v) < 1 {
            return Swift.min(4, Swift.max(2, magnitudeDecimals(abs(v)) + 1))
        }
        return 2
    }
    func trim(_ s: String) -> String {
        if format.decimals == nil && fallbackDecimals == nil && s.contains(".") {
            return trimTrailingZerosAfterDot(s)
        }
        return s
    }
    switch style {
    case .percent:
        let v = value * 100
        let d: Int
        if let fd = format.decimals {
            d = fd
        } else if let fb = fallbackDecimals {
            d = Swift.max(0, fb - 2)
        } else {
            d = isJSInteger(clean(v)) ? 0 : 1
        }
        body = "\(grouped(clean(v), d))%"
    case .compact:
        if let unit = COMPACT.first(where: { abs(value) >= $0.value }) {
            let v = value / unit.value
            let d = format.decimals ?? (abs(v) >= 100 || isJSInteger(clean(v)) ? 0 : 1)
            body = "\(trim(grouped(v, d)))\(unit.suffix)"
        } else {
            body = trim(grouped(value, decimalsFor(value)))
        }
    case .currency:
        let rawCurrency = format.currency ?? ""
        let code = (rawCurrency.isEmpty ? "USD" : rawCurrency).uppercased()
        let symbol = CURRENCY_SYMBOLS[code] ?? "\(code) "
        let d = format.decimals ?? (fallbackDecimals ?? (isJSInteger(value) ? 0 : 2))
        let s = grouped(abs(value), d)
        body = "\(value < 0 ? "-" : "")\(symbol)\(s)"
    case .number:
        body = trim(grouped(value, decimalsFor(value)))
    }
    return "\(format.prefix ?? "")\(body)\(format.suffix ?? "")"
}

/// Linear map from `domain` to `range`.
public func linearMap(_ value: Double, _ domain: (Double, Double), _ range: (Double, Double)) -> Double {
    let (d0, d1) = domain
    let (r0, r1) = range
    if d1 == d0 { return (r0 + r1) / 2 }
    return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0)
}

private func tidy(_ n: Double) -> Double {
    if n == 0 { return 0 }
    return Double(jsToPrecision(n, 12)) ?? n
}

/// A logarithmic scale over `[lo, hi]` (only positive values count): the ends extend to whole
/// powers of `base` unless fixed, and ticks sit on the powers, thinned to about `count`, or, in
/// base 10 over a few decades, on the 1-2-5 steps between them. `step` is the base. Non-positive
/// or non-finite ends fall back to the data, and no positive data at all gives 1 to `base`.
public func niceLogScale(
    _ loInput: Double,
    _ hiInput: Double,
    _ count: Double = 5,
    _ baseInput: Double = 10,
    _ fixedMinInput: Double? = nil,
    _ fixedMaxInput: Double? = nil
) -> NiceScale {
    var base = baseInput
    if !(base > 1) || !base.isFinite { base = 10 }
    var fixedMin = fixedMinInput
    var fixedMax = fixedMaxInput
    if let fm = fixedMin, !(fm > 0 && fm.isFinite) { fixedMin = nil }
    if let fx = fixedMax, !(fx > 0 && fx.isFinite) { fixedMax = nil }
    var lo = loInput
    var hi = hiInput
    if !(lo > 0) || !lo.isFinite {
        lo = hi > 0 && hi.isFinite ? hi : (fixedMin ?? 1)
    }
    if !(hi > 0) || !hi.isFinite {
        hi = Swift.max(lo, fixedMax ?? lo * base)
    }
    if lo > hi {
        let tmp = lo
        lo = hi
        hi = tmp
    }
    let logBaseVal = Foundation.log(base)
    func logB(_ v: Double) -> Double {
        Foundation.log(v) / logBaseVal
    }
    let e0 = floor(logB(fixedMin ?? lo) + 1e-9)
    var e1 = ceil(logB(fixedMax ?? hi) - 1e-9)
    if e1 <= e0 { e1 = e0 + 1 }
    var min = fixedMin ?? tidy(pow(base, e0))
    var max = fixedMax ?? tidy(pow(base, e1))
    if !(max > min) {
        if fixedMax == nil { max = tidy(min * base) }
        else { min = tidy(max / base) }
    }
    if !max.isFinite { max = Double.greatestFiniteMagnitude }
    if !(min > 0) { min = Double.leastNonzeroMagnitude }
    func inside(_ t: Double) -> Bool {
        t >= min * (1 - 1e-9) && t <= max * (1 + 1e-9)
    }
    let decades = Swift.max(1.0, logB(max) - logB(min))
    var ticks: [Double] = []
    let first = ceil(logB(min) - 1e-9)
    let last = floor(logB(max) + 1e-9)
    if base == 10 && decades * 3 <= count + 1 {
        var e = first - 1
        while e <= last {
            for m in [1.0, 2.0, 5.0] {
                ticks.append(tidy(m * pow(10.0, e)))
            }
            e += 1
        }
    } else {
        let every = Swift.max(1.0, ceil((last - first + 1) / (count + 2)))
        var e = ceil(first / every) * every
        while e <= last && ticks.count < 1000 {
            ticks.append(tidy(pow(base, e)))
            e += every
        }
    }
    ticks = ticks.filter { $0.isFinite && $0 > 0 && inside($0) }
    if ticks.count < 2 {
        ticks = niceScale(min, max, count, min, max).ticks.filter { $0 > 0 }
    }
    var seen = Set<Double>()
    var uniqueTicks: [Double] = []
    for t in ticks {
        if !seen.contains(t) {
            seen.insert(t)
            uniqueTicks.append(t)
        }
    }
    uniqueTicks.sort()
    return NiceScale(min: min, max: max, step: base, ticks: uniqueTicks)
}

/// A data value's pixel on a value scale: linear, or by logarithm when `scale.logBase` is set
/// (values of 0 or less have no pixel there and give NaN).
public func chartScaleToPixel(_ value: Double, _ scale: ChartValueScale) -> Double {
    guard let logBase = scale.logBase, logBase != 0 else {
        return linearMap(value, scale.domain, scale.range)
    }
    if !(value > 0) { return .nan }
    return linearMap(Foundation.log(value), (Foundation.log(scale.domain.0), Foundation.log(scale.domain.1)), scale.range)
}

/// The data value at a pixel on a value scale (the inverse of `chartScaleToPixel`).
public func chartScaleFromPixel(_ px: Double, _ scale: ChartValueScale) -> Double {
    guard let logBase = scale.logBase, logBase != 0 else {
        return linearMap(px, scale.range, scale.domain)
    }
    return Foundation.exp(linearMap(px, scale.range, (Foundation.log(scale.domain.0), Foundation.log(scale.domain.1))))
}
