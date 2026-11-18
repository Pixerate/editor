// Agent tools for a Markdown text (#609), with the names, input schemas and results of the web
// rich-text tools (`createRichTextToolProvider` and `createDocumentFormatTools` in
// packages/core/src/agent), so a model sees one set of tools in Swash and on the web:
// `get_text`, `find_text`, `insert_text`, `replace_text`, `replace_range`, `replace_selection`,
// `set_selection`, `format_text` and `set_block_type`. Positions are UTF-16 offsets into the
// Markdown source (on the web they are ProseMirror positions); `find_text` and
// `get_text {blocks: true}` return them.

import Foundation
import PixerateCore
import PixerateMarkdown

public struct MarkdownToolProviderOptions {
    /// Provider id (unique per registry). Default `markdown`.
    public var id: String
    /// Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `""` for bare names.
    public var namespace: String?

    public init(id: String = "markdown", namespace: String? = nil) {
        self.id = id
        self.namespace = namespace
    }
}

private let readOnlyAnnotations = ToolAnnotations(readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false)
private func writeAnnotations(_ title: String, destructive: Bool, idempotent: Bool) -> ToolAnnotations {
    ToolAnnotations(title: title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false)
}

private let findSchemaProperties: [(String, JSONValue)] = [
    ("matchCase", ["type": "boolean", "description": "Case-sensitive match (default false)."]),
    ("wholeWord", ["type": "boolean", "description": "Match whole words only (default false)."]),
    ("regex", ["type": "boolean", "description": "Treat the query as a regular expression (ICU syntax, close to JavaScript's; default false: literal text)."]),
]

private let rangeProperties: [(String, JSONValue)] = [
    ("from", ["type": "integer", "minimum": 0, "description": "Start position (UTF-16 offset into the Markdown source, from find_text or get_text `blocks`). Default: the selection."]),
    ("to", ["type": "integer", "minimum": 0, "description": "End position (UTF-16 offset). Default: the selection."]),
]

/// Characters of context `find_text` returns on each side of a match.
private let contextChars = 30
/// Matches `find_text` and `replace_text` look at before they stop and report `truncated`.
private let maxMatches = 10_000

private func object(_ pairs: [(String, JSONValue)]) -> JSONValue { .object(JSONObject(pairs)) }

private func intArg(_ args: JSONObject, _ key: String) -> Int? {
    guard let n = args[key]?.numberValue else { return nil }
    return Int(n)
}

private func boolArg(_ args: JSONObject, _ key: String) -> Bool { args[key]?.boolValue ?? false }

private func rangeJSON(_ range: NSRange) -> JSONValue {
    ["from": .number(Double(range.location)), "to": .number(Double(NSMaxRange(range)))]
}

/// `{from, to, text}` of the host's selection.
private func selectionInfo(_ host: MarkdownTextHost) -> JSONValue {
    let ns = host.markdown as NSString
    let s = host.selectedRange
    let clamped = NSIntersectionRange(s, NSRange(location: 0, length: ns.length))
    return ["from": .number(Double(s.location)), "to": .number(Double(NSMaxRange(s))), "text": .string(s.length > 0 ? ns.substring(with: clamped) : "")]
}

/// Throws a tool error unless `from..to` is an ordered range inside the text.
private func checkRange(_ from: Int, _ to: Int, size: Int) throws {
    if from > to { throw MarkdownToolError("\"from\" (\(from)) must not be after \"to\" (\(to)).") }
    if to > size { throw MarkdownToolError("Position \(to) is outside the document (size \(size)).") }
}

/// The range a formatting tool acts on: `from..to`, or the selection when both are omitted.
private func targetRange(_ host: MarkdownTextHost, _ args: JSONObject, allowEmpty: Bool) throws -> NSRange {
    let from = intArg(args, "from"), to = intArg(args, "to")
    if (from == nil) != (to == nil) { throw MarkdownToolError("Pass both \"from\" and \"to\", or neither to use the selection.") }
    let range = from.map { NSRange(location: $0, length: to! - $0) } ?? host.selectedRange
    let start = from ?? range.location, end = to ?? NSMaxRange(range)
    try checkRange(start, end, size: (host.markdown as NSString).length)
    if !allowEmpty && start == end {
        throw MarkdownToolError("The range is empty: pass \"from\" and \"to\" around the text (find_text returns them), or select it first.")
    }
    return NSRange(location: start, length: end - start)
}

