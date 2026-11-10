import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// The antimatter blast expansion animation (`marks.duration`, #732): view-only frames from the
/// stroke's heat field, played on the editor clock, matching `controller.ts`.
final class PaintBlastAnimationTests: XCTestCase {
    /// FNV-1a over every channel of `surface` in 0..<w × 0..<h, and the channel sum.
    private func hash(_ surface: TiledSurface, _ w: Int, _ h: Int) -> String {
        var hsh: UInt32 = 0x811c9dc5
        var sum = 0
        for y in 0..<h {
            for x in 0..<w {
                for v in readPixel(surface, x, y) {
                    hsh = (hsh ^ UInt32(v)) &* 0x01000193
                    sum += v
                }
            }
        }
        return "\(String(hsh, radix: 16)) \(sum)"
    }

    private func layerSurface(_ c: PaintEditorController, _ id: String) -> TiledSurface {
        findLayer(c.doc.layers, id)!.layer.pixelSurface
    }

    /// A red canvas and the stroke of `paint-antimatter.test.ts` test 13 (duration 0.8 s).
    private func blastOnRed() throws -> (c: PaintEditorController, layerId: String) {
        let c = try PaintEditorController(width: 128, height: 128, color: "#ff3864")
        let layerId = c.doc.activeLayerId!
        _ = try c.fillLayer(layerId: layerId, color: "#ff0000")
        let res = try c.paintStroke(
            PaintStrokeInit(brushId: "antimatter", brush: ["antimatter": ["duration": 0.8, "sparks": 0.6]], seed: 55),
            points: [PenPoint(x: 64, y: 64, pressure: 1)]
        )
        XCTAssertEqual(res.antimatter?.blasts, 1)
        return (c, layerId)
    }

    func testFramesMatchTheTypeScriptCoreAndEndOnTheCommittedPixels() throws {
        let (c, layerId) = try blastOnRed()
        let committedDoc = c.doc
        let committedComposite = c.compositePixels().data
        // Recorded from the TS core (`playEffects` on a clock at 1000 ms, the stroke above, then `blastLayers` at each time).
        XCTAssertEqual(hash(layerSurface(c, layerId), 128, 128), "f4cf5b9f 8337914")
        XCTAssertTrue(c.hasActiveBlastAnimation)
        XCTAssertTrue(c.blastAnimatingLayerIds.isEmpty, "no frame until the clock ticks")
        for (t, expected) in [(1000.0, "60c93364 8462861"), (1100, "8e379c03 8455072"), (1400, "97a044f 8364558")] {
            XCTAssertTrue(c.tickBlastAnimation(t))
            let frame = try XCTUnwrap(c.blastAnimation.layers[layerId], "frame at \(t)")
            XCTAssertEqual(hash(frame.surface, 128, 128), expected, "frame at \(t) ms")
            XCTAssertTrue(c.doc === committedDoc, "the animation never changes the document")
        }
        XCTAssertNotEqual(c.compositePixels().data, committedComposite, "the view shows the frame")
        // Past the duration: the animation ends on exactly the committed pixels.
        XCTAssertTrue(c.tickBlastAnimation(2000))
        XCTAssertFalse(c.hasActiveBlastAnimation)
        XCTAssertFalse(c.tickBlastAnimation(2100))
        XCTAssertEqual(c.compositePixels().data, committedComposite)
        XCTAssertEqual(hash(layerSurface(c, layerId), 128, 128), "f4cf5b9f 8337914")
        XCTAssertTrue(c.doc === committedDoc)
    }

    func testTheDriverFramesStartSmallAndEndOnLayerOutputs() throws {
        let (c, layerId) = try blastOnRed()
        let driver = try XCTUnwrap(c.blastAnimation.active?.driver)
        driver.rebaseTime(0)
        XCTAssertEqual(driver.blasts.map(\.t).min(), 0)
        let start = driver.renderAtTime(0)
        let mid = driver.renderAtTime(400)
        let end = driver.renderAtTime(800)
        XCTAssertTrue(start.active)
        XCTAssertTrue(mid.active)
        XCTAssertFalse(end.active)
        XCTAssertTrue(end.outputs.first { $0.id == layerId }!.surface === layerSurface(c, layerId))
        XCTAssertNotEqual(hash(start.outputs[0].surface, 128, 128), hash(mid.outputs[0].surface, 128, 128))
        // Before a blast's birth nothing of it shows: the frame is the layer before the stroke.
        let before = driver.renderAtTime(-100)
        XCTAssertTrue(before.active)
        XCTAssertEqual(hash(before.outputs[0].surface, 128, 128), hash(driver.initValues.targets[0].base, 128, 128))
    }

    func testRebasesAgentTimesOntoTheClock() throws {
        let c = try PaintEditorController(width: 128, height: 128, color: "#ff3864")
        _ = try c.fillLayer(color: "#ff0000")
        let final = try PaintEditorController(width: 128, height: 128, color: "#ff3864")
        _ = try final.fillLayer(color: "#ff0000")
        let tap = [PenPoint(x: 64, y: 64, pressure: 1, t: 0)]
        _ = try final.paintStroke(PaintStrokeInit(brushId: "antimatter", brush: ["antimatter": ["duration": 0]], seed: 5), points: tap)
        XCTAssertFalse(final.hasActiveBlastAnimation, "duration 0 shows the blast at once")
        _ = try c.paintStroke(PaintStrokeInit(brushId: "antimatter", brush: ["antimatter": ["duration": 0.8]], seed: 5), points: tap)
        XCTAssertEqual(c.compositePixels().data, final.compositePixels().data, "headless (no clock): the committed painting")
        // Points timed from 0, a clock at a million ms: the blast still grows from its first frame.
        c.tickBlastAnimation(1_000_000)
        c.tickBlastAnimation(1_000_050)
        XCTAssertNotEqual(c.compositePixels().data, final.compositePixels().data)
        c.tickBlastAnimation(1_002_050)
        XCTAssertEqual(c.compositePixels().data, final.compositePixels().data)
    }

