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

    // MARK: View compositing (#824)

    func testBlendTileHasTheBitsOfTheSerialBlend() {
        var rng = Rng(state: 11)
        let n = TILE * TILE
        let dst = (0..<(n * 4)).map { _ in UInt8(rng.next() % 256) }
        let src = (0..<(n * 4)).map { i in i % 4 == 3 && i % 28 == 3 ? 0 : (i % 4 == 3 && i % 44 == 7 ? 255 : UInt8(rng.next() % 256)) }
        let coverage = (0..<n).map { i in i % 9 == 0 ? Float(0) : Float(rng.unit()) }
        for mode in [BlendMode.normal, .multiply, .screen, .overlay, .colorDodge, .hue, .luminosity, .linearDodge, .pigment] {
            for cov in [nil, coverage] {
                for alpha in [1.0, 0.63] {
                    var fast = dst
                    blendTile(&fast, src, mode, alpha, cov)
                    // The reference: one row at a time, each far below the split, so it runs on one thread.
                    var serial = dst
                    for y in 0..<TILE {
                        var row = Array(serial[(y * TILE * 4)..<((y + 1) * TILE * 4)])
                        blendTile(&row, Array(src[(y * TILE * 4)..<((y + 1) * TILE * 4)]), mode, alpha, cov.map { Array($0[(y * TILE)..<((y + 1) * TILE)]) })
                        serial.replaceSubrange((y * TILE * 4)..<((y + 1) * TILE * 4), with: row)
                    }
                    XCTAssertTrue(fast == serial, "\(mode) coverage \(cov != nil) alpha \(alpha)")
                }
            }
        }
    }

    private func expandRef(_ t: Tile, _ channels: Int) -> [UInt8] {
        if t.data.count == TILE * TILE * channels { return t.data }
        let u = t.uniform ?? 0
        if channels == 1 { return [UInt8](repeating: UInt8(u & 255), count: TILE * TILE) }
        var out = [UInt8](repeating: 0, count: TILE * TILE * 4)
        for i in stride(from: 0, to: out.count, by: 4) {
            out[i] = UInt8((u >> 24) & 255); out[i + 1] = UInt8((u >> 16) & 255); out[i + 2] = UInt8((u >> 8) & 255); out[i + 3] = UInt8(u & 255)
        }
        return out
    }

    /// `LitCache.litFerro` as it was: one tile after another, no cache.
    private func referenceLitFerro(_ color: TiledSurface, _ ch: ThickChannels, _ light: PaintLighting, _ ferro: FerroLayerInput) -> TiledSurface {
        let hasFerroSpikes = !ferro.magnets.isEmpty
        var out = color.tiles
        var keys = OrderedMap<TileKey, Bool>()
        for k in color.tiles.keys { keys.set(k, true) }
        for k in ferro.surface.tiles.keys { keys.set(k, true) }
        func buildHeightTile(_ ntx: Int, _ nty: Int) -> [UInt8]? {
            let nkey = tileKeyIn(ntx, nty)
            let ht = ch.height.tiles.get(nkey)
            let ft = hasFerroSpikes ? ferro.surface.tiles.get(nkey) : nil
            if ht == nil && ft == nil { return nil }
            guard let ft else { return expandRef(ht!, 1) }
            var outH = ht.map { expandRef($0, 1) } ?? [UInt8](repeating: 0, count: TILE * TILE)
            let fData = expandRef(ft, 1)
            let ox = Double(ntx * TILE + ferro.offset.x) + 0.5
            let oy = Double(nty * TILE + ferro.offset.y) + 0.5
            var p = 0
            for py in 0..<TILE {
                for px in 0..<TILE {
                    let fb = Int(fData[p])
                    if fb != 0 {
                        let hs = ferroSpikeHeightAt(ox + Double(px), oy + Double(py), fb, ferro.magnets, ferro.settings)
                        if hs > 0 { outH[p] = UInt8(Swift.min(255, Int(outH[p]) + hs)) }
                    }
                    p += 1
                }
            }
            return outH
        }
        for (key, _) in keys {
            let tile = color.tiles.get(key)
            let (tx, ty) = tileCoord(key)
            let film = ch.film.tiles.get(key)
            var any = film != nil
            for dy in -1...1 { for dx in -1...1 where ch.height.tiles.get(tileKeyIn(tx + dx, ty + dy)) != nil || ferro.surface.tiles.get(tileKeyIn(tx + dx, ty + dy)) != nil { any = true } }
            if !any { continue }
            let m = ch.material.tiles.get(key)
            let f = ferro.surface.tiles.get(key)
            if tile == nil && f == nil { continue }
            var cd = tile.map { expandRef($0, 4) } ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
            var md = m.map { expandRef($0, 4) }
            if let f {
                let fd = expandRef(f, 1)
                var mBuf = md ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
                for p in 0..<fd.count {
                    let fb = Int(fd[p])
                    if fb == 0 { continue }
                    let i = p * 4
                    if Int(cd[i + 3]) < fb {
                        let a0 = Double(cd[i + 3]) / Double(fb)
                        cd[i] = JS.u8c(JS.round(Double(cd[i]) * a0 + Double(FERRO_CARRIER_RGB.0) * (1.0 - a0)))
                        cd[i + 1] = JS.u8c(JS.round(Double(cd[i + 1]) * a0 + Double(FERRO_CARRIER_RGB.1) * (1.0 - a0)))
                        cd[i + 2] = JS.u8c(JS.round(Double(cd[i + 2]) * a0 + Double(FERRO_CARRIER_RGB.2) * (1.0 - a0)))
                        cd[i + 3] = UInt8(fb)
                    }
                    let w = Double(fb) / 255.0
                    mBuf[i] = UInt8(Swift.max(Int(mBuf[i]), Int(JS.round(Double(FERRO_DEFAULT_GLOSS) * w))))
                    mBuf[i + 1] = UInt8(Swift.max(Int(mBuf[i + 1]), Int(JS.round(Double(FERRO_DEFAULT_METALLIC) * w))))
                    mBuf[i + 2] = UInt8(Swift.max(Int(mBuf[i + 2]), Int(JS.round(Double(FERRO_DEFAULT_RIM) * w))))
                    if mBuf[i + 3] == 0 { mBuf[i + 3] = 255 }
                }
                md = mBuf
            }
            let data = lightTile(cd, buildHeightTile(tx, ty), { dx, dy in buildHeightTile(tx + dx, ty + dy) }, md, light, film.map { expandRef($0, 4) })
            out.set(key, Tile(data: data, uniform: nil))
        }
        return TiledSurface(channels: 4, tiles: out, defaultValue: color.defaultValue)
    }

    func testFerroLightsWithTheBitsOfTheSerialPass() {
        let (color, _) = litScene()
        var rng = Rng(state: 5)
        let w = 700, h = 560
        var fData = [UInt8](repeating: 0, count: w * h)
        var hData = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let d = ((Double(x) - 300) * (Double(x) - 300) + (Double(y) - 260) * (Double(y) - 260)).squareRoot()
                if d < 220 { fData[y * w + x] = UInt8(Swift.min(255, Int((1 - d / 220) * 300))) }
                if (x / 41 + y / 29) % 4 == 0 { hData[y * w + x] = UInt8(rng.next() % 200) }
            }
        }
        // Ferrofluid reaches tiles the colour has none in (x 0).
        let ferroSurface = surfaceFromPixels(width: w, height: h, data: fData, channels: 1, x: 0, y: -20)
        let ch = ThickChannels(height: surfaceFromPixels(width: w, height: h, data: hData, channels: 1, x: 30, y: -20), material: emptySurface(4, 0))
        let light = PaintLighting()
        for magnets in [[], [PaintMagnet(id: "m1", x: 310, y: 250, strength: 0.9, radius: 160), PaintMagnet(id: "m2", x: 120, y: 400, strength: -0.6, radius: 90)]] {
            let ferro = FerroLayerInput(surface: ferroSurface, magnets: magnets, settings: DEFAULT_FERRO, offset: LayerOffset(x: 0, y: 0))
            let cache = LitCache()
            let fast = cache.lit(color, ch, light, DEFAULT_VIEW_TILT, ferro)
            let expected = referenceLitFerro(color, ch, light, ferro)
            XCTAssertEqual(fast.tiles.keys, expected.tiles.keys, "magnets \(magnets.count): tile order")
            assertSameSurface(fast, expected, "ferro, magnets \(magnets.count)")
            // Warm: the same tiles come back from the cache.
            let again = cache.lit(color, ch, light, DEFAULT_VIEW_TILT, ferro)
            for (k, t) in again.tiles { XCTAssertTrue(t === fast.tiles.get(k), "cached tile \(tileCoord(k))") }
        }
    }

    func testLightRectanglesCoverEverythingTheLightChanged() throws {
        // Glow-wash light moves every step: a view that recomposites only the emitted rectangles shows what a full composite does.
        let c = try PaintEditorController(width: 700, height: 420, color: "#2255aa")
        let compositor = createPaintCompositor()
        var view = [UInt8](repeating: 0, count: 700 * 420 * 4)
        func draw() {
            c.compositeTiles(using: compositor) { tx, ty, data, _ in
                for y in 0..<TILE {
                    let py = ty * TILE + y
                    if py >= 420 { break }
                    for x in 0..<TILE {
                        let px = tx * TILE + x
                        if px >= 700 { break }
                        for k in 0..<4 { view[(py * 700 + px) * 4 + k] = data[(y * TILE + x) * 4 + k] }
                    }
                }
            }
        }
        _ = try c.paintStroke(PaintStrokeInit(brushId: "glow-wash", seed: 3), points: [PenPoint(x: 40, y: 60, pressure: 0.7), PenPoint(x: 600, y: 330, pressure: 0.7)])
        draw()
        var partial = 0
        var now = 1000.0
        _ = c.tickWet(now)
        for i in 0..<24 {
            let since = c.version
            now += 1000.0 / 30
            _ = c.tickWet(now)
            if i == 11 { _ = try c.paintStroke(PaintStrokeInit(brushId: "ink-pen", seed: 9), points: [PenPoint(x: 500, y: 40, pressure: 0.7), PenPoint(x: 520, y: 60, pressure: 0.7)]) }
            if c.dirtySince(since) != nil { partial += 1 }
            draw()
            XCTAssertTrue(view == c.compositePixels(wet: "display").data, "step \(i)")
        }
        // The light no longer makes every frame a full one.
        XCTAssertGreaterThan(partial, 0)
    }

    // MARK: Live patterns

    /// `LivePatternField.step` as it was: one thread, a closure call per cell, the fields copied every substep.
    private func referenceStep(_ field: LivePatternField, _ wetSteps: Int, isWetCell: WetCellPredicate, canWakeTile: ((Int, Int) -> Bool)? = nil) -> Bool {
        if !field.enabled || field.tiles.isEmpty || wetSteps <= 0 { return false }
        let totalSubsteps = Swift.max(1, wetSteps) * PATTERN_SUBSTEPS
        let F = field.settings.feed
        let k = field.settings.kill
        let fk = F + k
        let scaleClamped = Swift.min(2.2, Swift.max(0.4, field.settings.scale))
        let Du = 0.16 * scaleClamped
        let Dv = 0.08 * scaleClamped
        for (key, tile) in Array(field.tiles) {
            let (tx, ty) = tileCoord(key)
            var top = false, bottom = false, left = false, right = false
            for i in 0..<PATTERN_TILE {
                if tile.v[i] > PATTERN_V_EPS || tile.v[PATTERN_TILE + i] > PATTERN_V_EPS { top = true }
                if tile.v[(PATTERN_TILE - 1) * PATTERN_TILE + i] > PATTERN_V_EPS || tile.v[(PATTERN_TILE - 2) * PATTERN_TILE + i] > PATTERN_V_EPS { bottom = true }
                if tile.v[i * PATTERN_TILE] > PATTERN_V_EPS || tile.v[i * PATTERN_TILE + 1] > PATTERN_V_EPS { left = true }
                if tile.v[i * PATTERN_TILE + PATTERN_TILE - 1] > PATTERN_V_EPS || tile.v[i * PATTERN_TILE + PATTERN_TILE - 2] > PATTERN_V_EPS { right = true }
            }
            func wake(_ nx: Int, _ ny: Int) {
                if nx < 0 || ny < 0 || nx >= field.tilesX || ny >= field.tilesY { return }
                if let canWakeTile, !canWakeTile(nx, ny) { return }
                let nk = tileKey(nx, ny)
                if !field.tiles.has(nk) {
                    field.tiles.set(nk, LivePatternTileState(u: [Double](repeating: 1, count: PATTERN_CELLS), v: [Double](repeating: 0, count: PATTERN_CELLS), bakedV: [Double](repeating: 0, count: PATTERN_CELLS)))
                }
            }
            if top { wake(tx, ty - 1) }
            if bottom { wake(tx, ty + 1) }
            if left { wake(tx - 1, ty) }
            if right { wake(tx + 1, ty) }
        }
        final class StepEntry {
            let key: TileKey, tx: Int, ty: Int
            var u: [Double], v: [Double], nextU: [Double], nextV: [Double]
            let wet: [UInt8]
            let hasWet: Bool
            init(key: TileKey, tx: Int, ty: Int, u: [Double], v: [Double], wet: [UInt8], hasWet: Bool) {
                self.key = key; self.tx = tx; self.ty = ty
                self.u = u; self.v = v; nextU = u; nextV = v
                self.wet = wet; self.hasWet = hasWet
            }
        }
        var entries: [StepEntry] = []
        var byKey: [TileKey: StepEntry] = [:]
        var anyWet = false
        let maxHalfW = Int(JS.ceil(Double(field.width) * 0.5))
        let maxHalfH = Int(JS.ceil(Double(field.height) * 0.5))
        for (key, tile) in field.tiles {
            let (tx, ty) = tileCoord(key)
            var wet = [UInt8](repeating: 0, count: PATTERN_CELLS)
            var hasWet = false
            let tileW = Swift.min(PATTERN_TILE, maxHalfW - tx * PATTERN_TILE)
            let tileH = Swift.min(PATTERN_TILE, maxHalfH - ty * PATTERN_TILE)
            if tileH > 0 && tileW > 0 {
                for ly in 0..<tileH {
                    for lx in 0..<tileW where isWetCell(tx, ty, lx, ly) {
                        wet[ly * PATTERN_TILE + lx] = 1
                        hasWet = true
                        anyWet = true
                    }
                }
            }
            let e = StepEntry(key: key, tx: tx, ty: ty, u: tile.u, v: tile.v, wet: wet, hasWet: hasWet)
            entries.append(e)
            byKey[key] = e
        }
        if !anyWet { return false }
        func sampleUV(_ entry: StepEntry, _ lx: Int, _ ly: Int) -> (Double, Double) {
            if lx >= 0 && lx < PATTERN_TILE && ly >= 0 && ly < PATTERN_TILE {
                let idx = ly * PATTERN_TILE + lx
                return (entry.u[idx], entry.v[idx])
            }
            var ntx = entry.tx, nty = entry.ty, nlx = lx, nly = ly
            if nlx < 0 { ntx -= 1; nlx += PATTERN_TILE } else if nlx >= PATTERN_TILE { ntx += 1; nlx -= PATTERN_TILE }
            if nly < 0 { nty -= 1; nly += PATTERN_TILE } else if nly >= PATTERN_TILE { nty += 1; nly -= PATTERN_TILE }
            guard let nb = byKey[tileKey(ntx, nty)] else {
                let cx = Swift.min(PATTERN_TILE - 1, Swift.max(0, lx))
                let cy = Swift.min(PATTERN_TILE - 1, Swift.max(0, ly))
                let idx = cy * PATTERN_TILE + cx
                return (entry.u[idx], entry.v[idx])
            }
            let idx = nly * PATTERN_TILE + nlx
            return (nb.u[idx], nb.v[idx])
        }
        for _ in 0..<totalSubsteps {
            for e in entries where e.hasWet {
                for ly in 0..<PATTERN_TILE {
                    let row = ly * PATTERN_TILE
                    let interiorY = ly > 0 && ly < PATTERN_TILE - 1
                    for lx in 0..<PATTERN_TILE {
                        let idx = row + lx
                        if e.wet[idx] == 0 {
                            e.nextU[idx] = e.u[idx]
                            e.nextV[idx] = e.v[idx]
                            continue
                        }
                        let uc = e.u[idx]
                        let vc = e.v[idx]
                        var lapU = -uc
                        var lapV = -vc
                        if interiorY && lx > 0 && lx < PATTERN_TILE - 1 {
                            let n = idx - PATTERN_TILE
                            let so = idx + PATTERN_TILE
                            lapU += 0.2 * (e.u[idx - 1] + e.u[idx + 1] + e.u[n] + e.u[so]) +
                                0.05 * (e.u[n - 1] + e.u[n + 1] + e.u[so - 1] + e.u[so + 1])
                            lapV += 0.2 * (e.v[idx - 1] + e.v[idx + 1] + e.v[n] + e.v[so]) +
                                0.05 * (e.v[n - 1] + e.v[n + 1] + e.v[so - 1] + e.v[so + 1])
                        } else {
                            let (uW, vW) = sampleUV(e, lx - 1, ly)
                            lapU += 0.2 * uW; lapV += 0.2 * vW
                            let (uE, vE) = sampleUV(e, lx + 1, ly)
                            lapU += 0.2 * uE; lapV += 0.2 * vE
                            let (uN, vN) = sampleUV(e, lx, ly - 1)
                            lapU += 0.2 * uN; lapV += 0.2 * vN
                            let (uS, vS) = sampleUV(e, lx, ly + 1)
                            lapU += 0.2 * uS; lapV += 0.2 * vS
                            let (uNW, vNW) = sampleUV(e, lx - 1, ly - 1)
                            lapU += 0.05 * uNW; lapV += 0.05 * vNW
                            let (uNE, vNE) = sampleUV(e, lx + 1, ly - 1)
                            lapU += 0.05 * uNE; lapV += 0.05 * vNE
                            let (uSW, vSW) = sampleUV(e, lx - 1, ly + 1)
                            lapU += 0.05 * uSW; lapV += 0.05 * vSW
                            let (uSE, vSE) = sampleUV(e, lx + 1, ly + 1)
                            lapU += 0.05 * uSE; lapV += 0.05 * vSE
                        }
                        let uvv = uc * vc * vc
                        let nu = uc + Du * lapU - uvv + F * (1 - uc)
                        let nv = vc + Dv * lapV + uvv - fk * vc
                        e.nextU[idx] = nu < 0 ? 0 : nu > 1 ? 1 : nu
                        e.nextV[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv
                    }
                }
            }
            for e in entries where e.hasWet {
                e.u = e.nextU
                e.v = e.nextV
            }
        }
        for e in entries where e.hasWet {
            if var tile = field.tiles.get(e.key) {
                tile.u = e.u
                tile.v = e.v
                field.tiles.set(e.key, tile)
            }
        }
        return true
    }

    /// A field over 3 × 3 tiles (the canvas ends inside the last ones) seeded so that patterns cross tile edges and reach tiles with no neighbour.
    private func seededField() -> LivePatternField {
        let f = LivePatternField(width: 700, height: 600, settings: ["pattern": "coral"])
        for (i, p) in [(250.0, 250.0), (258.0, 120.0), (500.0, 262.0), (8.0, 8.0), (690.0, 590.0), (380.0, 380.0)].enumerated() {
            f.seedDisc(cx: p.0, cy: p.1, radius: 30, seed: 5 + i)
        }
        return f
    }

    private func assertSameField(_ a: LivePatternField, _ b: LivePatternField, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.tiles.keys, b.tiles.keys, "\(message): tiles", file: file, line: line)
        for (key, t) in a.tiles {
            guard let o = b.tiles.get(key) else { continue }
            XCTAssertTrue(t.u.elementsEqual(o.u) { $0.bitPattern == $1.bitPattern }, "\(message): U of \(tileCoord(key))", file: file, line: line)
            XCTAssertTrue(t.v.elementsEqual(o.v) { $0.bitPattern == $1.bitPattern }, "\(message): V of \(tileCoord(key))", file: file, line: line)
        }
    }

    func testLivePatternStepHasTheBitsOfTheSerialStep() {
        // Wet in blobs and bands, dry between them; tile (2, 1) is never wet and tile (0, 2) may not wake.
        let wet: WetCellPredicate = { tx, ty, lx, ly in
            if tx == 2 && ty == 1 { return false }
            let gx = tx * PATTERN_TILE + lx, gy = ty * PATTERN_TILE + ly
            return (gx / 23 + gy / 17) % 5 != 0
        }
        let canWake: (Int, Int) -> Bool = { tx, ty in !(tx == 0 && ty == 2) }
        let mask: WetTileMask = { tx, ty, w, h, m in
            var any = false
            for ly in 0..<h { for lx in 0..<w where wet(tx, ty, lx, ly) { m[ly * PATTERN_TILE + lx] = 1; any = true } }
            return any
        }
        let reference = seededField()
        let variants: [(name: String, field: LivePatternField, mask: WetTileMask?, threads: Int)] = [
            ("one thread, cell predicate", seededField(), nil, 1),
            ("one thread, tile mask", seededField(), mask, 1),
            ("eight threads, tile mask", seededField(), mask, 8),
        ]
        // Several calls: the tiles a call wakes take part in the next.
        for round in 0..<6 {
            let steps = 1 + round % 3
            XCTAssertTrue(referenceStep(reference, steps, isWetCell: wet, canWakeTile: canWake))
            for v in variants {
                XCTAssertTrue(v.field.step(steps, isWetCell: wet, canWakeTile: canWake, wetTile: v.mask, threads: v.threads))
                assertSameField(v.field, reference, "\(v.name), round \(round)")
                XCTAssertEqual(Set(v.field.steppedTiles), Set(reference.tiles.keys.filter { tileCoord($0) != (2, 1) }), "\(v.name): stepped tiles")
            }
        }
        XCTAssertGreaterThan(reference.tiles.count, 6)
        // Nothing wet: nothing steps.
        let dry = seededField()
        XCTAssertFalse(dry.step(2, isWetCell: { _, _, _, _ in false }))
        XCTAssertTrue(dry.steppedTiles.isEmpty)
        assertSameField(dry, seededField(), "dry field")
    }

    func testPatternLaneStepsTheSameOnOneThreadAndMany() throws {
        func run(threads: Int) throws -> (TiledSurface, LivePatternFieldSnapshot) {
            let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [250, 248, 240], heightAt: { x, y in 0.5 + 0.25 * sin(x * 0.7) * cos(y * 0.9) })
            let w = try WetWorld(width: 600, height: 520, paper: paper)
            w.threads = threads
            try w.ensureLane("a")
            try w.paint("a", RasterRect(x: 40, y: 60, width: 480, height: 380), nil, water: 0.8, pigment: pigmentOf([0.2, 0.4, 0.7], 0.1).map { $0 * 0.05 })
            try w.setLivePatterns("a", ["pattern": "stripes"])
            for (i, p) in [(250.0, 250.0), (258.0, 120.0), (420.0, 262.0)].enumerated() { _ = try w.seedLivePatterns("a", p.0, p.1, 28, 9 + i) }
            w.step(40)
            return (try w.display("a").surface, try w.livePatternField("a").snapshot())
        }
        let (one, onePattern) = try run(threads: 1)
        let (many, manyPattern) = try run(threads: 8)
        assertSameSurface(one, many, "display")
        XCTAssertEqual(onePattern.tiles.keys, manyPattern.tiles.keys)
        for (key, t) in onePattern.tiles {
            XCTAssertTrue(t.v.elementsEqual(manyPattern.tiles.get(key)!.v) { $0.bitPattern == $1.bitPattern }, "V of \(tileCoord(key))")
        }
        XCTAssertGreaterThan(onePattern.tiles.values.reduce(0) { $0 + $1.v.filter { $0 > PATTERN_V_EPS }.count }, 500)
    }

    // MARK: Pattern relief

    /// `LivePatternField.applyReliefHeight` as it was: every pattern tile, every pixel, every call.
    private func referenceRelief(_ field: LivePatternField, _ currentHeight: TiledSurface) -> TiledSurface {
        let relief = field.settings.relief
        if !field.enabled || relief <= 0 || field.tiles.isEmpty { return currentHeight }
        var nextTiles: OrderedMap<TileKey, Tile>? = nil
        for (key, pTile) in field.tiles {
            let (tx, ty) = tileCoord(key)
            let w = Swift.min(TILE, field.width - tx * TILE)
            let h = Swift.min(TILE, field.height - ty * TILE)
            if w <= 0 || h <= 0 { continue }
            var maxTileV = 0.0
            for i in 0..<PATTERN_CELLS where pTile.v[i] > maxTileV { maxTileV = pTile.v[i] }
            if maxTileV < PATTERN_V_EPS { continue }
            let existing = currentHeight.tiles.get(key)
            var buf: [UInt8]
            if let existing {
                buf = !existing.data.isEmpty ? existing.data : [UInt8](repeating: UInt8(truncatingIfNeeded: existing.uniform ?? 0), count: TILE * TILE)
            } else {
                buf = [UInt8](repeating: 0, count: TILE * TILE)
            }
            var tileChanged = false
            for y in 0..<h {
                let row = (y >> 1) * PATTERN_TILE
                for x in 0..<w {
                    let vVal = pTile.v[row + (x >> 1)]
                    if vVal < PATTERN_V_EPS { continue }
                    let ridge = JS.u8c(Swift.min(255, JS.round(Swift.min(1, vVal * 2.2) * relief * 255)))
                    let p = y * TILE + x
                    if ridge > buf[p] {
                        buf[p] = ridge
                        tileChanged = true
                    }
                }
            }
            if tileChanged {
                if nextTiles == nil { nextTiles = currentHeight.tiles }
                if let finished = finishTile(buf, 1, 0) { nextTiles!.set(key, finished) } else { _ = nextTiles!.delete(key) }
            }
        }
        return nextTiles.map { TiledSurface(channels: 1, tiles: $0, defaultValue: 0) } ?? currentHeight
    }

    func testPatternReliefSkipsOnlyWhatWouldNotChange() {
        let wet: WetCellPredicate = { tx, _, _, _ in tx < 2 }
        let field = seededField()
        field.configure(["relief": 0.6])
        // The canvas ends inside the last tiles (700 × 600), and one height tile is already high in places.
        var start = [UInt8](repeating: 0, count: 300 * 300)
        for i in 0..<start.count where (i / 300 + i % 300) % 11 < 4 { start[i] = 200 }
        var height = surfaceFromPixels(width: 300, height: 300, data: start, channels: 1, x: 150, y: 130)
        var expected = height
        func apply(_ message: String, file: StaticString = #filePath, line: UInt = #line) {
            let before = height
            expected = referenceRelief(field, expected)
            height = field.applyReliefHeight(height)
            assertSameSurface(height, expected, message, file: file, line: line)
            // What the old code left unchanged is still the same object.
            XCTAssertEqual(height === before, referenceRelief(field, before) === before, "\(message): identity", file: file, line: line)
        }
        apply("first relief")
        let settled = height
        apply("nothing changed")
        XCTAssertTrue(height === settled)
        for round in 0..<3 {
            XCTAssertTrue(field.step(2, isWetCell: wet))
            apply("after step \(round)")
        }
        field.seedDisc(cx: 600, cy: 100, radius: 40, seed: 77)
        apply("after a seed")
        // The relief is flattened (or undone) under the pattern: the ridges come back, as before.
        height = emptySurface(1, 0)
        expected = height
        apply("after flattening")
        XCTAssertFalse(height.tiles.isEmpty)
        // One height tile is replaced by something lower: only the pattern knows it has to be raised again.
        let key = height.tiles.keys[0]
        var tiles = height.tiles
        tiles.set(key, Tile(data: height.tiles.get(key)!.data.map { $0 / 3 }, uniform: nil))
        height = TiledSurface(channels: 1, tiles: tiles, defaultValue: 0)
        expected = height
        apply("after one tile was lowered")
        // The tiles are replaced from outside, and the settings change.
        var replaced = field.tiles
        var t = replaced.get(key)!
        for i in 0..<400 { t.v[i * 17] = 0.9 }
        replaced.set(key, t)
        field.tiles = replaced
        apply("after the tiles were replaced")
        field.configure(["relief": 1])
        apply("after the relief was raised")
        field.restore(field.snapshot())
        apply("after a restore")
        XCTAssertTrue(height === field.applyReliefHeight(height))
    }

    func testThickPaintLightsTheSameWithAWarmCache() throws {
        let c = try PaintEditorController(width: 600, height: 300, color: "#2255aa")
        _ = try c.paintStroke(PaintStrokeInit(brushId: "turing-wash", seed: 3), points: [PenPoint(x: 40, y: 60, pressure: 0.7), PenPoint(x: 560, y: 240, pressure: 0.7)])
        _ = try c.setLivePatterns(nil, ["relief": 0.8])
        _ = try c.advanceWet(steps: 60, seconds: nil)
        XCTAssertFalse(c.doc.thick?.values.first?.height.tiles.isEmpty ?? true)
        let first = c.compositePixels(wet: "display")
        XCTAssertTrue(c.compositePixels(wet: "display").data == first.data)
        c.litCaches = [:]
        XCTAssertTrue(c.compositePixels(wet: "display").data == first.data)
    }

    func testOnlyTilesThePatternAdvancedInAreShadedAgain() throws {
        let paper = WetPaperInput(absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [250, 248, 240], heightAt: { _, _ in 0.5 })
        let w = try WetWorld(width: 1024, height: 300, paper: paper)
        try w.ensureLane("a")
        let pigment = pigmentOf([0.2, 0.4, 0.7], 0.1).map { $0 * 0.05 }
        // A wash with a pattern in the first tile, and a damp speck in the last that dries at once.
        try w.paint("a", RasterRect(x: 20, y: 20, width: 200, height: 200), nil, water: 0.8, pigment: pigment)
        try w.paint("a", RasterRect(x: 800, y: 100, width: 6, height: 6), nil, water: 0.002, pigment: pigment)
        try w.setLivePatterns("a", ["pattern": "spots"])
        XCTAssertGreaterThan(try w.seedLivePatterns("a", 120, 120, 30, 4), 0)
        _ = try w.display("a")
        var quiet = 0, patternShaded = 0
        for _ in 0..<30 {
            w.step(1)
            let d = try w.display("a")
            let speckLive = try w.activeRects("a").contains { $0.x == 768 }
            if speckLive && !d.changed.contains(where: { $0.x == 768 }) { quiet += 1 }
            if d.changed.contains(where: { $0.x == 0 }) { patternShaded += 1 }
        }
        // The pattern's tile is shaded after every step; the dry tile waiting to be freed is left alone.
        XCTAssertEqual(patternShaded, 30)
        XCTAssertGreaterThan(quiet, 0)
    }
}
