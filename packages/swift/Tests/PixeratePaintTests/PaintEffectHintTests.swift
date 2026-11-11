import Foundation
import PixerateCore
import XCTest
@testable import PixeratePaint

/// Paint hints (`paint-effect-hints.test.ts`): which effects suit paint, refusing the rest, and starting effect paint from a hint.
final class PaintEffectHintTests: XCTestCase {
    private struct Host {
        let c: PaintEditorController
        let registry: ToolRegistry

        func call(_ name: String, _ args: JSONObject = [:], file: StaticString = #filePath, line: UInt = #line) async throws -> JSONObject {
            let r = await registry.callTool(name, args)
            if r.isError { XCTFail("\(name) failed: \(r.text ?? "")", file: file, line: line) }
            return r.structuredContent ?? [:]
        }

        func fail(_ name: String, _ args: JSONObject = [:], file: StaticString = #filePath, line: UInt = #line) async -> String {
            let r = await registry.callTool(name, args)
            XCTAssertTrue(r.isError, "\(name) should fail", file: file, line: line)
            return r.text ?? ""
        }
    }

    private func setup(paintHints: Bool = true) throws -> Host {
        let c = try PaintEditorController(width: 32, height: 16, paperPreset: "smooth", authoredEffects: .author)
        c.authoredEffectsGPU = false
        c.setEffectsProvider(FakeEffectProvider(paintHints: paintHints))
        let r = ToolRegistry(validateArguments: true)
        _ = try r.register(createPaintEditorToolProvider(c))
        _ = try r.register(createPaintEffectsToolProvider(c))
        _ = try r.register(createPaintEffectAuthoringToolProvider(c))
        return Host(c: c, registry: r)
    }

    private func ids(_ list: JSONObject) -> [String] { (list["effects"]?.arrayValue ?? []).compactMap { $0.objectValue?["id"]?.stringValue }.sorted() }

    func testTheFakeProviderCarriesHintsOnlyWithTheCapability() async throws {
        let hinted = FakeEffectProvider(paintHints: true)
        XCTAssertEqual(hinted.capabilities["paintHints"], true)
        XCTAssertNil(FakeEffectProvider().capabilities["paintHints"])
        let gradient = try await hinted.describe("fake.gradient")
        XCTAssertEqual(gradient.paint, EffectPaintHint(map: "stroke", colors: ["from", "to"], values: ["angle": 0], live: true, repeat: "mirror", size: 24))
        XCTAssertEqual(effectPaintHintProblems(gradient), [])
        let v1 = try await FakeEffectProvider().describe("fake.gradient").paint
        XCTAssertNil(v1)
        let listed = try await hinted.list(EffectSearchOptions())
        XCTAssertEqual(listed.filter { $0.json["paint"] != nil }.map(\.id).sorted(), ["fake.gradient", "fake.trail"])
    }

    func testFlagsHintsThatDontFitTheControls() async throws {
        let gradient = try await FakeEffectProvider().describe("fake.gradient")
        XCTAssertEqual(effectPaintHintProblems(gradient, paint: ["map": "stroke", "colors": ["nope"]]), ["paint.colors names \"nope\", which is not a control"])
        XCTAssertEqual(effectPaintHintProblems(gradient, paint: ["map": "stroke", "colors": ["angle"]]), ["paint.colors names \"angle\", which does not take a \"#rrggbb\" colour"])
        XCTAssertEqual(effectPaintHintProblems(gradient, paint: ["map": "path"]), ["paint.map is \"path\", but no control takes a path (format \"svg-path\"); use \"stroke\" or \"canvas\""])
        XCTAssertEqual(effectPaintHintShapeProblems(["map": "sideways", "colors": ["a", "b", "c"], "live": "yes", "repeat": "loop", "size": -1, "extra": 1]), [
            "paint.extra is not a paint hint field (map, colors, values, live, repeat, size)",
            "paint.map must be \"path\", \"stroke\", \"canvas\"",
            "paint.colors names 3 controls; at most 2 (the main colour, then the second)",
            "paint.live must be true or false",
            "paint.repeat must be \"repeat\", \"mirror\", \"clamp\"",
            "paint.size must be a brush width in px above 0",
        ])
    }

    func testPaintPlaceOffersOnlyHintedEffects() async throws {
        let p = FakeEffectProvider(paintHints: true)
        let list = try await p.list(EffectSearchOptions())
        XCTAssertEqual(list.filter { paintEffectOffered($0, "paint", capabilities: p.capabilities) }.map(\.id).sorted(), ["fake.gradient", "fake.trail"])
        XCTAssertEqual(list.filter { paintEffectOffered($0, "layer", capabilities: p.capabilities) }.map(\.id).sorted(), ["fake.bar", "fake.gradient", "fake.trail"])
        let plain = FakeEffectProvider()
        let v2 = try await plain.list(EffectSearchOptions()).filter { paintEffectOffered($0, "paint", capabilities: plain.capabilities) }.map(\.id).sorted()
        XCTAssertEqual(v2, ["fake.bar", "fake.gradient", "fake.trail"])

        let t = try setup()
        let v3 = ids(try await t.call("search_effects", ["place": "paint"]))
        XCTAssertEqual(v3, ["fake.gradient", "fake.trail"])
        let v4 = ids(try await t.call("search_effects", ["place": "light"]))
        XCTAssertEqual(v4, ["fake.invert", "fake.tint"])
        let message = await t.fail("set_effect_paint", ["effect": "fake.bar"])
        XCTAssertTrue(message.hasPrefix("\"fake.bar\" (Lower-third bar) doesn't work as paint"), message)
        XCTAssertTrue(message.contains("add_effect_layer"))
        let layer = try await t.call("add_effect_layer", ["effect": "fake.bar"])
        XCTAssertNotNil(layer["layer"])
        let plainHost = try setup(paintHints: false)
        let v5 = try await plainHost.call("set_effect_paint", ["effect": "fake.bar"])["effectPaint"]?["effect"]
        XCTAssertEqual(v5, "fake.bar")
    }

