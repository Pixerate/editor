import Foundation
import PixerateCore

/// Deepest tree the editor keeps (a sunburst draws one ring per level).
public let MAX_CHART_TREE_DEPTH = 6
/// Most nodes a tree may have.
public let MAX_CHART_TREE_NODES = 5000

/// Checks a tree: every node has a name unique among its siblings, leaves have a value of 0 or
/// more, groups have children. Problems are reported with the node's path and the node is
/// dropped (or its value set to 0), so the rest of the tree is kept.
public func normalizeChartTree(
    _ value: JSONValue?,
    _ issues: inout [ChartIssue],
    _ path: String = "tree"
) -> [ChartTreeNode] {
    guard let value, value != .null else { return [] }
    guard case .array(let list) = value else {
        issues.append(ChartIssue(
            path: path,
            message: "\(path) must be an array of nodes such as {\"name\": \"Europe\", \"children\": [{\"name\": \"France\", \"value\": 40}]}."
        ))
        return []
    }
    var count = 0
    func read(_ list: [JSONValue], _ at: String, _ depth: Int) -> [ChartTreeNode] {
        var out: [ChartTreeNode] = []
        var names = Set<String>()
        for (i, raw) in list.enumerated() {
            let wherePath = "\(at)[\(i)]"
            guard case .object(let obj) = raw else {
                issues.append(ChartIssue(
                    path: wherePath,
                    message: "\(wherePath) must be an object with a name and a value or children."
                ))
                continue
            }
            let name: String
            switch obj["name"] {
            case .number(let n)?:
                name = JSONValue.jsNumber(n)
            case .string(let s)?:
                name = s.jsTrimmed
            default:
                name = ""
            }
            if name.isEmpty {
                issues.append(ChartIssue(
                    path: "\(wherePath).name",
                    message: "\(wherePath) needs a name."
                ))
                continue
            }
            if names.contains(name) {
                issues.append(ChartIssue(
                    path: "\(wherePath).name",
                    message: "\"\(name)\" appears twice under the same group in \(at); sibling names must be unique, so the second was left out."
                ))
                continue
            }
            count += 1
            if count > MAX_CHART_TREE_NODES {
                if count == MAX_CHART_TREE_NODES + 1 {
                    issues.append(ChartIssue(
                        path: path,
                        message: "The tree has more than \(MAX_CHART_TREE_NODES) nodes; the rest were left out."
                    ))
                }
                continue
            }
            names.insert(name)
            for k in obj.keys {
                if k != "name" && k != "value" && k != "children" && k != "color" {
                    issues.append(ChartIssue(
                        path: "\(wherePath).\(k)",
                        message: "\(wherePath) has no \"\(k)\"; a node takes name, value, children and color."
                    ))
                }
            }
            var node = ChartTreeNode(name: name)
            if case .string(let colorStr)? = obj["color"] {
                let trimmed = colorStr.jsTrimmed
                if !trimmed.isEmpty { node.color = trimmed }
            }
            if case .array(let rawChildren)? = obj["children"], !rawChildren.isEmpty {
                if depth >= MAX_CHART_TREE_DEPTH {
                    issues.append(ChartIssue(
                        path: "\(wherePath).children",
                        message: "\(wherePath) is more than \(MAX_CHART_TREE_DEPTH) levels deep; its children were left out."
                    ))
                    node.value = 0
                } else {
                    if let rawVal = obj["value"], rawVal != .null {
                        issues.append(ChartIssue(
                            path: "\(wherePath).value",
                            message: "\"\(name)\" is a group: its value is the sum of its children, so the value given was ignored."
                        ))
                    }
                    let children = read(rawChildren, "\(wherePath).children", depth + 1)
                    if !children.isEmpty {
                        node.children = children
                    } else {
                        node.value = 0
                    }
                }
            } else {
                if let rawChildren = obj["children"], rawChildren != .null {
                    if case .array = rawChildren {} else {
                        issues.append(ChartIssue(
                            path: "\(wherePath).children",
                            message: "\(wherePath).children must be an array of nodes."
                        ))
                    }
                }
                let rawVal = obj["value"]
                let parsed = parseChartValue(rawVal)
                if rawVal == nil || rawVal == .null {
                    node.value = 0
                } else if case .some(.some(let v)) = parsed, v >= 0 {
                    node.value = v
                } else {
                    issues.append(ChartIssue(
                        path: "\(wherePath).value",
                        message: "\"\(name)\" needs a value of 0 or more; got \(jsJSONStringify(rawVal))."
                    ))
                    node.value = 0
                }
            }
            out.append(node)
        }
        return out
    }
    return read(list, path, 1)
}

/// The value of a node: its own, or the sum of its leaves.
public func chartTreeTotal(_ node: ChartTreeNode) -> Double {
    if let children = node.children {
        return children.reduce(0.0) { $0 + chartTreeTotal($1) }
    }
    return node.value ?? 0
}

