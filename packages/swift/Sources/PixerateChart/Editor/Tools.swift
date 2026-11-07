import Foundation
import PixerateCore
import PixerateRaster

extension ChartHeaderOption {
    internal static func from(_ v: JSONValue?) -> ChartHeaderOption? {
        guard let v else { return nil }
        switch v {
        case .bool(let b): return .bool(b)
        case .string(let s) where s == "auto": return .auto
        default: return nil
        }
    }
}

public struct ChartToolProviderOptions {
    public var id: String
    public var namespace: String
    public var readOnly: (() -> Any)?
    public var width: Double
    public var height: Double
    /// Turns SVG into an image so `render_chart` can return PNG (e.g. through CoreGraphics).
    public var rasterize: (@Sendable (String, (width: Double, height: Double)) async throws -> ChartRasterImage)?

    public init(
        id: String = "chart",
        namespace: String = "",
        readOnly: (() -> Any)? = nil,
        width: Double = 640,
        height: Double = 400,
        rasterize: (@Sendable (String, (width: Double, height: Double)) async throws -> ChartRasterImage)? = nil
    ) {
        self.id = id
        self.namespace = namespace
        self.readOnly = readOnly
        self.width = width
        self.height = height
        self.rasterize = rasterize
    }
}

public func createChartToolProvider(
    _ controller: ChartController,
    _ options: ChartToolProviderOptions = ChartToolProviderOptions()
) -> AgentToolProvider {
    let provider = ChartToolProviderImpl(controller: controller, options: options)
    return provider.asProvider()
}

final class ChartToolProviderImpl: @unchecked Sendable {
    let controller: ChartController
    let options: ChartToolProviderOptions
    let defsByName: [String: McpToolDefinition]

    init(controller: ChartController, options: ChartToolProviderOptions) {
        self.controller = controller
        self.options = options
        var map: [String: McpToolDefinition] = [:]
        for def in (try? ChartContracts.tools()) ?? [] {
            map[def.name] = def
        }
        self.defsByName = map
    }

    var size: (width: Double, height: Double) {
        (width: options.width, height: options.height)
    }

    func spec() -> ChartSpec {
        controller.getSpec()
    }

    func table() -> [[JSONValue]] {
        chartDataToTable(spec())
    }

    func tableJSON() -> JSONValue {
        .array(table().map(JSONValue.array))
    }

    func treeTable() -> JSONValue {
        let s = spec()
        let rows = chartTreeToRows(s.tree)
        let depth = chartTreeDepth(s.tree)
        let header: [JSONValue] = (0..<depth).map { k in
            .string(k == 0 ? "Group" : (k == depth - 1 ? "Item" : "Level \(k + 1)"))
        } + [.string("Value")]
        let body: [JSONValue] = rows.map { r in
            let paddedPath = r.path.map(JSONValue.string)
                + Array(repeating: JSONValue.string(""), count: Swift.max(0, depth - r.path.count))
            return .array(paddedPath + [.number(r.value)])
        }
        return .array([.array(header)] + body)
    }

    func readOnlyReason() -> String? {
        guard let ro = options.readOnly?() else { return nil }
        if let b = ro as? Bool {
            return b ? "This chart is read-only." : nil
        }
        if let s = ro as? String, !s.isEmpty {
            return s
        }
        return nil
    }

    func check(_ result: ChartActionResult) throws {
        if !result.ok {
            throw ToolExecutionError(result.message ?? "Chart operation failed.")
        }
    }

    func seriesById(_ ref: String) throws -> ChartSeries {
        let s = spec()
        if let found = s.series.first(where: { $0.id == ref }) ?? s.series.first(where: { $0.name == ref }) {
            return found
        }
        let list = s.series.map { "\"\($0.id)\" (\($0.name))" }.joined(separator: ", ")
        throw ToolExecutionError(
            "There is no series \"\(ref)\"; expected one of \(list.isEmpty ? "(none yet; add one with add_chart_series)" : list)."
        )
    }

