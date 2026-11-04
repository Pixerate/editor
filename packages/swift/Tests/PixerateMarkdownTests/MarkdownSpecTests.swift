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
    // ParserChecks, one test per section, so a failing test's name says which part broke (CI's
    // `xcodebuild -quiet` shows failing test names but not their messages).
    private func check(_ section: () -> Int) {
        var failures = 0
        let output = Self.capturingOutput { failures = section() }
        XCTAssertEqual(failures, 0, Self.failureLines(output))
    }

    func testFormattingChecks() { check(ParserChecks.runFormatting) }
    func testEditingCommandChecks() { check(ParserChecks.runEditing) }
    func testHTMLPasteChecks() { check(ParserChecks.runHTML) }
    func testOutlineChecks() { check(ParserChecks.runOutline) }
    func testMathEditingChecks() { check(ParserChecks.runMathEditing) }
    func testMarkerAndExtensionChecks() { check(ParserChecks.runMarkers) }
    func testFuzzChecks() { check(ParserChecks.runFuzz) }
    func testPathologicalInputTimes() { check(ParserChecks.runPathological) }
    func testParseTimeGrowth() { check(ParserChecks.runGrowth) }

    func testCodeHighlighterChecks() { check(CodeHighlighterChecks.run) }

    /// The checks print their results (they also run as Swash's command-line runner), and CI's
    /// `xcodebuild -quiet` hides test output, so failing lines go into the assertion message.
    private static func failureLines(_ output: String) -> String {
        output.split(separator: "\n").filter { $0.contains("❌") }.joined(separator: "\n")
    }

    /// Runs `body` with standard output going to a temporary file, then echoes and returns it.
    private static func capturingOutput(_ body: () -> Void) -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pixerate-markdown-\(UUID().uuidString).txt")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let file = try? FileHandle(forWritingTo: url) else { body(); return "" }
        fflush(stdout)
        let saved = dup(STDOUT_FILENO)
        dup2(file.fileDescriptor, STDOUT_FILENO)
        body()
        fflush(stdout)
        dup2(saved, STDOUT_FILENO)
        close(saved)
        try? file.close()
        let output = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? FileManager.default.removeItem(at: url)
        print(output, terminator: "")
        return output
    }
}
