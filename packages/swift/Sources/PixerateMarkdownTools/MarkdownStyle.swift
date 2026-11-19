// House style for Markdown text (#890), a port of the `rich-text` domain (`richTextStyle.ts`:
// the profile, `heading-case`, `heading-levels`, `list-punctuation`, `quotes`, `terms`,
// `number-format`, `date-format`), `applyTextCase` (`tools/text-case.ts`) and `checkMarkdownStyle`
// / `createMarkdownStyleToolProvider` (`tools/markdown-style.ts`). Messages and results are the TS
// core's word for word; the blocks come from PixerateMarkdown's `markdownStyleState`, and
// `domains/markdown-style` in `@pixerate/conformance` checks both against the TS.

import Foundation
import PixerateCore
import PixerateMarkdown
import PixerateRaster

// MARK: - UTF-16 helpers

private func units(_ s: String) -> [UInt16] { Array(s.utf16) }
private func string(_ u: some Collection<UInt16>) -> String { String(decoding: Array(u), as: UTF16.self) }

/// `/[\p{L}\p{N}]/u` on one code unit.
private func isWordUnit(_ c: UInt16?) -> Bool {
    guard let c, let scalar = Unicode.Scalar(c) else { return false }
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: return true
    default: return false
    }
}

/// `String.prototype.toUpperCase` (Swift's full mapping matches it).
private func jsUpper(_ s: String) -> String { s.uppercased() }

/// `s.charAt(0).toUpperCase() + s.slice(1)`, by UTF-16 unit.
private func capitalised(_ s: String) -> String {
    let u = units(s)
    guard let first = u.first else { return s }
    return jsUpper(string([first])) + string(u.dropFirst())
}

/// `quote`: the text in double quotes, cut to 60 UTF-16 units.
private func quoted(_ text: String) -> String {
    let u = units(text)
    return "\"\(u.count > 60 ? string(u.prefix(57)) + "..." : text)\""
}

// MARK: - Text case

private let SMALL_WORDS: Set<String> = ["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor", "of", "on", "or", "over", "per", "so", "the", "to", "up", "via", "vs", "with", "yet"]
private let HAS_LETTER = JSRegExp("\\p{L}")
private let HAS_DIGIT = JSRegExp("\\d")
private let LOWER_THEN_UPPER_START = JSRegExp("^\\p{Ll}+\\p{Lu}")
private let LOWER_UPPER = JSRegExp("\\p{Ll}\\p{Lu}")
private let ENDS_SENTENCE = JSRegExp("[:.!?]$")

private func isLetterOrNumber(_ s: Unicode.Scalar) -> Bool {
    switch s.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: return true
    default: return false
    }
}

/// `w.replace(bare, with)`: the first occurrence only.
private func replaceFirst(_ w: String, _ bare: String, _ with: String) -> String {
    let ns = w as NSString
    let r = ns.range(of: bare, options: [.literal])
    return r.location == NSNotFound ? w : ns.replacingCharacters(in: r, with: with)
}

