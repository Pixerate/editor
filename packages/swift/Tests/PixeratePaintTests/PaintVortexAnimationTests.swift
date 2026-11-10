import Foundation
import XCTest
import PixerateCore
@testable import PixeratePaint
import PixerateRaster

/// The vortex winding animation (`marks.duration`, #733): keyframes of the integration, their
/// blending, and the controller's view-only playback, checked against the TS core's vectors
/// (`packages/core/tests/fixtures/swift-vortex-vectors.json`, written by `swift-paint-vortex-vectors.test.ts`).
final class PaintVortexAnimationTests: XCTestCase {
    private func vectors() throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../core/tests/fixtures/swift-vortex-vectors.json")
        return try JSONValue.parse(Data(contentsOf: url))
    }

    private func floats(_ v: JSONValue?) -> [Float] {
        guard case .string(let s)? = v, let data = Data(base64Encoded: s) else { return [] }
        return data.withUnsafeBytes { raw in
            (0..<(data.count / 4)).map { Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))) }
        }
    }

    private func bytes(_ v: JSONValue?) -> [UInt8] {
        guard case .string(let s)? = v, let data = Data(base64Encoded: s) else { return [] }
        return [UInt8](data)
    }

    private func number(_ v: JSONValue?) -> Double {
        if case .number(let n)? = v { return n }
        return .nan
    }

    private func rigidSpin(cols: Int, step: Int, centre: Double) -> VelocityGridField {
        let r0 = hypot(centre, centre)
        var vx = [Float](repeating: 0, count: cols * cols)
        var vy = [Float](repeating: 0, count: cols * cols)
        for r in 0..<cols {
            for c in 0..<cols {
                vx[r * cols + c] = Float(-(Double(r * step) - centre) / r0)
                vy[r * cols + c] = Float((Double(c * step) - centre) / r0)
            }
        }
        let side = (cols - 1) * step
        return VelocityGridField(rect: RasterRect(x: 0, y: 0, width: side, height: side), step: step, cols: cols, rows: cols, vx: vx, vy: vy, maxSpeed: 1)
    }

    private func assertField(_ got: DisplacementField, _ want: JSONValue?, _ msg: String, file: StaticString = #filePath, line: UInt = #line) {
        guard case .object(let o)? = want else { return XCTFail("\(msg): no vector", file: file, line: line) }
        for (name, values, expected) in [("dx", got.dx, floats(o["dx"])), ("dy", got.dy, floats(o["dy"]))] {
            XCTAssertEqual(values.count, expected.count, "\(msg) \(name) count", file: file, line: line)
            var worst: Float = 0
            for i in 0..<Swift.min(values.count, expected.count) { worst = Swift.max(worst, abs(values[i] - expected[i])) }
            XCTAssertLessThanOrEqual(worst, 1e-5, "\(msg) \(name) differs from TS by \(worst) px", file: file, line: line)
        }
        XCTAssertEqual(got.maxDisplacement, number(o["maxDisplacement"]), accuracy: 1e-4, "\(msg) maxDisplacement", file: file, line: line)
    }

    // MARK: - Keyframes

    func testKeyframesWindAlongArcsAtTheSameRadius() {
        // As `paint-vortex.test.ts`: halfway through, paint is halfway round, not cut across the chord.
        let vel = rigidSpin(cols: 101, step: 4, centre: 200)
        let r0 = hypot(200.0, 200.0)
        let (field, frames) = integrateVelocityFieldFrames(vel, 3 * r0, VORTEX_KEYFRAMES)
        XCTAssertEqual(frames.count, VORTEX_KEYFRAMES)
        XCTAssertEqual(frames.last!.dx, field.dx)
        XCTAssertNil(vortexWindingField(frames, 0))
        XCTAssertEqual(vortexWindingField(frames, 1)!.dx, field.dx)
        func src(_ f: DisplacementField) -> (r: Double, a: Double) {
            let d = sampleDisplacement(f, 300, 200)
            return (hypot(100 + d.dx, d.dy), -atan2(d.dy, 100 + d.dx))
        }
        let mid = src(vortexWindingField(frames, 0.5)!)
        XCTAssertGreaterThan(mid.r, 95)
        XCTAssertGreaterThan(mid.a, 1.4)
        XCTAssertLessThan(mid.a, 1.6)
        let d = sampleDisplacement(field, 300, 200)
        XCTAssertLessThan(hypot(100 + d.dx * 0.5, d.dy * 0.5), 20)
    }

    func testKeyframesLeaveTheFinalFieldUnchanged() {
        // Committed pixels (and conformance) depend on the final field: keeping keyframes must not move it.
        let vel = rigidSpin(cols: 41, step: 4, centre: 80)
        let plain = integrateVelocityField(vel, 150)
        let (field, frames) = integrateVelocityFieldFrames(vel, 150, VORTEX_KEYFRAMES)
        XCTAssertEqual(field.dx, plain.dx)
        XCTAssertEqual(field.dy, plain.dy)
        XCTAssertEqual(field.maxDisplacement, plain.maxDisplacement)
        XCTAssertEqual(frames.count, VORTEX_KEYFRAMES)
        XCTAssertTrue(integrateVelocityFieldFrames(vel, 150, 0).frames.isEmpty)
        XCTAssertTrue(integrateVelocityFieldFrames(vel, 0, VORTEX_KEYFRAMES).frames.isEmpty)
    }

    func testKeyframesAndWindingMatchTheTypeScriptCore() throws {
        guard case .object(let root) = try vectors(), case .object(let v)? = root["frames"] else { return XCTFail("no frames vectors") }
        let vel = rigidSpin(cols: 11, step: 4, centre: 20)
        let (field, frames) = integrateVelocityFieldFrames(vel, number(v["travel"]), Int(number(v["keyframes"])))
        guard case .array(let want)? = v["frames"] else { return XCTFail("no frames") }
        XCTAssertEqual(frames.count, want.count)
        for (i, f) in frames.enumerated() where i < want.count { assertField(f, want[i], "frame \(i)") }
        assertField(field, v["field"], "field")
        guard case .array(let winding)? = v["winding"] else { return XCTFail("no winding") }
        for w in winding {
            guard case .object(let o) = w else { continue }
            let t = number(o["t"])
            guard let got = vortexWindingField(frames, t) else { XCTFail("no winding field at \(t)"); continue }
            assertField(got, w, "winding at t = \(t)")
        }
    }

    // MARK: - Controller playback

    private func editorWithInk(size: Double = 64) throws -> (PaintEditorController, String) {
        let c = try PaintEditorController(width: size, height: size)
        _ = try c.paintStroke(PaintStrokeInit(color: "#dc2626", brushId: "ink-pen", brush: ["tip": ["size": 16, "opacity": 1]], seed: 3), points: [PenPoint(x: 14, y: 32), PenPoint(x: 50, y: 32)])
        return (c, c.doc.activeLayerId!)
    }

    private func vortex(_ c: PaintEditorController, duration: Double) throws -> PaintStrokeResult {
        try c.paintStroke(PaintStrokeInit(brushId: "vortex", brush: ["marks": ["kind": "vortex", "duration": .number(duration), "turns": 1.5, "reach": 2]], seed: 5), points: [PenPoint(x: 32, y: 32, pressure: 1)])
    }

    private func surface(_ c: PaintEditorController, _ id: String) -> TiledSurface {
        findLayer(c.doc.layers, id)!.layer.pixelSurface
    }

    private func viewComposite(_ c: PaintEditorController) -> [UInt8] {
        createPaintCompositor().composite(c.renderLayers(view: true), RasterRect(x: 0, y: 0, width: c.doc.canvas.width, height: c.doc.canvas.height), c.sources())
    }

    func testAMidAnimationFrameMatchesTheTypeScriptCore() throws {
        guard case .object(let root) = try vectors(), case .object(let v)? = root["controller"] else { return XCTFail("no controller vectors") }
        let (c, id) = try editorWithInk()
        _ = try vortex(c, duration: 1)
        let rect = RasterRect(x: 0, y: 0, width: 64, height: 64)
        XCTAssertEqual(readRegion(surface(c, id), rect), bytes(v["committed"]), "the committed vortex stroke matches TS")
        // Matches byte for byte today; one level of slack for libm differences in the Float maths.
        c.stepVortexAnimations(1000)
        c.stepVortexAnimations(1000 + number(v["elapsedMs"]))
        let mid = readRegion(try XCTUnwrap(c.vortexAnimationSurface(id)), rect)
        let want = bytes(v["mid"])
        XCTAssertEqual(mid.count, want.count)
        var worst = 0, differing = 0
        for i in 0..<Swift.min(mid.count, want.count) {
            let d = abs(Int(mid[i]) - Int(want[i]))
            worst = Swift.max(worst, d)
            if d > 0 { differing += 1 }
        }
        XCTAssertLessThanOrEqual(worst, 1, "mid-animation frame differs from TS by \(worst) levels in \(differing) bytes")
    }

    func testTheAnimationIsViewOnlyAndEndsOnTheCommittedPixels() throws {
        let (c, id) = try editorWithInk()
        let before = surface(c, id)
        let (c0, id0) = try editorWithInk()
        _ = try vortex(c0, duration: 0)
        XCTAssertFalse(c0.hasActiveVortexAnimations(), "duration 0 shows the final state at once")

        let r = try vortex(c, duration: 1)
        XCTAssertNotNil(r.strokeId)
        let committed = surface(c, id)
        XCTAssertFalse(committed === before)
        // The duration changes nothing in the document: the committed pixels are those of duration 0.
        XCTAssertEqual(readRegion(committed, RasterRect(x: 0, y: 0, width: 64, height: 64)), readRegion(surface(c0, id0), RasterRect(x: 0, y: 0, width: 64, height: 64)))
        XCTAssertTrue(c.hasActiveVortexAnimations())
        XCTAssertEqual(c.vortexAnimatingLayerIds(), [id])
        let committedPixels = c.compositePixels().data

        // No clock yet: the view shows the committed pixels.
        XCTAssertEqual(viewComposite(c), c.compositePixels(wet: "display").data)
        c.stepVortexAnimations(1000)
        XCTAssertTrue(c.vortexAnimationSurface(id) === c.vortexAnimationSurface(id))
        XCTAssertEqual(readRegion(c.vortexAnimationSurface(id)!, RasterRect(x: 0, y: 0, width: 64, height: 64)), readRegion(before, RasterRect(x: 0, y: 0, width: 64, height: 64)), "t = 0 is the layer before the warp")
        XCTAssertTrue(c.stepVortexAnimations(1500))
        let mid = c.vortexAnimationSurface(id)!
        XCTAssertFalse(mid === committed)
        XCTAssertNotEqual(readRegion(mid, RasterRect(x: 0, y: 0, width: 64, height: 64)), readRegion(committed, RasterRect(x: 0, y: 0, width: 64, height: 64)))
        XCTAssertNotEqual(viewComposite(c), c.compositePixels(wet: "display").data, "the view winds")
        // Export and saving never see the frame.
        XCTAssertEqual(c.compositePixels().data, committedPixels)

        XCTAssertTrue(c.stepVortexAnimations(2000))
        XCTAssertFalse(c.hasActiveVortexAnimations())
        XCTAssertNil(c.vortexAnimationSurface(id))
        XCTAssertEqual(viewComposite(c), c.compositePixels(wet: "display").data, "the last frame is the committed pixels")
        XCTAssertFalse(c.stepVortexAnimations(2100))
    }

    func testUndoRedoAndNewStrokesDropTheAnimation() throws {
        let (c, id) = try editorWithInk()
        c.stepVortexAnimations(0)
        _ = try vortex(c, duration: 2)
        c.stepVortexAnimations(10)
        XCTAssertTrue(c.hasActiveVortexAnimations())
        _ = c.undo()
        XCTAssertFalse(c.hasActiveVortexAnimations(), "undo changes the layer's surface")
        XCTAssertEqual(viewComposite(c), c.compositePixels(wet: "display").data)
        _ = c.redo()
        XCTAssertFalse(c.hasActiveVortexAnimations(), "redo does not replay the winding")

        _ = try vortex(c, duration: 2)
        XCTAssertTrue(c.hasActiveVortexAnimations())
        _ = try c.paintStroke(PaintStrokeInit(brushId: "ink-pen", seed: 9), points: [PenPoint(x: 10, y: 10), PenPoint(x: 20, y: 12)])
        XCTAssertFalse(c.hasActiveVortexAnimations(), "a new stroke on the layer ends it")
        XCTAssertNil(c.vortexAnimationSurface(id))
    }

    func testLiveAndPathStrokesQueueTheAnimation() throws {
        let (c, id) = try editorWithInk()
        let live = try c.beginStroke(PaintStrokeInit(brushId: "vortex", brush: ["marks": ["kind": "vortex", "duration": 1]], seed: 2))
        live.push([PenPoint(x: 32, y: 32, pressure: 1)])
        _ = try live.end()
        XCTAssertEqual(c.vortexAnimatingLayerIds(), [id])

        let (p, pid) = try editorWithInk()
        _ = try p.strokePath("M 20 32 L 44 32", spacing: nil, pressure: nil, PaintStrokeInit(brushId: "vortex", brush: ["marks": ["kind": "vortex", "duration": 1]], seed: 2))
        XCTAssertEqual(p.vortexAnimatingLayerIds(), [pid])
    }
}
