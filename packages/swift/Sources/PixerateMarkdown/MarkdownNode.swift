// The shared Markdown document model (CommonMark 0.31 + GFM + Swash extensions).
// Every node records its exact UTF-16 source range and the ranges of its syntax
// markers, so the editor, preview and bubble menu can all work from one parse.

import Foundation

public enum TableAlignment: String, Codable, Equatable, CaseIterable, Sendable {
    case left
    case center
    case right
    case defaultAlignment
}

public enum AlertType: String, Codable, Equatable, CaseIterable, Sendable {
    case note
    case tip
    case important
    case warning
    case caution
    
    public var title: String {
        switch self {
        case .note: return "Note"
        case .tip: return "Tip"
        case .important: return "Important"
        case .warning: return "Warning"
        case .caution: return "Caution"
        }
    }
}

public enum TaskState: Equatable, Sendable {
    case unchecked
    case checked
}

public enum LinkKind: Equatable, Sendable {
    case inline          // [text](dest "title")
    case reference       // [text][label], [label][], [label]
    case autolink        // <https://…>, <me@example.com>
    case extendedAutolink // GFM bare www./http(s):// URL or email
}

public final class MarkdownNode {
    public enum Kind: Equatable, Sendable {
        // Blocks
        case document
        case frontMatter
        case blockQuote
        case alert(AlertType)
        case list(ordered: Bool, start: Int, delimiter: Character, bullet: Character, tight: Bool)
        case listItem(task: TaskState?)
        case paragraph
        case heading(level: Int, setext: Bool)
        case thematicBreak
        case codeBlock(fenced: Bool, info: String)
        case htmlBlock
        case table(alignments: [TableAlignment])
        case tableHead
        case tableRow
        case tableCell(alignment: TableAlignment, isHeader: Bool)
        case footnoteDefinition(label: String)
        case linkReferenceDefinition(label: String, destination: String, title: String?)
        // Inlines
        case text
        case softBreak
        case hardBreak
        case code
        case emphasis
        case strong
        case strikethrough
        case link(destination: String, title: String?, kind: LinkKind)
        case image(destination: String, title: String?)
        case htmlInline
        case footnoteReference(label: String)
        case math   // inline $…$ (literal = TeX source); display math is a codeBlock with info "math"

        public var isBlock: Bool {
            switch self {
            case .text, .softBreak, .hardBreak, .code, .emphasis, .strong, .strikethrough,
                 .link, .image, .htmlInline, .footnoteReference, .math:
                return false
            default:
                return true
            }
        }
    }

    public var kind: Kind
    /// Full source range (UTF-16 offsets into the document), syntax markers included.
    /// Block ranges end at the end of their last non-blank line (no trailing newline).
    public var range: NSRange
    /// Source ranges of syntax that a WYSIWYG view hides or replaces: emphasis delimiters,
    /// heading hashes, quote markers, list bullets, fence lines, link brackets and URLs…
    public var markers: [NSRange] = []
    /// Decoded text for leaf nodes: text (escapes and entities resolved), code spans,
    /// code blocks and HTML.
    public var literal: String = ""

    /// Back references are `unowned` rather than `weak`: weak references give every node a side
    /// table and slow down every retain and release (about 20% of parse time). A node never outlives
    /// its document, which owns the tree; code that keeps nodes keeps the document too (render
    /// contexts, `MarkdownFormatting`), and `unlink()` clears both references.
    public internal(set) unowned var parent: MarkdownNode?
    public private(set) var firstChild: MarkdownNode?
    public private(set) var lastChild: MarkdownNode?
    public private(set) var next: MarkdownNode?
    public private(set) unowned var previous: MarkdownNode?

    public init(_ kind: Kind, range: NSRange) {
        self.kind = kind
        self.range = range
    }

    public var children: [MarkdownNode] {
        var result: [MarkdownNode] = []
        var child = firstChild
        while let c = child {
            result.append(c)
            child = c.next
        }
        return result
    }

    public var nextSibling: MarkdownNode? { next }
    public var previousSibling: MarkdownNode? { previous }

    // MARK: Tree editing