/// `text` in `kind` case (`sentence`, `title` or `upper`), keeping acronyms, words with digits or
/// inner capitals, and `properNouns` (`applyTextCase`).
public func applyTextCase(_ text: String, _ kind: String, properNouns: [String] = []) -> String {
    if kind == "upper" { return jsUpper(text) }
    var nouns: [String: String] = [:]
    for n in properNouns { nouns[n.jsLowercased] = n }
    // `text.split(/(\s+)/)`: words and the runs of space between them.
    var words: [String] = []
    var current: [UInt16] = []
    var inSpace = false
    for c in text.utf16 {
        let space = isJSWhitespaceUnit(c)
        if space != inSpace {
            words.append(string(current))
            current = []
            inSpace = space
        }
        current.append(c)
    }
    words.append(string(current))
    // A leading run of space yields "" first, as split does; a text without one starts with a word.
    let isWord = words.map { w in w.utf16.contains { !isJSWhitespaceUnit($0) } }
    let wordIndexes = isWord.indices.filter { isWord[$0] }
    let first = wordIndexes.first
    let last = wordIndexes.last
    var afterColon = false
    var out = ""
    for (i, w) in words.enumerated() {
        guard isWord[i] else { out += w; continue }
        let startsSentence = i == first || afterColon
        afterColon = ENDS_SENTENCE.test(w)
        var scalars = Array(w.unicodeScalars)
        while let s = scalars.first, !isLetterOrNumber(s) { scalars.removeFirst() }
        while let s = scalars.last, !isLetterOrNumber(s) { scalars.removeLast() }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars)
        let bare = String(view)
        let lower = bare.jsLowercased
        if bare.isEmpty { out += w; continue }
        if let noun = nouns[lower] { out += replaceFirst(w, bare, noun); continue }
        let bareUnits = units(bare)
        if (bareUnits.count > 1 && bare == jsUpper(bare) && HAS_LETTER.test(bare)) || HAS_DIGIT.test(bare) || LOWER_THEN_UPPER_START.test(bare) || LOWER_UPPER.test(string(bareUnits.dropFirst())) {
            out += w
            continue
        }
        if kind == "sentence" {
            out += replaceFirst(w, bare, startsSentence ? capitalised(lower) : lower)
            continue
        }
        let small = SMALL_WORDS.contains(lower) && i != first && i != last && !startsSentence
        out += replaceFirst(w, bare, small ? lower : capitalised(bare))
    }
    return out
}

