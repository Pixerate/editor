import Foundation

// The Markdown reader for house style (#890), a port of `markdownStyleState`,
// `narrowMarkdownStyleTarget`, `markdownStyleEdits` and `applyMarkdownStyleEdits`
// (packages/core/src/tools/markdown-style.ts) and `richTextBlockPos` (richTextStyle.ts). Strings
// are handled as UTF-16 code units, as the TS indexes them, so blocks, offsets and fixes match
// the `domains/markdown-style` contract exactly.

/// Stands in for an inline atom that is not prose (a code span, math, an image, inline HTML).
public let MARKDOWN_STYLE_ATOM = "\u{FFFC}"

/// A text block of `RichTextStyleState`: a heading, paragraph, list item, quote or other.
public struct RichTextStyleBlock: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case heading, paragraph, listItem, quote, code, other
    }

    /// Where a piece of the block's text starts: its offset in `text` and its source position.
    public struct Segment: Equatable, Sendable {
        public var offset: Int
        public var pos: Int
        public var length: Int
    }

    public var kind: Kind
    /// Heading level (1–6).
    public var level: Int?
    /// The block's plain text.
    public var text: String
    /// Source positions of the block's content.
    public var from: Int
    public var to: Int
    public var segments: [Segment]

    /// `text` as UTF-16 code units.
    public var units: [UInt16] { Array(text.utf16) }
}

/// A finding's target: the source range to change, and the text to put there when the fix is certain.
public struct RichTextStyleTarget: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public var replacement: String?

    public init(from: Int, to: Int, replacement: String? = nil) {
        self.from = from
        self.to = to
        self.replacement = replacement
    }
}

/// A source edit: replace `from..to` (UTF-16 offsets) with `replacement`.
public struct MarkdownStyleEdit: Equatable, Sendable {
    public var from: Int
    public var to: Int
    public var replacement: String

    public init(from: Int, to: Int, replacement: String) {
        self.from = from
        self.to = to
        self.replacement = replacement
    }
}

private func u(_ s: String) -> UInt16 { s.utf16.first! }
private let BACKSLASH = u("\\"), STAR = u("*"), UNDERSCORE = u("_"), TILDE = u("~"), OPEN = u("["), CLOSE = u("]"), PAREN = u("("), NEWLINE = u("\n")

/// JavaScript `/\s/` on one code unit (`undefined` counts as space, as `isSpace` in the TS).
private func isSpaceUnit(_ c: UInt16?) -> Bool { c.map(isJSSpace) ?? true }

/// `/[\p{L}\p{N}]/u` on one code unit (a lone surrogate is neither).
func isWordUnit(_ c: UInt16?) -> Bool {
    guard let c, let scalar = Unicode.Scalar(c) else { return false }
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: return true
    default: return false
    }
}

/// `/[!-/:-@[-`{-~]/`: ASCII punctuation.
private func isAsciiPunctuation(_ c: UInt16) -> Bool {
    (c >= 0x21 && c <= 0x2F) || (c >= 0x3A && c <= 0x40) || (c >= 0x5B && c <= 0x60) || (c >= 0x7B && c <= 0x7E)
}

private func plainPieces(_ source: [UInt16], _ ranges: [MarkdownProseRange]) -> [MarkdownProseRange] {
    func at(_ k: Int) -> UInt16? { k >= 0 && k < source.count ? source[k] : nil }
    var markup = Set<Int>()
    var opens: [Int] = []
    for r in ranges {
        var k = r.from
        while k < r.to {
            let c = source[k]
            if c == BACKSLASH && k + 1 < r.to && isAsciiPunctuation(source[k + 1]) {
                markup.insert(k)
                k += 2
                continue
            }
            if c == STAR || c == UNDERSCORE || c == TILDE {
                var end = k
                while end < r.to && source[end] == c { end += 1 }
                let before = at(k - 1)
                let after = at(end)
                let delimiter = !(isSpaceUnit(before) && isSpaceUnit(after)) && !(c == UNDERSCORE && isWordUnit(before) && isWordUnit(after)) && !(c == TILDE && end - k != 2)
                if delimiter { for m in k ..< end { markup.insert(m) } }
                k = end
                continue
            }
            if c == OPEN { opens.append(k) }
            else if c == CLOSE && (at(k + 1) == PAREN || at(k + 1) == OPEN) && !opens.isEmpty {
                markup.insert(opens.removeLast())
                markup.insert(k)
            }
            k += 1
        }
    }
    var pieces: [MarkdownProseRange] = []
    for r in ranges {
        var start = r.from
        var k = r.from
        while k <= r.to {
            if k == r.to || markup.contains(k) {
                if k > start { pieces.append(MarkdownProseRange(from: start, to: k)) }
                start = k + 1
            }
            k += 1
        }
    }
    return pieces
}

