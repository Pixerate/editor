import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Live effect paint in the view (`showEffectTime`, `playEffects`) and the painting at a moment (`withEffectTime`, `renderAnimationFrame`).
final class PaintEffectPlaybackTests: XCTestCase {
    private let line = [PenPoint(x: 4, y: 16, pressure: 0.9), PenPoint(x: 24, y: 20, pressure: 0.9), PenPoint(x: 44, y: 16, pressure: 0.9)]

    /// A 48 × 32 painting with one live stroke of a turning gradient on a stroke layer.
    private func livePainting() async throws -> PaintEditorController {
        let c = try PaintEditorController(width: 48, height: 32, brushId: "ink-pen")
        c.setEffectsProvider(FakeEffectProvider())
        _ = try c.addLayer(type: "strokes")
        _ = try await c.setEffectPaint("fake.gradient", values: ["from": "#ffcc00", "to": "#00ccff", "angle": 0, "spin": 180], live: true)
        _ = try c.paintStroke(PaintStrokeInit(seed: 8), points: line)
        return c
    }

    func testAFrameShowsInTheViewWithoutChangingTheDocument() async throws {
        let c = try await livePainting()
        let saved = JSONValue.object(c.toJSON()).stringified()
        let atRest = c.compositePixels(paper: false).data
        let undoLabel = c.undoLabel
        var heard = 0
        let sub = c.subscribe { heard += 1 }
        defer { sub.cancel() }

        let shown = try await c.showEffectTime(1000)
        XCTAssertTrue(shown)
        XCTAssertEqual(heard, 1)
        let frame = c.compositePixels(paper: false).data
        XCTAssertNotEqual(frame, atRest, "the view shows the effect a second on")
        XCTAssertEqual(JSONValue.object(c.toJSON()).stringified(), saved, "frames are view only")
        XCTAssertEqual(c.effectPlaybackState.time, 1000)
        XCTAssertEqual(c.undoLabel, undoLabel, "frames are not undo steps")

        // A frame at a moment is the same picture, and the moment the painting was painted is the one at rest.
        let at1000 = try await c.renderAnimationFrame(1000, paper: false).data
        XCTAssertEqual(at1000, frame)
        let at0 = try await c.renderAnimationFrame(0, paper: false).data
        XCTAssertEqual(at0, atRest)
    }

    func testAChangeToTheStrokeLayerDropsTheFrame() async throws {
        let c = try await livePainting()
        _ = try await c.showEffectTime(1000)
        _ = try c.setColor("#336699")
        _ = try c.paintStroke(PaintStrokeInit(seed: 9), points: [PenPoint(x: 4, y: 4, pressure: 1), PenPoint(x: 44, y: 4, pressure: 1)])
        // The committed pixels changed under the frame: the view shows them, not the stale frame.
        let reference = try PaintEditorController(width: 48, height: 32, brushId: "ink-pen")
        reference.setEffectsProvider(FakeEffectProvider())
        _ = try reference.addLayer(type: "strokes")
        _ = try await reference.setEffectPaint("fake.gradient", values: ["from": "#ffcc00", "to": "#00ccff", "angle": 0, "spin": 180], live: true)
        _ = try reference.paintStroke(PaintStrokeInit(seed: 8), points: line)
        _ = try reference.setColor("#336699")
        _ = try reference.paintStroke(PaintStrokeInit(seed: 9), points: [PenPoint(x: 4, y: 4, pressure: 1), PenPoint(x: 44, y: 4, pressure: 1)])
        XCTAssertEqual(c.compositePixels(paper: false).data, reference.compositePixels(paper: false).data)
    }

    func testExportsAtAMomentRestoreTheView() async throws {
        let c = try await livePainting()
        let atRest = try c.exportPng(paper: false)
        let later = try await c.withEffectTime(1000) { try c.exportPng(paper: false) }
        XCTAssertNotEqual(later, atRest)
        XCTAssertEqual(try c.exportPng(paper: false), atRest, "nothing persists after the export")
        do {
            _ = try await c.withEffectTime(-1) { 0 }
            XCTFail("a negative moment is refused")
        } catch {
            XCTAssertEqual("\(error)", "time -1 is not a moment of the effect; use 0 or more milliseconds.")
        }
    }

    func testAPaintingWithoutLiveEffectsExportsAsItIs() async throws {
        let c = try PaintEditorController(width: 48, height: 32, brushId: "ink-pen")
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: line)
        let atRest = try c.exportPng(paper: false)
        let later = try await c.withEffectTime(500) { try c.exportPng(paper: false) }
        XCTAssertEqual(later, atRest)
        _ = try await c.showEffectTime(500)
        XCTAssertEqual(try c.exportPng(paper: false), atRest)
    }

    func testThePlayerFollowsPlaybackSettingsAndTheFrameRateCap() async throws {
        let c = try await livePainting()
        _ = try c.setEffectPlayback(playing: true, fps: 10)
        let player = c.playEffects(now: 0)
        let first = await player.tick(now: 0)
        XCTAssertTrue(first)
        let tooSoon = await player.tick(now: 50)
        XCTAssertFalse(tooSoon, "10 fps shows a frame at most every 100 ms")
        let next = await player.tick(now: 120)
        XCTAssertTrue(next)
        XCTAssertEqual(c.effectPlaybackState.time, 120)

        // Paused: the moment shown holds while the view keeps ticking, and playing again carries on from it.
        _ = try c.setEffectPlayback(playing: false)
        for now in stride(from: 500.0, through: 1000, by: 100) {
            let paused = await player.tick(now: now)
            XCTAssertFalse(paused)
        }
        XCTAssertEqual(c.effectPlaybackState.time, 120)
        _ = try c.setEffectPlayback(playing: true)
        let resumed = await player.tick(now: 1010)
        XCTAssertTrue(resumed)
        XCTAssertEqual(c.effectPlaybackState.time, 130)
        let after = await player.tick(now: 1210)
        XCTAssertTrue(after)
        XCTAssertEqual(c.effectPlaybackState.time, 330)

        player.stop()
        let stopped = await player.tick(now: 2000)
        XCTAssertFalse(stopped)
    }

    func testThePlayerIdlesWithoutLiveEffects() async throws {
        let c = try PaintEditorController(width: 48, height: 32, brushId: "ink-pen")
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: line)
        let player = c.playEffects(now: 0)
        let ticked = await player.tick(now: 100)
        XCTAssertFalse(ticked)
    }

    func testExportToolsDrawLiveEffectsAtTheMomentGiven() async throws {
        let c = try await livePainting()
        let registry = ToolRegistry()
        _ = try registry.register(createPaintEditorToolProvider(c))
        let atRest = await registry.callTool("paint-editor__export_image", ["paper": false])
        let later = await registry.callTool("paint-editor__export_image", ["paper": false, "time": 1000])
        XCTAssertFalse(atRest.isError)
        XCTAssertFalse(later.isError)
        XCTAssertNotEqual(atRest.structuredContent?["data"], later.structuredContent?["data"])
        let psd = await registry.callTool("paint-editor__export_psd", ["time": 1000])
        XCTAssertFalse(psd.isError)
        let refused = await registry.callTool("paint-editor__export_image", ["time": -5])
        XCTAssertTrue(refused.isError)
    }
}
