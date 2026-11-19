import Foundation
import XCTest
import PixerateContracts
import PixerateCore
import PixerateMarkdown
@testable import PixerateMarkdownTools

private let SKILL_PROFILE: JSONValue = [
    "headingCase": "sentence",
    "terms": [["avoid": "utilize", "use": "use"]],
    "dateFormat": "day-month-year",
    "checks": ["heading-case", "terms", "date-format"],
]
private let ISSUE_SOURCE = "# Our New Release Plan\n\nWe utilize the tool from 3/4/2026 onwards.\n"

private func setup(_ text: String, profile: JSONValue? = SKILL_PROFILE, brand: JSONValue? = nil, readOnly: String? = nil) throws -> (registry: ToolRegistry, buffer: MarkdownTextBuffer) {
    let buffer = MarkdownTextBuffer(text, readOnlyReason: readOnly)
    let registry = ToolRegistry()
    let style = profile == nil && brand == nil ? HouseStyle() : richTextHouseStyle(profileJson: profile, brandJson: brand)
    try registry.register(createMarkdownStyleToolProvider(buffer, style, MarkdownStyleToolOptions(namespace: "")))
    return (registry, buffer)
}

/// House style on Markdown against `domains/markdown-style` in `@pixerate/conformance`, and its tools.
final class MarkdownStyleTests: XCTestCase {
    func testCasesMatchTheContracts() throws {
        let data = try ConformanceContracts.data("domains/markdown-style/cases.json")
        let cases = try XCTUnwrap(JSONValue.parse(String(decoding: data, as: UTF8.self)).arrayValue)
        XCTAssertGreaterThanOrEqual(cases.count, 7)
        for c in cases {
            let name = c["name"]?.stringValue ?? "?"
            let source = try XCTUnwrap(c["source"]?.stringValue)
            let profile = try XCTUnwrap(c["profile"]?.objectValue)
            let expected = try XCTUnwrap(c["expected"])

            let blocks = markdownStyleState(source)
            let wantBlocks = expected["blocks"]?.arrayValue ?? []
            XCTAssertEqual(blocks.count, wantBlocks.count, "\(name): blocks")
            for (b, want) in zip(blocks, wantBlocks) {
                XCTAssertEqual(b.kind.rawValue, want["kind"]?.stringValue, name)
                XCTAssertEqual(b.level, want["level"]?.numberValue.map { Int($0) }, name)
                XCTAssertEqual(b.text, want["text"]?.stringValue, name)
                XCTAssertEqual(b.from, want["from"]?.numberValue.map { Int($0) }, name)
                XCTAssertEqual(b.to, want["to"]?.numberValue.map { Int($0) }, name)
            }

            let findings = markdownStyleFindings(source, profile: profile)
            let wantFindings = expected["findings"]?.arrayValue ?? []
            XCTAssertEqual(findings.count, wantFindings.count, "\(name): findings")
            for (f, want) in zip(findings, wantFindings) {
                XCTAssertEqual(f.check, want["check"]?.stringValue, name)
                XCTAssertEqual(f.severity, want["severity"]?.stringValue, name)
                XCTAssertEqual(f.message, want["message"]?.stringValue, name)
                XCTAssertEqual(f.target?.from, want["from"]?.numberValue.map { Int($0) }, "\(name): \(f.message)")
                XCTAssertEqual(f.target?.to, want["to"]?.numberValue.map { Int($0) }, "\(name): \(f.message)")
                XCTAssertEqual(f.target?.replacement, want["replacement"]?.stringValue, "\(name): \(f.message)")
            }

            let fixed = applyMarkdownStyleEdits(source, markdownStyleEdits(findings.map(\.target)).edits)
            XCTAssertEqual(fixed, expected["fixed"]?.stringValue, "\(name): fixed")
        }
    }

    func testApplyTextCase() {
        XCTAssertEqual(applyTextCase("the API Of acme", "sentence", properNouns: ["Acme"]), "The API of Acme")
        XCTAssertEqual(applyTextCase("Planning for Q3: The Next Steps", "sentence"), "Planning for Q3: The next steps")
        XCTAssertEqual(applyTextCase("a guide to the iOS app", "title"), "A Guide to the iOS App")
        XCTAssertEqual(applyTextCase("what we learned in 2026", "title"), "What We Learned in 2026")
        XCTAssertEqual(applyTextCase("Quiet", "upper"), "QUIET")
        XCTAssertEqual(applyTextCase("  spaced  out ", "title"), "  Spaced  Out ")
    }

    func testTheReaderSkipsWhatIsNotProse() {
        let source = "---\ntitle: x\n---\n\nRun `npm i` then $a$ and ![img](i.png) <b>x</b>.\n\n```js\nlet a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[ref]: http://example.com\n"
        let blocks = markdownStyleState(source)
        XCTAssertEqual(blocks.map(\.text), ["Run \(MARKDOWN_STYLE_ATOM) then \(MARKDOWN_STYLE_ATOM) and \(MARKDOWN_STYLE_ATOM) \(MARKDOWN_STYLE_ATOM)x\(MARKDOWN_STYLE_ATOM)."])
        XCTAssertEqual(markdownStyleState("About ~5 minutes, ~~not~~ more.").map(\.text), ["About ~5 minutes, not more."])
    }

