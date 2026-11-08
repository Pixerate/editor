// The label ladder follows `ruler_steps` in filmcraft-main/crates/ui-egui/src/panels/timeline.rs (the first
// step on a ladder that keeps labels a minimum distance apart) (MIT OR Apache-2.0, © ArtCraft Team and
// contributors), adapted to calendar units. See THIRD_PARTY_NOTICES.md.
import Foundation
import PixerateCore

private let MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

private func floorDiv(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    let r = a % b
    return (r != 0 && ((r < 0) != (b < 0))) ? q - 1 : q
}

/// Converts UTC milliseconds since 1970-01-01 to `(year, month0, day)` where `month0` is `0...11`.
private func utcParts(_ ms: Double) -> (year: Int, month0: Int, day: Int) {
    let dayCount = Int(floor(ms / 86_400_000.0))
    let z = dayCount + 719468
    let era = floorDiv(z, 146097)
    let doe = z - era * 146097
    let yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365)
    let doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
    let mp = floorDiv(5 * doy + 2, 153)
    let d = doy - floorDiv(153 * mp + 2, 5) + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
    return (year: y, month0: m - 1, day: d)
}

/// Equivalent to `Date.UTC(y, mo, d)` for 4-digit years (`mo` is 0-based `0...11`, `d` is 1-based).
private func dateUTC(_ y: Int, _ mo0: Int, _ d: Int) -> Double {
    let yearAdj = y + floorDiv(mo0, 12)
    let month0 = ((mo0 % 12) + 12) % 12
    let days = daysFromCivil(yearAdj, month0 + 1, 1) + (d - 1)
    return Double(days) * 86_400_000.0
}

private func valid(_ y: Int, _ mo: Int, _ d: Int) -> Double? {
    let t = dateUTC(y, mo, d)
    let p = utcParts(t)
    return (p.year == y && p.month0 == mo && p.day == d) ? t : nil
}

/// Reads a category label as a UTC date: `2024`, `2024-03`, `2024-03-05`, ISO date-times,
/// `2024/03/05`, `Mar 2024` and `5 Mar 2024`. Returns milliseconds since the epoch, or `nil`.
public func parseChartDate(_ label: String) -> Double? {
    let text = label.jsTrimmed
    if let m = matchGroups(#"^([0-9]{4})$"#, in: text), let y = Int(m[1]) {
        return dateUTC(y, 0, 1)
    }
    if let m = matchGroups(#"^([0-9]{4})[-/]([0-9]{1,2})$"#, in: text),
       let y = Int(m[1]), let mo = Int(m[2]) {
        return valid(y, mo - 1, 1)
    }
    if let m = matchGroups(#"^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})(?:[T ]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?(?:\.([0-9]+))?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$"#, in: text),
       let y = Int(m[1]), let mo = Int(m[2]), let d = Int(m[3]) {
        if !m[4].isEmpty {
            // JS `Date.parse(text.replace(' ', 'T').replace(/\//g, '-') + (m[7] ? '' : 'Z'))`:
            // ECMA-262 ISO date-time requires 2-digit month/day/hour and valid ranges.
            guard m[2].count == 2, m[3].count == 2, m[4].count == 2,
                  let baseMs = valid(y, mo - 1, d),
                  let hh = Int(m[4]), let mm = Int(m[5]) else {
                return nil
            }
            let ss = m[6].isEmpty ? 0 : (Int(m[6]) ?? -1)
            if hh < 0 || hh > 24 || mm < 0 || mm > 59 || ss < 0 || ss > 59 { return nil }
            if hh == 24 && (mm != 0 || ss != 0 || !m[7].isEmpty) { return nil }
            var subMs = 0.0
            if !m[7].isEmpty {
                let fracStr = String((m[7] + "000").prefix(3))
                subMs = Double(Int(fracStr) ?? 0)
            }
            var offsetMs = 0.0
            let tz = m[8]
            if !tz.isEmpty && tz != "Z" {
                let sign: Double = tz.hasPrefix("-") ? -1.0 : 1.0
                let digits = tz.dropFirst().replacingOccurrences(of: ":", with: "")
                guard digits.count == 4,
                      let tzH = Int(digits.prefix(2)),
                      let tzM = Int(digits.suffix(2)),
                      tzH <= 23, tzM <= 59 else {
                    return nil
                }
                offsetMs = sign * Double(tzH * 3_600_000 + tzM * 60_000)
            }
            let timeMs = Double(hh * 3_600_000 + mm * 60_000 + ss * 1000) + subMs
            return baseMs + timeMs - offsetMs
        }
        return valid(y, mo - 1, d)
    }
    if let m = matchGroups(#"^(?:([0-9]{1,2})\s+)?([A-Za-z]{3})[a-z]*\.?,?\s+([0-9]{4})$"#, in: text),
       let y = Int(m[3]) {
        let m2Lower = m[2].lowercased()
        if let month = MONTHS.firstIndex(where: { $0.lowercased() == m2Lower }) {
            let day = m[1].isEmpty ? 1 : (Int(m[1]) ?? 1)
            return valid(y, month, day)
        }
    }
    return nil
}

public enum ChartDateUnit: String, Sendable, Equatable {
    case day
    case week
    case month
    case year
}

public struct ChartDateStep: Sendable, Equatable {
    public var unit: ChartDateUnit
    public var count: Int

    public init(unit: ChartDateUnit, count: Int) {
        self.unit = unit
        self.count = count
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("unit", .string(unit.rawValue)),
            ("count", .number(Double(count)))
        ]))
    }
}

