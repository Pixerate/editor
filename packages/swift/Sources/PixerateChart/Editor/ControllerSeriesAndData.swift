import Foundation
import PixerateCore

extension ChartSeries {
    internal mutating func insertCategoryPoint(at index: Int) {
        let clamped = Swift.max(0, Swift.min(values.count, index))
        values.insert(nil, at: clamped)
        if x != nil { x!.insert(nil, at: Swift.min(x!.count, clamped)) }
        if sizes != nil { sizes!.insert(nil, at: Swift.min(sizes!.count, clamped)) }
        if pointColors != nil { pointColors!.insert(nil, at: Swift.min(pointColors!.count, clamped)) }
        if callouts != nil { callouts!.insert(nil, at: Swift.min(callouts!.count, clamped)) }
        if errorBars?.plus != nil { errorBars!.plus!.insert(nil, at: Swift.min(errorBars!.plus!.count, clamped)) }
        if errorBars?.minus != nil { errorBars!.minus!.insert(nil, at: Swift.min(errorBars!.minus!.count, clamped)) }
        if xErrorBars?.plus != nil { xErrorBars!.plus!.insert(nil, at: Swift.min(xErrorBars!.plus!.count, clamped)) }
        if xErrorBars?.minus != nil { xErrorBars!.minus!.insert(nil, at: Swift.min(xErrorBars!.minus!.count, clamped)) }
    }

    internal mutating func removeCategoryPoint(at index: Int) {
        if index >= 0 && index < values.count { values.remove(at: index) }
        if x != nil, index >= 0 && index < x!.count { x!.remove(at: index) }
        if sizes != nil, index >= 0 && index < sizes!.count { sizes!.remove(at: index) }
        if pointColors != nil, index >= 0 && index < pointColors!.count { pointColors!.remove(at: index) }
        if callouts != nil, index >= 0 && index < callouts!.count { callouts!.remove(at: index) }
        if errorBars?.plus != nil, index >= 0 && index < errorBars!.plus!.count { errorBars!.plus!.remove(at: index) }
        if errorBars?.minus != nil, index >= 0 && index < errorBars!.minus!.count { errorBars!.minus!.remove(at: index) }
        if xErrorBars?.plus != nil, index >= 0 && index < xErrorBars!.plus!.count { xErrorBars!.plus!.remove(at: index) }
        if xErrorBars?.minus != nil, index >= 0 && index < xErrorBars!.minus!.count { xErrorBars!.minus!.remove(at: index) }
    }

    internal mutating func moveCategoryPoint(from: Int, to: Int) {
        func moveIn<T>(_ arr: inout [T]) {
            guard from >= 0 && from < arr.count else { return }
            let target = Swift.max(0, Swift.min(arr.count - 1, to))
            let item = arr.remove(at: from)
            arr.insert(item, at: target)
        }
        moveIn(&values)
        if x != nil { moveIn(&x!) }
        if sizes != nil { moveIn(&sizes!) }
        if pointColors != nil { moveIn(&pointColors!) }
        if callouts != nil { moveIn(&callouts!) }
        if errorBars?.plus != nil { moveIn(&errorBars!.plus!) }
        if errorBars?.minus != nil { moveIn(&errorBars!.minus!) }
        if xErrorBars?.plus != nil { moveIn(&xErrorBars!.plus!) }
        if xErrorBars?.minus != nil { moveIn(&xErrorBars!.minus!) }
    }
}

extension ChartController {
    @discardableResult
    public func setData(
        _ data: JSONObject,
        options: ChartEditOptions = ChartEditOptions()
    ) -> ChartActionResult {
        var patch = JSONObject()
        if let categories = data["categories"] { patch["categories"] = categories }
        if let series = data["series"] { patch["series"] = series }
        if (data["categories"] != nil || data["series"] != nil) && (!spec.tree.isEmpty || !spec.links.isEmpty) {
            patch["tree"] = .array([])
            patch["links"] = .array([])
        }
        return update(patch, options: ChartEditOptions(label: options.label ?? "Edit chart data"))
    }

