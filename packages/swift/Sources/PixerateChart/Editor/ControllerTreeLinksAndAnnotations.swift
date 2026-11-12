import Foundation
import PixerateCore
import PixerateRaster

extension ChartController {
    // -------------------------------------------------------------------------
    // Grouped data (tree)
    // -------------------------------------------------------------------------

    internal func treeLocked() -> ChartActionResult? {
        if !spec.links.isEmpty {
            return reject(
                "This chart's data is flows (links): its categories are the nodes and its values how much passes through each. Change it with setLinks / the flow edits (set_chart_links, add_chart_link, update_chart_link, remove_chart_link), or replace it with new data."
            )
        }
        if spec.tree.isEmpty { return nil }
        return reject(
            "This chart's data is grouped (a tree): its categories and values are the top-level groups and their totals. Change it with setTree / the tree node edits (set_chart_tree, add_chart_tree_node, update_chart_tree_node, remove_chart_tree_node), or replace it with new data."
        )
    }

    @discardableResult
    public func setTree(_ tree: JSONValue, options: ChartEditOptions = ChartEditOptions()) -> ChartActionResult {
        var treeIssues: [ChartIssue] = []
        let next = normalizeChartTree(tree, &treeIssues)
        if !treeIssues.isEmpty {
            return reject(treeIssues.map { $0.message }.joined(separator: " "), treeIssues)
        }
        return update(
            JSONObject([
                ("tree", .array(next.map { $0.toJSON() })),
                ("links", .array([]))
            ]),
            options: ChartEditOptions(label: options.label ?? (!next.isEmpty ? "Replace grouped data" : "Ungroup data"))
        )
    }

    @discardableResult
    public func setTreeRows(_ rows: [(path: [JSONValue], value: JSONValue?)], options: ChartEditOptions = ChartEditOptions()) -> ChartActionResult {
        var treeIssues: [ChartIssue] = []
        var next = chartTreeFromRows(rows, &treeIssues)
        if !treeIssues.isEmpty {
            return reject(treeIssues.map { $0.message }.joined(separator: " "), treeIssues)
        }
        func keepColors(_ list: inout [ChartTreeNode], _ prefix: [String]) {
            for i in list.indices {
                let p = prefix + [list[i].name]
                if let old = findChartTreeNode(spec.tree, p), let c = old.color {
                    list[i].color = c
                }
                if list[i].children != nil {
                    keepColors(&list[i].children!, p)
                }
            }
        }
        keepColors(&next, [])
        return update(
            JSONObject([("tree", .array(next.map { $0.toJSON() }))]),
            options: ChartEditOptions(label: options.label ?? "Edit grouped data")
        )
    }

    @discardableResult
    public func importTreeTable(_ rows: [[JSONValue]], header: ChartHeaderOption? = nil) -> ChartActionResult {
        var treeIssues: [ChartIssue] = []
        let next = chartTreeFromTable(rows, header: header ?? .auto, &treeIssues)
        if !treeIssues.isEmpty {
            return reject(treeIssues.map { $0.message }.joined(separator: " "), treeIssues)
        }
        if next.isEmpty {
            return reject("There is no grouped data to import: expected rows of names followed by a value, e.g. \"Europe,France,40\".")
        }
        return update(
            JSONObject([
                ("tree", .array(next.map { $0.toJSON() })),
                ("links", .array([]))
            ]),
            options: ChartEditOptions(label: "Import grouped data")
        )
    }

