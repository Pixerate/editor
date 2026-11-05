import Foundation
import PixerateContracts
import PixerateCore
import PixerateGeometry
import XCTest
@testable import PixerateVector

/// The TS core's own outputs (`packages/core/tests/swift-vector-model-vectors.test.ts` writes
/// `Fixtures/vector-model-vectors.json`): document round trips and the plain-path geometry. Entries
/// marked `trig: false` compare exactly, `trig: true` ones within relative 1e-9. Object keys
/// compare in order (that is what `toJSON` writes).
final class VectorModelVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-model-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    // MARK: Comparison

    private func mismatch(_ got: JSONValue, _ want: JSONValue, _ trig: Bool, _ path: inout [String]) -> String? {
        switch (got, want) {
        case let (.number(g), .number(w)):
            if g == w { return nil }
            if trig && abs(g - w) <= 1e-9 * max(1, abs(g), abs(w)) { return nil }
            return "\(g) != \(w)"
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(g.count) items != \(w.count): \(JSONValue.array(g).stringified().prefix(400)) vs \(JSONValue.array(w).stringified().prefix(400))" }
            for i in 0 ..< g.count {
                path.append("[\(i)]")
                if let d = mismatch(g[i], w[i], trig, &path) { return d }
                path.removeLast()
            }
            return nil
        case let (.object(g), .object(w)):
            if g.keys != w.keys { return "keys \(g.keys) != \(w.keys)" }
            for k in w.keys {
                path.append(".\(k)")
                if let d = mismatch(g[k]!, w[k]!, trig, &path) { return d }
                path.removeLast()
            }
            return nil
        default:
            return got == want ? nil : "\(got.stringified().prefix(300)) != \(want.stringified().prefix(300))"
        }
    }

    // MARK: Documents

    func testDocumentsRoundTrip() throws {
        for d in Self.vectors["documents"]!.arrayValue! {
            let want = d["doc"]!
            let doc = try VectorDocument(json: want)
            XCTAssertEqual(doc.toJSON().stringified(), want.stringified(), "document \(d["name"]!.stringValue!)")
            // A copy written and read again stays the same.
            XCTAssertEqual(try VectorDocument(json: doc.toJSON()), doc)
        }
    }

    /// Every document recorded in the vector conformance scenarios reads and writes back unchanged.
    func testRecordedScenarioDocumentsRoundTrip() throws {
        let dir = ConformanceContracts.url("domains/vector/fixtures")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        XCTAssertFalse(files.isEmpty)
        var count = 0
        // Recorded documents are the `document` members (`vector.list` results look alike but are not documents).
        func visit(_ v: JSONValue) throws {
            switch v {
            case .object(let o):
                for (k, x) in o {
                    if k == "document", x["nodes"]?.arrayValue != nil, x["width"]?.numberValue != nil {
                        let doc = try VectorDocument(json: x)
                        XCTAssertEqual(doc.toJSON().stringified(), x.stringified())
                        count += 1
                    }
                    try visit(x)
                }
            case .array(let a): for x in a { try visit(x) }
            default: break
            }
        }
        for f in files { try visit(JSONValue.parse(Data(contentsOf: f))) }
        XCTAssertGreaterThan(count, 10)
    }

    // MARK: Geometry

    func testGeometryVectors() throws {
        var checked = 0
        var skipped: [String] = []
        var failures: [String] = []
        for (index, e) in Self.vectors["geometry"]!.arrayValue!.enumerated() {
            let fn = e["fn"]!.stringValue!
            let label = "geometry[\(index)] \(fn)\(e["name"]?.stringValue.map { " (\($0))" } ?? "")\(e["node"]?["id"]?.stringValue.map { " node \($0)" } ?? "")\(e["matrix"]?.stringValue.map { " × \($0)" } ?? "")"
            do {
                let got = try run(fn, e)
                checked += 1
                var path: [String] = []
                if let d = mismatch(got, e["out"]!, e["trig"]?.boolValue ?? false, &path) { failures.append("\(label) at \(path.joined()): \(d)") }
            } catch let error as VectorNotPorted {
                skipped.append("\(label): \(error)")
            } catch {
                failures.append("\(label): threw \(error)")
            }
        }
        XCTAssertGreaterThan(checked, 500)
        for f in failures.prefix(30) { XCTFail(f) }
        if failures.count > 30 { XCTFail("… and \(failures.count - 30) more failures") }
        // Only the entries that reach unported features (#624) may be skipped: the symmetry
        // group's bounds (a live appearance) and a frame holding text transformed by a map that
        // is not an axis-aligned scale (text geometry).
        for s in skipped {
            let expected = (s.contains("vectorNodeBounds") && s.contains("node symmetry")) || (s.contains("transformVectorNode") && s.contains("node frame"))
            XCTAssertTrue(expected, "unexpected skip: \(s)")
        }
    }

    private func run(_ fn: String, _ e: JSONValue) throws -> JSONValue {
        switch fn {
        case "subpathsToBezier": return encode(subpathsToBezier(try subpaths(e["subpaths"]), corners: e["corners"]!.boolValue!))
        case "vectorPathData": return .string(vectorPathData(try subpaths(e["subpaths"]), precision: Int(e["precision"]!.numberValue!)))
        case "expandVectorCorners": return .array(expandVectorCorners(try subpaths(e["subpaths"])).map { $0.toJSON() })
        case "vectorCorners": return .array(vectorCorners(try subpaths(e["subpaths"])).map(encode))
        case "roundSubpaths": return .array(roundSubpaths(try subpaths(e["subpaths"]), Int(e["precision"]!.numberValue!)).map { $0.toJSON() })
        case "cloneSubpaths": return .array(try subpaths(e["subpaths"]).map { cloneSubpath($0).toJSON() })
        case "bezierToSubpaths": return .array(bezierToSubpaths(.svg(e["d"]!.stringValue!)).map { $0.toJSON() })
        case "inferAnchorType": return .array(try anchors(e["anchors"]).map { .string(inferAnchorType($0).rawValue) })
        case "cloneAnchor": return .array(try anchors(e["anchors"]).map { cloneAnchor($0).toJSON() })
        case "translateAnchor":
            return .array(try anchors(e["anchors"]).map { translateAnchor($0, e["dx"]!.numberValue!, e["dy"]!.numberValue!).toJSON() })
        case "moveAnchorHandle":
            return .array(try e["cases"]!.arrayValue!.map { c in
                moveAnchorHandle(try VectorAnchor(json: c["anchor"]!), VectorHandleSide(rawValue: c["side"]!.stringValue!)!, Vec2(json: c["pos"])!, c["breakHandles"]!.boolValue!).toJSON()
            })
        case "convertAnchor":
            let sp = try VectorSubpath(json: e["subpath"]!)
            let type = VectorAnchorType(rawValue: e["type"]!.stringValue!)!
            return .array(e["indices"]!.arrayValue!.map { convertAnchor(sp, Int($0.numberValue!), type).toJSON() })
        case "insertAnchor":
            let sp = try VectorSubpath(json: e["subpath"]!)
            return .array(e["cases"]!.arrayValue!.map { c in
                let r = insertAnchor(sp, Int(c["segment"]!.numberValue!), c["t"]!.numberValue!)
                return ["subpath": r.subpath.toJSON(), "index": .number(Double(r.index))]
            })
        case "removeAnchors":
            return removeAnchors(try VectorSubpath(json: e["subpath"]!), e["indices"]!.arrayValue!.map { Int($0.numberValue!) }).toJSON()
        case "reverseSubpath": return reverseSubpath(try VectorSubpath(json: e["subpath"]!)).toJSON()
        case "rectSubpath":
            return rectSubpath(box(e["box"]!), e["radius"]?.numberValue ?? 0, e["kind"]?.stringValue).toJSON()
        case "ellipseSubpath": return ellipseSubpath(box(e["box"]!)).toJSON()
        case "polygonSubpath": return polygonSubpath(box(e["box"]!), e["sides"]!.numberValue!).toJSON()
        case "starSubpath": return starSubpath(box(e["box"]!), e["points"]!.numberValue!, e["innerRatio"]!.numberValue!).toJSON()
        case "lineSubpath": return lineSubpath(Vec2(json: e["a"])!, Vec2(json: e["b"])!).toJSON()
        case "setSubpathCorners":
            return setSubpathCorners(try VectorSubpath(json: e["subpath"]!), e["radius"]!.numberValue!, e["kind"]?.stringValue, e["smoothing"]?.numberValue).toJSON()
        case "matrix": return Self.matrices[e["name"]!.stringValue!]!.json
        case "invertMatrix": return invertMatrix(matrix(e["m"])!).json
        case "matrixRotation": return .number(matrixRotation(matrix(e["m"])!))
        case "decomposeRigid":
            let r = decomposeRigid(matrix(e["m"])!)
            return ["rigid": r.rigid.json, "residual": r.residual.json]
        case "multiplyMatrices": return multiplyMatrices(matrix(e["a"])!, matrix(e["b"])!).json
        case "walkVectorNodes":
            var out: [JSONValue] = []
            walkVectorNodes(try nodes(e["nodes"])) { n, parent, depth in
                out.append([.string(n.id), parent.map { .string($0.id) } ?? .null, .number(Double(depth))])
            }
            return .array(out)
        case "findVectorNode":
            let list = try nodes(e["nodes"])
            return .array(e["ids"]!.arrayValue!.map { id in findVectorNode(list, id.stringValue!).map { .string($0.id) } ?? .null })
        case "locateVectorNode":
            let list = try nodes(e["nodes"])
            return .array(e["ids"]!.arrayValue!.map { id in
                guard let hit = locateVectorNode(list, id.stringValue!) else { return .null }
                XCTAssertEqual(list[path: hit.path].id, id.stringValue!)
                return ["path": .array(hit.path.map { .number(Double($0)) }), "index": .number(Double(hit.index)), "parent": hit.parent.map { .string($0.id) } ?? .null]
            })
        case "vectorWorldMatrix":
            let list = try nodes(e["nodes"])
            return .array(e["ids"]!.arrayValue!.map { vectorWorldMatrix(list, $0.stringValue!)?.json ?? .null })
        case "vectorParentMatrix":
            let list = try nodes(e["nodes"])
            return .array(e["ids"]!.arrayValue!.map { vectorParentMatrix(list, $0.stringValue!)?.json ?? .null })
        case "collectPaintedNodes": return .array(collectPaintedNodes(try VectorNode(json: e["node"]!)).map { .string($0.id) })
        case "collectPathNodes": return .array(collectPathNodes(try VectorNode(json: e["node"]!)).map { .string($0.id) })
        case "vectorNodeRotation": return .number(vectorNodeRotation(try VectorNode(json: e["node"]!)))
        case "cloneVectorNode": return try cloneVectorNode(try VectorNode(json: e["node"]!)).toJSON()
        case "vectorNodeBounds":
            let node = try VectorNode(json: e["node"]!)
            let b = try vectorNodeBounds(node, matrix(e["parent"]) ?? IDENTITY_MATRIX)
            return b?.json ?? .null
        case "transformVectorNode": return try transformVectorNode(try VectorNode(json: e["node"]!), matrix(e["m"])!).toJSON()
        case "nearestSegment":
            let node = try VectorNode(json: e["node"]!)
            return .array(e["points"]!.arrayValue!.map { p in
                guard let r = nearestSegment(node, Vec2(json: p)!) else { return .null }
                return ["subpath": .number(Double(r.subpath)), "segment": .number(Double(r.segment)), "t": .number(r.t), "point": r.point.json, "distance": .number(r.distance)]
            })
        case "unionBounds":
            let boxes = e["boxes"]!.arrayValue!.map { $0.isNull ? nil : box($0) }
            return [unionBounds(boxes)?.json ?? .null, unionBounds([])?.json ?? .null, unionBounds([nil])?.json ?? .null]
        case "boundsIntersect": return .array(e["pairs"]!.arrayValue!.map { p in .bool(boundsIntersect(box(p.arrayValue![0]), box(p.arrayValue![1]))) })
        case "boundsFromPoints": return boundsFromPoints(Vec2(json: e["a"])!, Vec2(json: e["b"])!).json
        case "hasPaint": return .array(e["paints"]!.arrayValue!.map { .bool(hasPaint($0["absent"] != nil ? nil : $0["paint"])) })
        default:
            XCTFail("unknown fn \(fn)")
            return .null
        }
    }

    /// The test's matrices, built as the TS test builds them.
    static let matrices: [String: VectorMatrix] = [
        "identity": IDENTITY_MATRIX,
        "translate": translateMatrix(12.5, -7),
        "scale": scaleMatrix(1.5, 0.5, Vec2(100, 30)),
        "mirror": scaleMatrix(-1, 1, Vec2(10, 0)),
        "flipBoth": scaleMatrix(-2, -0.5),
        "rotate": rotateMatrix(30, Vec2(30, 30)),
        "rotate90": rotateMatrix(90),
        "skew": skewMatrix(20, 0, Vec2(250, 80)),
        "rotateScale": multiplyMatrices(scaleMatrix(2, 3), rotateMatrix(-45, Vec2(5, 5))),
    ]

    // MARK: Decoding and encoding

    private func subpaths(_ v: JSONValue?) throws -> [VectorSubpath] { try v!.arrayValue!.map { try VectorSubpath(json: $0) } }
    private func anchors(_ v: JSONValue?) throws -> [VectorAnchor] { try v!.arrayValue!.map { try VectorAnchor(json: $0) } }
    private func nodes(_ v: JSONValue?) throws -> [VectorNode] { try v!.arrayValue!.map { try VectorNode(json: $0) } }
    private func matrix(_ v: JSONValue?) -> VectorMatrix? { VectorMatrix(json: v) }
    private func box(_ v: JSONValue) -> VectorBounds {
        VectorBounds(x: v["x"]!.numberValue!, y: v["y"]!.numberValue!, width: v["width"]!.numberValue!, height: v["height"]!.numberValue!)
    }
    private func box(_ v: JSONValue?) -> VectorBounds { box(v!) }

    private func encode(_ path: BezierPath) -> JSONValue {
        .array(path.map { c in
            switch c {
            case let .M(x, y): return ["M", .number(x), .number(y)]
            case let .L(x, y): return ["L", .number(x), .number(y)]
            case let .Q(x1, y1, x, y): return ["Q", .number(x1), .number(y1), .number(x), .number(y)]
            case let .C(x1, y1, x2, y2, x, y): return ["C", .number(x1), .number(y1), .number(x2), .number(y2), .number(x), .number(y)]
            default: return ["Z"]
            }
        })
    }

    private func encode(_ c: VectorCornerInfo) -> JSONValue {
        .object(JSONObject([
            ("subpath", .number(Double(c.subpath))), ("index", .number(Double(c.index))), ("at", c.at.json), ("u", c.u.json), ("v", c.v.json),
            ("lu", .number(c.lu)), ("lv", .number(c.lv)), ("cos", .number(c.cos)), ("sin", .number(c.sin)), ("angle", .number(c.angle)), ("maxRadius", .number(c.maxRadius)),
        ]))
    }
}
