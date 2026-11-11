import Foundation
import PixerateCore
import XCTest
@testable import PixeratePaint

/// A playback clock the test drives.
private final class ManualSchedule {
    var frame: ((Double) -> Void)?
    var schedule: EffectAuthoringSchedule {
        { [unowned self] f in
            frame = f
            return { [unowned self] in frame = nil }
        }
    }
}

/// A source backend over a tiny language: each `control NAME` line is a number control 0–1 (default 0.5); a line `bad` is an error.
private final class StubBackend: AuthoringSourceBackend {
    let language = "pixel"
    var renderersMade: [String] = []
    func sourceOf(_ effectId: String) throws -> String {
        guard effectId == "stub.a" else { throw EffectError.unknown(effectId, in: "the stub") }
        return "control top\ncontrol bottom"
    }
    func refuse(_ source: String) -> String? { source.count > 100 ? "the source is \(source.count) characters; the limit is 100" : nil }
    func compile(_ source: String, effectId: String) -> AuthoringCompileResult {
        var props = JSONObject(), defaults = JSONObject(), issues: [EffectAuthoringIssue] = []
        for (i, line) in source.components(separatedBy: "\n").enumerated() {
            if line.hasPrefix("control ") {
                let name = String(line.dropFirst(8))
                props[name] = ["type": "number", "minimum": 0, "maximum": 1]
                defaults[name] = 0.5
            } else if line == "bad" {
                issues.append(EffectAuthoringIssue(message: "bad line", line: i + 1, severity: "error"))
            }
        }
        if !issues.isEmpty { return AuthoringCompileResult(description: nil, issues: issues) }
        let d: JSONObject = ["id": .string(effectId), "name": "Stub", "kind": "shader", "category": "test", "uses": ["generator"], "transparent": false, "loop": false,
                             "controls": ["type": "object", "additionalProperties": false, "properties": .object(props)], "defaults": .object(defaults), "presets": [], "inputs": []]
        return AuthoringCompileResult(description: EffectDescription(d), issues: [])
    }
    func createRenderer(_ source: String, effectId: String, width: Int, height: Int) async throws -> EffectRenderer {
        renderersMade.append(source)
        return StubRenderer(effectId: effectId, width: width, height: height, source: source)
    }
}

/// Draws the number of controls in red and the first value (×255) in green.
private final class StubRenderer: EffectRenderer {
    let effectId: String, width: Int, height: Int, source: String
    init(effectId: String, width: Int, height: Int, source: String) {
        self.effectId = effectId
        self.width = width
        self.height = height
        self.source = source
    }
    func render(_ request: EffectRenderRequest) async throws -> EffectPixels {
        let controls = source.components(separatedBy: "\n").filter { $0.hasPrefix("control ") }.map { String($0.dropFirst(8)) }
        var p = EffectPixels(width: width, height: height)
        p.data[0] = UInt8(controls.count)
        p.data[1] = UInt8(((controls.first.flatMap { request.values?[$0]?.numberValue } ?? 0) * 255).rounded())
        return p
    }
    func dispose() {}
}

final class EffectAuthoringTests: XCTestCase {
    private func open(_ from: EffectAuthoringSource, provider: EffectProvider = FakeEffectProvider(), history: HistoryManager? = nil, schedule: EffectAuthoringSchedule? = nil, startTime: Double? = nil, source: AuthoringSourceBackend? = nil) async throws -> GenericEffectAuthoringSession {
        try await GenericEffectAuthoringSession(from, options: GenericAuthoringOptions(provider: provider, history: history, schedule: schedule ?? { _ in {} }, startTime: startTime, source: source))
    }

    private func openError(_ from: EffectAuthoringSource, source: AuthoringSourceBackend? = nil) async -> EffectError? {
        do {
            _ = try await open(from, source: source)
            return nil
        } catch {
            return error as? EffectError
        }
    }

    // MARK: Session

    func testOpensAnEffectHalfWayIn() async throws {
        let s = try await open(.effect("fake.invert"))
        let st = s.getState()
        XCTAssertEqual(st.effectId, "fake.invert")
        XCTAssertEqual(st.name, "Invert")
        XCTAssertEqual(st.values["amount"], 1)
        XCTAssertTrue(st.tracks.isEmpty)
        XCTAssertEqual(st.time, 500)
        XCTAssertEqual(st.duration, 1000)
        XCTAssertNil(st.previewError)
        XCTAssertNil(st.compiled)
        XCTAssertFalse(st.playing || st.loop || st.canUndo || st.canRedo)
        XCTAssertTrue(st === s.getState())
        let at0 = try await open(.effect("fake.invert"), startTime: 0)
        XCTAssertEqual(at0.getState().time, 0)
        let past = try await open(.effect("fake.invert"), startTime: 5000)
        XCTAssertEqual(past.getState().time, 1000)
    }