/// Levels in the tree (1 for a flat list of leaves, 0 for none).
public func chartTreeDepth(_ tree: [ChartTreeNode]) -> Int {
    tree.reduce(0) { d, n in
        Swift.max(d, 1 + (n.children.map(chartTreeDepth) ?? 0))
    }
}

/// The node at a path of names from the top, or nil.
public func findChartTreeNode(_ tree: [ChartTreeNode], _ path: [String]) -> ChartTreeNode? {
    var list: [ChartTreeNode]? = tree
    var node: ChartTreeNode?
    for name in path {
        node = list?.first(where: { $0.name == name })
        guard let found = node else { return nil }
        list = found.children
    }
    return node
}

public struct ChartTreeRow: Sendable, Equatable {
    public var path: [String]
    public var value: Double

    public init(path: [String], value: Double) {
        self.path = path
        self.value = value
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("path", .array(path.map(JSONValue.string))),
            ("value", .number(value))
        ]))
    }
}

/// Every leaf of the tree as a row, in order (the tree as a table: group, …, name, value).
public func chartTreeToRows(_ tree: [ChartTreeNode]) -> [ChartTreeRow] {
    var out: [ChartTreeRow] = []
    func walk(_ list: [ChartTreeNode], _ prefix: [String]) {
        for n in list {
            if let children = n.children {
                walk(children, prefix + [n.name])
            } else {
                out.append(ChartTreeRow(path: prefix + [n.name], value: n.value ?? 0))
            }
        }
    }
    walk(tree, [])
    return out
}

/// Builds a tree from rows of names and a value: rows that share leading names share those
/// groups, in the order they first appear. Empty names end a path. A name that is both a leaf
/// and a group, or a repeated path, is reported; the first wins.
public func chartTreeFromRows(
    _ rows: [(path: [JSONValue], value: JSONValue?)],
    _ issues: inout [ChartIssue]
) -> [ChartTreeNode] {
    var tree: [ChartTreeNode] = []
    for (r, row) in rows.enumerated() {
        var path: [String] = []
        for cell in row.path {
            let name = cell == .null ? "" : jsCellString(cell).jsTrimmed
            if name.isEmpty { break }
            path.append(name)
        }
        if path.isEmpty { continue }
        if path.count > MAX_CHART_TREE_DEPTH {
            issues.append(ChartIssue(
                path: "rows[\(r)]",
                message: "Row \(r + 1) is \(path.count) levels deep; the tree keeps at most \(MAX_CHART_TREE_DEPTH), so the row was left out."
            ))
            continue
        }
        let parsed = parseChartValue(row.value)
        let isValidNonNeg: Bool
        if case .some(.some(let pv)) = parsed, pv >= 0 {
            isValidNonNeg = true
        } else {
            isValidNonNeg = false
        }
        if let rv = row.value, rv != .null && !jsCellString(rv).jsTrimmed.isEmpty && !isValidNonNeg {
            issues.append(ChartIssue(
                path: "rows[\(r)]",
                message: "Row \(r + 1) (\(path.joined(separator: " / "))) needs a value of 0 or more; got \(jsJSONStringify(row.value)). It was counted as 0."
            ))
        }
        let value: Double
        if case .some(.some(let pv)) = parsed, pv >= 0 {
            value = pv
        } else {
            value = 0
        }
        func insertInto(_ list: inout [ChartTreeNode], _ k: Int) {
            let last = k == path.count - 1
            if let idx = list.firstIndex(where: { $0.name == path[k] }) {
                if last {
                    let reason = list[idx].children != nil ? "names a group that already has items" : "repeats an earlier row"
                    issues.append(ChartIssue(
                        path: "rows[\(r)]",
                        message: "Row \(r + 1) (\(path.joined(separator: " / "))) \(reason); it was left out."
                    ))
                    return
                } else if list[idx].children == nil {
                    let prefix = path[0...k].joined(separator: " / ")
                    issues.append(ChartIssue(
                        path: "rows[\(r)]",
                        message: "Row \(r + 1) puts items under \"\(prefix)\", which an earlier row made an item with its own value; it was left out."
                    ))
                    return
                }
                var children = list[idx].children!
                insertInto(&children, k + 1)
                list[idx].children = children
            } else {
                if last {
                    list.append(ChartTreeNode(name: path[k], value: value))
                    return
                } else {
                    var children: [ChartTreeNode] = []
                    insertInto(&children, k + 1)
                    list.append(ChartTreeNode(name: path[k], children: children))
                }
            }
        }
        insertInto(&tree, 0)
    }
    return tree
}

