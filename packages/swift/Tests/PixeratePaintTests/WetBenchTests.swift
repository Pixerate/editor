import Foundation
import XCTest
@testable import PixeratePaint
import PixerateRaster

/**
 * Wet-media throughput (one thread): `WET_BENCH=1 swift test -c release --filter WetBenchTests`.
 * Compare with `tests/paint-wet.bench.test.ts` in the core. M4 Pro, fully wet 2048² canvas (64
 * tiles): a step takes 92 ms on one thread (1.4 ms per tile; the scalar kernel took 3.5) and 15 ms
 * on 14; the CPU shades at 1.9 ms per tile (122 ms); Metal shades all 64 tiles, upload and
 * read-back included, in 9 ms.
 */
final class WetBenchTests: XCTestCase {
    func testThroughput() throws {
        guard ProcessInfo.processInfo.environment["WET_BENCH"] != nil else { throw XCTSkip("Set WET_BENCH=1 (and -c release) to run the benchmark.") }
        let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [250, 248, 240], heightAt: { x, y in 0.5 + 0.25 * sin(x * 0.7) * cos(y * 0.9) })
        func ms(_ body: () throws -> Void) rethrows -> Double {
            let t = Date()
            try body()
            return Date().timeIntervalSince(t) * 1000
        }
        for side in [1024, 2048] {
            let cpu = try WetWorld(width: side, height: side, paper: paper)
            let gpu = try WetWorld(width: side, height: side, paper: paper)
            for w in [cpu, gpu] {
                try w.ensureLane("a")
                try w.paint("a", RasterRect(x: 0, y: 0, width: side, height: side), nil, water: 0.8, pigment: pigmentOf([0.2, 0.4, 0.7], 0.1).map { $0 * 0.05 })
            }
            let engine = WetMetalEngine.shared().engine
            if let engine {
                gpu.attachGpu(engine)
                gpu.gpuMinTiles = 1
            }
            let tiles = cpu.activeTiles()
            cpu.threads = 1
            let oneThread = ms { cpu.step(2) } / 2
            cpu.threads = ProcessInfo.processInfo.activeProcessorCount
            let step = ms { cpu.step(4) } / 4
            let shadeCpu = try ms { _ = try cpu.display("a") }
            gpu.step(4)
            _ = try gpu.displayGpu("a")
            gpu.step(1)
            let shadeGpu = try ms { _ = try gpu.displayGpu("a") }
            print(String(format: "wet %d²: %d tiles, one thread %.1f ms a step (%.2f ms/tile), %d threads %.1f ms (%.2f ms/tile), CPU shading %.1f ms (%.2f ms/tile), Metal shading %@", side, tiles, oneThread, oneThread / Double(tiles), cpu.threads, step, step / Double(tiles), shadeCpu, shadeCpu / Double(tiles), engine == nil ? "unavailable" : String(format: "%.1f ms", shadeGpu)))
        }

        // Live wet stroke + compositor throughput on a 2048×1536 canvas.
        let c = try PaintEditorController(width: 2048, height: 1536, brushId: "watercolor-round", color: "#2255aa")
        let compositor = createPaintCompositor()
        func drawChanged() -> Int {
            var count = 0
            c.compositeTiles(using: compositor) { _, _, _, changed in if changed { count += 1 } }
            return count
        }
        _ = drawChanged()
        // Pre-wet a wash across several tiles so there are ~16 active tiles on the canvas.
        _ = try c.paintStroke(PaintStrokeInit(seed: 1), points: [PenPoint(x: 200, y: 200, pressure: 0.8), PenPoint(x: 900, y: 700, pressure: 0.8), PenPoint(x: 1500, y: 1100, pressure: 0.8)])
        _ = drawChanged()
        var strokeInit = PaintStrokeInit(seed: 2)
        strokeInit.start = Point2(x: 300, y: 300)
        let live = try c.beginStroke(strokeInit)
        var pushMs = 0.0
        var tickMs = 0.0
        var pushTiles = 0
        var tickTiles = 0
        var clockNow = 1000.0
        _ = c.tickWet(clockNow)
        for i in 0..<40 {
            let t = Double(i) / 39.0
            let pt = PenPoint(x: 300 + t * 1200, y: 300 + sin(t * 6) * 200 + t * 600, pressure: 0.7)
            pushMs += ms {
                live.push([pt])
                pushTiles += drawChanged()
            }
            if i % 2 == 1 {
                clockNow += 16.67
                tickMs += ms {
                    _ = c.tickWet(clockNow)
                    tickTiles += drawChanged()
                }
            }
        }
        try live.end()
        print(String(format: "live wet stroke (40 moves, 20 ticks, %d active tiles): push total %.1f ms (%.2f ms/move, %d tiles composited), tick total %.1f ms (%.2f ms/tick, %d tiles composited)", c.wet.world?.activeTiles() ?? 0, pushMs, pushMs / 40, pushTiles, tickMs, tickMs / 20, tickTiles))
    }
}
