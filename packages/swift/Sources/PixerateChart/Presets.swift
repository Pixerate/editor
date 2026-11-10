import Foundation
import PixerateCore

/// A partial change several fields at once (what `ChartController.update` takes).
public typealias ChartPresetPatch = JSONObject

public struct ChartLayoutPreset: Sendable, Equatable {
    public var id: String
    public var label: String
    public var description: String
    public var patch: ChartPresetPatch

    public init(id: String, label: String, description: String, patch: ChartPresetPatch) {
        self.id = id
        self.label = label
        self.description = description
        self.patch = patch
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("id", .string(id)),
            ("label", .string(label)),
            ("description", .string(description)),
            ("patch", .object(patch))
        ]))
    }
}

/// Quick layouts: legend, labels and grid lines set together.
public let CHART_LAYOUT_PRESETS: [ChartLayoutPreset] = [
    ChartLayoutPreset(
        id: "standard",
        label: "Standard",
        description: "Legend at the bottom, value grid lines, no data labels.",
        patch: JSONObject([
            ("legend", .object(JSONObject([("show", .bool(true)), ("position", .string("bottom"))]))),
            ("dataLabels", .bool(false)),
            ("xAxis", .object(JSONObject([("gridlines", .bool(false)), ("show", .bool(true))]))),
            ("yAxis", .object(JSONObject([("gridlines", .bool(true)), ("show", .bool(true))])))
        ])
    ),
    ChartLayoutPreset(
        id: "minimal",
        label: "Minimal",
        description: "No legend, grid lines or axis titles; the data speaks.",
        patch: JSONObject([
            ("legend", .object(JSONObject([("show", .bool(false))]))),
            ("dataLabels", .bool(false)),
            ("xAxis", .object(JSONObject([("gridlines", .bool(false)), ("title", .string(""))]))),
            ("yAxis", .object(JSONObject([("gridlines", .bool(false)), ("title", .string(""))])))
        ])
    ),
    ChartLayoutPreset(
        id: "labelled",
        label: "Labelled",
        description: "Values written on the marks, no value axis or grid lines.",
        patch: JSONObject([
            ("dataLabels", .bool(true)),
            ("labelPosition", .string("auto")),
            ("yAxis", .object(JSONObject([("show", .bool(false)), ("gridlines", .bool(false))]))),
            ("xAxis", .object(JSONObject([("gridlines", .bool(false))])))
        ])
    ),
    ChartLayoutPreset(
        id: "legend-right",
        label: "Legend on the right",
        description: "Legend beside the plot, value grid lines.",
        patch: JSONObject([
            ("legend", .object(JSONObject([("show", .bool(true)), ("position", .string("right"))]))),
            ("yAxis", .object(JSONObject([("gridlines", .bool(true))])))
        ])
    ),
    ChartLayoutPreset(
        id: "presentation",
        label: "Presentation",
        description: "Legend on top, data labels, light grid.",
        patch: JSONObject([
            ("legend", .object(JSONObject([("show", .bool(true)), ("position", .string("top"))]))),
            ("dataLabels", .bool(true)),
            ("yAxis", .object(JSONObject([("gridlines", .bool(true))]))),
            ("xAxis", .object(JSONObject([("gridlines", .bool(false))])))
        ])
    ),
    ChartLayoutPreset(
        id: "analysis",
        label: "Analysis",
        description: "Grid lines on both axes, point markers, legend at the bottom.",
        patch: JSONObject([
            ("legend", .object(JSONObject([("show", .bool(true)), ("position", .string("bottom"))]))),
            ("points", .bool(true)),
            ("dataLabels", .bool(false)),
            ("xAxis", .object(JSONObject([("gridlines", .bool(true))]))),
            ("yAxis", .object(JSONObject([("gridlines", .bool(true))])))
        ])
    )
]

public struct ChartColorScheme: Sendable, Equatable {
    public var id: String
    public var label: String
    public var description: String
    public var palette: [String]

    public init(id: String, label: String, description: String, palette: [String]) {
        self.id = id
        self.label = label
        self.description = description
        self.palette = palette
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("id", .string(id)),
            ("label", .string(label)),
            ("description", .string(description)),
            ("palette", .array(palette.map(JSONValue.string)))
        ]))
    }
}