private func checkWritable(_ host: MarkdownTextHost, _ fallback: String) throws {
    if let reason = host.readOnlyReason { throw MarkdownToolError(reason.isEmpty ? fallback : reason) }
}

// MARK: - Finding text

struct MarkdownFindMatch {
    var range: NSRange
    var text: String
}

/// Literal (or regex) matches in `text`; throws a tool error for an invalid pattern.
func findMatches(in text: String, query: String, matchCase: Bool, wholeWord: Bool, regex: Bool) throws -> (matches: [MarkdownFindMatch], truncated: Bool) {
    var pattern = regex ? query : NSRegularExpression.escapedPattern(for: query)
    if wholeWord { pattern = "(?<![\\p{L}\\p{N}_])(?:\(pattern))(?![\\p{L}\\p{N}_])" }
    let expression: NSRegularExpression
    do {
        expression = try NSRegularExpression(pattern: pattern, options: matchCase ? [] : [.caseInsensitive])
    } catch {
        throw MarkdownToolError("Invalid search pattern: \(query) is not a valid regular expression.")
    }
    let ns = text as NSString
    var matches: [MarkdownFindMatch] = []
    var truncated = false
    expression.enumerateMatches(in: text, range: NSRange(location: 0, length: ns.length)) { result, _, stop in
        guard let range = result?.range, range.length > 0 else { return }
        if matches.count == maxMatches {
            truncated = true
            stop.pointee = true
            return
        }
        matches.append(MarkdownFindMatch(range: range, text: ns.substring(with: range)))
    }
    return (matches, truncated)
}

// MARK: - Blocks

/// The text range of a block (its content without the heading hashes or code fences).
private func contentRange(_ node: MarkdownNode, _ ns: NSString) -> NSRange {
    switch node.kind {
    case .heading:
        let children = node.children
        guard let first = children.first, let last = children.last else {
            // An empty heading: the end of its hashes.
            return NSRange(location: NSMaxRange(node.range), length: 0)
        }
        return NSRange(location: first.range.location, length: NSMaxRange(last.range) - first.range.location)
    case .codeBlock(true, _):
        let markers = node.markers.sorted { $0.location < $1.location }
        guard let opening = markers.first else { return node.range }
        var start = NSMaxRange(opening)
        if start < ns.length, ns.character(at: start) == 10 { start += 1 }
        var end = NSMaxRange(node.range)
        if markers.count > 1, let closing = markers.last, closing.location >= start {
            end = closing.location
            if end > start, ns.character(at: end - 1) == 10 { end -= 1 }
        }
        return NSRange(location: start, length: max(0, end - start))
    default:
        return node.range
    }
}

/// Text blocks (paragraphs, headings, code blocks, table cells) in document order, with the
/// positions their text spans and, like the web's `blocksIn`, the heading `level`, the list or
/// quote they are `in` and whether a task item is `checked`. Pass `within` for those overlapping a range.
func markdownBlocks(_ text: String, within range: NSRange? = nil, details: Bool = true) -> [JSONValue] {
    let document = MarkdownDocument.parse(text)
    let ns = text as NSString
    var blocks: [JSONValue] = []
    func visit(_ node: MarkdownNode) {
        let type: String
        var level: Int?
        switch node.kind {
        case .paragraph: type = "paragraph"
        case .heading(let l, _): type = "heading"; level = l
        case .codeBlock: type = "codeBlock"
        case .tableCell: type = "tableCell"
        case .document, .blockQuote, .alert, .list, .listItem, .table, .tableHead, .tableRow, .footnoteDefinition:
            node.children.forEach(visit)
            return
        default: return
        }
        let content = contentRange(node, ns)
        if let range {
            // Blocks the range touches; a caret touches the block it is in or at the edge of.
            let end = max(NSMaxRange(range), range.location)
            guard node.range.location <= end && range.location <= NSMaxRange(node.range) else { return }
            if range.length > 0 && (NSMaxRange(node.range) == range.location || node.range.location == NSMaxRange(range)) && node.range.length > 0 { return }
        }
        var pairs: [(String, JSONValue)] = [
            ("type", .string(type)),
            ("from", .number(Double(content.location))),
            ("to", .number(Double(NSMaxRange(content)))),
            ("text", .string(ns.substring(with: content))),
        ]
        if let level { pairs.append(("level", .number(Double(level)))) }
        if details {
            if let wrapper = node.ancestors.lazy.compactMap({ ancestor -> String? in
                switch ancestor.kind {
                case .list(let ordered, _, _, _, _):
                    let task = ancestor.children.contains { if case .listItem(.some) = $0.kind { return true }; return false }
                    return task ? "taskList" : ordered ? "orderedList" : "bulletList"
                case .blockQuote, .alert: return "blockquote"
                default: return nil
                }
            }).first {
                pairs.append(("in", .string(wrapper)))
            }
            if case .listItem(let task?)? = node.parent?.kind {
                pairs.append(("checked", .bool(task == .checked)))
            }
        }
        blocks.append(object(pairs))
    }
    visit(document.root)
    return blocks
}

