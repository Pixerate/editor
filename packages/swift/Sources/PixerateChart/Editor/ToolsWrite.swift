import Foundation
import PixerateCore
import PixerateRaster

extension ChartToolProviderImpl {
    func writeTools() -> [AgentTool] {
        var list: [AgentTool] = []
        func add(_ name: String, _ fn: @escaping @Sendable (JSONObject) throws -> JSONValue) {
            if let t = makeTool(name, execute: fn) { list.append(t) }
        }

        add("update_chart") { args in
            if args.isEmpty {
                throw ToolExecutionError(
                    "Nothing to change: pass at least one field, e.g. {\"type\": \"line\"}."
                )
            }
            try self.check(self.controller.update(args))
            return ["spec": self.controller.toJSON().toJSON()]
        }

        add("set_chart_data") { args in
            if args["categories"] == nil && args["series"] == nil {
                throw ToolExecutionError("Pass categories, series or both.")
            }
            try self.check(self.controller.setData(args))
            return [
                "table": self.tableJSON(),
                "series": .array(self.spec().series.map { s in
                    ["id": .string(s.id), "name": .string(s.name)]
                })
            ]
        }

        add("set_chart_values") { args in
            let cells = args["cells"]?.arrayValue ?? []
            var resolved: [(seriesId: String, index: Int, value: JSONValue)] = []
            for cellVal in cells {
                guard case .object(let c) = cellVal else { continue }
                let s = try self.seriesById(c["series"]?.stringValue ?? "")
                let index = try self.categoryIndex(c["category"] ?? .null)
                let raw = c["value"] ?? .null
                let parsed = parseChartValue(raw)
                guard parsed != nil else {
                    let text: String
                    switch raw {
                    case .string(let str): text = str
                    case .number(let d): text = JSONValue.jsNumber(d)
                    case .bool(let b): text = b ? "true" : "false"
                    default: text = raw.stringified()
                    }
                    throw ToolExecutionError(
                        "\"\(text)\" is not a number; pass a number, numeric text or null for a gap. Nothing was changed."
                    )
                }
                resolved.append((seriesId: s.id, index: index, value: raw))
            }
            try self.check(self.controller.setValues(resolved))
            return [
                "cells": .array(resolved.map { c in
                    let val = self.controller.getSeries(c.seriesId)?.values[c.index] ?? nil
                    return [
                        "series": .string(c.seriesId),
                        "category": .string(self.spec().categories[c.index]),
                        "index": .number(Double(c.index)),
                        "value": val.map(JSONValue.number) ?? .null
                    ]
                })
            ]
        }

        add("add_chart_series") { args in
            var clean = JSONObject()
            let at = args["at"]?.intValue
            for (k, v) in args where k != "at" && v != .null {
                clean[k] = v
            }
            let result = self.controller.addSeries(clean, at: at)
            try self.check(result)
            let s = self.controller.getSeries(result.id ?? "")!
            return [
                "id": .string(s.id),
                "name": .string(s.name),
                "values": .array(s.values.map { $0.map(JSONValue.number) ?? .null })
            ]
        }

        add("update_chart_series") { args in
            let s = try self.seriesById(args["series"]?.stringValue ?? "")
            var patch = args
            patch["series"] = nil
            if patch.isEmpty {
                throw ToolExecutionError(
                    "Nothing to change: pass a field such as {\"color\": \"#e8710a\"} or {\"axis\": \"secondary\"}."
                )
            }
            try self.check(self.controller.updateSeries(s.id, patch))
            return ["series": self.controller.getSeries(s.id)?.toJSON() ?? .null]
        }

        add("remove_chart_series") { args in
            let s = try self.seriesById(args["series"]?.stringValue ?? "")
            try self.check(self.controller.removeSeries(s.id))
            return [
                "series": .array(self.spec().series.map { x in
                    ["id": .string(x.id), "name": .string(x.name)]
                })
            ]
        }

        add("add_chart_category") { args in
            let result = self.controller.addCategory(args["label"]?.stringValue, at: args["at"]?.intValue)
            try self.check(result)
            return [
                "index": .number(Double(result.index ?? 0)),
                "categories": .array(self.spec().categories.map(JSONValue.string))
            ]
        }

        add("remove_chart_category") { args in
            let idx = try self.categoryIndex(args["category"] ?? .null)
            try self.check(self.controller.removeCategory(idx))
            return [
                "categories": .array(self.spec().categories.map(JSONValue.string))
            ]
        }

        add("import_chart_csv") { args in
            let csv = args["csv"]?.stringValue ?? ""
            let seriesIn = (args["seriesIn"]?.stringValue).flatMap(ChartSeriesDirection.init(rawValue:))
            let header = ChartHeaderOption.from(args["header"])
            let chartType = args["chartType"]?.stringValue ?? "keep"
            if chartType == "auto" {
                let rows = parseCsv(csv, options: CsvParseOptions(delimiter: csv.contains("\t") ? "\t" : ",")).map {
                    $0.map(JSONValue.string)
                }
                let built = chartFromTable(rows)
                if built.series.isEmpty || built.categories.isEmpty {
                    throw ToolExecutionError("There is no data to import: expected at least one row of numbers.")
                }
                let patch: JSONObject = [
                    "type": .string(built.type.rawValue),
                    "stacking": .string(built.stacking.rawValue),
                    "categories": .array(built.categories.map(JSONValue.string)),
                    "series": .array(built.series.map { $0.toJSON() })
                ]
                try self.check(self.controller.update(patch, options: ChartEditOptions(label: "Import data")))
                return [
                    "type": .string(built.type.rawValue),
                    "table": self.tableJSON(),
                    "issues": .array(built.issues.map { $0.toJSON() })
                ]
            }
            let result = self.controller.importCsv(csv, ChartTableOptions(seriesIn: seriesIn, header: header))
            try self.check(result)
            return [
                "type": .string(self.spec().type.rawValue),
                "table": self.tableJSON(),
                "issues": .array((result.issues ?? []).map { $0.toJSON() })
            ]
        }

        add("import_chart_mermaid") { args in
            let mermaid = args["mermaid"]?.stringValue ?? ""
            let fencedRegex = try! NSRegularExpression(
                pattern: "```(?:mermaid)?\\s*\\n([\\s\\S]*?)```"
            )
            let ns = mermaid as NSString
            let source: String
            if let m = fencedRegex.firstMatch(in: mermaid, range: NSRange(location: 0, length: ns.length)),
               m.range(at: 1).location != NSNotFound {
                source = ns.substring(with: m.range(at: 1))
            } else {
                source = mermaid
            }
            let read = chartFromMermaid(source)
            if read.family == nil {
                let joined = read.issues.map { $0.message }.joined(separator: " ")
                throw ToolExecutionError(
                    !joined.isEmpty
                        ? joined
                        : "Expected Mermaid starting with xychart-beta, pie, radar-beta, sankey-beta or treemap-beta."
                )
            }
            let patch = read.spec.toJSON().objectValue ?? JSONObject()
            try self.check(self.controller.update(patch, options: ChartEditOptions(label: "Import Mermaid chart")))
            return [
                "spec": self.controller.toJSON().toJSON(),
                "issues": .array(read.issues.map { $0.toJSON() })
            ]
        }

        add("import_chart_ooxml") { args in
            let xml = args["xml"]?.stringValue ?? ""
            let read = chartFromOoxml(xml)
            if read.issues.contains(where: { $0.path.isEmpty || $0.path == "plotArea" }) {
                throw ToolExecutionError(read.issues.map { $0.message }.joined(separator: " "))
            }
            let patch = read.spec.toJSON().objectValue ?? JSONObject()
            try self.check(self.controller.update(patch, options: ChartEditOptions(label: "Import Office chart")))
            return [
                "spec": self.controller.toJSON().toJSON(),
                "issues": .array(read.issues.map { .string($0.message) }),
                "unsupported": .array(read.unsupported.map(JSONValue.string)),
                "lossless": .bool(read.lossless)
            ]
        }

        add("add_chart_trendline") { args in
            let s = try self.seriesById(args["series"]?.stringValue ?? "")
            var lineObj = args
            lineObj["series"] = nil
            let result = self.controller.addTrendline(s.id, .object(lineObj))
            try self.check(result)
            var out = JSONObject([
                ("series", .string(s.id)),
                ("index", .number(Double(result.index ?? 0)))
            ])
            if let fit = result.fit {
                out["coefficients"] = .array(fit.coefficients.map(JSONValue.number))
                out["r2"] = fit.r2.map(JSONValue.number) ?? .null
                out["equation"] = .string(fit.equation)
            }
            return .object(out)
        }

        add("remove_chart_trendline") { args in
            let s = try self.seriesById(args["series"]?.stringValue ?? "")
            let index = args["index"]?.intValue ?? 0
            try self.check(self.controller.removeTrendline(s.id, index))
            let trendlines = self.controller.getSeries(s.id)?.trendlines ?? []
            return [
                "series": .string(s.id),
                "trendlines": .array(trendlines.map { $0.toJSON() })
            ]
        }

        return list + writeToolsMore()
    }
}