/// Shades of one hue, dark to light (for monochrome schemes).
public func monochromeChartPalette(_ base: String, _ count: Int = 6) -> [String] {
    let steps: [Double] = count <= 1
        ? [0.0]
        : (0..<count).map { i in -0.45 + (1.05 * Double(i)) / Double(count - 1) }
    return steps.map { t in shadeChartColor(base, t) }
}

/// Named palettes. `default` and `okabe-ito` are colour-blind friendly.
public let CHART_COLOR_SCHEMES: [ChartColorScheme] = [
    ChartColorScheme(
        id: "default",
        label: "Default",
        description: "Ten distinct colours, readable on light and dark backgrounds.",
        palette: DEFAULT_CHART_PALETTE
    ),
    ChartColorScheme(
        id: "okabe-ito",
        label: "Okabe–Ito",
        description: "Eight colours chosen to stay distinct with colour-blindness.",
        palette: ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#000000"]
    ),
    ChartColorScheme(
        id: "office",
        label: "Office",
        description: "The six accent colours of the default Office theme.",
        palette: ["#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"]
    ),
    ChartColorScheme(
        id: "warm",
        label: "Warm",
        description: "Reds, oranges and yellows.",
        palette: ["#b2182b", "#d6604d", "#f4a582", "#e08214", "#fdb863", "#8c510a"]
    ),
    ChartColorScheme(
        id: "cool",
        label: "Cool",
        description: "Blues, teals and purples.",
        palette: ["#2166ac", "#4393c3", "#35978f", "#80cdc1", "#762a83", "#9970ab"]
    ),
    ChartColorScheme(
        id: "monochrome-blue",
        label: "Monochrome blue",
        description: "Shades of one blue.",
        palette: monochromeChartPalette("#4269d0")
    ),
    ChartColorScheme(
        id: "monochrome-green",
        label: "Monochrome green",
        description: "Shades of one green.",
        palette: monochromeChartPalette("#3ca951")
    ),
    ChartColorScheme(
        id: "monochrome-orange",
        label: "Monochrome orange",
        description: "Shades of one orange.",
        palette: monochromeChartPalette("#e8710a")
    ),
    ChartColorScheme(
        id: "monochrome-gray",
        label: "Monochrome grey",
        description: "Shades of grey.",
        palette: monochromeChartPalette("#6b7280")
    )
]

public enum ChartPresetPatchResult: Sendable, Equatable {
    case ok(ChartPresetPatch)
    case error(String)

    public func toJSON() -> JSONValue {
        switch self {
        case .ok(let patch):
            return .object(JSONObject([
                ("ok", .bool(true)),
                ("patch", .object(patch))
            ]))
        case .error(let message):
            return .object(JSONObject([
                ("ok", .bool(false)),
                ("message", .string(message))
            ]))
        }
    }
}

/// The change a named layout and / or colour scheme makes, or a sentence saying which names exist.
public func chartPresetPatch(layout: String? = nil, colors: String? = nil) -> ChartPresetPatchResult {
    var patch = ChartPresetPatch()
    if let layout {
        guard let preset = CHART_LAYOUT_PRESETS.first(where: { $0.id == layout }) else {
            let names = CHART_LAYOUT_PRESETS.map { "\"\($0.id)\"" }.joined(separator: ", ")
            return .error("There is no layout \"\(layout)\"; expected one of \(names).")
        }
        for (k, v) in preset.patch {
            patch[k] = v
        }
    }
    if let colors {
        guard let scheme = CHART_COLOR_SCHEMES.first(where: { $0.id == colors }) else {
            let names = CHART_COLOR_SCHEMES.map { "\"\($0.id)\"" }.joined(separator: ", ")
            return .error("There is no colour scheme \"\(colors)\"; expected one of \(names).")
        }
        patch["palette"] = .array(scheme.palette.map(JSONValue.string))
    }
    if layout == nil && colors == nil {
        return .error("Name a layout, a colour scheme or both.")
    }
    return .ok(patch)
}