private func isJWS(_ c: UInt16) -> Bool {
    switch c {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}
private func isJSWhitespaceUnit(_ c: UInt16) -> Bool { isJWS(c) }

// MARK: - The rich-text profile and checks

/// `richTextStyleDomain.profileSchema` (descriptions left out: validation does not read them).
public let RICH_TEXT_STYLE_PROFILE_SCHEMA: JSONValue = try! JSONValue.parse("""
{"type":"object","properties":{
"headingCase":{"type":"string","enum":["sentence","title","upper"]},
"maxHeadingLevel":{"type":"integer","minimum":1,"maximum":6},
"properNouns":{"type":"array","items":{"type":"string","minLength":1}},
"listItemEnd":{"type":"string","enum":["none","period"]},
"quotes":{"type":"string","enum":["curly","straight"]},
"terms":{"type":"array","items":{"type":"object","properties":{"avoid":{"type":"string","minLength":1},"use":{"type":"string"},"note":{"type":"string"}},"required":["avoid"],"additionalProperties":false}},
"thousandsSeparator":{"type":"string","enum":[",","."," ","thin","none"]},
"dateFormat":{"type":"string","enum":["iso","day-month-year","month-day-year"]},
"fonts":{"type":"array","items":{"type":"string","minLength":1}},
"palette":{"type":"array","items":{"type":"string","minLength":1}}
},"additionalProperties":false}
""")

private let MAX_PER_CHECK = 200

private func target(_ t: RichTextStyleTarget) -> JSONValue {
    var obj = JSONObject([("from", .number(Double(t.from))), ("to", .number(Double(t.to)))])
    if let r = t.replacement { obj["replacement"] = .string(r) }
    return .object(obj)
}

private func draft(_ severity: String, _ message: String, _ t: RichTextStyleTarget) -> StyleFindingDraft {
    StyleFindingDraft(severity: severity, message: message, target: target(t))
}

private func prose(_ blocks: [RichTextStyleBlock]) -> [RichTextStyleBlock] { blocks.filter { $0.kind != .code } }

private func strings(_ v: JSONValue?) -> [String] { v?.arrayValue?.compactMap(\.stringValue) ?? [] }

private func escapeRegex(_ s: String) -> String {
    var out = ""
    for ch in s {
        if ".*+?^${}()|[]\\".contains(ch) { out += "\\" }
        out.append(ch)
    }
    return out
}

private let MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
private let MONTH = "(\(MONTHS.joined(separator: "|"))|\(MONTHS.map { String($0.prefix(3)) }.joined(separator: "|")))\\.?"
private func monthIndex(_ name: String) -> Int {
    MONTHS.firstIndex { $0.prefix(3).lowercased() == name.prefix(3).lowercased() } ?? -1
}

private let LIST_PERIOD_END = JSRegExp("[^.]\\.$")
private let LIST_ANY_END = JSRegExp("[.!?:…]$")
private let SEPARATORS: [String: String] = [",": ",", ".": ".", " ": " ", "thin": "\u{202F}", "none": ""]
private let NUMBER = JSRegExp("(?<![\\d.,\u{202F}])(\\d{1,3}(?:([,. \u{202F}])\\d{3})+|\\d{5,})(?![\\d]|[.,]\\d)")
private let DATE_PATTERNS: [(re: JSRegExp, kind: String)] = [
    (JSRegExp("\\b(\\d{4})-(\\d{2})-(\\d{2})\\b"), "iso"),
    (JSRegExp("\\b(\\d{1,2}) \(MONTH) (\\d{4})\\b", ignoreCase: true), "day-month-year"),
    (JSRegExp("\\b\(MONTH) (\\d{1,2}),? (\\d{4})\\b", ignoreCase: true), "month-day-year"),
    (JSRegExp("\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b"), "numeric"),
]

/// `group`: thousands separated by `sep`.
private func groupDigits(_ digits: String, _ sep: String) -> String {
    let u = Array(digits)
    var out = ""
    for (i, ch) in u.enumerated() {
        if i > 0 && (u.count - i) % 3 == 0 { out += sep }
        out.append(ch)
    }
    return out
}

/// The `rich-text` domain's own checks on `blocks`.
public func richTextStyleChecks(_ blocks: [RichTextStyleBlock]) -> [StyleCheckDefinition] {
    let headingCase = StyleCheckDefinition(id: "heading-case") { profile, _, _ in
        guard let kind = profile["headingCase"]?.stringValue else { throw StyleCheckError("the profile has no \"headingCase\".") }
        let nouns = strings(profile["properNouns"])
        return blocks.filter { $0.kind == .heading && !$0.text.jsTrimmed.isEmpty }.compactMap { b in
            let want = applyTextCase(b.text, kind, properNouns: nouns)
            if want == b.text { return nil }
            return draft("warning", "Heading \(quoted(b.text)) is not in \(kind) case; write \(quoted(want)).", richTextStyleTarget(b, 0, b.text.utf16.count, replacement: want))
        }
    }
    let headingLevels = StyleCheckDefinition(id: "heading-levels") { profile, _, _ in
        let max = profile["maxHeadingLevel"]?.numberValue.map { Int($0) } ?? 6
        var out: [StyleFindingDraft] = []
        var prev = 0
        for b in blocks {
            guard b.kind == .heading, let level = b.level else { continue }
            let all = richTextStyleTarget(b, 0, b.text.utf16.count)
            if level > max {
                out.append(draft("warning", "Heading \(quoted(b.text)) is level \(level); the house style goes to level \(max). Promote it or make it bold text.", all))
            } else if level > prev + 1 {
                out.append(draft("warning", "Heading \(quoted(b.text)) is level \(level) after \(prev > 0 ? "level \(prev)" : "no heading"); use level \(prev + 1) so no level is skipped.", all))
            }
            prev = level
        }
        return out
    }
    let listItemEnd = StyleCheckDefinition(id: "list-punctuation") { profile, _, _ in
        guard let end = profile["listItemEnd"]?.stringValue else { throw StyleCheckError("the profile has no \"listItemEnd\".") }
        var out: [StyleFindingDraft] = []
        for b in blocks where b.kind == .listItem {
            var u = b.units
            while let c = u.last, isJWS(c) { u.removeLast() }
            if u.isEmpty { continue }
            let trimmed = string(u)
            let last = u.count
            if end == "none" && LIST_PERIOD_END.test(trimmed) {
                out.append(draft("info", "List item \(quoted(trimmed)) ends with a full stop; house list items have none.", richTextStyleTarget(b, last - 1, last, replacement: "")))
            }
            if end == "period" && !LIST_ANY_END.test(trimmed) {
                out.append(draft("info", "List item \(quoted(trimmed)) has no full stop; house list items end with one.", richTextStyleTarget(b, last, last, replacement: ".")))
            }
        }
        return out
    }
    let quotes = StyleCheckDefinition(id: "quotes") { profile, _, _ in
        guard let kind = profile["quotes"]?.stringValue else { throw StyleCheckError("the profile has no \"quotes\".") }
        let straight: Set<UInt16> = [0x22, 0x27]
        let curly: Set<UInt16> = [0x201C, 0x201D, 0x2018, 0x2019]
        var out: [StyleFindingDraft] = []
        for b in prose(blocks) {
            let u = b.units
            for (i, c) in u.enumerated() where (kind == "curly" ? straight : curly).contains(c) {
                if out.count >= MAX_PER_CHECK { return out }
                let before: UInt16? = i > 0 ? u[i - 1] : nil
                let want: String
                if kind == "straight" {
                    want = c == 0x201C || c == 0x201D ? "\"" : "'"
                } else if c == 0x27 {
                    want = isWordUnit(before) ? "’" : "‘"
                } else {
                    let opens = before.map { isJWS($0) || "([{—–-".utf16.contains($0) } ?? true
                    want = opens ? "“" : "”"
                }
                out.append(draft("info", "Use \(want) instead of \(string([c])) in \(quoted(b.text)).", richTextStyleTarget(b, i, i + 1, replacement: want)))
            }
        }
        return out
    }
    let terms = StyleCheckDefinition(id: "terms") { profile, _, _ in
        let list = profile["terms"]?.arrayValue?.compactMap(\.objectValue) ?? []
        if list.isEmpty { throw StyleCheckError("the profile has no \"terms\".") }
        var out: [StyleFindingDraft] = []
        for term in list {
            guard let avoid = term["avoid"]?.stringValue else { continue }
            let re = JSRegExp("(?<![\\p{L}\\p{N}])\(escapeRegex(avoid))(?![\\p{L}\\p{N}])", ignoreCase: true)
            for b in prose(blocks) {
                let ns = b.text as NSString
                for m in re.matches(ns) {
                    if out.count >= MAX_PER_CHECK { return out }
                    let found = ns.substring(with: m.range)
                    let f0 = string([found.utf16.first!])
                    let use: String? = term["use"]?.stringValue.map { u in f0 == jsUpper(f0) && f0 != f0.jsLowercased ? capitalised(u) : u }
                    let note = term["note"]?.stringValue ?? ""
                    let message = "Avoid \"\(found)\"\(use.map { "; write \"\($0)\"" } ?? "")\(note.isEmpty ? "" : " (\(note))")."
                    out.append(draft("warning", message, richTextStyleTarget(b, m.range.location, m.range.location + m.range.length, replacement: use)))
                }
            }
        }
        return out
    }
    let numbers = StyleCheckDefinition(id: "number-format") { profile, _, _ in
        guard let key = profile["thousandsSeparator"]?.stringValue, let sep = SEPARATORS[key] else { throw StyleCheckError("the profile has no \"thousandsSeparator\".") }
        var out: [StyleFindingDraft] = []
        for b in prose(blocks) {
            let ns = b.text as NSString
            for m in NUMBER.matches(ns) {
                if out.count >= MAX_PER_CHECK { return out }
                let r = m.range(at: 1)
                let found = ns.substring(with: r)
                let digits = String(found.filter { !",. \u{202F}".contains($0) })
                if digits.utf16.count < 5 { continue }
                let want = groupDigits(digits, sep)
                if want == found { continue }
                out.append(draft("info", "Write \(found) as \(want)\(key == "thin" ? " (thin spaces)" : "").", richTextStyleTarget(b, r.location, r.location + r.length, replacement: want)))
            }
        }
        return out
    }
    let dates = StyleCheckDefinition(id: "date-format") { profile, _, _ in
        guard let format = profile["dateFormat"]?.stringValue else { throw StyleCheckError("the profile has no \"dateFormat\".") }
        func write(_ y: Int, _ m: Int, _ d: Int) -> String {
            switch format {
            case "iso": return "\(y)-\(String(format: "%02d", m + 1))-\(String(format: "%02d", d))"
            case "day-month-year": return "\(d) \(MONTHS[m]) \(y)"
            default: return "\(MONTHS[m]) \(d), \(y)"
            }
        }
        var out: [StyleFindingDraft] = []
        for b in prose(blocks) {
            let ns = b.text as NSString
            for p in DATE_PATTERNS {
                for m in p.re.matches(ns) {
                    if out.count >= MAX_PER_CHECK { return out }
                    let whole = ns.substring(with: m.range)
                    let all = richTextStyleTarget(b, m.range.location, m.range.location + m.range.length)
                    func g(_ i: Int) -> String { JSRegExp.group(m, i, in: ns) ?? "" }
                    let read: (Int, Int, Int)?
                    switch p.kind {
                    case "iso": read = (Int(g(1)) ?? 0, (Int(g(2)) ?? 0) - 1, Int(g(3)) ?? 0)
                    case "day-month-year": read = (Int(g(3)) ?? 0, monthIndex(g(2)), Int(g(1)) ?? 0)
                    case "month-day-year": read = (Int(g(3)) ?? 0, monthIndex(g(1)), Int(g(2)) ?? 0)
                    default: read = nil
                    }
                    guard let (y, mo, d) = read else {
                        // `String.replace` with a string pattern: the first occurrence only.
                        let sample = write(2026, 10, 12) as NSString
                        let example = sample.replacingCharacters(in: sample.range(of: "2026"), with: "YYYY")
                        out.append(draft("warning", "\(whole) can be read as two different dates; write it as \(example)-style.", all))
                        continue
                    }
                    if mo < 0 || d < 1 || d > 31 { continue }
                    let want = write(y, mo, d)
                    if p.kind == format && want == whole { continue }
                    var t = all
                    t.replacement = want
                    out.append(draft("info", "Write \(whole) as \(want).", t))
                }
            }
        }
        return out
    }
    return [headingCase, headingLevels, listItemEnd, quotes, terms, numbers, dates]
}

