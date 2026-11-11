import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Authored effects in the paint editor (`paint-authored-effects.test.ts`): writing, saving, painting with and replaying effects written at run time.
final class PaintAuthoredEffectsTests: XCTestCase {
    private let hard: JSONObject = ["tip": ["size": 8, "hardness": 1, "opacity": 1, "flow": 1, "spacing": 0.05, "pressureOpacity": false, "pressureSize": false, "smoothing": 0], "grain": 0]
    private let line = [PenPoint(x: 2, y: 8), PenPoint(x: 30, y: 8)]
    /// Red on the left half, blue on the right.
    private let split = "control left: color = #ff0000 // Left half.\ncontrol right: color = #0000ff // Right half.\nout = select(uv.x < 0.5, left, right)"

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

    private func setup(_ policy: AuthoredEffectsPolicy = .author, rawShaders: Bool = false, limits: AuthoredEffectLimits = AuthoredEffectLimits(), provider: Bool = true) throws -> Host {
        let c = try PaintEditorController(width: 32, height: 16, paperPreset: "smooth", authoredEffects: policy, rawShaders: rawShaders, authoredEffectLimits: limits)
        c.authoredEffectsGPU = false
        if provider { c.setEffectsProvider(FakeEffectProvider()) }
        let r = ToolRegistry(validateArguments: true)
        _ = try r.register(createPaintEditorToolProvider(c))
        _ = try r.register(createPaintEffectsToolProvider(c))
        _ = try r.register(createPaintEffectAuthoringToolProvider(c))
        return Host(c: c, registry: r)
    }

    private func px(_ c: PaintEditorController, _ id: String, _ x: Int, _ y: Int) -> [Int] { readPixel(c.getLayer(id)!.pixelSurface, x, y) }

    private func stroke(_ c: PaintEditorController, _ points: [PenPoint]? = nil) throws {
        _ = try c.paintStroke(PaintStrokeInit(brushId: "ink-pen", brush: hard), points: points ?? line)
    }

    @discardableResult
    private func authorSplit(_ t: Host) async throws -> JSONObject {
        _ = try await t.call("open_effect_authoring", ["effect": "pixel.blank"])
        _ = try await t.call("effect_authoring_set_source", ["source": .string(split)])
        return try await t.call("save_authored_effect", ["name": "Split"])
    }

    private func ids(_ list: JSONObject) -> [String] { (list["effects"]?.arrayValue ?? []).compactMap { $0.objectValue?["id"]?.stringValue } }

    func testWritesSavesAndPaintsAStrokeWithIt() async throws {
        let t = try setup()
        let opened = try await t.call("open_effect_authoring", ["effect": "pixel.blank"])
        XCTAssertEqual(opened["from"], "pixel.blank")
        XCTAssertEqual(opened["compiled"], true)
        XCTAssertEqual(opened["controls"]?.arrayValue?.compactMap { $0.objectValue?["id"]?.stringValue }, ["top", "bottom"])

        let bad = try await t.call("effect_authoring_set_source", ["source": "out = vec3(oops)"])
        XCTAssertEqual(bad["issues"], [["severity": "error", "line": 1, "message": "there is no \"oops\"; built in: uv, pos, size, time, PI, TAU"]])
        let refused = await t.fail("save_authored_effect")
        XCTAssertTrue(refused.contains("doesn't compile, so it can't be saved: line 1: there is no \"oops\""), refused)

        _ = try await t.call("effect_authoring_set_source", ["source": .string(split)])
        let saved = try await t.call("save_authored_effect", ["name": "Split"])
        XCTAssertEqual(saved["id"], "authored.split")
        XCTAssertEqual(saved["controls"], ["left", "right"])
        XCTAssertEqual(saved["animated"], [])

        _ = try await t.call("set_effect_paint", ["effect": "authored.split"])
        XCTAssertEqual(t.c.getEffectPaint()?.provider, "authored")
        XCTAssertEqual(t.c.getEffectPaint()?.values, ["left": "#ff0000", "right": "#0000ff"])
        let layer = t.c.doc.activeLayerId!
        try stroke(t.c)
        XCTAssertEqual(px(t.c, layer, 6, 8), [255, 0, 0, 255])
        XCTAssertEqual(px(t.c, layer, 26, 8), [0, 0, 255, 255])

        let found = try await t.call("search_effects", ["query": "split"])
        XCTAssertEqual(ids(found), ["authored.split"])
        XCTAssertEqual(found["provider"]?.objectValue?["id"], "fake")
    }

