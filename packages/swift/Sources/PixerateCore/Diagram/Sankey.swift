import Foundation

public struct SankeyLink: Sendable, Equatable {
    public var source: String
    public var target: String
    public var value: Double

    public init(source: String, target: String, value: Double) {
        self.source = source
        self.target = target
        self.value = value
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("source", .string(source)),
            ("target", .string(target)),
            ("value", .number(value)),
        ]))
    }
}

public struct SankeyData: Sendable, Equatable {
    /// Node names in order of first appearance (a link's source, then its target).
    public var nodes: [String]
    public var links: [SankeyLink]

    public init(nodes: [String], links: [SankeyLink]) {
        self.nodes = nodes
        self.links = links
    }

    public func toJSON() -> JSONValue {
        return .object(JSONObject([
            ("nodes", .array(nodes.map(JSONValue.string))),
            ("links", .array(links.map { $0.toJSON() })),
        ]))
    }
}

/// What went wrong reading a diagram, with its 1-based line in the source.
public struct DiagramDataError: Error, LocalizedError, Sendable, Equatable {
    public var error: String
    public var line: Int?

    public init(error: String, line: Int? = nil) {
        self.error = error
        self.line = line
    }

    public var errorDescription: String? { error }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["error"] = .string(error)
        if let line { obj["line"] = .number(Double(line)) }
        return .object(obj)
    }
}

public enum SankeyParse: Sendable, Equatable {
    case data(SankeyData)
    case error(DiagramDataError)

    public func toJSON() -> JSONValue {
        switch self {
        case .data(let d):
            return .object(JSONObject([("data", d.toJSON())]))
        case .error(let err):
            return err.toJSON()
        }
    }
}

internal struct DiagramSplitSource {
    var header: String
    var headerIndex: Int
    var bodyLines: [String]
}

private let frontmatterFenceRegex = try! NSRegularExpression(pattern: "^---\\s*$")
private let directiveLineRegex = try! NSRegularExpression(pattern: "^\\s*%%\\{.*\\}%%\\s*$")
private let sankeyHeaderRegex = try! NSRegularExpression(pattern: "^\\s*sankey(?:-beta)?\\b", options: [.caseInsensitive])
private let commentPrefixRegex = try! NSRegularExpression(pattern: "^\\s*%%")
internal func matchesRegex(_ regex: NSRegularExpression, _ text: String) -> Bool {
    let ns = text as NSString
    return regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) != nil
}

internal func jsParseFloatFinite(_ raw: String) -> Double? {
    let v = raw.jsParseFloat
    guard v.isFinite else { return nil }
    return v == 0 ? 0 : v
}

internal func splitDiagramSource(_ source: String) -> DiagramSplitSource {
    let normalized = source.replacingOccurrences(of: "\r\n", with: "\n")
    let rawLines = normalized.components(separatedBy: "\n")

    var end = rawLines.count
    while end > 0 && rawLines[end - 1].jsTrimmed.isEmpty {
        end -= 1
    }
    let lines = Array(rawLines[0..<end])

    var i = 0
    if !lines.isEmpty && matchesRegex(frontmatterFenceRegex, lines[0]) {
        i = 1
        while i < lines.count && !matchesRegex(frontmatterFenceRegex, lines[i]) {
            i += 1
        }
        if i < lines.count {
            i += 1
        }
    }

    while i < lines.count {
        let line = lines[i]
        let t = line.jsTrimmed
        let isComment = t.hasPrefix("%%") && !t.hasPrefix("%%{")
        let isDirective = matchesRegex(directiveLineRegex, line)
        if t.isEmpty || isDirective || isComment {
            i += 1
            continue
        }
        break
    }

    let headerIndex = i
    let header = i < lines.count ? lines[i] : ""
    let bodyLines = (i + 1 < lines.count) ? Array(lines[(i + 1)...]) : []
    return DiagramSplitSource(header: header, headerIndex: headerIndex, bodyLines: bodyLines)
}