    func categoryIndex(_ ref: JSONValue) throws -> Int {
        let categories = spec().categories
        let index: Int
        if case .number(let d) = ref, d.isFinite, floor(d) == d {
            index = Int(d)
        } else if let s = ref.stringValue {
            index = categories.firstIndex(of: s) ?? -1
        } else {
            index = -1
        }
        if index < 0 || index >= categories.count {
            let list = categories.prefix(20).map { JSONValue.string($0).stringified() }.joined(separator: ", ")
            throw ToolExecutionError(
                "There is no category \(ref.stringified()); expected an index from 0 to \(categories.count - 1) or one of \(list)."
            )
        }
        return index
    }

    func raceFrameOf(_ time: JSONValue) throws -> Double {
        let cats = spec().categories
        let frame: Double
        if case .number(let d) = time {
            frame = d
        } else if let s = time.stringValue {
            frame = Double(cats.firstIndex(of: s) ?? -1)
        } else {
            frame = .nan
        }
        if !(frame.isFinite && frame >= 0 && frame <= Double(cats.count - 1)) {
            let list = cats.prefix(20).map { JSONValue.string($0).stringified() }.joined(separator: ", ")
            throw ToolExecutionError(
                "There is no time point \(time.stringified()); expected an index from 0 to \(Swift.max(0, cats.count - 1)) or one of \(list)."
            )
        }
        return frame
    }

    func raceAt(_ frame: Double?) -> JSONValue {
        let s = spec()
        let at = frame ?? Double(s.categories.count - 1)
        let rIdx = Int(JS.round(at))
        let timeVal: JSONValue = (rIdx >= 0 && rIdx < s.categories.count) ? .string(s.categories[rIdx]) : .null
        let ranking = Array(chartRaceRanking(s, at).prefix(s.raceTopN)).map { e -> JSONValue in
            [
                "rank": .number(Double(e.rank + 1)),
                "series": .string(e.seriesId),
                "name": .string(e.name),
                "value": .number(e.value)
            ]
        }
        return [
            "frame": .number(at),
            "time": timeVal,
            "ranking": .array(ranking)
        ]
    }

    func treeSummary() -> JSONValue {
        let tree = spec().tree
        return [
            "tree": .array(tree.map { $0.toJSON() }),
            "groups": .array(tree.map { n in
                ["name": .string(n.name), "total": .number(chartTreeTotal(n))]
            }),
            "depth": .number(Double(chartTreeDepth(tree)))
        ]
    }

    func linksSummary() -> JSONValue {
        let s = spec()
        let totals = chartSankeyNodeValues(s.links, s.sankeyNodes)
        return [
            "links": .array(s.links.map { $0.toJSON() }),
            "nodes": .array(s.sankeyNodes.enumerated().map { i, name in
                ["name": .string(name), "value": .number(totals[i])]
            })
        ]
    }

    func makeTool(_ bareName: String, execute: @escaping @Sendable (JSONObject) throws -> JSONValue) -> AgentTool? {
        guard let def = defsByName[bareName] else { return nil }
        return AgentTool(
            name: def.name,
            title: def.title,
            description: def.description,
            inputSchema: def.inputSchema,
            outputSchema: def.outputSchema,
            annotations: def.annotations,
            handler: { args, _ in
                if def.annotations?.readOnlyHint != true, let reason = self.readOnlyReason() {
                    throw ToolExecutionError(reason)
                }
                return .value(try execute(args))
            }
        )
    }

