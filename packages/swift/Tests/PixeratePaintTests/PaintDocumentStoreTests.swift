import Foundation
import PixerateConformance
import PixerateContracts
import PixerateCore
import XCTest
@testable import PixeratePaint

/// A `PaintAssetStore` in memory that counts its puts (as the TS tests' stores do).
private final class MemoryPaintStore: PaintAssetStore {
    var puts: [(id: String, width: Int, height: Int, size: Int)] = []
    var data: [String: [UInt8]] = [:]
    var failing: Set<String> = []

    func put(_ png: [UInt8], id: String, width: Int, height: Int) async throws -> String {
        puts.append((id, width, height, png.count))
        let ref = "mem:\(puts.count)"
        data[ref] = png
        return ref
    }

    func get(_ ref: String) async throws -> [UInt8] {
        if failing.contains(ref) { throw PaintEditorError("offline") }
        guard let bytes = data[ref] else { throw PaintEditorError("no such asset") }
        return bytes
    }
}

/// A 1 × 1 PNG (its asset id in the TS core is `ext-380f6147-3a`).
private let ONE_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/// External asset stores, the editor document envelope and the paint document tools (#742).
final class PaintDocumentStoreTests: XCTestCase {
    private let stroke: JSONObject = [
        "points": [["x": 4, "y": 6, "pressure": 0.3], ["x": 20, "y": 12, "pressure": 0.8], ["x": 42, "y": 26, "pressure": 0.5]],
        "seed": 3, "color": "#0a6040",
    ]

    private func painted() async throws -> PaintEditorController {
        let c = try PaintEditorController(width: 48, height: 32)
        let registry = ToolRegistry(validateArguments: true)
        _ = try registry.register(createPaintEditorToolProvider(c))
        let r = await registry.callTool("paint_stroke", stroke)
        XCTAssertFalse(r.isError)
        return c
    }

    func testTheDocumentToolsScenarioMatchesTheTypeScriptRecording() async throws {
        guard let scenario = try ConformanceScenario.load(domain: "paint").first(where: { $0.id == "document-tools" }) else { return XCTFail("no document-tools scenario") }
        let outputs = try await runConformanceScenario(scenario, host: PaintConformanceHost(setup: scenario.setup))
        let mismatches = compareConformance(scenario, outputs) { try decodeConformancePNG(Data(contentsOf: $0)) }
        for m in mismatches { XCTFail(m.description) }
    }

    func testTheDocumentStoreScenarioMatchesTheTypeScriptRecording() async throws {
        guard let scenario = try ConformanceScenario.load(domain: "paint").first(where: { $0.id == "document-store" }) else { return XCTFail("no document-store scenario") }
        XCTAssertNil(scenario.skip["swift"])
        let outputs = try await runConformanceScenario(scenario, host: PaintConformanceHost(setup: scenario.setup))
        let mismatches = compareConformance(scenario, outputs) { try decodeConformancePNG(Data(contentsOf: $0)) }
        for m in mismatches { XCTFail(m.description) }
    }

    func testASavedPaintingReopensInAnotherEditorThroughTheStore() async throws {
        let c = try await painted()
        let storage = MemoryEditorStorage()
        let store = createEditorDocumentStore(EditorDocumentStoreOptions(storage: storage))
        let registry = ToolRegistry(validateArguments: true)
        _ = try registry.register(createPaintDocumentToolProvider(c, store: store))
        let saved = await registry.callTool("save_paint_document", ["name": "Sketch"])
        XCTAssertEqual(saved.structuredContent?["key"], "paint/sketch")
        XCTAssertEqual(storage.orderedKeys.filter { $0.hasPrefix("pixerate.assets:") }.count, 1)

        // Another editor with a registry of its own reads the layer pixels back from storage.
        let d = try PaintEditorController(width: 8, height: 8)
        let other = ToolRegistry(validateArguments: true)
        _ = try other.register(createPaintDocumentToolProvider(d, store: store))
        let session = try d.beginStroke()
        let busy = await other.callTool("open_saved_paint_document", ["key": "paint/sketch"])
        XCTAssertEqual(busy.structuredContent?["error"]?["message"], "A stroke is in progress; end or cancel it first. Read tools still work; write tools are refused.")
        session.cancel()
        let opened = await other.callTool("open_saved_paint_document", ["key": "paint/sketch"])
        XCTAssertEqual(opened.structuredContent, ["key": "paint/sketch", "name": "Sketch", "revision": 1, "undoable": false])
        XCTAssertEqual(d.toJSON(), c.toJSON())
    }

