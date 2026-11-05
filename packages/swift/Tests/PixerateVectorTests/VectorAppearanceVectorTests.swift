import Foundation
import PixerateCore
import PixerateGeometry
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for path effects, masks, filters, lenses and gradient edits
/// (`packages/core/tests/swift-vector-appearance-vectors.test.ts` writes
/// `Fixtures/vector-appearance-vectors.json`). Entries marked `trig: false` compare exactly,
/// `trig: true` ones within relative 1e-9. Keys compare as sets. `commands` replays agent commands
/// (their failures and edge cases) and compares results, error texts and the saved document.
final class VectorAppearanceVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-appearance-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    private func mismatch(_ got: JSONValue, _ want: JSONValue, _ trig: Bool, _ path: String) -> String? {
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
            return got == want ? nil : "\(path): \(got.stringified().prefix(200)) != \(want.stringified().prefix(200))"
        }
    }

    private func bounds(_ b: VectorBounds?) -> JSONValue {
        guard let b else { return .null }
        return .object(JSONObject([("x", .number(b.x)), ("y", .number(b.y)), ("width", .number(b.width)), ("height", .number(b.height))]))
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        switch e["fn"]!.stringValue! {
        case "expandVectorAppearance": return try expandVectorAppearance(VectorNode(json: e["node"]!)).toJSON()
        case "vectorNodeBounds": return bounds(try vectorNodeBounds(VectorNode(json: e["node"]!)))
        case "vectorAppearanceNodes": return .array(try vectorAppearanceNodes(VectorNode(json: e["node"]!)).map { $0.toJSON() })
        case "vectorMaskSummary": return vectorMaskSummary(try VectorNode(json: e["node"]!)) ?? .null
        case "createVectorEffect": return .array(try e["types"]!.arrayValue!.map { t in try createVectorEffect(t.stringValue!, "fx-\(t.stringValue!)").map { .object($0) } ?? .null })
        case "sanitizeVectorEffects": return .array(try sanitizeVectorEffects(e["effects"]).map { .object($0) })
        case "transformVectorNode":
            let m = e["m"]!.arrayValue!.map { $0.numberValue! }
            return try transformVectorNode(VectorNode(json: e["node"]!), VectorMatrix(m[0], m[1], m[2], m[3], m[4], m[5])).toJSON()
        case "vectorFilterSvg":
            let b = e["bounds"]!
            let box = VectorBounds(x: b["x"]!.numberValue!, y: b["y"]!.numberValue!, width: b["width"]!.numberValue!, height: b["height"]!.numberValue!)
            guard let f = vectorFilterSvg(e["filters"]!.arrayValue!, "vf", box) else { return .null }
            return .object(JSONObject([("filter", f.json), ("markup", .string(vectorFilterMarkup(f)))]))
        case "vectorLensDrawn":
            let nodes = try e["nodes"]!.arrayValue!.map { try VectorNode(json: $0) }
            let doc = resolveVectorLenses(VectorDocument(width: 200, height: 200, nodes: nodes))
            return try vectorLensDrawn(doc.nodes[doc.nodes.count - 1]).toJSON()
        case "sanitizeVectorLens":
            let extra: [JSONValue] = [["type": "magnify", "amount": 99], ["type": "colorAdd", "color": "nope"], ["type": "bogus"]]
            return .array((e["lenses"]!.arrayValue! + extra).map { sanitizeVectorLens($0).map { .object($0) } ?? .null })
        case "parseVectorColor": return .array(e["colors"]!.arrayValue!.map { c in parseVectorColor(c.stringValue!).map { .array($0.map { .number($0) }) } ?? .null })
        case "applyVectorGradientPatch":
            let patch = e["patch"]!.objectValue!
            let from: JSONValue? = e["from"] == .null ? nil : e["from"]
            return applyVectorGradientPatch(defaultVectorGradient(patch["type"]?.stringValue ?? "linear", from), patch).map { .object($0) } ?? .null
        case "getVectorSceneRenderData":
            return try getVectorSceneRenderData(VectorDocument(width: 300, height: 200, nodes: e["nodes"]!.arrayValue!.map { try VectorNode(json: $0) }))
        case "vectorDocumentToSvg":
            return .string(try vectorDocumentToSvg(VectorDocument(width: 300, height: 200, nodes: e["nodes"]!.arrayValue!.map { try VectorNode(json: $0) })))
        case let fn:
            throw VectorEditorError("No vector function \(fn).")
        }
    }

    func testAppearanceVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 90)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            do {
                let got = try run(e)
                if let d = mismatch(got, e["out"]!, e["trig"]!.boolValue!, "") { XCTFail("entry \(i) \(fn): \(d)") }
            } catch {
                XCTFail("entry \(i) \(fn) threw: \(error)")
            }
        }
    }

    func testCommandVectors() async throws {
        let commands = Self.vectors["commands"]!
        let host = try VectorConformanceHost(setup: commands["setup"]!.objectValue!)
        for (i, step) in commands["steps"]!.arrayValue!.enumerated() {
            var args = JSONObject([("id", step["id"]!)])
            if let params = step["params"] { args["params"] = params }
            let r = await host.callTool("run_command", args)
            let got: JSONValue = r.isError ? .object(JSONObject([("error", .string(r.text ?? ""))])) : try JSONValue.parse(r.text ?? "null")
            if let d = mismatch(got, step["result"]!, true, "") { XCTFail("step \(i) \(step["id"]!.stringValue!): \(d)") }
        }
        if let d = mismatch(try host.document(), commands["document"]!, true, "") { XCTFail("document: \(d)") }
    }
}
