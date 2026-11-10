import Foundation
import PixerateCore

/// Most flows a chart may have.
public let MAX_CHART_LINKS = 2000

private func nameOf(_ value: JSONValue?) -> String {
    guard let value else { return "" }
    switch value {
    case .number(let n):
        return JSONValue.jsNumber(n)
    case .string(let s):
        return s.jsTrimmed
    default:
        return ""
    }
}

/// Checks flows: each has a source and a target (different names) and a value above 0, a pair
/// appears once, and flows only go forwards (a flow that would close a loop is dropped, since a
/// Sankey diagram cannot draw one). Problems are reported with the flow's index.
public func normalizeChartLinks(
    _ value: JSONValue?,
    _ issues: inout [ChartIssue],
    _ path: String = "links"
) -> [ChartLink] {
    guard let value, value != .null else { return [] }
    guard case .array(let arr) = value else {
        issues.append(ChartIssue(
            path: path,
            message: "\(path) must be an array of flows such as {\"source\": \"Website\", \"target\": \"Signup\", \"value\": 120}."
        ))
        return []
    }
    var out: [ChartLink] = []
    var seen = Set<String>()
    var next: [String: [String]] = [:]
    func reaches(_ to: String, _ from: String) -> Bool {
        var stack = [to]
        var visited = Set<String>()
        while let n = stack.popLast() {
            if n == from { return true }
            if visited.contains(n) { continue }
            visited.insert(n)
            for m in next[n] ?? [] {
                stack.append(m)
            }
        }
        return false
    }
    for (i, raw) in arr.enumerated() {
        let wherePath = "\(path)[\(i)]"
        if out.count >= MAX_CHART_LINKS {
            if out.count == MAX_CHART_LINKS && i == MAX_CHART_LINKS {
                issues.append(ChartIssue(
                    path: path,
                    message: "There are more than \(MAX_CHART_LINKS) flows; the rest were left out."
                ))
            }
            continue
        }
        guard case .object(let obj) = raw else {
            issues.append(ChartIssue(
                path: wherePath,
                message: "\(wherePath) must be an object with source, target and value."
            ))
            continue
        }
        for k in obj.keys {
            if k != "source" && k != "target" && k != "value" && k != "color" {
                issues.append(ChartIssue(
                    path: "\(wherePath).\(k)",
                    message: "\(wherePath) has no \"\(k)\"; a flow takes source, target, value and color."
                ))
            }
        }
        let source = nameOf(obj["source"])
        let target = nameOf(obj["target"])
        if source.isEmpty || target.isEmpty {
            issues.append(ChartIssue(
                path: wherePath,
                message: "\(wherePath) needs a source and a target (node names)."
            ))
            continue
        }
        if source == target {
            issues.append(ChartIssue(
                path: wherePath,
                message: "\(wherePath) goes from \"\(source)\" to itself; a flow must join two different nodes."
            ))
            continue
        }
        let parsed = parseChartValue(obj["value"])
        guard case .some(.some(let v)) = parsed, v > 0 else {
            let gotStr = jsJSONStringify(obj["value"])
            issues.append(ChartIssue(
                path: "\(wherePath).value",
                message: "The flow from \"\(source)\" to \"\(target)\" needs a value above 0; got \(gotStr)."
            ))
            continue
        }
        let key = "\(source)\u{0000}\(target)"
        if seen.contains(key) {
            issues.append(ChartIssue(
                path: wherePath,
                message: "The flow from \"\(source)\" to \"\(target)\" appears twice; add the values into one flow. The second was left out."
            ))
            continue
        }
        if reaches(target, source) {
            issues.append(ChartIssue(
                path: wherePath,
                message: "The flow from \"\(source)\" to \"\(target)\" would close a loop (\(target) already leads back to \(source)); flows must only go forwards, so it was left out."
            ))
            continue
        }
        seen.insert(key)
        var targets = next[source] ?? []
        if !targets.contains(target) {
            targets.append(target)
            next[source] = targets
        }
        var link = ChartLink(source: source, target: target, value: v)
        if case .string(let colorStr)? = obj["color"] {
            let trimmed = colorStr.jsTrimmed
            if !trimmed.isEmpty { link.color = trimmed }
        }
        out.append(link)
    }
    return out
}

