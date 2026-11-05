import Foundation
import PixerateCore
import PixerateGeometry
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for width profiles, variable-width outlines, stroke parts and
/// arrowheads, and brushstroke data (`packages/core/tests/swift-vector-stroke-vectors.test.ts`
/// writes `Fixtures/vector-stroke-vectors.json`). Entries marked `trig: false` compare exactly,
/// `trig: true` ones within relative 1e-9. Keys compare as sets. `commands` replays agent commands
/// (their failures and edge cases) and compares results, error texts and the saved document.
final class VectorStrokeVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-stroke-vectors", withExtension: "json", subdirectory: "Fixtures")!
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

    private func enc(_ path: BezierPath) -> JSONValue {
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

    private func pt(_ p: PathPoint) -> JSONValue { [.number(p[0]), .number(p[1])] }
    private func xy(_ p: PathPoint) -> JSONValue { .object(JSONObject([("x", .number(p[0])), ("y", .number(p[1]))])) }
    private func points(_ list: [VectorWidthPoint]) -> JSONValue { widthProfileJSON(list) }
    private func profile(_ v: JSONValue?) -> [VectorWidthPoint] { sanitizeWidthProfile(v) }
    private func path(_ e: JSONValue) -> BezierPath { toBezierPath(.svg(e["d"]!.stringValue!)) }
    private func style(_ v: JSONValue?) -> VectorNode { VectorNode(props: v?.objectValue ?? JSONObject()) }
    private func num(_ v: JSONValue?) -> Double? { v.flatMap { $0 == .null ? Double.nan : $0.numberValue } }
    private func nums(_ v: JSONValue?) -> [Double] { v!.arrayValue!.map { $0.numberValue ?? .nan } }

    private func taper(_ v: JSONValue?) -> VectorTaperOptions? { v?.objectValue.map(VectorTaperOptions.init(json:)) }
    private func wave(_ v: JSONValue?) -> VectorWaveOptions? { v?.objectValue.map(VectorWaveOptions.init(json:)) }

    private func variableOptions(_ e: JSONValue) -> VariableStrokeOptions {
        VariableStrokeOptions(
            width: e["width"]!.numberValue!, profile: profile(e["profile"]),
            join: e["join"]?.stringValue.flatMap(StrokeJoin.init(rawValue:)), cap: e["cap"]?.stringValue.flatMap(StrokeCap.init(rawValue:)),
            miterLimit: e["miterLimit"]?.numberValue, dash: e["dash"].map(nums), dashOffset: e["dashOffset"]?.numberValue, tolerance: e["tolerance"]?.numberValue
        )
    }

    // MARK: Entries

    private func run(_ e: JSONValue) throws -> JSONValue {
        switch e["fn"]!.stringValue! {
        // Width profiles
        case "sanitizeWidthProfile": return points(sanitizeWidthProfile(e["points"]))
        case "widthProfileAt":
            let p = profile(e["profile"])
            return .array(nums(e["ts"]).map { t in
                let w = widthProfileAt(p, t)
                return .object(JSONObject([("left", .number(w.left)), ("right", .number(w.right))]))
            })
        case "widthProfileMisc":
            let p = profile(e["profile"])
            return .object(JSONObject([
                ("uniform", .bool(isUniformWidthProfile(p))), ("max", .number(widthProfileMaxScale(p))), ("preset", .string(widthProfilePresetId(p))),
                ("reversed", points(reverseWidthProfile(p))), ("mirrored", points(mirrorWidthProfile(p))),
            ]))
        case "widthProfilePreset": return .array(e["ids"]!.arrayValue!.map { widthProfilePreset($0.stringValue!).map(points) ?? .null })
        case "insertWidthPoint":
            let given: [VectorWidthPoint]? = e["points"] == .null ? nil : profile(e["points"])
            let r = insertWidthPoint(given, e["t"]!.numberValue!, left: e["left"]?.numberValue, right: e["right"]?.numberValue, step: e["step"]?.boolValue == true)
            return .object(JSONObject([("points", points(r.points)), ("index", .number(Double(r.index)))]))
        case "setWidthPoint":
            return points(setWidthPoint(profile(e["points"]), Int(e["index"]!.numberValue!), t: e["t"]?.numberValue, left: e["left"]?.numberValue, right: e["right"]?.numberValue))
        case "removeWidthPoints": return points(removeWidthPoints(profile(e["points"]), nums(e["indices"]).map { Int($0) }))
        case "generateWidthProfile": return points(generateWidthProfile(taper: taper(e["taper"]), wave: wave(e["wave"]), tolerance: e["tolerance"]?.numberValue))
        case "taperWaveFactor": return .array(nums(e["ts"]).map { .number(taperWaveFactor($0, taper(e["taper"]), wave(e["wave"]))) })
        case "pressureWidthProfile":
            let samples = e["samples"]!.arrayValue!.map { (t: num($0["t"]) ?? .nan, pressure: num($0["pressure"]) ?? .nan) }
            return points(pressureWidthProfile(samples))

        // Variable-width outlines
        case "variableStrokeRings": return .array(variableStrokeRings(path(e), variableOptions(e)).map { .array($0.map(pt)) })
        case "variableStrokeOutline": return enc(variableStrokeOutline(path(e), variableOptions(e)))
        case "dashIntervals": return .array(dashIntervals(nums(e["pattern"]), e["offset"]!.numberValue!, e["len"]!.numberValue!).map { [.number($0.0), .number($0.1)] })
        case "nearestStrokePosition":
            let line = path(e)
            return .array(e["points"]!.arrayValue!.map { p in
                guard let n = nearestStrokePosition(line, PathPoint(p.arrayValue![0].numberValue!, p.arrayValue![1].numberValue!)) else { return .null }
                return .object(JSONObject([
                    ("contour", .number(Double(n.contour))), ("t", .number(n.t)), ("distance", .number(n.distance)), ("side", .string(n.side)),
                    ("point", pt(n.point)), ("tangent", pt(n.tangent)), ("length", .number(n.length)),
                ]))
            })
        case "strokePositionPoint":
            let line = path(e)
            return .array([0, 1, 5].map { i in
                .array(nums(e["ts"]).map { t in
                    strokePositionPoint(line, i, t).map { .object(JSONObject([("point", pt($0.point)), ("tangent", pt($0.tangent))])) } ?? .null
                })
            })

        // Stroke parts
        case "strokeMisc":
            let s = style(e["style"])
            return .object(JSONObject([("reach", .number(vectorStrokeReach(s))), ("start", .number(arrowheadWeight(s, "start"))), ("end", .number(arrowheadWeight(s, "end")))]))
        case "vectorStrokeParts":
            let p = vectorStrokeParts(path(e), style(e["style"]))
            return .object(JSONObject([
                ("align", .string(p.align)), ("line", enc(p.line)), ("drawWidth", .number(p.drawWidth)),
                ("heads", .array(p.heads.map { h in
                    .object(JSONObject([("end", .string(h.end)), ("kind", .string(h.kind)), ("tip", xy(h.tip)), ("dir", xy(h.dir)), ("inset", .number(h.inset)), ("path", enc(h.path))]))
                })),
            ]))
        case "vectorStrokeOutlinePath": return enc(try vectorStrokeOutlinePath(path(e), style(e["style"])))
        case "hitTestVectorStroke":
            let line = path(e)
            let s = style(e["style"])
            let tol = e["tolerance"]!.numberValue!
            return .array(e["points"]!.arrayValue!.map { p in .bool(hitTestVectorStroke(line, PathPoint(p.arrayValue![0].numberValue!, p.arrayValue![1].numberValue!), s, tolerance: tol)) })
        case "arrowheadInset":
            return .array(e["kinds"]!.arrayValue!.map { k in [.number(arrowheadInset(k.stringValue!, 3, 0)!), .number(arrowheadInset(k.stringValue!, 0.5, 4)!)] })

        // Brushstrokes
        case "vectorBrushstrokeBrushes":
            return .array(vectorBrushstrokeBrushes().map { b in .object(JSONObject([("id", .string(b.id)), ("name", .string(b.name)), ("category", .string(b.category)), ("size", .number(b.size))])) })
        case "sanitizeVectorBrushstroke": return sanitizeVectorBrushstroke(e["value"]).map { .object($0) } ?? .null
        case "vectorBrushstrokeBrushError": return .array(e["ids"]!.arrayValue!.map { vectorBrushstrokeBrushError($0.stringValue!).map { .string($0) } ?? .null })
        case "vectorBrushstrokeDefaultColour":
            return .array(e["ids"]!.arrayValue!.map { id in
                .array(["light", "dark"].map { vectorBrushstrokeDefaultColour(id.stringValue!, scheme: $0).map { .string($0) } ?? .null })
            })
        case "vectorBrushstrokePaintError":
            return .array(e["paints"]!.arrayValue!.map { p in [vectorBrushstrokePaintError(p).map { .string($0) } ?? .null, readVectorBrushstrokePaint(p) ?? .null] })
        case "vectorBrushstrokeCharacterError":
            return .array(e["characters"]!.arrayValue!.map { c in vectorBrushstrokeCharacterError(seed: c["seed"], paper: c["paper"]).map { .string($0) } ?? .null })
        case "sanitizeVectorBrushstrokePaper": return .array(e["papers"]!.arrayValue!.map { sanitizeVectorBrushstrokePaper($0).map { .object($0) } ?? .null })
        case "vectorBrushstrokeReach": return .array(e["layers"]!.arrayValue!.map { .number(vectorBrushstrokeReach($0.objectValue!)) })
        case let fn:
            throw VectorEditorError("No stroke function \(fn).")
        }
    }

    func testStrokeVectors() throws {
        let entries = Self.vectors["entries"]!.arrayValue!
        XCTAssertGreaterThan(entries.count, 150)
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

    func testCommandVectors() async throws {
        let commands = Self.vectors["commands"]!
        let host = try VectorConformanceHost(setup: commands["setup"]!.objectValue!)
        for (i, step) in commands["steps"]!.arrayValue!.enumerated() {
            var args = JSONObject([("id", step["id"]!)])
            if let params = step["params"] { args["params"] = params }
            let r = await host.callTool("run_command", args)
            let got: JSONValue = r.isError ? .object(JSONObject([("error", .string(r.text ?? ""))])) : try JSONValue.parse(r.text ?? "null")
            if let d = mismatch(got, step["result"]!, true) { XCTFail("step \(i) \(step["id"]!.stringValue!): \(d)") }
        }
        if let d = mismatch(try host.document(), commands["document"]!, true) { XCTFail("document: \(d)") }
    }

    /// A broken expectation fails: the comparison is not vacuous.
    func testMismatchIsReported() throws {
        let e = Self.vectors["entries"]!.arrayValue!.first { $0["fn"] == "variableStrokeOutline" }!
        let got = try run(e)
        XCTAssertNil(mismatch(got, e["out"]!, true))
        guard case .array(var out) = e["out"]!, case .array(var first) = out[0] else { return XCTFail("no path") }
        first[1] = .number(first[1].numberValue! + 1e-6)
        out[0] = .array(first)
        XCTAssertNotNil(mismatch(got, .array(out), true))
    }
}
