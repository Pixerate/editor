import Foundation
#if canImport(NaturalLanguage)
import NaturalLanguage
#endif

// Text mechanics (#892): the small, certain fixes a writer expects as they type, over Markdown
// source. A port of `packages/core/src/tools/text-mechanics.ts`, which is the specification:
// `@pixerate/conformance` (`domains/text-mechanics`) holds typing scenarios recorded from it, and
// this port must leave the same text with the same checks. Where the TypeScript reads a light
// prose map of the source, this reads `MarkdownDocument`. Positions are UTF-16 offsets.

/// One kind of fix, with its own switch and its own learning.
public enum TextMechanicsCheck: String, CaseIterable, Codable, Sendable {
    /// `i` → `I`, `i'm` → `I'm`.
    case pronounI = "pronoun-i"
    /// `dont` → `don't`; `its`, `id` and `ill` only when the tagger reads them as a contraction.
    case contractions
    /// A capital to start a sentence, a line, a heading or a paragraph.
    case sentenceCase = "sentence-case"
    /// A full stop or question mark at the end of a finished line of four or more words.
    case terminalPunctuation = "terminal-punctuation"
    /// `ok` → `OK`.
    case capitals
    /// A comma before "but" when it joins two clauses.
    case clauseComma = "clause-comma"
    /// Misspellings, as the host's spell checker corrects them.
    case spelling

    public var title: String {
        switch self {
        case .pronounI: return "Capital I"
        case .contractions: return "Apostrophes"
        case .sentenceCase: return "Capitals at the start of sentences"
        case .terminalPunctuation: return "Full stops and question marks"
        case .capitals: return "Capitals in OK"
        case .clauseComma: return "Commas before “but”"
        case .spelling: return "Spelling"
        }
    }
}

/// Word classes the checks ask a tagger for.
public enum TextMechanicsWordClass: String, Codable, Sendable {
    case noun, verb, adjective, adverb, pronoun, determiner, preposition, conjunction, interjection, other
}

/// The words of a text with their classes (UTF-16 ranges), punctuation and spaces left out.
public typealias TextMechanicsTagger = (String) -> [(range: NSRange, tag: TextMechanicsWordClass)]

/// A spelling correction for the misspelt `word` at `range` in `text`, or nil.
public typealias TextMechanicsSpelling = (_ word: String, _ range: NSRange, _ text: String) -> String?

public struct TextMechanicsOptions {
    public enum Profile: String, Sendable {
        case prose
        /// A light touch for chat (Slack): no sentence capitals, full stops, `OK` or commas.
        case chat
    }

    public var profile: Profile
    /// Which checks run (default: all; `spelling` only with `spelling`).
    public var enabled: (TextMechanicsCheck) -> Bool
    /// For a newline boundary: whether Enter was pressed at the end of its line. Nil: what follows the newline decides.
    public var enterEndedLine: Bool?
    public var spelling: TextMechanicsSpelling?
    public var tagger: TextMechanicsTagger?

    public init(profile: Profile = .prose, enabled: @escaping (TextMechanicsCheck) -> Bool = { _ in true }, enterEndedLine: Bool? = nil,
                spelling: TextMechanicsSpelling? = nil, tagger: TextMechanicsTagger? = nil) {
        self.profile = profile
        self.enabled = enabled
        self.enterEndedLine = enterEndedLine
        self.spelling = spelling
        self.tagger = tagger
    }
}

/// A fix: replace `range` with `replacement`.
public struct TextMechanicsEdit: Equatable, Sendable {
    public var range: NSRange
    public var replacement: String
    /// The checks it applies (a word can get an apostrophe and a capital at once).
    public var checks: [TextMechanicsCheck]

    public init(range: NSRange, replacement: String, checks: [TextMechanicsCheck]) {
        self.range = range
        self.replacement = replacement
        self.checks = checks
    }
}

public enum TextMechanics {
    // MARK: At a boundary