    func testUndoRedoAndNewStrokesClearTheAnimation() throws {
        var (c, _) = try blastOnRed()
        c.tickBlastAnimation(1000)
        XCTAssertFalse(c.blastAnimatingLayerIds.isEmpty)
        _ = c.undo()
        XCTAssertFalse(c.hasActiveBlastAnimation)
        XCTAssertTrue(c.blastAnimatingLayerIds.isEmpty)
        _ = c.redo()
        XCTAssertFalse(c.hasActiveBlastAnimation, "redo shows the committed blast; it does not replay the animation")
        let redone = c.compositePixels().data
        XCTAssertFalse(c.tickBlastAnimation(1100))
        XCTAssertEqual(c.compositePixels().data, redone)

        (c, _) = try blastOnRed()
        c.tickBlastAnimation(1000)
        _ = try c.paintStroke(PaintStrokeInit(color: "#0055ff", brushId: "ink-pen", seed: 1), points: [PenPoint(x: 10, y: 10), PenPoint(x: 30, y: 10)])
        XCTAssertFalse(c.hasActiveBlastAnimation)

        (c, _) = try blastOnRed()
        c.tickBlastAnimation(1000)
        let live = try c.beginStroke(PaintStrokeInit(seed: 2))
        XCTAssertFalse(c.hasActiveBlastAnimation)
        live.cancel()

        // A live antimatter stroke animates when it ends, and waits while another stroke is open.
        let l = try PaintEditorController(width: 128, height: 128, color: "#ff3864")
        _ = try l.fillLayer(color: "#ff0000")
        let am = try l.beginStroke(PaintStrokeInit(brushId: "antimatter", brush: ["antimatter": ["duration": 0.8]], seed: 9))
        am.push([PenPoint(x: 64, y: 64, pressure: 1, t: 5)])
        _ = try am.end()
        XCTAssertTrue(l.hasActiveBlastAnimation)
        XCTAssertTrue(l.tickBlastAnimation(0))

        // A document change the animation did not make (here a fill) ends it at the next tick.
        _ = try l.fillLayer(color: "#00ff00")
        XCTAssertFalse(l.tickBlastAnimation(100))
        XCTAssertFalse(l.hasActiveBlastAnimation)
    }

    func testFramesKeepLightAndReliefFromBeforeTheStroke() throws {
        let hardInk: JSONObject = ["tip": ["size": 20, "hardness": 1], "dynamics": ["smoothing": 0, "pressureSize": false, "pressureOpacity": false]]
        let smallBlast: JSONObject = ["tip": ["size": 12], "antimatter": ["blastRadius": 2, "sparks": 0, "crater": 0, "duration": 0.8]]
        let c = try PaintEditorController(width: 128, height: 128, color: "#ff3864")
        let layerId = c.doc.activeLayerId!
        _ = try c.paintStroke(PaintStrokeInit(color: "#ff00ff", brushId: "neon-marker", brush: ["tip": ["size": 16]]), points: [PenPoint(x: 16, y: 20, pressure: 1), PenPoint(x: 44, y: 20, pressure: 1)])
        _ = try c.paintStroke(PaintStrokeInit(color: "#0055ff", brushId: "ink-pen", brush: hardInk), points: [PenPoint(x: 96, y: 100), PenPoint(x: 104, y: 100)])
        let light = try XCTUnwrap(c.doc.light?.get(layerId))
        // Relief under the light paint (the Swift editor does not paint impasto yet): the light channel as height.
        var relief = OrderedMap<String, ThickChannels>()
        relief.set(layerId, ThickChannels(height: light, material: emptySurface(4), film: emptySurface(4)))
        c.commit("Relief", c.doc.with { $0.thick = relief })
        let thick = try XCTUnwrap(c.doc.thick?.get(layerId))
        let before = c.compositePixels().data
        let res = try c.paintStroke(PaintStrokeInit(brushId: "antimatter", brush: smallBlast, seed: 3), points: [PenPoint(x: 100, y: 100, pressure: 1)])
        XCTAssertEqual(res.antimatter?.blasts, 1)
        c.tickBlastAnimation(1000)
        c.tickBlastAnimation(1300)
        XCTAssertFalse(c.blastAnimatingLayerIds.isEmpty)
        // A frame whose output leaves light / relief alone (nil) shows them as they were before the stroke.
        XCTAssertTrue(c.blastViewLight(layerId, nil) === light)
        XCTAssertTrue(c.blastViewThick(layerId, nil)?.height === thick.height)
        let during = c.compositePixels().data
        let w = 128
        func at(_ img: [UInt8], _ x: Int, _ y: Int) -> [UInt8] { Array(img[((y * w + x) * 4)..<((y * w + x) * 4 + 4)]) }
        XCTAssertNotEqual(at(during, 100, 100), at(before, 100, 100))
        // The glow, spill and relief far from the blast are drawn as before.
        for (x, y) in [(30, 20), (30, 30), (10, 20), (20, 24)] {
            XCTAssertEqual(at(during, x, y), at(before, x, y), "(\(x), \(y))")
        }
    }
}
