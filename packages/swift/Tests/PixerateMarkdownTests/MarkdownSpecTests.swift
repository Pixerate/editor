import Foundation
import XCTest
@testable import PixerateMarkdown

/// The CommonMark 0.31.2 and GFM extension example suites (`Fixtures/`, see its README): each
/// example is rendered to HTML and compared with the expected output, and every node's source
/// range and markers must lie within the source and nest in their parent. Then the parser and
/// code-highlighter checks that the editors depend on beyond HTML conformance.
final class MarkdownSpecTests: XCTestCase {
    private struct SpecExample: Decodable {
        let markdown: String
        let html: String
        let example: Int
        let section: String
    }

    private func runSuite(_ file: String, options: MarkdownParseOptions) throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: file, withExtension: "json", subdirectory: "Fixtures"))
        let examples = try JSONDecoder().decode([SpecExample].self, from: Data(contentsOf: url))
        var failures: [String] = []
        for example in examples {
            let document = MarkdownDocument.parse(example.markdown, options: options)
            let html = MarkdownHTMLRenderer.render(document)
            // "<IGNORE>" examples only check that parsing does not crash
            if html != example.html && example.html != "<IGNORE>\n" {
                failures.append("#\(example.example) \(example.section): \(example.markdown.debugDescription) → \(html.debugDescription), expected \(example.html.debugDescription)")
            }
            if let problem = SpecStructure.problem(in: document) {
                failures.append("#\(example.example) \(example.section) structure: \(problem)")
            }
        }
        XCTAssert(failures.isEmpty, "\(failures.count) of \(examples.count) examples failed:\n" + failures.prefix(20).joined(separator: "\n"))
    }

    func testCommonMarkSpec() throws {
        try runSuite("commonmark-0.31.2", options: .commonMark)
    }

    func testGFMExtensions() throws {
        try runSuite("gfm-extensions", options: .gfm)
    }

    /// Marker ranges, extensions, formatting and editing commands, HTML paste conversion,
    /// robustness on random input and linear-time parsing (failures are printed above the count).
    func testParserChecks() {
        XCTAssertEqual(ParserChecks.run(), 0)
    }

    func testCodeHighlighterChecks() {
        XCTAssertEqual(CodeHighlighterChecks.run(), 0)
    }
}