    /// The fixes to make after the character at `boundary` was typed (the caret is just after it):
    /// the word it ends, the words before it that the new word decides (`its`, `id`, `ill`, the
    /// comma before "but"), and the line's full stop or question mark when it's a newline.
    /// `document` is `text` parsed.
    public static func edits(at boundary: Int, in text: String, document: MarkdownDocument, options: TextMechanicsOptions = TextMechanicsOptions()) -> [TextMechanicsEdit] {
        let ns = text as NSString
        guard boundary >= 0, boundary < ns.length else { return [] }
        let typed = ns.character(at: boundary)
        guard isBoundary(typed) || typed == newline else { return [] }
        let chat = options.profile == .chat
        let on = { (check: TextMechanicsCheck) -> Bool in
            check == .spelling && options.spelling == nil ? false : options.enabled(check)
        }

        var start = boundary
        while start > 0, isWordCharacter(ns.character(at: start - 1)) { start -= 1 }
        let wordRange = NSRange(location: start, length: boundary - start)
        guard wordRange.length > 0, isProse(wordRange, ns: ns, document: document), !insideUnclosedSpan(before: start, ns: ns) else { return [] }
        let word = ns.substring(with: wordRange)
        var edits: [TextMechanicsEdit] = []

        var replacement = word
        var checks: [TextMechanicsCheck] = []
        if let fixed = fixedWord(word, chat: chat, on: on) {
            replacement = fixed.word
            checks.append(fixed.check)
        } else if on(.spelling), let spelling = options.spelling, (word as NSString).length > 2,
                  !word.contains(where: { $0.isUppercase }) || word.first?.isUppercase == true && !word.dropFirst().contains(where: { $0.isUppercase }),
                  let corrected = spelling(word, wordRange, text), corrected != word, !corrected.contains(" ") {
            replacement = corrected
            checks.append(.spelling)
        }
        if !chat, on(.sentenceCase),
           let first = replacement.unicodeScalars.first, CharacterSet.lowercaseLetters.contains(first),
           !replacement.dropFirst().contains(where: { $0.isUppercase }),
           startsSentence(at: start, ns: ns, document: document) {
            replacement = replacement.prefix(1).uppercased() + replacement.dropFirst()
            checks.append(.sentenceCase)
        }
        if !checks.isEmpty, replacement != word {
            edits.append(TextMechanicsEdit(range: wordRange, replacement: replacement, checks: checks))
        }
        if let tagger = options.tagger {
            if on(.contractions) {
                if let edit = itsBefore(word: word, at: start, ns: ns, document: document, tagger: tagger) { edits.append(edit) }
                if let edit = pronounContractionBefore(word: word, at: start, ns: ns, document: document, tagger: tagger) { edits.append(edit) }
            }
            if !chat, on(.clauseComma), let edit = commaBeforeBut(word: word, at: start, ns: ns, document: document, tagger: tagger) {
                edits.append(edit)
            }
        }
        if typed == newline, !chat, on(.terminalPunctuation),
           let edit = terminalPunctuation(ns: ns, lineEnd: boundary, document: document, enterEndedLine: options.enterEndedLine) {
            edits.append(edit)
        }
        return edits
    }

    /// What the checks look at for the boundary at `boundary`: the word before it, or the line it
    /// ends when it's a newline. Nil when that isn't prose, so there's nothing to show as checked.
    public static func checkedRange(at boundary: Int, in text: String, document: MarkdownDocument) -> NSRange? {
        let ns = text as NSString
        guard boundary > 0, boundary < ns.length else { return nil }
        let typed = ns.character(at: boundary)
        if typed == newline {
            var lineStart = boundary
            while lineStart > 0, ns.character(at: lineStart - 1) != newline { lineStart -= 1 }
            let line = NSRange(location: lineStart, length: boundary - lineStart)
            guard line.length > 0, !ns.substring(with: line).trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            var last = boundary - 1
            while last > lineStart, ns.character(at: last) == 0x20 { last -= 1 }
            return isProse(NSRange(location: last, length: 1), ns: ns, document: document) ? line : nil
        }
        guard isBoundary(typed) else { return nil }
        var start = boundary
        while start > 0, isWordCharacter(ns.character(at: start - 1)) { start -= 1 }
        let word = NSRange(location: start, length: boundary - start)
        guard word.length > 0, isProse(word, ns: ns, document: document), !insideUnclosedSpan(before: start, ns: ns) else { return nil }
        return word
    }

    // MARK: A whole text

