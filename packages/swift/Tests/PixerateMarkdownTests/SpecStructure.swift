import Foundation
@testable import PixerateMarkdown

// No XCTest here: Swash's swiftc spec runner compiles this file with ParserChecks and
// CodeHighlighterChecks.

enum SpecStructure {
    /// Ranges must be inside the source; child and marker ranges must lie inside their node's range.
    static func problem(in document: MarkdownDocument) -> String? {
        let length = (document.source as NSString).length
        var problem: String? = nil
        func inside(_ inner: NSRange, _ outer: NSRange) -> Bool {
            inner.location >= outer.location && inner.location + inner.length <= outer.location + outer.length
        }
        document.root.walk { node in
            guard problem == nil else { return }
            let r = node.range
            if r.location < 0 || r.length < 0 || r.location + r.length > length {
                problem = "\(node.kind) range \(r) outside source (length \(length))"
                return
            }
            for marker in node.markers where !inside(marker, NSRange(location: 0, length: length)) {
                problem = "\(node.kind) marker \(marker) outside source"
                return
            }
            if let parent = node.parent, parent !== document.root, !inside(r, parent.range) {
                problem = "\(node.kind) \(r) not inside parent \(parent.kind) \(parent.range)"
            }
        }
        return problem
    }
}

/// Absolute time budgets in the checks are for optimised builds (Swash's `swiftc -O` runners).
/// `swift test` builds without optimisation and runs suites in parallel, so they get more room
/// there; the growth ratios, which catch quadratic paths, are the same in both.
enum TimingBudget {
    #if DEBUG
    static let scale = 5.0
    #else
    static let scale = 1.0
    #endif
}