    func readTools() -> [AgentTool] {
        var list: [AgentTool] = []
        func add(_ name: String, _ fn: @escaping @Sendable (JSONObject) throws -> JSONValue) {
            if let t = makeTool(name, execute: fn) { list.append(t) }
        }

        add("get_chart") { args in
            let width = args["width"]?.doubleValue ?? self.size.width
            let height = args["height"]?.doubleValue ?? self.size.height
            let s = self.controller.toJSON()
            let state = self.controller.getState()
            var out = JSONObject([
                ("spec", s.toJSON()),
                ("table", self.tableJSON()),
                ("selection", state.selection.map { $0.toJSON() } ?? .null),
                ("summary", summarizeChart(s, width: width, height: height, measureText: self.controller.measureText).toJSON())
            ])
            if !s.tree.isEmpty {
                out["treeTable"] = self.treeTable()
            }
            out["issues"] = .array(state.issues.map { $0.toJSON() })
            if let reason = self.readOnlyReason() {
                out["readOnly"] = .string(reason)
            }
            return .object(out)
        }

        if let def = defsByName["render_chart"] {
            list.append(AgentTool(
                name: def.name,
                title: def.title,
                description: def.description,
                inputSchema: def.inputSchema,
                outputSchema: def.outputSchema,
                annotations: def.annotations,
                handler: { args, _ in
                    let width = args["width"]?.doubleValue ?? self.size.width
                    let height = args["height"]?.doubleValue ?? self.size.height
                    let format = args["format"]?.stringValue ?? "svg"
                    let json = self.controller.toJSON()
                    let raceFrame: Double?
                    if let time = args["time"], time != .null {
                        raceFrame = try self.raceFrameOf(time)
                    } else {
                        raceFrame = self.controller.getState().raceFrame
                    }
                    let scene = layoutChart(
                        json,
                        ChartLayoutOptions(
                            width: width,
                            height: height,
                            selection: nil,
                            measureText: self.controller.measureText,
                            raceFrame: raceFrame
                        )
                    )
                    let svg = chartSceneToSvg(
                        scene,
                        ChartSvgOptions(
                            ariaLabel: json.title.isEmpty ? nil : json.title,
                            description: describeChart(json)
                        )
                    )
                    let warnings = scene.warnings
                    let warningsJSON: JSONValue = .array(warnings.map { $0.toJSON() })
                    if format == "png" {
                        guard let rasterize = self.options.rasterize else {
                            throw ToolExecutionError("This host cannot rasterize charts; call render_chart with format \"svg\", or get_chart for the layout warnings.")
                        }
                        let image = try await rasterize(svg, (width: width, height: height))
                        let info = JSONObject([
                            ("width", .number(width)),
                            ("height", .number(height)),
                            ("mimeType", .string(image.mimeType)),
                            ("warnings", warningsJSON),
                        ])
                        let note = !warnings.isEmpty
                            ? "Layout warnings: \(warnings.map { $0.message }.joined(separator: " "))"
                            : "No layout warnings."
                        let wStr = JSONValue.jsNumber(width)
                        let hStr = JSONValue.jsNumber(height)
                        return .result(McpToolResult(
                            content: [
                                .image(data: image.data, mimeType: image.mimeType),
                                .text("Chart at \(wStr) × \(hStr). \(note)"),
                            ],
                            structuredContent: info
                        ))
                    }
                    return .value([
                        "svg": .string(svg),
                        "width": .number(width),
                        "height": .number(height),
                        "warnings": warningsJSON,
                    ])
                }
            ))
        }

        add("check_chart_colors") { args in
            let s = self.spec()
            let visible = s.series.filter { !($0.hidden ?? false) }
            let own: [String]
            if chartSpecColorsByCategory(s) {
                own = s.categories.indices.map { i in
                    if let pc = visible.first?.pointColors, i < pc.count, let col = pc[i], !col.isEmpty {
                        return col
                    }
                    return chartSliceColor(s, i)
                }
            } else {
                own = visible.map { x in
                    let idx = s.series.firstIndex(where: { $0.id == x.id }) ?? 0
                    return chartSeriesColor(s, idx)
                }
            }
            let colors = args["colors"]?.arrayValue?.compactMap { $0.stringValue } ?? own
            let surface = args["surface"]?.stringValue
            let check = checkChartColors(colors, ChartColorCheckOptions(surface: surface))
            var out = JSONObject([("colors", .array(colors.map(JSONValue.string)))])
            if case .object(let obj) = check.toJSON() {
                for (k, v) in obj { out[k] = v }
            }
            return .object(out)
        }

        add("recommend_chart") { args in
            let rows: [[JSONValue]]
            if let csv = args["csv"]?.stringValue {
                let parsed = parseCsv(csv, options: CsvParseOptions(delimiter: csv.contains("\t") ? "\t" : ","))
                rows = parsed.map { $0.map(JSONValue.string) }
            } else {
                rows = self.table()
            }
            let recommendations = recommendChartTypes(rows)
            if recommendations.isEmpty {
                throw ToolExecutionError("There are no numbers to chart: give CSV with at least one numeric column.")
            }
            return [
                "recommendations": .array(recommendations.map { $0.toJSON() })
            ]
        }

        return list + readToolsMore()
    }
}