    @discardableResult
    public func setData(
        categories: [JSONValue]? = nil,
        series: [JSONValue]? = nil,
        options: ChartEditOptions = ChartEditOptions()
    ) -> ChartActionResult {
        var patch = JSONObject()
        if let categories { patch["categories"] = .array(categories) }
        if let series { patch["series"] = .array(series) }
        if (categories != nil || series != nil) && (!spec.tree.isEmpty || !spec.links.isEmpty) {
            patch["tree"] = .array([])
            patch["links"] = .array([])
        }
        return update(patch, options: ChartEditOptions(label: options.label ?? "Edit chart data"))
    }

    @discardableResult
    public func setValue(
        _ seriesId: String,
        _ index: Int,
        _ value: JSONValue?,
        options: ChartEditOptions = ChartEditOptions()
    ) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        guard let series = getSeries(seriesId) else { return unknownSeries(seriesId) }
        guard index >= 0 && index < spec.categories.count else { return badIndex(index) }
        guard let parsed = parseChartValue(value) else {
            let valStr = jsCellString(value)
            return reject(
                "\"\(valStr)\" is not a number; enter a number or leave the cell blank.",
                [ChartIssue(path: "\(seriesId)[\(index)]", message: "\"\(valStr)\" is not a number.")]
            )
        }
        if series.values[index] == parsed {
            if !issues.isEmpty {
                issues = []
                notify(specChanged: false)
            }
            return .success()
        }
        let next = edited { d in
            if let sIdx = d.series.firstIndex(where: { $0.id == seriesId }) {
                d.series[sIdx].values[index] = parsed
            }
        }
        commit(options.label ?? "Edit \(series.name) · \(spec.categories[index])", next)
        return .success()
    }

    @discardableResult
    public func setValues(
        _ cells: [(seriesId: String, index: Int, value: JSONValue?)],
        options: ChartEditOptions = ChartEditOptions()
    ) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        var cellIssues: [ChartIssue] = []
        var parsedCells: [(seriesId: String, index: Int, value: ChartValue)] = []
        for cell in cells {
            if getSeries(cell.seriesId) == nil {
                cellIssues.append(ChartIssue(path: cell.seriesId, message: unknownSeries(cell.seriesId).message ?? ""))
            } else if cell.index < 0 || cell.index >= spec.categories.count {
                cellIssues.append(ChartIssue(path: "\(cell.seriesId)[\(cell.index)]", message: badIndex(cell.index).message ?? ""))
            } else if let value = parseChartValue(cell.value) {
                parsedCells.append((seriesId: cell.seriesId, index: cell.index, value: value))
            } else {
                cellIssues.append(ChartIssue(
                    path: "\(cell.seriesId)[\(cell.index)]",
                    message: "\"\(jsCellString(cell.value))\" is not a number."
                ))
            }
        }
        if !cellIssues.isEmpty {
            return reject(cellIssues.map { $0.message }.joined(separator: " "), cellIssues)
        }
        let next = edited { d in
            for cell in parsedCells {
                if let sIdx = d.series.firstIndex(where: { $0.id == cell.seriesId }) {
                    d.series[sIdx].values[cell.index] = cell.value
                }
            }
        }
        if next.series != spec.series {
            commit(options.label ?? "Edit values", next)
        }
        return .success()
    }

    @discardableResult
    public func addSeries(_ input: JSONObject = JSONObject(), at: Int? = nil) -> ChartActionResult {
        let inputId = input["id"]?.stringValue
        let id: String
        if let inputId, !inputId.isEmpty, getSeries(inputId) == nil {
            id = inputId
        } else {
            id = uniqueChartSeriesId(spec.series)
        }
        let name = input["name"]?.stringValue ?? "Series \(spec.series.length + 1)"
        let insertAt = Swift.max(0, Swift.min(spec.series.count, at ?? spec.series.count))
        var seriesArr: [JSONValue] = spec.series.map { $0.toJSON() }
        var newObj = input
        newObj["id"] = .string(id)
        newObj["name"] = .string(name)
        if newObj["values"] == nil {
            newObj["values"] = .array([])
        }
        seriesArr.insert(.object(newObj), at: insertAt)
        guard case .object(var merged) = spec.toJSON() else { return .failure("Internal error") }
        merged["series"] = .array(seriesArr)
        let normalized = normalizeChartSpec(.object(merged))
        if !normalized.issues.isEmpty {
            return reject(normalized.issues.map { $0.message }.joined(separator: " "), normalized.issues)
        }
        commit("Add series \"\(name)\"", normalized.spec, select: .some(.series(seriesId: id)))
        return .success(id: id)
    }

    @discardableResult
    public func removeSeries(_ id: String) -> ChartActionResult {
        guard let series = getSeries(id) else { return unknownSeries(id) }
        commit(
            "Delete series \"\(series.name)\"",
            edited { d in
                d.series.removeAll { $0.id == id }
                d.highlight.removeAll { h in
                    h == id || (h == series.name && !d.series.contains(where: { $0.name == h }) && !d.categories.contains(h))
                }
            }
        )
        return .success()
    }

    @discardableResult
    public func updateSeries(_ id: String, _ patch: JSONObject) -> ChartActionResult {
        guard let series = getSeries(id) else { return unknownSeries(id) }
        guard case .object(var next) = series.toJSON() else { return .failure("Internal error") }
        if let nameVal = patch["name"] {
            next["name"] = .string(jsCellString(nameVal))
        }
        if let colorVal = patch["color"] {
            if colorVal == .null || colorVal.stringValue == "" {
                next["color"] = nil
            } else {
                next["color"] = colorVal
            }
        }
        if let typeVal = patch["type"] {
            if typeVal == .null {
                next["type"] = nil
            } else {
                next["type"] = typeVal
            }
        }
        if let hiddenVal = patch["hidden"] {
            if hiddenVal.boolValue == true {
                next["hidden"] = .bool(true)
            } else {
                next["hidden"] = nil
            }
        }
        let resettable = ["axis", "x", "sizes", "pointColors", "callouts", "marker", "curve", "dataLabels", "format", "errorBars", "xErrorBars"]
        for key in resettable {
            guard let v = patch[key] else { continue }
            if v == .null {
                next[key] = nil
            } else {
                next[key] = v
            }
        }
        if next["axis"]?.stringValue == "primary" {
            next["axis"] = nil
        }
        let nextName = next["name"]?.stringValue ?? series.name
        let series2: [JSONValue] = spec.series.map { s in
            s.id == id ? .object(next) : s.toJSON()
        }
        let renamed = nextName != series.name && spec.highlight.contains(series.name) && !spec.categories.contains(series.name)
        let highlight = renamed ? spec.highlight.map { $0 == series.name ? nextName : $0 } : spec.highlight
        guard case .object(var merged) = spec.toJSON() else { return .failure("Internal error") }
        merged["series"] = .array(series2)
        merged["highlight"] = .array(highlight.map(JSONValue.string))
        let normalized = normalizeChartSpec(.object(merged))
        if !normalized.issues.isEmpty {
            return reject(normalized.issues.map { $0.message }.joined(separator: " "), normalized.issues)
        }
        if normalized.spec.series == spec.series && normalized.spec.highlight == spec.highlight {
            return .success()
        }
        let label: String
        if patch.count == 1, let hidden = patch["hidden"]?.boolValue {
            label = "\(hidden ? "Hide" : "Show") \"\(series.name)\""
        } else if patch.count == 1, patch["name"] != nil {
            label = "Rename series"
        } else {
            label = "Change series \"\(series.name)\""
        }
        commit(label, normalized.spec)
        return .success()
    }

    @discardableResult
    public func toggleSeries(_ id: String) -> ChartActionResult {
        guard let series = getSeries(id) else { return unknownSeries(id) }
        return updateSeries(id, JSONObject([("hidden", .bool(!(series.hidden ?? false)))]))
    }

    @discardableResult
    public func moveSeries(_ id: String, to: Int) -> ChartActionResult {
        guard let from = spec.series.firstIndex(where: { $0.id == id }) else { return unknownSeries(id) }
        let target = Swift.max(0, Swift.min(spec.series.count - 1, to))
        if target == from { return .success() }
        commit(
            "Reorder series",
            edited { d in
                let s = d.series.remove(at: from)
                d.series.insert(s, at: target)
            }
        )
        return .success()
    }
}

