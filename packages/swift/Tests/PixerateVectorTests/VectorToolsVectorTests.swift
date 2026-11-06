import Foundation
import PixerateConformance
import PixerateCore
import PixeratePaint
import XCTest
@testable import PixerateVector

/// The TS core's own outputs for the vector agent tools (`packages/core/tests/swift-vector-tools-vectors.test.ts`
/// writes `Fixtures/vector-tools-vectors.json`): replays of the effect tools and the generation
/// tools (seeds, idempotency keys, regeneration of moved and rotated art, provenance through SVG
/// export and import) with their failures and the document, render data and SVG export after
/// each, and the generation core in `PixerateCore` (`planGenerationRequest` over capabilities and
/// strategies, `createProvenance`'s source map, `parseProvenance`, `stableStringify`). ISO
/// timestamps the replays make read `<time>`; keys compare as sets; numbers within relative 1e-9 (as the
/// conformance runner compares them).
final class VectorToolsVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "vector-tools-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    static func untimed(_ v: JSONValue) -> JSONValue {
        switch v {
        case .string(let s): return .string(s.replacingOccurrences(of: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z", with: "<time>", options: .regularExpression))
        case .array(let a): return .array(a.map(untimed))
        case .object(let o): return .object(JSONObject(o.map { ($0.key, untimed($0.value)) }))
        default: return v
        }
    }

    func mismatch(_ got: JSONValue, _ want: JSONValue, _ path: String = "") -> String? {
        switch (got, want) {
        case let (.number(g), .number(w)):
            if g == w || abs(g - w) <= 1e-9 * max(1, abs(g), abs(w)) { return nil }
            return "\(path): \(JSONValue.jsNumber(g)) != \(JSONValue.jsNumber(w))"
        case let (.array(g), .array(w)):
            if g.count != w.count { return "\(path): \(g.count) items != \(w.count)" }
            for i in 0 ..< g.count { if let d = mismatch(g[i], w[i], "\(path)[\(i)]") { return d } }
            return nil
        case let (.object(g), .object(w)):
            if Set(g.keys) != Set(w.keys) { return "\(path): keys \(g.keys.sorted()) != \(w.keys.sorted())" }
            for k in w.keys { if let d = mismatch(g[k]!, w[k]!, "\(path).\(k)") { return d } }
            return nil
        default:
            if case let (.string(g), .string(w)) = (got, want) {
                let a = Array(g.utf16), b = Array(w.utf16)
                let at = (0 ..< Swift.min(a.count, b.count)).first { a[$0] != b[$0] } ?? Swift.min(a.count, b.count)
                func around(_ u: [UInt16]) -> String { String(decoding: u[Swift.max(0, at - 80) ..< Swift.min(u.count, at + 120)], as: UTF16.self) }
                return got == want ? nil : "\(path) at \(at): \(around(a)) != \(around(b))"
            }
            return got == want ? nil : "\(path): \(got.stringified().prefix(400)) != \(want.stringified().prefix(400))"
        }
    }

    /// `got` (with the times it made untimed, unless `untime` is false) against the fixture.
    func check(_ got: JSONValue, _ want: JSONValue, _ label: String, untime: Bool = true) {
        if let d = mismatch(untime ? Self.untimed(got) : got, want) { XCTFail("\(label)\(d)") }
    }

    // MARK: Tool replays

    func testReplays() async throws {
        let replays = try XCTUnwrap(Self.vectors["replays"]?.arrayValue)
        XCTAssertEqual(replays.map { $0["name"]?.stringValue }, ["effects", "generation"])
        for r in replays {
            let name = r["name"]!.stringValue!
            let host = try VectorConformanceHost(setup: r["setup"]!.objectValue!)
            for (i, step) in r["steps"]!.arrayValue!.enumerated() {
                let tool = step["tool"]!.stringValue!
                let (value, isError) = conformanceResult(await host.callTool(tool, step["arguments"]!.objectValue!))
                XCTAssertEqual(isError, step["isError"]!.boolValue!, "\(name) step \(i + 1) \(tool) isError: \(value.stringified().prefix(300))")
                check(value, step["result"]!, "\(name) step \(i + 1) \(tool)")
            }
            check(conformanceResult(await host.callTool("run_command", ["id": "vector.exportSvg"])).value, r["svg"]!, "\(name) svg")
            check(try host.document(), r["document"]!, "\(name) document")
            check(try host.render() ?? .null, r["render"]!, "\(name) render")
        }
    }

    /// A broken expectation fails the replay (the comparison is not vacuous).
    func testReplayMismatchIsCaught() async throws {
        let r = try XCTUnwrap(Self.vectors["replays"]?.arrayValue?.last)
        let host = try VectorConformanceHost(setup: r["setup"]!.objectValue!)
        let step = r["steps"]!.arrayValue![1]
        XCTAssertEqual(step["tool"]?.stringValue, "generate_vector_art")
        let got = Self.untimed(conformanceResult(await host.callTool("generate_vector_art", step["arguments"]!.objectValue!)).value)
        XCTAssertNil(mismatch(got, step["result"]!))
        var broken = step["result"]!.objectValue!
        broken["ids"] = ["node-2"]
        XCTAssertNotNil(mismatch(got, .object(broken)))
    }

    // MARK: Generation core

    func testPlans() throws {
        let plans = try XCTUnwrap(Self.vectors["plans"]?.arrayValue)
        XCTAssertGreaterThan(plans.count, 20)
        for (i, p) in plans.enumerated() {
            let o = p["options"]!.objectValue!
            let mentions = o["mentions"]?.arrayValue?.map { m in
                PlanAssetMention(id: m["id"]?.stringValue ?? "", role: m["role"]?.stringValue, mediaType: m["mediaType"]?.stringValue, contentHash: m["contentHash"]?.stringValue, url: m["url"]?.stringValue, label: m["label"]?.stringValue)
            }
            let options = PlanOptions(strategy: o["strategy"]?.stringValue, resolvedPrompt: o["resolvedPrompt"]?.stringValue, fillDefaults: o["fillDefaults"]?.boolValue ?? false, dropUnsupportedReferences: o["dropUnsupportedReferences"]?.boolValue, mentions: mentions, defaultMentionRole: o["defaultMentionRole"]?.stringValue)
            let plan = planGenerationRequest(p["request"]!.objectValue!, ModelCapabilities(p["caps"]!.objectValue!), options)
            check(plan.json, p["out"]!, "plan \(i)")
        }
    }

    func testProvenance() throws {
        let entries = try XCTUnwrap(Self.vectors["provenance"]?.arrayValue)
        for e in entries {
            let input = e["input"]!
            let zero = Date(timeIntervalSince1970: 0)
            let out = createProvenance(CreateProvenanceOptions(rawPrompt: input["rawPrompt"]!.stringValue!, model: input["model"]!.stringValue!, request: input["request"]!.objectValue!, createdAt: zero, startedAt: zero, completedAt: zero, outputIds: ["o1"], meta: input["meta"]!.objectValue!))
            check(.object(out), e["out"]!, "provenance \(input["rawPrompt"]!.stringified())", untime: false)
        }
        XCTAssertEqual(isoTimestamp(Date(timeIntervalSince1970: 1.5)), "1970-01-01T00:00:01.500Z")
    }

    func testParseProvenance() throws {
        for (i, e) in try XCTUnwrap(Self.vectors["parse"]?.arrayValue).enumerated() {
            do {
                let out = try parseProvenance(e["input"]!)
                if let error = e["error"] { XCTFail("parse \(i): expected \(error.stringified())") } else { check(.object(out), e["out"]!, "parse \(i)", untime: false) }
            } catch {
                XCTAssertEqual(describeError(error), e["error"]?.stringValue, "parse \(i)")
            }
        }
    }

    func testStableStringify() throws {
        for e in try XCTUnwrap(Self.vectors["stable"]?.arrayValue) {
            XCTAssertEqual(stableStringify(e["input"]!), e["out"]!.stringValue!)
        }
    }

    // MARK: Behaviour the replays can't show

    /// A provider without vector effects is refused with its name, and so is no provider.
    func testVectorEffectsNeedAVectorProvider() async throws {
        let c = try VectorEditorController(createId: { "x" })
        do {
            _ = try await c.addVectorEffect("fake.badge")
            XCTFail("no provider")
        } catch {
            XCTAssertEqual(describeError(error), "No effects provider is registered with this editor. The host must call setEffectsProvider(provider) first.")
        }
        let stop = c.useEffects(FakeEffectProvider())
        // The TS lists only offered effects in apply_effect's schema once its catalog is fetched;
        // the controller refuses the others with these messages.
        do {
            _ = try await c.addVectorEffect("fake.fade-in")
            XCTFail("motion")
        } catch {
            XCTAssertEqual(describeError(error), "\"fake.fade-in\" (Fade in) is a motion effect; the vector editor adds vector effects, which bring their own picture (apply motion in the animation editor).")
        }
        XCTAssertNotNil(c.effectsProvider)
        stop()
        XCTAssertNil(c.effectsProvider)
    }

    /// The idempotency key: a failure is forgotten (retried), a success is kept.
    func testIdempotencyKeys() async throws {
        let c = try VectorEditorController(createId: { "x" })
        var calls = 0
        let options = VectorGenerationOptions(models: FAKE_VECTOR_ART_MODELS) { request, context in
            calls += 1
            if calls == 1 { throw VectorEditorError("offline") }
            return try await fakeVectorArtGenerator(request, context)
        }
        let input = VectorGenerateInput(prompt: "sun", seed: 1, idempotencyKey: "a")
        let first = try await generateVectorArt(c, input, options)
        XCTAssertEqual(first.message, "The generator failed: offline")
        let second = try await generateVectorArt(c, input, options)
        XCTAssertTrue(second.ok)
        let third = try await generateVectorArt(c, input, options)
        XCTAssertEqual(third.id, second.id)
        XCTAssertEqual(calls, 2)
    }
}