    /// Every fix the checks would make in `text`, as if it had been typed: each word boundary in
    /// order, on the text the earlier fixes left, and each line end as a finished line. Fixes to
    /// the same word merge (`its` → `It's`). Ranges are in `text` as it is, and never overlap.
    /// `parse` reads a text (default: `MarkdownDocument.parse` with Swash's options).
    public static func findings(in text: String, options: TextMechanicsOptions = TextMechanicsOptions(),
                                parse: (String) -> MarkdownDocument = { MarkdownDocument.parse($0) }) -> [TextMechanicsEdit] {
        struct Applied {
            var range: NSRange
            var at: Int
            var end: Int
            var replacement: String
            var checks: [TextMechanicsCheck]
        }
        var applied: [Applied] = []
        var current = text as NSString
        var document = parse(text)
        var i = 0
        while i < current.length {
            let c = current.character(at: i)
            guard isBoundary(c) || c == newline else { i += 1; continue }
            var boundaryOptions = options
            boundaryOptions.enterEndedLine = c == newline ? true : nil
            let edits = edits(at: i, in: current as String, document: document, options: boundaryOptions)
                .sorted { $0.range.location > $1.range.location }
            var shiftHere = 0
            for edit in edits {
                let length = (edit.replacement as NSString).length
                let delta = length - edit.range.length
                let from = edit.range.location
                let to = NSMaxRange(edit.range)
                if let index = applied.firstIndex(where: { $0.at <= from && to <= $0.end && (from != to || ($0.at < from && from < $0.end)) }) {
                    var inside = applied[index]
                    let replacement = inside.replacement as NSString
                    inside.replacement = replacement.replacingCharacters(in: NSRange(location: from - inside.at, length: to - from), with: edit.replacement)
                    for check in edit.checks where !inside.checks.contains(check) { inside.checks.append(check) }
                    inside.end += delta
                    applied[index] = inside
                    for k in applied.indices where k != index && applied[k].at >= to {
                        applied[k].at += delta
                        applied[k].end += delta
                    }
                } else if applied.contains(where: { from == to ? $0.at == from && $0.end == from : $0.at < to && from < $0.end }) {
                    continue
                } else {
                    let before = applied.filter { $0.end <= from }.reduce(0) { $0 + ($1.replacement as NSString).length - $1.range.length }
                    for k in applied.indices where applied[k].at >= to {
                        applied[k].at += delta
                        applied[k].end += delta
                    }
                    applied.append(Applied(range: NSRange(location: from - before, length: to - from), at: from, end: from + length,
                                           replacement: edit.replacement, checks: edit.checks))
                }
                current = current.replacingCharacters(in: edit.range, with: edit.replacement) as NSString
                if from <= i { shiftHere += delta }
            }
            if !edits.isEmpty { document = parse(current as String) }
            i += shiftHere + 1
        }
        let original = text as NSString
        return applied
            .filter { $0.replacement != original.substring(with: $0.range) }
            .sorted { $0.range.location < $1.range.location }
            .map { TextMechanicsEdit(range: $0.range, replacement: $0.replacement, checks: $0.checks) }
    }

    /// Applies non-overlapping edits to `text`.
    public static func apply(_ edits: [TextMechanicsEdit], to text: String) -> String {
        var out = text as NSString
        for edit in edits.sorted(by: { $0.range.location > $1.range.location }) {
            out = out.replacingCharacters(in: edit.range, with: edit.replacement) as NSString
        }
        return out as String
    }

    // MARK: Words

    private static let newline: unichar = 0x0A

    /// Characters that end a word: space, tab and sentence punctuation.
    public static func isBoundary(_ c: unichar) -> Bool {
        switch c {
        case 0x20, 0x09, 0x2C, 0x2E, 0x3F, 0x21, 0x3B, 0x3A: return true // space tab , . ? ! ; :
        default: return false
        }
    }

    /// Letters and apostrophes (`'` and `’`).
    public static func isWordCharacter(_ c: unichar) -> Bool {
        if c == 0x27 || c == 0x2019 { return true }
        guard let scalar = Unicode.Scalar(c) else { return false }
        return CharacterSet.letters.contains(scalar)
    }

