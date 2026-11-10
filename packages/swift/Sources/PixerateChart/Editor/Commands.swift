import Foundation
import PixerateCore
import PixerateRaster

public struct ChartCommandOptions {
    public var prefix: String
    public var group: String
    public var scope: String?

    public init(prefix: String = "chart.", group: String = "Chart", scope: String? = nil) {
        self.prefix = prefix
        self.group = group
        self.scope = scope
    }
}

typealias ChartCommandRun = (ChartController, JSONObject) throws -> JSONValue?

private func fail(_ message: String) -> ToolExecutionError {
    ToolExecutionError(message)
}

private func check(_ result: ChartActionResult) throws {
    if !result.ok {
        throw fail(result.message ?? "The change was rejected.")
    }
}

private func seriesIds(_ controller: ChartController) -> [String] {
    controller.getSpec().series.map(\.id)
}

private func resolveSeries(_ controller: ChartController, _ ref: String) throws -> ChartSeries {
    let spec = controller.getSpec()
    if let s = spec.series.first(where: { $0.id == ref }) ?? spec.series.first(where: { $0.name == ref }) {
        return s
    }
    let ids = seriesIds(controller).map { "\"\($0)\"" }.joined(separator: ", ")
    throw fail("There is no series \"\(ref)\"; expected one of \(ids.isEmpty ? "(none yet)" : ids).")
}

private func resolveCategory(_ controller: ChartController, _ ref: JSONValue) throws -> Int {
    let categories = controller.getSpec().categories
    let index: Int
    if case .number(let d) = ref, d.isFinite, floor(d) == d {
        index = Int(d)
    } else if let s = ref.stringValue {
        index = categories.firstIndex(of: s) ?? -1
    } else {
        index = -1
    }
    if index < 0 || index >= categories.count {
        throw fail(
            "There is no category \(ref.stringified()); expected an index from 0 to \(categories.count - 1) or one of the labels."
        )
    }
    return index
}

private func resolveRaceFrame(_ controller: ChartController, _ time: JSONValue) throws -> Double {
    let cats = controller.getSpec().categories
    let frame: Double
    if case .number(let d) = time {
        frame = d
    } else if let s = time.stringValue {
        frame = Double(cats.firstIndex(of: s) ?? -1)
    } else {
        frame = .nan
    }
    if !(frame.isFinite && frame >= 0 && frame <= Double(cats.count - 1)) {
        throw fail(
            "There is no time point \(time.stringified()); expected an index from 0 to \(Swift.max(0, cats.count - 1)) or a category label."
        )
    }
    return frame
}

private func tableToJSON(_ spec: ChartSpec) -> JSONValue {
    .array(chartDataToTable(spec).map(JSONValue.array))
}

public func createChartCommands(
    _ controller: ChartController,
    _ options: ChartCommandOptions = ChartCommandOptions()
) throws -> [CommandSpec<ChartController>] {
    let runs = chartCommandRuns()
    return try ChartContracts.commands().map { c in
        let bareId = c.id.hasPrefix("chart.") ? String(c.id.dropFirst("chart.".count)) : c.id
        let fullId = "\(options.prefix)\(bareId)"
        let enabled: ((ChartController, JSONObject?) throws -> CommandAvailability)?
        switch bareId {
        case "pauseRace":
            enabled = { ctl, _ in ctl.getState().racePlaying ? .enabled : .disabledBecause("The race is not playing") }
        case "undo":
            enabled = { ctl, _ in ctl.getState().canUndo ? .enabled : .disabledBecause("Nothing to undo") }
        case "redo":
            enabled = { ctl, _ in ctl.getState().canRedo ? .enabled : .disabledBecause("Nothing to redo") }
        default:
            enabled = nil
        }
        let run: ChartCommandRun = runs[bareId] ?? { _, _ in
            throw fail("\(fullId) is not ported to Swift yet (#701).")
        }
        return CommandSpec<ChartController>(
            id: fullId,
            label: c.label,
            group: options.group,
            keywords: c.keywords,
            description: c.description,
            params: c.params,
            shortcut: c.shortcut.map { CommandShortcut($0) },
            scope: options.scope ?? c.scope,
            undoable: c.undoable,
            readOnly: c.readOnly,
            hidden: c.hidden,
            enabled: enabled,
            run: { _, params in try run(controller, params) }
        )
    }
}

