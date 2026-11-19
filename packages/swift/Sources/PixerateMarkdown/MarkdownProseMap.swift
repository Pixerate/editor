import Foundation

// A port of `markdownProseMap` (packages/core/src/tools/markdown-prose.ts, #892): where the prose
// is in Markdown source. The house-style checks on Markdown (#890) compare the blocks they read
// with the TS core exactly (`domains/markdown-style`), so this follows the TS reader line by line
// rather than `MarkdownDocument`. Offsets are UTF-16 code units.

/// The kind of a text block.
public enum MarkdownProseBlockKind: String, Sendable {
    case paragraph, heading, code, html, table, frontMatter, thematicBreak, linkDefinition
}

/// A container a block sits in.
public enum MarkdownProseContainer: String, Sendable {
    case listItem, quote, alert, footnote
}

public struct MarkdownProseBlock: Equatable, Sendable {
    public var kind: MarkdownProseBlockKind
    /// The block's source range, markers included.
    public var from: Int
    public var to: Int
    /// Where the block's first text starts (after `# `, `- `, `> ` and the like), or -1.
    public var firstText: Int
    /// The containers it sits in, outermost first.
    public var within: [MarkdownProseContainer]
}

public struct MarkdownProseRange: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public init(from: Int, to: Int) {
        self.from = from
        self.to = to
    }
}

public struct MarkdownProseMap: Sendable {
    public var blocks: [MarkdownProseBlock]
    /// Ranges of plain text, in order.
    public var prose: [MarkdownProseRange]
}

private struct ProseLine {
    var from: Int
    /// End of the line's text (the newline's offset, or the end of the source).
    var to: Int
    var text: NSString
}

private func splitLines(_ source: NSString) -> [ProseLine] {
    var lines: [ProseLine] = []
    var from = 0
    while true {
        let nl = source.range(of: "\n", options: [.literal], range: NSRange(location: from, length: source.length - from)).location
        let to = nl == NSNotFound ? source.length : nl
        lines.append(ProseLine(from: from, to: to, text: source.substring(with: NSRange(location: from, length: to - from)) as NSString))
        if nl == NSNotFound { return lines }
        from = nl + 1
    }
}

private let FENCE = JSRegExp("^ {0,3}(`{3,}|~{3,}|\\$\\$)")
private let ATX = JSRegExp("^ {0,3}(#{1,6})(?:[ \\t]+|$)")
private let THEMATIC = JSRegExp("^ {0,3}([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$")
private let SETEXT = JSRegExp("^ {0,3}(=+|-+)[ \\t]*$")
private let HTML_BLOCK = JSRegExp("^ {0,3}<(?:!--|\\/?[A-Za-z][A-Za-z0-9-]*(?:[\\s/>]|$))")
private let LINK_DEF = JSRegExp("^ {0,3}\\[(?!\\^)[^\\]]+\\]:\\s*\\S")
private let FOOTNOTE_DEF = JSRegExp("^ {0,3}\\[\\^[^\\]\\s]+\\]:[ \\t]?")
private let LIST_ITEM = JSRegExp("^( {0,3})([-*+]|\\d{1,9}[.)])([ \\t]+|$)")
private let TASK = JSRegExp("^\\[[ xX]\\][ \\t]+")
private let QUOTE = JSRegExp("^ {0,3}>[ \\t]?")
private let ALERT = JSRegExp("^\\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\][ \\t]*$", ignoreCase: true)
private let TABLE_DELIMITER = JSRegExp("^ {0,3}\\|?[ \\t]*:?-+:?[ \\t]*(?:\\|[ \\t]*:?-+:?[ \\t]*)*\\|?[ \\t]*$")
private let LEADING_SPACE = JSRegExp("^[ \\t]*")
private let FOUR_SPACES = JSRegExp("^ {4,}")
private let INDENTED_CODE = JSRegExp("^( {4}|\\t)")
private let QUOTE_LINE = JSRegExp("^ {0,3}>")
private let FRONT_OPEN = JSRegExp("^(---|\\+\\+\\+)[ \\t]*$")
private let FRONT_CLOSE_DASH = JSRegExp("^(---|\\.\\.\\.)[ \\t]*$")
private let FRONT_CLOSE_PLUS = JSRegExp("^\\+\\+\\+[ \\t]*$")
private let MATH_CLOSE = JSRegExp("^\\s*\\$\\$\\s*$")
private let ATX_CLOSING = JSRegExp("(?:^|[ \\t]+)#+[ \\t]*$")
private let TRAILING_SPACE = JSRegExp("[ \\t]+$")
private let NON_SPACE = JSRegExp("\\S")