    func testPickingAHintedEffectStartsFromItsHint() async throws {
        let t = try setup()
        _ = try await t.call("set_color", ["color": "#ff0000", "secondaryColor": "#0000ff"])
        let p = try await t.c.setEffectPaint("fake.gradient")
        XCTAssertEqual(p.map?.json, ["by": "stroke", "length": 300, "repeat": "mirror"])
        XCTAssertTrue(p.live)
        XCTAssertEqual(p.values["from"], "#ff0000")
        XCTAssertEqual(p.values["to"], "#0000ff")
        XCTAssertEqual(p.values["angle"], 0)
        let trail = try await t.c.setEffectPaint("fake.trail")
        XCTAssertEqual(trail.map?.by, "path")
        XCTAssertEqual(trail.values["color"], "#ff0000")
        XCTAssertEqual(trail.values["width"], 4)
        XCTAssertFalse(trail.live)
        // What the caller gives wins, control by control.
        let mine = try await t.c.setEffectPaint("fake.gradient", values: ["to": "#00ff00", "angle": 45], map: ["by": "canvas"], live: false)
        XCTAssertNil(mine.map)
        XCTAssertFalse(mine.live)
        XCTAssertEqual(mine.values["from"], "#ff0000")
        XCTAssertEqual(mine.values["to"], "#00ff00")
        // update_effect keeps the paint's own map instead of going back to the hint.
        let updated = try await t.call("update_effect", ["target": "paint", "effect": "paint", "values": ["angle": 30]])
        XCTAssertNil(updated["effect"]?["map"])
    }

    func testAuthoredEffectsKeepAPaintHint() async throws {
        let t = try setup()
        let v6 = try await PixelEffectProvider().describe("pixel.rings").json["paint"]
        XCTAssertEqual(v6, ["map": "canvas", "colors": ["ink"], "live": true])
        _ = try await t.call("open_effect_authoring", ["effect": "pixel.clouds"])
        let bad = await t.fail("effect_authoring_set_paint_hint", ["paint": ["map": "canvas", "colors": ["ink"]]])
        XCTAssertEqual(bad, "paint.colors names \"ink\", which is not a control")
        let v7 = try await t.call("effect_authoring_set_paint_hint", ["paint": ["map": "stroke", "colors": ["sky"], "repeat": "clamp"]])["paint"]
        XCTAssertEqual(v7, ["map": "stroke", "colors": ["sky"], "repeat": "clamp"])
        _ = try await t.call("effect_authoring_undo")
        let v8 = try await t.call("effect_authoring_describe")["paint"]
        XCTAssertEqual(v8, ["map": "canvas", "colors": ["cloud", "sky"], "live": true])
        let saved = try await t.call("save_authored_effect", ["name": "Clouds"])
        let id = try XCTUnwrap(saved["id"]?.stringValue)
        let v9 = try await t.call("describe_effect", ["effect": .string(id)])["paint"]
        XCTAssertEqual(v9, ["map": "canvas", "colors": ["cloud", "sky"], "live": true])
        _ = try await t.call("set_color", ["color": "#ff0000", "secondaryColor": "#0000ff"])
        let p = try await t.c.setEffectPaint(id)
        XCTAssertEqual(p.values["cloud"], "#ff0000")
        XCTAssertEqual(p.values["sky"], "#0000ff")
        XCTAssertTrue(p.live)

        // A source edit keeps the hint while its controls are still there.
        _ = try await t.call("effect_authoring_set_source", ["source": "control sky: color = #000000 // Sky.\ncontrol cloud: color = #ffffff // Cloud.\nout = mix(sky, cloud, uv.x)"])
        let v10 = try await t.call("effect_authoring_describe")["paint"]
        XCTAssertEqual(v10, ["map": "canvas", "colors": ["cloud", "sky"], "live": true])
        _ = try await t.call("effect_authoring_set_source", ["source": "control tone: color = #ff0000 // Tone.\nout = tone"])
        let v11 = try await t.call("effect_authoring_describe")["paint"]
        XCTAssertEqual(v11, .null)
    }

    func testADocumentWithABadHintIsRefused() async throws {
        let p = PixelEffectProvider()
        let s = try await p.openAuthoring(.effect("pixel.blank"))
        var doc = s.exportDocument().json
        XCTAssertEqual(doc["paint"], ["map": "stroke", "colors": ["top", "bottom"], "repeat": "mirror"])
        doc["paint"] = ["map": "stroke", "colors": ["nope"]]
        do {
            _ = try await p.openAuthoring(.document(.object(doc)))
            XCTFail("a bad paint hint should be refused")
        } catch {
            XCTAssertTrue("\(error.localizedDescription)".contains("/paint: colors names \"nope\", which is not a control"), error.localizedDescription)
        }
        doc["paint"] = Optional<JSONValue>.none
        let v12 = try await p.openAuthoring(.document(.object(doc))).getState().description.json["paint"]
        XCTAssertNil(v12)
    }
}
