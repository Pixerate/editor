import Foundation
import PixerateCore
import PixeratePaint
import XCTest

// No `@testable import` here: this file only uses what a host outside PixeratePaint can see (#747).
final class PaintPublicInitTests: XCTestCase {
    func testHostReplaysAStrokeWithPublicReplayOptions() throws {
        let c = try PaintEditorController(width: 80, height: 60)
        let r = try c.paintStroke(PaintStrokeInit(seed: 1), points: [
            PenPoint(x: 10, y: 20, pressure: 1),
            PenPoint(x: 40, y: 20, pressure: 1),
            PenPoint(x: 70, y: 20, pressure: 1),
        ])
        let id = try XCTUnwrap(r.strokeId)

        let replayed = try c.replayStrokes(ReplayOptions(strokeIds: [id]))
        XCTAssertEqual(replayed["strokeIds"]?.arrayValue?.count, 1)

        let moved = try c.replayStrokes(ReplayOptions(strokeIds: [id], dy: 25, origin: (x: 40, y: 20), repeatCount: 2))
        XCTAssertEqual(moved["strokeIds"]?.arrayValue?.count, 2)
        XCTAssertEqual(c.strokes.count, 4)

        XCTAssertThrowsError(try c.replayStrokes(ReplayOptions(strokeIds: ["nope"])))
    }

    func testHostMakesAnAuthoringEditor() throws {
        let c = try PaintEditorController(width: 32, height: 16, authoredEffects: try AuthoredEffectsPolicy.parse("author"), rawShaders: false, authoredEffectLimits: AuthoredEffectLimits(maxSourceLength: 4096, maxCost: 512, trialSize: 32, trialRenderMs: 200, liveFrameMs: 40))
        XCTAssertEqual(c.authoredPolicy, .author)
        _ = PaintAuthoredEffect(id: "authored.x", name: "X", document: ["version": 1, "providerId": "pixel"])
        XCTAssertEqual(try createPaintEffectAuthoringToolProvider(c, readOnly: { nil }).tools.count, 20)
    }

    func testHostBuildsEngineOptionStructs() {
        let rates = mixerRates(MixerSettings(wet: 0.5, load: 0.5, mix: 0.5, loadEachStroke: true, cleanEachStroke: false, mixing: "pigment"))
        _ = ExchangeRates(pickup: rates.pickup, mix: rates.mix, drain: rates.drain, mixing: rates.mixing)
        _ = BlenderSettings(strength: 0.5, distance: 4, mixing: "rgb")
        _ = SmudgeSettings(strength: 0.5, length: 0.5, mixing: "rgb")
        _ = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [255, 255, 255]) { _, _ in 0.5 }
        _ = PaintDabParams(travel: 0, index: 0, pressure: 1, lean: 0, direction: 0)
        let profile = BrushHostProfile(
            id: "host", name: "Host", kinds: [], tools: [], tipShapes: [], marks: [], surfaces: [],
            exchange: "none", reservoir: "none", grain: "none", light: "none", motion: "none",
            colours: [], velocity: "none", tilt: "none"
        )
        XCTAssertNil(profile.tipGrain)
    }
}