    /// Missing apostrophes. Words that are also real words without one (its, well, were, ill, id,
    /// wont, lets, shell, hell, wed) aren't here.
    public static let contractions: [String: String] = [
        "dont": "don't", "doesnt": "doesn't", "didnt": "didn't", "cant": "can't", "couldnt": "couldn't",
        "shouldnt": "shouldn't", "wouldnt": "wouldn't", "isnt": "isn't", "arent": "aren't", "wasnt": "wasn't",
        "werent": "weren't", "havent": "haven't", "hasnt": "hasn't", "hadnt": "hadn't", "mustnt": "mustn't",
        "neednt": "needn't", "youre": "you're", "theyre": "they're", "youve": "you've", "theyve": "they've",
        "weve": "we've", "youll": "you'll", "theyll": "they'll", "youd": "you'd", "theyd": "they'd",
        "thats": "that's", "whats": "what's", "theres": "there's", "heres": "here's", "wheres": "where's",
        "whos": "who's", "hes": "he's", "shes": "she's", "aint": "ain't", "im": "I'm", "ive": "I've",
    ]

    private static let pronounForms: [String: String] = ["i": "I", "i'm": "I'm", "i've": "I've", "i'd": "I'd", "i'll": "I'll",
                                                         "i’m": "I’m", "i’ve": "I’ve", "i’d": "I’d", "i’ll": "I’ll"]

    /// Words always written in capitals. Only lowercase spellings are changed (`Ok` might be a name).
    public static let capitalWords: [String: String] = ["ok": "OK"]

    private static func fixedWord(_ word: String, chat: Bool, on: (TextMechanicsCheck) -> Bool) -> (word: String, check: TextMechanicsCheck)? {
        if on(.pronounI), let fixed = pronounForms[word] { return (fixed, .pronounI) }
        if !chat, on(.capitals), let fixed = capitalWords[word] { return (fixed, .capitals) }
        guard on(.contractions) else { return nil }
        let lower = word.lowercased()
        guard let fixed = contractions[lower] else { return nil }
        if lower == "im" || lower == "ive" { return word == "IM" || word == "IVE" ? nil : (fixed, .contractions) }
        if word == lower { return (fixed, .contractions) }
        if word == word.uppercased() { return (fixed.uppercased(), .contractions) }
        if word == word.prefix(1).uppercased() + word.dropFirst() { return (fixed.prefix(1).uppercased() + fixed.dropFirst(), .contractions) }
        return nil // mixed case: a name or a code word
    }

    /// The word before the one at `start` when a single space separates them, and the line up to the end of `word`.
    private static func previousWord(before start: Int, word: String, ns: NSString) -> (range: NSRange, text: String, line: String, offsetInLine: Int)? {
        guard start >= 2, ns.character(at: start - 1) == 0x20 else { return nil }
        var previousStart = start - 1
        while previousStart > 0, isWordCharacter(ns.character(at: previousStart - 1)) { previousStart -= 1 }
        let range = NSRange(location: previousStart, length: start - 1 - previousStart)
        guard range.length > 0 else { return nil }
        var lineStart = previousStart
        while lineStart > 0, ns.character(at: lineStart - 1) != newline { lineStart -= 1 }
        let line = ns.substring(with: NSRange(location: lineStart, length: start + (word as NSString).length - lineStart))
        return (range, ns.substring(with: range), line, previousStart - lineStart)
    }

    private static func tag(at offset: Int, in line: String, tagger: TextMechanicsTagger) -> TextMechanicsWordClass? {
        tagger(line).first { $0.range.location <= offset && offset < NSMaxRange($0.range) }?.tag
    }

    /// `its` before an adverb, determiner, verb or pronoun ("its really", "its a") is "it's"; before a noun or adjective it stays.
    private static func itsBefore(word: String, at start: Int, ns: NSString, document: MarkdownDocument, tagger: TextMechanicsTagger) -> TextMechanicsEdit? {
        guard let previous = previousWord(before: start, word: word, ns: ns), previous.range.length == 3,
              previous.text.lowercased() == "its", isProse(previous.range, ns: ns, document: document) else { return nil }
        let lineStart = previous.range.location - previous.offsetInLine
        guard let tag = tag(at: start - lineStart, in: previous.line, tagger: tagger), [.adverb, .determiner, .verb, .pronoun].contains(tag) else { return nil }
        let fixed: String
        switch previous.text {
        case "its": fixed = "it's"
        case "ITS": fixed = "IT'S"
        case "Its": fixed = "It's"
        default: return nil
        }
        return TextMechanicsEdit(range: previous.range, replacement: fixed, checks: [.contractions])
    }