    func testOpeningRefusesUnknownEffectsAndPresets() async throws {
        let unknown = await openError(.effect("nope"))
        XCTAssertEqual(unknown?.code, "unknown_effect")
        let preset = await openError(.effect("fake.tint", preset: "missing"))
        XCTAssertEqual(preset?.message, "Unknown preset \"missing\" for effect \"fake.tint\". Valid presets are: \"Sepia\", \"Cool\"")
        let sepia = try await open(.effect("fake.tint", preset: "Sepia"))
        XCTAssertEqual(sepia.getState().values["color"], "#704214")
        let motion = await openError(.effect("fake.fade-in"))
        XCTAssertEqual(motion?.message, "Motion effects cannot be authored as pixel effects")
        let notDoc = await openError(.document("x"))
        XCTAssertEqual(notDoc?.message, "Invalid effect authoring source")
        let v2 = await openError(.document(["version": 2, "effectId": "fake.tint"]))
        XCTAssertEqual(v2?.message, "Invalid effect authoring document: version 1 required")
    }

    func testSetsValuesWithUndoRedoAndMergesGestures() async throws {
        let s = try await open(.effect("fake.invert"))
        XCTAssertEqual(s.setValue("amount", 0.5), .ok)
        XCTAssertEqual(s.getState().values["amount"], 0.5)
        XCTAssertTrue(s.getState().canUndo)
        XCTAssertTrue(s.undo())
        XCTAssertEqual(s.getState().values["amount"], 1)
        XCTAssertTrue(s.getState().canRedo)
        XCTAssertTrue(s.redo())
        XCTAssertEqual(s.getState().values["amount"], 0.5)

        let g = try await open(.effect("fake.invert"))
        for v in [0.2, 0.4, 0.6] { _ = g.setValue("amount", .number(v), gesture: "amount-drag") }
        XCTAssertEqual(g.getState().values["amount"], 0.6)
        XCTAssertTrue(g.undo())
        XCTAssertEqual(g.getState().values["amount"], 1)
        XCTAssertFalse(g.getState().canUndo)

        // Without a gesture, calls on one control within the merge window are one step.
        var now = 0.0
        let w = try await open(.effect("fake.invert"), history: HistoryManager(now: { now }))
        _ = w.setValue("amount", 0.3)
        now = 100
        _ = w.setValue("amount", 0.2)
        now = 1000
        _ = w.setValue("amount", 0.1)
        XCTAssertTrue(w.undo())
        XCTAssertEqual(w.getState().values["amount"], 0.2)
        XCTAssertTrue(w.undo())
        XCTAssertEqual(w.getState().values["amount"], 1)

        let m = try await open(.effect("fake.tint"))
        let before = m.getState().values
        XCTAssertEqual(m.setValues(["amount": 0.2, "color": "#000000"]), .ok)
        XCTAssertTrue(m.undo())
        XCTAssertEqual(m.getState().values, before)
    }

    func testRefusesWithTheTSMessagesAndChangesNothing() async throws {
        let s = try await open(.effect("fake.tint"))
        let before = s.getState()
        XCTAssertEqual(s.setValue("nope", 1).message, "there is no control \"nope\"; the controls are color, amount")
        XCTAssertEqual(s.setValues(["nope": 1]).message, "there is no control \"nope\"; the controls are color, amount")
        XCTAssertTrue(s.setValue("color", "zzz").message!.hasPrefix("control \"color\": "))
        XCTAssertTrue(s.setValues(["amount": 0.2, "color": "zzz"]).message!.contains("control \"color\""))
        XCTAssertFalse(s.setValue("amount", 5).isOK)
        XCTAssertEqual(s.clearTrack("amount").message, "control \"amount\" is not animated, so there is nothing to clear; no control is animated")
        XCTAssertEqual(s.removeKeyframe("amount", time: 0).message, "control \"amount\" has no keyframes")
        XCTAssertEqual(s.setKeyframe("amount", time: -1).message, "keyframe time must be a finite number >= 0")
        XCTAssertEqual(s.setKeyframe("amount", time: 0, value: 0.5, easing: .named("wobbly")).message, "invalid easing: wobbly")
        XCTAssertEqual(s.setTiming(duration: 0, loop: nil).message, "duration must be a finite number > 0")
        XCTAssertEqual(s.applyPreset("x").message, "unknown preset \"x\"; available presets are: \"Sepia\", \"Cool\"")
        XCTAssertEqual(s.savePreset("  ").message, "preset name cannot be empty")
        XCTAssertTrue(s.getState() === before)

        _ = s.setKeyframe("amount", time: 250, value: 0.1)
        XCTAssertEqual(s.removeKeyframe("amount", time: 100).message, "no keyframe at 100 ms on control \"amount\"; its keyframes are at 250 ms")
        XCTAssertEqual(s.clearTrack("color").message, "control \"color\" is not animated, so there is nothing to clear; the animated controls are amount")

        s.play()
        s.dispose()
        XCTAssertFalse(s.getState().playing)
        XCTAssertEqual(s.setValue("amount", 0.5).message, "the session is closed")
    }