    internal func nodeAt(_ path: [String]) -> Result<ChartTreeNode, ChartActionResult> {
        if let node = findChartTreeNode(spec.tree, path) {
            return .success(node)
        }
        let known = path.count > 1 ? findChartTreeNode(spec.tree, Array(path.dropLast())) : nil
        let siblings = (path.count > 1 ? known?.children : spec.tree) ?? []
        let pathJson = JSONValue.array(path.map(JSONValue.string)).stringified()
        let detail: String
        if !siblings.isEmpty {
            let prefix = (path.count > 1 && known != nil) ? "\"\(known!.name)\" contains" : "The top level has"
            let names = siblings.prefix(20).map { "\"\($0.name)\"" }.joined(separator: ", ")
            detail = "\(prefix) \(names)."
        } else {
            detail = "The chart has no grouped data yet; add nodes with add_chart_tree_node or set_chart_tree."
        }
        return .failure(.failure("There is no node \(pathJson). \(detail)"))
    }

    @discardableResult
    public func addTreeNode(_ parent: [String], _ input: JSONValue, at: Int? = nil) -> ChartActionResult {
        let siblings: [ChartTreeNode]
        if !parent.isEmpty {
            switch nodeAt(parent) {
            case .failure(let err):
                return err
            case .success(let group):
                guard let children = group.children else {
                    return reject("\"\(group.name)\" is an item with its own value, not a group; add the node next to it, or turn it into a group by replacing the tree with set_chart_tree.")
                }
                siblings = children
            }
        } else {
            siblings = spec.tree
        }
        var nodeIssues: [ChartIssue] = []
        let normalized = normalizeChartTree(.array([input]), &nodeIssues, "node")
        guard let node = normalized.first, nodeIssues.isEmpty else {
            let msg = nodeIssues.map { $0.message }.joined(separator: " ")
            return reject(msg.isEmpty ? "The node is not valid." : msg, nodeIssues)
        }
        if siblings.contains(where: { $0.name == node.name }) {
            return reject("\"\(node.name)\" is already there; names under one group must be unique.")
        }
        let insertAt = Swift.max(0, Swift.min(siblings.count, at ?? siblings.count))
        var tree = cloneChartTree(spec.tree)
        func insertInto(_ list: inout [ChartTreeNode], _ p: ArraySlice<String>) {
            guard let head = p.first else {
                list.insert(node, at: insertAt)
                return
            }
            if let idx = list.firstIndex(where: { $0.name == head }), list[idx].children != nil {
                insertInto(&list[idx].children!, p.dropFirst())
            }
        }
        insertInto(&tree, parent[...])
        let result = update(
            JSONObject([("tree", .array(tree.map { $0.toJSON() }))]),
            options: ChartEditOptions(label: "Add \"\(node.name)\"")
        )
        if !result.ok { return result }
        return .success(path: parent + [node.name])
    }

    @discardableResult
    public func updateTreeNode(_ path: [String], _ patch: JSONObject) -> ChartActionResult {
        let node: ChartTreeNode
        switch nodeAt(path) {
        case .failure(let err): return err
        case .success(let n): node = n
        }
        if patch["value"] != nil && node.children != nil {
            return reject("\"\(node.name)\" is a group: its value is the sum of its items. Change the items instead.")
        }
        let name = patch["name"] != nil ? jsCellString(patch["name"]).jsTrimmed : node.name
        let allSiblings = path.count > 1 ? (findChartTreeNode(spec.tree, Array(path.dropLast()))?.children ?? []) : spec.tree
        let siblings = allSiblings.filter { $0 != node }
        if siblings.contains(where: { $0.name == name }) {
            return reject("There is already a \"\(name)\" next to \"\(node.name)\"; names under one group must be unique.")
        }
        guard case .object(var merged) = node.toJSON() else { return .failure("Internal error") }
        merged["name"] = .string(name)
        if let val = patch["value"] { merged["value"] = val }
        if let col = patch["color"] {
            if col == .null { merged["color"] = nil }
            else { merged["color"] = col }
        }
        var nodeIssues: [ChartIssue] = []
        let normalized = normalizeChartTree(.array([.object(merged)]), &nodeIssues, "node")
        guard var checked = normalized.first, nodeIssues.isEmpty else {
            return reject(nodeIssues.map { $0.message }.joined(separator: " "), nodeIssues)
        }
        if patch["color"] == .null { checked.color = nil }
        var tree = cloneChartTree(spec.tree)
        func replaceIn(_ list: inout [ChartTreeNode], _ p: ArraySlice<String>) {
            guard let head = p.first, let idx = list.firstIndex(where: { $0.name == head }) else { return }
            if p.count == 1 {
                list[idx] = checked
            } else if list[idx].children != nil {
                replaceIn(&list[idx].children!, p.dropFirst())
            }
        }
        replaceIn(&tree, path[...])
        let label = (patch["name"] != nil && name != node.name) ? "Rename group" : "Change \"\(node.name)\""
        let result = update(JSONObject([("tree", .array(tree.map { $0.toJSON() }))]), options: ChartEditOptions(label: label))
        if !result.ok { return result }
        return .success(path: Array(path.dropLast()) + [name])
    }

