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

/// Absolute time budgets in the checks hold for optimised builds (Swash's `swiftc -O` runners).
/// `swift test` and the iOS simulator build without optimisation, where a single timing on a
/// shared runner says little, so there the budgets are not enforced (the times are still
/// printed). The growth ratios, which catch quadratic paths, are checked in both.
enum TimingBudget {
    #if DEBUG
    static let scale = Double.infinity
    #else
    static let scale = 1.0
    #endif

    /// The largest time ratio for 4× the input. A quadratic path costs ~16×; debug builds on a
    /// busy simulator have measured up to ~12× for linear code, so they get 10 rather than
    /// the optimised build's limit.
    static func growthLimit(_ optimised: Double) -> Double {
        #if DEBUG
        return max(optimised, 10)
        #else
        return optimised
        #endif
    }

    /// The best times (ms) of `run` on a small and a 4× input, alternating the two five times so
    /// that a busy stretch on the machine slows both rather than only one of them. While the ratio
    /// looks worse than linear it measures again, up to four rounds: a shared CI simulator can
    /// stall for a whole round (×10.8 there for a parse that is ×4.0 locally), and a quadratic
    /// path stays at ~16× however often it is measured.
    static func growth(small: String, large: String, _ run: (String) -> Void) -> (small: Double, large: Double) {
        func time(_ input: String) -> Double {
            let start = Date()
            run(input)
            return Date().timeIntervalSince(start) * 1000
        }
        var best = (small: Double.infinity, large: Double.infinity)
        for round in 0..<4 {
            for _ in 0..<5 {
                best.small = min(best.small, time(small))
                best.large = min(best.large, time(large))
            }
            if round == 3 || best.large / max(best.small, 0.01) <= 5 { break }
        }
        return best
    }
}