/// Reads a table as a tree: every column but the last holds names (group, subgroup, …, item),
/// the last holds the value. Blank names repeat the name above (as spreadsheets lay out groups).
/// With `header` (default `auto`: when the first row's last cell is not a number) the first row
/// is skipped.
public func chartTreeFromTable(
    _ rows: [[JSONValue]],
    header: ChartHeaderOption = .auto,
    _ issues: inout [ChartIssue]
) -> [ChartTreeNode] {
    let grid = rows.filter { r in
        r.contains { c in c != .null && !jsCellString(c).jsTrimmed.isEmpty }
    }
    if grid.isEmpty { return [] }
    let width = grid.map { $0.count }.max() ?? 0
    if width < 2 {
        issues.append(ChartIssue(
            path: "rows",
            message: "A tree table needs at least two columns: names, then values."
        ))
        return []
    }
    let skip: Bool
    switch header {
    case .bool(let b):
        skip = b
    case .auto:
        let lastCell: JSONValue? = grid[0].count > width - 1 ? grid[0][width - 1] : nil
        if case .some(.some(_)) = parseChartValue(lastCell) {
            skip = false
        } else {
            skip = true
        }
    }
    let body = skip ? Array(grid.dropFirst()) : grid
    var above: [String] = []
    let treeRows: [(path: [JSONValue], value: JSONValue?)] = body.map { r in
        let cells: [String] = (0..<(width - 1)).map { k in
            guard k < r.count, r[k] != .null else { return "" }
            return jsCellString(r[k]).jsTrimmed
        }
        let valCell: JSONValue? = width - 1 < r.count ? r[width - 1] : nil
        guard let first = cells.firstIndex(where: { !$0.isEmpty }) else {
            return (path: [], value: valCell)
        }
        var own: [String] = []
        for c in cells[first...] {
            if c.isEmpty { break }
            own.append(c)
        }
        let prefix = Array(above.prefix(first))
        let path = prefix + own
        above = path
        return (path: path.map(JSONValue.string), value: valCell)
    }
    return chartTreeFromRows(treeRows, &issues)
}

/// A flat tree (one leaf per category) from labels and values, for starting to group a table.
public func chartTreeFromSeries(_ categories: [String], _ values: [Double?]) -> [ChartTreeNode] {
    var seen = Set<String>()
    var out: [ChartTreeNode] = []
    for (i, c) in categories.enumerated() {
        let trimmed = c.jsTrimmed
        let name = trimmed.isEmpty ? "\(i + 1)" : trimmed
        if seen.contains(name) { continue }
        seen.insert(name)
        let v = i < values.count ? values[i] : nil
        let val = (v != nil && v!.isFinite && v! > 0) ? v! : 0
        out.append(ChartTreeNode(name: name, value: val))
    }
    return out
}

/// A deep copy.
public func cloneChartTree(_ tree: [ChartTreeNode]) -> [ChartTreeNode] {
    tree.map { n in
        ChartTreeNode(
            name: n.name,
            value: n.value,
            children: n.children.map(cloneChartTree),
            color: n.color
        )
    }
}

/// Column headings for a tree table `depth` levels deep: Group, Level 2, …, Item.
public func chartTreeColumnLabels(_ depth: Int) -> [String] {
    if depth <= 1 { return ["Item"] }
    return (0..<depth).map { k in
        k == 0 ? "Group" : k == depth - 1 ? "Item" : "Level \(k + 1)"
    }
}

/// Rows with the name at `level` of row `row` set (shorter paths are padded with blanks; a blank name ends the path there).
public func setChartTreeRowName(
    _ rows: [ChartTreeRow],
    _ row: Int,
    _ level: Int,
    _ name: String
) -> [(path: [String], value: JSONValue)] {
    rows.enumerated().map { i, r in
        if i != row { return (path: r.path, value: .number(r.value)) }
        var path = r.path
        while path.count <= level { path.append("") }
        path[level] = name.jsTrimmed
        return (path: path, value: .number(r.value))
    }
}

/// Rows with row `row`'s value set (text is parsed by `setTreeRows`).
public func setChartTreeRowValue(
    _ rows: [ChartTreeRow],
    _ row: Int,
    _ value: JSONValue
) -> [(path: [String], value: JSONValue)] {
    rows.enumerated().map { i, r in
        (path: r.path, value: i == row ? value : .number(r.value))
    }
}

/// Rows with a new item after the last row, in the same group, named "Item n" (unique there), value 0.
public func addChartTreeRow(_ rows: [ChartTreeRow]) -> [ChartTreeRow] {
    let parent: [String] = rows.last.map { Array($0.path.dropLast()) } ?? []
    let taken = Set(
        rows.filter { r in
            r.path.count == parent.count + 1 && parent.enumerated().allSatisfy { k, p in r.path[k] == p }
        }.map { $0.path[parent.count] }
    )
    var n = rows.count + 1
    while taken.contains("Item \(n)") { n += 1 }
    return rows + [ChartTreeRow(path: parent + ["Item \(n)"], value: 0)]
}

/// Rows without row `row`.
public func removeChartTreeRow(_ rows: [ChartTreeRow], _ row: Int) -> [ChartTreeRow] {
    rows.enumerated().filter { i, _ in i != row }.map { _, r in r }
}
