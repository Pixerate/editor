import Foundation
import PixerateContracts
import PixerateMarkdown
import XCTest

/// The text mechanics checks against the scenarios recorded from the TypeScript core
/// (`@pixerate/conformance`, `domains/text-mechanics`).
final class TextMechanicsTests: XCTestCase {
    private struct Manifest: Decodable {
        var lexicon: [String: TextMechanicsWordClass]
        var checks: [Check]
        struct Check: Decodable {
            var id: String
            var title: String
        }
    }

    private struct Scenario: Decodable {
        var name: String
        var typed: String
        var after: String?
        var suffix: String?
        var profile: String?
        var disabled: [TextMechanicsCheck]?
        var spelling: [String: String]?
        var lexicon: [String: TextMechanicsWordClass]?
        var expect: Expect
        struct Expect: Decodable {
            var text: String
            var checks: [TextMechanicsCheck]
        }
    }

    private struct CheckedCase: Decodable {
        var text: String
        var boundary: Int
        var expect: Range?
        struct Range: Decodable {
            var from: Int
            var to: Int
        }
    }

    private struct FindingsCase: Decodable {
        var name: String
        var text: String
        var expect: [Finding]
        struct Finding: Decodable {
            var from: Int
            var to: Int
            var replacement: String
            var checks: [TextMechanicsCheck]
        }
    }

    private func load<T: Decodable>(_ file: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(contentsOf: ConformanceContracts.url("domains/text-mechanics/\(file)")))
    }

    private func options(_ scenario: Scenario, lexicon: [String: TextMechanicsWordClass]) -> TextMechanicsOptions {
        let disabled = Set(scenario.disabled ?? [])
        let spelling = scenario.spelling
        return TextMechanicsOptions(
            profile: scenario.profile == "chat" ? .chat : .prose,
            enabled: { !disabled.contains($0) },
            spelling: spelling.map { table in { word, _, _ in table[word] } },
            tagger: TextMechanics.lexiconTagger(lexicon.merging(scenario.lexicon ?? [:]) { _, new in new })
        )
    }

    /// Types the scenario one code point at a time, applying every fix, as the TypeScript harness does.
    private func play(_ scenario: Scenario, lexicon: [String: TextMechanicsWordClass]) -> (text: String, checks: [TextMechanicsCheck]) {
        let suffix = scenario.suffix ?? ""
        let options = options(scenario, lexicon: lexicon)
        var text = scenario.after ?? ""
        var checks: [TextMechanicsCheck] = []
        for scalar in scenario.typed.unicodeScalars {
            let character = String(scalar)
            text += character
            let boundary = text.utf16.count - character.utf16.count
            let full = text + suffix
            let edits = TextMechanics.edits(at: boundary, in: full, document: MarkdownDocument.parse(full), options: options)
                .sorted { $0.range.location > $1.range.location }
            for edit in edits { checks += edit.checks }
            let updated = TextMechanics.apply(edits, to: full) as NSString
            text = updated.substring(to: updated.length - (suffix as NSString).length)
        }
        return (text + suffix, checks)
    }

    func testTypingScenariosMatchTheContracts() throws {
        let manifest = try load("manifest.json", as: Manifest.self)
        let scenarios = try load("typing.json", as: [Scenario].self)
        XCTAssertGreaterThan(scenarios.count, 70)
        for scenario in scenarios {
            let result = play(scenario, lexicon: manifest.lexicon)
            XCTAssertEqual(result.text, scenario.expect.text, scenario.name)
            XCTAssertEqual(result.checks, scenario.expect.checks, scenario.name)
        }
    }

    func testChecksMatchTheManifest() throws {
        let manifest = try load("manifest.json", as: Manifest.self)
        XCTAssertEqual(manifest.checks.map(\.id), TextMechanicsCheck.allCases.map(\.rawValue))
        XCTAssertEqual(manifest.checks.map(\.title), TextMechanicsCheck.allCases.map(\.title))
    }

    func testCheckedRangesMatchTheContracts() throws {
        for item in try load("checked-ranges.json", as: [CheckedCase].self) {
            let range = TextMechanics.checkedRange(at: item.boundary, in: item.text, document: MarkdownDocument.parse(item.text))
            XCTAssertEqual(range.map { [$0.location, NSMaxRange($0)] }, item.expect.map { [$0.from, $0.to] }, item.text.debugDescription)
        }
    }

    func testFindingsMatchTheContracts() throws {
        let manifest = try load("manifest.json", as: Manifest.self)
        for item in try load("findings.json", as: [FindingsCase].self) {
            let found = TextMechanics.findings(in: item.text, options: TextMechanicsOptions(tagger: TextMechanics.lexiconTagger(manifest.lexicon)))
            XCTAssertEqual(found.map(\.range.location), item.expect.map(\.from), item.name)
            XCTAssertEqual(found.map { NSMaxRange($0.range) }, item.expect.map(\.to), item.name)
            XCTAssertEqual(found.map(\.replacement), item.expect.map(\.replacement), item.name)
            XCTAssertEqual(found.map(\.checks), item.expect.map(\.checks), item.name)
        }
    }

    func testTheSystemTaggerReadsContractions() {
        // The system tagger tags every word with a class
        let words = TextMechanics.naturalLanguageTagger("I tried but it failed")
        XCTAssertEqual(words.map(\.range.length), [1, 5, 3, 2, 6])
        XCTAssertTrue(words.contains { $0.tag == .verb })
        #if os(macOS)
        // macOS's model, as Swash uses it: "id" before "like" is "I'd"; "the id field" stays. (The
        // iOS model reads "id like" differently, so the scenarios use a fixed lexicon instead.)
        let typed = "for now id like "
        let edits = TextMechanics.edits(at: (typed as NSString).length - 1, in: typed, document: MarkdownDocument.parse(typed),
                                        options: TextMechanicsOptions(tagger: TextMechanics.naturalLanguageTagger))
        XCTAssertTrue(edits.contains { $0.replacement == "I'd" }, "\(edits)")
        let noun = "the id field "
        let kept = TextMechanics.edits(at: (noun as NSString).length - 1, in: noun, document: MarkdownDocument.parse(noun),
                                       options: TextMechanicsOptions(tagger: TextMechanics.naturalLanguageTagger))
        XCTAssertFalse(kept.contains { $0.replacement == "I'd" })
        #endif
    }
}
