// Document structure derived from the Markdown AST: the heading outline (sidebar, VoiceOver rotor,
// "Insert Table of Contents", "Copy Heading Link") and reader-facing statistics (status bar).

import Foundation

public struct MarkdownOutline: Equatable, Sendable {
    public struct Heading: Equatable, Sendable {
        public let level: Int
        public let title: String
        /// Raw-markdown range of the whole heading line(s), markers included.
        public let range: NSRange
        /// GitHub-style anchor, unique within the document.
        public let anchor: String

        public init(level: Int, title: String, range: NSRange, anchor: String) {
            self.level = level
            self.title = title
            self.range = range
            self.anchor = anchor
        }
    }

    public let headings: [Heading]

    public init(document: MarkdownDocument) {
        var headings: [Heading] = []
        var used: [String: Int] = [:]
        document.root.walk { node in
            guard case .heading(let level, _) = node.kind else { return }
            let title = node.plainText
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespaces)
            let base = MarkdownOutline.slug(title)
            let count = used[base, default: 0]
            used[base] = count + 1
            let anchor = count == 0 ? base : "\(base)-\(count)"
            headings.append(Heading(level: level, title: title, range: node.range, anchor: anchor))
        }
        self.headings = headings
    }

    public init(text: String) {
        self.init(document: MarkdownDocument.parse(text))
    }

    /// Index of the heading whose section contains `location`: the last heading starting at or before it.
    public func headingIndex(containing location: Int) -> Int? {
        var low = 0, high = headings.count - 1, found: Int? = nil
        while low <= high {
            let mid = (low + high) / 2
            if headings[mid].range.location <= location {
                found = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return found
    }

    /// GitHub's heading anchor: lowercased, punctuation removed (letters, digits, `-` and `_` kept),
    /// spaces turned into hyphens.
    public static func slug(_ title: String) -> String {
        var result = ""
        for scalar in title.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_" {
                result.unicodeScalars.append(scalar)
            } else if scalar == " " {
                result.append("-")
            }
        }
        return result
    }

    /// A nested Markdown list of links to every heading, indented relative to the shallowest level.
    /// `excludingFirstTitle` drops a lone leading H1 (the document title) the way most TOCs do.
    public func tableOfContents(excludingFirstTitle: Bool = true) -> String {
        var items = headings
        if excludingFirstTitle, let first = items.first, first.level == 1,
           !items.dropFirst().contains(where: { $0.level == 1 }) {
            items.removeFirst()
        }
        guard let minLevel = items.map(\.level).min() else { return "" }
        return items.map { heading in
            let indent = String(repeating: "  ", count: heading.level - minLevel)
            return "\(indent)- [\(MarkdownOutline.escapeLinkText(heading.title))](#\(heading.anchor))"
        }.joined(separator: "\n")
    }

    public static func escapeLinkText(_ text: String) -> String {
        var out = ""
        for character in text {
            if character == "[" || character == "]" || character == "\\" { out.append("\\") }
            out.append(character)
        }
        return out
    }
}

/// Counts of what a reader sees: Markdown syntax, front matter and HTML blocks are not counted.
public struct MarkdownStatistics: Equatable, Sendable {
    public var words = 0
    public var characters = 0
    public var charactersExcludingSpaces = 0
    public var paragraphs = 0

    /// Minutes at 230 words per minute, at least one for any text.
    public var readingMinutes: Int { words == 0 ? 0 : max(1, Int((Double(words) / 230).rounded(.up))) }

    public static let empty = MarkdownStatistics()

    public init() {}

    public init(document: MarkdownDocument) {
        var visible = ""
        var paragraphs = 0
        document.root.walk { node in
            switch node.kind {
            case .paragraph, .heading, .tableCell:
                let text = node.plainText
                visible += text + "\n"
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !node.isInsideTable {
                    paragraphs += 1
                }
            case .codeBlock:
                visible += node.literal + "\n"
                paragraphs += 1
            case .table:
                paragraphs += 1
            default:
                break
            }
        }
        self.init(visibleText: visible, paragraphs: paragraphs)
    }

    public init(text: String) {
        self.init(document: MarkdownDocument.parse(text))
    }

    private init(visibleText: String, paragraphs: Int) {
        let ns = visibleText as NSString
        var words = 0
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byWords, .substringNotRequired]) { _, _, _, _ in
            words += 1
        }
        self.words = words
        // Block separators added above are not part of the text
        let trimmed = visibleText.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        self.characters = trimmed.count
        self.charactersExcludingSpaces = trimmed.filter { !$0.isWhitespace }.count
        self.paragraphs = paragraphs
    }
}

private extension MarkdownNode {
    var isInsideTable: Bool {
        ancestors.contains { if case .table = $0.kind { return true }; return false }
    }
}