    // MARK: Tools

    func testCheckThenFixTheIssueExample() async throws {
        let (registry, buffer) = try setup(ISSUE_SOURCE)
        XCTAssertEqual(registry.listTools().map(\.name), ["check_rich_text_style", "fix_rich_text_style"])
        let check = await registry.callTool("check_rich_text_style")
        XCTAssertFalse(check.isError)
        let report = try XCTUnwrap(check.structuredContent)
        XCTAssertEqual(report["ok"], false)
        XCTAssertEqual(report["fixable"], 2)
        XCTAssertEqual(report["ran"], ["heading-case", "terms", "date-format"])
        let findings = report["findings"]?.arrayValue ?? []
        XCTAssertEqual(findings.map { $0["check"]?.stringValue }, ["heading-case", "terms", "date-format"])
        XCTAssertEqual(findings.map { $0["text"]?.stringValue }, ["New Release Plan", "utilize", "3/4/2026"])
        XCTAssertEqual(findings[1]["layer"], "org")
        XCTAssertEqual(findings[1]["target"], ["from": 27, "to": 34, "replacement": "use"])

        let fix = await registry.callTool("fix_rich_text_style")
        XCTAssertFalse(fix.isError)
        let s = try XCTUnwrap(fix.structuredContent)
        XCTAssertEqual(s["fixed"], 2)
        XCTAssertEqual(s["edits"], [["from": 6, "to": 22, "replacement": "new release plan"], ["from": 27, "to": 34, "replacement": "use"]])
        XCTAssertEqual(s["left"]?.arrayValue?.map { $0["check"]?.stringValue }, ["date-format"])
        XCTAssertEqual(buffer.markdown, "# Our new release plan\n\nWe use the tool from 3/4/2026 onwards.\n")
        XCTAssertEqual(buffer.undoActionNames, ["Fix House Style"])
    }

    func testFixOnlyTheChecksAskedForAndRejectBadArguments() async throws {
        let (registry, buffer) = try setup(ISSUE_SOURCE)
        let fix = await registry.callTool("fix_rich_text_style", ["checks": ["terms"]])
        XCTAssertEqual(fix.structuredContent?["fixed"], 1)
        XCTAssertTrue(buffer.markdown.hasPrefix("# Our New Release Plan"))
        let empty = await registry.callTool("fix_rich_text_style", ["checks": []])
        XCTAssertTrue(empty.isError)
        let extra = await registry.callTool("check_rich_text_style", ["extra": 1])
        XCTAssertTrue(extra.isError)
    }

    func testBrandColourAndFontChecksAreSkipped() async throws {
        let (registry, _) = try setup("# Fine heading", profile: ["headingCase": "sentence", "checks": ["heading-case", "fonts-allowed"]], brand: ["colors": ["primary": "#123456"], "checks": ["palette-only"]])
        let result = await registry.callTool("check_rich_text_style")
        let report = try XCTUnwrap(result.structuredContent)
        XCTAssertEqual(report["ran"], ["heading-case"])
        XCTAssertEqual(report["skipped"], [
            ["check": "fonts-allowed", "reason": .string(MARKDOWN_NO_SURFACE_REASON)],
            ["check": "palette-only", "reason": .string(MARKDOWN_NO_SURFACE_REASON)],
        ])
    }

    func testReadOnlyTextOnlyChecks() async throws {
        let (registry, buffer) = try setup(ISSUE_SOURCE, readOnly: "The note is locked.")
        XCTAssertEqual(registry.listTools().map(\.name), ["check_rich_text_style"])
        var announced = 0
        let listening = registry.onListChanged { _ in announced += 1 }
        buffer.readOnlyReason = nil
        XCTAssertEqual(announced, 1)
        XCTAssertTrue(registry.hasTool("fix_rich_text_style"))
        listening.cancel()
    }

    func testNoHouseStyle() async throws {
        let (registry, _) = try setup("# Hi There", profile: nil)
        let result = await registry.callTool("check_rich_text_style")
        let report = try XCTUnwrap(result.structuredContent)
        XCTAssertEqual(report["ok"], true)
        XCTAssertEqual(report["note"], "No house style applies to documents.")
    }

    func testAnInvalidProfileIsAnIssue() async throws {
        let (registry, _) = try setup("# Hi", profile: ["headingCase": "shouty"])
        let result = await registry.callTool("check_rich_text_style")
        let report = try XCTUnwrap(result.structuredContent)
        XCTAssertEqual(report["issues"]?.arrayValue?.count, 1)
        XCTAssertTrue(report["issues"]?.arrayValue?.first?["message"]?.stringValue?.contains("rich-text.json is left out") == true)
    }
}