private let SETEXT_UNDERLINE_PREFIX = JSRegExp("^[ \\t>]*")
private let ALL_EQUALS = JSRegExp("^=+$")
private let ALL_DASHES = JSRegExp("^-+$")
private let HEADING_ATX = JSRegExp("^(?:[ \\t]*(?:>[ \\t]?|[-*+][ \\t]+|\\d{1,9}[.)][ \\t]+))*[ \\t]{0,3}(#{1,6})(?:[ \\t]|$)")
private let HEADING_CLOSING = JSRegExp("(?:^|[ \\t]+)#+[ \\t]*$")
private let SYNTAX_ONLY = JSRegExp("^[\\s>*+\\-_~\\\\[\\]]*(?:\\((?:[^()\\n]|\\([^()\\n]*\\))*\\)|\\[[^\\]\\n]*\\])?[\\s*_~\\\\[\\]]*$")

private func slice(_ s: [UInt16], _ from: Int, _ to: Int) -> String { String(decoding: s[max(0, from) ..< max(from, min(to, s.count))], as: UTF16.self) }

private func headingLevel(_ source: [UInt16], _ block: MarkdownProseBlock) -> Int {
    let text = slice(source, block.from, block.to)
    let lines = text.components(separatedBy: "\n")
    if lines.count > 1 {
        let last = lines[lines.count - 1] as NSString
        let prefix = SETEXT_UNDERLINE_PREFIX.exec(last)?.range.length ?? 0
        let underline = trimJS(last.substring(from: prefix)) as NSString
        if ALL_EQUALS.test(underline) { return 1 }
        if ALL_DASHES.test(underline) { return 2 }
    }
    let ns = text as NSString
    guard let atx = HEADING_ATX.exec(ns) else { return 1 }
    return atx.range(at: 1).length
}

private func trimJS(_ s: String) -> String {
    let units = Array(s.utf16)
    var a = 0
    var b = units.count
    while a < b && isJSSpace(units[a]) { a += 1 }
    while b > a && isJSSpace(units[b - 1]) { b -= 1 }
    return String(decoding: units[a ..< b], as: UTF16.self)
}

private func endOfHeadingText(_ source: [UInt16], _ block: MarkdownProseBlock) -> Int {
    let line = slice(source, block.from, block.to)
    // A setext heading's text ends before its underline.
    if let nl = Array(line.utf16).lastIndex(of: NEWLINE) { return block.from + nl }
    guard let closing = HEADING_CLOSING.exec(line as NSString) else { return block.to }
    return block.from + closing.range.location
}

private func gapText(_ gap: [UInt16], between: Bool) -> String {
    if gap.isEmpty { return "" }
    if between && gap.contains(NEWLINE) { return " " }
    if SYNTAX_ONLY.test(String(decoding: gap, as: UTF16.self) as NSString) { return "" }
    return MARKDOWN_STYLE_ATOM
}

private func kindOf(_ block: MarkdownProseBlock) -> RichTextStyleBlock.Kind {
    if block.kind == .heading { return .heading }
    switch block.within.last {
    case .listItem?: return .listItem
    case .quote?, .alert?: return .quote
    case .footnote?: return .other
    default: return .paragraph
    }
}