    func testTheSourceTravelsWithThePaintingAndReplaysWithoutTheSessionOrProvider() async throws {
        let t = try setup()
        try await authorSplit(t)
        _ = try await t.call("close_effect_authoring")
        _ = try await t.call("set_effect_paint", ["effect": "authored.split", "values": ["right": "#00ff00"]])
        let layer = t.c.doc.activeLayerId!
        try stroke(t.c)
        let json = JSONValue.object(t.c.toJSON())
        let text = json.stringified()
        XCTAssertTrue(text.contains("\"authoredEffects\""))
        XCTAssertTrue(text.contains("select(uv.x < 0.5, left, right)"))

        // Another machine: no provider, replay only.
        let other = try PaintEditorController(width: 32, height: 16, paperPreset: "smooth")
        XCTAssertEqual(try other.loadJSON(json), [])
        XCTAssertEqual(other.authoredPolicy, .replay)
        let listed = await other.listAuthoredEffects()
        XCTAssertEqual(listed.map(\.id), ["authored.split"])
        _ = try await other.setEffectPaint("authored.split", values: ["right": "#00ff00"])
        try stroke(other, [PenPoint(x: 2, y: 4), PenPoint(x: 30, y: 4)])
        XCTAssertEqual(px(other, other.doc.activeLayerId!, 26, 4), [0, 255, 0, 255])
        XCTAssertEqual(px(other, layer, 26, 8), [0, 255, 0, 255])
        // It saves back unchanged.
        XCTAssertEqual(JSONValue.object(other.toJSON()).objectValue?["authoredEffects"], json.objectValue?["authoredEffects"])
    }

    func testWorksAsPaperAnEffectLayerAndAFill() async throws {
        let t = try setup()
        try await authorSplit(t)
        _ = try await t.call("set_paper_effect", ["effect": "authored.split"])
        XCTAssertEqual(t.c.getPaperEffect()?.source.provider, "authored")
        let added = try await t.call("add_effect_layer", ["effect": "authored.split", "name": "Split layer"])
        let addedId = try XCTUnwrap(added["layer"]?.objectValue?["id"]?.stringValue)
        XCTAssertEqual(px(t.c, addedId, 1, 1), [255, 0, 0, 255])
        let fill = try await t.call("fill_layer_with_effect", ["effect": "authored.split", "values": ["left": "#ffffff"]])
        XCTAssertEqual(px(t.c, fill["layerId"]!.stringValue!, 1, 1), [255, 255, 255, 255])
        let uses = try await t.call("list_authored_effects")["effects"]?.arrayValue?.first?.objectValue?["uses"]
        XCTAssertEqual(uses, ["strokes": 0, "paint": false, "paper": true, "layers": [.string(addedId)]])
    }

    func testKeyframedControlsAnimateWithTheEffectTimeAndAreHidden() async throws {
        let t = try setup()
        _ = try await t.call("open_effect_authoring", ["effect": "pixel.blank"])
        _ = try await t.call("effect_authoring_set_source", ["source": "control k: number = 0 range 0 1 // Grey.\ncontrol a: number = 1 range 0 1 // Alpha.\nout = vec4(vec3(k), a)"])
        _ = try await t.call("effect_authoring_set_keyframe", ["control": "k", "time": 0, "value": 0])
        _ = try await t.call("effect_authoring_set_keyframe", ["control": "k", "time": 1000, "value": 1])
        let saved = try await t.call("save_authored_effect", ["name": "Fade"])
        XCTAssertEqual(saved["controls"], ["a"])
        XCTAssertEqual(saved["animated"], ["k"])
        let d = try await t.call("describe_effect", ["effect": "authored.fade"])
        XCTAssertEqual(d["controls"]?.objectValue?["properties"]?.objectValue?.keys, ["a"])
        let half = try await t.c.addEffectLayer("authored.fade", time: 500)
        XCTAssertEqual(px(t.c, half.layer.id, 0, 0), [128, 128, 128, 255])
    }

    func testIdsNeverChangeWhatTheyDraw() async throws {
        let t = try setup()
        try await authorSplit(t)
        _ = try await t.call("effect_authoring_set_values", ["values": ["left": "#00ff00"]])
        let again = try await t.call("save_authored_effect", ["name": "Split"])
        XCTAssertEqual(again["id"], "authored.split-2")
        XCTAssertEqual(authoredEffectId("  Ünïcode -- rings!! ") { _ in false }, "authored.n-code-rings")
        XCTAssertEqual(authoredEffectId("***") { _ in false }, "authored.effect")
    }

