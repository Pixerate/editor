import Foundation
import PixerateCore
import PixerateGeometry
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for frames, pages, connectors, snapping options and perspective grids:
/// frames as drawn, their children's resizing, bounds, transforms and masks, master pages,
/// connection sites, routes and rerouting, polar angles, perspective planes, maps and grid lines,
/// and SVG export, import and render data of frames and connectors
/// (`packages/core/tests/swift-vector-frame-vectors.test.ts` writes `Fixtures/vector-frame-vectors.json`).
/// Entries marked `trig: false` compare exactly, `trig: true` ones within relative 1e-9; strings
/// always exactly. Keys compare as sets. `commands` replays agent commands and compares their
/// results, error texts, the saved document, the SVG export and the render data.
final class VectorFrameVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-frame-vectors", withExtension: "json", subdirectory: "Fixtures")!
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

    private func obj(_ pairs: [(String, JSONValue)]) -> JSONValue { .object(JSONObject(pairs)) }
    private func node(_ v: JSONValue) throws -> VectorNode { try VectorNode(json: v) }
    private func matrix(_ v: JSONValue) -> VectorMatrix { VectorMatrix(json: v)! }
    private func bounds(_ v: JSONValue) -> VectorBounds {
        VectorBounds(x: v["x"]!.numberValue!, y: v["y"]!.numberValue!, width: v["width"]!.numberValue!, height: v["height"]!.numberValue!)
    }
    private func pointOrNull(_ p: Vec2?) -> JSONValue { p?.json ?? .null }
    private func subpaths(_ list: [VectorSubpath]) -> JSONValue { .array(list.map { $0.toJSON() }) }

    private func routedEnd(_ v: JSONValue) -> VectorRoutedEnd {
        VectorRoutedEnd(x: v["x"]!.numberValue!, y: v["y"]!.numberValue!, nx: v["nx"]!.numberValue!, ny: v["ny"]!.numberValue!, glued: v["glued"]!.boolValue!)
    }

    private func routing(_ r: VectorConnectorRouting?) -> JSONValue {
        guard let r else { return .null }
        return obj([
            ("subpaths", subpaths(r.subpaths)), ("startSide", r.startSide.map { .string($0) } ?? .null), ("endSide", r.endSide.map { .string($0) } ?? .null),
            ("dropped", obj([("start", .bool(r.droppedStart)), ("end", .bool(r.droppedEnd))])),
        ])
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        func doc(_ k: String = "doc") throws -> VectorDocument { try VectorDocument(json: e[k]!) }
        func grid() -> JSONObject { e["grid"]!.objectValue! }
        let planes = ["floor", "left", "right", "side", "front"]
        switch e["fn"]!.stringValue! {
        case "vectorFrameDrawn": return vectorFrameDrawn(try node(e["node"]!)).toJSON()
        case "expandVectorAppearance": return try expandVectorAppearance(try node(e["node"]!)).toJSON()
        case "vectorNodeBounds":
            let n = try node(e["node"]!)
            return .array(try list("parents").map { try vectorNodeBounds(n, matrix($0))?.json ?? .null })
        case "transformVectorNode":
            let n = try node(e["node"]!)
            return .array(try list("matrices").map { try transformVectorNode(n, matrix($0)).toJSON() })
        case "vectorFrameChildMatrix":
            let vrules = list("vrules")
            return .array(list("rules").enumerated().map { i, h in
                let v = vrules[i]
                var resizing: JSONValue?
                if h.stringValue != nil || v.stringValue != nil {
                    var o = JSONObject()
                    if let h = h.stringValue { o["horizontal"] = .string(h) }
                    if let v = v.stringValue { o["vertical"] = .string(v) }
                    resizing = .object(o)
                }
                return .array(list("boxes").map { box in
                    .array(list("sizes").map { pair in
                        vectorFrameChildMatrix(resizing, bounds(box), bounds(pair.arrayValue![0]), bounds(pair.arrayValue![1])).json
                    })
                })
            })
        case "sanitizeVectorFrame": return .array(list("values").map { sanitizeVectorFrame($0).map { .object($0) } ?? .null })
        case "sanitizeVectorResizing": return .array(list("values").map { sanitizeVectorResizing($0).map { .object($0) } ?? .null })
        case "sanitizeVectorConnector": return .array(list("values").map { sanitizeVectorConnector($0).map { .object($0) } ?? .null })
        case "sanitizeVectorPerspective": return .array(list("values").map { sanitizeVectorPerspective($0).map { .object($0) } ?? .null })
        case "vectorPolarAngles":
            return .array(list("cases").map { c in
                let pair = c.arrayValue!
                return .array(vectorPolarAngles(pair[0].numberValue ?? .infinity, pair[1].arrayValue!.map { $0.numberValue! }).map { .number($0) })
            })
        case "vectorConnectionSites":
            let nodes = try list("nodes").map(node)
            return .array(try vectorConnectionSites(nodes, e["id"]!.stringValue!).map(\.json))
        case "vectorConnectorWorldAnchors":
            let route = e["route"]!.stringValue!
            return .array(list("ends").map { pair in
                let ab = pair.arrayValue!
                return .array(list("options").map { o in
                    .array(vectorConnectorWorldAnchors(routedEnd(ab[0]), routedEnd(ab[1]), route, radius: o["radius"]?.numberValue, gap: o["gap"]?.numberValue).map { $0.toJSON() })
                })
            })
        case "routeVectorConnector":
            let nodes = try list("nodes").map(node)
            return .array(try list("ids").map { routing(try routeVectorConnector(nodes, $0.stringValue!)) })
        case "rerouteVectorConnectors":
            let d = try doc()
            var out = d
            let nodes = rerouteVectorConnectors(d.nodes)
            if e["name"]?.stringValue == "again" {
                out.nodes = nodes
                return obj([("same", .bool(nodes == d.nodes)), ("doc", out.toJSON())])
            }
            out.nodes = nodes
            return out.toJSON()
        case "vectorPerspectivePlanes": return .array(vectorPerspectivePlanes(grid()).map { .string($0) })
        case "vectorPerspectivePlaneMap": return .array(planes.map { p in vectorPerspectivePlaneMap(grid(), p).map { .array($0.map { .number($0) }) } ?? .null })
        case "vectorPerspectiveFlatToPlane", "vectorPerspectivePlaneToFlat":
            let flat = e["fn"]!.stringValue! == "vectorPerspectiveFlatToPlane"
            let samples = list("samples").map { Vec2(json: $0)! }
            return .array(planes.map { p in
                guard let f = flat ? vectorPerspectiveFlatToPlane(grid(), p) : vectorPerspectivePlaneToFlat(grid(), p) else { return .null }
                return .array(samples.map { pointOrNull(f($0)) })
            })
        case "vectorPerspectiveMapPath":
            return .array(planes.map { p in
                .array(list("paths").map { d in
                    let path = subpathsToBezier(bezierToSubpaths(.svg(d.stringValue!)))
                    return vectorPerspectiveMapPath(grid(), p, path).map { subpaths(bezierToSubpaths(.commands($0))) } ?? .null
                })
            })
        case "vectorPerspectiveGridLines":
            return .array(planes.map { p in .array(vectorPerspectiveGridLines(grid(), p).map { obj([("a", $0.a.json), ("b", $0.b.json)]) }) })
        case "vectorPerspectivePreset":
            return .array(list("cases").map { c in
                let a = c.arrayValue!.map { $0.numberValue! }
                return .object(vectorPerspectivePreset(Int(a[0]), a[1], a[2]))
            })
        case "resolveVectorMasterPages":
            let d = try doc()
            let r = resolveVectorMasterPages(d)
            if e["name"]?.stringValue == "again" { return obj([("same", .bool(r == d)), ("doc", r.toJSON())]) }
            return r.toJSON()
        case "stripVectorMasterArt": return stripVectorMasterArt(try doc()).toJSON()
        case "pageLists":
            let d = try doc()
            return obj([
                ("pages", .array(vectorPages(d.nodes).map { .string($0.id) })), ("masters", .array(vectorMasterPages(d.nodes).map { .string($0.id) })),
                ("isMaster", .array(d.nodes.map { .bool(isVectorMasterPage($0)) })),
            ])
        case "vectorFrameDocument":
            let d = try doc()
            return .array(list("ids").map { vectorFrameDocument(d, $0.stringValue!)?.toJSON() ?? .null })
        case "vectorDocumentToSvg": return .string(try vectorDocumentToSvg(try doc()))
        case "parseVectorSvg": return try parseVectorSvg(e["svg"]!.stringValue!).toJSON()
        case "getVectorSceneRenderData": return try getVectorSceneRenderData(try doc())
        case let fn:
            throw VectorEditorError("No frame function \(fn).")
        }
    }

    func testFrameVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 50)
        for (i, e) in entries.enumerated() {
            let fn = e["fn"]!.stringValue!
            let label = e["name"]?.stringValue.map { "\(fn) (\($0))" } ?? fn
            do {
                if let d = mismatch(try run(e), e["out"]!, e["trig"]!.boolValue!) { XCTFail("entry \(i) \(label): \(d)") }
            } catch {
                XCTFail("entry \(i) \(label) threw: \(error)")
            }
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
            if let d = mismatch(got, step["result"]!, false) { XCTFail("step \(i) \(step["id"]!.stringValue!): \(d)") }
        }
        if let d = mismatch(try host.document(), commands["document"]!, false) { XCTFail("document: \(d)") }
        XCTAssertEqual(try host.controller.toSvg(), commands["svg"]!.stringValue!)
        if let d = mismatch(try host.render() ?? .null, commands["render"]!, false) { XCTFail("render: \(d)") }
    }

    /// Undo takes a frame resize, a connector and a perspective grid back one step each, and the
    /// connector follows its object through undo and redo.
    func testUndoAndRedo() async throws {
        let host = try VectorConformanceHost(setup: ["width": 300, "height": 200])
        let c = host.controller
        _ = try await call(host, "vector.addShape", ["kind": "rect", "x": 10, "y": 10, "width": 20, "height": 20])
        _ = try await call(host, "vector.addShape", ["kind": "rect", "x": 100, "y": 100, "width": 20, "height": 20])
        _ = try await call(host, "vector.connect", ["start": ["nodeId": "n1"], "end": ["nodeId": "n2"], "endArrow": .null])
        let routed = c.getNode("n3")!.subpaths
        _ = try await call(host, "vector.transform", ["ids": ["n2"], "dx": 50])
        XCTAssertNotEqual(c.getNode("n3")!.subpaths, routed)
        XCTAssertTrue(c.undo())
        XCTAssertEqual(c.getNode("n3")!.subpaths, routed)
        XCTAssertTrue(c.redo())
        XCTAssertEqual(c.getConnectors()[0]["end"]?["x"], 150)
        _ = try await call(host, "vector.setPerspective", ["vanishingPoints": [["x": 0, "y": 50]], "origin": ["x": 150, "y": 180]])
        _ = try await call(host, "vector.setPerspectivePlane", ["plane": "side"])
        XCTAssertEqual(c.perspectivePlane, "side")
        XCTAssertTrue(c.undo())
        XCTAssertNil(c.getPerspective())
        XCTAssertNil(c.perspectivePlane)
        // The saved document never holds a page's drawn master art.
        _ = try await call(host, "vector.addPage")
        _ = try await call(host, "vector.addMasterPage", ["assignTo": "all"])
        _ = try await call(host, "vector.addShape", ["kind": "rect", "x": 0, "y": 230, "width": 30, "height": 10, "parentId": "n5"])
        XCTAssertEqual(c.document.nodes.first { $0.id == "n4" }?["masterArt"]?.arrayValue?.count, 1)
        XCTAssertFalse(try c.editorDocument().stringified().contains("masterArt"))
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "routeVectorConnector" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, true))
        guard case .array(var routes) = e["out"]!, case .object(var first) = routes[0] else { return XCTFail("no routes") }
        first["startSide"] = "left"
        routes[0] = .object(first)
        XCTAssertNotNil(mismatch(got, .array(routes), true))
        let sites = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "vectorConnectionSites" && $0["id"] == "p" }!
        let x = try run(sites).arrayValue![0]["x"]!.numberValue!
        XCTAssertNotNil(mismatch(.number(x.nextUp), .number(x), false))
    }
}
