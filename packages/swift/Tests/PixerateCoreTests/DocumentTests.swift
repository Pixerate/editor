import XCTest
@testable import PixerateCore

private struct Rejected: Error, CustomStringConvertible { var description: String }

/// A tiny editor for the envelope tests: its document is `{ "items": [...] }`.
private final class ListEditor {
    var items: [JSONValue] = []
    let history = HistoryManager()
    var loads: [EditorDocumentLoadHistory] = []
}

final class DocumentTests: XCTestCase {
    private func document(_ editor: ListEditor, formatVersion: Int = 2) throws -> EditorDocument {
        try EditorDocument(EditorDocumentSpec(
            kind: "list",
            formatVersion: formatVersion,
            get: { ["items": .array(editor.items)] },
            load: { doc, history in
                guard let items = doc["items"]?.arrayValue else { throw Rejected(description: "The list document has no items array.") }
                editor.items = items
                editor.loads.append(history)
                return []
            },
            // Version 1 called the array "entries".
            migrations: [1: { old in
                var o = old.objectValue ?? JSONObject()
                o["items"] = o["entries"] ?? []
                o["entries"] = nil
                return .object(o)
            }],
            history: editor.history))
    }

    func testTheEnvelopeIsWrittenAsTheTSCoreWritesIt() throws {
        let editor = ListEditor()
        editor.items = ["a", 1]
        let file = try document(editor).file(name: "Shopping")
        XCTAssertEqual(file.serialized(), #"{"format":"pixerate.editor-document","kind":"list","formatVersion":2,"name":"Shopping","document":{"items":["a",1]}}"#)
        XCTAssertEqual(try EditorDocumentFile.parse(file.serialized(space: 2)), file)
    }

    func testParsingRefusesWhatIsNotADocumentOfThisKind() {
        XCTAssertThrowsError(try EditorDocumentFile.parse("{nope")) { XCTAssertTrue(($0 as! EditorDocumentLoadError).message.hasPrefix("The file is not valid JSON: ")) }
        XCTAssertThrowsError(try EditorDocumentFile.parse(#"{"kind":"list"}"#)) {
            XCTAssertEqual(($0 as! EditorDocumentLoadError).message, #"The file is not a saved editor document (expected "format": "pixerate.editor-document")."#)
        }
        let paint = #"{"format":"pixerate.editor-document","kind":"paint","formatVersion":1,"document":{}}"#
        XCTAssertThrowsError(try EditorDocumentFile.parse(paint, kind: "list")) { XCTAssertEqual(($0 as! EditorDocumentLoadError).message, "The file is a paint document, not a list document.") }
    }

    func testLoadingMigratesOlderFilesStepByStep() throws {
        let editor = ListEditor()
        let doc = try document(editor)
        let old = EditorDocumentFile(kind: "list", formatVersion: 1, document: ["entries": ["x", "y"]])
        let report = try doc.loadDocument(old.json, history: .record)
        XCTAssertEqual(report.migratedFrom, 1)
        XCTAssertEqual(report.version, 1)
        XCTAssertEqual(editor.items, ["x", "y"])
        XCTAssertEqual(editor.loads, [.record])
        // A raw document loads as it is.
        XCTAssertNil(try doc.loadDocument(["items": ["z"]]).migratedFrom)
        XCTAssertEqual(editor.items, ["z"])
    }

    func testLoadingRefusesNewerFilesOtherKindsAndBadDocumentsWithoutChangingAnything() throws {
        let editor = ListEditor()
        editor.items = ["keep"]
        let doc = try document(editor)
        XCTAssertThrowsError(try doc.loadDocument(EditorDocumentFile(kind: "list", formatVersion: 9, document: ["items": []]).json)) {
            let e = $0 as! EditorDocumentLoadError
            XCTAssertEqual(e.message, "Cannot open the list document: document has version 9, newer than the supported 2.")
            XCTAssertEqual(e.report?.readOnly?.kind, "newerVersion")
        }
        XCTAssertThrowsError(try doc.loadDocument(EditorDocumentFile(kind: "paint", formatVersion: 2, document: [:]).json)) {
            XCTAssertEqual(($0 as! EditorDocumentLoadError).message, "This is a paint document; it cannot be opened in the list editor.")
        }
        XCTAssertThrowsError(try doc.loadDocument(["wrong": true])) { XCTAssertEqual(($0 as! EditorDocumentLoadError).message, "The list document has no items array.") }
        XCTAssertThrowsError(try doc.loadDocument(.null)) { XCTAssertEqual(($0 as! EditorDocumentLoadError).message, "No list document was given.") }
        XCTAssertEqual(editor.items, ["keep"])
        XCTAssertThrowsError(try EditorDocument(EditorDocumentSpec(kind: "Bad Kind", get: { .null }, load: { _, _ in [] }, history: editor.history)))
    }

    func testRevisionsAndListeners() throws {
        let doc = try document(ListEditor())
        var heard = 0
        let off = doc.subscribe { heard += 1 }
        doc.changed()
        doc.changed()
        off.cancel()
        doc.changed()
        XCTAssertEqual(doc.revision, 3)
        XCTAssertEqual(heard, 2)
    }

    func testSectionsKeepGoodValuesAndReportBadOnes() {
        let sections = [
            SectionSpec("theme", parse: { $0.stringValue.map(JSONValue.string) }, defaults: { "light" }),
            SectionSpec("zoom", parse: { v in
                guard let n = v.numberValue, n > 0 else { throw Rejected(description: "zoom must be a positive number") }
                return .number(n)
            }, defaults: { 1 }),
            SectionSpec("grid", parse: { $0.boolValue.map(JSONValue.bool) }, defaults: { true }),
        ]
        let result = loadDocument(.text(#"{"version":1,"theme":"dark","zoom":-2,"plugins":["x"],"__proto__":{"evil":1}}"#), sections, MigrateOptions(currentVersion: 1))
        XCTAssertEqual(result.value, ["theme": "dark", "zoom": 1, "grid": true])
        XCTAssertEqual(result.problems, [SectionProblem(section: "zoom", message: "zoom must be a positive number")])
        XCTAssertEqual(result.unknown, ["plugins": ["x"]])
        XCTAssertEqual(result.report.unknownKeys, ["plugins"])
        XCTAssertTrue(result.report.hasProblems)
        // Not JSON at all: every section takes its defaults and the document is read-only.
        let bad = loadDocument(.text("[1]"), sections, MigrateOptions(currentVersion: 1))
        XCTAssertEqual(bad.report.readOnly?.kind, "invalid")
        XCTAssertEqual(bad.value["theme"], "light")
    }
}