    /// `id` and `ill` read as a pronoun or verb in their line ("id like", "ill be") are "I'd" and "I'll"; as a noun or adjective they stay.
    private static func pronounContractionBefore(word: String, at start: Int, ns: NSString, document: MarkdownDocument, tagger: TextMechanicsTagger) -> TextMechanicsEdit? {
        guard let previous = previousWord(before: start, word: word, ns: ns) else { return nil }
        let forms = ["id": "I'd", "Id": "I'd", "ill": "I'll", "Ill": "I'll"]
        guard let fixed = forms[previous.text], isProse(previous.range, ns: ns, document: document),
              let tag = tag(at: previous.offsetInLine, in: previous.line, tagger: tagger), tag == .pronoun || tag == .verb else { return nil }
        return TextMechanicsEdit(range: previous.range, replacement: fixed, checks: [.contractions])
    }

    /// Words before "but" that make it mean "except" ("nothing but the truth"): no comma.
    private static let exceptBefore: Set<String> = ["nothing", "anything", "everything", "all", "none", "nobody", "anyone",
                                                     "everyone", "no", "any", "every", "last", "next", "not", "only"]

    /// "but" starts a new clause when the word after it begins one (a pronoun, determiner,
    /// preposition or adverb) and the clause before it has a verb and at least two words.
    private static func commaBeforeBut(word: String, at start: Int, ns: NSString, document: MarkdownDocument, tagger: TextMechanicsTagger) -> TextMechanicsEdit? {
        guard let but = previousWord(before: start, word: word, ns: ns), but.text.lowercased() == "but",
              word.lowercased() != "also", isProse(but.range, ns: ns, document: document),
              let before = previousWord(before: but.range.location, word: but.text, ns: ns),
              !exceptBefore.contains(before.text.lowercased()) else { return nil }
        var clauseStart = before.range.location
        while clauseStart > 0 {
            let c = ns.character(at: clauseStart - 1)
            if c == newline || c == 0x2E || c == 0x3F || c == 0x21 || c == 0x3B || c == 0x3A || c == 0x2C { break }
            clauseStart -= 1
        }
        let clause = tagger(ns.substring(with: NSRange(location: clauseStart, length: NSMaxRange(before.range) - clauseStart)))
        guard clause.count >= 2, clause.contains(where: { $0.tag == .verb }),
              let tag = tag(at: but.offsetInLine + but.range.length + 1, in: but.line, tagger: tagger),
              [.pronoun, .determiner, .preposition, .adverb].contains(tag) else { return nil }
        return TextMechanicsEdit(range: NSRange(location: NSMaxRange(before.range), length: 0), replacement: ",", checks: [.clauseComma])
    }

    // MARK: Where prose is

    /// The deepest node whose range contains `location`.
    private static func node(at location: Int, in document: MarkdownDocument) -> MarkdownNode {
        var node = document.root
        descend: while true {
            for child in node.children where NSLocationInRange(location, child.range) {
                node = child
                continue descend
            }
            return node
        }
    }

    /// The word is ordinary text in a paragraph, heading or list item: not in code, math, HTML,
    /// an address, front matter or a table, and not part of a URL, path, email, mention or tag.
    public static func isProse(_ range: NSRange, ns: NSString, document: MarkdownDocument) -> Bool {
        var current: MarkdownNode? = node(at: range.location, in: document)
        guard current?.kind == .text else { return false }
        while let node = current {
            switch node.kind {
            case .code, .codeBlock, .math, .htmlInline, .htmlBlock, .frontMatter, .image, .table, .linkReferenceDefinition:
                return false
            case .link(_, _, let kind) where kind == .autolink || kind == .extendedAutolink:
                return false
            default:
                current = node.parent
            }
        }
        var tokenStart = range.location
        while tokenStart > 0 {
            let c = ns.character(at: tokenStart - 1)
            if c == 0x20 || c == 0x09 || c == newline { break }
            tokenStart -= 1
        }
        let token = ns.substring(with: NSRange(location: tokenStart, length: NSMaxRange(range) - tokenStart))
        if token.contains("/") || token.contains("@") || token.contains("#") || token.contains("\\") || token.contains(":") || token.contains("_") {
            return false
        }
        if (token as NSString).substring(to: (token as NSString).length - range.length).contains(".") { return false } // file.name, e.g.word
        return true
    }

