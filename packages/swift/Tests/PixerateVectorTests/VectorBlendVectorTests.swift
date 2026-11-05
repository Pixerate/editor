import CryptoKit
import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster
import XCTest
@testable import PixerateVector

private typealias Vec2 = PixerateVector.Vec2

/// The TS core's own outputs for morphs and paint interpolation, live blend groups, warp presets
/// and meshes, the Envelope effect and symmetry groups
/// (`packages/core/tests/swift-vector-blend-vectors.test.ts` writes `Fixtures/vector-blend-vectors.json`).
/// Entries marked `trig: false` compare exactly, `trig: true` ones within relative 1e-9; strings
/// always exactly. Keys compare as sets. `commands` replays agent commands and compares results,
/// error texts, the saved document, the SVG round trip and digests of the export and the render data.
final class VectorBlendVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-blend-vectors", withExtension: "json", subdirectory: "Fixtures")!
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

    private func node(_ v: JSONValue) throws -> VectorNode { try VectorNode(json: v) }
    private func at(_ v: JSONValue, _ i: Int) -> JSONValue { v.arrayValue![i] }
    private func nodes(_ list: [VectorNode]) -> JSONValue { .array(list.map { $0.toJSON() }) }
    private func num(_ v: JSONValue?) -> Double { v?.numberValue ?? .nan }
    private func point(_ p: PathPoint) -> JSONValue { .array([.number(p[0]), .number(p[1])]) }
    private func bounds(_ v: JSONValue?) -> VectorBounds { VectorBounds(x: num(v?["x"]), y: num(v?["y"]), width: num(v?["width"]), height: num(v?["height"])) }
    private func boundsJSON(_ b: VectorBounds) -> JSONValue { b.json }
    private func mesh(_ v: JSONValue?) -> VectorWarpMesh { VectorWarpMesh(json: v)! }
    private func contour(_ c: VectorMorphContour) -> JSONValue { .object(JSONObject([("closed", .bool(c.closed)), ("pts", .array(c.pts.map(point)))])) }
    /// The paint inputs, with "undefined" read back as a missing paint.
    private func paint(_ v: JSONValue) -> JSONValue? { v == "undefined" ? Optional<JSONValue>.none : v }

    private func options(_ v: JSONValue?) -> VectorMorphOptions {
        var o = VectorMorphOptions()
        o.linear = v?["linear"]?.boolValue ?? false
        o.rigidity = v?["rigidity"]?.numberValue
        o.minSegments = v?["minSegments"]?.numberValue
        o.maxSegments = v?["maxSegments"]?.numberValue
        o.spacing = v?["spacing"]?.numberValue
        o.matchStart = v?["matchStart"] != .bool(false)
        o.shapeContext = v?["shapeContext"] != .bool(false)
        if let s = v?["starts"]?.arrayValue { o.starts = (s[0].numberValue.map { Int($0) }, s[1].numberValue.map { Int($0) }) }
        return o
    }

    /// A blend group with its steps generated.
    private func live(_ g: VectorNode) throws -> VectorNode {
        var n = g
        n.children = try generateVectorBlendChildren(g)
        return n
    }

    // MARK: Entries

    private func run(_ e: JSONValue) throws -> JSONValue {
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        switch e["fn"]!.stringValue! {
        // Morphs and paint
        case "interpolateVectorPaths":
            let m = try createVectorMorph(try node(e["a"]!), try node(e["b"]!), options(e["options"]))
            return .array(try list("ts").map { try m.at($0.numberValue!).toJSON() })
        case "interpolateVectorPaint":
            return .array(list("pairs").map { p in
                .array(list("ts").map { t in interpolateVectorPaint(paint(at(p, 0)), paint(at(p, 1)), t.numberValue!) ?? "undefined" })
            })
        case "interpolateVectorStyle":
            return .array(list("pairs").map { p in .array(list("ts").map { .object(interpolateVectorStyle(at(p, 0).objectValue!, at(p, 1).objectValue!, $0.numberValue!)) }) })
        case "interpolateRigidMatrix":
            return .array(list("pairs").map { p in .array(list("ts").map { interpolateRigidMatrix(VectorMatrix(json: at(p, 0))!, VectorMatrix(json: at(p, 1))!, $0.numberValue!).json }) })
        case "interpolateWidthProfiles":
            let a = e["a"]!.arrayValue!.map { VectorWidthPoint(t: num($0["t"]), left: num($0["left"]), right: num($0["right"])) }
            return .array(list("ts").map { t in interpolateWidthProfiles(a, nil, t.numberValue!).map { .array($0.map(\.json)) } ?? .null })
        case "correspondMorphContours":
            func contours(_ k: String) -> [VectorMorphContour] { list(k).flatMap { bezierToSubpaths(.svg($0.stringValue!)) }.map { subpathToMorphContour($0)! } }
            let r = correspondMorphContours(contours("a"), contours("b"), options(e["options"]))
            return .object(JSONObject([("a", .array(r.a.map(contour))), ("b", .array(r.b.map(contour))), ("reversed", .bool(r.reversed))]))

        // Blend groups
        case "resolveVectorBlendOptions": return .array(list("values").map { .object(resolveVectorBlendOptions($0)) })
        case "vectorBlendColorDistance": return .array(try list("pairs").map { p in .number(vectorBlendColorDistance(try node(at(p, 0)), try node(at(p, 1)))) })
        case "vectorBlendStepCount":
            return .array(try list("cases").map { c in .number(Double(try vectorBlendStepCount(try node(at(c, 0)), try node(at(c, 1)), at(c, 2), num(at(c, 3))))) })
        case "vectorBlendRail":
            return .array(try list("rails").map { sp in
                guard let rail = vectorBlendRail(try VectorSubpath(json: sp)) else { return .null }
                let r = JSONObject([
                    ("pts", .array(rail.pts.map(point))), ("cum", .array(rail.cum.map { .number($0) })), ("angles", .array(rail.angles.map { .number($0) })),
                    ("total", .number(rail.total)), ("closed", .bool(rail.closed)),
                ])
                let at = list("at").map { s -> JSONValue in
                    let p = vectorBlendRailAt(rail, num(s))
                    return .object(JSONObject([("point", point(p.point)), ("angle", .number(p.angle))]))
                }
                return .object(JSONObject([("rail", .object(r)), ("at", .array(at))]))
            })
        case "generateVectorBlendChildren": return .array(try list("groups").map { nodes(try generateVectorBlendChildren(try node($0))) })
        case "vectorBlendKeyTargets": return .array(try list("groups").map { .array(try vectorBlendKeyTargets(try node($0)).map(point)) })
        case "expandVectorBlend":
            return .array(try list("groups").map { g in
                var n = 0
                return expandVectorBlend(try live(try node(g))) {
                    n += 1
                    return "e\(n)"
                }.toJSON()
            })
        case "releaseVectorBlend":
            return .array(try list("groups").map { g in
                var n = 0
                return nodes(try releaseVectorBlend(try live(try node(g))) {
                    n += 1
                    return "r\(n)"
                })
            })

        // Warps
        case "vectorWarpPresetGrid":
            return .array(list("cases").map { c in
                .array(vectorWarpPresetGrid(at(c, 0).stringValue!, num(at(c, 1)), num(at(c, 2)), num(at(c, 3)), at(c, 4).boolValue!, num(at(c, 5))).map { row in .array(row.map { .array($0.map { .number($0) }) }) })
            })
        case "vectorWarpPresetMesh": return .array(list("presets").map { vectorWarpPresetMesh($0.objectValue!, bounds(e["bounds"]))?.json ?? .null })
        case "resizeVectorMesh": return .array(list("cases").map { c in resizeVectorMesh(mesh(at(c, 0)), num(at(c, 1)), num(at(c, 2))).json })
        case "evalVectorMesh": return .array(list("meshes").map { m in .array(list("uv").map { evalVectorMesh(mesh(m), num(at($0, 0)), num(at($0, 1))).json }) })
        case "splitVectorMesh":
            let m = mesh(e["mesh"])
            return .array(list("at").map { s in
                .object(JSONObject([("u", splitVectorMeshU(m, num(s))?.json ?? .null), ("v", splitVectorMeshV(m, num(s))?.json ?? .null)]))
            })
        case "isValidVectorMesh": return .array(list("values").map { .bool(isValidVectorMesh($0)) })
        case "vectorMeshFromOutline": return .array(try list("cases").map { c in vectorMeshFromOutline(try VectorSubpath(json: at(c, 0)), num(at(c, 1)), num(at(c, 2)))?.json ?? .null })
        case "vectorMeshOutline": return .array(list("meshes").map { vectorMeshOutline(mesh($0)).toJSON() })

        // Envelopes
        case "normalizeVectorEffectParams":
            return .array(try list("cases").map { c in try normalizeVectorEffectParams("envelope", c["params"]?.objectValue, c["base"]?.objectValue).map { .object($0) } ?? .null })
        case "expandVectorAppearance": return .array(try list("nodes").map { try expandVectorAppearance(try node($0)).toJSON() })
        case "vectorEnvelopeFrame":
            return .array(try list("nodes").map { n in
                let v = try node(n)
                let id = v["effects"]?.arrayValue?.first { $0["type"] == "envelope" }?["id"]?.stringValue
                guard let f = try vectorEnvelopeFrame(v, id) else { return .null }
                return .object(JSONObject([("effectId", .string(f.effectId)), ("bounds", f.bounds.json), ("mesh", f.mesh.json)]))
            })
        case "transformVectorEffects":
            return .array(try list("nodes").map { n in
                let v = try node(n)
                return .array(try list("matrices").map { .array(try transformVectorEffects(v["effects"]!.arrayValue!, VectorMatrix(json: $0)!, v)) })
            })

        // Symmetry
        case "vectorSymmetryMatrices": return .array(list("settings").map { .array(vectorSymmetryMatrices($0.objectValue!).map(\.json)) })
        case "vectorSymmetryAxes":
            return .array(list("settings").map { s in .array(vectorSymmetryAxes(s.objectValue!, bounds(e["box"])).map { .array([$0.0.json, $0.1.json]) }) })
        case "sanitizeVectorSymmetry": return .array(list("values").map { sanitizeVectorSymmetry($0).map { .object($0) } ?? .null })
        case "transformVectorSymmetry":
            return .array(list("settings").map { s in .array(list("matrices").map { .object(transformVectorSymmetry(s.objectValue!, VectorMatrix(json: $0)!)) }) })
        case "vectorSymmetryDrawn": return .array(try list("groups").map { try vectorSymmetryDrawn(try node($0)).toJSON() })
        case let fn:
            throw VectorEditorError("No blend function \(fn).")
        }
    }

    func testBlendVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 50)
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
        if let d = mismatch(try host.document(), commands["document"]!, true) { XCTFail("document: \(d)") }
        if let d = mismatch(try await call(host, "vector.importSvg", ["svg": .string(svg), "replace": true]), commands["imported"]!, true) { XCTFail("import: \(d)") }
        if let d = mismatch(try await call(host, "vector.list"), commands["after"]!, true) { XCTFail("list after import: \(d)") }
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "generateVectorBlendChildren" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, true))
        guard case .array(var groups) = e["out"]!, case .array(var children) = groups[1], case .object(var step) = children[1] else { return XCTFail("no step") }
        step["fill"] = "#000001"
        children[1] = .object(step)
        groups[1] = .array(children)
        XCTAssertNotNil(mismatch(got, .array(groups), true))
        XCTAssertNotNil(mismatch(digest("<svg/>"), Self.vectors["commands"]!["svg"]!, false))
    }
}