    public func appendChild(_ child: MarkdownNode) {
        child.unlink()
        child.parent = self
        if let last = lastChild {
            last.next = child
            child.previous = last
            lastChild = child
        } else {
            firstChild = child
            lastChild = child
        }
    }

    public func insertAfter(_ sibling: MarkdownNode) {
        sibling.unlink()
        sibling.next = next
        if let n = next { n.previous = sibling }
        sibling.previous = self
        next = sibling
        sibling.parent = parent
        if parent?.lastChild === self { parent?.lastChild = sibling }
    }

    public func insertBefore(_ sibling: MarkdownNode) {
        sibling.unlink()
        sibling.previous = previous
        if let p = previous { p.next = sibling }
        sibling.next = self
        previous = sibling
        sibling.parent = parent
        if parent?.firstChild === self { parent?.firstChild = sibling }
    }

    public func unlink() {
        if let p = previous { p.next = next } else if let par = parent, par.firstChild === self { par.firstChild = next }
        if let n = next { n.previous = previous } else if let par = parent, par.lastChild === self { par.lastChild = previous }
        parent = nil
        next = nil
        previous = nil
    }

    /// Depth-first, pre-order traversal of this node and its descendants.
    public func walk(_ visit: (MarkdownNode) -> Void) {
        visit(self)
        var child = firstChild
        while let c = child {
            let following = c.next
            c.walk(visit)
            child = following
        }
    }

    /// Concatenated literal text of all descendant text-like nodes (used for image alt text, labels).
    public var plainText: String {
        var out = ""
        walk { node in
            switch node.kind {
            case .text, .code, .htmlInline, .math: out += node.literal
            case .softBreak, .hardBreak: out += "\n"
            default: break
            }
        }
        return out
    }

    /// Ancestors from the parent up to the document.
    public var ancestors: [MarkdownNode] {
        var result: [MarkdownNode] = []
        var node = parent
        while let n = node {
            result.append(n)
            node = n.parent
        }
        return result
    }
}

/// A parsed document: the tree plus lookups shared by every consumer.
public struct MarkdownDocument {
    public let source: String
    public let root: MarkdownNode
    /// Normalised label → (destination, title)
    public let linkReferences: [String: (destination: String, title: String?)]
    /// Footnote labels in order of first reference (GFM numbering).
    public let footnoteOrder: [String]

    public init(source: String, root: MarkdownNode, linkReferences: [String: (destination: String, title: String?)], footnoteOrder: [String]) {
        self.source = source
        self.root = root
        self.linkReferences = linkReferences
        self.footnoteOrder = footnoteOrder
    }

    public static func parse(_ text: String, options: MarkdownParseOptions = .swash) -> MarkdownDocument {
        MarkdownBlockParser(source: text, options: options).parse()
    }

    /// Deepest nodes (block and inline) whose range contains `range`, innermost last.
    public func nodePath(containing range: NSRange) -> [MarkdownNode] {
        var path: [MarkdownNode] = [root]
        var current = root
        while true {
            guard let child = current.children.first(where: { child in
                range.location >= child.range.location &&
                range.location + range.length <= child.range.location + child.range.length
            }) else { break }
            path.append(child)
            current = child
        }
        return path
    }
}

public struct MarkdownParseOptions: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let tables = MarkdownParseOptions(rawValue: 1 << 0)
    public static let strikethrough = MarkdownParseOptions(rawValue: 1 << 1)
    public static let taskLists = MarkdownParseOptions(rawValue: 1 << 2)
    public static let extendedAutolinks = MarkdownParseOptions(rawValue: 1 << 3)
    public static let footnotes = MarkdownParseOptions(rawValue: 1 << 4)
    public static let alerts = MarkdownParseOptions(rawValue: 1 << 5)
    public static let frontMatter = MarkdownParseOptions(rawValue: 1 << 6)
    public static let math = MarkdownParseOptions(rawValue: 1 << 7)

    public static let commonMark: MarkdownParseOptions = []
    public static let gfm: MarkdownParseOptions = [.tables, .strikethrough, .taskLists, .extendedAutolinks, .footnotes]
    public static let swash: MarkdownParseOptions = [.gfm, .alerts, .frontMatter, .math]
}
