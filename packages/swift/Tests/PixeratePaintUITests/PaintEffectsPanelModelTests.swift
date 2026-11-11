import Foundation
import PixerateCore
import PixeratePaint
import XCTest
@testable import PixeratePaintUI

/// The effects panel's handlers (`PaintProviderEffectsPanel`): the same controller calls the effect tools make.
@MainActor
final class PaintEffectsPanelModelTests: XCTestCase {
    private func makeModel(provider: Bool = true) throws -> PaintEditorModel {
        let model = try PaintEditorModel(controller: PaintEditorController(width: 48, height: 32, brushId: "ink-pen"))
        if provider { model.controller.setEffectsProvider(FakeEffectProvider()) }
        return model
    }

    func testTheEffectsTabShowsOnlyWithAProvider() throws {
        let model = try makeModel(provider: false)
        XCTAssertFalse(model.tabs.contains(.providerEffects))
        XCTAssertTrue(model.tabs.contains(.effects), "layer styles need no provider")
        let revision = model.revision
        model.controller.setEffectsProvider(FakeEffectProvider())
        XCTAssertGreaterThan(model.revision, revision, "registering a provider redraws the panels")
        XCTAssertTrue(model.tabs.contains(.providerEffects))
        XCTAssertEqual(PaintPanelTab.providerEffects.label, "Effects")
    }

    func testTheBrowserOffersWhatEachPlaceTakes() async throws {
        let model = try makeModel()
        let paper = await model.effects(for: .paper).map(\.id)
        XCTAssertTrue(paper.contains("fake.gradient"))
        XCTAssertFalse(paper.contains("fake.bar"), "effect paper takes generators only")
        let light = await model.effects(for: .light).map(\.id)
        XCTAssertEqual(Set(light), ["fake.invert", "fake.tint"])
        let paint = await model.effects(for: .paint).map(\.id)
        XCTAssertFalse(paint.contains("fake.badge"), "vector effects draw no pixels to paint with")
        XCTAssertFalse(paint.contains("fake.crossfade"))
        let searched = await model.effects(for: .light, query: "tint").map(\.id)
        XCTAssertEqual(searched, ["fake.tint"])
        XCTAssertNil(model.error)
    }

    func testWithPaintHintsTheBrowserOffersOnlyHintedPaintsAndPicksFromTheHint() async throws {
        let model = try makeModel(provider: false)
        model.controller.setEffectsProvider(FakeEffectProvider(paintHints: true))
        let paints = await model.effects(for: .paint).map(\.id)
        XCTAssertEqual(Set(paints), ["fake.gradient", "fake.trail"])
        let layers = await model.effects(for: .layer).map(\.id)
        XCTAssertTrue(layers.contains("fake.bar"), "layers still take every effect")
        _ = try model.controller.setColor("#ff0000")
        _ = try model.controller.setSecondaryColor("#0000ff")
        await model.pickEffect("fake.gradient", for: .paint)
        let p = try XCTUnwrap(model.effectPaint)
        XCTAssertEqual(p.map?.by, "stroke")
        XCTAssertEqual(p.map?.repeatMode, "mirror")
        XCTAssertEqual(p.values["from"], "#ff0000")
        XCTAssertEqual(p.values["to"], "#0000ff")
        XCTAssertTrue(p.live)
        // Repainting keeps what the paint has, not the hint.
        await model.repaintEffect(map: ["by": "canvas"])
        await model.repaintEffect(values: ["angle": 10])
        XCTAssertNil(model.effectPaint?.map)
        await model.pickEffect("fake.bar", for: .paint)
        XCTAssertNotNil(model.error, "an effect without a hint is refused as paint")
    }

    func testPickingPutsTheEffectInItsPlace() async throws {
        let model = try makeModel()
        await model.pickEffect("fake.gradient", for: .paper)
        XCTAssertEqual(model.paperEffect?.source.effect, "fake.gradient")
        XCTAssertEqual(model.controller.undoLabel, "Effect paper")
        await model.updatePaperEffect(opacity: 0.4, blend: "screen")
        XCTAssertEqual(model.paperEffect?.opacity, 0.4)
        XCTAssertEqual(model.paperEffect?.blend, "screen")
        await model.updatePaperEffect(values: ["angle": 45])
        XCTAssertEqual(model.paperEffect?.source.values["angle"], 45)
        await model.removePaperEffect()
        XCTAssertNil(model.paperEffect)

        await model.pickEffect("fake.bar", for: .layer)
        let layer = try XCTUnwrap(model.activeEffectLayer)
        XCTAssertEqual(layer.effect, "fake.bar")
        await model.updateEffectLayer(values: ["height": 0.3])
        XCTAssertEqual(model.activeEffectLayer?.values["height"], 0.3)
        model.rasterizeEffectLayer()
        XCTAssertNil(model.activeEffectLayer)
        XCTAssertFalse(model.effectsBusy)
        XCTAssertNil(model.error)
    }