// MARK: - Inline formatting

/// The inline formats `format_text` sets and clears, by tool argument.
private let toggleFormats: [(arg: String, format: MarkdownInlineFormat, what: String)] = [
    ("bold", .strong, "Bold (strong) text, `**…**`."),
    ("italic", .emphasis, "Italic (emphasis), `*…*`."),
    ("strike", .strikethrough, "Struck-through text, `~~…~~`."),
    ("code", .code, "Inline code, `` `…` `` (monospace; the other formats don't apply inside it)."),
]

private func isUnsafeLink(_ url: String) -> Bool {
    let trimmed = url.trimmingCharacters(in: .whitespaces).lowercased()
    return ["javascript:", "data:", "vbscript:"].contains { trimmed.hasPrefix($0) }
}

/// The inline nodes of `format` that overlap `range`'s text.
private func formatNodes(_ format: MarkdownInlineFormat, _ formatting: MarkdownFormatting, _ range: NSRange) -> [MarkdownNode] {
    var nodes: [MarkdownNode] = []
    let segments = formatting.segments(in: range)
    formatting.document.root.walk { node in
        guard format.matches(node.kind) else { return }
        if segments.contains(where: { NSIntersectionRange($0, node.range).length > 0 }) { nodes.append(node) }
    }
    return nodes
}

/// Which formats are on the text of `range`, as the web's `marksOn`: `true` when on all of it,
/// `"partly"` when on some, and `link` (the destination, or `"mixed"`).
private func formattingJSON(_ text: String, _ range: NSRange) -> JSONValue {
    let formatting = MarkdownFormatting(text: text)
    var out: [(String, JSONValue)] = []
    for (arg, format, _) in toggleFormats {
        if formatting.isActive(format, selection: range) {
            out.append((arg, true))
        } else if !formatNodes(format, formatting, range).isEmpty {
            out.append((arg, "partly"))
        }
    }
    var links = Set<String?>()
    for segment in formatting.segments(in: range) {
        var destination: String?
        formatting.document.root.walk { node in
            if case .link(let d, _, _) = node.kind, NSIntersectionRange(node.range, segment).length > 0 || (NSLocationInRange(segment.location, node.range)) {
                destination = d
            }
        }
        links.insert(destination)
    }
    if links.count == 1, let only = links.first, let destination = only { out.append(("link", .string(destination))) }
    else if links.count > 1 { out.append(("link", "mixed")) }
    return object(out)
}

/// A step of a formatting tool: the text after it and where the acted-on range went.
private struct Step {
    var text: String
    var range: NSRange
}

/// Applies `edit` (a whole new text from the formatting engine) and keeps track of the user's selection.
private func advance(_ step: inout Step, _ edit: MarkdownEdit?, selection: inout NSRange) {
    guard let edit, let diff = MarkdownTextEdit.minimal(from: step.text, to: edit.text) else { return }
    selection = mapRange(selection, through: [diff])
    step = Step(text: edit.text, range: edit.selection)
}

