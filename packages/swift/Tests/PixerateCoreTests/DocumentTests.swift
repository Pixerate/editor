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

    func testAssetReferencesAreContentAddressedAsInTheTSCore() throws {
        let registry = EditorAssetRegistry()
        let png = "data:image/png;base64," + String(repeating: "A", count: 600)
        let ref = registry.put(png)
        // `pixerate-asset:<length base 36>-<cyrb53 base 36>`, as `createEditorAssetRegistry` writes it.
        // The references the TS core's `createEditorAssetRegistry().put` returns for the same data.
        XCTAssertEqual(ref, "pixerate-asset:ha-1i2o24ecw4e")
        XCTAssertEqual(EditorAssetRegistry().put(""), "pixerate-asset:0-wvjl67o803")
        XCTAssertEqual(EditorAssetRegistry().put("x"), "pixerate-asset:1-49fp6jq86t")
        XCTAssertEqual(registry.put(png), ref)
        XCTAssertEqual(registry.size, 1)
        XCTAssertFalse(isInlineAsset("data:image/png;base64,short"))
        XCTAssertTrue(isInlineAsset(String(repeating: "Q", count: 4096)))
        let document: JSONValue = ["layers": [["asset": .string(png), "name": "a"]], "again": .string(png), "small": "data:x"]
        let out = externalizeAssets(document, registry)
        XCTAssertEqual(out, ["layers": [["asset": .string(ref), "name": "a"]], "again": .string(ref), "small": "data:x"])
        XCTAssertEqual(collectAssetRefs(out), [ref])
        XCTAssertEqual(try internalizeAssets(out, registry), document)
        XCTAssertThrowsError(try internalizeAssets(["a": "pixerate-asset:1-a", "b": "pixerate-asset:2-b~1"], EditorAssetRegistry())) {
            XCTAssertEqual(errorMessage($0), "The document refers to 2 assets that are not loaded (pixerate-asset:1-a, pixerate-asset:2-b~1). Pass a document from get_*_document in this session, or open it from storage so its assets are read first.")
        }
    }

    func testDocumentsWithAssetsKeepTheirDataOutOfTheJSON() throws {
        let editor = ListEditor()
        let blob = String(repeating: "QUJD", count: 1100)
        editor.items = [.string(blob)]
        let assets = EditorAssetRegistry()
        let doc = try EditorDocument(EditorDocumentSpec(
            kind: "list",
            get: { ["items": .array(editor.items)] },
            load: { d, _ in
                editor.items = d["items"]?.arrayValue ?? []
                return []
            },
            history: editor.history,
            assets: assets))
        let saved = doc.getDocument()
        XCTAssertEqual(saved["items"]?.arrayValue?.first?.stringValue?.hasPrefix(editorAssetPrefix), true)
        editor.items = []
        try doc.loadDocument(saved)
        XCTAssertEqual(editor.items, [.string(blob)])
        // A reference that is not loaded refuses the load and changes nothing.
        XCTAssertThrowsError(try doc.loadDocument(["items": ["pixerate-asset:zz-zz"]])) {
            XCTAssertTrue(($0 as! EditorDocumentLoadError).message.hasPrefix("The document refers to 1 asset that is not loaded (pixerate-asset:zz-zz)."))
        }
        XCTAssertEqual(editor.items, [.string(blob)])
    }

    func testRevisionsFollowTheEditorsSubscription() throws {
        var listener: (() -> Void)?
        let editor = ListEditor()
        let doc = try EditorDocument(EditorDocumentSpec(kind: "list", get: { .null }, load: { _, _ in [] }, history: editor.history, subscribe: { l in
            listener = l
            return Cancellable { listener = nil }
        }))
        listener?()
        listener?()
        XCTAssertEqual(doc.revision, 2)
        doc.destroy()
        XCTAssertNil(listener)
        // Changes made while disconnected were not counted, so a reconnect is a new revision.
        XCTAssertEqual(doc.revision, 3)
        XCTAssertNotNil(listener)
    }

    func testTheDocumentToolsGetLoadUndoAndRedo() async throws {
        let editor = ListEditor()
        var readOnly: String?
        let doc = try EditorDocument(EditorDocumentSpec(
            kind: "shopping_list",
            get: { ["items": .array(editor.items)] },
            load: { d, history in
                guard let items = d["items"]?.arrayValue else { throw Rejected(description: "The list document has no items array.") }
                let before = editor.items
                if history == .record {
                    editor.history.execute(Command(name: "Open list", execute: { editor.items = items }, undo: { editor.items = before }))
                } else {
                    editor.items = items
                }
                return [SectionProblem(section: "items", message: "repaired")]
            },
            history: editor.history,
            readOnly: { readOnly }))
        let registry = ToolRegistry(validateArguments: true)
        let provider = createDocumentToolProvider(doc, DocumentToolProviderOptions(namespace: ""))
        XCTAssertEqual(provider.id, "shopping_list-document")
        XCTAssertEqual(provider.title, "Shopping list document")
        XCTAssertEqual(provider.description, "Get, load, undo, redo the whole shopping list.")
        _ = try registry.register(provider)
        XCTAssertEqual(registry.listTools().map(\.name), ["get_shopping_list_document", "load_shopping_list_document", "undo_shopping_list", "redo_shopping_list"])
        XCTAssertEqual(registry.getTool("get_shopping_list_document")?.annotations, ToolAnnotations(title: "Get the shopping list document", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false))

        let empty = await registry.callTool("undo_shopping_list")
        XCTAssertEqual(empty.structuredContent?["error"]?["message"], "Nothing to undo.")
        let loaded = await registry.callTool("load_shopping_list_document", ["document": ["items": ["milk"]]])
        XCTAssertEqual(loaded.structuredContent, ["revision": 0, "undoable": true, "problems": [["section": "items", "message": "repaired"]]])
        let got = await registry.callTool("get_shopping_list_document")
        XCTAssertEqual(got.structuredContent, ["kind": "shopping_list", "formatVersion": 1, "revision": 0, "document": ["items": ["milk"]]])
        let undone = await registry.callTool("undo_shopping_list")
        XCTAssertEqual(undone.structuredContent, ["undone": "Open list", "revision": 0, "canUndo": false, "canRedo": true, "redoName": "Open list"])
        XCTAssertEqual(editor.items, [])
        let redone = await registry.callTool("redo_shopping_list")
        XCTAssertEqual(redone.structuredContent, ["redone": "Open list", "revision": 0, "canUndo": true, "canRedo": false, "undoName": "Open list"])
        let bad = await registry.callTool("load_shopping_list_document", ["document": ["nope": 1]])
        XCTAssertEqual(bad.structuredContent?["error"]?["message"], "The list document has no items array.")
        let invalid = await registry.callTool("load_shopping_list_document", ["document": "milk"])
        XCTAssertTrue(invalid.isError)
        readOnly = "The list is locked."
        let refused = await registry.callTool("load_shopping_list_document", ["document": ["items": []]])
        XCTAssertEqual(refused.structuredContent?["error"]?["message"], "The list is locked. Read tools still work; write tools are refused.")
        let stillReads = await registry.callTool("get_shopping_list_document")
        XCTAssertFalse(stillReads.isError)
        XCTAssertEqual(editor.items, ["milk"])
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
