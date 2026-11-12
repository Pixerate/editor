import Foundation
import PixerateCore
import PixeratePaint
import XCTest
@testable import PixeratePaintUI

/// The effect authoring editor's view model (`EffectAuthoringModel`) and the paint editor's entry points (#752).
@MainActor
final class EffectAuthoringModelTests: XCTestCase {
    private func makeModel(_ policy: AuthoredEffectsPolicy = .author, provider: Bool = false) throws -> PaintEditorModel {
        let c = try PaintEditorController(width: 48, height: 32, authoredEffects: policy)
        c.authoredEffectsGPU = false
        if provider { c.setEffectsProvider(FakeEffectProvider()) }
        return try PaintEditorModel(controller: c)
    }

    private func editor(_ model: PaintEditorModel, _ effect: String = "pixel.rings") async throws -> EffectAuthoringModel {
        await model.openEffectAuthoring(effect)
        XCTAssertNil(model.error)
        let editor = try XCTUnwrap(model.authoringEditor)
        editor.preferGPU = false
        return editor
    }

    func testAuthoringIsOfferedOnlyWithTheAuthorPolicy() async throws {
        let replay = try makeModel(.replay)
        XCTAssertFalse(replay.canAuthorEffects)
        XCTAssertFalse(replay.tabs.contains(.providerEffects), "no provider and no authoring: no Effects tab")
        await replay.openEffectAuthoring("pixel.blank")
        XCTAssertNotNil(replay.error, "the controller refuses")
        XCTAssertFalse(replay.authoringPresented)
        XCTAssertNil(replay.authoringEditor)

        let author = try makeModel()
        XCTAssertTrue(author.canAuthorEffects)
        XCTAssertTrue(author.tabs.contains(.providerEffects), "the Effects tab offers New effect without a provider")
        XCTAssertEqual(author.effectTemplates.map(\.id), ["pixel.blank", "pixel.rings", "pixel.clouds"])
    }

    func testOpensShowsAndClosesOneSession() async throws {
        let model = try makeModel()
        let editor = try await editor(model)
        XCTAssertTrue(model.authoringPresented)
        XCTAssertEqual(model.authoringFrom, "pixel.rings")
        XCTAssertTrue(model.authoringEditor === editor, "the same model while the session stays open")
        await model.openEffectAuthoring("pixel.blank")
        XCTAssertNotNil(model.error, "one session at a time")
        model.closeEffectAuthoring()
        XCTAssertFalse(model.authoringPresented)
        XCTAssertNil(model.authoringEditor)
        XCTAssertNil(model.controller.authoringSession)
    }

    func testFollowsAnAgentsSession() async throws {
        let model = try makeModel()
        let opened = await model.registry.callTool("open_effect_authoring", ["effect": "pixel.blank"])
        XCTAssertFalse(opened.isError)
        let editor = try XCTUnwrap(model.authoringEditor, "a session an agent opened shows here too")
        XCTAssertFalse(model.authoringPresented, "but the editor isn't popped up over the person's work")
        let source = "control glow: number = 0.5 range 0 1 // Glow.\nout = vec4(vec3(glow), 1)"
        let set = await model.registry.callTool("effect_authoring_set_source", ["source": .string(source)])
        XCTAssertFalse(set.isError)
        XCTAssertEqual(editor.sourceDraft, source)
        XCTAssertEqual(editor.fields.map(\.id), ["glow"])
        _ = await model.registry.callTool("effect_authoring_set_values", ["values": ["glow": 0.8]])
        XCTAssertEqual(editor.value(editor.fields[0]), 0.8)
        XCTAssertTrue(editor.state.canUndo)
        editor.undo()
        XCTAssertEqual(editor.value(editor.fields[0]), 0.5)
    }

    func testFieldsKeyframesAndTimeline() async throws {
        let model = try makeModel()
        let editor = try await editor(model)
        let fields = editor.fields
        XCTAssertFalse(fields.isEmpty)
        let number = try XCTUnwrap(fields.first { $0.type == "number" && $0.min != nil && $0.max != nil })
        XCTAssertEqual(editor.keyframeMark(number.id), .none)

        editor.seek(0)
        editor.toggleKeyframe(number.id)
        XCTAssertEqual(editor.keyframeMark(number.id), .atPlayhead)
        editor.seek(editor.state.duration)
        XCTAssertEqual(editor.keyframeMark(number.id), .animated)
        editor.toggleKeyframe(number.id)
        XCTAssertEqual(editor.timelineTracks.map(\.control), [number.id])
        XCTAssertEqual(editor.timelineTracks[0].positions, [0, 1])
        editor.toggleKeyframe(number.id)
        XCTAssertEqual(editor.timelineTracks[0].times, [0], "the toggle removes the keyframe at the playhead")
        editor.clearTrack(number.id)
        XCTAssertTrue(editor.timelineTracks.isEmpty)
        XCTAssertNil(editor.message)

        editor.setValue(number.id, .number(number.max! + 1000))
        XCTAssertNotNil(editor.message, "an out-of-range value is refused, with the reason")
    }