    @discardableResult
    public func removeTreeNode(_ path: [String]) -> ChartActionResult {
        let node: ChartTreeNode
        switch nodeAt(path) {
        case .failure(let err): return err
        case .success(let n): node = n
        }
        var tree = cloneChartTree(spec.tree)
        func removeFrom(_ list: inout [ChartTreeNode], _ p: ArraySlice<String>) {
            guard let head = p.first, let idx = list.firstIndex(where: { $0.name == head }) else { return }
            if p.count == 1 {
                list.remove(at: idx)
            } else if list[idx].children != nil {
                removeFrom(&list[idx].children!, p.dropFirst())
                if list[idx].children?.isEmpty == true {
                    list[idx].children = nil
                    list[idx].value = 0
                }
            }
        }
        removeFrom(&tree, path[...])
        return update(
            JSONObject([("tree", .array(tree.map { $0.toJSON() }))]),
            options: ChartEditOptions(label: "Delete \"\(node.name)\"")
        )
    }

    // -------------------------------------------------------------------------
    // Flows (links)
    // -------------------------------------------------------------------------

    @discardableResult
    public func setLinks(_ links: JSONValue, nodes: [String]? = nil, options: ChartEditOptions = ChartEditOptions()) -> ChartActionResult {
        var linkIssues: [ChartIssue] = []
        let next = normalizeChartLinks(links, &linkIssues)
        if !linkIssues.isEmpty {
            return reject(linkIssues.map { $0.message }.joined(separator: " "), linkIssues)
        }
        let used = Set(next.flatMap { [$0.source, $0.target] })
        let sankeyNodes = nodes ?? spec.sankeyNodes.filter { used.contains($0) }
        return update(
            JSONObject([
                ("links", .array(next.map { $0.toJSON() })),
                ("tree", .array([])),
                ("sankeyNodes", .array(sankeyNodes.map(JSONValue.string)))
            ]),
            options: ChartEditOptions(label: options.label ?? (!next.isEmpty ? "Replace flows" : "Remove flows"))
        )
    }

    @discardableResult
    public func importLinksTable(_ rows: [[JSONValue]], header: ChartHeaderOption? = nil) -> ChartActionResult {
        let raw = chartLinksFromTable(rows, header: header ?? .auto)
        if raw.isEmpty {
            return reject("There are no flows to import: expected rows of source, target and value, e.g. \"Website,Signup,120\".")
        }
        return setLinks(.array(raw), options: ChartEditOptions(label: "Import flows"))
    }

    internal func badLink(_ index: Int) -> ChartActionResult {
        let n = spec.links.count
        return .failure("There is no flow \(index); \(n > 0 ? "expected 0 to \(n - 1)" : "the chart has none yet").")
    }

    @discardableResult
    public func addLink(_ link: ChartLink) -> ChartActionResult {
        addLink(link.toJSON())
    }