/// `richTextStyleDomain.themeFromBrand`: the brand's fonts and palette.
public func richTextStyleFromBrand(_ brand: JSONObject) -> JSONObject {
    let fonts = brandFonts(brand)
    let palette = brandPalette(brand)
    var out = JSONObject()
    if !fonts.isEmpty { out["fonts"] = .array(fonts.map { .string($0) }) }
    if !palette.isEmpty { out["palette"] = .array(palette.map { .string($0) }) }
    return out
}

/// The option schemas a `rich-text.json` `checks` list is validated against (`styleChecksOf`).
public let RICH_TEXT_STYLE_CHECK_OPTIONS: [(id: String, schema: JSONValue)] = styleCheckOptionSchemas(richTextStyleChecks([]), surface: true)

/// The document house style for one `layer` holding one `skill` with an optional `rich-text.json`
/// and `brand.json`, as `createStyleResolver` resolves it with `richTextStyleDomain`.
public func richTextHouseStyle(skill: String = "house", layer: String = "org", profileJson: JSONValue?, brandJson: JSONValue?) -> HouseStyle {
    HouseStyle(
        domain: "rich-text",
        skill: skill,
        layer: layer,
        profileJson: profileJson,
        brandJson: brandJson,
        schema: RICH_TEXT_STYLE_PROFILE_SCHEMA,
        checks: RICH_TEXT_STYLE_CHECK_OPTIONS,
        themeFromBrand: richTextStyleFromBrand
    )
}