    func testValuesMergeOneGestureIntoOneUndoStep() async throws {
        let model = try makeModel()
        let editor = try await editor(model)
        let number = try XCTUnwrap(editor.fields.first { $0.type == "number" && $0.min != nil && $0.max != nil })
        let before = editor.value(number)
        let lo = number.min!, hi = number.max!
        editor.setValue(number.id, .number(lo + (hi - lo) * 0.25), gesture: "slider")
        editor.setValue(number.id, .number(lo + (hi - lo) * 0.75), gesture: "slider")
        XCTAssertEqual(editor.value(number), .number(lo + (hi - lo) * 0.75))
        editor.undo()
        XCTAssertEqual(editor.value(number), before, "a slider drag is one undo step")
        editor.redo()
        XCTAssertEqual(editor.value(number), .number(lo + (hi - lo) * 0.75))
        editor.resetValue(number.id)
        XCTAssertEqual(editor.value(number), number.defaultValue)
    }

    func testPresetsAndTiming() async throws {
        let model = try makeModel()
        let editor = try await editor(model)
        XCTAssertFalse(editor.savePreset("   "))
        XCTAssertEqual(editor.message, "Give the preset a name.")
        XCTAssertTrue(editor.savePreset(" Mine "))
        XCTAssertTrue(editor.presetNames.contains("Mine"))
        editor.applyPreset("Mine")
        XCTAssertNil(editor.message)

        XCTAssertFalse(editor.setDuration(0))
        XCTAssertFalse(editor.setDuration(.nan))
        XCTAssertFalse(editor.setDuration(editor.state.duration), "the same duration is no undo step")
        XCTAssertTrue(editor.setDuration(2500))
        XCTAssertEqual(editor.state.duration, 2500)
        editor.setLoop(!editor.state.loop)
        editor.seek(500)
        XCTAssertEqual(editor.timeReadout, "500ms / 2500ms")
    }

    func testTypedSourceAppliesAndMarksIssueLines() async throws {
        let model = try makeModel()
        let editor = try await editor(model, "pixel.blank")
        XCTAssertTrue(editor.hasSource)
        XCTAssertTrue(editor.marksIssueLines)
        editor.sourceDelay = 60
        editor.editSource("control a: number = 1 range 0 2 // A.\nout = vec3(oops)")
        XCTAssertEqual(editor.sourceLineCount, 2)
        XCTAssertNotEqual(editor.state.source, editor.sourceDraft, "applied after a pause")
        await editor.commitSource()
        XCTAssertEqual(editor.state.source, editor.sourceDraft)
        XCTAssertEqual(editor.state.compiled, false)
        XCTAssertEqual(editor.issueLines, [2: "error"])
        // The fix, typed and applied at once (as Save to painting does).
        editor.editSource("control a: number = 1 range 0 2 // A.\nout = vec3(a / 2)")
        await editor.commitSource()
        XCTAssertTrue(editor.issueLines.isEmpty)
        XCTAssertEqual(editor.fields.map(\.id), ["a"])
    }

    func testRendersThePreviewOnTheCPU() async throws {
        let model = try makeModel()
        let editor = try await editor(model)
        await editor.renderFrames()
        let frame = try XCTUnwrap(editor.preview, editor.previewError ?? "no frame")
        XCTAssertEqual(frame.width, editor.previewWidth)
        XCTAssertEqual(frame.height, editor.previewHeight)
        XCTAssertFalse(editor.previewOnGPU)
        XCTAssertNil(editor.previewError)
        XCTAssertNotNil(effectPreviewImage(frame))
        editor.detach()
    }

    func testAVectorEffectSaysWhyThereIsNoPreview() async throws {
        let model = try makeModel(provider: true)
        let editor = try await editor(model, "fake.badge")
        XCTAssertFalse(editor.hasSource, "a provider effect has no source pane")
        await editor.renderFrames()
        XCTAssertNil(editor.preview)
        XCTAssertTrue(editor.previewError?.hasPrefix("No pixel preview for this vector effect") == true, editor.previewError ?? "")
    }

    func testSavesToThePainting() async throws {
        let model = try makeModel()
        let editor = try await editor(model)
        editor.editSource("control glow: number = 0.5 range 0 1 // Glow.\nout = vec4(vec3(glow), 1)")
        await editor.commitSource()
        let id = await model.saveAuthoredEffect(name: "  Glow  ")
        XCTAssertEqual(id, "authored.glow")
        XCTAssertNil(model.error)
        XCTAssertNotNil(model.authoringEditor, "the session stays open to save again")
        let listed = await model.authoredEffects()
        XCTAssertEqual(listed.map(\.id), ["authored.glow"])
        XCTAssertTrue(model.authoredEffectsKey.hasPrefix("authored.glow|"))

        let again = await model.saveAuthoredEffect(name: "Glow")
        XCTAssertEqual(again, "authored.glow-2", "saving again makes a new id")
        model.closeEffectAuthoring()
        await model.openEffectAuthoring("authored.glow")
        XCTAssertEqual(model.authoringFrom, "authored.glow", "Edit opens an authored effect")
    }

    func testSavingABrokenEffectIsRefused() async throws {
        let model = try makeModel()
        let editor = try await editor(model, "pixel.blank")
        editor.editSource("out = vec3(oops)")
        await editor.commitSource()
        let id = await model.saveAuthoredEffect()
        XCTAssertNil(id)
        XCTAssertTrue(model.error?.contains("doesn't compile") == true, model.error ?? "")
    }
}