    func testAFailureIsReportedNotThrown() async throws {
        let model = try makeModel()
        await model.pickEffect("fake.bar", for: .paper)
        XCTAssertNil(model.paperEffect)
        let error = try XCTUnwrap(model.error)
        XCTAssertTrue(error.contains("effect paper takes generator effects"), error)
        XCTAssertFalse(model.effectsBusy)
    }

    func testEffectPaintPlacementLiveAndPlayback() async throws {
        let model = try makeModel()
        await model.pickEffect("fake.gradient", for: .paint)
        XCTAssertEqual(model.effectPaint?.effect, "fake.gradient")
        await model.repaintEffect(map: PaintEffectStrokeMap(length: 64, repeatMode: "mirror").json)
        XCTAssertEqual(model.effectPaint?.map, PaintEffectStrokeMap(length: 64, repeatMode: "mirror"))
        await model.repaintEffect(values: ["spin": 180], map: .string("canvas"), live: true)
        XCTAssertNil(model.effectPaint?.map)
        XCTAssertEqual(model.effectPaint?.live, true)
        XCTAssertEqual(model.effectPaint?.values["spin"], 180)
        XCTAssertEqual(model.effectPaint?.values["from"], "#1e3a8a", "the other values are kept")

        XCTAssertNil(model.liveAnimation)
        model.addLayer(type: "strokes")
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: [PenPoint(x: 4, y: 16, pressure: 0.9), PenPoint(x: 44, y: 16, pressure: 0.9)])
        XCTAssertEqual(model.liveAnimation, PaintLiveAnimation(layerIds: [model.activeLayer!.id], strokes: 1, sources: 1))

        model.setEffectPlayback(playing: false, fps: 12)
        XCTAssertEqual(model.effectPlayback.playing, false)
        XCTAssertEqual(model.effectPlayback.fps, 12)
        model.setEffectPlayback(fps: 0)
        XCTAssertEqual(model.error, "fps 0 is out of range; use a whole number 1..60.")

        model.stopEffectPaint()
        XCTAssertNil(model.effectPaint)
    }

    func testExportingAtTheMomentShown() async throws {
        let model = try makeModel()
        model.addLayer(type: "strokes")
        _ = try await model.controller.setEffectPaint("fake.gradient", values: ["spin": 180, "angle": 0], live: true)
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: [PenPoint(x: 4, y: 16, pressure: 0.9), PenPoint(x: 44, y: 16, pressure: 0.9)])
        let rest = await model.exportFile(.png)
        let atRest = try XCTUnwrap(rest)
        let moment = await model.exportFile(.png, time: 1000)
        let later = try XCTUnwrap(moment)
        XCTAssertNotEqual(atRest.bytes, later.bytes)
        let psd = await model.exportFile(.psd, time: 1000)
        XCTAssertNotNil(psd)
        let refused = await model.exportFile(.png, time: -1)
        XCTAssertNil(refused)
        XCTAssertEqual(model.error, "time -1 is not a moment of the effect; use 0 or more milliseconds.")
    }

    func testFramesRedrawTheCanvasButNotThePanels() async throws {
        let model = try makeModel()
        model.addLayer(type: "strokes")
        _ = try await model.controller.setEffectPaint("fake.gradient", values: ["spin": 180], live: true)
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: [PenPoint(x: 4, y: 16, pressure: 0.9), PenPoint(x: 44, y: 16, pressure: 0.9)])
        var flagged: [Bool] = []
        let sub = model.controller.subscribe { flagged.append(model.controller.emittingViewFrame) }
        defer { sub.cancel() }
        let revision = model.revision
        _ = try await model.controller.showEffectTime(500)
        XCTAssertEqual(flagged, [true])
        XCTAssertGreaterThan(model.revision, revision, "the canvas redraws")
        XCTAssertFalse(model.controller.emittingViewFrame)
    }
}
