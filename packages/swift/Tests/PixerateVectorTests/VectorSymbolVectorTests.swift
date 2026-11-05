import CryptoKit
import Foundation
import PixerateCore
import PixerateGeometry
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for symbols and instances: resolving and stripping symbol art,
/// symbol cycles, what an instance draws, instances in geometry, blends and SVG export and import
/// (`packages/core/tests/swift-vector-symbol-vectors.test.ts` writes `Fixtures/vector-symbol-vectors.json`).
/// Entries marked `trig: false` compare exactly, `trig: true` ones within relative 1e-9; strings
/// always exactly. Keys compare as sets. `commands` replays agent commands and compares results,
/// error texts, the saved document, the SVG round trip and digests of the export and the render data.
final class VectorSymbolVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-symbol-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    func mismatch(_ got: JSONValue, _ want: JSONValue, _ trig: Bool, _ path: String = "") -> String? {
        switch (got, want) {
        case let (.number(g), .number(w)):
            if g == w || (trig && abs(g - w) <= 1e-9 * max(1, abs(g), abs(w))) { return nil }
            return "\(path): \(JSONValue.jsNumber(g)) != \(JSONValue.jsNumber(w))"
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(path): \(g.count) items != \(w.count)" }
            for i in 0 ..< g.count { if let d = mismatch(g[i], w[i], trig, "\(path)[\(i)]") { return d } }
            return nil
        case let (.object(g), .object(w)):
            if Set(g.keys) != Set(w.keys) { return "\(path): keys \(g.keys.sorted()) != \(w.keys.sorted())" }
            for k in w.keys { if let d = mismatch(g[k]!, w[k]!, trig, "\(path).\(k)") { return d } }
            return nil
        default:
            return got == want ? nil : "\(path): \(got.stringified().prefix(300)) != \(want.stringified().prefix(300))"
        }
    }

    private func node(_ v: JSONValue) throws -> VectorNode { try VectorNode(json: v) }
    private func nodes(_ list: [VectorNode]) -> JSONValue { .array(list.map { $0.toJSON() }) }
    private func matrix(_ v: JSONValue) -> VectorMatrix { VectorMatrix(json: v)! }

    private func run(_ e: JSONValue) throws -> JSONValue {
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        switch e["fn"]!.stringValue! {
        case "resolveVectorSymbols": return resolveVectorSymbols(try VectorDocument(json: e["doc"]!)).toJSON()
        case "stripVectorSymbolArt": return stripVectorSymbolArt(try VectorDocument(json: e["doc"]!)).toJSON()
        case "vectorSymbolUses":
            let symbols = try list("symbols").map { try VectorSymbol(json: $0) }
            return .array(list("pairs").map { p in .bool(vectorSymbolUses(symbols, p.arrayValue![0].stringValue!, p.arrayValue![1].stringValue!)) })
        case "scaleVectorStrokeWidths":
            return .array(try list("nodes").map { n in .array(try list("ks").map { scaleVectorStrokeWidths(try node(n), $0.numberValue!).toJSON() }) })
        case "tintVectorNode":
            return .array(try list("nodes").map { n in .array(try list("overrides").map { tintVectorNode(try node(n), $0.objectValue!).toJSON() }) })
        case "prefixVectorIds": return nodes(prefixVectorIds(try list("nodes").map(node), "inst"))
        case "vectorInstanceDrawn": return try vectorInstanceDrawn(try node(e["node"]!)).toJSON()
        case "expandVectorAppearance": return try expandVectorAppearance(try node(e["node"]!)).toJSON()
        case "vectorNodeBounds":
            let n = try node(e["node"]!)
            return .array(try list("parents").map { try vectorNodeBounds(n, matrix($0))?.json ?? .null })
        case "transformVectorNode":
            let n = try node(e["node"]!)
            return .array(try list("matrices").map { try transformVectorNode(n, matrix($0)).toJSON() })
        case "generateVectorBlendChildren": return nodes(try generateVectorBlendChildren(try node(e["group"]!)))
        case "vectorDocumentToSvg":
            return .string(try vectorDocumentToSvg(try VectorDocument(json: e["doc"]!), includeHidden: e["includeHidden"]?.boolValue ?? false))
        case "parseVectorSvg":
            if let svg = e["svg"]?.stringValue { return try parseVectorSvg(svg).toJSON() }
            return .array(try list("svgs").map { try parseVectorSvg($0.stringValue!).toJSON() })
        case "symbolsPanel":
            var n = 0
            let c = try VectorEditorController(document: try VectorDocument(json: e["document"]!), createId: {
                n += 1
                return "c\(n)"
            })
            let made = try c.makeSymbol(ids: ["p1"], name: "Box")
            let placed = try c.placeSymbol(made.symbolId!, transform: VectorMatrix(2, 0, 0, 2, 150, 50))
            c.select([placed.id!])
            _ = try c.setInstanceOptions(["stroke": "#f00", "hidden": .array([])])
            let before = try c.symbolsPanel()
            c.select(["p2"])
            let selected = try c.symbolsPanel()
            _ = try c.editSymbol(placed.id!)
            let editing = try c.symbolsPanel(idPrefix: "x-")
            let background = try c.symbolEditBackground() ?? .null
            return .object(JSONObject([("before", before), ("selected", selected), ("editing", editing), ("background", background)]))
        case let fn:
            throw VectorEditorError("No symbol function \(fn).")
        }
    }

    func testSymbolVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 40)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            do {
                var got = try run(e)
                var want = e["out"]!
                if fn == "symbolsPanel" {
                    // The Swift controller has no view: compare the background's placement after it.
                    got = viewless(got)
                    want = viewless(want)
                }
                if let d = mismatch(got, want, e["trig"]!.boolValue!) { XCTFail("entry \(i) \(fn): \(d)") }
            } catch {
                XCTFail("entry \(i) \(fn) threw: \(error)")
            }
        }
    }

    /// The panel vectors with the background's `transform` cut to its `matrix(…)` part.
    private func viewless(_ v: JSONValue) -> JSONValue {
        guard case var .object(o) = v, case var .object(bg) = o["background"]!, let t = bg["transform"]?.stringValue, let r = t.range(of: "matrix(") else { return v }
        bg["transform"] = .string(String(t[r.lowerBound...]))
        o["background"] = .object(bg)
        return .object(o)
    }

    /// `{ length, sha256 }` of a text (UTF-16 length, as JavaScript counts it).
    private func digest(_ text: String) -> JSONValue {
        let hash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        return .object(JSONObject([("length", .number(Double(text.utf16.count))), ("sha256", .string(hash))]))
    }

    /// The value with every object's keys sorted (render data keys are compared as sets).
    private func sortedKeys(_ v: JSONValue) -> JSONValue {
        switch v {
        case let .array(a): return .array(a.map(sortedKeys))
        case let .object(o): return .object(JSONObject(o.keys.sorted().map { ($0, sortedKeys(o[$0]!)) }))
        default: return v
        }
    }

    private func call(_ host: VectorConformanceHost, _ id: String, _ params: JSONValue? = nil) async throws -> JSONValue {
        var args = JSONObject([("id", .string(id))])
        if let params { args["params"] = params }
        let r = await host.callTool("run_command", args)
        return r.isError ? .object(JSONObject([("error", .string(r.text ?? ""))])) : try JSONValue.parse(r.text ?? "null")
    }

    func testCommandVectors() async throws {
        let commands = Self.vectors["commands"]!
        let host = try VectorConformanceHost(setup: commands["setup"]!.objectValue!)
        for (i, step) in commands["steps"]!.arrayValue!.enumerated() {
            let got = try await call(host, step["id"]!.stringValue!, step["params"])
            if let d = mismatch(got, step["result"]!, true) { XCTFail("step \(i) \(step["id"]!.stringValue!): \(d)") }
        }
        let svg = try await call(host, "vector.exportSvg")["result"]!["svg"]!.stringValue!
        XCTAssertNil(mismatch(digest(svg), commands["svg"]!, false), "exported SVG")
        let render = try XCTUnwrap(try host.render())
        XCTAssertNil(mismatch(digest(sortedKeys(render).stringified()), commands["render"]!, false), "render data")
        if let d = mismatch(try host.document(), commands["document"]!, true) { XCTFail("document: \(d)") }
        if let d = mismatch(try await call(host, "vector.importSvg", ["svg": .string(svg), "replace": true]), commands["imported"]!, true) { XCTFail("import: \(d)") }
        if let d = mismatch(try await call(host, "vector.list"), commands["after"]!, true) { XCTFail("list after import: \(d)") }
        if let d = mismatch(try await call(host, "vector.listSymbols"), commands["afterSymbols"]!, true) { XCTFail("symbols after import: \(d)") }
    }

    /// Undo and redo step in and out of isolation mode with the edits made there.
    func testUndoThroughIsolation() async throws {
        let host = try VectorConformanceHost(setup: ["width": 200, "height": 100])
        let c = host.controller
        _ = try await call(host, "vector.addShape", ["kind": "rect", "x": 10, "y": 10, "width": 20, "height": 20])
        _ = try await call(host, "vector.makeSymbol", ["ids": ["n1"]])
        _ = try await call(host, "vector.editSymbol", ["id": "n3"])
        _ = try await call(host, "vector.addShape", ["kind": "rect", "x": 0, "y": 0, "width": 5, "height": 5])
        XCTAssertEqual(c.document.nodes.map(\.id), ["n1", "n4"])
        _ = try await call(host, "vector.exitSymbolEdit")
        XCTAssertNil(c.symbolEditState)
        XCTAssertEqual(c.getSymbols()[0].nodes.map(\.id), ["n1", "n4"])
        XCTAssertTrue(c.undo())
        // Back inside the symbol, without the added shape.
        XCTAssertEqual(c.symbolEditState?.symbolId, "symbol-n2")
        XCTAssertEqual(c.document.nodes.map(\.id), ["n1"])
        XCTAssertEqual(try c.toJSON().symbols?[0].nodes.map(\.id), ["n1"])
        XCTAssertTrue(c.redo())
        XCTAssertEqual(c.document.nodes.map(\.id), ["n1", "n4"])
        // The panel and the dimmed host follow.
        let panel = try c.symbolsPanel()
        XCTAssertEqual(panel["editing"]?["symbolId"], "symbol-n2")
        XCTAssertEqual(panel["symbols"]?.arrayValue?.first?["instances"], 1)
        let background = try XCTUnwrap(try c.symbolEditBackground())
        XCTAssertEqual(background["name"], "Symbol 1")
        XCTAssertEqual(background["transform"], "translate(0 0) scale(1) matrix(1 0 0 1 -20 -20)")
        c.exitSymbolEdit()
        XCTAssertNil(try c.symbolEditBackground())
        // Saved documents never hold the resolved art.
        XCTAssertFalse(try c.toJSON().toJSON().stringified().contains("\"art\""))
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "vectorInstanceDrawn" && $0["node"]?["id"] == "i7" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, false))
        guard case .object(var g) = e["out"]!, case .array(var children) = g["children"]!, case .object(var first) = children[0] else { return XCTFail("no art") }
        first["fill"] = "#000001"
        children[0] = .object(first)
        g["children"] = .array(children)
        XCTAssertNotNil(mismatch(got, .object(g), false))
        XCTAssertNotNil(mismatch(digest("<svg/>"), Self.vectors["commands"]!["svg"]!, false))
    }
}
