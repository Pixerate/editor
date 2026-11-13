import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/**
 * The faster paths of the specialty paints give the bits of the code they replaced (#533): each
 * test runs the old, serial code (kept here as the reference) next to the engine's.
 */
final class SpecialtyPaintPerfTests: XCTestCase {
    /// A small deterministic generator (the tests need the same bytes every run).
    private struct Rng {
        var state: UInt64
        mutating func next() -> UInt64 {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return state >> 33
        }
        mutating func unit() -> Double { Double(next() % 1_000_000) / 1_000_000 }
    }

    // MARK: Light

    /// `computeSpill` as it was: one thread, every pixel.
    private func referenceSpill(_ color: TiledSurface, _ light: TiledSurface?, _ spill: LightSpill) -> TiledSurface? {
        func boxBlur(_ p: inout [Float], _ w: Int, _ h: Int, _ r: Int) {
            var tmp = [Float](repeating: 0, count: Swift.max(w, h))
            let n = Double(2 * r + 1)
            for y in 0..<h {
                var sum = 0.0
                for k in -r...r { sum += Double(p[y * w + Swift.min(w - 1, Swift.max(0, k))]) }
                for x in 0..<w {
                    tmp[x] = Float(sum / n)
                    sum += Double(p[y * w + Swift.min(w - 1, x + r + 1)]) - Double(p[y * w + Swift.max(0, x - r)])
                }
                for x in 0..<w { p[y * w + x] = tmp[x] }
            }
            for x in 0..<w {
                var sum = 0.0
                for k in -r...r { sum += Double(p[Swift.min(h - 1, Swift.max(0, k)) * w + x]) }
                for y in 0..<h {
                    tmp[y] = Float(sum / n)
                    sum += Double(p[Swift.min(h - 1, y + r + 1) * w + x]) - Double(p[Swift.max(0, y - r) * w + x])
                }
                for y in 0..<h { p[y * w + x] = tmp[y] }
            }
        }
        guard let light, let b = lightInfo(light).bounds, spill.radius > 0, spill.strength > 0 else { return nil }
        let r = Int(JS.ceil(spill.radius))
        let region = RasterRect(x: b.x - r, y: b.y - r, width: b.width + 2 * r, height: b.height + 2 * r)
        let col = readRegion(color, region)
        let lit = readRegion(light, region)
        let f = Swift.max(1, Int(JS.floor(spill.radius / 6)))
        let w = Int(JS.ceil(Double(region.width) / Double(f)))
        let h = Int(JS.ceil(Double(region.height) / Double(f)))
        var e = [[Float](repeating: 0, count: w * h), [Float](repeating: 0, count: w * h), [Float](repeating: 0, count: w * h)]
        for y in 0..<region.height {
            for x in 0..<region.width {
                let i = y * region.width + x
                let l = lit[i]
                if l == 0 { continue }
                let j = i * 4
                let k = ((Double(l) / 255) * (Double(col[j + 3]) / 255)) / Double(f * f)
                let cell = (y / f) * w + x / f
                for ch in 0..<3 { e[ch][cell] = Float(Double(e[ch][cell]) + colourToLinear(Double(col[j + ch]) / 255) * k) }
            }
        }
        let box = Swift.max(1, Int(JS.round(spill.radius / Double(f) / 2.5)))
        for ch in 0..<3 { for _ in 0..<3 { boxBlur(&e[ch], w, h, box) } }
        var out = [UInt8](repeating: 0, count: region.width * region.height * 4)
        for y in 0..<region.height {
            for x in 0..<region.width {
                let fx = Swift.min(Double(w - 1), Swift.max(0, (Double(x) + 0.5) / Double(f) - 0.5))
                let fy = Swift.min(Double(h - 1), Swift.max(0, (Double(y) + 0.5) / Double(f) - 0.5))
                let x0 = Int(JS.floor(fx)), y0 = Int(JS.floor(fy))
                let x1 = Swift.min(w - 1, x0 + 1), y1 = Swift.min(h - 1, y0 + 1)
                let tx = fx - Double(x0), ty = fy - Double(y0)
                let add = e.map { p -> Double in
                    let v = (Double(p[y0 * w + x0]) * (1 - tx) + Double(p[y0 * w + x1]) * tx) * (1 - ty) + (Double(p[y1 * w + x0]) * (1 - tx) + Double(p[y1 * w + x1]) * tx) * ty
                    return Swift.min(1, colourFromLinear(Swift.min(1, v * spill.strength)))
                }
                let a = Swift.max(add[0], add[1], add[2])
                if a <= 1.0 / 255 { continue }
                let o = (y * region.width + x) * 4
                out[o] = JS.u8c(JS.round((add[0] / a) * 255))
                out[o + 1] = JS.u8c(JS.round((add[1] / a) * 255))
                out[o + 2] = JS.u8c(JS.round((add[2] / a) * 255))
                out[o + 3] = JS.u8c(JS.round(a * 255))
            }
        }
        return surfaceFromPixels(width: region.width, height: region.height, data: out, channels: 4, x: region.x, y: region.y)
    }

