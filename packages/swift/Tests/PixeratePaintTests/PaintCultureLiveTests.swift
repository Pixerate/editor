import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/**
 * Live biopaint growth (`playCultures`, #731): clock-driven, so the conformance scenarios (which
 * call tools) can't reach it. Mirrors tests 14, 16, 20, 22 and 23 of `paint-culture.test.ts`.
 */
final class PaintCultureLiveTests: XCTestCase {
    private func pts(_ list: [(Double, Double)], pressure: Double? = nil) -> [PenPoint] {
        list.map { PenPoint(x: $0.0, y: $0.1, pressure: pressure) }
    }

    private func grows(_ c: PaintEditorController) -> [PaintEvent] {
        (c.doc.paintEvents ?? []).filter { $0.kind == "culture-grow" }
    }

    private func run(_ player: PaintCulturePlayer, _ now: inout Double, frames: Int, ms: Double = 100) {
        for _ in 0..<frames {
            now += ms
            player.tick(now: now)
        }
    }

    private func maxDiff(_ a: TiledSurface, _ b: TiledSurface, _ w: Int, _ h: Int) -> Int {
        var diff = 0
        for y in 0..<h {
            for x in 0..<w {
                let u = readPixel(a, x, y), v = readPixel(b, x, y)
                for k in 0..<4 { diff = Swift.max(diff, abs(u[k] - v[k])) }
            }
        }
        return diff
    }

