import Foundation
import XCTest
@testable import PixeratePaint
import PixerateRaster

/**
 * Frame cost of specialty paints after a stroke (#533):
 * `SPECIALTY_BENCH=1 swift test -c release --filter SpecialtyPaintBenchTests`.
 *
 * On a 2048 × 1536 canvas it paints one long stroke with each brush, then runs the frames an
 * editor view runs: `tickWet`, the vortex and blast animations, the culture player, and the
 * view's `compositeTiles`. For each brush it prints the mean time of a frame's tick and of its
 * composite, the share of the canvas the tick reported dirty (100 % for an `emit(nil)`), the
 * tiles the view recomposited, and two hashes of what the view showed, which must not change when
 * the engine gets faster: after the last frame, and once every wet tile is shaded (frames shade at
 * most `DISPLAY_TILES_PER_TICK` stale tiles, so the last frame may show some a few steps late).
 *
 * `SPECIALTY_BENCH_BRUSHES=a,b` picks the brushes, `SPECIALTY_BENCH_FRAMES` the frames (default
 * 90), `SPECIALTY_BENCH_GPU=off` keeps Metal out of the shading.
 */
final class SpecialtyPaintBenchTests: XCTestCase {
    static let defaultBrushes = ["turing-wash", "coral-ink", "ghost-gouache", "glow-wash", "mycelial-ink"]

    struct Result {
        var brush: String
        var strokeMs = 0.0
        var tickMs = 0.0
        var compositeMs = 0.0
        var worstMs = 0.0
        var dirtyShare = 0.0
        var tiles = 0.0
        var steps = 0
        var activeTiles = 0
        var hash: UInt64 = 0
        var settledHash: UInt64 = 0
    }

    private func ms(_ body: () throws -> Void) rethrows -> Double {
        let t = DispatchTime.now().uptimeNanoseconds
        try body()
        return Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6
    }

    /// The share of the canvas (0..1) the changes after `since` cover, by 256 px tile.
    private func dirtyShare(_ c: PaintEditorController, since: Int) -> Double {
        if c.version == since { return 0 }
        guard let rects = c.dirtySince(since) else { return 1 }
        let w = c.doc.canvas.width, h = c.doc.canvas.height
        var tiles = Set<Int>()
        for r in rects where r.width > 0 && r.height > 0 {
            let x0 = Swift.max(0, r.x) / TILE, y0 = Swift.max(0, r.y) / TILE
            let x1 = (Swift.min(w, r.x + r.width) - 1) / TILE, y1 = (Swift.min(h, r.y + r.height) - 1) / TILE
            if x1 < x0 || y1 < y0 { continue }
            for ty in y0...y1 { for tx in x0...x1 { tiles.insert(ty * 4096 + tx) } }
        }
        let all = ((w + TILE - 1) / TILE) * ((h + TILE - 1) / TILE)
        return Double(tiles.count) / Double(all)
    }

    func run(_ brush: String, frames: Int, gpu: String?) throws -> Result {
        let width = 2048, height = 1536
        let c = try PaintEditorController(width: Double(width), height: Double(height), color: "#2255aa", wet: PaintWetOptions(gpu: gpu))
        let compositor = createPaintCompositor()
        let seed: UInt64 = 0xcbf2_9ce4_8422_2325
        var hash = seed
        func draw(hashing: Bool = false) -> Int {
            var count = 0
            c.compositeTiles(using: compositor) { tx, ty, data, changed in
                if changed { count += 1 }
                if hashing {
                    hash = (hash ^ UInt64(tx * 131 + ty)) &* 0x100_0000_01b3
                    data.withUnsafeBufferPointer { p in for b in p { hash = (hash ^ UInt64(b)) &* 0x100_0000_01b3 } }
                }
            }
            return count
        }
        _ = draw()
        // One long stroke across the canvas: about 2400 px, over a dozen tiles.
        let points = (0..<48).map { i -> PenPoint in
            let t = Double(i) / 47
            return PenPoint(x: 180 + t * 1680, y: 420 + sin(t * 7) * 240 + t * 620, pressure: 0.55 + 0.35 * sin(t * 11))
        }
        var out = Result(brush: brush)
        out.strokeMs = try ms { _ = try c.paintStroke(PaintStrokeInit(brushId: brush, seed: 7), points: points) }
        _ = draw()
        var now = 1000.0
        _ = c.tickWet(now)
        let player = c.playCultures(now: now)
        _ = draw()
        for _ in 0..<frames {
            now += 1000.0 / 60.0
            let before = c.version
            let tick = ms {
                out.steps += c.tickWet(now)
                if c.activeStroke == nil { _ = c.stepVortexAnimations(now) }
                _ = c.tickBlastAnimation(now)
                _ = player.tick(now: now)
            }
            out.dirtyShare += dirtyShare(c, since: before)
            var tiles = 0
            let composite = ms { tiles = draw() }
            out.tiles += Double(tiles)
            out.tickMs += tick
            out.compositeMs += composite
            out.worstMs = Swift.max(out.worstMs, tick + composite)
        }
        out.activeTiles = c.wet.world?.activeTiles() ?? 0
        _ = draw(hashing: true)
        out.hash = hash
        hash = seed
        c.wet.syncDisplays()
        _ = draw(hashing: true)
        out.settledHash = hash
        player.stop()
        let n = Double(frames)
        out.tickMs /= n
        out.compositeMs /= n
        out.dirtyShare /= n
        out.tiles /= n
        return out
    }

    func testSpecialtyPaintFrames() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["SPECIALTY_BENCH"] != nil else { throw XCTSkip("Set SPECIALTY_BENCH=1 (and -c release) to run the benchmark.") }
        let brushes = env["SPECIALTY_BENCH_BRUSHES"].map { $0.split(separator: ",").map(String.init) } ?? Self.defaultBrushes
        let frames = env["SPECIALTY_BENCH_FRAMES"].flatMap { Int($0) } ?? 90
        let gpu = env["SPECIALTY_BENCH_GPU"]
        print("specialty paints, 2048×1536, \(frames) frames at 60 Hz, gpu \(gpu ?? "auto"):")
        print("| brush | stroke ms | tick ms | composite ms | frame ms | worst frame ms | dirty % of canvas | tiles recomposited | wet steps | wet tiles left | view hash | settled hash |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for brush in brushes {
            let r = try run(brush, frames: frames, gpu: gpu)
            print(String(format: "| %@ | %.0f | %.2f | %.2f | %.2f | %.1f | %.0f | %.1f | %d | %d | %016llx | %016llx |", r.brush, r.strokeMs, r.tickMs, r.compositeMs, r.tickMs + r.compositeMs, r.worstMs, r.dirtyShare * 100, r.tiles, r.steps, r.activeTiles, r.hash, r.settledHash))
        }
    }
}
