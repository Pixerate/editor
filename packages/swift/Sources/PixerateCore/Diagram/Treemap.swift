import Foundation

public struct TreemapItem: Sendable, Equatable {
    public var name: String
    /// Leaves only.
    public var value: Double?
    /// Sections only (possibly empty).
    public var children: [TreemapItem]?
    /// The `:::class` the item names, if any.
    public var className: String?

    public init(
        name: String,
        value: Double? = nil,
        children: [TreemapItem]? = nil,
        className: String? = nil
    ) {
        self.name = name
        self.value = value
        self.children = children
        self.className = className
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["name"] = .string(name)
        if let value { obj["value"] = .number(value) }
        if let children { obj["children"] = .array(children.map { $0.toJSON() }) }
        if let className { obj["className"] = .string(className) }
        return .object(obj)
    }
}

public struct TreemapData: Sendable, Equatable {
    /// `title` line in the body.
    public var title: String?
    public var accTitle: String?
    public var accDescr: String?
    /// Top-level items; Mermaid allows several.
    public var items: [TreemapItem]

    public init(
        title: String? = nil,
        accTitle: String? = nil,
        accDescr: String? = nil,
        items: [TreemapItem] = []
    ) {
        self.title = title
        self.accTitle = accTitle
        self.accDescr = accDescr
        self.items = items
    }

    public func toJSON() -> JSONValue {
        var obj = JSONObject()
        obj["items"] = .array(items.map { $0.toJSON() })
        if let title { obj["title"] = .string(title) }
        if let accTitle { obj["accTitle"] = .string(accTitle) }
        if let accDescr { obj["accDescr"] = .string(accDescr) }
        return .object(obj)
    }
}

public enum TreemapParse: Sendable, Equatable {
    case data(TreemapData)
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

private let treemapHeaderRegex = try! NSRegularExpression(pattern: "^\\s*treemap(?:-beta)?\\b", options: [.caseInsensitive])
private let accBlockRegex = try! NSRegularExpression(pattern: "^accDescr\\s*\\{(.*)$")
private let accSingleRegex = try! NSRegularExpression(pattern: "^(accTitle|accDescr)\\s*:(.*)$")
private let titleLineRegex = try! NSRegularExpression(pattern: "^title(?:[ \\t]+(.*))?$")
private let classDefRegex = try! NSRegularExpression(pattern: "^classDef\\s")
private let sectionRegex = try! NSRegularExpression(pattern: "^(?:\"([^\"]*)\"|'([^']*)')(?:\\s*::: *([A-Za-z_][A-Za-z0-9_]*))?$")
private let leafRegex = try! NSRegularExpression(pattern: "^(?:\"([^\"]*)\"|'([^']*)')\\s*[:,]\\s*([0-9_.,]+)(?:\\s*:\\:\\:\\s*([A-Za-z_][A-Za-z0-9_]*))?$")
private let sectionStrictRegex = try! NSRegularExpression(pattern: "^(?:\"([^\"]*)\"|'([^']*)')(?:\\s*:\\:\\:\\s*([A-Za-z_][A-Za-z0-9_]*))?$")

private final class TreemapItemBuilder {
    var name: String
    var value: Double?
    var isSection: Bool
    var children: [TreemapItemBuilder]
    var className: String?

    init(name: String, value: Double? = nil, isSection: Bool = false, className: String? = nil) {
        self.name = name
        self.value = value
        self.isSection = isSection
        self.children = []
        self.className = className
    }