    // TS 14: a live run commits as one undo step; undo flushes it, undoes it and pauses growth.
    func testLiveRunIsOneUndoStepAndUndoPauses() throws {
        let c = try PaintEditorController(width: 140, height: 140)
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 12), points: pts([(30, 50), (30, 90)]))
        let undoBefore = c.undoStack.count
        var now = 1000.0
        let player = c.playCultures(now: now)
        run(player, &now, frames: 6)
        XCTAssertGreaterThan(c.getCultures().layers[0].tick, 0)
        // Growing is not a step yet: it commits when interrupted.
        XCTAssertEqual(c.undoStack.count, undoBefore)
        XCTAssertTrue(grows(c).isEmpty)
        XCTAssertEqual(c.undo(), "Culture growth")
        XCTAssertTrue(c.getCultures().paused)
        XCTAssertEqual(c.getCultures().layers[0].tick, 0)
        // Paused: nothing grows until the next stroke, Grow, or unpause.
        let paused = c.doc
        run(player, &now, frames: 4)
        XCTAssertTrue(c.doc === paused)
        // Redo brings the run back with its replay events.
        XCTAssertEqual(c.redo(), "Culture growth")
        XCTAssertEqual(grows(c).count, 1)
        XCTAssertGreaterThan(grows(c)[0].data?["steps"]?.numberValue ?? 0, 0)
        player.stop()
    }

    // TS 14 (speed) and stop(): stop commits the run; speed scales the ticks.
    func testStopCommitsTheRunAndSpeedScalesGrowth() throws {
        func ticks(speed: Double) throws -> (Int, PaintEditorController) {
            let c = try PaintEditorController(width: 140, height: 140)
            _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 12), points: pts([(30, 50), (30, 90)]))
            _ = try c.setCultureSpeed(speed)
            var now = 0.0
            let player = c.playCultures(now: now)
            run(player, &now, frames: 5)
            player.stop()
            return (c.getCultures().layers[0].tick, c)
        }
        let (slow, c) = try ticks(speed: 1)
        let (fast, _) = try ticks(speed: 2)
        // 5 frames of 0.1 s at 24 ticks/s: 12 ticks; twice as fast: 24.
        XCTAssertEqual(slow, 12)
        XCTAssertGreaterThanOrEqual(fast, 23)
        XCTAssertEqual(c.undoLabel, "Culture growth")
        XCTAssertEqual(grows(c).count, 1)
        XCTAssertEqual(grows(c)[0].data?["steps"]?.numberValue, 12)
    }

    // TS 16: a command during growth keeps the growth as its own undo step, with its replay events.
    func testCommandDuringGrowthKeepsTheGrowthAndItsEvents() throws {
        let c = try PaintEditorController(width: 140, height: 140)
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 5), points: pts([(30, 50), (30, 90)]))
        var now = 1000.0
        let player = c.playCultures(now: now)
        run(player, &now, frames: 6)
        _ = try c.addLayer(name: "Over")
        player.stop()
        let events = c.toJSON()["paintEvents"]?.arrayValue ?? []
        XCTAssertTrue(events.contains { $0.objectValue?["kind"]?.stringValue == "culture-grow" })
        XCTAssertNotEqual(c.undo(), "Culture growth")
        XCTAssertEqual(c.undo(), "Culture growth")
    }

    // TS 20: replays include pending growth; set_age and bake_age during growth keep it, and replay matches exactly.
    func testReplaysIncludePendingGrowthAndSetAgeKeepsIt() async throws {
        let c = try PaintEditorController(width: 96, height: 96)
        let layerId = c.doc.activeLayerId!
        _ = try c.paintStroke(PaintStrokeInit(color: "#dc2626", brushId: "ink-pen", brush: ["tip": ["size": 16, "hardness": 1]], seed: 11), points: pts([(60, 48), (70, 48)]))
        _ = try c.paintStroke(PaintStrokeInit(brushId: "rot", seed: 5), points: pts([(30, 40), (30, 56)]))
        _ = try c.growCultures(steps: 20)
        var now = 1000.0
        let player = c.playCultures(now: now)
        run(player, &now, frames: 6)
        let shown = c.doc
        let total = c.doc.strokes.count
        let live = try await c.renderXray(maxSide: 96)
        let replayed = try await c.renderXray(strokes: total, maxSide: 96)
        XCTAssertEqual(replayed.data, live.data)
        // The replay committed nothing.
        XCTAssertTrue(c.doc === shown)
        _ = try c.setAge(["years": .number(120), "varnish": .number(0.5)])
        run(player, &now, frames: 6)
        _ = try c.bakeAge()
        player.stop()
        XCTAssertEqual(grows(c).count, 3)
        let target = try c.createReplayTarget(scale: 1)
        try await c.replayPainting(into: target, scale: 1)
        XCTAssertEqual(maxDiff(c.getLayer(layerId)!.pixelSurface, target.getLayer(layerId)!.pixelSurface, 96, 96), 0)
        XCTAssertEqual(c.undo(), "Bake age")
        XCTAssertEqual(c.undo(), "Culture growth")
        XCTAssertEqual(c.undo(), "Culture growth")
        XCTAssertEqual(c.undo(), "Grow culture")
        XCTAssertEqual(c.redo(), "Grow culture")
        XCTAssertEqual(c.redo(), "Culture growth")
        XCTAssertEqual(c.redo(), "Culture growth")
        XCTAssertEqual(c.redo(), "Bake age")
    }

    // TS 22: a held layer (an animation still playing on it) waits, then growth resumes.
    func testHeldLayersWaitThenResume() throws {
        let c = try PaintEditorController(width: 96, height: 96)
        let layerId = c.doc.activeLayerId!
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 5), points: pts([(30, 48), (60, 48)]))
        var animating = true
        c.cultureGrowthHolds["test"] = { animating ? [layerId] : [] }
        let committed = c.getLayer(layerId)!.pixelSurface
        var now = 1000.0
        let player = c.playCultures(now: now)
        run(player, &now, frames: 4)
        XCTAssertTrue(c.getLayer(layerId)!.pixelSurface === committed)
        animating = false
        run(player, &now, frames: 4)
        XCTAssertFalse(c.getLayer(layerId)!.pixelSurface === committed)
        player.stop()
        XCTAssertEqual(grows(c).count, 1)
    }

    // TS 23: wet paint flowing on another layer replaces the document, but the run goes on as one step.
    func testWetFlowDuringGrowthKeepsOneRun() throws {
        let c = try PaintEditorController(width: 96, height: 96)
        let cultureLayer = c.doc.activeLayerId!
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 5), points: pts([(30, 30), (60, 30)]))
        let wetLayer = try c.addLayer(name: "Wash").id
        _ = try c.paintStroke(PaintStrokeInit(layerId: wetLayer, color: "#1d4ed8", brushId: "watercolor-round", seed: 2), points: pts([(20, 70), (76, 70)], pressure: 0.8))
        XCTAssertTrue(c.wet.isWet())
        var now = 1000.0
        let player = c.playCultures(now: now)
        for _ in 0..<6 {
            now += 100
            player.tick(now: now)
            _ = try c.advanceWet(steps: 2, seconds: nil)
        }
        let undoBefore = c.undoStack.count
        player.stop()
        XCTAssertEqual(c.undoStack.count, undoBefore + 1)
        XCTAssertEqual(c.undoLabel, "Culture growth")
        let ev = grows(c).filter { $0.layerId == cultureLayer }
        XCTAssertEqual(ev.count, 1)
        XCTAssertGreaterThan(ev.first?.data?["steps"]?.numberValue ?? 0, 6)
    }
}