/// Reads a sankey diagram's links. `source` is the whole Mermaid text (with
/// frontmatter and header).
public func parseSankey(_ source: String) -> SankeyParse {
    let split = splitDiagramSource(source)
    if !matchesRegex(sankeyHeaderRegex, split.header) {
        return .error(DiagramDataError(error: "Not a sankey diagram: the first line should be `sankey-beta`."))
    }
    let firstLine = split.headerIndex + 2
    var kept: [(text: String, line: Int)] = []
    for (i, text) in split.bodyLines.enumerated() {
        if matchesRegex(commentPrefixRegex, text) { continue }
        kept.append((text: text.jsTrimmed, line: firstLine + i))
    }

    switch readCsvRecords(kept) {
    case .failure(let err):
        return .error(err)
    case .success(let records):
        var nodes: [String] = []
        var seen = Set<String>()
        func add(_ name: String) {
            if !seen.contains(name) {
                seen.insert(name)
                nodes.append(name)
            }
        }
        var links: [SankeyLink] = []
        for record in records {
            if record.fields.count != 3 {
                return .error(DiagramDataError(
                    error: "Expected three fields (source,target,value), found \(record.fields.count).",
                    line: record.line
                ))
            }
            let src = record.fields[0]
            let dst = record.fields[1]
            let raw = record.fields[2]
            guard let value = jsParseFloatFinite(raw) else {
                return .error(DiagramDataError(error: "\"\(raw)\" is not a number.", line: record.line))
            }
            add(src)
            add(dst)
            links.append(SankeyLink(source: src, target: dst, value: value))
        }
        if links.isEmpty {
            return .error(DiagramDataError(error: "No links: add lines like `A,B,10`."))
        }
        return .data(SankeyData(nodes: nodes, links: links))
    }
}

private struct CsvRecord {
    var fields: [String]
    var line: Int
}

private func readCsvRecords(_ lines: [(text: String, line: Int)]) -> Result<[CsvRecord], DiagramDataError> {
    var records: [CsvRecord] = []
    var i = 0
    while i < lines.count {
        let start = lines[i]
        if start.text.isEmpty {
            i += 1
            continue
        }
        var fields: [String] = []
        var chars = Array(start.text)
        var pos = 0
        var field = ""
        var quoted = false
        while true {
            if quoted {
                var close = -1
                var scan = pos
                while scan < chars.count {
                    if chars[scan] == "\"" {
                        close = scan
                        break
                    }
                    scan += 1
                }
                if close < 0 {
                    if pos < chars.count {
                        field += String(chars[pos...])
                    }
                    i += 1
                    if i >= lines.count {
                        return .failure(DiagramDataError(error: "A quoted field is never closed.", line: start.line))
                    }
                    field += "\n"
                    chars = Array(lines[i].text)
                    pos = 0
                    continue
                }
                if pos < close {
                    field += String(chars[pos..<close])
                }
                if close + 1 < chars.count && chars[close + 1] == "\"" {
                    field.append("\"")
                    pos = close + 2
                    continue
                }
                quoted = false
                pos = close + 1
                while pos < chars.count && (chars[pos] == " " || chars[pos] == "\t") {
                    pos += 1
                }
                if pos < chars.count && chars[pos] != "," {
                    return .failure(DiagramDataError(error: "Unexpected text after a quoted field.", line: lines[i].line))
                }
                continue
            }
            if pos >= chars.count {
                fields.append(field.jsTrimmed)
                break
            }
            let ch = chars[pos]
            if ch == "," {
                fields.append(field.jsTrimmed)
                field = ""
                pos += 1
            } else if ch == "\"" && field.jsTrimmed.isEmpty {
                quoted = true
                field = ""
                pos += 1
            } else if ch == "\"" {
                return .failure(DiagramDataError(error: "A quote inside an unquoted field.", line: lines[i].line))
            } else {
                field.append(ch)
                pos += 1
            }
        }
        records.append(CsvRecord(fields: fields, line: start.line))
        i += 1
    }
    return .success(records)
}