    @discardableResult
    public func addLink(_ link: JSONValue) -> ChartActionResult {
        let src: String
        let dst: String
        if case .object(let obj) = link {
            src = jsCellString(obj["source"] ?? .string(""))
            dst = jsCellString(obj["target"] ?? .string(""))
        } else {
            src = ""
            dst = ""
        }
        let allLinks = spec.links.map { $0.toJSON() } + [link]
        let result = setLinks(.array(allLinks), options: ChartEditOptions(label: "Add flow \(src) → \(dst)"))
        if !result.ok { return result }
        return .success(index: spec.links.count - 1)
    }

    @discardableResult
    public func updateLink(_ index: Int, _ patch: JSONObject) -> ChartActionResult {
        guard index >= 0 && index < spec.links.count else { return badLink(index) }
        let current = spec.links[index]
        guard case .object(var merged) = current.toJSON() else { return .failure("Internal error") }
        for (k, v) in patch {
            if k == "color" && v == .null {
                merged["color"] = nil
            } else {
                merged[k] = v
            }
        }
        let nextLinks: [JSONValue] = spec.links.enumerated().map { i, l in
            i == index ? .object(merged) : l.toJSON()
        }
        return setLinks(.array(nextLinks), options: ChartEditOptions(label: "Change flow"))
    }

    @discardableResult
    public func removeLink(_ index: Int) -> ChartActionResult {
        guard index >= 0 && index < spec.links.count else { return badLink(index) }
        let current = spec.links[index]
        let nextLinks: [JSONValue] = spec.links.enumerated().compactMap { i, l -> JSONValue? in
            if i == index { return nil }
            return l.toJSON()
        }
        return setLinks(
            .array(nextLinks),
            options: ChartEditOptions(label: "Delete flow \(current.source) → \(current.target)")
        )
    }
}

extension ChartController {
    // -------------------------------------------------------------------------
    // Annotations
    // -------------------------------------------------------------------------

    @discardableResult
    public func setNote(_ note: String) -> ChartActionResult {
        update(
            JSONObject([("note", .string(note))]),
            options: ChartEditOptions(label: !note.isEmpty ? "Edit note" : "Remove note")
        )
    }

    @discardableResult
    public func setHighlight(_ names: [String]) -> ChartActionResult {
        let s = spec
        var seen = Set<String>()
        var list: [String] = []
        for n in names {
            if seen.insert(n).inserted { list.append(n) }
        }
        let unknown = list.filter { n in
            !s.categories.contains(n) && !s.series.contains(where: { $0.id == n || $0.name == n })
        }
        if !unknown.isEmpty {
            let unknownStr = unknown.map { "\"\($0)\"" }.joined(separator: ", ")
            let verb = unknown.count == 1 ? "is" : "are"
            let catsStr = s.categories.isEmpty ? "(none)" : s.categories.prefix(20).map { "\"\($0)\"" }.joined(separator: ", ")
            let seriesStr = s.series.isEmpty ? "(none)" : s.series.map { "\"\($0.name)\"" }.joined(separator: ", ")
            return reject("\(unknownStr) \(verb) neither a category nor a series. Categories: \(catsStr); series: \(seriesStr).")
        }
        let result = update(
            JSONObject([("highlight", .array(list.map(JSONValue.string)))]),
            options: ChartEditOptions(label: !list.isEmpty ? "Highlight" : "Clear highlight")
        )
        if !result.ok { return result }
        let matchedCategories = s.categories.enumerated().compactMap { i, c in list.contains(c) ? i : nil }
        let matchedSeries = s.series.filter { list.contains($0.id) || list.contains($0.name) }.map { $0.id }
        return .success(categories: matchedCategories, series: matchedSeries)
    }