private func chartCommandRuns() -> [String: ChartCommandRun] {
    var runs: [String: ChartCommandRun] = [:]

    runs["describe"] = { controller, params in
        let spec = controller.getSpec()
        let width = params["width"]?.doubleValue ?? 640.0
        let height = params["height"]?.doubleValue ?? 400.0
        let jsonSpec = controller.toJSON()
        return [
            "spec": jsonSpec.toJSON(),
            "table": tableToJSON(spec),
            "summary": summarizeChart(jsonSpec, width: width, height: height, measureText: controller.measureText).toJSON(),
            "issues": .array(controller.getState().issues.map { $0.toJSON() })
        ]
    }

    runs["update"] = { controller, params in
        try check(controller.update(params))
        return ["spec": controller.toJSON().toJSON()]
    }

    runs["setData"] = { controller, params in
        try check(controller.setData(params))
        return ["table": tableToJSON(controller.getSpec())]
    }

    runs["setValues"] = { controller, params in
        let cells = params["cells"]?.arrayValue ?? []
        var mapped: [(seriesId: String, index: Int, value: JSONValue)] = []
        for cVal in cells {
            guard case .object(let c) = cVal else { continue }
            let s = try resolveSeries(controller, c["series"]?.stringValue ?? "")
            let idx = try resolveCategory(controller, c["category"] ?? .null)
            mapped.append((seriesId: s.id, index: idx, value: c["value"] ?? .null))
        }
        try check(controller.setValues(mapped))
        return ["table": tableToJSON(controller.getSpec())]
    }

    runs["addSeries"] = { controller, params in
        let at = params["at"]?.intValue
        var clean = JSONObject()
        for (k, v) in params where k != "at" && v != .null {
            clean[k] = v
        }
        let result = controller.addSeries(clean, at: at)
        try check(result)
        return ["id": .string(result.id ?? "")]
    }

    runs["updateSeries"] = { controller, params in
        let id = try resolveSeries(controller, params["series"]?.stringValue ?? "").id
        var patch = params
        patch["series"] = nil
        try check(controller.updateSeries(id, patch))
        return ["series": controller.getSeries(id)?.toJSON() ?? .null]
    }

    runs["removeSeries"] = { controller, params in
        let id = try resolveSeries(controller, params["series"]?.stringValue ?? "").id
        try check(controller.removeSeries(id))
        return ["series": .array(seriesIds(controller).map(JSONValue.string))]
    }

    runs["addCategory"] = { controller, params in
        let result = controller.addCategory(params["label"]?.stringValue, at: params["at"]?.intValue)
        try check(result)
        return [
            "ok": .bool(true),
            "index": .number(Double(result.index ?? 0))
        ]
    }

    runs["removeCategory"] = { controller, params in
        let idx = try resolveCategory(controller, params["category"] ?? .null)
        try check(controller.removeCategory(idx))
        return ["categories": .array(controller.getSpec().categories.map(JSONValue.string))]
    }

    for (k, v) in chartCommandRunsMore() {
        runs[k] = v
    }
    return runs
}