extension ChartToolProviderImpl {
    func writeToolsMore() -> [AgentTool] {
        var list: [AgentTool] = []
        func add(_ name: String, _ fn: @escaping @Sendable (JSONObject) throws -> JSONValue) {
            if let t = makeTool(name, execute: fn) { list.append(t) }
        }

        add("add_chart_reference_line") { args in
            let result = self.controller.addReferenceLine(.object(args))
            try self.check(result)
            let idx = result.index ?? 0
            return [
                "index": .number(Double(idx)),
                "referenceLines": .array(self.spec().referenceLines.map { $0.toJSON() })
            ]
        }

        add("update_chart_reference_line") { args in
            let index = args["index"]?.intValue ?? -1
            var patch = args
            patch["index"] = nil
            if patch.isEmpty {
                throw ToolExecutionError(
                    "Nothing to change: pass at least one field besides index, e.g. {\"index\": \(index), \"label\": \"Target\"}."
                )
            }
            try self.check(self.controller.updateReferenceLine(index, patch))
            return [
                "index": .number(Double(index)),
                "referenceLine": self.spec().referenceLines[index].toJSON()
            ]
        }

        add("remove_chart_reference_line") { args in
            let index = args["index"]?.intValue ?? -1
            try self.check(self.controller.removeReferenceLine(index))
            return [
                "referenceLines": .array(self.spec().referenceLines.map { $0.toJSON() })
            ]
        }

        add("add_chart_reference_band") { args in
            let result = self.controller.addReferenceBand(.object(args))
            try self.check(result)
            let idx = result.index ?? 0
            return [
                "index": .number(Double(idx)),
                "referenceBands": .array(self.spec().referenceBands.map { $0.toJSON() })
            ]
        }

        add("update_chart_reference_band") { args in
            let index = args["index"]?.intValue ?? -1
            var patch = args
            patch["index"] = nil
            if patch.isEmpty {
                throw ToolExecutionError(
                    "Nothing to change: pass at least one field besides index, e.g. {\"index\": \(index), \"label\": \"Target\"}."
                )
            }
            try self.check(self.controller.updateReferenceBand(index, patch))
            return [
                "index": .number(Double(index)),
                "referenceBand": self.spec().referenceBands[index].toJSON()
            ]
        }

        add("remove_chart_reference_band") { args in
            let index = args["index"]?.intValue ?? -1
            try self.check(self.controller.removeReferenceBand(index))
            return [
                "referenceBands": .array(self.spec().referenceBands.map { $0.toJSON() })
            ]
        }

        return list + writeToolsTail()
    }
}