// MARK: - Markdown

/// Why the brand's colour and font checks are skipped on Markdown.
public let MARKDOWN_NO_SURFACE_REASON = "Markdown source has no fonts or colours, so there is nothing for this check to read."

private func targetOf(_ finding: JSONValue) -> RichTextStyleTarget? {
    guard let t = finding.objectValue?["target"]?.objectValue, let from = t["from"]?.numberValue, let to = t["to"]?.numberValue else { return nil }
    return RichTextStyleTarget(from: Int(from), to: Int(to), replacement: t["replacement"]?.stringValue)
}

/// `{ ...rest, target }`: the finding with its target replaced (moved to the end, as the TS spread does).
private func withTarget(_ finding: JSONValue, _ t: RichTextStyleTarget) -> JSONValue {
    var obj = finding.objectValue ?? JSONObject()
    obj["target"] = Optional<JSONValue>.none
    obj["target"] = target(t)
    return .object(obj)
}

/**
 * Runs the document house-style checks on Markdown `source` (`checkMarkdownStyle`): findings
 * target UTF-16 ranges of the source, each certain fix narrowed to the words it changes. The
 * brand's colour and font checks are reported as skipped. `checks` limits the findings.
 */
public func checkMarkdownStyle(_ source: String, _ style: HouseStyle, checks only: [String]? = nil) -> StyleCheckRun {
    let blocks = markdownStyleState(source)
    let run = runStyleChecks(domain: "rich-text", checks: richTextStyleChecks(blocks), surface: { StyleSurface(colors: [], fonts: []) }, style: style)
    let surface = Set(SHARED_STYLE_CHECK_IDS)
    var out = StyleCheckRun()
    out.findings = run.findings.compactMap { f in
        guard let id = f.objectValue?["check"]?.stringValue, !surface.contains(id), only == nil || only!.contains(id) else { return nil }
        guard let t = targetOf(f) else { return f }
        return withTarget(f, narrowMarkdownStyleTarget(source, blocks, t))
    }
    out.ran = run.ran.filter { !surface.contains($0) }
    out.skipped = run.skipped.map { s in
        guard let id = s.objectValue?["check"]?.stringValue, surface.contains(id) else { return s }
        return .object(JSONObject([("check", .string(id)), ("reason", .string(MARKDOWN_NO_SURFACE_REASON))]))
    } + run.ran.filter { surface.contains($0) }.map { .object(JSONObject([("check", .string($0)), ("reason", .string(MARKDOWN_NO_SURFACE_REASON))])) }
    return out
}