    func build() -> TreemapItem {
        return TreemapItem(
            name: name,
            value: value,
            children: isSection ? children.map { $0.build() } : nil,
            className: className
        )
    }
}

/// Reads a treemap's items. `source` is the whole Mermaid text (with
/// frontmatter and header).
public func parseTreemap(_ source: String) -> TreemapParse {
    let split = splitDiagramSource(source)
    if !matchesRegex(treemapHeaderRegex, split.header) {
        return .error(DiagramDataError(error: "Not a treemap: the first line should be `treemap-beta`."))
    }
    var titleVal: String?
    var accTitleVal: String?
    var accDescrVal: String?
    var rootItems: [TreemapItemBuilder] = []
    var stack: [(item: TreemapItemBuilder, indent: Int)] = []
    let firstLine = split.headerIndex + 2
    let lines = split.bodyLines

    var i = 0
    while i < lines.count {
        let raw = lines[i]
        let line = firstLine + i
        var indent = 0
        for ch in raw {
            if ch == " " || ch == "\t" {
                indent += 1
            } else {
                break
            }
        }
        let text = stripTreemapComment(raw).jsTrimmed
        if text.isEmpty {
            i += 1
            continue
        }
        let nsText = text as NSString
        let fullRange = NSRange(location: 0, length: nsText.length)

        if let accBlock = accBlockRegex.firstMatch(in: text, range: fullRange) {
            var body = nsText.substring(with: accBlock.range(at: 1))
            while !body.contains("}") && i + 1 < lines.count {
                i += 1
                body += "\n\(lines[i])"
            }
            guard let closeIdx = body.firstIndex(of: "}") else {
                return .error(DiagramDataError(error: "`accDescr {` is never closed.", line: line))
            }
            accDescrVal = String(body[..<closeIdx]).jsTrimmed
            i += 1
            continue
        }

        if let acc = accSingleRegex.firstMatch(in: text, range: fullRange) {
            let key = nsText.substring(with: acc.range(at: 1))
            let val = nsText.substring(with: acc.range(at: 2)).jsTrimmed
            if key == "accTitle" {
                accTitleVal = val
            } else {
                accDescrVal = val
            }
            i += 1
            continue
        }

        if let titleMatch = titleLineRegex.firstMatch(in: text, range: fullRange) {
            let r = titleMatch.range(at: 1)
            let rawTitle = (r.location != NSNotFound ? nsText.substring(with: r) : "").jsTrimmed
            titleVal = rawTitle.isEmpty ? nil : rawTitle
            i += 1
            continue
        }

        if matchesRegex(classDefRegex, text) {
            i += 1
            continue
        }

        let itemBuilder: TreemapItemBuilder
        if let leaf = leafRegex.firstMatch(in: text, range: fullRange) {
            let r1 = leaf.range(at: 1)
            let r2 = leaf.range(at: 2)
            let name = r1.location != NSNotFound ? nsText.substring(with: r1) : nsText.substring(with: r2)
            let rawNum = nsText.substring(with: leaf.range(at: 3))
            let cleanedNum = rawNum.replacingOccurrences(of: ",", with: "")
            guard let value = jsParseFloatFinite(cleanedNum) else {
                return .error(DiagramDataError(error: "\"\(rawNum)\" is not a number.", line: line))
            }
            let r4 = leaf.range(at: 4)
            let cls = r4.location != NSNotFound ? nsText.substring(with: r4) : nil
            itemBuilder = TreemapItemBuilder(name: name, value: value, isSection: false, className: cls)
        } else if let section = sectionStrictRegex.firstMatch(in: text, range: fullRange) {
            let r1 = section.range(at: 1)
            let r2 = section.range(at: 2)
            let name = r1.location != NSNotFound ? nsText.substring(with: r1) : nsText.substring(with: r2)
            let r3 = section.range(at: 3)
            let cls = r3.location != NSNotFound ? nsText.substring(with: r3) : nil
            itemBuilder = TreemapItemBuilder(name: name, value: nil, isSection: true, className: cls)
        } else {
            let startsWithQuote = text.hasPrefix("\"") || text.hasPrefix("'")
            let msg = startsWithQuote
                ? "Expected `\"Name\"` for a section or `\"Name\": value` for a leaf."
                : "Names must be in quotes, e.g. `\"Sales\": 120`."
            return .error(DiagramDataError(error: msg, line: line))
        }

        while let last = stack.last, last.indent >= indent {
            stack.removeLast()
        }
        if let parent = stack.last?.item {
            parent.children.append(itemBuilder)
        } else {
            rootItems.append(itemBuilder)
        }
        if itemBuilder.isSection {
            stack.append((item: itemBuilder, indent: indent))
        }
        i += 1
    }

    if rootItems.isEmpty {
        return .error(DiagramDataError(error: "No items: add lines like `\"Sales\": 120`."))
    }
    return .data(TreemapData(
        title: titleVal,
        accTitle: accTitleVal,
        accDescr: accDescrVal,
        items: rootItems.map { $0.build() }
    ))
}

/// Drops a `%%` comment, unless it sits inside a quoted name.
private func stripTreemapComment(_ line: String) -> String {
    // `line[i]` is a UTF-16 code unit: a quote followed by a combining mark still opens a name.
    let units = Array(line.utf16)
    var quote: UInt16? = nil
    var i = 0
    while i < units.count {
        let ch = units[i]
        if let q = quote {
            if ch == q { quote = nil }
        } else if ch == 0x22 || ch == 0x27 {
            quote = ch
        } else if ch == 0x25 && i + 1 < units.count && units[i + 1] == 0x25 {
            return String(decoding: units[0..<i], as: UTF16.self)
        }
        i += 1
    }
    return line
}

/// A treemap item's value: a leaf's own, or the sum of a section's leaves.
public func treemapValue(_ item: TreemapItem) -> Double {
    if let children = item.children {
        return children.reduce(0.0) { $0 + treemapValue($1) }
    }
    return item.value ?? 0
}
