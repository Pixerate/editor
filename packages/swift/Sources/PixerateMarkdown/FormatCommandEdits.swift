// Turns a FormatCommand into a Markdown edit with the AST formatting engine. The Format menu
// and keyboard shortcuts use it (through ContentView), and so does the shared conformance
// corpus (`scripts/run_conformance_tests.sh`). Ranges are raw-Markdown UTF-16 offsets.

import Foundation

public enum FormatCommandEdits: Sendable {
    /// The edit for `command`, or nil when it does not apply (or a manifest `enabledWhen`
    /// condition fails). `.link` needs a URL, so callers use `link(_:text:selection:)`; table,
    /// callout, footnote and table-of-contents edits live in the macOS editor.
    public static func edit(for command: FormatCommand, text: String, selection: NSRange) -> MarkdownEdit? {
        edit(for: command, formatting: MarkdownFormatting(text: text), selection: selection)
    }

    /// The same, reusing a parse of the text (the editor caches one).
    public static func edit(for command: FormatCommand, formatting: MarkdownFormatting, selection: NSRange) -> MarkdownEdit? {
        let text = formatting.text
        guard formatting.isEnabled(command, selection: selection) else { return nil }
        switch command {
        case .bold: return formatting.toggle(.strong, selection: selection)
        case .italic: return formatting.toggle(.emphasis, selection: selection)
        case .strikethrough: return formatting.toggle(.strikethrough, selection: selection)
        case .code:
            // In a code block, the code toggle removes the fences; across lines it makes a block
            if formatting.codeBlock(containing: selection) != nil || formatting.segments(in: selection).count > 1 {
                return toggleCodeBlock(text: text, selection: selection, formatting: formatting)
            }
            return formatting.toggle(.code, selection: selection)
        case .heading(let level): return formatting.toggleBlock(.heading(level), selection: selection)
        case .paragraph: return formatting.toggleBlock(.paragraph, selection: selection)
        case .bulletList: return formatting.toggleBlock(.bulletList, selection: selection)
        case .numberedList: return formatting.toggleBlock(.numberedList, selection: selection)
        case .taskList: return formatting.toggleBlock(.taskList, selection: selection)
        case .quote: return formatting.toggleBlock(.quote, selection: selection)
        case .codeBlock: return toggleCodeBlock(text: text, selection: selection, formatting: formatting)
        case .link, .table, .callout, .footnote, .tableOfContents: return nil
        }
    }

    /// Sets the link URL on the selection, or removes the link when `url` is nil or empty.
    public static func link(_ url: String?, text: String, selection: NSRange) -> MarkdownEdit? {
        let formatting = MarkdownFormatting(text: text)
        guard formatting.isEnabled(.link, selection: selection) else { return nil }
        guard let url = url, !url.isEmpty else { return formatting.removeLink(selection: selection) }
        return formatting.setLink(url, selection: selection)
    }

    /// The destination of the link at `selection`, if there is one.
    public static func activeLink(text: String, selection: NSRange) -> String? {
        let formatting = MarkdownFormatting(text: text)
        guard let node = formatting.link(at: selection), case .link(let destination, _, _) = node.kind else { return nil }
        return destination
    }

    /// Active inline formats (`.bold`, `.italic`, `.code`, `.strikethrough`) and list types
    /// (`.bulletList`, `.numberedList`, `.checkList`) at a UTF-16 caret `offset` in `text`.
    public static func activeFormats(at offset: Int, in text: String) -> Set<FormatCommand> {
        activeFormats(at: offset, in: MarkdownFormatting(text: text))
    }

    /// Active inline formats and list types for a UTF-16 `selection` range in `text`.
    public static func activeFormats(at selection: NSRange, in text: String) -> Set<FormatCommand> {
        activeFormats(at: selection, in: MarkdownFormatting(text: text))
    }

    /// Active inline formats and list types at a UTF-16 caret `offset`, reusing an existing parse.
    public static func activeFormats(at offset: Int, in formatting: MarkdownFormatting) -> Set<FormatCommand> {
        guard offset != NSNotFound else { return [] }
        return activeFormats(at: NSRange(location: offset, length: 0), in: formatting)
    }

