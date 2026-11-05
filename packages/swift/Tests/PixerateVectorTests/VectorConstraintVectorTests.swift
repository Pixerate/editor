import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for constraints: expressions and parameters, the Levenberg–Marquardt
/// solver and its rank tools, every constraint kind solved, over-constrained and unsatisfiable
/// systems, adding constraints, degrees of freedom, purging, auto-constrain at several tolerances
/// and the glyph and panel data (`packages/core/tests/swift-vector-constraint-vectors.test.ts`
/// writes `Fixtures/vector-constraint-vectors.json`). Entries marked `trig: false` compare exactly,
/// `trig: true` ones (angle rows, through `Math.atan2`) within relative 1e-9; strings always
/// exactly. Keys compare as sets. `commands` replays agent commands and compares their results,
/// error texts and the saved document.
final class VectorConstraintVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-constraint-vectors", withExtension: "json", subdirectory: "Fixtures")!
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
    private func nums(_ v: [Double]) -> JSONValue { .array(v.map { .number($0) }) }
    private func strs(_ v: [String]) -> JSONValue { .array(v.map { .string($0) }) }

    /// `{ value }` or `{ error }`, as the TS `each` writes them.
    private func each(_ f: () throws -> JSONValue) -> JSONValue {
        do { return obj([("value", try f())]) } catch { return obj([("error", .string(constraintErrorMessage(error)))]) }
    }

    /// The result, or `{ error, ids? }` as the TS `vec` writes a thrown error.
    private func caught(_ f: () throws -> JSONValue) -> JSONValue {
        do { return try f() } catch let e as VectorConstraintError {
            return obj([("error", .string(e.message)), ("ids", strs(e.ids))])
        } catch {
            return obj([("error", .string(constraintErrorMessage(error)))])
        }
    }

    private func skippedJSON(_ s: [(id: String, message: String)]) -> JSONValue {
        .array(s.map { obj([("id", .string($0.id)), ("message", .string($0.message))]) })
    }

    private func residualsJSON(_ r: [String: Double?]) -> JSONValue {
        .object(JSONObject(r.keys.sorted().map { k in (k, r[k]!.map { .number($0) } ?? .null) }))
    }

    private func refs(_ v: JSONValue?) -> [VectorAnchorRef] {
        (v?.arrayValue ?? []).map { VectorAnchorRef(nodeId: $0["nodeId"]!.stringValue!, subpath: Int($0["subpath"]!.numberValue!), index: Int($0["index"]!.numberValue!)) }
    }

    private func infer(_ o: JSONValue?) -> VectorInferOptions {
        VectorInferOptions(distanceTolerance: o?["distanceTolerance"]?.numberValue, angleTolerance: o?["angleTolerance"]?.numberValue, kinds: o?["kinds"]?.arrayValue?.compactMap(\.stringValue))
    }

    /// The residual functions of the `solveLm` vectors (`lmSystem` in the TS test).
    private func lmSystem(_ name: String) -> ResidualFn {
        let pts: [(Double, Double)] = [(10, 0), (0, 7), (-9, 1)]
        switch name {
        case "circle3": return { x, out in for (px, py) in pts { out.append(JS.hypot(px - x[0], py - x[1]) - x[2]) } }
        case "distance": return { x, out in out.append(JS.hypot(x[2] - x[0], x[3] - x[1]) - 10) }
        default: return { x, out in out.append(x[0] + x[1] - 1); out.append(x[0] + x[1] - 2) }
        }
    }

    private func run(_ e: JSONValue) throws -> JSONValue {
        func list(_ k: String) -> [JSONValue] { e[k]!.arrayValue! }
        func doc(_ k: String = "doc") throws -> VectorDocument { try VectorDocument(json: e[k]!) }
        switch e["fn"]!.stringValue! {
        case "evalVectorExpression": return .array(list("exprs").map { x in each { .number(try evalVectorExpression(x.stringValue!)) } })
        case "checkVectorExpression": return .array(list("exprs").map { x in each { try checkVectorExpression(x.stringValue!); return true } })
        case "vectorExpressionNames": return .array(list("exprs").map { x in each { strs(try vectorExpressionNames(x.stringValue!)) } })
        case "isValidVectorParameterName": return .array(list("names").map { .bool(isValidVectorParameterName($0.stringValue!)) })
        case "formatVectorValue": return .array(list("values").map { .string(formatVectorValue($0.numberValue!)) })
        case "VectorExprEnv":
            let pairs = list("pairs").map { ($0.arrayValue![0].stringValue!, $0.arrayValue![1].stringValue!) }
            let env = VectorExprEnv()
            for (n, v) in pairs { env.set(n, v) }
            return obj([
                ("values", .array(pairs.map { p in each { .number(try env.value(p.0)) } })),
                ("eval", each { .number(try env.eval("\(pairs[0].0) * 2 + 1")) }),
                ("has", .array([.bool(env.has(pairs[0].0)), .bool(env.has("nope"))])),
            ])
        case "constraintRank":
            let rows = Int(e["rows"]!.numberValue!), cols = Int(e["cols"]!.numberValue!)
            let m = list("m").map { $0.numberValue! }
            let ns = constraintNullSpace(m, rows, cols)
            return obj([("rank", .number(Double(constraintRankQr(m, rows, cols)))), ("nullRank", .number(Double(ns.rank))), ("basis", .array(ns.basis.map(nums)))])
        case "constraintQr":
            let r = constraintQr(list("cols").map { $0.arrayValue!.map { $0.numberValue! } }, e["rel"]!.numberValue!, e["abs"]!.numberValue!)
            return obj([("rank", .number(Double(r.rank))), ("reflectors", .array(r.reflectors.map(nums)))])
        case "solveLm":
            let r = constraintSolveLm(lmSystem(e["name"]!.stringValue!), list("x0").map { $0.numberValue! }, list("free").map { Int($0.numberValue!) }, list("weights").map { $0.numberValue! }, 1e-9, 200)
            return obj([("x", nums(r.x)), ("converged", .bool(r.converged))])
        case "solve":
            let d = try doc()
            if let p = e["previous"] {
                let r = solveVectorConstraints(d, try VectorDocument(json: p))
                return obj([("document", r.document.toJSON()), ("converged", .bool(r.converged)), ("conflicts", strs(r.conflicts)), ("skipped", skippedJSON(r.skipped))])
            }
            let r = solveVectorConstraints(d)
            if e["name"]!.stringValue!.hasPrefix("after a drag") {
                return obj([("document", r.document.toJSON()), ("converged", .bool(r.converged)), ("conflicts", strs(r.conflicts)), ("skipped", skippedJSON(r.skipped))])
            }
            return obj([
                ("document", r.document.toJSON()), ("converged", .bool(r.converged)), ("conflicts", strs(r.conflicts)), ("skipped", skippedJSON(r.skipped)),
                ("dof", vectorConstraintDof(d).json), ("residuals", residualsJSON(vectorConstraintResiduals(d))), ("after", residualsJSON(vectorConstraintResiduals(r.document))),
            ])
        case "purge":
            let r = purgeVectorConstraints(try doc())
            return obj([("document", r.document.toJSON()), ("removed", strs(r.removed))])
        case "addVectorConstraint":
            let d = try doc()
            return caught { try addVectorConstraint(d, e["constraint"]!.objectValue!).toJSON() }
        case "measureVectorConstraint":
            let d = try doc()
            let c = VectorConstraint(json: e["constraint"]!.objectValue!)
            return caught { .number(try measureVectorConstraint(d, kind: c.kind, refs: c.refs, axis: c.axis)) }
        case "nextVectorConstraintName":
            let d = try doc()
            return strs(["distance", "angle", "radius", "diameter"].map { nextVectorConstraintName(d, $0) })
        case "inferVectorConstraints":
            var d = try doc()
            d.nodes = mapTree(d.nodes) { $0.isPath ? withVectorAnchorIds($0) : $0 }
            return .array(inferVectorConstraints(d, e["ids"]?.arrayValue?.compactMap(\.stringValue), infer(e["options"])).map { .object($0.json) })
        case "autoConstrainVector":
            var n = 0
            let r = try autoConstrainVector(try doc(), e["ids"]?.arrayValue?.compactMap(\.stringValue), {
                n += 1
                return "k\(n)"
            }, infer(e["options"]))
            return obj([("document", r.document.toJSON()), ("added", .array(r.added.map { .object($0.json) })), ("calls", .number(Double(n)))])
        case "withVectorAnchorIds": return withVectorAnchorIds(try VectorNode(json: e["node"]!)).toJSON()
        case "vectorConstraintGlyphs":
            let ids = e["nodeIds"]?.arrayValue.map { Set($0.compactMap(\.stringValue)) }
            return .array(vectorConstraintGlyphs(try doc(), ids))
        case "vectorConstraintActions": return .array(vectorConstraintActions(try doc(), anchors: refs(e["anchors"]), nodes: list("nodes").compactMap(\.stringValue)))
        case "vectorConstraintPanel":
            return vectorConstraintPanel(try doc(), anchors: refs(e["anchors"]), nodes: list("nodes").compactMap(\.stringValue), conflicts: list("conflicts").compactMap(\.stringValue))
        case let fn:
            throw VectorEditorError("No constraint function \(fn).")
        }
    }

    func testConstraintVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 100)
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
    }

    /// Undo takes a constraint and the geometry it moved back in one step, and redo solves again.
    func testUndoAndRedo() async throws {
        let host = try VectorConformanceHost(setup: ["width": 200, "height": 100])
        let c = host.controller
        _ = try await call(host, "vector.addPath", ["d": "M10 10 L90 20 L50 80 Z"])
        let before = c.document
        _ = try await call(host, "vector.addConstraint", ["kind": "horizontal", "refs": [["nodeId": "n1", "subpath": 0, "index": 0, "segment": true]]])
        let after = c.document
        XCTAssertEqual(c.getConstraints().map(\.id), ["k1"])
        XCTAssertEqual(after.nodes[0].subpaths[0].anchors[0].y, after.nodes[0].subpaths[0].anchors[1].y, accuracy: 1e-6)
        XCTAssertTrue(c.undo())
        XCTAssertTrue(c.getConstraints().isEmpty)
        XCTAssertEqual(c.document.nodes, before.nodes)
        XCTAssertTrue(c.redo())
        XCTAssertEqual(c.document, after)
        // A later edit is solved, the edited anchor moving least.
        _ = try await call(host, "vector.moveAnchor", ["nodeId": "n1", "subpath": 0, "index": 1, "x": 90, "y": 40])
        let a = c.document.nodes[0].subpaths[0].anchors
        XCTAssertEqual(a[0].y, a[1].y, accuracy: 1e-6)
        XCTAssertGreaterThan(a[1].y, 35)
        XCTAssertNil(c.constraintIssues)
        let panel = c.constraintPanel()
        XCTAssertEqual(panel["constraints"]?.arrayValue?.count, 1)
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "solve" && $0["name"] == "a square" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, false))
        guard case .object(var o) = e["out"]!, case .object(var dof) = o["dof"]! else { return XCTFail("no dof") }
        dof["dof"] = 1
        o["dof"] = .object(dof)
        XCTAssertNotNil(mismatch(got, .object(o), false))
        // One bit off in a solved coordinate is caught where trig is not involved.
        let x = got["document"]!["nodes"]!.arrayValue![1]["subpaths"]!.arrayValue![0]["anchors"]!.arrayValue![1]["x"]!.numberValue!
        XCTAssertNotNil(mismatch(.number(x.nextUp), .number(x), false))
    }
}
