import Foundation
import PixerateCore
import PixerateRaster

public enum ChartTooltipMode: String, CaseIterable, Sendable, Equatable {
    case point
    case category
}

public struct ChartTooltipItem: Sendable, Equatable {
    public var seriesId: String
    public var name: String
    public var color: String
    public var value: ChartValue
    public var share: Double?
    public var text: String

    public init(
        seriesId: String,
        name: String,
        color: String,
        value: ChartValue,
        share: Double? = nil,
        text: String
    ) {
        self.seriesId = seriesId
        self.name = name
        self.color = color
        self.value = value
        self.share = share
        self.text = text
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject([
            ("seriesId", .string(seriesId)),
            ("name", .string(name)),
            ("color", .string(color)),
            ("value", value.map(JSONValue.number) ?? .null)
        ])
        if let share { obj["share"] = .number(share) }
        obj["text"] = .string(text)
        return .object(obj)
    }
}

public struct ChartTooltip: Sendable, Equatable {
    public var title: String
    public var index: Int
    public var items: [ChartTooltipItem]
    public var x: Double
    public var y: Double

    public init(title: String, index: Int, items: [ChartTooltipItem], x: Double, y: Double) {
        self.title = title
        self.index = index
        self.items = items
        self.x = x
        self.y = y
    }

    public func toJSON() -> JSONValue {
        .object(JSONObject([
            ("title", .string(title)),
            ("index", .number(Double(index))),
            ("items", .array(items.map { $0.toJSON() })),
            ("x", .number(x)),
            ("y", .number(y))
        ]))
    }
}

public struct ChartTooltipOptions: Sendable {
    public var mode: ChartTooltipMode?
    public var measureText: ChartTextMeasure?

    public init(mode: ChartTooltipMode? = nil, measureText: ChartTextMeasure? = nil) {
        self.mode = mode
        self.measureText = measureText
    }
}

private let VALUE_FAMILIES: Set<ChartFamily> = [
    .cartesian, .xy, .pie, .radar, .waterfall, .funnel, .parliament, .slope, .streamgraph
]

private let SLICE_FAMILIES: Set<ChartFamily> = [
    .pie, .funnel, .parliament
]

private func valueFormat(_ spec: ChartSpec, _ series: ChartSeries) -> ChartNumberFormat {
    series.format ?? (series.axis == .secondary ? spec.yAxis2.format : spec.yAxis.format)
}

private func percentText(_ share: Double) -> String {
    formatChartNumber(share, ChartNumberFormat(style: .percent, decimals: share < 0.1 ? 1 : 0))
}

private func makeTooltipItem(_ spec: ChartSpec, _ seriesIndex: Int, _ index: Int, _ share: Double?) -> ChartTooltipItem {
    let family = chartFamily(spec)
    let series = spec.series[seriesIndex]
    let value: ChartValue = (index >= 0 && index < series.values.count) ? series.values[index] : nil
    let slice = SLICE_FAMILIES.contains(family)
    var text = formatChartNumber(value, valueFormat(spec, series))
    if family == .xy, let xs = series.x, index >= 0, index < xs.count, let x = xs[index] {
        text = "\(formatChartNumber(x, spec.xAxis.format)), \(text)"
    }
    if let share {
        text = "\(text) (\(percentText(share)))"
    }
    let name: String
    if slice {
        name = (index >= 0 && index < spec.categories.count) ? spec.categories[index] : series.name
    } else {
        name = series.name
    }
    let color: String
    if slice {
        if let pc = series.pointColors, index >= 0, index < pc.count, let c = pc[index], !c.isEmpty {
            color = c
        } else {
            color = chartSliceColor(spec, index)
        }
    } else {
        color = chartPointColor(spec, seriesIndex, index)
    }
    return ChartTooltipItem(
        seriesId: series.id,
        name: name,
        color: color,
        value: value,
        share: share,
        text: text
    )
}

/// What a tooltip shows for one category: the category label and each visible series' value there.
public func chartTooltipFor(
    _ spec: ChartSpec,
    _ index: Int,
    _ seriesId: String? = nil,
    _ anchor: (x: Double, y: Double) = (x: 0, y: 0)
) -> ChartTooltip? {
    let family = chartFamily(spec)
    guard VALUE_FAMILIES.contains(family) else { return nil }
    let maxLen = spec.series.reduce(spec.categories.count) { Swift.max($0, $1.values.count) }
    guard index >= 0 && index < maxLen else { return nil }
    let visible = spec.series.enumerated().filter { _, s in
        !(s.hidden ?? false) && (seriesId == nil || s.id == seriesId)
    }
    let present = visible.filter { _, s in
        guard index < s.values.count, let v = s.values[index] else { return false }
        return v.isFinite
    }
    guard !present.isEmpty else { return nil }
    func shareOf(_ s: ChartSeries) -> Double? {
        guard index < s.values.count, let v = s.values[index] else { return nil }
        if spec.stacking == .percent && family == .cartesian {
            let total = spec.series
                .filter { !($0.hidden ?? false) && $0.axis == s.axis }
                .reduce(0.0) { sum, t in
                    let tv = (index < t.values.count ? t.values[index] : nil) ?? 0.0
                    return sum + abs(tv)
                }
            return total != 0 ? abs(v) / total : nil
        }
        if family == .pie {
            let total = s.values.reduce(0.0) { sum, tOpt in
                guard let t = tOpt, t > 0 else { return sum }
                return sum + t
            }
            return (total != 0 && v > 0) ? v / total : nil
        }
        return nil
    }
    let items = present.map { i, s in makeTooltipItem(spec, i, index, shareOf(s)) }
    let catLabel = index < spec.categories.count ? spec.categories[index] : ""
    let title: String
    if family == .xy {
        title = !catLabel.isEmpty ? catLabel : present[0].element.name
    } else {
        title = catLabel
    }
    return ChartTooltip(title: title, index: index, items: items, x: anchor.x, y: anchor.y)
}

/// The tooltip at a scene point (for hover), or `nil` when the pointer is over nothing with a value.
public func chartTooltipAt(
    _ spec: ChartSpec,
    _ scene: ChartScene,
    _ point: (x: Double, y: Double),
    _ options: ChartTooltipOptions = ChartTooltipOptions()
) -> ChartTooltip? {
    if options.mode == .category && scene.categoryScale != nil {
        if let index = chartCategoryAtPoint(scene, point) {
            return chartTooltipFor(spec, index, nil, point)
        }
    }
    let target = chartHitTest(scene, point, options.measureText ?? estimateChartTextWidth)
    if case .point(let seriesId, let index) = target {
        return chartTooltipFor(spec, index, seriesId, point)
    }
    if case .category(let index) = target, scene.categoryScale != nil, options.mode == .category {
        return chartTooltipFor(spec, index, nil, point)
    }
    return nil
}

/// Whether two tooltips show the same thing.
public func sameChartTooltip(_ a: ChartTooltip?, _ b: ChartTooltip?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    guard a.index == b.index && a.items.count == b.items.count else { return false }
    for (itA, itB) in zip(a.items, b.items) {
        if itA.seriesId != itB.seriesId || itA.text != itB.text { return false }
    }
    return true
}