/// Applies plain edits (ranges in `step.text`) and maps the range and selection through them.
private func advance(_ step: inout Step, edits: [MarkdownTextEdit], selection: inout NSRange) {
    let sorted = edits.sorted { $0.range.location < $1.range.location }
    guard !sorted.isEmpty else { return }
    let text = MarkdownTextChange(edits: sorted, selection: NSRange(), actionName: "").applied(to: step.text)
    selection = mapRange(selection, through: sorted)
    step = Step(text: text, range: mapRange(step.range, through: sorted))
}

/// Applies the result of a formatting tool to the host as one undo step, leaving the user's selection where it was.
private func commit(_ host: MarkdownTextHost, original: String, step: Step, selection: NSRange, actionName: String) throws {
    guard let diff = MarkdownTextEdit.minimal(from: original, to: step.text) else { return }
    try host.apply(MarkdownTextChange(edits: [diff], selection: selection, actionName: actionName))
}

// MARK: - Block types

/// Block types `set_block_type` can make, by tool value.
private let blockTypes: [(value: String, what: String)] = [
    ("paragraph", "a plain paragraph (also takes the blocks out of lists, quotes and code blocks)"),
    ("heading", "a heading of `level`"),
    ("bullet_list", "items of a bulleted list"),
    ("ordered_list", "items of a numbered list"),
    ("task_list", "items of a checklist"),
    ("blockquote", "a quote"),
    ("code_block", "a fenced code block (plain text: formatting is kept as literal Markdown)"),
]

/// Takes the lines of `step.range` out of any code block and quote, as ProseMirror's `clearNodes`.
private func clearContainers(_ step: inout Step, selection: inout NSRange, keepLists: Bool) {
    var formatting = MarkdownFormatting(text: step.text)
    if formatting.codeBlock(containing: step.range) != nil {
        advance(&step, FormatCommandEdits.edit(for: .codeBlock, formatting: formatting, selection: step.range), selection: &selection)
        formatting = MarkdownFormatting(text: step.text)
    }
    // Each call removes one level of quoting.
    for _ in 0 ..< 16 where formatting.isQuoted(selection: step.range) {
        guard let edit = formatting.toggleBlock(.quote, selection: step.range) else { break }
        advance(&step, edit, selection: &selection)
        formatting = MarkdownFormatting(text: step.text)
    }
    if !keepLists, formatting.activeBlockFormat(selection: step.range) != .paragraph {
        advance(&step, formatting.toggleBlock(.paragraph, selection: step.range), selection: &selection)
    }
}

/// Makes the lines of `step.range` `format` (not a toggle: blocks already in it stay).
private func setLines(_ format: MarkdownBlockFormat, _ step: inout Step, selection: inout NSRange) {
    let formatting = MarkdownFormatting(text: step.text)
    guard formatting.activeBlockFormat(selection: step.range) != format else { return }
    advance(&step, formatting.toggleBlock(format, selection: step.range), selection: &selection)
}

// MARK: - Provider

/**
 Tools for a Markdown text, named and shaped like the web rich-text tools: `get_text` and
 `find_text` (always), plus `insert_text`, `replace_text`, `replace_range`, `replace_selection`,
 `set_selection`, `format_text` and `set_block_type` while the host can be edited. Each write is one
 undo step on the host. Register it in a `ToolRegistry` (`namespace: ""` for the bare web names) to
 serve it over `ToolBridgeClient`; add `createMarkdownCommandToolProvider` for the format commands
 and `createMarkdownTextMechanicsToolProvider` for punctuation and spelling.
 */