/// The nodes of a set of flows, in `order` first (names no flow uses are reported and dropped),
/// then any others as the flows first name them.
public func chartSankeyNodes(
    _ links: [ChartLink],
    _ order: [String] = [],
    _ issues: inout [ChartIssue]
) -> [String] {
    var used = Set<String>()
    var named: [String] = []
    for l in links {
        for n in [l.source, l.target] {
            if !used.contains(n) {
                used.insert(n)
                named.append(n)
            }
        }
    }
    var out: [String] = []
    for n in order {
        if !used.contains(n) {
            if !links.isEmpty {
                issues.append(ChartIssue(
                    path: "sankeyNodes",
                    message: "sankeyNodes names \"\(n)\", which no flow uses; it was left out."
                ))
            }
            continue
        }
        if !out.contains(n) { out.append(n) }
    }
    for n in named {
        if !out.contains(n) { out.append(n) }
    }
    return out
}

/// How much flows through each node: the larger of what comes in and what goes out.
public func chartSankeyNodeValues(_ links: [ChartLink], _ nodes: [String]) -> [Double] {
    var inflow: [String: Double] = [:]
    var outflow: [String: Double] = [:]
    for l in links {
        outflow[l.source, default: 0] += l.value
        inflow[l.target, default: 0] += l.value
    }
    return nodes.map { n in Swift.max(inflow[n] ?? 0, outflow[n] ?? 0) }
}

public enum ChartHeaderOption: Sendable, Equatable {
    case auto
    case bool(Bool)
}

/// Reads flows from a table of source, target and value columns. With `header` (default
/// `auto`: when the first row's third cell is not a number) the first row is skipped.
public func chartLinksFromTable(
    _ rows: [[JSONValue]],
    header: ChartHeaderOption = .auto
) -> [JSONValue] {
    let grid = rows.filter { r in
        r.contains { c in c != .null && !jsCellString(c).jsTrimmed.isEmpty }
    }
    if grid.isEmpty { return [] }
    let skip: Bool
    switch header {
    case .bool(let b):
        skip = b
    case .auto:
        let cell2: JSONValue? = grid[0].count > 2 ? grid[0][2] : nil
        if case .some(.some(_)) = parseChartValue(cell2) {
            skip = false
        } else {
            skip = true
        }
    }
    let body = skip ? Array(grid.dropFirst()) : grid
    return body.map { r in
        var obj = JSONObject()
        obj["source"] = r.count > 0 ? r[0] : .null
        obj["target"] = r.count > 1 ? r[1] : .null
        obj["value"] = r.count > 2 ? r[2] : .null
        return .object(obj)
    }
}

public enum ChartLinkField: String, Sendable, Equatable {
    case source
    case target
    case value
}

/// Flows with one field of flow `index` set to `text` (for the data grids; `setLinks` checks the result).
public func setChartLinkField(
    _ links: [ChartLink],
    _ index: Int,
    _ field: ChartLinkField,
    _ text: String
) -> [JSONValue] {
    links.enumerated().map { i, l in
        guard case .object(var obj) = l.toJSON() else { return l.toJSON() }
        if i == index {
            obj[field.rawValue] = .string(field == .value ? text : text.jsTrimmed)
        }
        return .object(obj)
    }
}

/// Flows with a new one at the end: from the last flow's target (or "Start") to a new node
/// named "Step n", carrying the last flow's value (or 1).
public func addChartLink(_ links: [ChartLink]) -> [ChartLink] {
    let last = links.last
    let names = Set(links.flatMap { [$0.source, $0.target] })
    var n = names.count + 1
    while names.contains("Step \(n)") { n += 1 }
    return links + [ChartLink(source: last?.target ?? "Start", target: "Step \(n)", value: last?.value ?? 1)]
}