    func testTheProviderListsTheContractsTools() throws {
        let c = try PaintEditorController(width: 16, height: 16)
        // The contract lists the tools of a host with a document store (as the TS demo's paint tab).
        let provider = try createPaintDocumentToolProvider(c, store: PaintConformanceHost.documentStore())
        guard let contract = try PaintContracts.toolProviders().first(where: { $0.id == "paint-document" }) else { return XCTFail("no paint-document provider in tools.json") }
        XCTAssertEqual(provider.id, contract.id)
        XCTAssertEqual(provider.title, contract.title)
        XCTAssertEqual(provider.skill, contract.skill)
        let registry = ToolRegistry()
        _ = try registry.register(provider)
        XCTAssertEqual(registry.listTools(), contract.tools)
    }

    func testToolsReportRevisionsAndRefuseMidStroke() async throws {
        let c = try await painted()
        let registry = ToolRegistry(validateArguments: true)
        let doc = try createPaintEditorDocument(c)
        _ = try registry.register(createPaintDocumentToolProvider(doc))
        let got = await registry.callTool("get_paint_document")
        XCTAssertFalse(got.isError)
        XCTAssertEqual(got.structuredContent?["revision"], 0)
        let document = try XCTUnwrap(got.structuredContent?["document"])
        XCTAssertTrue(document.stringified().contains(editorAssetPrefix))
        XCTAssertFalse(document.stringified().contains("data:image/png"))
        let loaded = await registry.callTool("load_paint_document", ["document": document])
        XCTAssertEqual(loaded.structuredContent, ["revision": 1, "undoable": false])
        // Arguments are checked against the schema first.
        let missing = await registry.callTool("load_paint_document", [:])
        XCTAssertTrue(missing.isError)
        // Mid-stroke the painting cannot be replaced; reading still works.
        let session = try c.beginStroke()
        let busy = await registry.callTool("load_paint_document", ["document": document])
        XCTAssertTrue(busy.isError)
        XCTAssertEqual(busy.structuredContent?["error"]?["message"], "A stroke is in progress; end or cancel it first. Read tools still work; write tools are refused.")
        let read = await registry.callTool("get_paint_document")
        XCTAssertFalse(read.isError)
        session.cancel()
        // A document over the limit is refused with the size.
        let small = createDocumentToolProvider(doc, DocumentToolProviderOptions(id: "small", namespace: "small", history: false, maxChars: 10))
        _ = try registry.register(small)
        let big = await registry.callTool("small__get_paint_document")
        XCTAssertTrue(big.isError)
        XCTAssertTrue(big.structuredContent?["error"]?["message"]?.stringValue?.hasSuffix("characters of JSON, over the 10 limit for this tool. Use the editor's read tools to look at parts of it.") == true)
    }

    func testEditorDocumentOutputReopensThroughItsAssets() async throws {
        let c = try await painted()
        let assets = EditorAssetRegistry()
        let file = c.editorDocument(assets: assets, name: "Sketch")
        XCTAssertEqual(file["format"], .string(editorDocumentFormat))
        XCTAssertEqual(file["name"], "Sketch")
        XCTAssertEqual(assets.size, 1)

        // Without the assets, nothing changes and the error names them.
        let other = try PaintEditorController(width: 8, height: 8)
        XCTAssertThrowsError(try other.openEditorDocument(file, assets: EditorAssetRegistry())) {
            let message = ($0 as! EditorDocumentLoadError).message
            XCTAssertTrue(message.hasPrefix("The document refers to 1 asset that is not loaded (pixerate-asset:"), message)
        }
        XCTAssertEqual(other.doc.canvas.width, 8)

        // Through storage: the assets are written, then read back into a new registry.
        let storage = MemoryEditorStorage()
        try await persistEditorAssets(storage, assets, file)
        XCTAssertEqual(storage.values.count, 1)
        XCTAssertTrue(storage.values.keys.allSatisfy { $0.hasPrefix("pixerate.assets:") })
        let reread = EditorAssetRegistry()
        let missing = try await preloadEditorAssets(storage, reread, file)
        XCTAssertEqual(missing, [])
        let report = try other.openEditorDocument(file, assets: reread)
        XCTAssertNil(report.migratedFrom)
        XCTAssertEqual(other.toJSON(), c.toJSON())
        let notStored = try await preloadEditorAssets(MemoryEditorStorage(), EditorAssetRegistry(), file)
        XCTAssertEqual(notStored.count, 1)
    }

