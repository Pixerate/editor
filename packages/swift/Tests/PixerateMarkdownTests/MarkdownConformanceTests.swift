import Foundation
import XCTest
@testable import PixerateMarkdown

// Runs the shared Markdown editing corpus (packages/markdown-conformance/fixtures, read in place)
// against the editing engine (FormatCommandEdits, MarkdownFormatting, MarkdownEditingCommands).
// Fixtures address raw Markdown, so the text and range are used directly. The engine is Swash's,
// so a case's `variants.swash` and `skip.swash` apply to it.
//
// `edit.*` commands model an editor's key handling: when a command returns nil, the text view
// falls back to its default behaviour (Return inserts a newline, Backspace deletes, Tab inserts
// a tab, Shift-Tab does nothing), so the runner applies that default too. Backspace runs with
// the markers hidden, as in the Edit Text view the corpus describes.

struct ConformanceCase {
    let file: String
    let id: String
    let command: String
    let params: [String: Any]
    let input: String
    let expected: String
    let expectedNoop: Bool
    let skipReason: String?
}

/// Cases where the engine intentionally differs from the corpus, pending a `variants.swash` entry
/// in packages/markdown-conformance. Keep this list short; every entry needs a reason.
/// The engine edits Markdown source: in Edit Text, blank lines are visible lines, so Return adds one
/// line and Backspace removes one line, rather than splitting or joining paragraphs.
let localSkips: [String: String] = [
    "enter-splits-paragraph": "Return in a paragraph inserts one line break (\"Hello \\n‸world\"); Swash doesn't add a blank line or trim the space",
    "enter-at-end-of-heading": "Return after a heading starts the next line (\"## Title\\n‸\"); the line is already a new paragraph, so no blank line is added",
    "backspace-joins-paragraphs": "Backspace at the start of a paragraph removes the blank line before it (\"Hello\\n‸world\"); a second Backspace joins the lines",
]

enum Marker {
    static let caret: unichar = 0x2038      // ‸
    static let rangeStart: unichar = 0x27E6 // ⟦
    static let rangeEnd: unichar = 0x27E7   // ⟧
}

/// Removes the selection markers and returns the text with the selection as a UTF-16 range.
func parseSelection(_ marked: String) -> (text: String, selection: NSRange)? {
    let units = Array(marked.utf16)
    var stripped: [unichar] = []
    var caret: Int?, start: Int?, end: Int?
    for unit in units {
        switch unit {
        case Marker.caret: guard caret == nil else { return nil }; caret = stripped.count
        case Marker.rangeStart: guard start == nil else { return nil }; start = stripped.count
        case Marker.rangeEnd: guard end == nil else { return nil }; end = stripped.count
        default: stripped.append(unit)
        }
    }
    let text = String(utf16CodeUnits: stripped, count: stripped.count)
    switch (caret, start, end) {
    case (let c?, nil, nil): return (text, NSRange(location: c, length: 0))
    case (nil, let s?, let e?) where e >= s: return (text, NSRange(location: s, length: e - s))
    default: return nil
    }
}

/// Puts the selection markers back into `text`.
func marked(_ text: String, selection: NSRange) -> String {
    let ns = text as NSString
    guard selection.location >= 0, NSMaxRange(selection) <= ns.length else { return text + " ⚠️ selection \(selection) out of bounds" }
    if selection.length == 0 {
        return ns.replacingCharacters(in: selection, with: "‸")
    }
    let withEnd = ns.replacingCharacters(in: NSRange(location: NSMaxRange(selection), length: 0), with: "⟧") as NSString
    return withEnd.replacingCharacters(in: NSRange(location: selection.location, length: 0), with: "⟦")
}

func paramValues(_ params: [String: Any]) -> [String: FormatParamValue] {
    var result: [String: FormatParamValue] = [:]
    for (key, value) in params {
        switch value {
        case is NSNull: result[key] = .null
        case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID(): result[key] = .bool(number.boolValue)
        case let number as NSNumber: result[key] = .int(number.intValue)
        case let string as String: result[key] = .string(string)
        default: break
        }
    }
    return result
}

enum Outcome {
    case edit(MarkdownEdit)
    case noEdit
    case unsupported(String)
}

/// The text view's default handling when a key command returns nil.
func fallback(_ command: String, text: String, selection: NSRange) -> MarkdownEdit? {
    let ns = text as NSString
    switch command {
    case "edit.newline":
        return MarkdownEdit(text: ns.replacingCharacters(in: selection, with: "\n"), selection: NSRange(location: selection.location + 1, length: 0))
    case "edit.indent":
        return MarkdownEdit(text: ns.replacingCharacters(in: selection, with: "\t"), selection: NSRange(location: selection.location + 1, length: 0))
    case "edit.backspace":
        if selection.length > 0 {
            return MarkdownEdit(text: ns.replacingCharacters(in: selection, with: ""), selection: NSRange(location: selection.location, length: 0))
        }
        guard selection.location > 0 else { return nil }
        let deleted = ns.rangeOfComposedCharacterSequence(at: selection.location - 1)
        return MarkdownEdit(text: ns.replacingCharacters(in: deleted, with: ""), selection: NSRange(location: deleted.location, length: 0))
    default:
        return nil
    }
}