    /// A code span or inline math still being typed: an odd number of backticks or dollar signs earlier on the line.
    static func insideUnclosedSpan(before location: Int, ns: NSString) -> Bool {
        var backticks = 0
        var dollars = 0
        var i = location
        while i > 0 {
            let c = ns.character(at: i - 1)
            if c == newline { break }
            if c == 0x60 { backticks += 1 }
            if c == 0x24, i < 2 || ns.character(at: i - 2) != 0x5C { dollars += 1 }
            i -= 1
        }
        return backticks % 2 == 1 || dollars % 2 == 1
    }

    // MARK: Sentences

    private static let abbreviations: Set<String> = ["e.g", "i.e", "etc", "vs", "cf", "approx", "mr", "mrs", "ms", "dr", "st", "no", "fig", "ca", "al"]

    /// The word at `start` begins a sentence: the first word of its paragraph or heading, the start
    /// of a line, or after `.`, `?` or `!` (not an abbreviation, ellipsis, decimal or initial).
    static func startsSentence(at start: Int, ns: NSString, document: MarkdownDocument) -> Bool {
        let text = node(at: start, in: document)
        var block = text.parent
        while let current = block, !current.kind.isBlock { block = current.parent }
        guard let block else { return false }
        switch block.kind {
        case .paragraph, .heading: break
        default: return false
        }
        if let first = firstText(in: block), first === text, onlyOpeningMarkup(in: ns, from: first.range.location, to: start) {
            return true
        }
        var i = start
        while i > 0 {
            let c = ns.character(at: i - 1)
            if c == 0x20 || c == 0x2A || c == 0x5F || c == 0x7E || c == 0x5B || c == 0x28 || c == 0x22 || c == 0x201C {
                i -= 1
            } else {
                break
            }
        }
        guard i > 0 else { return false }
        if ns.character(at: i - 1) == newline { return true }
        guard i < start else { return false }
        let end = ns.character(at: i - 1)
        var stop = i - 1
        if end == 0x22 || end == 0x201D || end == 0x29, stop > 0 { stop -= 1 }
        let mark = ns.character(at: stop)
        if mark == 0x3F || mark == 0x21 { return true }
        guard mark == 0x2E else { return false }
        if stop > 0 {
            let before = ns.character(at: stop - 1)
            if before == 0x2E { return false } // ellipsis
            if before >= 0x30, before <= 0x39 { return false } // a decimal
        }
        var wordStart = stop
        while wordStart > 0, isWordCharacter(ns.character(at: wordStart - 1)) || ns.character(at: wordStart - 1) == 0x2E { wordStart -= 1 }
        let previous = ns.substring(with: NSRange(location: wordStart, length: stop - wordStart)).lowercased()
        if abbreviations.contains(previous) { return false }
        if previous.count == 1 { return false } // initials: J. Smith
        return true
    }

    private static func firstText(in block: MarkdownNode) -> MarkdownNode? {
        var found: MarkdownNode?
        block.walk { node in
            if found == nil, node.kind == .text { found = node }
        }
        return found
    }

    private static func onlyOpeningMarkup(in ns: NSString, from: Int, to: Int) -> Bool {
        guard from <= to else { return false }
        for i in from..<to {
            switch ns.character(at: i) {
            case 0x20, 0x2A, 0x5F, 0x7E, 0x22, 0x201C, 0x28: continue
            default: return false
            }
        }
        return true
    }

    // MARK: Line ends

    private static let questionWords: Set<String> = [
        "who", "what", "when", "where", "why", "how", "which", "whose", "whom",
        "is", "are", "am", "was", "were", "do", "does", "did", "can", "could", "would", "should", "will", "shall",
        "may", "might", "have", "has", "had", "isn't", "aren't", "don't", "doesn't", "didn't", "can't", "won't",
        "wouldn't", "shouldn't", "couldn't",
    ]