/// Calendar steps from fine to coarse.
public let CHART_DATE_STEPS: [ChartDateStep] = [
    ChartDateStep(unit: .day, count: 1),
    ChartDateStep(unit: .day, count: 2),
    ChartDateStep(unit: .week, count: 1),
    ChartDateStep(unit: .week, count: 2),
    ChartDateStep(unit: .month, count: 1),
    ChartDateStep(unit: .month, count: 3),
    ChartDateStep(unit: .month, count: 6),
    ChartDateStep(unit: .year, count: 1),
    ChartDateStep(unit: .year, count: 2),
    ChartDateStep(unit: .year, count: 5),
    ChartDateStep(unit: .year, count: 10),
    ChartDateStep(unit: .year, count: 25),
    ChartDateStep(unit: .year, count: 50),
    ChartDateStep(unit: .year, count: 100)
]

private func bucket(_ t: Double, _ step: ChartDateStep) -> Int {
    let d = utcParts(t)
    let y = d.year
    let count = Double(step.count)
    switch step.unit {
    case .day:
        return Int(floor(floor(t / 86_400_000.0) / count))
    case .week:
        return Int(floor(floor((t / 86_400_000.0 - 4.0) / 7.0) / count))
    case .month:
        return Int(floor(Double(y * 12 + d.month0) / count))
    case .year:
        return Int(floor(Double(y) / count))
    }
}

/// A label for a date at `step`: years as `2024`, months as `Mar 2024` (`Mar` within a year), days as `5 Mar`.
public func formatChartDate(_ t: Double, _ step: ChartDateStep, _ previous: Double? = nil) -> String {
    let d = utcParts(t)
    let y = d.year
    let mo = MONTHS[d.month0]
    let sameYear = previous != nil && utcParts(previous!).year == y
    if step.unit == .year { return String(y) }
    if step.unit == .month { return sameYear ? mo : "\(mo) \(y)" }
    return sameYear ? "\(d.day) \(mo)" : "\(d.day) \(mo) \(y)"
}

public struct ChartDateLabels: Sendable, Equatable {
    public var step: ChartDateStep
    public var indexes: [Int]
    public var labels: [Int: String]

    public init(step: ChartDateStep, indexes: [Int], labels: [Int: String]) {
        self.step = step
        self.indexes = indexes
        self.labels = labels
    }

    public func toJSON() -> JSONValue {
        let labelEntries = indexes.map { i -> JSONValue in
            .array([.number(Double(i)), .string(labels[i] ?? "")])
        }
        return .object(JSONObject([
            ("step", step.toJSON()),
            ("indexes", .array(indexes.map { .number(Double($0)) })),
            ("labels", .array(labelEntries))
        ]))
    }
}

/// Picks the finest calendar step whose labels fit along a category axis.
public func chartDateLabels(
    _ categories: [String],
    _ band: Double,
    _ measure: (String) -> Double,
    _ gap: Double = 10
) -> ChartDateLabels? {
    let times = categories.map(parseChartDate)
    let validCount = times.compactMap { $0 }.count
    if Double(validCount) < Swift.max(1.0, Double(categories.count) / 2.0) {
        return nil
    }
    let present = times.compactMap { $0 }.sorted()
    var gaps: [Double] = []
    if present.count > 1 {
        for i in 0..<(present.count - 1) {
            let g = present[i + 1] - present[i]
            if g > 0 { gaps.append(g) }
        }
    }
    gaps.sort()
    let spacing = !gaps.isEmpty ? gaps[gaps.count / 2] : 0.0
    let dayMs = 86_400_000.0
    func stepLength(_ step: ChartDateStep) -> Double {
        let mult: Double
        switch step.unit {
        case .day: mult = dayMs
        case .week: mult = 7.0 * dayMs
        case .month: mult = 30.0 * dayMs
        case .year: mult = 365.0 * dayMs
        }
        return Double(step.count) * mult
    }
    let lastStep = CHART_DATE_STEPS.last!
    for step in CHART_DATE_STEPS {
        if stepLength(step) < spacing * 0.5 && step != lastStep {
            continue
        }
        var indexes: [Int] = []
        var labels: [Int: String] = [:]
        var last: Int?
        var lastTime: Double?
        for (i, tOpt) in times.enumerated() {
            guard let t = tOpt else { continue }
            let b = bucket(t, step)
            if b == last { continue }
            last = b
            indexes.append(i)
            labels[i] = formatChartDate(t, step, lastTime)
            lastTime = t
        }
        var fits = true
        if indexes.count > 1 {
            for k in 1..<indexes.count {
                if !fits { break }
                let a = labels[indexes[k - 1]] ?? ""
                let b = labels[indexes[k]] ?? ""
                if Double(indexes[k] - indexes[k - 1]) * band < (measure(a) + measure(b)) / 2.0 + gap {
                    fits = false
                }
            }
        }
        if fits || step == lastStep {
            return ChartDateLabels(step: step, indexes: indexes, labels: labels)
        }
    }
    return nil
}

private func matchGroups(_ pattern: String, in text: String) -> [String]? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
    let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = regex.firstMatch(in: text, options: [], range: nsRange) else { return nil }
    var out: [String] = []
    for i in 0..<match.numberOfRanges {
        let r = match.range(at: i)
        if let swiftRange = Range(r, in: text) {
            out.append(String(text[swiftRange]))
        } else {
            out.append("")
        }
    }
    return out
}
