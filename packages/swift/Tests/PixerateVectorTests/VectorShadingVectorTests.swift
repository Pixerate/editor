import CryptoKit
import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster
import XCTest
@testable import PixerateVector

private typealias Vec2 = PixerateVector.Vec2

/// The TS core's own outputs for gradient meshes and freeform gradients, stop expansion, spread
/// periods, conic and diamond paint servers and gradients along or across a stroke
/// (`packages/core/tests/swift-vector-shading-vectors.test.ts` writes
/// `Fixtures/vector-shading-vectors.json`). Entries marked `trig: false` compare exactly,
/// `trig: true` ones within relative 1e-9; strings always exactly. Keys compare as sets.
/// `commands` replays agent commands and compares results, error texts, the saved document and
/// digests of the exported SVG and the render data (both hold freeform strips, too big to keep).
final class VectorShadingVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-shading-vectors", withExtension: "json", subdirectory: "Fixtures")!
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
            return got == want ? nil : "\(path): \(got.stringified().prefix(200)) != \(want.stringified().prefix(200))"
        }
    }

    // MARK: Encoding

    private func bounds(_ v: JSONValue?) -> VectorBounds? {
        guard let o = v?.objectValue else { return nil }
        return VectorBounds(x: o["x"]!.numberValue!, y: o["y"]!.numberValue!, width: o["width"]!.numberValue!, height: o["height"]!.numberValue!)
    }

    private func node(_ v: JSONValue?) -> VectorNode? {
        guard let n = v?.objectValue else { return nil }
        var props = JSONObject([("id", "p"), ("type", "path")])
        for (k, x) in n["style"]?.objectValue ?? JSONObject() { props[k] = x }
        return VectorNode(props: props, subpaths: bezierToSubpaths(.svg(n["d"]!.stringValue!)))
    }

    private func nums(_ v: [Double]) -> JSONValue { .array(v.map { .number($0) }) }
    private func curves(_ list: [[Vec2]]) -> JSONValue { .array(list.map { .array($0.map(\.json)) }) }
    private func defs(_ list: [VectorPaintDef]) -> JSONValue { .array(list.map(\.json)) }
    private func stops(_ list: [VectorGradientStop]) -> JSONValue { .array(list.map(\.json)) }
    private func object(_ o: JSONObject?) -> JSONValue { o.map { .object($0) } ?? .null }
    private func int(_ v: JSONValue?) -> Int? { v?.numberValue.map { Int($0) } }

    // MARK: Entries

    private func run(_ e: JSONValue) throws -> JSONValue {
        let options = e["options"]?.objectValue ?? JSONObject()
        let precision = int(options["precision"])
        switch e["fn"]!.stringValue! {
        // Meshes and freeform gradients
        case "sanitizeVectorShadedPaint": return .array(e["values"]!.arrayValue!.map { object(sanitizeVectorShadedPaint($0)) })
        case "createVectorMeshGradient":
            return .object(createVectorMeshGradient(bounds(e["bounds"])!, e["rows"]!.numberValue!, e["columns"]!.numberValue!,
                                                    colors: e["colors"]?.arrayValue?.map { $0.stringValue! }, corners: e["corners"]?.arrayValue?.map { $0.stringValue! }))
        case "vectorMeshSample":
            let mesh = e["mesh"]!.objectValue!
            return .array(e["uv"]!.arrayValue!.map { q in
                let a = q.arrayValue!.map { $0.numberValue! }
                return .object(JSONObject([
                    ("point", vectorMeshPointAt(mesh, Int(a[0]), Int(a[1]), a[2], a[3])!.json),
                    ("color", nums(vectorMeshColorAt(mesh, Int(a[0]), Int(a[1]), a[2], a[3])!)),
                ]))
            })
        case "vectorMeshLines":
            let l = vectorMeshLines(e["mesh"]!.objectValue!)!
            return .object(JSONObject([("rows", .array(l.rows.map(curves))), ("columns", .array(l.columns.map(curves)))]))
        case "vectorFreeformLineSegments":
            let g = e["gradient"]!.objectValue!
            return .array(e["lines"]!.arrayValue!.map { curves(vectorFreeformLineSegments(g, Int($0.numberValue!))) })
        case "sampleVectorFreeform":
            let field = vectorFreeformField(e["gradient"]!.objectValue!, e["scale"]!.numberValue!)
            return .array(e["points"]!.arrayValue!.map { nums(sampleVectorFreeform(field, Vec2(json: $0)!)) })
        case "autoVectorFreeformGradient":
            let colors = e["colors"]!.arrayValue!.map { $0.stringValue! }
            guard let c = e["circle"]?.objectValue else { return .object(autoVectorFreeformGradient(bounds(e["bounds"])!, colors)) }
            let (cx, cy, r) = (c["cx"]!.numberValue!, c["cy"]!.numberValue!, c["r"]!.numberValue!)
            return .object(autoVectorFreeformGradient(bounds(e["bounds"])!, colors) { JS.hypot($0.x - cx, $0.y - cy) <= r })
        case "removeVectorFreeformPoint": return object(removeVectorFreeformPoint(e["gradient"]!.objectValue!, int(e["index"])!))
        case "nearestVectorShadingPoint":
            let paint = e["paint"]!.objectValue!
            return .array(e["queries"]!.arrayValue!.map { q in
                let a = q.arrayValue!.map { $0.numberValue! }
                return .number(Double(nearestVectorShadingPoint(paint, Vec2(a[0], a[1]), a[2])))
            })
        case "transformVectorShadedPaint":
            let m = VectorMatrix(json: e["matrix"])!
            return .array(e["paints"]!.arrayValue!.map { .object(transformVectorShadedPaint($0.objectValue!, m)) })
        case "vectorRgbaToCss": return .array(e["colours"]!.arrayValue!.map { .string(vectorRgbaToCss($0.arrayValue!.map { $0.numberValue! })) })
        case "vectorShadedSvgDefs":
            return defs(vectorShadedSvgDefs(e["paint"]!.objectValue!, "s", bounds: bounds(options["bounds"]), area: bounds(options["area"]),
                                            meshCells: options["meshCells"]?.numberValue, freeformCells: options["freeformCells"]?.numberValue, precision: precision))

        // Gradients
        case "expandVectorGradientStops": return stops(expandVectorGradientStops(e["gradient"]!.objectValue!, tolerance: e["tolerance"]?.numberValue))
        case "sampleVectorGradient":
            let g = e["gradient"]!.objectValue!
            return .array(e["ts"]!.arrayValue!.map { t in
                let s = sampleVectorGradient(g, t.numberValue!)
                return .object(JSONObject([("color", .string(s.color)), ("opacity", .number(s.opacity))]))
            })
        case "spanVectorGradientStops": return stops(spanVectorGradientStops(e["gradient"]!.objectValue!, e["from"]!.numberValue!, e["to"]!.numberValue!))
        case "expandVectorGradientSpread":
            guard let x = expandVectorGradientSpread(e["gradient"]!.objectValue!, bounds(e["bounds"]), bounds(e["area"])!) else { return .null }
            return .object(JSONObject([
                ("start", x.start.json), ("end", x.end.json), ("from", .number(x.from)), ("to", .number(x.to)), ("matrix", x.matrix.json),
                ("stops", stops(x.stops)), ("capped", .bool(x.capped)),
            ]))
        case "vectorGradientSvgDefs":
            return defs(vectorGradientSvgDefs(e["gradient"]!.objectValue!, "g", bounds: bounds(options["bounds"]), area: bounds(options["area"]), wedges: options["wedges"]?.numberValue, precision: precision))
        case "vectorStrokeGradientDefs":
            return defs(vectorStrokeGradientDefs(e["gradient"]!.objectValue!, "k", node(e["node"])!, bounds: bounds(options["bounds"]), area: bounds(options["area"]), precision: precision))
        case "vectorPaintToSvg":
            let r = vectorPaintToSvg(e["paint"], e["id"]!.stringValue!, node: node(e["node"]), role: e["role"]!.stringValue!)
            return .object(JSONObject([("value", .string(r.value)), ("defs", defs(r.defs))]))
        case let fn:
            throw VectorEditorError("No shading function \(fn).")
        }
    }

    func testShadingVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 90)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            do {
                let got = try run(e)
                if let d = mismatch(got, e["out"]!, e["trig"]!.boolValue!) { XCTFail("entry \(i) \(fn): \(d)") }
            } catch {
                XCTFail("entry \(i) \(fn) threw: \(error)")
            }
        }
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
        if let d = mismatch(try await call(host, "vector.importSvg", ["svg": .string(svg), "replace": true]), commands["imported"]!, true) { XCTFail("import: \(d)") }
        if let d = mismatch(try await call(host, "vector.list"), commands["after"]!, true) { XCTFail("list after import: \(d)") }
        if let d = mismatch(try host.document(), commands["document"]!, true) { XCTFail("document: \(d)") }
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "vectorShadedSvgDefs" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, true))
        guard case .array(var out) = e["out"]!, case .object(var def) = out[0], case .array(var tiles) = def["tiles"]!, case .object(var tile) = tiles[0] else { return XCTFail("no tile") }
        tile["fill"] = "#000001"
        tiles[0] = .object(tile)
        def["tiles"] = .array(tiles)
        out[0] = .object(def)
        XCTAssertNotNil(mismatch(got, .array(out), true))
        XCTAssertNotNil(mismatch(digest("<svg/>"), Self.vectors["commands"]!["svg"]!, false))
    }
}
