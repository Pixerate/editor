import Foundation
import PixerateContracts
import PixerateCore

/// The chart domain's contracts (`@pixerate/conformance` `domains/chart`), read from the bundled
/// files: every command agents run with `run_command` (id, label, group, keywords, description,
/// params schema and flags), the tool providers and the JSON Schema of a saved chart. The
/// TypeScript core writes them (`chartContracts` in `chart/contract.ts`).
public enum ChartContracts {
    /// A contract file of the chart domain as JSON (`commands.json`, `tools.json`, …).
    public static func json(_ file: String) throws -> JSONValue {
        try JSONValue.parse(ConformanceContracts.data("domains/chart/\(file)"))
    }

    /// The commands, in the order `createChartCommands` registers them.
    public static func commands() throws -> [ChartCommandContract] {
        guard let list = try json("commands.json").arrayValue else { throw ContractError("commands.json must be an array.") }
        return try list.map(ChartCommandContract.init(json:))
    }

    /// The tool providers (`chart-commands`, `chart-editor`) and their tools.
    public static func toolProviders() throws -> [ToolProviderContract] {
        try ToolProviderContract.providers(json: json("tools.json"))
    }

    /// All tool definitions across the chart tool providers.
    public static func tools() throws -> [McpToolDefinition] {
        try toolProviders().flatMap(\.tools)
    }

    /// The JSON Schema of a saved chart (the `pixerate.editor-document` envelope of kind `chart`).
    public static func documentSchema() throws -> JSONValue {
        try json("document.schema.json")
    }

    /// The UI tables (`ui.json`): layout presets, colour schemes, palette shades, error bar types, and option lists.
    public static func ui() throws -> ChartUITables {
        try ChartUITables(json: json("ui.json"))
    }
}

/// The error bar tables in `ui.json`.
public struct ChartErrorBarTables: Equatable, Sendable {
    public var types: [String]
    public var directions: [String]
    public var labels: [String: String]

    public init(types: [String] = [], directions: [String] = [], labels: [String: String] = [:]) {
        self.types = types
        self.directions = directions
        self.labels = labels
    }

    public init(json value: JSONValue?) {
        let obj = value?.objectValue ?? JSONObject()
        self.types = obj["types"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.directions = obj["directions"]?.arrayValue?.compactMap(\.stringValue) ?? []
        var lbls: [String: String] = [:]
        if let lo = obj["labels"]?.objectValue {
            for (k, v) in lo {
                if let s = v.stringValue { lbls[k] = s }
            }
        }
        self.labels = lbls
    }
}

/// The UI tables in `domains/chart/ui.json`.
public struct ChartUITables: Equatable, Sendable {
    public var layoutPresets: [ChartLayoutPreset]
    public var colorSchemes: [ChartColorScheme]
    public var errorBars: ChartErrorBarTables
    public var paletteShades: [Double]
    public var types: [String]
    public var typeLabels: [String: String]
    public var seriesTypes: [String]
    public var stackings: [String]
    public var orientations: [String]
    public var curves: [String]
    public var markers: [String]
    public var labelPositions: [String]
    public var legendPositions: [String]
    public var numberStyles: [String]
    public var trendlineTypes: [String]
    public var axisKinds: [String]
    public var axisScales: [String]
    public var radarGraticules: [String]
    public var likertNeutrals: [String]
    public var likertSorts: [String]
    public var sankeyLinkColors: [String]
    public var referenceAxes: [String]
    public var defaultPalette: [String]

    public init(json value: JSONValue) throws {
        guard let o = value.objectValue else { throw ContractError("ui.json must be an object.") }
        self.layoutPresets = (o["layoutPresets"]?.arrayValue ?? []).compactMap { item -> ChartLayoutPreset? in
            guard let obj = item.objectValue,
                  let id = obj["id"]?.stringValue,
                  let label = obj["label"]?.stringValue,
                  let description = obj["description"]?.stringValue,
                  let patch = obj["patch"]?.objectValue else { return nil }
            return ChartLayoutPreset(id: id, label: label, description: description, patch: patch)
        }
        self.colorSchemes = (o["colorSchemes"]?.arrayValue ?? []).compactMap { item -> ChartColorScheme? in
            guard let obj = item.objectValue,
                  let id = obj["id"]?.stringValue,
                  let label = obj["label"]?.stringValue,
                  let description = obj["description"]?.stringValue,
                  let palette = obj["palette"]?.arrayValue?.compactMap(\.stringValue) else { return nil }
            return ChartColorScheme(id: id, label: label, description: description, palette: palette)
        }
        self.errorBars = ChartErrorBarTables(json: o["errorBars"])
        self.paletteShades = o["paletteShades"]?.arrayValue?.compactMap(\.doubleValue) ?? []
        self.types = o["types"]?.arrayValue?.compactMap(\.stringValue) ?? []
        var tLabels: [String: String] = [:]
        if let tlo = o["typeLabels"]?.objectValue {
            for (k, v) in tlo {
                if let s = v.stringValue { tLabels[k] = s }
            }
        }
        self.typeLabels = tLabels
        self.seriesTypes = o["seriesTypes"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.stackings = o["stackings"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.orientations = o["orientations"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.curves = o["curves"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.markers = o["markers"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.labelPositions = o["labelPositions"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.legendPositions = o["legendPositions"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.numberStyles = o["numberStyles"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.trendlineTypes = o["trendlineTypes"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.axisKinds = o["axisKinds"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.axisScales = o["axisScales"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.radarGraticules = o["radarGraticules"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.likertNeutrals = o["likertNeutrals"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.likertSorts = o["likertSorts"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.sankeyLinkColors = o["sankeyLinkColors"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.referenceAxes = o["referenceAxes"]?.arrayValue?.compactMap(\.stringValue) ?? []
        self.defaultPalette = o["defaultPalette"]?.arrayValue?.compactMap(\.stringValue) ?? []
    }
}

/// One command of `commands.json`.
public struct ChartCommandContract: Equatable, Sendable {
    public var id: String
    public var label: String
    public var group: String?
    public var keywords: [String]?
    public var description: String?
    /// The params schema, or nil for a command that takes none (`run_command` refuses any).
    public var params: JSONObject?
    /// Default shortcut(s) as written (`Mod` is ⌘ / Ctrl).
    public var shortcut: [String]
    public var scope: String?
    /// The spec runs in one history step (`undoable`; unset is false).
    public var undoable: Bool
    public var readOnly: Bool
    public var hidden: Bool

    public init(json value: JSONValue) throws {
        guard let o = value.objectValue, let id = o["id"]?.stringValue, let label = o["label"]?.stringValue else { throw ContractError("A command needs an id and a label.") }
        self.id = id
        self.label = label
        group = o["group"]?.stringValue
        keywords = o["keywords"]?.arrayValue?.compactMap(\.stringValue)
        description = o["description"]?.stringValue
        params = o["params"]?.objectValue
        switch o["shortcut"] {
        case .string(let s)?: shortcut = [s]
        case .array(let a)?: shortcut = a.compactMap(\.stringValue)
        default: shortcut = []
        }
        scope = o["scope"]?.stringValue
        undoable = o["undoable"]?.boolValue ?? false
        readOnly = o["readOnly"]?.boolValue ?? false
        hidden = o["hidden"]?.boolValue ?? false
    }
}