extension ChartToolProviderImpl {
    func readToolsMore() -> [AgentTool] {
        var list: [AgentTool] = []
        func add(_ name: String, _ fn: @escaping @Sendable (JSONObject) throws -> JSONValue) {
            if let t = makeTool(name, execute: fn) { list.append(t) }
        }

        add("get_chart_trendline") { args in
            let s = try self.seriesById(args["series"]?.stringValue ?? "")
            let index = args["index"]?.intValue ?? 0
            let list = s.trendlines ?? []
            guard index >= 0 && index < list.count else {
                throw ToolExecutionError("\"\(s.name)\" has no trendline \(index); it has \(list.count).")
            }
            let line = list[index]
            if line.type == .movingAverage {
                let pts = self.controller.trendlineMovingAverage(s.id, index).map { pt -> JSONValue in
                    .array([.number(pt.0), .number(pt.1)])
                }
                return [
                    "trendline": line.toJSON(),
                    "points": .array(pts)
                ]
            }
            guard let fit = self.controller.trendlineFit(s.id, index) else {
                throw ToolExecutionError(
                    "The \(line.type.rawValue) trendline on \"\(s.name)\" cannot be fitted: it needs more points (and positive values for log, exponential and power fits)."
                )
            }
            return [
                "trendline": line.toJSON(),
                "coefficients": .array(fit.coefficients.map(JSONValue.number)),
                "r2": fit.r2.map(JSONValue.number) ?? .null,
                "equation": .string(fit.equation),
                "points": .number(Double(fit.points))
            ]
        }

        add("get_chart_tooltip") { args in
            let index = try self.categoryIndex(args["category"] ?? .null)
            let seriesId: String?
            if let sRef = args["series"]?.stringValue {
                seriesId = try self.seriesById(sRef).id
            } else {
                seriesId = nil
            }
            guard let tooltip = chartTooltipFor(self.controller.toJSON(), index, seriesId) else {
                return .null
            }
            return [
                "title": .string(tooltip.title),
                "index": .number(Double(tooltip.index)),
                "items": .array(tooltip.items.map { $0.toJSON() })
            ]
        }

        add("get_chart_race_ranking") { args in
            let frame: Double?
            if let time = args["time"], time != .null {
                frame = try self.raceFrameOf(time)
            } else {
                frame = self.controller.getState().raceFrame
            }
            return self.raceAt(frame)
        }

        add("list_chart_map_regions") { args in
            let s = self.spec()
            let id = args["map"]?.stringValue ?? s.map
            let maps = listChartMaps()
            guard let geometry = getChartMap(id) else {
                if !maps.isEmpty {
                    let ids = maps.map { "\"\($0.id)\"" }.joined(separator: ", ")
                    throw ToolExecutionError("There is no map \"\(id)\"; the host has \(ids).")
                } else {
                    throw ToolExecutionError("There is no map \"\(id)\": the host has not registered any maps (EUROPE_CHART_MAP in @pixerate/editor/chart-maps).")
                }
            }
            let matches = matchChartMapRegions(geometry, s.categories)
            var matched: [JSONValue] = []
            var unmatched: [JSONValue] = []
            for (i, c) in s.categories.enumerated() {
                if let r = matches[i] {
                    matched.append(["category": .string(c), "region": .string(r.id)])
                } else {
                    unmatched.append(.string(c))
                }
            }
            return [
                "maps": .array(maps.map { m in
                    ["id": .string(m.id), "name": .string(m.name), "regions": .number(Double(m.regions.count))]
                }),
                "map": .string(id),
                "regions": .array(geometry.regions.map { r in
                    ["id": .string(r.id), "name": .string(r.name)]
                }),
                "matched": .array(matched),
                "unmatched": .array(unmatched)
            ]
        }

        add("list_chart_presets") { _ in
            [
                "layouts": .array(CHART_LAYOUT_PRESETS.map { p in
                    ["id": .string(p.id), "label": .string(p.label), "description": .string(p.description)]
                }),
                "colorSchemes": .array(CHART_COLOR_SCHEMES.map { p in
                    [
                        "id": .string(p.id),
                        "label": .string(p.label),
                        "description": .string(p.description),
                        "palette": .array(p.palette.map(JSONValue.string))
                    ]
                })
            ]
        }

        add("export_chart_mermaid") { args in
            let meta = args["meta"]?.boolValue ?? true
            return [
                "mermaid": .string(chartToMermaid(self.controller.toJSON(), ChartMermaidOptions(meta: meta)))
            ]
        }

        add("export_chart_ooxml") { _ in
            chartToOoxml(self.controller.toJSON()).toJSON()
        }

        return list
    }