    /// Active inline formats and list types for a UTF-16 `selection` range, reusing an existing parse.
    public static func activeFormats(at selection: NSRange, in formatting: MarkdownFormatting) -> Set<FormatCommand> {
        let ns = formatting.text as NSString
        guard selection.location != NSNotFound else { return [] }
        let clampedLocation = min(max(0, selection.location), ns.length)
        let clampedLength = min(max(0, selection.length), ns.length - clampedLocation)
        let clamped = NSRange(location: clampedLocation, length: clampedLength)

        if let block = formatting.codeBlock(containing: clamped) {
            // A standalone `~~~~` line is parsed as an unclosed tilde fence, so only allow it when
            // the caret sits right in the middle of an empty `~~‸~~` strikethrough pair.
            let isEmptyTildePair = clamped.length == 0
                && block.kind == .codeBlock(fenced: true, info: "")
                && block.markers.count == 1
                && block.markers[0].length == 4
                && clamped.location == block.markers[0].location + 2
                && block.markers[0].location + 4 <= ns.length
                && ns.substring(with: block.markers[0]) == "~~~~"
            guard isEmptyTildePair else { return [] }
        }

        var inlineNodes: [MarkdownNode] = []
        var inlineMarkers: [NSRange] = []
        var isInsideOpaqueInline = false

        formatting.document.root.walk { node in
            guard !node.kind.isBlock else { return }
            inlineMarkers.append(contentsOf: node.markers)
            switch node.kind {
            case .strong, .emphasis, .strikethrough, .code:
                inlineNodes.append(node)
                if case .code = node.kind, clamped.length == 0,
                   clamped.location > node.range.location, clamped.location < NSMaxRange(node.range) {
                    isInsideOpaqueInline = true
                }
            case .math, .htmlInline:
                if clamped.length == 0,
                   clamped.location > node.range.location, clamped.location < NSMaxRange(node.range) {
                    isInsideOpaqueInline = true
                }
            default:
                break
            }
        }

        var active: Set<FormatCommand> = []

        if clamped.length == 0 {
            let loc = clamped.location
            for node in inlineNodes {
                let isActiveAtCaret: Bool
                if node.markers.count >= 2 {
                    let inner = innerRange(of: node, in: ns)
                    isActiveAtCaret = inner.location <= loc && loc <= NSMaxRange(inner)
                } else {
                    isActiveAtCaret = node.range.location < loc && loc < NSMaxRange(node.range)
                }
                if isActiveAtCaret, let command = inlineCommand(for: node.kind) {
                    active.insert(command)
                }
            }

            if !isInsideOpaqueInline {
                let delimiters: [unichar] = [0x2A, 0x5F, 0x7E, 0x60] // *, _, ~, `
                for ch in delimiters {
                    var leftStart = loc
                    while leftStart > 0 && ns.character(at: leftStart - 1) == ch {
                        leftStart -= 1
                    }
                    if leftStart < loc && leftStart > 0 {
                        var backslashes = 0
                        while leftStart - 1 - backslashes >= 0 && ns.character(at: leftStart - 1 - backslashes) == 0x5C {
                            backslashes += 1
                        }
                        if backslashes % 2 == 1 {
                            leftStart += 1
                        }
                    }
                    let leftCount = loc - leftStart
                    guard leftCount > 0 else { continue }

                    var rightEnd = loc
                    while rightEnd < ns.length && ns.character(at: rightEnd) == ch {
                        rightEnd += 1
                    }
                    let rightCount = rightEnd - loc
                    guard leftCount == rightCount else { continue }

                    let pairRange = NSRange(location: leftStart, length: leftCount + rightCount)
                    guard !inlineMarkers.contains(where: { NSIntersectionRange($0, pairRange).length > 0 }) else {
                        continue
                    }

                    switch (ch, leftCount) {
                    case (0x2A, 1), (0x5F, 1): active.insert(.italic)
                    case (0x2A, 2), (0x5F, 2): active.insert(.bold)
                    case (0x2A, 3), (0x5F, 3): active.formUnion([.bold, .italic])
                    case (0x7E, 2): active.insert(.strikethrough)
                    case (0x60, 1): active.insert(.code)
                    default: break
                    }
                }
            }
        } else {
            let segs = formatting.segments(in: clamped)
            for (inlineFormat, command) in [
                (MarkdownInlineFormat.strong, FormatCommand.bold),
                (.emphasis, .italic),
                (.strikethrough, .strikethrough),
                (.code, .code),
            ] {
                let matching = inlineNodes.filter { inlineFormat.matches($0.kind) }
                if !segs.isEmpty {
                    let allCovered = segs.allSatisfy { seg in
                        matching.contains { node in
                            let covers = node.range.location <= seg.location && NSMaxRange(seg) <= NSMaxRange(node.range)
                            guard covers else { return false }
                            return NSIntersectionRange(innerRange(of: node, in: ns), seg).length > 0
                        }
                    }
                    if allCovered { active.insert(command) }
                } else {
                    let containsWhitespace = matching.contains { node in
                        let inner = innerRange(of: node, in: ns)
                        return inner.location <= clamped.location && NSMaxRange(clamped) <= NSMaxRange(inner)
                    }
                    if containsWhitespace { active.insert(command) }
                }
            }
        }

        switch formatting.activeListFormat(selection: clamped) {
        case .bulletList?: active.insert(.bulletList)
        case .numberedList?: active.insert(.numberedList)
        case .taskList?: active.insert(.checkList)
        default: break
        }

        return active
    }