    func testRemoveIsRefusedWhileUsedAndIsOneUndoStep() async throws {
        let t = try setup()
        try await authorSplit(t)
        _ = try await t.call("set_paper_effect", ["effect": "authored.split"])
        let used = await t.fail("remove_authored_effect", ["id": "authored.split"])
        XCTAssertTrue(used.contains("\"authored.split\" (Split) is still used by the effect paper; remove those first"), used)
        _ = try await t.call("set_paper_effect", ["effect": .null])
        let removed = try await t.call("remove_authored_effect", ["id": "authored.split"])
        XCTAssertEqual(removed, ["removed": "authored.split", "name": "Split"])
        let afterRemove = try await t.call("list_authored_effects")
        XCTAssertEqual(ids(afterRemove), [])
        _ = t.c.undo()
        let afterUndo = try await t.call("list_authored_effects")
        XCTAssertEqual(ids(afterUndo), ["authored.split"])
        let unknown = await t.fail("remove_authored_effect", ["id": "authored.nope"])
        XCTAssertTrue(unknown.contains("has no authored effect \"authored.nope\"; it has authored.split"), unknown)
    }

    func testOneSessionAtATime() async throws {
        let t = try setup()
        let none = await t.fail("effect_authoring_describe")
        XCTAssertTrue(none.contains("open one with open_effect_authoring"), none)
        let nope = await t.fail("open_effect_authoring", ["effect": "pixel.nope"])
        XCTAssertTrue(nope.contains("the templates are pixel.blank, pixel.rings, pixel.clouds"), nope)
        _ = try await t.call("open_effect_authoring", ["effect": "pixel.rings"])
        let twice = await t.fail("open_effect_authoring", ["effect": "pixel.blank"])
        XCTAssertTrue(twice.contains("already open for authoring (Rings, from \"pixel.rings\")"), twice)
        let closed = try await t.call("close_effect_authoring")
        XCTAssertEqual(closed, ["closed": "Rings"])
        let closedAgain = try await t.call("close_effect_authoring")
        XCTAssertEqual(closedAgain, ["closed": .null])
        _ = try await t.call("open_effect_authoring", ["effect": "fake.gradient"])
        let noSource = await t.fail("effect_authoring_set_source", ["source": "out = 1"])
        XCTAssertTrue(noSource.contains("has no source to edit"), noSource)
        // A provider effect has no pixel source: it can't be saved without rawShaders.
        let notPixel = await t.fail("save_authored_effect")
        XCTAssertTrue(notPixel.contains("isn't written in pixel expressions"), notPixel)
    }

    func testPolicyReplayDrawsButRefusesAuthoringAndOffDrawsNothing() async throws {
        let author = try setup()
        try await authorSplit(author)
        let json = JSONValue.object(author.c.toJSON())

        let replay = try setup(.replay)
        try replay.c.loadJSON(json)
        let refused = await replay.fail("open_effect_authoring", ["effect": "pixel.blank"])
        XCTAssertTrue(refused.contains("doesn't allow authoring effects (authoredEffects: \"replay\")"), refused)
        let notSaved = await replay.fail("save_authored_effect")
        XCTAssertTrue(notSaved.contains("so it can't save an authored effect"), notSaved)
        _ = try await replay.call("set_effect_paint", ["effect": "authored.split"])

        let off = try setup(.off)
        try off.c.loadJSON(json)
        let offPaint = await off.fail("set_effect_paint", ["effect": "authored.split"])
        XCTAssertTrue(offPaint.contains("turned off in this editor"), offPaint)
        let problem = try await off.call("list_authored_effects")["effects"]?.arrayValue?.first?.objectValue?["problem"]?.stringValue ?? ""
        XCTAssertTrue(problem.contains("turned off in this editor"), problem)
        XCTAssertThrowsError(try AuthoredEffectsPolicy.parse("maybe")) { XCTAssertTrue("\($0)".contains("use off, replay, author"), "\($0)") }
    }

    func testTheTrialRenderBudgetRefusesASlowEffect() async throws {
        let slow = try setup(limits: AuthoredEffectLimits(trialRenderMs: 0))
        _ = try await slow.call("open_effect_authoring", ["effect": "pixel.blank"])
        let refused = await slow.fail("save_authored_effect")
        XCTAssertNotNil(refused.range(of: "was not saved: a 64×64 trial render took \\d+ ms; the limit is 0 ms", options: .regularExpression), refused)
        XCTAssertTrue(slow.c.authoredEffects.isEmpty)
    }

