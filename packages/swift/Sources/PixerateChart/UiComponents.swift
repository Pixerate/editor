import Foundation
import PixerateCore
import PixerateRaster

// Chart types offered as UI components (#819): the Swift side of `uiComponents()` in
// `chart/ui-components.ts`, for the types listed in `CHART_UI_SWIFT_READY` (sparkline, bar chart,
// line chart, donut chart). Each one's descriptor (data JSON Schema, colour roles, accessibility,
// sizing, example, `contentHash`) comes from the chart contracts (`ui-components.json`), and its
// render matches the TypeScript render byte for byte (`chart-ui-components-vectors.json`), so the
// descriptor's content hash describes this output too.

/// Light or dark, as a UI component is drawn.
public enum ChartUiThemeMode: String, CaseIterable, Sendable, Equatable {
    case light
    case dark
}

/// How a chart UI component is drawn: size in CSS px (1–4096), theme, and colours by role.
public struct ChartUiRenderOptions: Sendable, Equatable {
    public var width: Double
    public var height: Double
    public var theme: ChartUiThemeMode
    /// Role → CSS colour; roles the type does not use are ignored, values are trimmed.
    public var colors: [String: String]

    public init(width: Double, height: Double, theme: ChartUiThemeMode = .light, colors: [String: String] = [:]) {
        self.width = width
        self.height = height
        self.theme = theme
        self.colors = colors
    }
}

/// A refusal: invalid data or size, with the same message as the TypeScript render.
public struct ChartUiError: Error, Equatable, Sendable, CustomStringConvertible {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// A laid-out chart UI component: the scene to draw and its accessible name and description.
public struct ChartUiDrawing: Sendable {
    public var scene: ChartScene
    public var ariaLabel: String
    public var description: String
}

/// `ACCENT_PALETTE_MIN_DISTANCE`: palette colours closer than this (OKLab ΔE) to the accent are dropped.
public let CHART_ACCENT_PALETTE_MIN_DISTANCE = 0.1

/// `chartPaletteWithAccent`: the accent first, then the palette after its first colour without
/// colours too close to the accent to tell apart.
public func chartPaletteWithAccent(_ accent: String, _ palette: [String] = DEFAULT_CHART_PALETTE) -> [String] {
    let a = parseCssColor(accent)
    let rest = palette.dropFirst().filter { color in
        guard let a, let c = parseCssColor(color) else { return true }
        let la = cssRgbToOklab(a)
        let lc = cssRgbToOklab(c)
        return JS.hypot(la.l - lc.l, la.a - lc.a, la.b - lc.b) >= CHART_ACCENT_PALETTE_MIN_DISTANCE
    }
    return [accent] + rest
}

/// One chart type as a UI component.
public struct ChartUiComponent: Sendable {
    public var id: String
    public var title: String
    public var description: String
    /// The `UiDescriptor` (schemas), as the TypeScript `uiComponents()` gives it.
    public var descriptor: JSONValue
    /// What each colour role colours.
    public var colorRoleUse: [String: String]
    /// The colours each role takes when none is given.
    public var defaultColors: [ChartUiThemeMode: [String: String]]
    /// The size the descriptor's example is drawn at for its content hash.
    public var exampleSize: (width: Double, height: Double)