    private static func inlineCommand(for kind: MarkdownNode.Kind) -> FormatCommand? {
        switch kind {
        case .strong: return .bold
        case .emphasis: return .italic
        case .strikethrough: return .strikethrough
        case .code: return .code
        default: return nil
        }
    }

    private static func innerRange(of node: MarkdownNode, in ns: NSString) -> NSRange {
        guard node.markers.count >= 2 else { return node.range }
        let open = node.markers[0]
        let close = node.markers[node.markers.count - 1]
        var start = NSMaxRange(open)
        var end = close.location
        if case .code = node.kind {
            // Code spans with multi-backtick fences absorb one space of padding into each marker;
            // restore that padding to the inner range so carets inside the padding stay `.code`.
            if open.length > 1 && start > 0 && start <= ns.length && ns.character(at: start - 1) == 0x20 {
                start -= 1
            }
            if close.length > 1 && end < ns.length && ns.character(at: end) == 0x20 {
                end += 1
            }
        }
        return NSRange(location: start, length: max(0, end - start))
    }

    /// Makes the selection a fenced code block with `language` (nil for no info string). Inside
    /// a fenced block, only the info string changes.
    public static func codeBlock(language: String?, text: String, selection: NSRange) -> MarkdownEdit? {
        let formatting = MarkdownFormatting(text: text)
        guard formatting.isEnabled(.codeBlock, selection: selection) else { return nil }
        if let block = formatting.codeBlock(containing: selection), case .codeBlock(true, _) = block.kind {
            guard let edit = MarkdownEditingCommands.setCodeLanguage(language, text: text, location: selection.location) else { return nil }
            // setCodeLanguage reports a caret; keep a range selection's length
            return MarkdownEdit(text: edit.text, selection: NSRange(location: edit.selection.location, length: selection.length))
        }
        return wrapInCodeBlock(text: text, selection: selection, language: language)
    }

    /// Removes the fences of the code block around the selection, or wraps the selected lines in one.
    private static func toggleCodeBlock(text: String, selection: NSRange, formatting: MarkdownFormatting) -> MarkdownEdit? {
        let ns = text as NSString
        guard let block = formatting.codeBlock(containing: selection) else {
            return wrapInCodeBlock(text: text, selection: selection, language: nil)
        }
        let blockText = ns.substring(with: block.range)
        var lines = blockText.components(separatedBy: "\n")
        if lines.last?.isEmpty == true { lines.removeLast() }
        guard lines.count >= 1,
              let first = lines.first?.trimmingCharacters(in: .whitespaces),
              first.hasPrefix("```") || first.hasPrefix("~~~") else { return nil }
        let last = lines.last!.trimmingCharacters(in: .whitespaces)
        let hasClosingFence = lines.count > 1 && (last.hasPrefix("```") || last.hasPrefix("~~~"))
        let bodyLines = lines.dropFirst().dropLast(hasClosingFence ? 1 : 0)
        let body = bodyLines.joined(separator: "\n")
        let trailing = blockText.hasSuffix("\n") ? "\n" : ""
        let newText = ns.replacingCharacters(in: block.range, with: body + trailing)
        // Keep the selection where it was in the body, clamped to the body
        let bodyStart = block.range.location + (lines[0] as NSString).length + 1
        let bodyLength = (body as NSString).length
        func map(_ position: Int) -> Int {
            block.range.location + min(max(position - bodyStart, 0), bodyLength)
        }
        let start = map(selection.location)
        let end = map(NSMaxRange(selection))
        return MarkdownEdit(text: newText, selection: NSRange(location: start, length: end - start))
    }

    /// Wraps the lines the selection touches in a fenced code block, keeping the selection on the same text.
    private static func wrapInCodeBlock(text: String, selection: NSRange, language: String?) -> MarkdownEdit? {
        let ns = text as NSString
        guard selection.location != NSNotFound, NSMaxRange(selection) <= ns.length else { return nil }
        let lineRange = ns.lineRange(for: selection)
        var body = ns.substring(with: lineRange)
        let endsWithNewline = body.hasSuffix("\n")
        if endsWithNewline { body.removeLast() }
        let opening = "```" + (language ?? "") + "\n"
        let replacement = opening + body + "\n```" + (endsWithNewline ? "\n" : "")
        let newText = ns.replacingCharacters(in: lineRange, with: replacement)
        let shift = (opening as NSString).length
        return MarkdownEdit(text: newText, selection: NSRange(location: selection.location + shift, length: selection.length))
    }
}