/// A house-style finding on Markdown without a resolver (`markdownStyleFindings` in the
/// contracts): the profile's checks in its `checks` order.
public struct MarkdownStyleFinding: Equatable, Sendable {
    public var check: String
    public var severity: String
    public var message: String
    public var target: RichTextStyleTarget?
}

/// Runs `profile`'s checks on `source` as `markdownStyleFindings` does: no layers, no brand.
public func markdownStyleFindings(_ source: String, profile: JSONObject) -> [MarkdownStyleFinding] {
    let blocks = markdownStyleState(source)
    let checks = richTextStyleChecks(blocks)
    var out: [MarkdownStyleFinding] = []
    for id in strings(profile["checks"]) {
        guard let check = checks.first(where: { $0.id == id }), let drafts = try? check.run(profile, JSONObject(), nil) else { continue }
        for d in drafts {
            let t = d.target.flatMap { targetOf(.object(JSONObject([("target", $0)]))) }
            out.append(MarkdownStyleFinding(check: id, severity: d.severity, message: d.message, target: t.map { narrowMarkdownStyleTarget(source, blocks, $0) }))
        }
    }
    return out
}

// MARK: - Tools

public struct MarkdownStyleToolOptions {
    /// Provider id (unique per registry). Default `markdown-style`.
    public var id: String
    /// Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `""` for bare names.
    public var namespace: String?

    public init(id: String = "markdown-style", namespace: String? = nil) {
        self.id = id
        self.namespace = namespace
    }
}

private func describeFinding(_ source: NSString, _ f: JSONValue) -> JSONValue {
    guard var obj = f.objectValue, let t = targetOf(f) else { return f }
    obj["text"] = .string(source.substring(with: NSRange(location: t.from, length: t.to - t.from)))
    return .object(obj)
}

/**
 * `check_rich_text_style` and, while the host can be edited, `fix_rich_text_style` for Markdown
 * text (`createMarkdownStyleToolProvider`): the document house-style tools, with positions as
 * UTF-16 offsets of the source.
 */
