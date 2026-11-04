import XCTest
@testable import PixeratePaint
import PixerateCore
import PixerateRaster

/// Metal shading of wet paint against the CPU's (`WetMetal.swift`), as `tests/paint-wet-gpu.test.ts` does for WebGPU.
final class WetMetalTests: XCTestCase {
    private let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [247, 243, 234], heightAt: { x, y in 0.5 + 0.25 * sin(x * 0.7) * cos(y * 0.9) })

    private func engine() throws -> WetMetalEngine {
        let (engine, support) = WetMetalEngine.create()
        guard let engine else { throw XCTSkip(support.reason ?? "no Metal") }
        return engine
    }

    /// Coverage of a disc (1 inside, a soft pixel edge).
    private func disc(_ cx: Double, _ cy: Double, _ r: Double) -> (rect: RasterRect, cov: [Float]) {
        let x0 = Int(cx - r) - 1, y0 = Int(cy - r) - 1, side = Int(r * 2) + 3
        var cov = [Float](repeating: 0, count: side * side)
        for y in 0..<side {
            for x in 0..<side {
                let d = hypot(Double(x0 + x) + 0.5 - cx, Double(y0 + y) + 0.5 - cy)
                cov[y * side + x] = Float(Swift.max(0, Swift.min(1, r - d + 0.5)))
            }
        }
        return (RasterRect(x: x0, y: y0, width: side, height: side), cov)
    }

    /// A world with paint, light, a base tile under it and partial edge tiles, stepped a little (debug builds step slowly).
    private func scene(_ gpu: WetMetalEngine?) throws -> WetWorld {
        let w = try WetWorld(width: 600, height: 420, paper: paper)
        let base = solidSurface(4, RasterRect(x: 200, y: 180, width: 120, height: 60), 0x80_30_60_c0)
        try w.ensureLane("a", base: base)
        _ = w.setTilt(WetTilt(angle: 30, direction: 20))
        if let gpu {
            w.attachGpu(gpu)
            w.gpuMinTiles = 1
        }
        let blue = pigmentOf([0.15, 0.3, 0.75], 0).map { $0 * 0.06 }
        let red = pigmentOf([0.8, 0.2, 0.15], 0.2).map { $0 * 0.05 }
        let a = disc(250, 250, 45)
        try w.paint("a", a.rect, a.cov, water: 0.4, pigment: blue)
        w.step(1)
        let b = disc(300, 230, 25)
        try w.paint("a", b.rect, b.cov, water: 0.4, pigment: red, light: 0.6)
        try w.push("a", b.rect, b.cov, ux: 0.04, uy: 0.01)
        let c = disc(560, 400, 30)
        try w.paint("a", c.rect, c.cov, water: 0.5, pigment: blue)
        w.step(1)
        return w
    }

    private func pixels(_ s: TiledSurface, _ tk: TileKey) -> [UInt8] {
        s.tiles.get(tk)?.data ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
    }

    func testMetalShadingStaysWithinOneLevelOfTheCpu() throws {
        let gpu = try engine()
        let cpu = try scene(nil)
        let shaded = try scene(gpu)
        let want = try cpu.display("a").surface
        let got = try shaded.displayGpu("a")
        XCTAssertTrue(got.gpu, "the GPU shaded")
        XCTAssertTrue(shaded.gpuActive)
        XCTAssertGreaterThan(gpu.tilesShaded, 3)
        XCTAssertEqual(got.pending, 0)
        let keys = Set(Array(want.tiles.keys) + Array(got.surface.tiles.keys))
        XCTAssertGreaterThan(keys.count, 3)
        var worst = 0.0, overOne = 0, compared = 0, painted = 0
        for tk in keys {
            let a = pixels(want, tk), b = pixels(got.surface, tk)
            for k in stride(from: 0, to: a.count, by: 4) {
                if a[k + 3] != 0 { painted += 1 }
                for ch in 0..<3 {
                    // What shows: the layer over the paper (straight colour at a tiny alpha magnifies one-level differences).
                    func over(_ p: [UInt8]) -> Double { Double(p[k + 3]) / 255 * Double(p[k + ch]) + (1 - Double(p[k + 3]) / 255) * Double(paper.color[ch]) }
                    let d = abs(over(a) - over(b))
                    worst = Swift.max(worst, d)
                    if d > 1 { overOne += 1 }
                    compared += 1
                }
            }
        }
        XCTAssertGreaterThan(painted, 5000)
        XCTAssertLessThanOrEqual(worst, 2)
        XCTAssertLessThan(Double(overOne) / Double(compared), 1e-4)
    }

    func testGpuShadingNeverChangesTheSimulation() throws {
        let gpu = try engine()
        let cpu = try scene(nil)
        let shaded = try scene(gpu)
        _ = try shaded.displayGpu("a")
        shaded.step(1)
        _ = try shaded.displayGpu("a")
        cpu.step(1)
        XCTAssertEqual(cpu.clock, shaded.clock)
        // Saving reads the bake, which is the CPU's alone: identical bytes.
        let a = try cpu.bakedSurface("a"), b = try shaded.bakedSurface("a")
        XCTAssertEqual(Set(a.tiles.keys), Set(b.tiles.keys))
        for tk in a.tiles.keys { XCTAssertEqual(pixels(a, tk), pixels(b, tk)) }
    }

    func testGpuShadingWaitsForEnoughTilesAndStopsBelowHalf() throws {
        let gpu = try engine()
        let w = try WetWorld(width: 1024, height: 256, paper: paper)
        try w.ensureLane("a")
        w.attachGpu(gpu)
        w.gpuMinTiles = 4
        let one = disc(128, 128, 40)
        try w.paint("a", one.rect, one.cov, water: 0.4, pigment: pigmentOf([0.2, 0.4, 0.6], 0))
        XCTAssertFalse(try w.displayGpu("a").gpu, "one tile is below gpuMinTiles: the CPU shades")
        try w.paint("a", RasterRect(x: 0, y: 0, width: 1024, height: 256), nil, water: 0.3, pigment: nil)
        XCTAssertTrue(try w.displayGpu("a").gpu)
        XCTAssertTrue(w.gpuActive)
        _ = try w.dry("a", RasterRect(x: 256, y: 0, width: 768, height: 256))
        XCTAssertEqual(w.activeTiles(), 1)
        XCTAssertFalse(try w.displayGpu("a").gpu, "below half of gpuMinTiles: back to the CPU")
        XCTAssertFalse(w.gpuActive)
        XCTAssertNil(w.gpuError)
    }

    func testTheEditorReportsAndUsesTheGpuEngine() throws {
        guard WetMetalEngine.shared().engine != nil else { throw XCTSkip(WetMetalEngine.shared().support.reason ?? "no Metal") }
        let c = try PaintEditorController(width: 300, height: 200)
        var info = try c.setWetEngine(gpu: "auto", minTiles: 2)
        XCTAssertEqual(info.state, "not-started")
        XCTAssertEqual(info.reason, "Starts with the first wet stroke.")
        _ = try c.wetPaper(rect: ["x": 10, "y": 10, "width": 60, "height": 40], amount: 0.5)
        info = c.wet.engineInfo()
        XCTAssertEqual(info.state, "standby")
        XCTAssertEqual(info.reason, "The GPU takes over at 2 wet tiles (256 px).")
        XCTAssertNotNil(info.adapter)
        XCTAssertEqual(info.maxTiles, MAX_WET_SLOTS)
        _ = try c.wetPaper(amount: 0.5)
        _ = try c.advanceWet(steps: 1, seconds: nil)
        info = c.wet.engineInfo()
        XCTAssertEqual(info.state, "active")
        XCTAssertNil(info.reason)
        XCTAssertEqual(info.activeTiles, 2)
        info = try c.setWetEngine(gpu: "off", minTiles: nil)
        XCTAssertEqual(info.state, "off")
        XCTAssertEqual(info.reason, "Forced to the CPU.")
        XCTAssertNil(info.adapter)
        _ = try c.advanceWet(steps: 1, seconds: nil)
        XCTAssertFalse(c.wet.world!.gpuActive)
    }
}