    func asProvider() -> AgentToolProvider {
        let reads = readTools()
        let writes = writeTools()
        return AgentToolProvider(
            id: options.id,
            namespace: options.namespace,
            title: "Chart editor",
            description: "One chart: its spec, data and values, series and categories, trendlines, reference lines and bands, callouts, highlight, grouped data, flows, bar race playback and presets, CSV, Mermaid and OOXML import, rendering and colour checks.",
            skill: "pixerate-chart",
            tools: reads + writes
        )
    }
}

public struct OfficeChartFile: Sendable, Equatable {
    public var name: String
    public var data: [UInt8]

    public init(name: String, data: [UInt8]) {
        self.name = name
        self.data = data
    }
}

public struct OfficeChartToolProviderOptions {
    public var id: String
    public var namespace: String
    public var hasFiles: Bool
    public var files: (() -> [OfficeChartFile])?
    public var controller: ChartController?
    public var readOnly: (() -> Any)?

    public init(
        id: String = "office-charts",
        namespace: String = "",
        hasFiles: Bool = true,
        files: (() -> [OfficeChartFile])? = nil,
        controller: ChartController? = nil,
        readOnly: (() -> Any)? = nil
    ) {
        self.id = id
        self.namespace = namespace
        self.hasFiles = hasFiles
        self.files = files
        self.controller = controller
        self.readOnly = readOnly
    }
}

private func decodeOfficeBase64(_ input: String) throws -> [UInt8] {
    var clean = input
    if let range = clean.range(of: #"^data:[^,]*,"#, options: [.regularExpression]) {
        clean.removeSubrange(range)
    }
    clean = clean.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
    guard let data = Data(base64Encoded: clean) else {
        throw ToolExecutionError("\"data\" is not valid base64. Pass the whole .xlsx, .pptx or .docx file encoded as base64 (a data: URL prefix is fine).")
    }
    return [UInt8](data)
}

public func createOfficeChartToolProvider(
    _ options: OfficeChartToolProviderOptions = OfficeChartToolProviderOptions()
) -> AgentToolProvider {
    OfficeChartToolProviderImpl(options: options).asProvider()
}

private final class OfficeChartToolProviderImpl: @unchecked Sendable {
    let options: OfficeChartToolProviderOptions
    let defsByName: [String: McpToolDefinition]

    init(options: OfficeChartToolProviderOptions) {
        self.options = options
        var map: [String: McpToolDefinition] = [:]
        for def in (try? ChartContracts.tools()) ?? [] {
            map[def.name] = def
        }
        self.defsByName = map
    }

    func readOnlyReason() -> String? {
        guard let ro = options.readOnly?() else { return nil }
        if let b = ro as? Bool { return b ? "This chart is read-only." : nil }
        if let s = ro as? String { return s.isEmpty ? nil : s }
        return nil
    }

    func read(_ args: JSONObject) throws -> OfficeChartsResult {
        do {
            if !options.hasFiles && options.files == nil {
                let raw = args["data"]?.stringValue ?? "undefined"
                let bytes = try decodeOfficeBase64(raw)
                return try extractOfficeCharts(bytes)
            }
            let files = options.files?() ?? []
            let fileName = args["file"]?.stringValue ?? "undefined"
            guard let file = files.first(where: { $0.name == fileName }) else {
                let listDesc = files.isEmpty
                    ? "(none; ask the user to open an .xlsx, .pptx or .docx file)"
                    : files.map { "\"\($0.name)\"" }.joined(separator: ", ")
                throw ToolExecutionError("There is no open file \"\(fileName)\"; expected one of \(listDesc).")
            }
            return try extractOfficeCharts(file.data)
        } catch let err as ToolExecutionError {
            throw err
        } catch {
            throw ToolExecutionError("\(error)")
        }
    }

    func chartById(_ args: JSONObject) throws -> OfficeFileChart {
        let charts = try read(args).charts
        let chartId = args["chartId"]?.stringValue ?? "undefined"
        guard let chart = charts.first(where: { $0.id == chartId }) else {
            let listDesc = charts.isEmpty
                ? "(none: the file has no charts)"
                : charts.map { "\"\($0.id)\" (\(describeOfficeChartPlace($0)))" }.joined(separator: ", ")
            throw ToolExecutionError("There is no chart \"\(chartId)\" in this file; expected one of \(listDesc).")
        }
        return chart
    }