private func matchLength(_ re: JSRegExp, _ s: NSString) -> Int? { re.exec(s).map(\.range.length) }

/// `s.trim()` (JavaScript's white space).
private func jsTrim(_ s: NSString) -> NSString {
    var a = 0
    var b = s.length
    while a < b, isJSSpace(s.character(at: a)) { a += 1 }
    while b > a, isJSSpace(s.character(at: b - 1)) { b -= 1 }
    return s.substring(with: NSRange(location: a, length: b - a)) as NSString
}

/// Whether a UTF-16 unit is JavaScript white space or a line terminator.
func isJSSpace(_ c: unichar) -> Bool {
    switch c {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

private func hasText(_ s: NSString) -> Bool { jsTrim(s).length > 0 }

private struct Stripped {
    var contentFrom: Int
    var content: NSString
    var within: [MarkdownProseContainer]
    var startsItem: Bool
    var alertMarker: Bool
}

/// Reads where the prose is in `source` (see `markdownProseMap` in the TS core).
public func markdownProseMap(_ sourceText: String) -> MarkdownProseMap {
    let source = sourceText as NSString
    let lines = splitLines(source)
    var blocks: [MarkdownProseBlock] = []
    var prose: [MarkdownProseRange] = []
    var i = 0

    // Front matter
    if lines.count > 1 && FRONT_OPEN.test(lines[0].text) {
        let close = jsTrim(lines[0].text) == "---" ? FRONT_CLOSE_DASH : FRONT_CLOSE_PLUS
        for j in 1 ..< lines.count where close.test(lines[j].text) {
            blocks.append(MarkdownProseBlock(kind: .frontMatter, from: 0, to: lines[j].to, firstText: -1, within: []))
            i = j + 1
            break
        }
    }

    var openItem: (indent: Int, within: [MarkdownProseContainer])?
    var openAlert = false

    func strip(_ line: ProseLine) -> Stripped {
        var content = line.text
        var offset = line.from
        var within: [MarkdownProseContainer] = []
        var startsItem = false
        var alertMarker = false
        if let item = openItem, hasText(content) {
            let indent = matchLength(LEADING_SPACE, content) ?? 0
            let rest = content.substring(from: min(indent, item.indent)) as NSString
            let unindented: NSString = {
                if let m = FOUR_SPACES.exec(rest) { return rest.replacingCharacters(in: m.range, with: "") as NSString }
                return rest
            }()
            if indent >= item.indent && !LIST_ITEM.test(unindented) {
                within += item.within
                content = content.substring(from: item.indent) as NSString
                offset += item.indent
            } else if indent < item.indent {
                openItem = nil
            }
        }
        while true {
            if let quote = QUOTE.exec(content) {
                let rest = content.substring(from: quote.range.length) as NSString
                if ALERT.test(rest) {
                    openAlert = true
                    alertMarker = true
                }
                within.append(openAlert ? .alert : .quote)
                content = rest
                offset += quote.range.length
                continue
            }
            if let footnote = FOOTNOTE_DEF.exec(content) {
                within.append(.footnote)
                content = content.substring(from: footnote.range.length) as NSString
                offset += footnote.range.length
                startsItem = true
                openItem = (4, within)
                continue
            }
            if let item = LIST_ITEM.exec(content), !THEMATIC.test(content) {
                within.append(.listItem)
                let marker = item.range.length
                content = content.substring(from: marker) as NSString
                offset += marker
                if let task = TASK.exec(content) {
                    content = content.substring(from: task.range.length) as NSString
                    offset += task.range.length
                }
                startsItem = true
                openItem = (offset - line.from, within)
                continue
            }
            break
        }
        return Stripped(contentFrom: offset, content: content, within: within, startsItem: startsItem, alertMarker: alertMarker)
    }

    while i < lines.count {
        let line = lines[i]
        if !hasText(line.text) {
            if !QUOTE_LINE.test(line.text) { openAlert = false }
            i += 1
            continue
        }
        let s = strip(line)
        if !s.within.contains(.quote) && !s.within.contains(.alert) { openAlert = false }
        if s.alertMarker || !hasText(s.content) {
            i += 1
            continue
        }
        let content = s.content

        // Fenced code and display math
        if let fence = FENCE.exec(content) {
            let mark = content.substring(with: fence.range(at: 1))
            let markLength = (mark as NSString).length
            let closing = mark == "$$" ? MATH_CLOSE : JSRegExp("^\\s*\(mark.hasPrefix("`") ? "`" : "~"){\(markLength),}\\s*$")
            var j = i + 1
            let trimmed = jsTrim(content)
            let oneLine = mark == "$$" && trimmed.length > 2 && trimmed.hasSuffix("$$")
            if !oneLine {
                while j < lines.count && !closing.test(strip(lines[j]).content) { j += 1 }
            } else {
                j = i
            }
            let end = min(j, lines.count - 1)
            blocks.append(MarkdownProseBlock(kind: .code, from: line.from, to: lines[end].to, firstText: -1, within: s.within))
            i = end + 1
            continue
        }
        // Indented code (four spaces, outside a list item)
        if INDENTED_CODE.test(content) && !s.within.contains(.listItem) && !s.within.contains(.footnote) {
            var j = i
            while j + 1 < lines.count && (INDENTED_CODE.test(lines[j + 1].text) || !hasText(lines[j + 1].text)) { j += 1 }
            while j > i && !hasText(lines[j].text) { j -= 1 }
            blocks.append(MarkdownProseBlock(kind: .code, from: line.from, to: lines[j].to, firstText: -1, within: s.within))
            i = j + 1
            continue
        }
        if THEMATIC.test(content) {
            blocks.append(MarkdownProseBlock(kind: .thematicBreak, from: line.from, to: line.to, firstText: -1, within: s.within))
            i += 1
            continue
        }
        if HTML_BLOCK.test(content) {
            var j = i
            while j + 1 < lines.count && hasText(lines[j + 1].text) { j += 1 }
            blocks.append(MarkdownProseBlock(kind: .html, from: line.from, to: lines[j].to, firstText: -1, within: s.within))
            i = j + 1
            continue
        }
        if LINK_DEF.test(content) {
            blocks.append(MarkdownProseBlock(kind: .linkDefinition, from: line.from, to: line.to, firstText: -1, within: s.within))
            i += 1
            continue
        }
        if let atx = ATX.exec(content) {
            let textFrom = s.contentFrom + atx.range.length
            var text = content.substring(from: atx.range.length) as NSString
            if let closing = ATX_CLOSING.exec(text) { text = text.substring(to: closing.range.location) as NSString }
            if let trailing = TRAILING_SPACE.exec(text) { text = text.substring(to: trailing.range.location) as NSString }
            blocks.append(MarkdownProseBlock(kind: .heading, from: line.from, to: line.to, firstText: text.length > 0 ? textFrom : -1, within: s.within))
            if text.length > 0 { inlineProse(source, textFrom, textFrom + text.length, &prose) }
            i += 1
            continue
        }
        // A table: a row of cells, then a delimiter row
        // `strip` updates the open list item and alert, so it is called as often as in the TS.
        if content.contains("|") && i + 1 < lines.count && TABLE_DELIMITER.test(strip(lines[i + 1]).content) && strip(lines[i + 1]).content.contains("-") {
            var j = i + 1
            while j + 1 < lines.count && hasText(lines[j + 1].text) && strip(lines[j + 1]).content.contains("|") { j += 1 }
            blocks.append(MarkdownProseBlock(kind: .table, from: line.from, to: lines[j].to, firstText: -1, within: s.within))
            i = j + 1
            continue
        }
        // A paragraph: this line and the ones that continue it
        var parts: [MarkdownProseRange] = [MarkdownProseRange(from: s.contentFrom, to: line.to)]
        let within = s.within
        var j = i
        var heading = false
        while j + 1 < lines.count {
            let next = lines[j + 1]
            if !hasText(next.text) { break }
            let savedItem = openItem
            let savedAlert = openAlert
            let n = strip(next)
            let c = n.content
            if SETEXT.test(c) && n.within == within && !n.startsItem {
                heading = true
                j += 1
                break
            }
            let interrupts = n.startsItem || FENCE.test(c) || ATX.test(c) || THEMATIC.test(c) || HTML_BLOCK.test(c) || n.alertMarker || !hasText(c)
            if interrupts || (n.within != within && !n.within.isEmpty) {
                openItem = savedItem
                openAlert = savedAlert
                break
            }
            parts.append(MarkdownProseRange(from: n.contentFrom, to: next.to))
            j += 1
        }
        let firstText = s.contentFrom + (matchLength(LEADING_SPACE, content) ?? 0)
        blocks.append(MarkdownProseBlock(kind: heading ? .heading : .paragraph, from: line.from, to: lines[j].to, firstText: firstText, within: within))
        for part in parts { inlineProse(source, part.from, part.to, &prose) }
        i = j + 1
    }
    return MarkdownProseMap(blocks: blocks, prose: prose)
}

private let INLINE_TAG = JSRegExp("^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\\s<>]*|[^\\s<>@]+@[^\\s<>]+|\\/?[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*)?\\/?|!--[\\s\\S]*?--)>")
private let INLINE_IMAGE = JSRegExp("^!\\[[^\\]]*\\](?:\\([^)]*\\)|\\[[^\\]]*\\])?")
private let INLINE_FOOTNOTE = JSRegExp("^\\[\\^[^\\]\\s]+\\]")
private let INLINE_DEST = JSRegExp("^\\](\\([^)]*\\)|\\[[^\\]]*\\])")

private func unit(_ s: String) -> unichar { s.utf16.first! }
private let BACKSLASH = unit("\\"), BACKTICK = unit("`"), DOLLAR = unit("$"), SPACE = unit(" "), LT = unit("<"), BANG = unit("!"), OPEN = unit("["), CLOSE = unit("]")

private func isDigit(_ c: unichar?) -> Bool { c.map { $0 >= 48 && $0 <= 57 } ?? false }

/// The prose ranges of the inline text in `from..to` of `source` (`inlineProse` in the TS core).
private func inlineProse(_ source: NSString, _ from: Int, _ to: Int, _ out: inout [MarkdownProseRange]) {
    var skip: [MarkdownProseRange] = []
    let text = source.substring(with: NSRange(location: from, length: to - from)) as NSString
    let n = text.length
    func at(_ k: Int) -> unichar? { k >= 0 && k < n ? text.character(at: k) : nil }
    var k = 0
    while k < n {
        let c = text.character(at: k)
        if c == BACKSLASH {
            k += 2
            continue
        }
        if c == BACKTICK {
            var run = 1
            while at(k + run) == BACKTICK { run += 1 }
            let fence = String(repeating: "`", count: run)
            let close = k + run <= n ? text.range(of: fence, options: [.literal], range: NSRange(location: k + run, length: n - k - run)).location : NSNotFound
            if close != NSNotFound && at(close + run) != BACKTICK {
                skip.append(MarkdownProseRange(from: k, to: close + run))
                k = close + run
                continue
            }
            k += run
            continue
        }
        if c == DOLLAR && at(k + 1) != DOLLAR && at(k + 1) != SPACE && at(k + 1) != nil {
            var close = k + 1
            while close < n && !(text.character(at: close) == DOLLAR && text.character(at: close - 1) != SPACE && text.character(at: close - 1) != BACKSLASH) { close += 1 }
            if close < n && !isDigit(at(close + 1)) {
                skip.append(MarkdownProseRange(from: k, to: close + 1))
                k = close + 1
                continue
            }
        }
        if c == LT, let tag = INLINE_TAG.exec(text, from: k) {
            skip.append(MarkdownProseRange(from: k, to: k + tag.range.length))
            k += tag.range.length
            continue
        }
        if c == BANG && at(k + 1) == OPEN, let image = INLINE_IMAGE.exec(text, from: k) {
            skip.append(MarkdownProseRange(from: k, to: k + image.range.length))
            k += image.range.length
            continue
        }
        if c == OPEN, let footnote = INLINE_FOOTNOTE.exec(text, from: k) {
            skip.append(MarkdownProseRange(from: k, to: k + footnote.range.length))
            k += footnote.range.length
            continue
        }
        if c == CLOSE, let dest = INLINE_DEST.exec(text, from: k) {
            skip.append(MarkdownProseRange(from: k + 1, to: k + dest.range.length))
            k += dest.range.length
            continue
        }
        k += 1
    }
    var cursor = 0
    for s in skip {
        if s.from > cursor { out.append(MarkdownProseRange(from: from + cursor, to: from + s.from)) }
        cursor = max(cursor, s.to)
    }
    if cursor < n { out.append(MarkdownProseRange(from: from + cursor, to: to)) }
}
