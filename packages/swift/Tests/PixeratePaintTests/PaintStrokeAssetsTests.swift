import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// A `PaintAssetStore` in memory that records its puts.
private final class StrokeStore: PaintAssetStore {
    var puts: [(id: String, width: Int, height: Int, size: Int)] = []
    var data: [String: [UInt8]] = [:]

    func put(_ png: [UInt8], id: String, width: Int, height: Int) async throws -> String {
        puts.append((id, width, height, png.count))
        let ref = "mem:\(puts.count)"
        data[ref] = png
        return ref
    }

    func get(_ ref: String) async throws -> [UInt8] {
        guard let bytes = data[ref] else { throw PaintEditorError("no asset \(ref)") }
        return bytes
    }

    var strokePuts: [String] { puts.map(\.id).filter { $0.hasPrefix(STROKE_CHUNK_PREFIX) } }
}

/// Stroke data in the asset store and `StrokeLogOption.replay` (port of `paint-editor-stroke-assets.test.ts`).
final class PaintStrokeAssetsTests: XCTestCase {
    private let ink = PaintDualColor(light: "#111827", dark: "#f9fafb")

    private func editor() throws -> PaintEditorController {
        try PaintEditorController(width: 200, height: 140, paperPreset: "smooth")
    }

    /// A long pen stroke, as a pointer records it.
    private func long(_ k: Int, _ n: Int = 120) -> [PenPoint] {
        (0..<n).map { (i: Int) -> PenPoint in
            let t = Double(i)
            let kk = Double(k)
            let x: Double = 10 + (t * 1.13 + kk * 7.31).truncatingRemainder(dividingBy: 180)
            let y: Double = 10 + (kk * 13.7 + sin(t / 9 + kk) * 40 + 60).truncatingRemainder(dividingBy: 120)
            return PenPoint(x: x, y: y, pressure: 0.5 + 0.4 * sin(t / 7 + kk), t: 1000 * kk + t * 8.333, tiltX: 12.5, tiltY: -7.25)
        }
    }

    private func pen(_ c: PaintEditorController, _ k: Int, dual: Bool = false, brushId: String = "ink-pen") throws {
        var i = PaintStrokeInit(color: dual ? nil : "#1d4ed8", seed: k + 1)
        if dual { i.dualColor = ink }
        i.brushId = brushId
        _ = try c.paintStroke(i, points: long(k))
    }

    /// An editor with a stroke layer of `n` long ink strokes, and that layer's id.
    private func inked(_ n: Int, dual: Bool = false) throws -> (PaintEditorController, String) {
        let c = try editor()
        let layer = try c.addLayer(type: "strokes").id
        for k in 0..<n { try pen(c, k, dual: dual) }
        return (c, layer)
    }

    /// Key-order-free comparison (a reopened document orders some keys differently).
    private func same(_ a: JSONObject, _ b: JSONObject) -> Bool {
        canonicalJSON(.object(a)) == canonicalJSON(.object(b))
    }

    func testRunsAndIdsMatchTheTypeScriptCore() {
        XCTAssertEqual(strokeChunkRuns(0), [])
        XCTAssertEqual(strokeChunkRuns(37), [16, 16, 4, 1])
        XCTAssertEqual(strokeChunkRuns(38), [16, 16, 4, 2])
        XCTAssertEqual(strokeChunkRuns(48), [16, 16, 16])
        let v: JSONValue = [["b": 1.5, "a": [2, ["d": .null, "c": "x\u{e9}\u{1F3A8}"]], "z": -0.0, "n": 1e21, "s": "q\"\\\n"], ["10": "a", "9": "b"]]
        let text = canonicalJSON(v)
        XCTAssertEqual(text, "[{\"a\":[2,{\"c\":\"x\u{e9}\u{1F3A8}\",\"d\":null}],\"b\":1.5,\"n\":1e+21,\"s\":\"q\\\"\\\\\\n\",\"z\":0},{\"10\":\"a\",\"9\":\"b\"}]")
        // The ids the TS core gives the same texts.
        XCTAssertEqual(strokeChunkId(text), "json-03ccf66524defd-2i")
        XCTAssertEqual(strokeChunkId("[]"), "json-15202279b28c9e-2")
    }