    func testExternalStoresWriteWhatTheTypeScriptCoreWrites() async throws {
        let c = try await painted()
        var saved = c.toJSON()
        let layerAssets = try XCTUnwrap(saved["assets"]?.objectValue)
        let layerUrl = try XCTUnwrap(layerAssets.keys.first.flatMap { layerAssets[$0]?.stringValue })
        saved["later"] = ["png": .string(layerUrl), "again": [.string(layerUrl)], "other": .string(ONE_PIXEL)]
        let d = try PaintEditorController(width: 8, height: 8)
        try d.loadJSON(.object(saved))
        let store = MemoryPaintStore()
        let out = try await d.toJSONExternal(store)
        _ = try await d.toJSONExternal(store)
        // Each PNG is put once per store: the layer, the same PNG as an extension asset, and the small
        // one; then the stroke log, as one run of JSON.
        XCTAssertEqual(store.puts.count, 4)
        let layerId = try XCTUnwrap(out["layers"]?.arrayValue?.first?["asset"]?.stringValue)
        let extId = "ext-\(fnv1a(layerUrl))-\(String(layerUrl.utf16.count, radix: 36))"
        let runId = try XCTUnwrap(out["strokes"]?["chunks"]?.arrayValue?.first?.stringValue)
        XCTAssertTrue(runId.hasPrefix(STROKE_CHUNK_PREFIX))
        XCTAssertEqual([store.puts[3].id, String(store.puts[3].width), String(store.puts[3].height)], [runId, "0", "0"])
        XCTAssertEqual(out["assets"], .object([layerId: "mem:1", extId: "mem:2", "ext-380f6147-3a": "mem:3", runId: "mem:4"]))
        XCTAssertEqual(out["later"], ["png": .string("asset:\(extId)"), "again": [.string("asset:\(extId)")], "other": "asset:ext-380f6147-3a"])
        XCTAssertEqual(store.puts[2].id, "ext-380f6147-3a")
        XCTAssertEqual([store.puts[2].width, store.puts[2].height, store.puts[2].size], [1, 1, 70])
        XCTAssertEqual(out.keys, ["later", "format", "version", "width", "height", "dpi", "paper", "activeLayerId", "strokes", "guides", "swatches", "layers", "assets"])

        // Reopened through the store, it is the painting that was saved.
        let e = try PaintEditorController(width: 8, height: 8)
        let problems = try await e.loadJSONAsync(.object(out), store: store)
        XCTAssertEqual(problems, [])
        XCTAssertEqual(e.toJSON(), d.toJSON())
    }

    func testExternalAssetsThatCannotBeReadAreReported() async throws {
        let c = try await painted()
        let store = MemoryPaintStore()
        let out = try await c.toJSONExternal(store)
        let id = try XCTUnwrap(out["layers"]?.arrayValue?.first?["asset"]?.stringValue)
        let e = try PaintEditorController(width: 8, height: 8)
        let without = try await e.loadJSONAsync(.object(out))
        XCTAssertEqual(without.first, "Asset \"\(id)\" is external (mem:1) and no asset store was given.")
        store.failing = ["mem:1"]
        let failed = try await e.loadJSONAsync(.object(out), store: store)
        XCTAssertEqual(failed.first, "Asset \"\(id)\" (mem:1) could not be fetched: offline")
        do {
            _ = try await e.loadJSONAsync("nope")
            XCTFail("a string is not a painting")
        } catch {
            XCTAssertEqual((error as? PaintEditorError)?.message, "Not a paint document: expected a JSON object.")
        }
    }
}