    func testLiveFramesOverBudgetStopPlaying() async throws {
        for gpu in [false, true] {
            let t = try setup(limits: AuthoredEffectLimits(liveFrameMs: 0))
            t.c.authoredEffectsGPU = gpu
            _ = try await t.call("open_effect_authoring", ["effect": "pixel.blank"])
            _ = try await t.call("effect_authoring_set_source", ["source": "out = vec3(fract(time))"])
            _ = try await t.call("save_authored_effect", ["name": "Pulse"])
            _ = try t.c.addLayer(type: "strokes")
            _ = try await t.c.setEffectPaint("authored.pulse", live: true)
            try stroke(t.c)
            XCTAssertEqual(t.c.getAnimation().objectValue?["strokes"], 1)
            XCTAssertEqual(t.c.getAnimation().objectValue?["sources"], 1)
            let before = await t.c.listAuthoredEffects()
            XCTAssertNil(before[0].problem)
            _ = try await t.c.showEffectTime(100)
            _ = try await t.c.showEffectTime(200)
            let problem = await t.c.listAuthoredEffects()[0].problem ?? ""
            XCTAssertNotNil(problem.range(of: "live playback stopped: frames took \\d+ ms, over the 0 ms budget", options: .regularExpression), problem)
            // Frozen: later frames draw the stroke's own moment.
            let frozen = t.c.compositePixels().data
            _ = try await t.c.showEffectTime(700)
            XCTAssertEqual(t.c.compositePixels().data, frozen, "gpu \(gpu)")
            // GPU frames are view only: nothing rendered on the GPU stays in the effect paint cache.
            XCTAssertTrue(t.c.gpuFrameKeys.isEmpty)
        }
    }

    func testLiveGPUFramesMatchTheCPUWithinALevel() async throws {
        guard PixelGPU.isAvailable else { throw XCTSkip("no Metal GPU") }
        var frames: [[UInt8]] = []
        for gpu in [false, true] {
            let t = try setup()
            t.c.authoredEffectsGPU = gpu
            try await authorSplit(t)
            _ = try await t.call("effect_authoring_set_source", ["source": "control k: number = 0.5 range 0 1 // Grey.\nout = vec3(fract(time + k))"])
            _ = try await t.call("save_authored_effect", ["name": "Pulse"])
            _ = try t.c.addLayer(type: "strokes")
            _ = try await t.c.setEffectPaint("authored.pulse", live: true)
            try stroke(t.c)
            _ = try await t.c.showEffectTime(250)
            frames.append(t.c.compositePixels(paper: false).data)
            // An export at the moment shown renders on the CPU either way.
            let exported = try await t.c.renderAnimationFrame(250, paper: false).data
            if gpu { XCTAssertEqual(exported, frames[0]) }
        }
        XCTAssertEqual(frames[0].count, frames[1].count)
        let worst = zip(frames[0], frames[1]).map { abs(Int($0) - Int($1)) }.max() ?? 0
        XCTAssertLessThanOrEqual(worst, 2)
    }

    func testRawShaderDocumentsNeedRawShaders() async throws {
        let t = try setup()
        try await authorSplit(t)
        var json = t.c.toJSON()
        json["authoredEffects"] = ["authored.raw": ["name": "Raw", "document": ["version": 1, "providerId": "flair", "effectId": "x", "name": "Raw", "values": [:], "tracks": [:], "presets": [], "duration": 1000, "loop": false, "source": "void main(){}", "sourceLanguage": "glsl"]]]
        XCTAssertEqual(try t.c.loadJSON(.object(json)), [])
        let listed = try await t.call("list_authored_effects")["effects"]?.arrayValue?.first?.objectValue ?? [:]
        XCTAssertEqual(listed["id"], "authored.raw")
        XCTAssertEqual(listed["language"], "glsl")
        let problem = listed["problem"]?.stringValue ?? ""
        XCTAssertTrue(problem.contains("written in glsl for the provider \"flair\"; this editor draws only pixel expression effects (raw shader source needs rawShaders: true)"), problem)
        let raw = try setup(rawShaders: true)
        try raw.c.loadJSON(.object(json))
        let rawProblem = try await raw.call("list_authored_effects")["effects"]?.arrayValue?.first?.objectValue?["problem"]?.stringValue ?? ""
        XCTAssertTrue(rawProblem.contains("needs the provider \"flair\" with authoring; the registered provider is \"fake\""), rawProblem)
    }

    func testDropsUnreadableEntriesWithAProblem() throws {
        let t = try setup()
        var json = t.c.toJSON()
        json["authoredEffects"] = ["authored.bad": ["name": 1], "not-authored": ["name": "x", "document": [:]]]
        XCTAssertEqual(try t.c.loadJSON(.object(json)), [
            "The authored effect \"authored.bad\" could not be read; it was dropped (paint that uses it shows a placeholder).",
            "The authored effect \"not-authored\" could not be read; it was dropped (paint that uses it shows a placeholder).",
        ])
    }

    func testTheEffectsTabShowsWithOnlyAuthoredEffects() async throws {
        let t = try setup(provider: false)
        XCTAssertNil(t.c.effectsCatalog)
        try await authorSplit(t)
        let catalog = try XCTUnwrap(t.c.effectsCatalog)
        XCTAssertEqual(catalog.id, AUTHORED_PROVIDER_ID)
        let listed = try await catalog.list()
        XCTAssertEqual(listed.map(\.id), ["authored.split"])
        XCTAssertTrue(t.c.effectsCatalog === catalog, "the catalog keeps its identity while nothing changes")
    }
}