extension ChartToolProviderImpl {
    func writeToolsTail() -> [AgentTool] {
        var list: [AgentTool] = []
        func add(_ name: String, _ fn: @escaping @Sendable (JSONObject) throws -> JSONValue) {
            if let t = makeTool(name, execute: fn) { list.append(t) }
        }

        add("set_chart_callout") { args in
            let s = try self.seriesById(args["series"]?.stringValue ?? "")
            let index = try self.categoryIndex(args["category"] ?? .null)
            let label = args["label"]?.stringValue
            try self.check(self.controller.setCallout(s.id, index, label))
            let currentCallouts = self.controller.getSeries(s.id)?.callouts
            let stored: String? = (currentCallouts != nil && index >= 0 && index < currentCallouts!.count) ? currentCallouts![index] : nil
            return [
                "series": .string(s.id),
                "index": .number(Double(index)),
                "category": .string(self.spec().categories[index]),
                "label": stored.map(JSONValue.string) ?? .null
            ]
        }

        add("highlight_chart") { args in
            let names = args["names"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            let result = self.controller.setHighlight(names)
            try self.check(result)
            let s = self.spec()
            let cats = (result.categories ?? []).map { index -> JSONValue in
                ["index": .number(Double(index)), "label": .string(s.categories[index])]
            }
            let sers = (result.series ?? []).map { id -> JSONValue in
                let name = s.series.first(where: { $0.id == id })?.name ?? id
                return ["id": .string(id), "name": .string(name)]
            }
            return [
                "highlight": .array(s.highlight.map(JSONValue.string)),
                "categories": .array(cats),
                "series": .array(sers)
            ]
        }

        add("set_chart_tree") { args in
            try self.check(self.controller.setTree(args["tree"] ?? .array([])))
            return self.treeSummary()
        }

        add("import_chart_tree_csv") { args in
            let csv = args["csv"]?.stringValue ?? ""
            let rows = parseCsv(csv, options: CsvParseOptions(delimiter: csv.contains("\t") ? "\t" : ",")).map {
                $0.map(JSONValue.string)
            }
            let header = ChartHeaderOption.from(args["header"])
            try self.check(self.controller.importTreeTable(rows, header: header))
            return self.treeSummary()
        }

        add("add_chart_tree_node") { args in
            let parent = args["parent"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            let node = args["node"] ?? .null
            let at = args["at"]?.intValue
            let result = self.controller.addTreeNode(parent, node, at: at)
            try self.check(result)
            let parentTotal: Double
            if parent.isEmpty {
                parentTotal = self.spec().tree.reduce(0.0) { $0 + chartTreeTotal($1) }
            } else if let pNode = findChartTreeNode(self.spec().tree, parent) {
                parentTotal = chartTreeTotal(pNode)
            } else {
                parentTotal = 0.0
            }
            return [
                "path": .array((result.path ?? []).map(JSONValue.string)),
                "parentTotal": .number(parentTotal)
            ]
        }

        add("update_chart_tree_node") { args in
            let path = args["path"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            var patch = args
            patch["path"] = nil
            if patch.isEmpty {
                throw ToolExecutionError("Nothing to change: pass name, value or color with the path.")
            }
            let result = self.controller.updateTreeNode(path, patch)
            try self.check(result)
            let newPath = result.path ?? path
            let node = findChartTreeNode(self.spec().tree, newPath)
            return [
                "path": .array(newPath.map(JSONValue.string)),
                "node": node.map { $0.toJSON() } ?? .null
            ]
        }

        add("remove_chart_tree_node") { args in
            let path = args["path"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            try self.check(self.controller.removeTreeNode(path))
            let groups = self.treeSummary().objectValue?["groups"] ?? .array([])
            return ["groups": groups]
        }

        add("set_chart_links") { args in
            let nodes = args["nodes"]?.arrayValue?.compactMap { $0.stringValue }
            try self.check(self.controller.setLinks(args["links"] ?? .array([]), nodes: nodes))
            return self.linksSummary()
        }

        add("import_chart_links_csv") { args in
            let csv = args["csv"]?.stringValue ?? ""
            let rows = parseCsv(csv, options: CsvParseOptions(delimiter: csv.contains("\t") ? "\t" : ",")).map {
                $0.map(JSONValue.string)
            }
            let header = ChartHeaderOption.from(args["header"])
            try self.check(self.controller.importLinksTable(rows, header: header))
            return self.linksSummary()
        }

        add("add_chart_link") { args in
            let result = self.controller.addLink(.object(args))
            try self.check(result)
            let idx = result.index ?? 0
            let s = self.spec()
            let stored = s.links[idx]
            func through(_ name: String) -> Double {
                guard let nIdx = s.sankeyNodes.firstIndex(of: name),
                      let vals = s.series.first?.values,
                      nIdx < vals.count else { return 0.0 }
                return vals[nIdx] ?? 0.0
            }
            return [
                "index": .number(Double(idx)),
                "link": stored.toJSON(),
                "nodes": .array([stored.source, stored.target].map { name in
                    ["name": .string(name), "value": .number(through(name))]
                })
            ]
        }

        add("update_chart_link") { args in
            let index = args["index"]?.intValue ?? -1
            var patch = args
            patch["index"] = nil
            if patch.isEmpty {
                throw ToolExecutionError(
                    "Nothing to change: pass source, target, value or color with the index, e.g. {\"index\": \(index), \"value\": 40}."
                )
            }
            try self.check(self.controller.updateLink(index, patch))
            return [
                "index": .number(Double(index)),
                "link": self.spec().links[index].toJSON()
            ]
        }

        add("remove_chart_link") { args in
            let index = args["index"]?.intValue ?? -1
            try self.check(self.controller.removeLink(index))
            return [
                "links": .array(self.spec().links.map { $0.toJSON() })
            ]
        }

        add("set_chart_race_frame") { args in
            let frame: Double?
            if let time = args["time"], time != .null {
                frame = try self.raceFrameOf(time)
            } else {
                frame = nil
            }
            try self.check(self.controller.setRaceFrame(frame))
            return self.raceAt(frame)
        }

        add("play_chart_race") { args in
            let msPerStep = args["msPerStep"]?.doubleValue
            try self.check(self.controller.playRace(msPerStep: msPerStep))
            let n = self.spec().categories.count
            let from = self.controller.getState().raceFrame ?? 0.0
            let durationMs = JS.round((Double(n - 1) - from) * (msPerStep ?? 1000.0))
            return [
                "playing": .bool(true),
                "from": .number(from),
                "durationMs": .number(durationMs)
            ]
        }

        add("apply_chart_preset") { args in
            try self.check(self.controller.applyPreset(
                layout: args["layout"]?.stringValue,
                colors: args["colors"]?.stringValue
            ))
            return ["spec": self.controller.toJSON().toJSON()]
        }

        add("transpose_chart") { _ in
            try self.check(self.controller.transpose())
            return [
                "table": self.tableJSON(),
                "series": .array(self.spec().series.map { s in
                    ["id": .string(s.id), "name": .string(s.name)]
                })
            ]
        }

        add("select_chart_element") { args in
            let kind = args["kind"]?.stringValue ?? "none"
            func need(_ val: JSONValue?, _ what: String) throws {
                if val == nil || val == .null {
                    throw ToolExecutionError("kind \"\(kind)\" needs \(what).")
                }
            }
            let sel: ChartSelection?
            switch kind {
            case "none":
                sel = nil
            case "axis":
                try need(args["axis"], "axis")
                guard let axisStr = args["axis"]?.stringValue,
                      let axis = ChartSelectionAxis(rawValue: axisStr) else {
                    throw ToolExecutionError("kind \"\(kind)\" needs axis.")
                }
                sel = .axis(axis)
            case "series":
                try need(args["series"], "series")
                let s = try self.seriesById(args["series"]?.stringValue ?? "")
                sel = .series(seriesId: s.id)
            case "point":
                try need(args["series"], "series")
                try need(args["category"], "category")
                let s = try self.seriesById(args["series"]?.stringValue ?? "")
                sel = .point(seriesId: s.id, index: try self.categoryIndex(args["category"] ?? .null))
            case "category":
                try need(args["category"], "category")
                sel = .category(index: try self.categoryIndex(args["category"] ?? .null))
            case "trendline":
                try need(args["series"], "series")
                try need(args["index"], "index")
                let s = try self.seriesById(args["series"]?.stringValue ?? "")
                sel = .trendline(seriesId: s.id, index: args["index"]?.intValue ?? 0)
            case "chart":
                sel = .chart
            case "title":
                sel = .title
            case "subtitle":
                sel = .subtitle
            case "legend":
                sel = .legend
            default:
                sel = nil
            }
            self.controller.select(sel)
            let now = self.controller.getState().selection
            if sel != nil && now == nil {
                throw ToolExecutionError("Nothing to select there (e.g. the chart has no \(kind) of that kind).")
            }
            return ["selection": now.map { $0.toJSON() } ?? .null]
        }

        add("drag_chart_point") { args in
            let fromObj = args["from"]?.objectValue ?? JSONObject()
            let toObj = args["to"]?.objectValue ?? JSONObject()
            let width = args["width"]?.doubleValue ?? self.size.width
            let height = args["height"]?.doubleValue ?? self.size.height
            let fine = args["fine"]?.boolValue
            let lockAxis = args["lockAxis"]?.boolValue
            let scene = layoutChart(
                self.controller.toJSON(),
                ChartLayoutOptions(width: width, height: height, measureText: self.controller.measureText)
            )
            let fromX = fromObj["x"]?.doubleValue ?? 0.0
            let fromY = fromObj["y"]?.doubleValue ?? 0.0
            let start = (x: fromX * width, y: fromY * height)
            let target = chartHitTest(scene, start, self.controller.measureText ?? estimateChartTextWidth)
            guard case .point(let seriesId, let index) = target else {
                let what = target.map { "that is the \($0.kindName)" } ?? "that is outside the chart"
                throw ToolExecutionError(
                    "There is no bar or point at (\(JSONValue.jsNumber(fromX)), \(JSONValue.jsNumber(fromY))); \(what). Use render_chart to find marks."
                )
            }
            let before = self.controller.getSeries(seriesId)?.values[index] ?? nil
            guard let session = startChartPointDrag(self.controller, scene, target, start) else {
                throw ToolExecutionError("That point cannot be dragged here (percent-stacked charts, pies and gaps cannot be dragged).")
            }
            session.move(
                (x: (toObj["x"]?.doubleValue ?? 0.0) * width, y: (toObj["y"]?.doubleValue ?? 0.0) * height),
                ChartDragMoveOptions(fine: fine, lockAxis: lockAxis)
            )
            session.end()
            let s = self.controller.getSeries(seriesId)!
            var out = JSONObject([
                ("series", .string(s.id)),
                ("category", .string(self.spec().categories[index])),
                ("index", .number(Double(index))),
                ("before", before.map(JSONValue.number) ?? .null),
                ("after", s.values[index].map(JSONValue.number) ?? .null)
            ])
            if let xs = s.x, index < xs.count {
                out["x"] = xs[index].map(JSONValue.number) ?? .null
            }
            return .object(out)
        }

        add("press_chart_key") { args in
            let k = args["key"]?.stringValue ?? ""
            let shift = args["shift"]?.boolValue
            let alt = args["alt"]?.boolValue
            let scene = layoutChart(
                self.controller.toJSON(),
                ChartLayoutOptions(width: self.size.width, height: self.size.height, measureText: self.controller.measureText)
            )
            let used = handleChartKey(self.controller, scene, ChartKeyInput(key: k, shiftKey: shift, altKey: alt))
            let sel = self.controller.getState().selection
            var out = JSONObject([
                ("used", .bool(used)),
                ("selection", sel.map { $0.toJSON() } ?? .null)
            ])
            if case .point(let seriesId, let index) = sel {
                let val = self.controller.getSeries(seriesId)?.values[index] ?? nil
                out["value"] = val.map(JSONValue.number) ?? .null
            }
            return .object(out)
        }

        add("undo_chart") { _ in
            let label = self.controller.getState().undoLabel
            let undone = self.controller.undo()
            let nextLabel = self.controller.getState().undoLabel
            var out = JSONObject([("undone", .bool(undone))])
            if undone {
                out["label"] = .string(label)
            }
            out["next"] = nextLabel.isEmpty ? .null : .string(nextLabel)
            return .object(out)
        }

        add("redo_chart") { _ in
            let label = self.controller.getState().redoLabel
            let redone = self.controller.redo()
            var out = JSONObject([("redone", .bool(redone))])
            if redone {
                out["label"] = .string(label)
            }
            return .object(out)
        }

        return list
    }
}