    /// A full stop or question mark for the line ended at `lineEnd` (the newline): four or more
    /// words of prose ending in a letter or digit, in a paragraph that isn't in a list item, table,
    /// alert or footnote, and only when Enter ended the line rather than splitting it.
    private static func terminalPunctuation(ns: NSString, lineEnd: Int, document: MarkdownDocument, enterEndedLine: Bool?) -> TextMechanicsEdit? {
        guard lineEnd > 0 else { return nil }
        let endedLine = enterEndedLine ?? (lineEnd + 1 >= ns.length || ns.character(at: lineEnd + 1) == newline)
        guard endedLine else { return nil }
        let last = lineEnd - 1
        guard let scalar = Unicode.Scalar(ns.character(at: last)), CharacterSet.alphanumerics.contains(scalar) else { return nil }
        let text = node(at: last, in: document)
        guard text.kind == .text else { return nil }
        var paragraph = text.parent
        while let current = paragraph, current.kind != .paragraph {
            if current.kind.isBlock { return nil }
            paragraph = current.parent
        }
        guard let paragraph else { return nil }
        var ancestor = paragraph.parent
        while let current = ancestor {
            switch current.kind {
            case .listItem, .tableCell, .alert, .footnoteDefinition: return nil
            default: ancestor = current.parent
            }
        }
        guard isProse(NSRange(location: last, length: 1), ns: ns, document: document), !insideUnclosedSpan(before: last, ns: ns) else { return nil }
        var lineStart = lineEnd
        while lineStart > 0, ns.character(at: lineStart - 1) != newline { lineStart -= 1 }
        let line = ns.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart))
        let words = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard words.count >= 4 else { return nil }
        let first = words[0].lowercased().trimmingCharacters(in: CharacterSet.letters.inverted.subtracting(CharacterSet(charactersIn: "'’")))
        return TextMechanicsEdit(range: NSRange(location: lineEnd, length: 0), replacement: questionWords.contains(first) ? "?" : ".", checks: [.terminalPunctuation])
    }

    // MARK: Taggers

    /// A tagger that reads words from a lexicon of lower-case words (for tests and scenarios).
    public static func lexiconTagger(_ lexicon: [String: TextMechanicsWordClass]) -> TextMechanicsTagger {
        { text in
            let ns = text as NSString
            var words: [(range: NSRange, tag: TextMechanicsWordClass)] = []
            var i = 0
            while i < ns.length {
                guard isTaggerWordCharacter(ns.character(at: i)) else { i += 1; continue }
                var end = i
                while end < ns.length, isTaggerWordCharacter(ns.character(at: end)) { end += 1 }
                let range = NSRange(location: i, length: end - i)
                words.append((range, lexicon[ns.substring(with: range).lowercased()] ?? .other))
                i = end
            }
            return words
        }
    }

    private static func isTaggerWordCharacter(_ c: unichar) -> Bool {
        if c == 0x27 || c == 0x2019 { return true }
        guard let scalar = Unicode.Scalar(c) else { return false }
        return CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)
    }

    #if canImport(NaturalLanguage)
    /// Word classes from the system's `NLTagger` (`.lexicalClass`). Pass it as `tagger`.
    public static func naturalLanguageTagger(_ text: String) -> [(range: NSRange, tag: TextMechanicsWordClass)] {
        let tagger = NLTagger(tagSchemes: [.lexicalClass])
        tagger.string = text
        var words: [(range: NSRange, tag: TextMechanicsWordClass)] = []
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .lexicalClass,
                             options: [.omitWhitespace, .omitPunctuation]) { tag, range in
            let wordClass: TextMechanicsWordClass
            switch tag {
            case .noun?: wordClass = .noun
            case .verb?: wordClass = .verb
            case .adjective?: wordClass = .adjective
            case .adverb?: wordClass = .adverb
            case .pronoun?: wordClass = .pronoun
            case .determiner?: wordClass = .determiner
            case .preposition?: wordClass = .preposition
            case .conjunction?: wordClass = .conjunction
            case .interjection?: wordClass = .interjection
            default: wordClass = .other
            }
            words.append((NSRange(range, in: text), wordClass))
            return true
        }
        return words
    }
    #endif
}