private func chartCommandRunsMore() -> [String: ChartCommandRun] {
    var runs: [String: ChartCommandRun] = [:]

    runs["addTrendline"] = { controller, params in
        let s = try resolveSeries(controller, params["series"]?.stringValue ?? "")
        var lineObj = params
        lineObj["series"] = nil
        let result = controller.addTrendline(s.id, .object(lineObj))
        try check(result)
        var out = JSONObject([("index", .number(Double(result.index ?? 0)))])
        if let fit = result.fit {
            out["coefficients"] = .array(fit.coefficients.map(JSONValue.number))
            out["r2"] = fit.r2.map(JSONValue.number) ?? .null
            out["equation"] = .string(fit.equation)
        }
        return .object(out)
    }

    runs["removeTrendline"] = { controller, params in
        let s = try resolveSeries(controller, params["series"]?.stringValue ?? "")
        let index = params["index"]?.intValue ?? 0
        try check(controller.removeTrendline(s.id, index))
        let trendlines = controller.getSeries(s.id)?.trendlines ?? []
        return ["trendlines": .array(trendlines.map { $0.toJSON() })]
    }

    runs["addReferenceLine"] = { controller, params in
        let result = controller.addReferenceLine(.object(params))
        try check(result)
        return [
            "index": .number(Double(result.index ?? 0)),
            "referenceLines": .array(controller.getSpec().referenceLines.map { $0.toJSON() })
        ]
    }

    runs["updateReferenceLine"] = { controller, params in
        let index = params["index"]?.intValue ?? -1
        var patch = params
        patch["index"] = nil
        try check(controller.updateReferenceLine(index, patch))
        return ["referenceLine": controller.getSpec().referenceLines[index].toJSON()]
    }

    runs["removeReferenceLine"] = { controller, params in
        let index = params["index"]?.intValue ?? -1
        try check(controller.removeReferenceLine(index))
        return ["referenceLines": .array(controller.getSpec().referenceLines.map { $0.toJSON() })]
    }

    runs["addReferenceBand"] = { controller, params in
        let result = controller.addReferenceBand(.object(params))
        try check(result)
        return [
            "index": .number(Double(result.index ?? 0)),
            "referenceBands": .array(controller.getSpec().referenceBands.map { $0.toJSON() })
        ]
    }

    runs["updateReferenceBand"] = { controller, params in
        let index = params["index"]?.intValue ?? -1
        var patch = params
        patch["index"] = nil
        try check(controller.updateReferenceBand(index, patch))
        return ["referenceBand": controller.getSpec().referenceBands[index].toJSON()]
    }

    runs["removeReferenceBand"] = { controller, params in
        let index = params["index"]?.intValue ?? -1
        try check(controller.removeReferenceBand(index))
        return ["referenceBands": .array(controller.getSpec().referenceBands.map { $0.toJSON() })]
    }

    runs["setCallout"] = { controller, params in
        let s = try resolveSeries(controller, params["series"]?.stringValue ?? "")
        let idx = try resolveCategory(controller, params["category"] ?? .null)
        try check(controller.setCallout(s.id, idx, params["label"]?.stringValue))
        let callouts = controller.getSeries(s.id)?.callouts
        let stored: String? = (callouts != nil && idx >= 0 && idx < callouts!.count) ? callouts![idx] : nil
        return [
            "series": .string(s.id),
            "index": .number(Double(idx)),
            "label": stored.map(JSONValue.string) ?? .null
        ]
    }

    runs["highlight"] = { controller, params in
        let names = params["names"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        let result = controller.setHighlight(names)
        try check(result)
        return [
            "highlight": .array(controller.getSpec().highlight.map(JSONValue.string)),
            "categories": .array((result.categories ?? []).map { .number(Double($0)) }),
            "series": .array((result.series ?? []).map(JSONValue.string))
        ]
    }

    runs["setTree"] = { controller, params in
        try check(controller.setTree(params["tree"] ?? .array([])))
        let groups = controller.getSpec().tree.map { n -> JSONValue in
            ["name": .string(n.name), "total": .number(chartTreeTotal(n))]
        }
        return ["groups": .array(groups)]
    }

    runs["importTreeCsv"] = { controller, params in
        let csv = params["csv"]?.stringValue ?? ""
        let rows = parseCsv(csv, options: CsvParseOptions(delimiter: csv.contains("\t") ? "\t" : ",")).map {
            $0.map(JSONValue.string)
        }
        try check(controller.importTreeTable(rows, header: ChartHeaderOption.from(params["header"])))
        return ["tree": .array(controller.getSpec().tree.map { $0.toJSON() })]
    }

    runs["addTreeNode"] = { controller, params in
        let parent = params["parent"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        let result = controller.addTreeNode(parent, params["node"] ?? .null, at: params["at"]?.intValue)
        try check(result)
        return ["path": .array((result.path ?? []).map(JSONValue.string))]
    }

    runs["updateTreeNode"] = { controller, params in
        let path = params["path"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        var patch = params
        patch["path"] = nil
        let result = controller.updateTreeNode(path, patch)
        try check(result)
        return ["path": .array((result.path ?? []).map(JSONValue.string))]
    }

    runs["removeTreeNode"] = { controller, params in
        let path = params["path"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        try check(controller.removeTreeNode(path))
        let groups = controller.getSpec().tree.map { n -> JSONValue in
            ["name": .string(n.name), "total": .number(chartTreeTotal(n))]
        }
        return ["groups": .array(groups)]
    }

    for (k, v) in chartCommandRunsTail() {
        runs[k] = v
    }
    return runs
}

private func chartCommandRunsTail() -> [String: ChartCommandRun] {
    var runs: [String: ChartCommandRun] = [:]

    runs["setLinks"] = { controller, params in
        let nodes = params["nodes"]?.arrayValue?.compactMap { $0.stringValue }
        try check(controller.setLinks(params["links"] ?? .array([]), nodes: nodes))
        return [
            "links": .array(controller.getSpec().links.map { $0.toJSON() }),
            "nodes": .array(controller.getSpec().sankeyNodes.map(JSONValue.string))
        ]
    }

    runs["importLinksCsv"] = { controller, params in
        let csv = params["csv"]?.stringValue ?? ""
        let rows = parseCsv(csv, options: CsvParseOptions(delimiter: csv.contains("\t") ? "\t" : ",")).map {
            $0.map(JSONValue.string)
        }
        try check(controller.importLinksTable(rows, header: ChartHeaderOption.from(params["header"])))
        return ["links": .array(controller.getSpec().links.map { $0.toJSON() })]
    }

    runs["addLink"] = { controller, params in
        let result = controller.addLink(.object(params))
        try check(result)
        return ["index": .number(Double(result.index ?? 0))]
    }

    runs["updateLink"] = { controller, params in
        let index = params["index"]?.intValue ?? -1
        var patch = params
        patch["index"] = nil
        try check(controller.updateLink(index, patch))
        return ["link": controller.getSpec().links[index].toJSON()]
    }

    runs["removeLink"] = { controller, params in
        let index = params["index"]?.intValue ?? -1
        try check(controller.removeLink(index))
        return ["links": .array(controller.getSpec().links.map { $0.toJSON() })]
    }

    runs["mapRegions"] = { controller, params in
        let id = params["map"]?.stringValue ?? controller.getSpec().map
        guard let geometry = getChartMap(id) else {
            throw fail("There is no map \"\(id)\"; register it with registerChartMap.")
        }
        let matches = matchChartMapRegions(geometry, controller.getSpec().categories)
        let unmatched: [JSONValue] = controller.getSpec().categories.enumerated().compactMap { i, c -> JSONValue? in
            if matches[i] == nil { return .string(c) }
            return nil
        }
        return [
            "regions": .array(geometry.regions.map { r in
                ["id": .string(r.id), "name": .string(r.name)]
            }),
            "unmatched": .array(unmatched)
        ]
    }

    runs["raceRanking"] = { controller, params in
        let spec = controller.getSpec()
        let frame: Double
        if let time = params["time"], time != .null {
            frame = try resolveRaceFrame(controller, time)
        } else {
            frame = controller.getState().raceFrame ?? Double(spec.categories.count - 1)
        }
        let ranking = Array(chartRaceRanking(spec, frame).prefix(spec.raceTopN)).map { e -> JSONValue in
            [
                "rank": .number(Double(e.rank + 1)),
                "series": .string(e.seriesId),
                "name": .string(e.name),
                "value": .number(e.value)
            ]
        }
        return [
            "frame": .number(frame),
            "ranking": .array(ranking)
        ]
    }

    runs["setRaceFrame"] = { controller, params in
        let frame: Double?
        if let time = params["time"], time != .null {
            frame = try resolveRaceFrame(controller, time)
        } else {
            frame = nil
        }
        try check(controller.setRaceFrame(frame))
        return ["frame": frame.map(JSONValue.number) ?? .null]
    }

    runs["playRace"] = { controller, params in
        try check(controller.playRace(msPerStep: params["msPerStep"]?.doubleValue))
        return ["playing": .bool(true)]
    }

    runs["pauseRace"] = { controller, _ in
        controller.pauseRace()
        return ["frame": controller.getState().raceFrame.map(JSONValue.number) ?? .null]
    }

    runs["applyPreset"] = { controller, params in
        try check(controller.applyPreset(layout: params["layout"]?.stringValue, colors: params["colors"]?.stringValue))
        return ["spec": controller.toJSON().toJSON()]
    }

    runs["transpose"] = { controller, _ in
        try check(controller.transpose())
        return ["table": tableToJSON(controller.getSpec())]
    }

    runs["importCsv"] = { controller, params in
        let csv = params["csv"]?.stringValue ?? ""
        let seriesIn = (params["seriesIn"]?.stringValue).flatMap(ChartSeriesDirection.init(rawValue:))
        let header = ChartHeaderOption.from(params["header"])
        let result = controller.importCsv(csv, ChartTableOptions(seriesIn: seriesIn, header: header))
        try check(result)
        return [
            "table": tableToJSON(controller.getSpec()),
            "issues": .array((result.issues ?? []).map { $0.toJSON() })
        ]
    }

    runs["importMermaid"] = { controller, params in
        let mermaid = params["mermaid"]?.stringValue ?? ""
        let read = chartFromMermaid(mermaid)
        if read.family == nil {
            let joined = read.issues.map { $0.message }.joined(separator: " ")
            throw fail(
                !joined.isEmpty
                    ? joined
                    : "Expected Mermaid starting with xychart-beta, pie, radar-beta, sankey-beta or treemap-beta."
            )
        }
        let patch = read.spec.toJSON().objectValue ?? JSONObject()
        try check(controller.update(patch, options: ChartEditOptions(label: "Import Mermaid chart")))
        return [
            "spec": controller.toJSON().toJSON(),
            "issues": .array(read.issues.map { $0.toJSON() })
        ]
    }

    runs["exportMermaid"] = { controller, params in
        let meta = params["meta"]?.boolValue
        return [
            "mermaid": .string(chartToMermaid(controller.toJSON(), ChartMermaidOptions(meta: meta)))
        ]
    }

    runs["exportOoxml"] = { controller, _ in
        chartToOoxml(controller.toJSON()).toJSON()
    }

    runs["exportSvg"] = { controller, params in
        let width = params["width"]?.doubleValue ?? 640
        let height = params["height"]?.doubleValue ?? 400
        return [
            "svg": .string(chartToSvg(
                controller.toJSON(),
                width: width,
                height: height,
                measureText: controller.measureText
            ))
        ]
    }

    runs["recommend"] = { controller, params in
        let rows: [[JSONValue]]
        if let csv = params["csv"]?.stringValue {
            rows = parseCsv(csv).map { $0.map(JSONValue.string) }
        } else {
            rows = chartDataToTable(controller.getSpec())
        }
        return [
            "recommendations": .array(recommendChartTypes(rows).map { $0.toJSON() })
        ]
    }

    runs["checkColors"] = { controller, _ in
        let s = controller.getSpec()
        let visible = s.series.filter { !($0.hidden ?? false) }
        let colors: [String]
        if chartSpecColorsByCategory(s) {
            colors = s.categories.indices.map { i in
                if let pc = visible.first?.pointColors, i < pc.count, let col = pc[i], !col.isEmpty {
                    return col
                }
                return chartSliceColor(s, i)
            }
        } else {
            colors = visible.map { x in
                let idx = s.series.firstIndex(where: { $0.id == x.id }) ?? 0
                return chartSeriesColor(s, idx)
            }
        }
        let report = checkChartColors(colors)
        var out = JSONObject([("colors", .array(colors.map(JSONValue.string)))])
        if case .object(let obj) = report.toJSON() {
            for (k, v) in obj { out[k] = v }
        }
        return .object(out)
    }

    runs["undo"] = { controller, _ in
        ["undone": .bool(controller.undo())]
    }

    runs["redo"] = { controller, _ in
        ["redone": .bool(controller.redo())]
    }

    return runs
}