public func createMarkdownToolProvider(_ host: MarkdownTextHost, _ options: MarkdownToolProviderOptions = MarkdownToolProviderOptions()) -> AgentToolProvider {
    let size = { (host.markdown as NSString).length }

    let getText = AgentTool(
        name: "get_text",
        title: "Get document text",
        description:
            "Returns the document content, the current selection and the document size. The document is Markdown source: `text` and `markdown` both return it as it is, `html` renders it. " +
            "Editing tools take positions in the source (UTF-16 offsets): pass `blocks: true` to get every paragraph, heading, code block and table cell with the positions its text spans, " +
            "or use find_text to get the positions of a phrase.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([
                ("format", ["type": "string", "enum": ["text", "html", "markdown"], "description": "Content format (default: text, which is the Markdown source)."]),
                ("blocks", ["type": "boolean", "description": "Also return `blocks`: each paragraph/heading/code block/cell as {type, from, to, text} (default false)."]),
            ])),
            ("additionalProperties", false),
        ]),
        annotations: ToolAnnotations(title: "Get document text", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false),
        handler: { args, _ in
            let format = args["format"]?.stringValue ?? "text"
            let text = host.markdown
            let content = format == "html" ? MarkdownHTMLRenderer.render(MarkdownDocument.parse(text)) : text
            var out: [(String, JSONValue)] = [
                ("format", .string(format)),
                ("content", .string(content)),
                ("selection", selectionInfo(host)),
                ("size", .number(Double(size()))),
            ]
            if boolArg(args, "blocks") { out.append(("blocks", .array(markdownBlocks(text)))) }
            return .value(object(out))
        }
    )

    let insertText = AgentTool(
        name: "insert_text",
        title: "Insert text",
        description:
            "Inserts literal text (Markdown source: a blank line starts a new paragraph) at a position, or at the cursor when `at` is omitted. " +
            "Returns the inserted `range` {from, to}.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([
                ("text", ["type": "string", "description": "Text to insert."]),
                ("at", ["type": "integer", "minimum": 0, "description": "Position (UTF-16 offset into the Markdown source; default: the selection)."]),
            ])),
            ("required", ["text"]),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Insert text", destructive: false, idempotent: false),
        handler: { args, _ in
            try checkWritable(host, "The document is read-only.")
            let text = args["text"]?.stringValue ?? ""
            let at = intArg(args, "at")
            if let at, at > size() { throw MarkdownToolError("Position \(at) is outside the document (size \(size())).") }
            let target = at.map { NSRange(location: $0, length: 0) } ?? host.selectedRange
            let range = try write(host, target, text, actionName: "Insert Text")
            return .value(object([("inserted", .number(Double((text as NSString).length))), ("range", rangeJSON(range)), ("selection", selectionInfo(host))]))
        }
    )

    let findText = AgentTool(
        name: "find_text",
        title: "Find text",
        description:
            "Finds a phrase (literal by default) in the Markdown source and returns each match with its positions {from, to}, " +
            "ready for replace_range, insert_text `at` or set_selection, plus surrounding context.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([("query", ["type": "string", "minLength": 1, "description": "Text (or regex) to find."])] + findSchemaProperties + [
                ("maxResults", ["type": "integer", "minimum": 1, "maximum": 500, "description": "Matches returned (default 50)."]),
            ])),
            ("required", ["query"]),
            ("additionalProperties", false),
        ]),
        annotations: ToolAnnotations(title: "Find text", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false),
        handler: { args, _ in
            let text = host.markdown
            let ns = text as NSString
            let maxResults = intArg(args, "maxResults") ?? 50
            let (matches, truncated) = try findMatches(in: text, query: args["query"]?.stringValue ?? "", matchCase: boolArg(args, "matchCase"),
                                                       wholeWord: boolArg(args, "wholeWord"), regex: boolArg(args, "regex"))
            let shown = matches.prefix(maxResults).map { m -> JSONValue in
                let beforeStart = max(0, m.range.location - contextChars)
                let afterEnd = min(ns.length, NSMaxRange(m.range) + contextChars)
                return object([
                    ("from", .number(Double(m.range.location))),
                    ("to", .number(Double(NSMaxRange(m.range)))),
                    ("text", .string(m.text)),
                    ("before", .string(ns.substring(with: NSRange(location: beforeStart, length: m.range.location - beforeStart)))),
                    ("after", .string(ns.substring(with: NSRange(location: NSMaxRange(m.range), length: afterEnd - NSMaxRange(m.range))))),
                ])
            }
            return .value(object([
                ("total", .number(Double(matches.count))),
                ("truncated", .bool(truncated || matches.count > maxResults)),
                ("matches", .array(Array(shown))),
            ]))
        }
    )

    let replaceText = AgentTool(
        name: "replace_text",
        title: "Find and replace",
        description:
            "Replaces occurrences of a phrase with literal text in one undoable step. The search runs on the Markdown source, so the found text's formatting markers around it are kept. " +
            "Replaces every occurrence by default, or only the n-th with `occurrence`. Fails when nothing matches.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([
                ("find", ["type": "string", "minLength": 1, "description": "Text (or regex) to find."]),
                ("replace", ["type": "string", "description": "Replacement text (literal; an empty string deletes the matches)."]),
            ] + findSchemaProperties + [
                ("occurrence", ["type": "integer", "minimum": 1, "description": "Only replace the n-th match (1-based, in document order). Default: all matches."]),
            ])),
            ("required", ["find", "replace"]),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Find and replace", destructive: true, idempotent: false),
        handler: { args, _ in
            try checkWritable(host, "The document is read-only.")
            let find = args["find"]?.stringValue ?? ""
            let replacement = args["replace"]?.stringValue ?? ""
            let (matches, _) = try findMatches(in: host.markdown, query: find, matchCase: boolArg(args, "matchCase"),
                                               wholeWord: boolArg(args, "wholeWord"), regex: boolArg(args, "regex"))
            if matches.isEmpty { throw MarkdownToolError("No match for \(JSONValue.string(find).stringified()).") }
            let occurrence = intArg(args, "occurrence")
            if let occurrence, occurrence > matches.count {
                throw MarkdownToolError("Occurrence \(occurrence) requested, but there are only \(matches.count) matches.")
            }
            let chosen = occurrence.map { [matches[$0 - 1]] } ?? matches
            let edits = chosen.map { MarkdownTextEdit(range: $0.range, replacement: replacement) }
            let selection = mapRange(host.selectedRange, through: edits)
            try host.apply(MarkdownTextChange(edits: edits, selection: selection, actionName: "Replace Text"))
            let length = (replacement as NSString).length
            var shift = 0
            let ranges = chosen.map { m -> JSONValue in
                let from = m.range.location + shift
                shift += length - m.range.length
                return rangeJSON(NSRange(location: from, length: length))
            }
            return .value(object([
                ("replaced", .number(Double(chosen.count))),
                ("total", .number(Double(matches.count))),
                ("ranges", .array(ranges)),
                ("selection", selectionInfo(host)),
            ]))
        }
    )

    let replaceRange = AgentTool(
        name: "replace_range",
        title: "Replace a range",
        description:
            "Replaces the Markdown source between two positions (from get_text `blocks` or find_text) with literal text. " +
            "from === to inserts; an empty text deletes. Returns the new text's `range` {from, to}.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([
                ("from", ["type": "integer", "minimum": 0, "description": "Start position (UTF-16 offset into the Markdown source)."]),
                ("to", ["type": "integer", "minimum": 0, "description": "End position (UTF-16 offset)."]),
                ("text", ["type": "string", "description": "Replacement text (Markdown source)."]),
            ])),
            ("required", ["from", "to", "text"]),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Replace a range", destructive: true, idempotent: false),
        handler: { args, _ in
            try checkWritable(host, "The document is read-only.")
            let from = intArg(args, "from") ?? 0, to = intArg(args, "to") ?? 0
            try checkRange(from, to, size: size())
            let range = try write(host, NSRange(location: from, length: to - from), args["text"]?.stringValue ?? "", actionName: "Replace Text")
            return .value(object([
                ("replaced", ["from": .number(Double(from)), "to": .number(Double(to))]),
                ("range", rangeJSON(range)),
                ("selection", selectionInfo(host)),
                ("size", .number(Double(size()))),
            ]))
        }
    )

    let setSelection = AgentTool(
        name: "set_selection",
        title: "Set the selection",
        description: "Selects the Markdown source between two positions (from === to places the cursor).",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([
                ("from", ["type": "integer", "minimum": 0, "description": "Start position (UTF-16 offset into the Markdown source)."]),
                ("to", ["type": "integer", "minimum": 0, "description": "End position (default: from)."]),
            ])),
            ("required", ["from"]),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Set the selection", destructive: false, idempotent: true),
        handler: { args, _ in
            let from = intArg(args, "from") ?? 0
            let to = intArg(args, "to") ?? from
            try checkRange(from, to, size: size())
            host.setSelectedRange(NSRange(location: from, length: to - from))
            return .value(object([("selection", selectionInfo(host))]))
        }
    )

    let replaceSelection = AgentTool(
        name: "replace_selection",
        title: "Replace selection",
        description: "Replaces the selected source with literal text (an empty string deletes the selection). Returns the new text's `range` {from, to}.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object([("text", ["type": "string", "description": "Replacement text."])])),
            ("required", ["text"]),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Replace selection", destructive: true, idempotent: false),
        handler: { args, _ in
            try checkWritable(host, "The document is read-only.")
            let selected = host.selectedRange
            let range = try write(host, selected, args["text"]?.stringValue ?? "", actionName: "Replace Selection")
            return .value(object([("replaced", rangeJSON(selected)), ("range", rangeJSON(range)), ("selection", selectionInfo(host))]))
        }
    )

    let formatArgs = toggleFormats.map(\.arg) + ["link"]
    let formatText = AgentTool(
        name: "format_text",
        title: "Format text",
        description:
            "Sets or clears inline formatting on a range of text (or the selection): \(formatArgs.joined(separator: ", ")). " +
            "Only the properties you pass change; they are written as Markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`). Positions come from find_text or get_text `blocks`. One undo step; the selection is left where it was. " +
            "Returns the `range` and the formatting now on it (`partly` / `mixed` where only some of the text has it). For headings and lists use set_block_type.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object(rangeProperties + toggleFormats.map { ($0.arg, ["type": "boolean", "description": .string("\($0.what) true sets it, false clears it; omit to leave it.")]) } + [
                ("link", ["type": ["string", "null"], "minLength": 1, "description": "Link the text to this URL (https://…, mailto:…), or null to remove links. Omit to leave links."]),
            ])),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Format text", destructive: false, idempotent: true),
        handler: { args, _ in
            try checkWritable(host, "The document is read-only, so it cannot be formatted.")
            let asked = formatArgs.filter { args[$0] != nil }
            if asked.isEmpty { throw MarkdownToolError("Pass at least one formatting property: \(formatArgs.joined(separator: ", ")).") }
            let range = try targetRange(host, args, allowEmpty: false)
            if case .string(let url)? = args["link"], isUnsafeLink(url) {
                throw MarkdownToolError("Links may not use javascript:, data: or vbscript: URLs. Nothing was changed.")
            }
            let original = host.markdown
            var step = Step(text: original, range: range)
            var selection = host.selectedRange
            for (arg, format, _) in toggleFormats {
                guard let want = args[arg]?.boolValue else { continue }
                let formatting = MarkdownFormatting(text: step.text)
                if want {
                    if formatting.codeSpan(containing: step.range) != nil || formatting.codeBlock(containing: step.range) != nil, format != .code {
                        throw MarkdownToolError("The range is inside code, which can't be \(arg). Nothing was changed.")
                    }
                    if !formatting.isActive(format, selection: step.range) {
                        advance(&step, formatting.toggle(format, selection: step.range), selection: &selection)
                    }
                } else if formatting.isActive(format, selection: step.range) {
                    advance(&step, formatting.toggle(format, selection: step.range), selection: &selection)
                } else {
                    // Partly formatted: remove the delimiters of every span it overlaps.
                    let edits = formatNodes(format, formatting, step.range).flatMap { $0.markers.map { MarkdownTextEdit(range: $0, replacement: "") } }
                    advance(&step, edits: edits, selection: &selection)
                }
            }
            if let link = args["link"] {
                let formatting = MarkdownFormatting(text: step.text)
                if case .string(let url) = link {
                    advance(&step, formatting.setLink(url.trimmingCharacters(in: .whitespaces), selection: step.range), selection: &selection)
                } else if formatting.link(at: step.range) != nil {
                    advance(&step, formatting.removeLink(selection: step.range), selection: &selection)
                }
            }
            try commit(host, original: original, step: step, selection: selection, actionName: "Format Text")
            let text = host.markdown as NSString
            let after = NSIntersectionRange(step.range, NSRange(location: 0, length: text.length))
            return .value(object([("range", rangeJSON(after)), ("text", .string(text.substring(with: after))), ("formatting", formattingJSON(host.markdown, after))]))
        }
    )

    let setBlockType = AgentTool(
        name: "set_block_type",
        title: "Set the block type",
        description:
            "Turns every paragraph the range touches (or the one at the cursor) into " +
            blockTypes.map { "\($0.value) (\($0.what))" }.joined(separator: ", ") +
            ". The blocks are first taken out of any quote or code block, so one call switches between kinds. One undo step; the selection is left where it was. " +
            "Returns the resulting `blocks` with their type, positions, text, level and the list or quote they are in.",
        inputSchema: object([
            ("type", "object"),
            ("properties", object(rangeProperties + [
                ("type", ["type": "string", "enum": .array(blockTypes.map { .string($0.value) }), "description": "What the blocks become."]),
                ("level", ["type": "integer", "enum": [1, 2, 3, 4, 5, 6], "description": "Heading level for type \"heading\" (1, 2, 3, 4, 5, 6; 1 is the largest)."]),
            ])),
            ("required", ["type"]),
            ("additionalProperties", false),
        ]),
        annotations: writeAnnotations("Set the block type", destructive: false, idempotent: true),
        handler: { args, _ in
            try checkWritable(host, "The document is read-only, so it cannot be formatted.")
            let type = args["type"]?.stringValue ?? ""
            let level = intArg(args, "level")
            if type == "heading" && level == nil { throw MarkdownToolError("Pass a heading \"level\" (1, 2, 3, 4, 5, 6).") }
            if type != "heading" && level != nil { throw MarkdownToolError("\"level\" only applies to type \"heading\".") }
            let range = try targetRange(host, args, allowEmpty: true)
            if MarkdownFormatting(text: host.markdown).isInTable(range) {
                throw MarkdownToolError("Those blocks cannot become \(type) here (they are in a table). Nothing was changed.")
            }
            let original = host.markdown
            var step = Step(text: original, range: range)
            var selection = host.selectedRange
            switch type {
            case "heading", "bullet_list", "ordered_list", "task_list":
                clearContainers(&step, selection: &selection, keepLists: true)
                let format: MarkdownBlockFormat = type == "heading" ? .heading(level!) : type == "bullet_list" ? .bulletList : type == "ordered_list" ? .numberedList : .taskList
                setLines(format, &step, selection: &selection)
            case "blockquote":
                clearContainers(&step, selection: &selection, keepLists: false)
                advance(&step, MarkdownFormatting(text: step.text).toggleBlock(.quote, selection: step.range), selection: &selection)
            case "code_block":
                if MarkdownFormatting(text: step.text).codeBlock(containing: step.range) == nil {
                    clearContainers(&step, selection: &selection, keepLists: false)
                    advance(&step, FormatCommandEdits.codeBlock(language: nil, text: step.text, selection: step.range), selection: &selection)
                }
            default:
                clearContainers(&step, selection: &selection, keepLists: false)
            }
            try commit(host, original: original, step: step, selection: selection, actionName: "Set Block Type")
            return .value(object([("type", .string(type)), ("range", rangeJSON(step.range)), ("blocks", .array(markdownBlocks(host.markdown, within: step.range)))]))
        }
    )

    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Markdown text",
        description: "Read, find, edit and format a Markdown text: the web rich-text tools, with positions in the Markdown source.",
        skill: "pixerate-rich-text",
        tools: {
            host.readOnlyReason == nil
                ? [getText, findText, insertText, replaceText, replaceRange, replaceSelection, setSelection, formatText, setBlockType]
                : [getText, findText]
        },
        subscribe: { listener in host.observeEditability(listener) ?? Cancellable {} }
    )
}

/// Replaces `range` with `text` as one undo step, keeping the user's selection where it was
/// (a caret at the edit moves past it). Returns the new text's range.
private func write(_ host: MarkdownTextHost, _ range: NSRange, _ text: String, actionName: String) throws -> NSRange {
    let edit = MarkdownTextEdit(range: range, replacement: text)
    let selection = mapRange(host.selectedRange, through: [edit])
    try host.apply(MarkdownTextChange(edits: [edit], selection: selection, actionName: actionName))
    return NSRange(location: range.location, length: (text as NSString).length)
}