    func testInterpolatesKeyframes() async throws {
        let s = try await open(.effect("fake.tint"))
        _ = s.setTiming(duration: 2000, loop: nil)
        _ = s.setKeyframe("amount", time: 0, value: 0)
        _ = s.setKeyframe("amount", time: 2000, value: 1)
        _ = s.setKeyframe("color", time: 0, value: "#000000")
        _ = s.setKeyframe("color", time: 2000, value: "#ffffff")
        s.seek(0)
        XCTAssertEqual(s.getState().values["amount"], 0)
        XCTAssertEqual(s.getState().values["color"], "#000000")
        s.seek(1000)
        XCTAssertEqual(s.getState().values["amount"]?.numberValue ?? -1, 0.5, accuracy: 1e-12)
        XCTAssertEqual(s.getState().values["color"], "#808080")
        s.seek(2000)
        XCTAssertEqual(s.getState().values["amount"], 1)
        XCTAssertEqual(s.getState().values["color"], "#ffffff")

        // Booleans hold; vectors interpolate per item; a looping document wraps.
        var tracks = EffectTracks()
        tracks["on"] = [EffectKeyframe(time: 0, value: false), EffectKeyframe(time: 1000, value: true)]
        tracks["v"] = [EffectKeyframe(time: 0, value: [0, 10]), EffectKeyframe(time: 1000, value: [1, 20])]
        tracks["c"] = [EffectKeyframe(time: 0, value: "#00000000"), EffectKeyframe(time: 1000, value: "#ff0000")]
        let doc = EffectAuthoringDocument(providerId: "x", effectId: "x", name: "X", values: ["k": 3], tracks: tracks, duration: 1000, loop: true)
        let mid = authoringValuesAt(doc, 1500)
        XCTAssertEqual(mid.keys, ["k", "on", "v", "c"])
        XCTAssertEqual(mid["on"], false)
        XCTAssertEqual(mid["v"], [0.5, 15])
        XCTAssertEqual(mid["c"], "#80000080")
        XCTAssertEqual(authoringValuesAt(doc, 999.999)["on"], false)
    }

    func testRemovesAndClearsKeyframes() async throws {
        let s = try await open(.effect("fake.invert"))
        _ = s.setKeyframe("amount", time: 500, value: 0.2)
        _ = s.setKeyframe("amount", time: 1500, value: 0.8)
        XCTAssertEqual(s.getState().tracks["amount"]?.count, 2)
        XCTAssertEqual(s.removeKeyframe("amount", time: 500), .ok)
        XCTAssertEqual(s.getState().tracks["amount"]?.count, 1)
        XCTAssertEqual(s.removeKeyframe("amount", time: 1500), .ok)
        XCTAssertNil(s.getState().tracks["amount"])
        _ = s.setKeyframe("amount", time: 500, value: 0.5)
        XCTAssertEqual(s.clearTrack("amount"), .ok)
        XCTAssertNil(s.getState().tracks["amount"])
        XCTAssertEqual(s.getState().values["amount"], 0.5)
        XCTAssertTrue(s.undo())
        XCTAssertEqual(s.getState().tracks["amount"]?.count, 1)
    }

    func testSavesAndAppliesPresets() async throws {
        let s = try await open(.effect("fake.invert"))
        _ = s.setValue("amount", 0.35)
        XCTAssertEqual(s.savePreset("custom-inv"), .ok)
        XCTAssertEqual((s.getState().description.json["presets"]?.arrayValue ?? []).map { $0["name"] }, ["custom-inv", "Half"])
        _ = s.setValue("amount", 0.9)
        XCTAssertEqual(s.applyPreset("custom-inv"), .ok)
        XCTAssertEqual(s.getState().values["amount"], 0.35)
    }