public func createMarkdownStyleToolProvider(_ host: MarkdownTextHost, _ style: HouseStyle, _ options: MarkdownStyleToolOptions = MarkdownStyleToolOptions()) -> AgentToolProvider {
    let check = AgentTool(
        name: "check_rich_text_style",
        title: "Check Markdown house style",
        description:
            "Checks the Markdown text against the house style (see get_style with domain \"rich-text\"): runs the checks its profile turns on (heading-case, heading-levels, list-punctuation, quotes, terms, number-format, date-format) on the prose only: code, math, HTML, tables, front matter, link addresses and syntax markers are never checked. Returns findings with a severity, a sentence saying how to fix it, a target {from, to} range of UTF-16 offsets into the source (with the replacement when the fix is certain), the text there and the layer that asked; the checks that ran and those skipped (the brand's colour and font checks always are: Markdown has none). fix_rich_text_style applies every certain fix at once.",
        inputSchema: ["type": "object", "properties": .object(JSONObject()), "additionalProperties": false],
        annotations: ToolAnnotations(title: "Check Markdown house style", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false),
        handler: { _, _ in
            let source = host.markdown
            let run = checkMarkdownStyle(source, style)
            var obj = JSONObject([
                ("findings", .array(run.findings.map { describeFinding(source as NSString, $0) })),
                ("ran", .array(run.ran.map { .string($0) })),
                ("skipped", .array(run.skipped)),
                ("ok", .bool(run.findings.isEmpty)),
                ("fixable", .number(Double(run.findings.filter { targetOf($0)?.replacement != nil }.count))),
            ])
            if !style.hasSkills { obj["note"] = "No house style applies to documents." }
            if !style.issues.isEmpty { obj["issues"] = .array(style.issues) }
            return .value(.object(obj))
        }
    )
    let fix = AgentTool(
        name: "fix_rich_text_style",
        title: "Fix Markdown house style",
        description:
            "Applies every house-style fix whose replacement is certain (heading case, list endings, quotation marks, terms with a replacement, number and date formats) to the Markdown text, as one undo step, keeping its syntax. Pass checks to limit it to some checks. Returns how many it fixed, the edits it made ({from, to, replacement} in the source before the fix) and the findings it left for you (no certain replacement: rephrase or restructure those yourself). Run check_rich_text_style again after.",
        inputSchema: [
            "type": "object",
            "properties": ["checks": ["type": "array", "items": ["type": "string", "minLength": 1], "minItems": 1, "description": "Only fix findings of these check ids (default: all)."]],
            "additionalProperties": false,
        ],
        annotations: ToolAnnotations(title: "Fix Markdown house style", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false),
        handler: { args, _ in
            if let reason = host.readOnlyReason { throw MarkdownToolError(reason.isEmpty ? "The text is read-only, so its house style cannot be fixed." : reason) }
            let only = args["checks"]?.arrayValue?.compactMap(\.stringValue)
            let source = host.markdown
            let run = checkMarkdownStyle(source, style, checks: only)
            let (edits, overlapping) = markdownStyleEdits(run.findings.map(targetOf))
            if !edits.isEmpty {
                let textEdits = edits.map { MarkdownTextEdit(range: NSRange(location: $0.from, length: $0.to - $0.from), replacement: $0.replacement) }
                try host.apply(MarkdownTextChange(edits: textEdits, selection: mapRange(host.selectedRange, through: textEdits), actionName: "Fix House Style"))
            }
            let left = run.findings.filter { targetOf($0)?.replacement == nil }.map { describeFinding(source as NSString, $0) }
            var obj = JSONObject([
                ("fixed", .number(Double(edits.count))),
                ("edits", .array(edits.map { .object(JSONObject([("from", .number(Double($0.from))), ("to", .number(Double($0.to))), ("replacement", .string($0.replacement))])) })),
                ("left", .array(left)),
            ])
            if overlapping > 0 { obj["note"] = .string("\(overlapping) overlapping fixes were left; run fix_rich_text_style again.") }
            return .value(.object(obj))
        }
    )
    return AgentToolProvider(
        id: options.id,
        namespace: options.namespace,
        title: "Markdown house style",
        description: "Check Markdown text against the house style and apply its certain fixes.",
        skill: "pixerate-rich-text",
        tools: { host.readOnlyReason == nil ? [check, fix] : [check] },
        subscribe: { listener in host.observeEditability(listener) ?? Cancellable {} }
    )
}