    func chartSummary(_ chart: OfficeFileChart) -> JSONObject {
        var out = JSONObject([
            ("id", .string(chart.id)),
            ("place", .string(describeOfficeChartPlace(chart)))
        ])
        if let sheet = chart.sheet { out["sheet"] = .string(sheet) }
        if let slide = chart.slide { out["slide"] = .number(Double(slide)) }
        if let anchor = chart.anchor, !anchor.isEmpty { out["anchor"] = .string(anchor) }
        if let range = chart.range, !range.isEmpty { out["range"] = .string(range) }
        if let name = chart.name, !name.isEmpty { out["name"] = .string(name) }
        out["path"] = .string(chart.path)
        out["partKind"] = .string(chart.partKind.rawValue)
        out["title"] = .string(chart.title)
        out["type"] = .string(chart.spec.type.rawValue)
        out["series"] = .array(chart.spec.series.map { .string($0.name) })
        out["categories"] = .number(Double(chart.spec.categories.count))
        out["issues"] = .array(chart.issues.map(JSONValue.string))
        out["unsupported"] = .array(chart.unsupported.map(JSONValue.string))
        out["lossless"] = .bool(chart.lossless)
        return out
    }

    func makeTool(_ name: String, _ fn: @escaping @Sendable (JSONObject) throws -> JSONValue) -> AgentTool? {
        guard let def = defsByName[name] else { return nil }
        return AgentTool(
            name: def.name,
            title: def.title,
            description: def.description,
            inputSchema: def.inputSchema,
            outputSchema: def.outputSchema,
            annotations: def.annotations,
            handler: { args, _ in
                .value(try fn(args))
            }
        )
    }

    func asProvider() -> AgentToolProvider {
        var tools: [AgentTool] = []
        if options.hasFiles || options.files != nil {
            if let t = makeTool("list_open_files", { _ in
                let list = self.options.files?() ?? []
                let filesOut: [JSONValue] = list.map { f in
                    .object(JSONObject([
                        ("name", .string(f.name)),
                        ("bytes", .number(Double(f.data.count)))
                    ]))
                }
                return .object(JSONObject([("files", .array(filesOut))]))
            }) {
                tools.append(t)
            }
        }

        if let t = makeTool("list_file_charts", { args in
            let result = try self.read(args)
            return .object(JSONObject([
                ("format", .string(result.format.rawValue)),
                ("charts", .array(result.charts.map { .object(self.chartSummary($0)) }))
            ]))
        }) {
            tools.append(t)
        }

        if let t = makeTool("get_file_chart", { args in
            let chart = try self.chartById(args)
            var out = self.chartSummary(chart)
            out["spec"] = chart.spec.toJSON()
            return .object(out)
        }) {
            tools.append(t)
        }

        if let controller = options.controller, readOnlyReason() == nil {
            if let t = makeTool("load_file_chart", { args in
                if let reason = self.readOnlyReason() {
                    throw ToolExecutionError(reason)
                }
                let chart = try self.chartById(args)
                let patch = chart.spec.toJSON().objectValue ?? JSONObject()
                let result = controller.update(patch, options: ChartEditOptions(label: "Load chart from file"))
                if !result.ok {
                    throw ToolExecutionError(result.message ?? "The chart could not be loaded.")
                }
                return .object(JSONObject([
                    ("id", .string(chart.id)),
                    ("place", .string(describeOfficeChartPlace(chart))),
                    ("spec", controller.toJSON().toJSON()),
                    ("issues", .array(chart.issues.map(JSONValue.string))),
                    ("unsupported", .array(chart.unsupported.map(JSONValue.string))),
                    ("lossless", .bool(chart.lossless))
                ]))
            }) {
                tools.append(t)
            }
        }

        return AgentToolProvider(
            id: options.id,
            namespace: options.namespace,
            title: "Office charts",
            description: "Charts inside Word, Excel and PowerPoint files: list and read them, and load one into the chart editor.",
            skill: "pixerate-chart",
            tools: tools
        )
    }
}