    func testStrokeDataGoesToTheStoreAndComesBack() async throws {
        let (c, layer) = try inked(20)
        _ = try c.updateStroke(c.doc.liveStrokes![layer]![3].id, brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: 77)
        _ = try c.addLayer(name: "Pixels")
        try pen(c, 40, brushId: "soft-pastel")
        let inline = c.toJSON()
        let store = StrokeStore()
        let out = try await c.toJSONExternal(store)
        XCTAssertEqual(out["liveStrokes"]?[layer]?["chunks"]?.arrayValue?.count, strokeChunkRuns(20).count)
        XCTAssertEqual(out["strokes"]?["chunks"]?.arrayValue?.count, strokeChunkRuns(21).count)
        XCTAssertEqual(out["paintEvents"]?["chunks"]?.arrayValue?.count, 1)
        XCTAssertFalse(JSONValue.object(out).stringified().contains("\"pressure\""))
        for p in store.puts where p.id.hasPrefix(STROKE_CHUNK_PREFIX) { XCTAssertEqual([p.width, p.height], [0, 0]) }
        XCTAssertEqual(Set(store.strokePuts).count, store.strokePuts.count)

        let d = try editor()
        let problems = try await d.loadJSONAsync(.object(out), store: store)
        XCTAssertEqual(problems, [])
        XCTAssertTrue(same(d.toJSON(), inline))
        XCTAssertEqual(d.compositePixels().data, c.compositePixels().data)
    }

    func testOneMoreStrokeUploadsOneStrokeAsset() async throws {
        let (c, _) = try inked(37)
        let store = StrokeStore()
        _ = try await c.toJSONExternal(store, strokes: false)
        XCTAssertEqual(store.strokePuts.count, strokeChunkRuns(37).count)
        store.puts = []
        _ = try await c.toJSONExternal(store, strokes: false)
        XCTAssertEqual(store.strokePuts, [])
        for k in 37..<45 {
            try pen(c, k)
            store.puts = []
            _ = try await c.toJSONExternal(store, strokes: false)
            XCTAssertEqual(store.strokePuts.count, 1)
        }
    }

    func testReopeningFromTheStoreUploadsNoStrokeDataAgain() async throws {
        let (c, _) = try inked(20)
        let store = StrokeStore()
        let out = try await c.toJSONExternal(store)
        let reopened = StrokeStore()
        reopened.data = store.data
        let d = try editor()
        let problems = try await d.loadJSONAsync(.object(out), store: reopened)
        XCTAssertEqual(problems, [])
        let again = try await d.toJSONExternal(reopened)
        XCTAssertEqual(reopened.strokePuts, [])
        XCTAssertEqual(again["liveStrokes"], out["liveStrokes"])
        XCTAssertEqual(again["strokes"], out["strokes"])
    }

    func testAMissingStrokeAssetIsReportedAndTheRestLoads() async throws {
        let (c, layer) = try inked(20)
        let store = StrokeStore()
        let out = try await c.toJSONExternal(store, strokes: false)
        let lost = try XCTUnwrap(out["liveStrokes"]?[layer]?["chunks"]?.arrayValue?[1].stringValue)
        let ref = try XCTUnwrap(out["assets"]?[lost]?.stringValue)
        store.data[ref] = nil
        let d = try editor()
        let problems = try await d.loadJSONAsync(.object(out), store: store)
        XCTAssertEqual(problems, [
            "Asset \"\(lost)\" (\(ref)) could not be fetched: no asset \(ref)",
            "\"liveStrokes.\(layer)\" refers to stroke data asset \"\(lost)\", which could not be read; what it holds is left out.",
        ])
        XCTAssertEqual(d.doc.liveStrokes?[layer]?.map(\.id), Array(c.doc.liveStrokes![layer]!.prefix(16)).map(\.id))
        XCTAssertEqual(d.compositePixels().data, c.compositePixels().data)
    }