    internal func referenceProblem(_ axis: ChartReferenceAxis?, _ values: [Double]) -> String? {
        let s = spec
        let family = chartFamily(s)
        if family != .cartesian && family != .xy {
            return "Reference lines and bands are drawn on bar, line, area, scatter and bubble charts; this is a \(s.type.rawValue) chart."
        }
        if axis == .x && family != .xy {
            return "axis \"x\" needs a scatter or bubble chart with numeric x values; use \"y\" for the value axis."
        }
        if axis == .y2 && (family != .cartesian || !s.series.contains(where: { !($0.hidden ?? false) && $0.axis == .secondary })) {
            return "axis \"y2\" needs a visible series on the secondary axis (set one with update_chart_series axis \"secondary\"), or use \"y\"."
        }
        let targetAxis = axis == .x ? s.xAxis : (axis == .y2 ? s.yAxis2 : s.yAxis)
        if targetAxis.scale == .log && values.contains(where: { !($0 > 0) }) {
            return "That axis is logarithmic, so the values must be above 0."
        }
        return nil
    }

    internal func noReference(_ what: String, _ count: Int, _ index: Int) -> String {
        "There is no \(what) \(index); \(count > 0 ? "expected 0 to \(count - 1)" : "the chart has none yet")."
    }

    @discardableResult
    public func addReferenceLine(_ line: ChartReferenceLine) -> ChartActionResult {
        addReferenceLine(line.toJSON())
    }