    /// The same edits as a TS session (fake.tint), compared as JSON with what the TS core gives.
    func testExportsAndReopensAsTheTSCoreDoes() async throws {
        let s = try await open(.effect("fake.tint"))
        _ = s.setKeyframe("amount", time: 0, value: 0.2, easing: .named("ease-in"))
        _ = s.setKeyframe("amount", time: 1000, value: 0.9)
        _ = s.setKeyframe("color", time: 300, value: "#102030", easing: .spring(stiffness: 200))
        _ = s.savePreset("Mine")
        let h = effectAuthoringToolHandlers(host: EffectAuthoringToolHost(session: { s }))
        let described = try await h["effect_authoring_describe"]!([:])
        XCTAssertEqual(described.stringified(), ##"{"name":"Tint","kind":"shader","sourceLanguage":null,"controls":[{"id":"color","description":"Tint colour as #rrggbb. Default #ff8800.","type":"color","alpha":false,"default":"#ff8800"},{"id":"amount","description":"How far to mix towards the colour, 0–1. Default 0.5.","type":"number","default":0.5,"min":0,"max":1}],"values":{"color":"#102030","amount":0.42074976880077763},"presets":["Mine","Sepia","Cool"],"tracks":[{"control":"amount","keyframes":2},{"control":"color","keyframes":1}],"time":500,"duration":1000,"loop":false,"issues":[],"previewError":null}"##)
        let kf = try await h["effect_authoring_set_keyframe"]!(["control": "amount", "time": 500, "value": 0.5])
        XCTAssertEqual(kf.stringified(), ##"{"control":"amount","keyframes":[{"time":0,"value":0.2,"easing":"ease-in"},{"time":500,"value":0.5},{"time":1000,"value":0.9}]}"##)
        let doc = s.exportDocument()
        let exported = ##"{"version":1,"providerId":"fake","effectId":"fake.tint","name":"Tint","values":{"color":"#102030","amount":0.5},"tracks":{"amount":[{"time":0,"value":0.2,"easing":"ease-in"},{"time":500,"value":0.5},{"time":1000,"value":0.9}],"color":[{"time":300,"value":"#102030","easing":{"type":"spring","stiffness":200}}]},"presets":[{"name":"Mine","values":{"color":"#102030","amount":0.42074976880077763}}],"duration":1000,"loop":false}"##
        XCTAssertEqual(JSONValue.object(doc.json).stringified(), exported)
        let seek = try await h["effect_authoring_seek"]!(["time": 250])
        XCTAssertEqual(seek.stringified(), ##"{"time":250,"values":{"color":"#102030","amount":0.29460704377176183}}"##)

        let again = try await open(.document(try JSONValue.parse(exported)))
        XCTAssertEqual(again.getState().tracks, s.getState().tracks)
        XCTAssertEqual(JSONValue.object(again.exportDocument().json).stringified(), exported)
        var named = doc.json
        named["name"] = "My tint"
        let renamed = try await open(.document(.object(named)))
        XCTAssertEqual(renamed.getState().name, "My tint")
        XCTAssertEqual(renamed.exportDocument().name, "My tint")
    }

    func testGivesADocumentsProviderDataBackUnchangedAndRefusesDataThatIsNotAnObject() async throws {
        let first = try await open(.effect("fake.invert"))
        XCTAssertNil(first.exportDocument().json["provider"])
        let data: JSONObject = ["metal": ["sourceHash": "abc", "msl": "fragment float4 f() { return 1; }"], "n": [1, 2]]
        var doc = first.exportDocument().json
        doc["provider"] = .object(data)
        let opened = try await open(.document(.object(doc)))
        _ = opened.setValue("amount", 0.3)
        let saved = opened.exportDocument()
        XCTAssertEqual(saved.provider, data)
        XCTAssertEqual(saved.json.keys.last, "provider")
        let again = try await open(.document(try JSONValue.parse(JSONValue.object(saved.json).stringified())))
        XCTAssertEqual(again.exportDocument().provider, data)
        doc["provider"] = "metal"
        let notObject = await openError(.document(.object(doc)))
        XCTAssertEqual(notObject?.code, "invalid_values")
        XCTAssertTrue(notObject?.message.contains("- /provider: must be an object of the provider's own data") == true, notObject?.message ?? "")
    }

    func testDropsProviderDataWhenTheSourceIsEditedAndUndoBringsItBack() async throws {
        let backend = StubBackend()
        let first = try await open(.effect("stub.a"), source: backend)
        let data: JSONObject = ["compiled": "for the old source"]
        var doc = first.exportDocument().json
        doc["provider"] = .object(data)
        let s = try await open(.document(.object(doc)), source: backend)
        let source = s.getState().source!
        // The same source again is not an edit of it.
        _ = await s.setSource(source)
        XCTAssertEqual(s.exportDocument().provider, data)
        _ = await s.setSource(source + "\ncontrol third")
        XCTAssertNil(s.exportDocument().provider)
        XCTAssertTrue(s.undo())
        XCTAssertEqual(s.exportDocument().provider, data)
        XCTAssertTrue(s.redo())
        XCTAssertNil(s.exportDocument().provider)
    }

    func testRefusesBadDocumentsNamingEachProblem() async throws {
        let good = try await open(.effect("fake.tint")).exportDocument().json
        func message(_ change: (inout JSONObject) -> Void) async -> String? {
            var d = good
            change(&d)
            return await openError(.document(.object(d)))?.message
        }
        let values = await message { $0["values"] = ["color": "garbage", "nope": 1] }
        XCTAssertTrue(values!.hasPrefix("Invalid values for effect \"fake.tint\":\n- /values/color"), values!)
        let r1 = await message { $0["tracks"] = ["amount": 5] }
        XCTAssertTrue(r1!.contains("/tracks/amount: must be a list of keyframes"))
        let r2 = await message { $0["tracks"] = ["nope": []] }
        XCTAssertTrue(r2!.contains("there is no control \"nope\""))
        let both = await message { $0["tracks"] = ["amount": [["time": -1, "value": 2]]] }!
        XCTAssertTrue(both.contains("/tracks/amount/0/time: must be a finite number of ms >= 0") && both.contains("/tracks/amount/0/value"), both)
        let r3 = await message { $0["tracks"] = ["amount": [["time": 0, "value": 0.5, "easing": "wobbly"]]] }
        XCTAssertTrue(r3!.contains("/tracks/amount/0/easing: is not a valid easing"))
        let r4 = await message { $0["presets"] = [["name": "Bad", "values": ["amount": 9]]] }
        XCTAssertTrue(r4!.contains("/presets/0/values/amount"))
        let r5 = await message { $0["duration"] = 0 }
        XCTAssertTrue(r5!.contains("/duration"))
        let r6 = await message { _ in }
        XCTAssertNil(r6)
    }

    func testPlaysLoopsAndStops() async throws {
        let clock = ManualSchedule()
        let s = try await open(.effect("fake.invert"), schedule: clock.schedule)
        _ = s.setTiming(duration: 4000, loop: true)
        s.seek(1500)
        s.play()
        XCTAssertTrue(s.getState().playing)
        clock.frame?(1000)
        clock.frame?(2000)
        XCTAssertEqual(s.getState().time, 2500)
        clock.frame?(4000)
        XCTAssertEqual(s.getState().time, 500)
        s.pause()
        XCTAssertFalse(s.getState().playing)
        XCTAssertNil(clock.frame)

        _ = s.setTiming(duration: nil, loop: false)
        s.seek(3500)
        s.play()
        clock.frame?(0)
        clock.frame?(1000)
        XCTAssertEqual(s.getState().time, 4000)
        XCTAssertFalse(s.getState().playing)
        XCTAssertNil(clock.frame)
    }

    func testNotifiesListenersAndKeepsStateIdentity() async throws {
        let s = try await open(.effect("fake.invert"))
        var heard = 0
        let sub = s.subscribe { _ in heard += 1 }
        let first = s.getState()
        _ = s.setValue("amount", 0.7)
        XCTAssertEqual(heard, 1)
        XCTAssertFalse(first === s.getState())
        sub.cancel()
        _ = s.setValue("amount", 0.9)
        XCTAssertEqual(heard, 1)
    }

    func testPreviewRendersKeyframedValuesAndRecordsWhyThereIsNone() async throws {
        var seen: [JSONValue?] = []
        let provider = FakeEffectProvider(onRender: { _, _, _, req in seen.append(req.values?["amount"]) })
        let s = try await open(.effect("fake.invert"), provider: provider)
        _ = s.setKeyframe("amount", time: 0, value: 0.1)
        _ = s.setKeyframe("amount", time: 2000, value: 0.9)
        let preview = try await s.createPreview(width: 4, height: 4)
        _ = try await preview.render(EffectRenderRequest(time: 1000, inputs: ["source": EffectPixels(width: 4, height: 4)]))
        XCTAssertEqual(seen.last??.numberValue ?? -1, 0.5, accuracy: 1e-12)
        _ = try await preview.render(EffectRenderRequest(time: 1000, values: ["amount": 0.25], inputs: ["source": EffectPixels(width: 4, height: 4)]))
        XCTAssertEqual(seen.last, 0.25)
        XCTAssertEqual(s.getState().compiled, true)
        preview.dispose()

        let badge = try await open(.effect("fake.badge"))
        XCTAssertEqual(badge.getState().time, 250)
        var errors: [String?] = []
        _ = badge.subscribe { errors.append($0.previewError) }
        do {
            _ = try await badge.createPreview(width: 16, height: 9)
            XCTFail("a vector effect has no pixel preview")
        } catch {}
        XCTAssertTrue(badge.getState().previewError!.hasPrefix("No pixel preview for this vector effect: \"fake.badge\" is a vector effect"))
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(badge.setValue("color", "#ff0000"), .ok)
    }

    // MARK: Source backend

    func testSourceEditsKeepTheLastGoodControlsCarryValuesOverAndUndo() async throws {
        let backend = StubBackend()
        let s = try await open(.effect("stub.a"), source: backend)
        XCTAssertTrue(s.canEditSource)
        XCTAssertEqual(s.getState().sourceLanguage, "pixel")
        XCTAssertEqual(s.getState().compiled, true)
        XCTAssertEqual(s.setValue("top", 0.2), .ok)

        let bad = await s.setSource("control top\nbad")
        XCTAssertEqual(bad, .ok(issues: [EffectAuthoringIssue(message: "bad line", line: 2, severity: "error")]))
        XCTAssertEqual(s.getState().compiled, false)
        XCTAssertEqual(s.getState().source, "control top\nbad")
        XCTAssertEqual(s.getState().description.controlNames, ["top", "bottom"])

        let good = await s.setSource("control top\ncontrol glow")
        XCTAssertEqual(good, .ok(issues: []))
        XCTAssertEqual(s.getState().compiled, true)
        XCTAssertEqual(s.getState().description.controlNames, ["top", "glow"])
        XCTAssertEqual(s.getState().values, ["top": 0.2, "glow": 0.5])

        let preview = try await s.createPreview(width: 1, height: 1)
        let drawn = try await preview.render(EffectRenderRequest(time: 0))
        XCTAssertEqual(Array(drawn.data.prefix(2)), [2, 51])

        XCTAssertTrue(s.undo())
        XCTAssertEqual(s.getState().compiled, false)
        XCTAssertTrue(s.undo())
        XCTAssertEqual(s.getState().source, "control top\ncontrol bottom")
        XCTAssertEqual(s.getState().description.controlNames, ["top", "bottom"])
        XCTAssertEqual(s.getState().values["top"], 0.2)
        // The preview follows the source that compiles now.
        _ = await s.setSource("control a\ncontrol b\ncontrol c")
        let after = try await preview.render(EffectRenderRequest(time: 0))
        XCTAssertEqual(after.data[0], 3)
        XCTAssertEqual(backend.renderersMade.count, 2)

        let before = s.getState()
        let refused = await s.setSource(String(repeating: "x", count: 200))
        XCTAssertEqual(refused, .refused("the source is 200 characters; the limit is 100"))
        XCTAssertTrue(s.getState() === before)

        let doc = s.exportDocument()
        XCTAssertEqual(doc.source, "control a\ncontrol b\ncontrol c")
        XCTAssertEqual(doc.sourceLanguage, "pixel")
        XCTAssertEqual(doc.json.keys.prefix(3), ["source", "sourceLanguage", "version"])
        let again = try await open(.document(.object(doc.json)), source: StubBackend())
        XCTAssertEqual(again.getState().source, doc.source)

        var broken = doc.json
        broken["source"] = "bad"
        let refusedDoc = await openError(.document(.object(broken)), source: StubBackend())
        XCTAssertEqual(refusedDoc?.message, "The effect's source doesn't compile (line 1: bad line); fix it in the document, or open a catalog effect instead.")
    }

    // MARK: Tools

    private func call(_ h: [String: EffectToolHandler], _ name: String, _ args: JSONObject = [:]) async -> (result: JSONValue?, error: String?) {
        do {
            return (try await h[name]!(args), nil)
        } catch {
            return (nil, (error as? EffectToolError)?.message ?? "\(error)")
        }
    }

    func testToolsRefuseWithoutASession() async throws {
        let h = effectAuthoringToolHandlers(host: EffectAuthoringToolHost(session: { nil }))
        XCTAssertNil(h["effect_authoring_view"])
        XCTAssertEqual(h.count, 14)
        for name in ["effect_authoring_describe", "effect_authoring_set_values", "effect_authoring_undo"] {
            let r = await call(h, name, ["values": ["amount": 0.5]])
            XCTAssertEqual(r.error, NO_EFFECT_AUTHORING_SESSION)
        }
        let custom = effectAuthoringToolHandlers(host: EffectAuthoringToolHost(session: { nil }, noSession: "Open the effect panel first."))
        let r = await call(custom, "effect_authoring_seek", ["time": 0])
        XCTAssertEqual(r.error, "Open the effect panel first.")
        XCTAssertFalse(effectAuthoringToolNames(EffectAuthoringToolHost(session: { nil })).contains("effect_authoring_set_source"))
        XCTAssertTrue(effectAuthoringToolNames(EffectAuthoringToolHost(session: { nil }, alwaysListSetSource: true)).contains("effect_authoring_set_source"))
    }

    func testToolsEditTheOpenSession() async throws {
        let s = try await open(.effect("fake.invert"))
        let h = effectAuthoringToolHandlers(host: EffectAuthoringToolHost(session: { s }))
        XCTAssertEqual(effectAuthoringToolNames(EffectAuthoringToolHost(session: { s })).count, 13)

        let source = await call(h, "effect_authoring_get_source")
        XCTAssertEqual(source.error, "The currently open effect (Invert) does not use shader or script source code.")
        let setSource = await call(h, "effect_authoring_set_source", ["source": "x"])
        XCTAssertEqual(setSource.error, "The open effect (Invert) has no source to edit: it is a catalog effect of its provider. Open an effect written in pixel expressions to edit source.")

        let r7 = await call(h, "effect_authoring_set_values", ["values": ["amount": 0.4]])
        XCTAssertEqual(r7.result?["values"]?["amount"], 0.4)
        let r8 = await call(h, "effect_authoring_set_values", ["values": ["amount": 5]])
        XCTAssertNotNil(r8.error)
        let r9 = await call(h, "effect_authoring_set_values", ["values": ["nonExistent": 1]])
        XCTAssertEqual(r9.error, "there is no control \"nonExistent\"; the controls are amount")
        let r10 = await call(h, "effect_authoring_reset_values", ["names": ["amount"]])
        XCTAssertEqual(r10.result?["values"]?["amount"], 1)

        _ = await call(h, "effect_authoring_set_values", ["values": ["amount": 0.3]])
        let r11 = await call(h, "effect_authoring_save_preset", ["name": "subtle"])
        XCTAssertEqual(r11.result, ["name": "subtle", "values": ["amount": 0.3]])
        _ = await call(h, "effect_authoring_reset_values")
        let r12 = await call(h, "effect_authoring_apply_preset", ["name": "subtle"])
        XCTAssertEqual(r12.result?["values"]?["amount"], 0.3)
        let r13 = await call(h, "effect_authoring_apply_preset", ["name": "missing"])
        XCTAssertNotNil(r13.error)

        let r14 = await call(h, "effect_authoring_set_keyframe", ["control": "amount", "time": 0, "value": 0])
        XCTAssertEqual(r14.result, ["control": "amount", "keyframes": [["time": 0, "value": 0]]])
        _ = await call(h, "effect_authoring_set_keyframe", ["control": "amount", "time": 1000, "value": 1, "easing": "ease-in-out"])
        let r15 = await call(h, "effect_authoring_seek", ["time": 500])
        XCTAssertEqual(r15.result?["values"]?["amount"]?.numberValue ?? -1, 0.5, accuracy: 0.05)
        let r16 = await call(h, "effect_authoring_remove_keyframe", ["control": "amount", "time": 0])
        XCTAssertEqual(r16.result?["keyframes"]?.arrayValue?.count, 1)
        let r17 = await call(h, "effect_authoring_clear_track", ["control": "amount"])
        XCTAssertEqual(r17.result, ["control": "amount", "value": 1])
        let r18 = await call(h, "effect_authoring_set_keyframe", ["control": "amount", "time": -100])
        XCTAssertNotNil(r18.error)
        let r19 = await call(h, "effect_authoring_set_keyframe", ["control": "nope", "time": 100, "value": 1])
        XCTAssertNotNil(r19.error)
        let r20 = await call(h, "effect_authoring_set_keyframe", ["control": "amount", "time": 500, "value": 0.8, "easing": ["type": "spring", "stiffness": 200]])
        XCTAssertNil(r20.error)
        let r21 = await call(h, "effect_authoring_set_keyframe", ["control": "amount", "time": 0, "easing": "wobbly"])
        XCTAssertEqual(r21.error, "invalid easing: wobbly")
        let r22 = await call(h, "effect_authoring_set_keyframe", ["control": "amount", "time": 0, "easing": ["type": "cubic-bezier", "x1": 0]])
        XCTAssertEqual(r22.error, "invalid easing: [object Object]")

        let r23 = await call(h, "effect_authoring_set_timing", ["duration": 2500, "loop": true])
        XCTAssertEqual(r23.result, ["duration": 2500, "loop": true])
        let r24 = await call(h, "effect_authoring_set_timing")
        XCTAssertEqual(r24.error, "Provide at least one of duration or loop to change.")
        let r25 = await call(h, "effect_authoring_set_timing", ["duration": 0])
        XCTAssertEqual(r25.error, "duration must be a finite number > 0")
        let r26 = await call(h, "effect_authoring_seek", ["time": 99999])
        XCTAssertEqual(r26.result?["time"], 2500)
        let r27 = await call(h, "effect_authoring_seek", ["time": -10])
        XCTAssertEqual(r27.error, "time must be a finite non-negative number.")

        let r28 = await call(h, "effect_authoring_undo")
        XCTAssertEqual(r28.result, ["changed": true, "canUndo": true, "canRedo": true])
        let r29 = await call(h, "effect_authoring_redo")
        XCTAssertEqual(r29.result, ["changed": true, "canUndo": true, "canRedo": false])
    }

    func testToolsEditSourceAndDescribeAnyOfColours() async throws {
        let s = try await open(.effect("stub.a"), source: StubBackend())
        let h = effectAuthoringToolHandlers(host: EffectAuthoringToolHost(session: { s }))
        XCTAssertTrue(effectAuthoringToolNames(EffectAuthoringToolHost(session: { s })).contains("effect_authoring_set_source"))
        let r30 = await call(h, "effect_authoring_get_source")
        XCTAssertEqual(r30.result, ["language": "pixel", "source": "control top\ncontrol bottom"])
        let r31 = await call(h, "effect_authoring_set_source", ["source": "control x\nbad"])
        XCTAssertEqual(r31.result, ["issues": [["severity": "error", "line": 2, "message": "bad line"]]])
        let r32 = await call(h, "effect_authoring_describe")
        XCTAssertEqual(r32.result?["issues"], [["severity": "error", "line": 2, "message": "bad line"]])
        let r33 = await call(h, "effect_authoring_set_source", ["source": .string(String(repeating: "y", count: 101))])
        XCTAssertEqual(r33.error, "the source is 101 characters; the limit is 100")

        let colour: JSONObject = ["title": "Colour", "anyOf": [["type": "array", "items": ["type": "number", "minimum": 0, "maximum": 1], "minItems": 3, "maxItems": 3], ["type": "string", "pattern": "^#[0-9a-fA-F]{6}$"], ["const": "currentColor"]], "default": "#ff8800"]
        var tint = try await FakeEffectProvider().describe("fake.tint").json
        var controls = tint["controls"]!.objectValue!
        var props = controls["properties"]!.objectValue!
        props["color"] = .object(colour)
        controls["properties"] = .object(props)
        tint["controls"] = .object(controls)
        let fields = effectParameterFields(EffectDescription(tint))
        XCTAssertEqual(fields.map { [$0["id"], $0["type"]] }, [["color", "color"], ["amount", "number"]])
        XCTAssertEqual(JSONValue.object(fields[0]).stringified(), ##"{"id":"color","label":"Colour","type":"color","alpha":false,"default":"#ff8800"}"##)
        let font = effectControlField("family", ["type": "string", "format": "font"], "Papyrus", fonts: [EffectFieldFont(family: "Arial", category: "sans-serif")])
        XCTAssertEqual(font.map { JSONValue.object($0).stringified() }, ##"{"id":"family","type":"choice","options":[{"value":"Papyrus","label":"Papyrus","description":"current"},{"value":"Arial","label":"Arial","description":"sans-serif"}],"default":"Papyrus","control":"select"}"##)
    }
}