/// The text blocks of Markdown `source` for the house-style checks (see `markdownStyleState` in
/// the TS core). Code, math, HTML, tables, front matter and link definitions are not read.
public func markdownStyleState(_ sourceText: String, map: MarkdownProseMap? = nil) -> [RichTextStyleBlock] {
    let map = map ?? markdownProseMap(sourceText)
    let source = Array(sourceText.utf16)
    var blocks: [RichTextStyleBlock] = []
    var p = 0
    for block in map.blocks {
        guard block.kind == .heading || block.kind == .paragraph else { continue }
        while p < map.prose.count && map.prose[p].to <= block.from && map.prose[p].from < block.from { p += 1 }
        var ranges: [MarkdownProseRange] = []
        while p < map.prose.count && map.prose[p].from <= block.to {
            if map.prose[p].to > map.prose[p].from { ranges.append(map.prose[p]) }
            p += 1
        }
        let pieces = plainPieces(source, ranges)
        let contentFrom = block.firstText >= 0 ? block.firstText : block.from
        var contentTo = block.kind == .heading ? (pieces.isEmpty ? block.to : max(pieces[pieces.count - 1].to, endOfHeadingText(source, block))) : block.to
        while contentTo > contentFrom && isJSSpace(source[contentTo - 1]) { contentTo -= 1 }
        var text: [UInt16] = []
        var segments: [RichTextStyleBlock.Segment] = []
        var prevEnd = contentFrom
        for piece in pieces {
            text += Array(gapText(Array(source[min(prevEnd, piece.from) ..< piece.from]), between: !segments.isEmpty).utf16)
            segments.append(RichTextStyleBlock.Segment(offset: text.count, pos: piece.from, length: piece.to - piece.from))
            text += source[piece.from ..< piece.to]
            prevEnd = piece.to
        }
        if !segments.isEmpty && contentTo > prevEnd { text += Array(gapText(Array(source[prevEnd ..< contentTo]), between: false).utf16) }
        let kind = kindOf(block)
        let from = segments.first?.pos ?? (block.firstText >= 0 ? block.firstText : block.from)
        let textEnd = segments.last.map { $0.pos + $0.length } ?? from
        blocks.append(RichTextStyleBlock(
            kind: kind,
            level: kind == .heading ? headingLevel(source, block) : nil,
            text: String(decoding: text, as: UTF16.self),
            from: from,
            to: max(textEnd, contentTo),
            segments: segments
        ))
    }
    return blocks
}

/**
 * The source position of character `offset` of a block's text (`richTextBlockPos`). Where two
 * segments meet, a range's start maps to the later segment and its end (`end`) to the earlier.
 */
public func richTextBlockPos(_ block: RichTextStyleBlock, _ offset: Int, end: Bool = false) -> Int {
    var seg = block.segments.first
    for s in block.segments where (end && offset > 0 ? s.offset < offset : s.offset <= offset) { seg = s }
    guard let seg else { return block.from }
    // Before the first segment (an atom the reader put there) is the first text's start.
    return seg.pos + max(0, offset - seg.offset)
}

/// `targetOf`: the source target of characters `start..<end` of a block's text.
public func richTextStyleTarget(_ block: RichTextStyleBlock, _ start: Int, _ end: Int, replacement: String? = nil) -> RichTextStyleTarget {
    RichTextStyleTarget(from: richTextBlockPos(block, start), to: richTextBlockPos(block, end, end: end > start), replacement: replacement)
}

/**
 * Narrows a certain fix to the whole words it changes, keeping the syntax around and inside the
 * text; a fix that would have to change syntax loses its replacement (`narrowMarkdownStyleTarget`).
 */