    @discardableResult
    public func addReferenceLine(_ input: JSONValue) -> ChartActionResult {
        var refIssues: [ChartIssue] = []
        let line = normalizeChartReferenceLine(input, "referenceLine", &refIssues)
        guard let line, refIssues.isEmpty else {
            return reject(refIssues.map { $0.message }.joined(separator: " "), refIssues)
        }
        if let problem = referenceProblem(line.axis, [line.value]) {
            return reject(problem)
        }
        let index = spec.referenceLines.count
        let label = "Add reference line\(line.label.map { !$0.isEmpty ? " \"\($0)\"" : "" } ?? "")"
        commit(label, edited { $0.referenceLines.append(line) })
        return .success(index: index)
    }

    @discardableResult
    public func updateReferenceLine(_ index: Int, _ patch: JSONObject) -> ChartActionResult {
        guard index >= 0 && index < spec.referenceLines.count else {
            return .failure(noReference("reference line", spec.referenceLines.count, index))
        }
        let current = spec.referenceLines[index]
        guard case .object(var merged) = current.toJSON() else { return .failure("Internal error") }
        for (k, v) in patch {
            if v == .null { merged[k] = nil }
            else { merged[k] = v }
        }
        var refIssues: [ChartIssue] = []
        let line = normalizeChartReferenceLine(.object(merged), "referenceLine", &refIssues)
        guard let line, refIssues.isEmpty else {
            return reject(refIssues.map { $0.message }.joined(separator: " "), refIssues)
        }
        if let problem = referenceProblem(line.axis, [line.value]) {
            return reject(problem)
        }
        commit("Change reference line", edited { $0.referenceLines[index] = line })
        return .success()
    }

    @discardableResult
    public func removeReferenceLine(_ index: Int) -> ChartActionResult {
        guard index >= 0 && index < spec.referenceLines.count else {
            return .failure(noReference("reference line", spec.referenceLines.count, index))
        }
        commit("Delete reference line", edited { $0.referenceLines.remove(at: index) })
        return .success()
    }

    @discardableResult
    public func addReferenceBand(_ band: ChartReferenceBand) -> ChartActionResult {
        addReferenceBand(band.toJSON())
    }

    @discardableResult
    public func addReferenceBand(_ input: JSONValue) -> ChartActionResult {
        var refIssues: [ChartIssue] = []
        let band = normalizeChartReferenceBand(input, "referenceBand", &refIssues)
        guard let band, refIssues.isEmpty else {
            return reject(refIssues.map { $0.message }.joined(separator: " "), refIssues)
        }
        if let problem = referenceProblem(band.axis, [band.from, band.to]) {
            return reject(problem)
        }
        let index = spec.referenceBands.count
        let label = "Add reference band\(band.label.map { !$0.isEmpty ? " \"\($0)\"" : "" } ?? "")"
        commit(label, edited { $0.referenceBands.append(band) })
        return .success(index: index)
    }

    @discardableResult
    public func updateReferenceBand(_ index: Int, _ patch: JSONObject) -> ChartActionResult {
        guard index >= 0 && index < spec.referenceBands.count else {
            return .failure(noReference("reference band", spec.referenceBands.count, index))
        }
        let current = spec.referenceBands[index]
        guard case .object(var merged) = current.toJSON() else { return .failure("Internal error") }
        for (k, v) in patch {
            if v == .null { merged[k] = nil }
            else { merged[k] = v }
        }
        var refIssues: [ChartIssue] = []
        let band = normalizeChartReferenceBand(.object(merged), "referenceBand", &refIssues)
        guard let band, refIssues.isEmpty else {
            return reject(refIssues.map { $0.message }.joined(separator: " "), refIssues)
        }
        if let problem = referenceProblem(band.axis, [band.from, band.to]) {
            return reject(problem)
        }
        commit("Change reference band", edited { $0.referenceBands[index] = band })
        return .success()
    }

    @discardableResult
    public func removeReferenceBand(_ index: Int) -> ChartActionResult {
        guard index >= 0 && index < spec.referenceBands.count else {
            return .failure(noReference("reference band", spec.referenceBands.count, index))
        }
        commit("Delete reference band", edited { $0.referenceBands.remove(at: index) })
        return .success()
    }

    @discardableResult
    public func setCallout(_ seriesId: String, _ index: Int, _ label: String?) -> ChartActionResult {
        guard let series = getSeries(seriesId) else { return unknownSeries(seriesId) }
        guard index >= 0 && index < spec.categories.count else { return badIndex(index) }
        let family = chartFamily(spec)
        let text = label?.jsTrimmed ?? ""
        if !text.isEmpty && family != .cartesian && family != .xy {
            return reject("Callouts are drawn on bar, line, area, scatter and bubble charts; this is a \(spec.type.rawValue) chart.")
        }
        if !text.isEmpty && (index >= series.values.count || series.values[index] == nil) {
            return reject("\"\(series.name)\" has no value at \"\(spec.categories[index])\", so there is nothing to point at; set a value first.")
        }
        let next = edited { d in
            guard let sIdx = d.series.firstIndex(where: { $0.id == seriesId }) else { return }
            var labels = d.series[sIdx].callouts ?? d.categories.map { _ in nil as String? }
            while labels.count < d.categories.count { labels.append(nil) }
            labels[index] = text.isEmpty ? nil : text
            if labels.contains(where: { $0 != nil && !$0!.isEmpty }) {
                d.series[sIdx].callouts = labels
            } else {
                d.series[sIdx].callouts = nil
            }
        }
        commit(!text.isEmpty ? "Add callout" : "Remove callout", next, select: .some(.point(seriesId: seriesId, index: index)))
        return .success()
    }

    // -------------------------------------------------------------------------
    // Trendlines
    // -------------------------------------------------------------------------

    @discardableResult
    public func addTrendline(_ seriesId: String, _ line: ChartTrendline) -> ChartActionResult {
        addTrendline(seriesId, line.toJSON())
    }

    @discardableResult
    public func addTrendline(_ seriesId: String, _ input: JSONValue) -> ChartActionResult {
        guard let series = getSeries(seriesId) else { return unknownSeries(seriesId) }
        if !chartSupportsTrendlines(spec.type.rawValue, spec.stacking.rawValue) {
            let stackPart = spec.stacking != .none ? "\(spec.stacking.rawValue) " : ""
            return reject("Trendlines need an unstacked bar, line, area, scatter or bubble chart; this is a \(stackPart)\(spec.type.rawValue) chart.")
        }
        var trendIssues: [ChartIssue] = []
        let line = normalizeChartTrendline(input, "trendline", &trendIssues)
        guard let line, trendIssues.isEmpty else {
            let msg = trendIssues.map { $0.message }.joined(separator: " ")
            return reject(msg.isEmpty ? "The trendline is not valid." : msg, trendIssues)
        }
        let index = series.trendlines?.count ?? 0
        let next = edited { d in
            guard let sIdx = d.series.firstIndex(where: { $0.id == seriesId }) else { return }
            d.series[sIdx].trendlines = (d.series[sIdx].trendlines ?? []) + [line]
        }
        commit("Add trendline to \"\(series.name)\"", next, select: .some(.trendline(seriesId: seriesId, index: index)))
        return .success(index: index, fit: trendlineFit(seriesId, index))
    }

    @discardableResult
    public func updateTrendline(_ seriesId: String, _ index: Int, _ patch: JSONObject) -> ChartActionResult {
        guard let series = getSeries(seriesId) else { return unknownSeries(seriesId) }
        let count = series.trendlines?.count ?? 0
        guard index >= 0 && index < count, let current = series.trendlines?[index] else {
            return .failure("\"\(series.name)\" has no trendline \(index); \(count > 0 ? "expected 0 to \(count - 1)" : "it has none yet").")
        }
        guard case .object(var merged) = current.toJSON() else { return .failure("Internal error") }
        for (k, v) in patch {
            if v == .null { merged[k] = nil }
            else { merged[k] = v }
        }
        var trendIssues: [ChartIssue] = []
        let line = normalizeChartTrendline(.object(merged), "trendline", &trendIssues)
        guard let line, trendIssues.isEmpty else {
            return reject(trendIssues.map { $0.message }.joined(separator: " "), trendIssues)
        }
        commit("Change trendline", edited { d in
            if let sIdx = d.series.firstIndex(where: { $0.id == seriesId }) {
                d.series[sIdx].trendlines?[index] = line
            }
        })
        return .success()
    }

    @discardableResult
    public func removeTrendline(_ seriesId: String, _ index: Int) -> ChartActionResult {
        guard let series = getSeries(seriesId) else { return unknownSeries(seriesId) }
        let count = series.trendlines?.count ?? 0
        guard index >= 0 && index < count else {
            return .failure("\"\(series.name)\" has no trendline \(index).")
        }
        commit("Delete trendline", edited { d in
            guard let sIdx = d.series.firstIndex(where: { $0.id == seriesId }) else { return }
            d.series[sIdx].trendlines?.remove(at: index)
            if d.series[sIdx].trendlines?.isEmpty == true {
                d.series[sIdx].trendlines = nil
            }
        })
        return .success()
    }

    public func trendlinePoints(_ seriesId: String) -> [(Double, Double)] {
        guard let series = getSeries(seriesId) else { return [] }
        let xy = chartFamily(spec) == .xy
        var out: [(Double, Double)] = []
        for (i, v) in series.values.enumerated() {
            let x: Double? = xy
                ? ((series.x != nil && i < series.x!.count ? series.x![i] : nil) ?? (spec.type == .bubble ? Double(i + 1) : nil))
                : Double(i + 1)
            if let v, let x, v.isFinite && x.isFinite {
                out.append((x, v))
            }
        }
        return out
    }

    public func trendlineFit(_ seriesId: String, _ index: Int) -> ChartTrendFit? {
        guard let t = getSeries(seriesId)?.trendlines, index >= 0 && index < t.count else { return nil }
        return fitChartTrendline(t[index], trendlinePoints(seriesId))
    }

    public func trendlineMovingAverage(_ seriesId: String, _ index: Int) -> [(Double, Double)] {
        guard let t = getSeries(seriesId)?.trendlines, index >= 0 && index < t.count else { return [] }
        let line = t[index]
        guard line.type == .movingAverage else { return [] }
        return chartMovingAverage(trendlinePoints(seriesId), Double(line.period ?? 2))
    }

    // -------------------------------------------------------------------------
    // Selection and gestures
    // -------------------------------------------------------------------------

    @discardableResult
    public func setRaceFrame(_ frame: Double?) -> ChartActionResult {
        let n = spec.categories.count
        if let frame {
            if !frame.isFinite || frame < 0 || frame > Double(Swift.max(0, n - 1)) {
                let rangePart = n > 1 ? " (\"\(spec.categories[0])\" to \"\(spec.categories[n - 1])\")" : ""
                let msg = n > 0
                    ? "The race has time points 0 to \(n - 1)\(rangePart); got \(JSONValue.jsString(frame))."
                    : "The chart has no time points (categories) yet."
                return .failure(msg)
            }
        }
        stopRace()
        if frame == raceFrame { return .success() }
        raceFrame = frame
        notify(specChanged: false)
        return .success()
    }

    /// `last` is captured when playback starts, as the TS `step` closure does: editing categories
    /// mid-race does not move the end.
    private func scheduleRaceStep(from: Double, start: Double, per: Double, last: Double) {
        raceStop = raceTicker.next { [weak self] in
            guard let self else { return }
            let at = Swift.min(last, from + (self.raceTicker.now() - start) / per)
            self.raceFrame = at
            if at >= last {
                self.raceStop = nil
                self.raceFrame = nil
            } else {
                self.scheduleRaceStep(from: from, start: start, per: per, last: last)
            }
            self.notify(specChanged: false)
        }
    }

    @discardableResult
    public func playRace(msPerStep: Double? = nil) -> ChartActionResult {
        let last = Double(spec.categories.count - 1)
        if last < 1 { return .failure("A race needs at least two time points (categories) to play.") }
        stopRace()
        let per = Swift.max(50.0, msPerStep ?? 1000.0)
        let from = (raceFrame == nil || raceFrame! >= last) ? 0.0 : raceFrame!
        let start = raceTicker.now()
        raceFrame = from
        scheduleRaceStep(from: from, start: start, per: per, last: last)
        notify(specChanged: false)
        return .success()
    }

    public func pauseRace() {
        guard raceStop != nil else { return }
        stopRace()
        notify(specChanged: false)
    }

    internal func stopRace() {
        raceStop?()
        raceStop = nil
    }

    public func select(_ sel: ChartSelection?) {
        let next = validSelection(sel, spec)
        if sameChartSelection(next, selection) || (next == nil && selection == nil) { return }
        selection = next
        notify(specChanged: false)
    }

    @discardableResult
    public func deleteSelection() -> ChartActionResult {
        guard let sel = selection else { return .failure("Nothing is selected.") }
        switch sel {
        case .series(let seriesId):
            return removeSeries(seriesId)
        case .category(let index):
            return removeCategory(index)
        case .point(let seriesId, let index):
            return setValue(seriesId, index, .null, options: ChartEditOptions(label: "Clear value"))
        case .title:
            return setTitle("")
        case .subtitle:
            return setSubtitle("")
        case .legend:
            return setLegend(JSONObject([("show", .bool(false))]))
        case .axis(let axis):
            return setAxis(axis, JSONObject([("show", .bool(false))]))
        case .trendline(let seriesId, let index):
            return removeTrendline(seriesId, index)
        case .chart:
            return .failure("The chart itself cannot be deleted.")
        }
    }

    @discardableResult
    public func nudgeValue(_ seriesId: String, _ index: Int, _ delta: Double) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        guard let series = getSeries(seriesId) else { return unknownSeries(seriesId) }
        let current = (index >= 0 && index < series.values.count ? series.values[index] : nil) ?? 0.0
        let nextVal = Double(jsToPrecision(current + delta, 12)) ?? (current + delta)
        let catLabel = (index >= 0 && index < spec.categories.count) ? spec.categories[index] : "\(index)"
        return setValue(seriesId, index, .number(nextVal), options: ChartEditOptions(label: "Edit \(series.name) · \(catLabel)"))
    }
}