    /// Paint and light over a few tiles: two glowing blobs far apart (so most of the light's bounds is dark) on patchy colour.
    private func litScene(width: Int = 700, height: Int = 600) -> (color: TiledSurface, light: TiledSurface) {
        var rng = Rng(state: 42)
        var color = [UInt8](repeating: 0, count: width * height * 4)
        var light = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                let i = y * width + x
                if (x / 37 + y / 53) % 3 != 0 {
                    color[i * 4] = UInt8(rng.next() % 256)
                    color[i * 4 + 1] = UInt8((x * 7 + y * 3) % 256)
                    color[i * 4 + 2] = UInt8(rng.next() % 256)
                    color[i * 4 + 3] = UInt8(120 + rng.next() % 136)
                }
                for (cx, cy, rad) in [(90.0, 80.0, 46.0), (560.0, 470.0, 70.0)] {
                    let d = ((Double(x) - cx) * (Double(x) - cx) + (Double(y) - cy) * (Double(y) - cy)).squareRoot()
                    if d < rad { light[i] = UInt8(Swift.min(255, Int((1 - d / rad) * 255) + Int(rng.next() % 9))) }
                }
            }
        }
        return (surfaceFromPixels(width: width, height: height, data: color, channels: 4, x: 30, y: -20), surfaceFromPixels(width: width, height: height, data: light, channels: 1, x: 30, y: -20))
    }

    private func assertSameSurface(_ a: TiledSurface?, _ b: TiledSurface?, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let a, let b else {
            XCTAssertTrue(a == nil && b == nil, "\(message): only one surface is nil", file: file, line: line)
            return
        }
        XCTAssertEqual(a.tiles.keys, b.tiles.keys, "\(message): tiles", file: file, line: line)
        for (key, tile) in a.tiles {
            XCTAssertTrue(tile.data == b.tiles.get(key)?.data, "\(message): tile \(tileCoord(key))", file: file, line: line)
        }
    }

    func testSpillHasTheBitsOfTheSerialSpill() {
        let (color, light) = litScene()
        for spill in [DEFAULT_LIGHT_SPILL, LightSpill(radius: 5, strength: 2), LightSpill(radius: 61.5, strength: 0.4)] {
            let fast = computeSpill(color, light, spill)
            XCTAssertNotNil(fast)
            assertSameSurface(fast, referenceSpill(color, light, spill), "spill \(spill)")
        }
        XCTAssertNil(computeSpill(color, emptyLight(), DEFAULT_LIGHT_SPILL))
    }

    func testLightCacheKeepsWhatDidNotChange() {
        let (color, light) = litScene()
        let cache = LightCache()
        let glowed = cache.glow(color, light, nil)
        assertSameSurface(glowed, glowSurface(color, light, nil), "glow")
        XCTAssertFalse(glowed === color)
        // The same inputs: the same surface, so the compositor sees no change.
        XCTAssertTrue(cache.glow(color, light, nil) === glowed)
        let spill = cache.spill(color, light, DEFAULT_LIGHT_SPILL)
        XCTAssertNotNil(spill)
        XCTAssertTrue(cache.spill(color, light, DEFAULT_LIGHT_SPILL) === spill)
        XCTAssertFalse(cache.spill(color, light, LightSpill(radius: 12, strength: 1)) === spill)
        XCTAssertNil(cache.spill(color, nil, DEFAULT_LIGHT_SPILL))

        // One light tile changes: only that tile is shaded again; the others are the same objects.
        let key = light.tiles.keys[0]
        var tiles = light.tiles
        tiles.set(key, Tile(data: light.tiles.get(key)!.data.map { $0 / 2 }, uniform: nil))
        let dimmer = TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
        let again = cache.glow(color, dimmer, nil)
        assertSameSurface(again, glowSurface(color, dimmer, nil), "glow after a light change")
        var reused = 0
        for (k, t) in again.tiles where light.tiles.has(k) {
            if k == key { XCTAssertFalse(t === glowed.tiles.get(k)) } else if t === glowed.tiles.get(k) { reused += 1 }
        }
        XCTAssertEqual(reused, light.tiles.keys.filter { color.tiles.has($0) }.count - 1)
    }

    func testLitLayerRendersTheSameWithWarmCaches() throws {
        let c = try PaintEditorController(width: 300, height: 200, color: "#2255aa")
        _ = try c.paintStroke(PaintStrokeInit(brushId: "glow-wash", seed: 3), points: [PenPoint(x: 40, y: 60, pressure: 0.7), PenPoint(x: 240, y: 140, pressure: 0.7)])
        _ = try c.advanceWet(steps: 40, seconds: nil)
        let first = c.compositePixels(wet: "display")
        XCTAssertFalse(c.lightCaches.isEmpty)
        // Warm caches, then caches dropped: the same picture each time.
        XCTAssertTrue(c.compositePixels(wet: "display").data == first.data)
        c.lightCaches = [:]
        XCTAssertTrue(c.compositePixels(wet: "display").data == first.data)
    }
}
