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
    }
}