    /// The roles the type draws with (`contract.colorRoles`).
    public var colorRoles: [String] {
        descriptor["contract"]?["colorRoles"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    /// The JSON Schema of the type's data (`contract.props`).
    public var propsSchema: JSONValue? { descriptor["contract"]?["props"] }

    /// The descriptor's example data.
    public var example: JSONValue { descriptor["example"] ?? .object(JSONObject()) }

    /// Lays `data` out at the options' size, theme and colours, for a SwiftUI canvas
    /// (`drawChartSceneInCanvas`) or for `chartSceneToSvg`.
    public func drawing(_ data: JSONValue, _ options: ChartUiRenderOptions) throws -> ChartUiDrawing {
        try check(data, options)
        let c = roleColors(options)
        let accent = c["accent"] ?? DEFAULT_CHART_PALETTE[0]
        switch id {
        case "sparkline":
            let values = (data["values"]?.arrayValue ?? []).map(\.numberValue)
            let label = data["label"]?.stringValue ?? ""
            let spec = createChartSpec([
                "type": "line",
                "title": .string(label),
                "categories": .array(values.indices.map { .string(String($0 + 1)) }),
                "series": [["id": "s1", "name": .string(label.isEmpty ? "Values" : label), "values": .array(values.map { $0.map(JSONValue.number) ?? .null })]]
            ])
            let description = describeChart(spec)
            let scene = layoutSparkline(values, ChartSparklineOptions(kind: .line, width: options.width, height: options.height, color: accent))
            return ChartUiDrawing(scene: scene, ariaLabel: label.isEmpty ? description : label, description: description)
        case "bar-chart", "line-chart":
            let categories = data["categories"]?.arrayValue ?? []
            let series = data["series"]?.arrayValue ?? []
            for s in series {
                let n = s["values"]?.arrayValue?.count ?? 0
                if n != categories.count {
                    throw ChartUiError("\(id): series \"\(s["name"]?.stringValue ?? "")\" has \(n) values for \(categories.count) categories; give one value per category.")
                }
            }
            let unit = data["unit"]?.stringValue ?? ""
            let spec = createChartSpec([
                "type": .string(id == "bar-chart" ? "bar" : "line"),
                "title": .string(data["title"]?.stringValue ?? ""),
                "categories": .array(categories),
                "series": .array(series.enumerated().map { i, s in
                    ["id": .string("s\(i + 1)"), "name": s["name"] ?? "", "values": s["values"] ?? []]
                }),
                "palette": .array(chartPaletteWithAccent(accent).map(JSONValue.string)),
                "legend": ["show": .bool(series.count > 1)],
                "yAxis": ["format": unit.isEmpty ? [:] : ["suffix": .string(unit)]]
            ])
            let theme = ChartThemePatch(background: c["surface"], surface: c["surface"], text: c["ink"], mutedText: c["ink-muted"], grid: c["border"], axis: c["ink-muted"])
            return chartDrawing(spec, options, theme, title: data["title"]?.stringValue)
        case "donut-chart":
            let slices = data["slices"]?.arrayValue ?? []
            let title = data["title"]?.stringValue ?? ""
            let unit = data["unit"]?.stringValue ?? ""
            let spec = createChartSpec([
                "type": "donut",
                "title": .string(title),
                "categories": .array(slices.map { $0["label"] ?? "" }),
                "series": [["id": "s1", "name": .string(title.isEmpty ? "Values" : title), "values": .array(slices.map { $0["value"] ?? .null })]],
                "palette": .array(chartPaletteWithAccent(accent).map(JSONValue.string)),
                // Beside the ring when there is width for it, so the ring takes the height.
                "legend": ["show": true, "position": .string(options.width >= options.height * 1.2 ? "right" : "bottom")],
                "yAxis": ["format": unit.isEmpty ? [:] : ["suffix": .string(unit)]]
            ])
            let ink = c["ink"]
            let theme = ChartThemePatch(background: c["surface"], surface: c["surface"], text: ink, mutedText: ink, grid: ink, axis: ink)
            return chartDrawing(spec, options, theme, title: title)
        default:
            throw ChartUiError("\(id): not drawn in Swift.")
        }
    }

    /// Draws `data` as a standalone, accessible SVG document: the same string the TypeScript
    /// `render` gives for the same data and options.
    public func render(_ data: JSONValue, _ options: ChartUiRenderOptions) throws -> String {
        let d = try drawing(data, options)
        return chartSceneToSvg(d.scene, ChartSvgOptions(ariaLabel: d.ariaLabel, description: d.description))
    }

    /// The same data as the type named in `descriptor.fallback` (a `table`): the
    /// `{ implements, props }` the TypeScript `fallback(data)` gives, for where a drawing can't
    /// be shown. Throws on invalid data, as `render` does.
    public func fallback(_ data: JSONValue) throws -> JSONValue {
        try checkData(data)
        func caption(_ title: String?, _ unit: String?) -> String? {
            let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let u = unit?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if u.isEmpty { return t.isEmpty ? nil : t }
            return "\(t.isEmpty ? "Values" : t) (\(u))"
        }
        var columns: [String]
        var rows: [[JSONValue]]
        var title: String?
        switch id {
        case "sparkline":
            let label = data["label"]?.stringValue ?? ""
            title = label.isEmpty ? nil : label
            columns = ["#", label.isEmpty ? "Value" : label]
            rows = (data["values"]?.arrayValue ?? []).enumerated().map { i, v in [.number(Double(i + 1)), v] }
        case "bar-chart", "line-chart":
            let categories = data["categories"]?.arrayValue ?? []
            let series = data["series"]?.arrayValue ?? []
            for s in series {
                let n = s["values"]?.arrayValue?.count ?? 0
                if n != categories.count {
                    throw ChartUiError("\(id): series \"\(s["name"]?.stringValue ?? "")\" has \(n) values for \(categories.count) categories; give one value per category.")
                }
            }
            title = caption(data["title"]?.stringValue, data["unit"]?.stringValue)
            columns = [""] + series.map { $0["name"]?.stringValue ?? "" }
            rows = categories.enumerated().map { i, c in [c] + series.map { $0["values"]?.arrayValue?[i] ?? .null } }
        case "donut-chart":
            title = caption(data["title"]?.stringValue, data["unit"]?.stringValue)
            columns = ["", "Value"]
            rows = (data["slices"]?.arrayValue ?? []).map { [$0["label"] ?? "", $0["value"] ?? .null] }
        default:
            throw ChartUiError("\(id): no fallback in Swift.")
        }
        var props = JSONObject()
        if let title { props["caption"] = .string(title) }
        props["columns"] = .array(columns.map(JSONValue.string))
        props["rows"] = .array(rows.map(JSONValue.array))
        props["rowHeaders"] = true
        return ["implements": "table", "props": .object(props)]
    }

    private func chartDrawing(_ spec: ChartSpec, _ options: ChartUiRenderOptions, _ theme: ChartThemePatch, title: String?) -> ChartUiDrawing {
        let scene = layoutChart(spec, ChartLayoutOptions(width: options.width, height: options.height, theme: theme))
        let description = describeChart(spec)
        let label = (title?.isEmpty == false) ? title! : description
        return ChartUiDrawing(scene: scene, ariaLabel: label, description: description)
    }

    private func checkData(_ data: JSONValue) throws {
        let errors = validateJSONSchema(data, propsSchema)
        if !errors.isEmpty {
            throw ChartUiError("\(id): invalid data: \(errors.map { "\($0.path.isEmpty ? "/" : $0.path) \($0.message)" }.joined(separator: "; "))")
        }
    }

    private func check(_ data: JSONValue, _ options: ChartUiRenderOptions) throws {
        try checkData(data)
        for (name, v) in [("width", options.width), ("height", options.height)] where !(v.isFinite && v >= 1 && v <= 4096) {
            throw ChartUiError("\(id): \(name) must be a number of CSS px from 1 to 4096 (got \(JSONValue.jsString(v))).")
        }
    }

    private func roleColors(_ options: ChartUiRenderOptions) -> [String: String] {
        var out = defaultColors[options.theme] ?? [:]
        let roles = colorRoles
        for (role, color) in options.colors {
            let trimmed = color.trimmingCharacters(in: .whitespacesAndNewlines)
            if roles.contains(role), !trimmed.isEmpty { out[role] = trimmed }
        }
        return out
    }
}

/// The chart types the Swift package draws as UI components, in the order `uiComponents()` lists
/// them: `sparkline`, `bar-chart`, `line-chart` and `donut-chart`.
public func chartUiComponents() throws -> [ChartUiComponent] {
    guard let list = try ChartContracts.json("ui-components.json")["components"]?.arrayValue else {
        throw ContractError("ui-components.json must have a components array.")
    }
    return try list.map { item in
        guard let id = item["id"]?.stringValue, let descriptor = item["descriptor"],
              let w = item["exampleSize"]?["width"]?.numberValue, let h = item["exampleSize"]?["height"]?.numberValue
        else { throw ContractError("ui-components.json: each component needs an id, a descriptor and an exampleSize.") }
        let strings = { (v: JSONValue?) -> [String: String] in
            var out: [String: String] = [:]
            for (k, v) in v?.objectValue ?? JSONObject() { if let s = v.stringValue { out[k] = s } }
            return out
        }
        return ChartUiComponent(
            id: id,
            title: item["title"]?.stringValue ?? id,
            description: item["description"]?.stringValue ?? "",
            descriptor: descriptor,
            colorRoleUse: strings(item["colorRoleUse"]),
            defaultColors: [.light: strings(item["defaultColors"]?["light"]), .dark: strings(item["defaultColors"]?["dark"])],
            exampleSize: (w, h)
        )
    }
}