private extension Array {
    var length: Int { count }
}

extension ChartController {
    @discardableResult
    public func addCategory(_ label: String? = nil, at: Int? = nil) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        let insertAt = Swift.max(0, Swift.min(spec.categories.count, at ?? spec.categories.count))
        let name = label ?? "\(spec.categories.count + 1)"
        commit(
            "Add category \"\(name)\"",
            edited { d in
                d.categories.insert(name, at: insertAt)
                for i in d.series.indices {
                    d.series[i].insertCategoryPoint(at: insertAt)
                }
            },
            select: .some(.category(index: insertAt))
        )
        return .success(index: insertAt)
    }

    @discardableResult
    public func removeCategory(_ index: Int) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        guard index >= 0 && index < spec.categories.count else { return badIndex(index) }
        commit(
            "Delete category \"\(spec.categories[index])\"",
            edited { d in
                let label = d.categories.remove(at: index)
                for i in d.series.indices {
                    d.series[i].removeCategoryPoint(at: index)
                }
                if !d.categories.contains(label) {
                    d.highlight.removeAll { $0 == label }
                }
            }
        )
        return .success()
    }

    @discardableResult
    public func renameCategory(_ index: Int, _ label: String) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        guard index >= 0 && index < spec.categories.count else { return badIndex(index) }
        if spec.categories[index] == label { return .success() }
        commit(
            "Rename category",
            edited { d in
                let before = d.categories[index]
                d.categories[index] = label
                if d.highlight.contains(before) && !d.categories.contains(before) {
                    d.highlight = d.highlight.map { $0 == before ? label : $0 }
                }
            }
        )
        return .success()
    }

    @discardableResult
    public func moveCategory(_ from: Int, to: Int) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        guard from >= 0 && from < spec.categories.count else { return badIndex(from) }
        let target = Swift.max(0, Swift.min(spec.categories.count - 1, to))
        if target == from { return .success() }
        commit(
            "Reorder categories",
            edited { d in
                let cat = d.categories.remove(at: from)
                d.categories.insert(cat, at: target)
                for i in d.series.indices {
                    d.series[i].moveCategoryPoint(from: from, to: target)
                }
            }
        )
        return .success()
    }

    @discardableResult
    public func pasteCells(_ row: Int, _ column: Int, _ text: String) -> ChartActionResult {
        let parsed = text.contains("\t") ? parseTsv(text) : parseCsv(text)
        return pasteCells(row, column, parsed.map { $0.map(JSONValue.string) })
    }

    @discardableResult
    public func pasteCells(_ row: Int, _ column: Int, _ rows: [[JSONValue]]) -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        if rows.isEmpty { return .success() }
        var cellIssues: [ChartIssue] = []
        let next = edited { d in
            let width = rows.map { $0.count }.max() ?? 0
            let lastSeries = column + width - 1
            while d.series.count <= lastSeries {
                let id = uniqueChartSeriesId(d.series)
                d.series.append(ChartSeries(
                    id: id,
                    name: "Series \(d.series.count + 1)",
                    values: d.categories.map { _ in nil }
                ))
            }
            let lastRow = row + rows.count - 1
            while d.categories.count <= lastRow {
                d.categories.append("\(d.categories.count + 1)")
                for i in d.series.indices {
                    d.series[i].values.append(nil)
                }
            }
            for (r, cellsInRow) in rows.enumerated() {
                for (c, cell) in cellsInRow.enumerated() {
                    let col = column + c
                    let index = row + r
                    if col < 0 {
                        d.categories[index] = cell == .null ? "" : jsCellString(cell).jsTrimmed
                    } else if col < d.series.count && index >= 0 && index < d.series[col].values.count {
                        if let parsed = parseChartValue(cell) {
                            d.series[col].values[index] = parsed
                        } else {
                            cellIssues.append(ChartIssue(
                                path: "\(d.series[col].id)[\(index)]",
                                message: "\"\(jsCellString(cell))\" is not a number; it was left blank."
                            ))
                            d.series[col].values[index] = nil
                        }
                    }
                }
            }
        }
        commit("Paste cells", next)
        if !cellIssues.isEmpty {
            issues = cellIssues
            notify(specChanged: false)
            return .success(issues: cellIssues)
        }
        return .success()
    }

    @discardableResult
    public func importTable(_ rows: [[JSONValue]], _ options: ChartTableOptions = ChartTableOptions()) -> ChartActionResult {
        let data = chartDataFromTable(rows, options)
        if data.categories.isEmpty || data.series.isEmpty {
            return reject("There is no data to import: expected a header row and at least one row of values.")
        }
        var byName: [String: ChartSeries] = [:]
        for s in spec.series {
            byName[s.name] = s
        }
        let series: [ChartSeries] = data.series.map { s in
            var copy = s
            if let old = byName[s.name] {
                if let c = old.color { copy.color = c }
                if let t = old.type { copy.type = t }
                copy.id = old.id
            }
            return copy
        }
        guard case .object(var merged) = spec.toJSON() else { return .failure("Internal error") }
        merged["categories"] = .array(data.categories.map(JSONValue.string))
        merged["series"] = .array(series.map { $0.toJSON() })
        merged["tree"] = .array([])
        merged["links"] = .array([])
        let normalized = normalizeChartSpec(.object(merged))
        commit("Import data", normalized.spec)
        if !data.issues.isEmpty {
            issues = data.issues
            notify(specChanged: false)
            return .success(issues: data.issues)
        }
        return .success()
    }

    @discardableResult
    public func importCsv(
        _ text: String,
        _ options: ChartTableOptions = ChartTableOptions(),
        delimiter: String? = nil
    ) -> ChartActionResult {
        let sep = delimiter ?? (text.contains("\t") ? "\t" : ",")
        let parsed = parseCsv(text, options: CsvParseOptions(delimiter: sep))
        return importTable(parsed.map { $0.map(JSONValue.string) }, options)
    }

    @discardableResult
    public func transpose() -> ChartActionResult {
        if let grouped = treeLocked() { return grouped }
        let s = spec
        if s.series.isEmpty || s.categories.isEmpty {
            return reject("There is no data to switch: the chart needs at least one series and one category.")
        }
        var used = Set<String>()
        let series: [ChartSeries] = s.categories.enumerated().map { i, name in
            var id = "series-\(i + 1)"
            var k = i + 2
            while used.contains(id) {
                id = "series-\(k)"
                k += 1
            }
            used.insert(id)
            let values: [ChartValue] = s.series.map { x in
                i < x.values.count ? x.values[i] : nil
            }
            return ChartSeries(id: id, name: name, values: values)
        }
        guard case .object(var merged) = s.toJSON() else { return .failure("Internal error") }
        merged["categories"] = .array(s.series.map { .string($0.name) })
        merged["series"] = .array(series.map { $0.toJSON() })
        let normalized = normalizeChartSpec(.object(merged))
        commit("Switch rows and columns", normalized.spec, select: .some(nil))
        return .success()
    }
}