public func narrowMarkdownStyleTarget(_ sourceText: String, _ blocks: [RichTextStyleBlock], _ input: RichTextStyleTarget) -> RichTextStyleTarget {
    var target = input
    guard let block = blocks.first(where: { $0.from <= target.from && target.from <= $0.to && !$0.segments.isEmpty }) else { return target }
    let lastSeg = block.segments[block.segments.count - 1]
    let textEnd = lastSeg.pos + lastSeg.length
    if target.from == target.to {
        if target.from >= textEnd { target.from = block.to; target.to = block.to }
        return target
    }
    if target.to > textEnd { target.to = block.to }
    guard let replacement = target.replacement else { return target }
    let source = Array(sourceText.utf16)
    let text = block.units
    var chars: [(ch: UInt16, pos: Int?)] = []
    var seg = 0
    for i in 0 ..< text.count {
        while seg < block.segments.count && block.segments[seg].offset + block.segments[seg].length <= i { seg += 1 }
        let s = seg < block.segments.count ? block.segments[seg] : nil
        chars.append((text[i], s.flatMap { $0.offset <= i ? $0.pos + (i - $0.offset) : nil }))
    }
    // A target from the block's start or to its end takes in the spaces and atoms the reader put there.
    let firstIndex = target.from <= block.segments[0].pos ? 0 : chars.firstIndex(where: { $0.pos != nil && $0.pos! >= target.from })
    let lastIndex = target.to >= textEnd ? chars.count - 1 : chars.lastIndex(where: { $0.pos != nil && $0.pos! < target.to })
    guard let first = firstIndex, let last = lastIndex, last >= first else { return target }
    let picked = Array(chars[first ... last])
    let original = picked.map(\.ch)
    let want = Array(replacement.utf16)
    func o(_ i: Int) -> UInt16? { i >= 0 && i < original.count ? original[i] : nil }
    func w(_ i: Int) -> UInt16? { i >= 0 && i < want.count ? want[i] : nil }
    var pre = 0
    while pre < original.count && pre < want.count && original[pre] == want[pre] { pre += 1 }
    var suf = 0
    while suf < original.count - pre && suf < want.count - pre && original[original.count - 1 - suf] == want[want.count - 1 - suf] { suf += 1 }
    while pre > 0 && isWordUnit(o(pre - 1)) && (isWordUnit(o(pre)) || isWordUnit(w(pre))) { pre -= 1 }
    while suf > 0 && isWordUnit(o(original.count - suf)) && (isWordUnit(o(original.count - suf - 1)) || isWordUnit(w(want.count - suf - 1))) { suf -= 1 }
    let middle = Array(picked[pre ..< picked.count - suf])
    let insertUnits = Array(want[pre ..< want.count - suf])
    let insert = String(decoding: insertUnits, as: UTF16.self)
    let uncertain = RichTextStyleTarget(from: target.from, to: target.to)
    if middle.isEmpty {
        if pre < picked.count, let pos = picked[pre].pos { return RichTextStyleTarget(from: pos, to: pos, replacement: insert) }
        if pre > 0, let pos = picked[pre - 1].pos { return RichTextStyleTarget(from: pos + 1, to: pos + 1, replacement: insert) }
        return uncertain
    }
    if middle.contains(where: { $0.pos == nil }) {
        if middle.count != insertUnits.count || middle.enumerated().contains(where: { i, c in c.pos == nil && insertUnits[i] != c.ch }) { return uncertain }
    }
    let real = middle.compactMap { c in c.pos.map { (ch: c.ch, pos: $0) } }
    if real.isEmpty { return uncertain }
    let from = real[0].pos
    let to = real[real.count - 1].pos + 1
    let contiguous = real.count == middle.count && real.indices.allSatisfy { $0 == 0 || real[$0].pos == real[$0 - 1].pos + 1 }
    if contiguous { return RichTextStyleTarget(from: from, to: to, replacement: insert) }
    if middle.count != insertUnits.count { return uncertain }
    var byPos: [Int: UInt16] = [:]
    for (i, c) in middle.enumerated() { if let pos = c.pos { byPos[pos] = insertUnits[i] } }
    var out: [UInt16] = []
    for k in from ..< to { out.append(byPos[k] ?? source[k]) }
    return RichTextStyleTarget(from: from, to: to, replacement: String(decoding: out, as: UTF16.self))
}

/// The certain fixes of `targets` as non-overlapping edits in order, and how many overlapped
/// (`markdownStyleEdits`).
public func markdownStyleEdits(_ targets: [RichTextStyleTarget?]) -> (edits: [MarkdownStyleEdit], overlapping: Int) {
    let certain = targets.compactMap { t -> MarkdownStyleEdit? in
        guard let t, let r = t.replacement else { return nil }
        return MarkdownStyleEdit(from: t.from, to: t.to, replacement: r)
    }.enumerated().sorted { a, b in a.element.from != b.element.from ? a.element.from < b.element.from : a.element.to != b.element.to ? a.element.to < b.element.to : a.offset < b.offset }.map(\.element)
    var edits: [MarkdownStyleEdit] = []
    var overlapping = 0
    var end = -1
    for t in certain {
        // Two insertions at one place would land in an unknown order; an insertion right after a replacement is fine.
        if t.from < end || (t.from == t.to && edits.last.map { $0.from == $0.to && $0.from == t.from } == true) {
            overlapping += 1
            continue
        }
        edits.append(t)
        end = t.to
    }
    return (edits, overlapping)
}

/// Applies non-overlapping edits (in any order) to `source` (`applyMarkdownStyleEdits`).
public func applyMarkdownStyleEdits(_ source: String, _ edits: [MarkdownStyleEdit]) -> String {
    var out = Array(source.utf16)
    for e in edits.enumerated().sorted(by: { a, b in a.element.from != b.element.from ? a.element.from > b.element.from : a.offset < b.offset }).map(\.element) {
        out.replaceSubrange(e.from ..< e.to, with: Array(e.replacement.utf16))
    }
    return String(decoding: out, as: UTF16.self)
}