func runCase(_ c: ConformanceCase, text: String, selection: NSRange) -> Outcome {
    let params = paramValues(c.params)
    switch c.command {
    case "edit.newline", "edit.indent", "edit.outdent", "edit.backspace":
        let edit: MarkdownEdit?
        switch c.command {
        case "edit.newline": edit = MarkdownEditingCommands.newline(text: text, selection: selection)
        case "edit.indent": edit = MarkdownEditingCommands.indent(text: text, selection: selection)
        case "edit.outdent": edit = MarkdownEditingCommands.outdent(text: text, selection: selection)
        default: edit = MarkdownEditingCommands.backspace(text: text, selection: selection, markersHidden: true)
        }
        if let edit = edit ?? fallback(c.command, text: text, selection: selection) { return .edit(edit) }
        return .noEdit
    case "format.link":
        let url = params["url"]?.stringValue
        return FormatCommandEdits.link(url, text: text, selection: selection).map(Outcome.edit) ?? .noEdit
    case "format.codeBlock" where params["language"] != nil:
        let language = params["language"]?.stringValue
        return FormatCommandEdits.codeBlock(language: language, text: text, selection: selection).map(Outcome.edit) ?? .noEdit
    default:
        guard c.command.hasPrefix("format."), let command = FormatCommand(manifestID: c.command, params: params) else {
            return .unsupported("no FormatCommand for \(c.command) \(c.params)")
        }
        return FormatCommandEdits.edit(for: command, text: text, selection: selection).map(Outcome.edit) ?? .noEdit
    }
}

struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

func loadCases(from directory: URL) throws -> [ConformanceCase] {
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
        .filter { $0.hasSuffix(".json") }.sorted()
    guard !files.isEmpty else {
        throw FixtureError(description: "No fixtures in \(directory.path)")
    }
    var cases: [ConformanceCase] = []
    for file in files {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(file)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = json["cases"] as? [[String: Any]] else {
            throw FixtureError(description: "Could not load \(file)")
        }
        for item in list {
            guard let id = item["id"] as? String, let command = item["command"] as? String,
                  let input = item["input"] as? String, let expected = item["expected"] as? String else {
                throw FixtureError(description: "\(file): malformed case \(item["id"] ?? "?")")
            }
            let variants = item["variants"] as? [String: Any]
            let skip = item["skip"] as? [String: Any]
            cases.append(ConformanceCase(
                file: file, id: id, command: command,
                params: item["params"] as? [String: Any] ?? [:],
                input: input,
                expected: variants?["swash"] as? String ?? expected,
                expectedNoop: item["expectedNoop"] as? Bool ?? false,
                skipReason: (skip?["swash"] as? String) ?? localSkips[id].map { "\($0) (local skip)" }
            ))
        }
    }
    return cases
}

final class MarkdownConformanceTests: XCTestCase {
    /// packages/markdown-conformance/fixtures, from this file's place in the repository.
    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../markdown-conformance/fixtures")
        .standardizedFileURL

    func testCorpus() throws {
        let cases = try loadCases(from: Self.fixtures)
        XCTAssertFalse(cases.isEmpty)
        for id in localSkips.keys.sorted() {
            XCTAssert(cases.contains { $0.id == id }, "local skip \(id) matches no case; remove it from localSkips")
        }
        var passed = 0, skipped = 0
        for c in cases {
            if c.skipReason != nil {
                skipped += 1
                continue
            }
            let context = "[\(c.id)] \(c.file) \(c.command)\(c.params.isEmpty ? "" : " \(c.params)") on \(c.input.debugDescription)"
            guard let input = parseSelection(c.input), let expected = parseSelection(c.expected) else {
                XCTFail("\(context): invalid selection markers")
                continue
            }
            switch runCase(c, text: input.text, selection: input.selection) {
            case .unsupported(let reason):
                XCTFail("\(context): \(reason)")
            case .noEdit:
                if c.expectedNoop { passed += 1 } else { XCTFail("\(context): no edit, expected \(c.expected.debugDescription)") }
            case .edit(let edit):
                if edit.text == expected.text && edit.selection == expected.selection {
                    passed += 1
                } else {
                    XCTFail("\(context): got \(marked(edit.text, selection: edit.selection).debugDescription), expected \(c.expected.debugDescription)")
                }
            }
        }
        print("Markdown conformance (@pixerate/markdown-conformance \(FormatManifest.version)): \(passed) passed, \(skipped) skipped")
    }

    /// The code-language menu maps the manifest's languages onto CodeHighlighter's.
    func testManifestCodeLanguagesAreHighlighted() {
        for language in FormatManifest.codeLanguages {
            XCTAssertNotNil(CodeLanguage(name: language.id), "manifest code language \(language.id) has no CodeLanguage; add it to CodeHighlighter")
        }
    }

    /// The generated manifest is from the corpus in this repository.
    func testManifestVersionMatchesPackage() throws {
        let url = Self.fixtures.deletingLastPathComponent().appendingPathComponent("package.json")
        let package = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(FormatManifest.version, package["version"] as? String, "run node scripts/gen-swift-markdown.mjs")
    }
}