    func testTheReplayLogRefersToStrokeLayerStrokes() throws {
        let (c, layer) = try inked(3, dual: true)
        XCTAssertNil(c.toJSON(strokeLog: .replay)["strokes"])
        XCTAssertEqual(c.toJSON(strokeLog: .all), c.toJSON())
        let pixel = try c.addLayer(name: "Wash").id
        try pen(c, 5, dual: true, brushId: "soft-pastel")
        _ = try c.updateStroke(c.doc.liveStrokes![layer]![0].id, brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: 99)
        let saved = c.toJSON(strokeLog: .replay)
        let log = try XCTUnwrap(saved["strokes"]?.arrayValue)
        XCTAssertEqual(log.count, 4)
        // Edited on its layer: written in full; the others are references.
        XCTAssertNotNil(log[0]["points"])
        XCTAssertEqual(log[1], ["liveStroke": .string(c.doc.strokes[1].id), "layerId": .string(layer)])
        XCTAssertEqual(log[2], ["liveStroke": .string(c.doc.strokes[2].id), "layerId": .string(layer)])
        XCTAssertEqual(log[3]["layerId"], .string(pixel))
        let d = try editor()
        XCTAssertEqual(try d.loadJSON(.object(saved)), [])
        XCTAssertTrue(same(d.toJSON(), c.toJSON()))
        var broken = saved
        broken["strokes"] = .array([["liveStroke": "nope", "layerId": "gone"]] + log.dropFirst())
        let e = try editor()
        XCTAssertEqual(try e.loadJSON(.object(broken)), ["strokes[0] refers to stroke \"nope\" of stroke layer \"gone\", which the document does not have; skipped."])
    }

    func testTheSchemeReplayFollowsAfterReopeningFromTheStore() async throws {
        let blue = PaintDualColor(light: "#1d4ed8", dark: "#93c5fd")
        let red = PaintDualColor(light: "#b91c1c", dark: "#fca5a5")
        func wave(_ y: Double) -> [PenPoint] {
            (0..<16).map { (i: Int) -> PenPoint in
                let t = Double(i)
                return PenPoint(x: 20 + (120 * t) / 15, y: y + sin(t / 3) * 8, pressure: 0.7)
            }
        }
        func wet() throws -> PaintEditorController {
            try PaintEditorController(width: 160, height: 120, paperPreset: "cold-pressed", wet: PaintWetOptions(gpu: "off"), colorScheme: "light")
        }
        func paint(_ c: PaintEditorController, _ side: String?) throws {
            func stroke(_ pair: PaintDualColor, _ y: Double, _ seed: Int, _ brushId: String) throws {
                var i = PaintStrokeInit(color: side.map { pair.side($0) }, seed: seed)
                if side == nil { i.dualColor = pair }
                i.brushId = brushId
                _ = try c.paintStroke(i, points: wave(y))
            }
            try stroke(blue, 40, 3, "watercolor-round")
            _ = try c.advanceWet(steps: 5, seconds: nil)
            try stroke(red, 60, 8, "watercolor-round")
            _ = try c.addLayer(type: "strokes")
            try stroke(ink, 80, 4, "ink-pen")
        }
        let c = try wet()
        try paint(c, nil)
        let store = StrokeStore()
        let out = try await c.toJSONExternal(store, strokeLog: .replay)
        XCTAssertEqual(out["strokes"]?["chunks"]?.arrayValue?.count, 2)
        let d = try wet()
        let problems = try await d.loadJSONAsync(.object(out), store: store)
        XCTAssertEqual(problems, [])
        XCTAssertEqual(d.doc.strokes.map(\.id), c.doc.strokes.map(\.id))
        d.setColorScheme("dark")
        let view = await d.colorSchemeViewReady()
        XCTAssertEqual(view.layers.map(\.view).sorted(), ["replay", "strokes"])
        let f = try wet()
        try paint(f, "dark")
        XCTAssertEqual(d.compositePixels(wet: "dried").data, f.compositePixels(wet: "dried").data)
    }
}
