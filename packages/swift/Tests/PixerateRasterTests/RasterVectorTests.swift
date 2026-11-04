import Foundation
import PixerateCore
import XCTest
@testable import PixerateRaster

/// The TS raster module's own outputs (`packages/core/tests/swift-raster-vectors.test.ts` writes and
/// checks `Fixtures/raster-vectors.json`): the Swift port must reproduce every one. Pixels and PNG /
/// zlib bytes must be byte-equal; numbers that went through `exp`, `pow`, `sin`, … are stored as
/// `Math.fround` and compared as `Float`.
final class RasterVectorTests: XCTestCase {
    static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "raster-vectors", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.parse(try! Data(contentsOf: url))
    }()

    private var v: JSONValue { Self.vectors }

    // MARK: Blend modes

    func testBlendChannelAndRgb() {
        let blend = v.get("blend")
        let grid = blend.get("grid").a.map(\.n)
        for c in blend.get("channel").a {
            let mode = BlendMode(rawValue: c.get("mode").s)!
            let out = c.get("out").a
            var k = 0
            for cb in grid {
                for cs in grid {
                    expectNumber(blendChannel(mode, cb, cs), out[k], transcendental(mode), "blendChannel \(mode.rawValue)(\(cb), \(cs))")
                    k += 1
                }
            }
        }
        let colors = blend.get("colors").a.map { $0.a.map(\.n) }
        for c in blend.get("rgb").a {
            let mode = BlendMode(rawValue: c.get("mode").s)!
            let out = c.get("out").a
            var k = 0
            for cb in colors {
                for cs in colors {
                    let got = blendRgb(mode, cb, cs)
                    for ch in 0..<3 { expectNumber(got[ch], out[k + ch], transcendental(mode), "blendRgb \(mode.rawValue) \(cb) \(cs)") }
                    k += 3
                }
            }
        }
        for p in blend.get("pixels").a {
            let mode = BlendMode(rawValue: p.get("mode").s)!
            let got = blendPixel(mode, p.get("b").a.map(\.n), p.get("s").a.map(\.n), p.get("alpha").n)
            for (i, w) in p.get("out").a.enumerated() { expectNumber(got[i], w, transcendental(mode), "blendPixel \(mode.rawValue)") }
        }
    }

    func testBlendTilesAndPigment() {
        let blend = v.get("blend")
        let dst = bytes(blend.get("dst"))
        let src = bytes(blend.get("src"))
        let coverage = blend.get("coverage").a.map { Float($0.n) }
        for t in blend.get("tiles").a {
            let mode = BlendMode(rawValue: t.get("mode").s)!
            var a = dst
            blendTile(&a, src, mode, 0.7, coverage)
            assertBytes(a, bytes(t.get("coverage")), "blendTile \(mode.rawValue) with coverage")
            var b = dst
            blendTile(&b, src, mode, 1, nil)
            assertBytes(b, bytes(t.get("plain")), "blendTile \(mode.rawValue)")
            var c = dst
            blendImageData(&c, src, mode, 0.85)
            assertBytes(c, bytes(t.get("imageData")), "blendImageData \(mode.rawValue)")
        }
        for p in blend.get("pigment").a {
            let got = mixPigmentRgb(p.get("b").a.map(\.n), p.get("s").a.map(\.n), p.get("t").n)
            for (i, w) in p.get("out").a.enumerated() { expectNumber(got[i], w, true, "mixPigmentRgb") }
        }
        for p in blend.get("pigment8").a {
            let a = p.get("in").a.map(\.n)
            var out = [0.0, 0.0, 0.0]
            mixPigment8(Int(a[0]), Int(a[1]), Int(a[2]), Int(a[3]), Int(a[4]), Int(a[5]), a[6], &out)
            for (i, w) in p.get("out").a.enumerated() { expectNumber(out[i], w, true, "mixPigment8 \(a)") }
        }
        let info = blend.get("info").a
        XCTAssertEqual(info.count, BLEND_MODES.count)
        for (i, m) in info.enumerated() {
            let mine = BLEND_MODES[i]
            XCTAssertEqual(mine.id.rawValue, m.get("id").s)
            XCTAssertEqual(mine.label, m.get("label").s)
            XCTAssertEqual(mine.canvas, m.get("canvas").stringValue)
            XCTAssertEqual(mine.painterly, m.get("painterly").b)
            XCTAssertEqual(standardBlendMode(mine.id).rawValue, m.get("standard").s)
            XCTAssertEqual(isSeparableBlendMode(mine.id), m.get("separable").b)
            XCTAssertEqual(canvasCompositeOperation(mine.id), m.get("op").stringValue)
        }
    }

    // MARK: Surfaces

    func testSurfaces() {
        let s = v.get("surface")
        let base = surface(s.get("source"))
        let mask = surface(s.get("mask"))
        let px = bytes(s.get("source").get("data"))
        let draft = SurfaceDraft(base)
        draft.tile(0, 0).data[0] = 99
        draft.tile(1, -1).data[4 * 300] = 7
        draft.tile(5, 5).data[3] = 255
        let committed = draft.commit()
        let written = writeRegion(base, RasterRect(x: 255, y: 0, width: 3, height: 2), (1...24).map { UInt8($0) })
        let built: [(String, TiledSurface)] = [
            ("across four tiles", base),
            ("fill whole tiles", fillRect(base, RasterRect(x: 0, y: 0, width: 512, height: 256), [10, 20, 30, 255])),
            ("fill part", fillRect(base, RasterRect(x: 253, y: -2, width: 5, height: 3), [255, 0, 0, 128])),
            ("fill default", fillRect(base, RasterRect(x: -256, y: -256, width: 1024, height: 512), [0, 0, 0, 0])),
            ("write region", written),
            ("translate", translateSurface(base, 3.4, -7.6)),
            ("translate by tiles", translateSurface(base, 256, -512)),
            ("solid", solidSurface(4, RasterRect(x: -3, y: 2, width: 6, height: 4), 0x1122_3344)),
            ("mask default 255", mask),
            ("mask fill hide", fillRect(mask, RasterRect(x: -256, y: -256, width: 512, height: 512), [0])),
            ("draft", committed),
        ]
        let cases = s.get("cases").a
        XCTAssertEqual(cases.count, built.count)
        for (c, (name, sur)) in zip(cases, built) {
            XCTAssertEqual(c.get("name").s, name)
            XCTAssertEqual(sur.channels, c.get("channels").i, name)
            XCTAssertEqual(sur.defaultValue, c.get("defaultValue").i, name)
            XCTAssertEqual(sur.bounds, rect(c.get("bounds")), "\(name) bounds")
            XCTAssertEqual(contentBounds(sur), rect(c.get("contentBounds")), "\(name) contentBounds")
            let tiles = c.get("tiles").a.map { $0.a }
            XCTAssertEqual(sur.tiles.keys, tiles.map { $0[0].i }, "\(name) tile keys")
            for t in tiles {
                XCTAssertEqual(tileCoord(t[0].i).tx, t[1].i)
                XCTAssertEqual(tileCoord(t[0].i).ty, t[2].i)
                XCTAssertEqual(sur.tiles.get(t[0].i)?.uniform.map { Double($0) }, t[3].numberValue, "\(name) uniform")
            }
            XCTAssertEqual(surfaceBytes(sur), c.get("bytes").i, "\(name) bytes")
            assertBytes(readRegion(sur, rect(c.get("read"))!), bytes(c.get("pixels")), "\(name) pixels")
        }
        for k in s.get("tileKeys").a.map({ $0.a }) { XCTAssertEqual(tileKey(k[0].i, k[1].i), k[2].i) }
        XCTAssertEqual(tilesInRect(RasterRect(x: -10, y: 250, width: 300, height: 10)).map { [$0.tx, $0.ty] }, s.get("tilesInRect").a.map { $0.a.map(\.i) })
        XCTAssertEqual(draft.touched, s.get("draftTouched").a.map(\.i))
        let pixelReads = [(base, 250, -5), (base, 261, 4), (base, 0, 0), (mask, -2, -1), (mask, 100, 100)].map { readPixel($0.0, $0.1, $0.2) }
        XCTAssertEqual(pixelReads, s.get("readPixel").a.map { $0.a.map(\.i) })
        let other = writeRegion(base, RasterRect(x: 260, y: 3, width: 1, height: 1), [0, 0, 0, 0])
        XCTAssertEqual([surfacesEqual(base, base), surfacesEqual(base, written), surfacesEqual(base, surfaceFromPixels(width: 12, height: 10, data: px, channels: 4, x: 250, y: -5)), surfacesEqual(base, other)], s.get("equal").a.map(\.b))
        XCTAssertEqual(changedTiles(base, other), s.get("changed").a.map(\.i))
        XCTAssertEqual(changedTiles(base, committed), s.get("changedDraft").a.map(\.i))
    }

    // MARK: Deep samples

    func testDeepSamples() {
        let d = v.get("deep")
        for e in d.get("enc").a.map({ $0.a }) {
            expectNumber(srgbEncode(e[0].n), e[1], true, "srgbEncode(\(e[0].n))")
            expectNumber(srgbDecode(e[0].n), e[2], true, "srgbDecode(\(e[0].n))")
        }
        let c = d.get("convert")
        let lin = floats(c.get("lin"))
        let u16 = shorts(c.get("u16"))
        let rgba = bytes(d.get("rgba8"))
        _ = rgba
        assertFloats(to32From8((0..<256).map { UInt8($0) }, 4), floats(c.get("codes")), "to32From8 codes")
        assertFloats(to32From8((0..<256).map { UInt8($0) }, 1), floats(c.get("mask32")), "to32From8 mask")
        let src = gradientCheck(c)
        XCTAssertEqual(to16From8(src), shorts(c.get("to16From8")))
        assertFloats(to32From8(src, 4), floats(c.get("to32From8")), "to32From8")
        assertFloats(to32From16(u16, 4), floats(c.get("to32From16")), "to32From16")
        assertFloats(to32From16(u16, 1), floats(c.get("to32From16Mask")), "to32From16 mask")
        XCTAssertEqual(to16From32(lin, 4), shorts(c.get("to16From32")))
        XCTAssertEqual(to16From32(lin, 1), shorts(c.get("to16From32Mask")))
        assertBytes(to8From16(u16), bytes(c.get("to8From16")), "to8From16")
        assertBytes(to8From32(lin, 4), bytes(c.get("to8From32")), "to8From32")
        assertBytes(to8From32(lin, 1), bytes(c.get("to8From32Mask")), "to8From32 mask")

        let d16 = shorts(d.get("d16"))
        let d32 = floats(d.get("d32"))
        let sur16 = surfaceFromDeepPixels(width: 6, height: 5, data: .u16(d16), channels: 4, x: 253, y: -2)
        let sur32 = surfaceFromDeepPixels(width: 6, height: 5, data: .f32(d32), channels: 4, x: 253, y: -2)
        let read = rect(d.get("read"))!
        let surfaces: [TiledSurface] = [
            sur16, sur32, convertSurfaceDepth(sur16, 32), convertSurfaceDepth(sur32, 16), convertSurfaceDepth(sur32, 8),
            surfaceFromDeepPixels(width: 6, height: 5, data: .u16(shorts(d.get("exact16"))), channels: 4, x: 0, y: 0),
            writeDeepRegion(surfaceFromPixels(width: 8, height: 8, data: bytes(d.get("rgba8")), channels: 4, x: 250, y: -4), RasterRect(x: 253, y: -2, width: 6, height: 5), .u16(d16)),
        ]
        for (c, sur) in zip(d.get("surfaces").a, surfaces) {
            let name = c.get("name").s
            XCTAssertEqual(surfaceDepth(sur), c.get("depth").i, name)
            XCTAssertEqual(sur.tiles.count, c.get("tiles").i, name)
            assertBytes(readRegion(sur, read), bytes(c.get("bytes8")), "\(name) 8-bit")
            XCTAssertEqual(readDeepRegion16(sur, read), shorts(c.get("read16")), "\(name) 16-bit")
            assertFloats(readDeepRegion32(sur, read), floats(c.get("read32")), "\(name) 32-bit")
        }
        let after = writeRegion(sur16, RasterRect(x: 254, y: -1, width: 2, height: 2), [UInt8](repeating: 200, count: 16))
        let kept = keepDeepSamples(sur16, after)
        let k = d.get("kept")
        XCTAssertEqual(surfaceDepth(kept), k.get("depth").i)
        XCTAssertEqual(readDeepRegion16(kept, read), shorts(k.get("read16")))
        assertBytes(readRegion(kept, read), bytes(k.get("bytes8")), "keepDeepSamples")
        XCTAssertEqual(deepTile(.f32([Float](repeating: 0, count: TILE * TILE * 4)), 4, 0) == nil, d.get("emptyFloatTile").b)
        if case .u16(let w) = workingToSamples([0, 0.5, 1, 1.2, -0.1, 0.25, 0.75, 0.999], 16) { XCTAssertEqual(w, shorts(d.get("working16"))) } else { XCTFail("workingToSamples") }
    }

    /// The 4×4 RGBA the TS `deepVectors` converts (`to16From8` of it is stored, so read it back).
    private func gradientCheck(_ c: JSONValue) -> [UInt8] {
        shorts(c.get("to16From8")).map { UInt8($0 / 257) }
    }

    // MARK: Pigment, blur, curves

    func testPigment() {
        let p = v.get("pigment")
        for s in p.get("spectra").a {
            let c = s.get("c").a.map(\.n)
            assertFloats(rgbToReflectance(c[0], c[1], c[2]), floats(s.get("spectrum")), "spectrum \(c)")
            let back = reflectanceToRgb(rgbToReflectance(c[0], c[1], c[2]))
            for (i, w) in s.get("back").a.enumerated() { expectNumber(back[i], w, true, "reflectanceToRgb \(c)") }
        }
        for (i, s) in p.get("pigments").a.enumerated() {
            let c = s.get("c").a.map(\.n)
            let pig = createPigment(c, PigmentOptions(strength: i % 3 == 0 ? 2 : nil))
            XCTAssertEqual(pig.strength, s.get("strength").n)
            expectNumber(pig.scatter, s.get("scatter"), true, "scatter \(c)")
            assertFloats(pig.ks, floats(s.get("ks")), "ks \(c)")
            XCTAssertEqual(pig.rgb, s.get("rgb").a.map(\.n))
        }
        let colors = p.get("colors").a.map { $0.a.map(\.n) }
        let rgb = { (i: Int) in PigmentColor.rgb(colors[i][0], colors[i][1], colors[i][2]) }
        for m in p.get("mixes").a {
            let got = try! mixPigments(m.get("idx").a.map { rgb($0.i) }, m.get("weights").a.map(\.n))
            for (i, w) in m.get("out").a.enumerated() { expectNumber(got[i], w, true, "mixPigments") }
        }
        for l in p.get("lerps").a {
            let got = try! lerpPigment(rgb(3), rgb(4), l.get("t").n)
            for (i, w) in l.get("out").a.enumerated() { expectNumber(got[i], w, true, "lerpPigment") }
        }
        let strong = createPigment([0.05, 0.02, 0.3], PigmentOptions(strength: 4))
        let mixed = try! mixPigments([.pigment(strong), .rgb(1, 1, 1)], [1, 3])
        for (i, w) in p.get("strongMix").a.enumerated() { expectNumber(mixed[i], w, true, "strong mix") }
        let errors: [() throws -> Void] = [
            { _ = try mixPigments([], []) },
            { _ = try mixPigments([.rgb(0, 0, 0)], [1, 2]) },
            { _ = try mixPigments([.rgb(0, 0, 0)], [-1]) },
            { _ = try mixPigments([.rgb(0, 0, 0)], [0]) },
        ]
        for (f, w) in zip(errors, p.get("errors").a) {
            do {
                try f()
                XCTAssertEqual(w, .null)
            } catch {
                XCTAssertEqual("\(error)", w.s)
            }
        }
    }

    func testBlur() {
        let b = v.get("blur")
        let src = floats(b.get("src"))
        for c in b.get("cases").a {
            let edge = BlurEdge(rawValue: c.get("edge").s)!
            assertFloats(gaussianBlur(src, b.get("w").i, b.get("h").i, c.get("sigma").n, edge), floats(c.get("out")), "blur σ \(c.get("sigma").n) \(edge)")
        }
    }

    func testCurves() {
        for c in v.get("curve").a {
            let points = c.get("points").a.map { CurvePoint(input: $0.a[0].n, output: $0.a[1].n) }
            assertFloats(curveLut(points, 65), floats(c.get("small")), "curve \(points)")
            if c.get("full") != .null { assertFloats(curveLut(points), floats(c.get("full")), "full curve \(points)") }
        }
    }

    // MARK: Transforms

    func testTransforms() throws {
        let t = v.get("transform")
        let src = surface(t.get("source"))
        let mask = surface(t.get("mask"))
        let deep = surfaceFromDeepPixels(width: 16, height: 14, data: .u16(shorts(t.get("deep16"))), channels: 4, x: 3, y: 2)
        let read = rect(t.get("read"))!
        for c in t.get("cases").a {
            let name = c.get("name").s
            let s = c.get("surface").stringValue == "mask" ? mask : c.get("surface").stringValue == "deep16" ? deep : src
            let options = ResampleOptions(interpolation: c.get("interpolation").stringValue.flatMap(Interpolation.init), source: rect(c.get("sourceRect")), clip: rect(c.get("clip")), step: c.get("step").numberValue)
            let out = try transformSurface(s, c.get("h").a.map(\.n), options)
            XCTAssertEqual(contentBounds(out), rect(c.get("contentBounds")), "\(name) bounds")
            XCTAssertEqual(surfaceDepth(out), c.get("depth").i, "\(name) depth")
            assertBytes(readRegion(out, read), bytes(c.get("pixels")), name)
            if c.get("deep16") != .null { XCTAssertEqual(readDeepRegion16(out, read), shorts(c.get("deep16")), "\(name) 16-bit") }
        }
        for w in t.get("warps").a {
            let name = w.get("name").s
            let shrink = w.get("shrink").b
            let f: (Vec2) -> Vec2? = shrink
                ? { Vec2(x: $0.x * 0.4 + 2, y: $0.y * 0.45 + 1) }
                : { Vec2(x: $0.x + Double(Float(1.5 * JS.sin($0.y / 3))), y: $0.y + Double(Float(0.7 * JS.cos($0.x / 4)))) }
            let out = try warpSurface(src, f, ResampleOptions(interpolation: Interpolation(rawValue: w.get("interpolation").s), step: w.get("step").numberValue))
            XCTAssertEqual(contentBounds(out), rect(w.get("contentBounds")), "\(name) bounds")
            assertBytes(readRegion(out, read), bytes(w.get("pixels")), name)
        }
        let top = surface(t.get("top"))
        let over: [(String, TiledSurface)] = [("layer", compositeSurfaceOver(src, top)), ("mask", compositeSurfaceOver(mask, top)), ("deep", compositeSurfaceOver(deep, top))]
        for (o, (name, s)) in zip(t.get("over").a, over) {
            assertBytes(readRegion(s, read), bytes(o.get("pixels")), "over \(name)")
            if o.get("deep16") != .null { XCTAssertEqual(readDeepRegion16(s, read), shorts(o.get("deep16")), "over \(name) 16-bit") }
        }
        let reduced = reduceSurface(src, 3)
        XCTAssertEqual(contentBounds(reduced), rect(t.get("reduced").get("contentBounds")))
        assertBytes(readRegion(reduced, RasterRect(x: 0, y: 0, width: 8, height: 8)), bytes(t.get("reduced").get("pixels")), "reduceSurface")

        let h = t.get("homography")
        let quad = [Vec2(x: 0, y: 0), Vec2(x: 10, y: 1), Vec2(x: 12, y: 9), Vec2(x: -1, y: 8)]
        let h1 = homographyFromPoints([Vec2(x: 0, y: 0), Vec2(x: 1, y: 0), Vec2(x: 1, y: 1), Vec2(x: 0, y: 1)], quad)
        let h2 = rectToQuad(Box(x: 2, y: 3, width: 8, height: 6), quad)
        XCTAssertEqual(h1, h.get("fromPoints").arrayValue?.map(\.n))
        XCTAssertEqual(h2, h.get("rectToQuad").arrayValue?.map(\.n))
        XCTAssertEqual(h2.flatMap(invertHomography), h.get("inverse").arrayValue?.map(\.n))
        XCTAssertEqual(multiplyHomographies(h1!, h2!), h.get("product").a.map(\.n))
        XCTAssertEqual([applyHomography(h2!, Vec2(x: 3, y: 4)), applyHomography(h2!, Vec2(x: 10, y: 9))].map { [$0!.x, $0!.y] }, h.get("applied").a.map { [$0.get("x").n, $0.get("y").n] })
        XCTAssertEqual(orderQuad([Vec2(x: 10, y: 1), Vec2(x: -1, y: 8), Vec2(x: 0, y: 0), Vec2(x: 12, y: 9)])?.map { [$0.x, $0.y] }, h.get("order").arrayValue?.map { [$0.get("x").n, $0.get("y").n] })
        XCTAssertEqual([isConvexQuad(quad), isConvexQuad([quad[0], quad[2], quad[1], quad[3]])], h.get("convex").a.map(\.b))
        XCTAssertEqual(homographyFrontSide(h2!, Box(x: 2, y: 3, width: 8, height: 6)), h.get("front").i)
        XCTAssertEqual(cornerBounds(quad), rect(h.get("corners")))
        for k in h.get("keys").a.map({ $0.a }) { XCTAssertEqual(keysWeight(k[0].n), k[1].n, "keysWeight(\(k[0].n))") }
    }

    // MARK: Compositor

    func testCompositor() {
        let c = v.get("compositor")
        let W = c.get("canvas").get("width").i
        let H = c.get("canvas").get("height").i
        let sources = BasicRasterSources(width: W, height: H)
        for (st, r) in zip(c.get("stacks").a, c.get("results").a) {
            let name = st.get("name").s
            let comp = RasterCompositor<RasterLayer, BasicRasterSources>()
            let layers = st.get("layers").a.map(buildLayer)
            let area = rect(st.get("rect")) ?? RasterRect(x: 0, y: 0, width: W, height: H)
            XCTAssertEqual(area, rect(r.get("rect")))
            let first = comp.composite(layers, area, sources)
            let stats1 = comp.lastStats
            let again = comp.composite(layers, area, sources)
            let stats2 = comp.lastStats
            assertBytes(first, bytes(r.get("pixels")), name)
            XCTAssertEqual(first == again, r.get("same").b, "\(name) again")
            XCTAssertEqual([stats(stats1), stats(stats2)], r.get("stats").a, "\(name) stats")
        }
        // Incremental: a change inside a dirty rect matches a fresh composite.
        let comp = RasterCompositor<RasterLayer, BasicRasterSources>()
        let layers0 = c.get("stacks").a[1].get("layers").a.map(buildLayer)
        let all = RasterRect(x: 0, y: 0, width: W, height: H)
        _ = comp.composite(layers0, all, sources, CompositeCallOptions(checkpointLayerId: "b"))
        let s1 = writeRegion(layers0[2].surface!, RasterRect(x: 12, y: 8, width: 3, height: 3), [UInt8](repeating: 250, count: 36))
        let layers1 = [layers0[0], layers0[1], layers0[2].with(content: .pixel(surface: s1, offset: layers0[2].offset!, fillOpacity: layers0[2].fillOpacity))]
        let inc = comp.composite(layers1, all, sources, CompositeCallOptions(dirty: [DirtyRect(x: 12, y: 8, width: 3, height: 3)]))
        let fresh = RasterCompositor<RasterLayer, BasicRasterSources>().composite(layers1, all, sources)
        let incremental = c.get("incremental")
        assertBytes(inc, bytes(incremental.get("pixels")), "incremental")
        XCTAssertEqual(inc == fresh, incremental.get("matchesFresh").b)
        XCTAssertEqual(stats(comp.lastStats), incremental.get("stats"))
    }

    func testCompositorEffectsPatch() throws {
        let c = v.get("compositor")
        let inc = c.get("effectsIncremental")
        let effects = c.get("stacks").a.first { $0.get("name").s == "effects" }!.get("layers").a[1].get("effects")
        let sources = BasicRasterSources(width: 80, height: 56)
        let all = RasterRect(x: 0, y: 0, width: 80, height: 56)
        let comp = RasterCompositor<RasterLayer, BasicRasterSources>()
        let layers0 = [
            buildLayer(.object(JSONObject([("id", "bg"), ("type", "pixel"), ("pixels", inc.get("bg"))]))),
            buildLayer(.object(JSONObject([("id", "a"), ("type", "pixel"), ("pixels", inc.get("big")), ("effects", effects)]))),
        ]
        _ = comp.composite(layers0, all, sources)
        let changed = writeRegion(layers0[1].surface!, RasterRect(x: 4, y: 5, width: 2, height: 2), [UInt8](repeating: 255, count: 16))
        let layers1 = [layers0[0], layers0[1].with(content: .pixel(surface: changed, offset: LayerOffset(x: 0, y: 0), fillOpacity: nil))]
        let out = comp.composite(layers1, all, sources, CompositeCallOptions(dirty: [DirtyRect(x: 4, y: 5, width: 2, height: 2)]))
        let fresh = RasterCompositor<RasterLayer, BasicRasterSources>().composite(layers1, all, sources)
        assertBytes(out, bytes(inc.get("pixels")), "patched effects")
        XCTAssertEqual(out == fresh, inc.get("matchesFresh").b)
        XCTAssertEqual(stats(comp.lastStats), inc.get("stats"))
    }

    func testCompositorProfile() {
        let c = v.get("compositor")
        let W = c.get("canvas").get("width").i
        let H = c.get("canvas").get("height").i
        let sources = BasicRasterSources(width: W, height: H)
        let all = RasterRect(x: 0, y: 0, width: W, height: H)
        for r in c.get("profile").a {
            let name = r.get("name").s
            let layers = r.get("layers").a.map(buildProfileLayer)
            let profile = Self.testProfile()
            assertBytes(RasterCompositor(profile: profile).composite(layers, all, sources), bytes(r.get("pixels")), name)
            for depth in [16, 32] {
                let deep = DeepCompositor(base: RasterCompositor(profile: profile), profile: profile, depth: depth)
                assertFloats(deep.composite(layers, all, sources), floats(r.get("deep\(depth)")), "\(name) at \(depth)")
            }
        }
    }

    /// The TS test's profile (filter layers that invert, solid fills drawn by the host, a per-pixel and
    /// a spatial pixel filter, a ramp mask source, pixel-like smart layers).
    static func testProfile() -> CompositorProfile<TestLayer, BasicRasterSources> {
        var p = CompositorProfile<TestLayer, BasicRasterSources>()
        p.isFilterLayer = { $0.type == "invert" }
        p.applyFilterRun = { layers, acc, _, coverage, _ in
            for l in layers {
                let cov = coverage?[l.id]
                var i = 0, px = 0
                while i < acc.count {
                    let k = cov.map { Double($0[px]) } ?? 1
                    for ch in 0..<3 { acc[i + ch] = JS.u8c(JS.round(Double(acc[i + ch]) + (255 - 2 * Double(acc[i + ch])) * k)) }
                    i += 4
                    px += 1
                }
            }
        }
        p.contentTile = { l, r, _ in
            guard l.type == "fill", let color = l.color else { return nil }
            var out = [UInt8](repeating: 0, count: r.width * r.height * 4)
            for i in stride(from: 0, to: out.count, by: 4) { for ch in 0..<4 { out[i + ch] = color[ch] } }
            return out
        }
        p.pixelFilters = { l in
            if l.id == "dim" {
                return PixelFilterSpec(key: "dim", spatial: false) { d, _, _ in
                    for i in stride(from: 0, to: d.count, by: 4) { for ch in 0..<3 { d[i + ch] = JS.u8c(Double(d[i + ch]) * 0.5) } }
                }
            }
            if l.id == "blur" {
                return PixelFilterSpec(key: "blur", spatial: true) { d, w, h in
                    let src = d
                    for y in 0..<h {
                        for x in 0..<w {
                            for ch in 0..<4 {
                                let at = { (xx: Int) in Double(src[(y * w + Swift.min(w - 1, Swift.max(0, xx))) * 4 + ch]) }
                                d[(y * w + x) * 4 + ch] = JS.u8c((at(x - 1) + at(x) + at(x + 1)) / 3)
                            }
                        }
                    }
                }
            }
            return nil
        }
        p.maskSourcePlane = { source, w, h, _ in
            source["ramp"] == .bool(true) ? (0..<(w * h)).map { Float(Double($0 % w) / Double(w)) } : nil
        }
        p.isPixelLike = { $0.type == "smart" }
        p.layerKey = { l in l.color.map { .array($0.map { .number(Double($0)) }) } }
        return p
    }

    private func buildProfileLayer(_ s: JSONValue) -> TestLayer {
        let base = buildLayer(.object({
            var o = s.objectValue!
            o["type"] = s.get("type").s == "pixel" || s.get("type").s == "smart" ? "pixel" : "group"
            o["children"] = .array([])
            return o
        }()))
        var mask = base.mask
        if s.get("mask").get("source") != .null { mask?.source = s.get("mask").get("source") }
        let type = s.get("type").s
        let pixelLike = type == "pixel" || type == "smart"
        return TestLayer(
            id: base.id, type: type, visible: base.visible, opacity: base.opacity, blend: base.blend, clipped: base.clipped, mask: mask,
            surface: pixelLike ? base.surface : nil, offset: pixelLike ? base.offset : nil, fillOpacity: pixelLike ? base.fillOpacity : nil,
            effects: base.effects, edge: base.edge, children: type == "group" ? [] : nil,
            color: s.get("color").arrayValue?.map { UInt8($0.i) }
        )
    }

    func testDeepCompositor() {
        let c = v.get("compositor")
        let W = c.get("canvas").get("width").i
        let H = c.get("canvas").get("height").i
        let d16 = shorts(c.get("d16"))
        let specs: [[JSONValue]] = deepStackSpecs(c)
        for (out, depth) in zip(c.get("deep").a, [16, 16, 16, 16, 32, 32, 32, 32]) {
            XCTAssertEqual(out.get("depth").i, depth)
        }
        var k = 0
        for depth in [16, 32] {
            for layersSpec in specs {
                let want = c.get("deep").a[k]
                k += 1
                var layers = layersSpec.map(buildLayer)
                for (i, l) in layers.enumerated() where l.id == "a" && l.surface != nil {
                    let deep = surfaceFromDeepPixels(width: 14, height: 12, data: depth == 16 ? .u16(d16) : .f32(to32From16(d16, 4)), channels: 4, x: 2, y: 3)
                    layers[i] = l.with(content: .pixel(surface: deep, offset: l.offset!, fillOpacity: l.fillOpacity))
                }
                let base = RasterCompositor<RasterLayer, BasicRasterSources>()
                let deepComp = DeepCompositor(base: base, profile: CompositorProfile(), depth: depth)
                let got = deepComp.composite(layers, RasterRect(x: 0, y: 0, width: W, height: H), BasicRasterSources(width: W, height: H))
                assertFloats(got, floats(want.get("pixels")), "\(want.get("name").s) at \(depth)")
            }
        }
    }

    /// The layer specs of the TS deep compositor stacks, rebuilt from the stored surfaces.
    private func deepStackSpecs(_ c: JSONValue) -> [[JSONValue]] {
        let s = c.get("surfaces")
        let bg = s.get("bg"), blob = s.get("blob"), blob2 = s.get("blob2"), stripes = s.get("stripes"), mask = s.get("mask")
        let shadow = c.get("stacks").a.first { $0.get("name").s == "effects" }!.get("layers").a[1].get("effects").get("items").a[0]
        func layer(_ pairs: [(String, JSONValue)]) -> JSONValue { .object(JSONObject(pairs)) }
        return [
            [layer([("id", "bg"), ("type", "pixel"), ("pixels", bg)]), layer([("id", "a"), ("type", "pixel"), ("pixels", blob), ("opacity", 0.8), ("blend", "multiply")])],
            [layer([("id", "bg"), ("type", "pixel"), ("pixels", bg)]), layer([("id", "g"), ("type", "group"), ("opacity", 0.7), ("children", .array([
                layer([("id", "a"), ("type", "pixel"), ("pixels", blob2), ("mask", layer([("pixels", mask), ("density", 0.6)]))]),
                layer([("id", "c"), ("type", "pixel"), ("pixels", stripes), ("clipped", true), ("blend", "soft-light")]),
            ]))])],
            [layer([("id", "bg"), ("type", "pixel"), ("pixels", bg)]), layer([("id", "a"), ("type", "pixel"), ("pixels", blob), ("effects", layer([("enabled", true), ("items", .array([shadow]))]))])],
            [layer([("id", "bg"), ("type", "pixel"), ("pixels", bg)]), layer([("id", "a"), ("type", "pixel"), ("pixels", blob2), ("blend", "pigment"), ("opacity", 0.6)])],
        ]
    }

    // MARK: Layer effects

    func testEffectRenders() throws {
        let e = v.get("effects")
        let content = bytes(e.get("content"))
        let backdrop = bytes(e.get("backdrop"))
        let r = rect(e.get("rect"))!
        let canvas = rect(e.get("canvas"))!
        for c in e.get("renders").a {
            let name = c.get("name").s
            var out = c.get("backdrop").stringValue == "clear" ? [UInt8](repeating: 0, count: backdrop.count) : backdrop
            let items = try c.get("effects").a.map { try LayerEffect(json: $0) }
            let effects = LayerEffects(enabled: true, scale: c.get("scale").numberValue, items: items)
            renderLayerEffects(effects, content: content, rect: r, blend: BlendMode(rawValue: c.get("blend").stringValue ?? "normal")!, opacity: c.get("opacity").numberValue ?? 1, fillOpacity: c.get("fillOpacity").numberValue, backdrop: &out, canvas: canvas, ctx: ctx)
            assertBytes(out, bytes(c.get("out")), name)
        }
        // The float path.
        let items = try e.get("float").get("items").a.map { try LayerEffect(json: $0) }
        let n = r.width * r.height
        let shape = (0..<n).map { Float(Double(content[$0 * 4 + 3]) / 255) }
        let maps = buildEffectMaps(items, shape, r, ctx)
        var input = EffectCompositeInput(backdrop: .floats(backdrop.map { Float(Double($0) / 255) }), content: .floats(content.map { Float(Double($0) / 255) }), rect: r, maps: maps, blend: .screen, opacity: 0.9, fillOpacity: 1, canvas: canvas, ctx: ctx)
        compositeLayerEffects(&input)
        assertFloats(input.backdrop.floats!, floats(e.get("float").get("out")), "float effects")
    }

    func testEffectModel() throws {
        let e = v.get("effects")
        for (i, d) in e.get("defaults").a.enumerated() {
            let kind = LAYER_EFFECT_KINDS[i]
            XCTAssertEqual(defaultLayerEffect(kind, "id_\(kind.rawValue)").json, d, kind.rawValue)
            XCTAssertEqual(try LayerEffect(json: d).json, d, "\(kind.rawValue) round trip")
        }
        for r in e.get("reach").a.map({ $0.a }) {
            XCTAssertEqual(effectReach(defaultLayerEffect(LayerEffectKind(rawValue: r[0].s)!, "x")), r[1].n, r[0].s)
        }
        let defaults = try e.get("defaults").a.map { try LayerEffect(json: $0) }
        var chisel = defaults[0]
        if case .bevelEmboss(var b) = chisel {
            b.technique = .chiselSoft
            b.size = 9
            b.soften = 3
            chisel = .bevelEmboss(b)
        }
        let margins = [
            LayerEffects(enabled: true, items: defaults),
            LayerEffects(enabled: false, items: defaults),
            LayerEffects(enabled: true, scale: 2.5, items: [defaults[1], defaults[9]]),
            LayerEffects(enabled: true, items: [chisel]),
        ].map(effectsMargin)
        XCTAssertEqual(margins, e.get("margins").a.map(\.i))
        var unaligned = defaults[6]
        if case .gradientOverlay(var g) = unaligned {
            g.gradient.align = false
            unaligned = .gradientOverlay(g)
        }
        var unlinked = defaults[7]
        if case .patternOverlay(var p) = unlinked {
            p.pattern.link = false
            unlinked = .patternOverlay(p)
        }
        var noisy = defaults[9]
        if case .dropShadow(var s) = noisy {
            s.noise = 0.1
            noisy = .dropShadow(s)
        }
        var patternStroke = defaults[1]
        if case .stroke(var s) = patternStroke {
            s.fill = .pattern(EffectPatternRef(patternId: "dots", scale: 1, link: false))
            patternStroke = .stroke(s)
        }
        XCTAssertEqual([defaults, [unaligned], [unlinked], [noisy], [patternStroke]].map(effectsAreLocal), e.get("local").a.map(\.b))
        for (d, want) in zip(defaults, e.get("scaled").a) { XCTAssertEqual(scaleLayerEffect(d, 1.5).json, want, "scaled \(d.kind.rawValue)") }
        for c in e.get("validation").a {
            do {
                try validateLayerEffect(c.get("value"))
                XCTAssertEqual(c.get("error"), .null, c.get("name").s)
            } catch {
                XCTAssertEqual("\(error)", c.get("error").stringValue, c.get("name").s)
            }
        }
        for c in e.get("effectsValidation").a {
            do {
                try validateLayerEffects(c.get("value"))
                XCTAssertEqual(c.get("error"), .null)
            } catch {
                XCTAssertEqual("\(error)", c.get("error").stringValue)
            }
        }
        for m in e.get("merges").a {
            let effect = try LayerEffect(json: m.get("effect"))
            do {
                let out = try mergeLayerEffect(effect, m.get("changes").objectValue!)
                XCTAssertEqual(out.json, m.get("out"), "merge \(m.get("changes").stringified())")
            } catch {
                XCTAssertEqual("\(error)", m.get("error").stringValue, "merge \(m.get("changes").stringified())")
            }
        }
        let normalize = e.get("normalize")
        let normalized = normalizeLayerEffects(normalize.get("raw"))!
        XCTAssertEqual(normalized.enabled, normalize.get("out").get("enabled").b)
        XCTAssertEqual(normalized.scale, normalize.get("out").get("scale").numberValue)
        XCTAssertEqual(normalized.items.map { e -> JSONValue in
            var o = e.json.objectValue!
            if e.id.hasPrefix("fx_") { o["id"] = "<new>" }
            return .object(o)
        }, normalize.get("out").get("items").a)
        let fingerprints = [
            LayerEffects(enabled: true, items: defaults),
            LayerEffects(enabled: true, scale: 2, items: [defaults[1]]),
            LayerEffects(enabled: false, items: [try LayerEffect(json: { var o = defaults[1].json.objectValue!; o["id"] = "other"; return .object(o) }())]),
        ].map(effectsFingerprint)
        XCTAssertEqual(fingerprints, e.get("fingerprints").a.map(\.s))
        for f in e.get("fields").a.map({ $0.a }) { XCTAssertEqual(layerEffectFields(LayerEffectKind(rawValue: f[0].s)!), f[1].a.map(\.s)) }
        for c in e.get("colors").a.map({ $0.a }) { XCTAssertEqual(parseEffectColor(c[0].s), c[1].arrayValue?.map(\.n), c[0].s) }
        for h in e.get("hex").a.map({ $0.a }) { XCTAssertEqual(effectColorHex(h[0].a.map(\.n)), h[1].s) }
        for c in e.get("contours").a {
            let contour = EffectContour(json: c.get("contour"))!
            let lut = contourLut(contour)
            if c.get("lut") == .null { XCTAssertNil(lut, contour.name) } else { assertFloats(lut ?? [], floats(c.get("lut")), "contour \(contour.name)") }
        }
        let frame = rect(e.get("frame"))!
        for g in e.get("gradientTs").a {
            let style = GradientStyle(rawValue: g.get("style").s)!
            let pts: [(Double, Double)] = [(2.5, 3.5), (7, 6), (11.5, 8.5), (0, 0), (20, -4)]
            for (p, w) in zip(pts, g.get("t").a) {
                expectNumber(gradientT(style, g.get("angle").n, g.get("scale").n, g.get("reverse").b, EffectPoint(json: g.get("offset")), frame, p.0, p.1), w, true, "gradientT \(style)")
            }
        }
        let fillRect = rect(e.get("fillRect"))!
        for f in e.get("fillColors").a {
            let fill = EffectFill(json: f.get("fill"))
            assertFloats(effectFillColors(fill, fillRect, frame, RasterRect(x: 0, y: 0, width: 30, height: 20), EffectPoint(x: 1, y: 1), ctx), floats(f.get("out")), "fill \(f.get("fill").stringified())")
        }
    }

    // MARK: Patterns and the effects panel

    func testPatterns() {
        let p = v.get("patterns")
        XCTAssertEqual(builtinPatternIds(), p.get("builtins").a.map { $0.get("id").s })
        for b in p.get("builtins").a {
            let pat = builtinPattern(b.get("id").s)!
            XCTAssertEqual(pat.name, b.get("name").s)
            XCTAssertEqual(pat.width, b.get("width").i)
            assertBytes(pat.data, bytes(b.get("data")), "builtin \(pat.id)")
        }
        let tile = PatternTile(width: 3, height: 2, data: bytes(p.get("tile").get("data")))
        for s in p.get("samples").a.map({ $0.a }) {
            var out = [0.0, 0.0, 0.0, 0.0]
            tile.sample(s[0].n, s[1].n, &out)
            for i in 0..<4 { expectNumber(out[i], s[i + 2], true, "sample \(s[0].n), \(s[1].n)") }
        }
        let pl = p.get("placement")
        let place = PatternPlacement(anchor: EffectPoint(json: pl.get("anchor")), link: pl.get("link").b, phase: EffectPoint(json: pl.get("phase")), scale: pl.get("scale").n, angle: pl.get("angle").n)
        for o in pl.get("out").a.map({ $0.a }) {
            var uv = [0.0, 0.0]
            place.map(o[0].n, o[1].n, &uv)
            expectNumber(uv[0], o[2], true, "placement x")
            expectNumber(uv[1], o[3], true, "placement y")
        }
        for n in p.get("noise").a.map({ $0.a }) { XCTAssertEqual(hashNoise(n[0].n, n[1].n), n[2].n, "hashNoise(\(n[0].n), \(n[1].n))") }
    }

    func testEffectsPanel() throws {
        let u = v.get("ui")
        let patterns = u.get("patterns").a.map { EffectPattern(id: $0.get("id").s, name: $0.get("name").s, width: $0.get("width").i, height: $0.get("height").i, data: bytes($0.get("data"))) }
        for c in u.get("controls").a {
            let effect = try LayerEffect(json: c.get("effect"))
            XCTAssertEqual(JSONValue.array(layerEffectControls(effect, patterns).map(\.json)), c.get("controls"), "controls of \(effect.kind.rawValue)")
        }
        for c in u.get("changed").a {
            let effect = try LayerEffect(json: c.get("effect"))
            XCTAssertEqual(JSONValue.object(effectControlChange(effect, c.get("key").s, c.get("value"), patterns)), c.get("out"), "change \(c.get("key").s)")
        }
        for p in u.get("panels").a {
            let l = p.get("layer")
            let target: LayerEffectsTarget? = l == .null ? nil : LayerEffectsTarget(
                id: l.get("id").s, type: l.get("type").s,
                effects: l.get("effects") == .null ? nil : try effects(l.get("effects")),
                locks: l.get("locks").get("all") == .bool(true) ? LayerLocks(all: true) : nil
            )
            let panel = layerEffectsPanel(target)
            let want = p.get("panel")
            XCTAssertEqual(panel.available, want.get("available").b)
            XCTAssertEqual(panel.reason, want.get("reason").stringValue)
            XCTAssertEqual(panel.readOnly, want.get("readOnly").b)
            XCTAssertEqual(panel.enabled, want.get("enabled").b)
            XCTAssertEqual(panel.scale, want.get("scale").n)
            XCTAssertEqual(panel.rows.map { [$0.id, $0.kind.rawValue, $0.label, $0.enabled ? "1" : "0"] }, want.get("rows").a.map { [$0.get("id").s, $0.get("kind").s, $0.get("label").s, $0.get("enabled").b ? "1" : "0"] })
        }
    }

    // MARK: PNG and zlib

    func testZlib() throws {
        let c = v.get("codec")
        for z in c.get("zlib").a {
            let name = z.get("name").s
            let input = bytes(z.get("input"))
            XCTAssertEqual(adler32(input), UInt32(z.get("adler").n), name)
            let out = deflate(input)
            assertBytes(out, bytes(z.get("deflate")), "deflate \(name)")
            if z.get("stored") != .null { assertBytes(deflate(input, level: 0), bytes(z.get("stored")), "deflate stored \(name)") }
            if z.get("raw") != .null { assertBytes(deflateRaw(input), bytes(z.get("raw")), "deflateRaw \(name)") }
            assertBytes(try inflate(out), input, "inflate \(name)")
        }
        for f in c.get("foreign").a { assertBytes(try inflate(bytes(f.get("stream"))), bytes(f.get("out")), "inflate \(f.get("name").s)") }
        assertBytes(try inflateRaw(bytes(c.get("rawInflate").get("stream"))), bytes(c.get("rawInflate").get("out")), "inflateRaw")
        for e in c.get("inflateErrors").a {
            do {
                _ = try inflate(bytes(e.get("input")))
                XCTAssertEqual(e.get("error"), .null)
            } catch {
                XCTAssertEqual("\(error)", e.get("error").stringValue)
            }
        }
        do {
            _ = try inflate(deflate([UInt8](repeating: 0, count: 5000)), maxOutput: 1000)
            XCTFail("expected the bomb guard")
        } catch {
            XCTAssertEqual("\(error)", c.get("bombError").s)
        }
    }

    func testPng() throws {
        let c = v.get("codec")
        for p in c.get("png").a {
            let name = p.get("name").s
            let png = encodePng(p.get("width").i, p.get("height").i, bytes(p.get("data")), p.get("channels").i)
            assertBytes(png, bytes(p.get("png")), "encodePng \(name)")
            assertBytes(try decodePng(png).data, bytes(p.get("decoded")), "decodePng \(name)")
            assertBytes(try decodePng(png, keepGray: true).data, bytes(p.get("gray")), "decodePng keepGray \(name)")
        }
        for p in c.get("foreignPng").a {
            let name = p.get("name").s
            do {
                let d = try decodePng(bytes(p.get("png")), keepGray: p.get("keepGray").b)
                XCTAssertEqual([d.width, d.height, d.channels], [p.get("width").i, p.get("height").i, p.get("channels").i], name)
                assertBytes(d.data, bytes(p.get("out")), name)
            } catch {
                XCTAssertEqual("\(error)", p.get("error").stringValue, name)
            }
        }
        let b = c.get("base64")
        for r in b.get("roundTrip").a.map({ $0.a }) {
            let data = r[0].a.map { UInt8($0.i) }
            XCTAssertEqual(bytesToBase64(data), r[1].s)
            XCTAssertEqual(try base64ToBytes(r[1].s), data)
        }
        for d in b.get("decode").a.map({ $0.a }) { XCTAssertEqual(try base64ToBytes(d[0].s), d[1].a.map { UInt8($0.i) }, d[0].s) }
        XCTAssertThrowsError(try base64ToBytes("AQ*D")) { XCTAssertEqual("\($0)", b.get("invalid").s) }
        for d in b.get("dataUrls").a.map({ $0.a }) {
            let parsed = parseDataUrl(d[0].s)
            if d[1] == .null { XCTAssertNil(parsed, d[0].s) } else {
                XCTAssertEqual(parsed?.mime, d[1].get("mime").s, d[0].s)
                XCTAssertEqual(parsed?.bytes, d[1].get("bytes").a.map { UInt8($0.i) }, d[0].s)
            }
        }
    }

    // MARK: Viewport and layer trees

    func testViewport() {
        let vp = v.get("viewport")
        for m in vp.get("mapped").a {
            let mapping = mappingOf(m.get("mapping"))
            let view = viewOf(m.get("view"))
            XCTAssertEqual(point(worldToSurface(mapping, 13.25, -7.5)), point(m.get("w2s")))
            XCTAssertEqual(point(surfaceToWorld(mapping, 13.25, -7.5)), point(m.get("s2w")))
            XCTAssertEqual(worldRectToSurface(mapping, Box(x: -3.2, y: 4.7, width: 10.1, height: 0.2)), rect(m.get("rect")))
            XCTAssertEqual(visibleSurfaceRect(mapping, view, 800, 600, 3), rect(m.get("visible")))
        }
        for z in vp.get("zooms").a.map({ $0.a }) {
            XCTAssertEqual(surfaceResolutionForZoom(z[0].n), z[1].n, "zoom \(z[0].n)")
            XCTAssertEqual(surfaceResolutionForZoom(z[0].n, ResolutionPolicy(devicePixelRatio: 2, min: 0.5, max: 4)), z[2].n, "zoom \(z[0].n) with policy")
        }
        for m in vp.get("mips").a.map({ $0.a }) {
            XCTAssertEqual(surfaceMipLevel(m[0].n), m[1].i)
            XCTAssertEqual(surfaceMipLevel(m[0].n, 2), m[2].i)
        }
        let t = vp.get("surface").get("tiles").a[0].a
        let patch = vp.get("surface").get("patch").a.map(\.i)
        let surface = writeRegion(surfaceFromPixels(width: t[2].i, height: t[3].i, data: bytes(t[4]), channels: 4, x: t[0].i, y: t[1].i), RasterRect(x: patch[0], y: patch[1], width: patch[2], height: patch[3]), [UInt8](repeating: UInt8(patch[4]), count: patch[2] * patch[3] * 4))
        for d in vp.get("draws").a {
            let renderer = SurfaceViewportRenderer<FakeImage> { data, _, _ in FakeImage(data) }
            var ctx = FakeDrawing()
            let o = d.get("options")
            let options = DrawSurfaceOptions(width: o.get("width").n, height: o.get("height").n, maxMipLevel: o.get("maxMipLevel").numberValue.map { Int($0) })
            let stats = renderer.draw(&ctx, surface, mappingOf(d.get("mapping")), viewOf(d.get("view")), options)
            let again = renderer.draw(&ctx, surface, mappingOf(d.get("mapping")), viewOf(d.get("view")), options)
            XCTAssertEqual([stats.level, stats.drawn, stats.built], [d.get("stats").get("level").i, d.get("stats").get("drawn").i, d.get("stats").get("built").i])
            XCTAssertEqual([again.level, again.drawn, again.built], [d.get("again").get("level").i, d.get("again").get("drawn").i, d.get("again").get("built").i])
            XCTAssertEqual(ctx.smoothing, d.get("smoothing").b)
            XCTAssertEqual(ctx.calls, d.get("calls").a.map { $0.a.map(\.i) })
            XCTAssertEqual(ctx.images, d.get("images").a.map(\.s))
        }
    }

    func testLayerTrees() {
        let l = v.get("layers")
        let tree = [Node("a"), Node("g", [Node("b"), Node("h", [Node("c")])]), Node("d")]
        XCTAssertEqual(ids(tree), l.get("tree"))
        XCTAssertEqual(flattenLayers(tree).map(\.id), l.get("flat").a.map(\.s))
        for f in l.get("find").a.map({ $0.a }) {
            let loc = findLayer(tree, f[0].s)
            if f[1] == .null { XCTAssertNil(loc) } else {
                XCTAssertEqual(loc?.layer.id, f[1].get("id").s)
                XCTAssertEqual(loc?.parent?.id, f[1].get("parent").stringValue)
                XCTAssertEqual(loc?.index, f[1].get("index").i)
                XCTAssertEqual(loc?.path.map(\.id), f[1].get("path").a.map(\.s))
            }
        }
        XCTAssertEqual(ids(mapLayer(tree, "c") { _ in nil }), l.get("removeC"))
        XCTAssertEqual(ids(mapLayer(tree, "b") { Node("B", $0.children) }), l.get("renameB"))
        XCTAssertEqual(ids(insertLayer(tree, Node("n"), nil)), l.get("insertTop"))
        XCTAssertEqual(ids(insertLayer(tree, Node("n"), "h", 0)), l.get("insertIntoH"))
        XCTAssertEqual(ids(insertLayer(tree, Node("n"), "g", 99)), l.get("insertClamped"))
    }

    // MARK: JavaScript number semantics

    func testJavaScriptRounding() {
        XCTAssertEqual(JS.round(2.5), 3)
        XCTAssertEqual(JS.round(-2.5), -2)
        XCTAssertEqual(JS.round(0.49999999999999994), 0)
        XCTAssertEqual(JS.round(-0.4).sign, .minus)
        // Uint8ClampedArray rounds half to even, Math.round half up.
        XCTAssertEqual(JS.u8c(0.5), 0)
        XCTAssertEqual(JS.u8c(1.5), 2)
        XCTAssertEqual(JS.u8c(2.5), 2)
        XCTAssertEqual(JS.u8c(254.5), 254)
        XCTAssertEqual(JS.u8c(-3), 0)
        XCTAssertEqual(JS.u8c(300), 255)
        XCTAssertEqual(JS.u8c(.nan), 0)
        XCTAssertEqual(JS.i32(4294967295), -1)
        XCTAssertEqual(JS.i32(-1.9), -1)
        XCTAssertEqual(JS.u16(65536 + 7), 7)
        XCTAssertEqual(JS.hypot(3, 4), 5)
    }

    /// Inputs where the platform's libm and Node's `Math` disagree in the last bit: `JS` must give
    /// Node's answer (recorded with Node 25 / V8 14.1 on arm64, where V8's fdlibm is compiled with
    /// fused multiply-adds; x64 builds round some of these differently, so they are not in the TS vectors).
    func testV8MathOnArm64() {
        let cases: [(String, UInt64, UInt64, UInt64)] = [
            ("atan2", 0xbfd620b200000000, 0xbfcc4f63c0000000, 0xc0011e816f2c0628),
            ("atan2", 0xbfd7b49200000000, 0xbfc0bc23c0000000, 0xbffe8fdb737b885f),
            ("atan2", 0x3fc2f4db00000000, 0x3fbdf6de00000000, 0x3fecdcf005c0cd6e),
            ("cbrt", 0x3fd84e7500000000, 0x0, 0x3fe72c7e5177092e),
            ("cbrt", 0xbfe39aa5e0000000, 0x0, 0xbfeb2d8988a2bbfe),
            ("cbrt", 0x3fd582c240000000, 0x0, 0x3fe63fb86092f012),
            ("cos", 0x40048e6290000000, 0x0, 0xbfeae7b16228d128),
            ("cos", 0x400b2721b0000000, 0x0, 0xbfeefc3588325280),
            ("cos", 0x4004423340000000, 0x0, 0xbfea3dfd078cc626),
            ("exp", 0xc02caf6560000000, 0x0, 0x3ea3cef759f1386c),
            ("exp", 0x401ae372d0000000, 0x0, 0x4089f498a190ebca),
            ("exp", 0xc029720f38000000, 0x0, 0x3ec904b7e4c7b6c0),
            ("hypot", 0xbf8814e800000000, 0x3fffa28980000000, 0x3fffa2ae29d3a44d),
            ("hypot", 0x3fc291e400000000, 0x3ffb585980000000, 0x3ffb718694c4c10e),
            ("hypot", 0x3fc84e7500000000, 0x3fffa54060000000, 0x3fffca8135edfc26),
            ("sin", 0x40120fe9e0000000, 0x0, 0xbfef61cb76d239a7),
            ("sin", 0x3fe37c1680000000, 0x0, 0x3fe24d86340c2dc8),
            ("sin", 0x3fe8f5ca40000000, 0x0, 0x3fe681494eb50dea),
        ]
        for (fn, a, b, want) in cases {
            let x = Double(bitPattern: a), y = Double(bitPattern: b)
            let got: Double
            switch fn {
            case "atan2": got = JS.atan2(x, y)
            case "cbrt": got = JS.cbrt(x)
            case "cos": got = JS.cos(x)
            case "exp": got = JS.exp(x)
            case "hypot": got = JS.hypot(x, y)
            default: got = JS.sin(x)
            }
            XCTAssertEqual(got.bitPattern, want, "\(fn)(\(x), \(y)) = \(got), V8 gives \(Double(bitPattern: want))")
        }
    }

    // MARK: Helpers

    var ctx: EffectContext { EffectContext(light: GlobalLight(angle: 120, altitude: 30)) { id in builtinPattern(id).map { PatternTile($0) } } }

    private func transcendental(_ mode: BlendMode) -> Bool {
        [.pigment, .watercolor, .tint, .highlight, .shadow].contains(mode)
    }

    private func expectNumber(_ got: Double, _ want: JSONValue, _ asFloat: Bool, _ msg: String, file: StaticString = #filePath, line: UInt = #line) {
        let w = want.n
        if asFloat {
            if Float(got) != Float(w) && !(got.isNaN && w.isNaN) { XCTFail("\(msg): \(Float(got)) != \(Float(w))", file: file, line: line) }
        } else if got != w && !(got.isNaN && w.isNaN) {
            XCTFail("\(msg): \(got) != \(w)", file: file, line: line)
        }
    }

    private func assertBytes(_ got: [UInt8], _ want: [UInt8], _ msg: String, file: StaticString = #filePath, line: UInt = #line) {
        guard got.count == want.count else {
            XCTFail("\(msg): \(got.count) bytes, expected \(want.count)", file: file, line: line)
            return
        }
        var diff = 0
        var maxDelta = 0
        var first = -1
        for i in 0..<got.count where got[i] != want[i] {
            diff += 1
            maxDelta = Swift.max(maxDelta, Swift.abs(Int(got[i]) - Int(want[i])))
            if first < 0 { first = i }
        }
        if diff > 0 { XCTFail("\(msg): \(diff) of \(got.count) bytes differ (max delta \(maxDelta)); first at \(first): \(got[first]) vs \(want[first])", file: file, line: line) }
    }

    private func assertFloats(_ got: [Float], _ want: [Float], _ msg: String, file: StaticString = #filePath, line: UInt = #line) {
        guard got.count == want.count else {
            XCTFail("\(msg): \(got.count) values, expected \(want.count)", file: file, line: line)
            return
        }
        var diff = 0
        var first = -1
        for i in 0..<got.count where got[i].bitPattern != want[i].bitPattern && !(got[i].isNaN && want[i].isNaN) {
            diff += 1
            if first < 0 { first = i }
        }
        if diff > 0 { XCTFail("\(msg): \(diff) of \(got.count) floats differ; first at \(first): \(got[first]) vs \(want[first])", file: file, line: line) }
    }

    private func bytes(_ v: JSONValue) -> [UInt8] { [UInt8](Data(base64Encoded: v.s)!) }

    private func floats(_ v: JSONValue) -> [Float] {
        let b = bytes(v)
        return stride(from: 0, to: b.count, by: 4).map { (i: Int) -> Float in
            // Split up: the one-line OR of four shifted bytes timed out the CI type checker.
            let b0 = UInt32(b[i])
            let b1: UInt32 = UInt32(b[i + 1]) << 8
            let b2: UInt32 = UInt32(b[i + 2]) << 16
            let b3: UInt32 = UInt32(b[i + 3]) << 24
            return Float(bitPattern: b0 | b1 | b2 | b3)
        }
    }

    private func shorts(_ v: JSONValue) -> [UInt16] {
        let b = bytes(v)
        return stride(from: 0, to: b.count, by: 2).map { (i: Int) -> UInt16 in
            let high: UInt16 = UInt16(b[i + 1]) << 8
            return UInt16(b[i]) | high
        }
    }

    private func rect(_ v: JSONValue) -> RasterRect? {
        guard v != .null else { return nil }
        return RasterRect(x: v.get("x").i, y: v.get("y").i, width: v.get("width").i, height: v.get("height").i)
    }

    private func point(_ v: Vec2) -> [Double] { [v.x, v.y] }
    private func point(_ v: JSONValue) -> [Double] { [v.get("x").n, v.get("y").n] }

    private func surface(_ spec: JSONValue) -> TiledSurface {
        surfaceFromPixels(width: spec.get("width").i, height: spec.get("height").i, data: bytes(spec.get("data")), channels: spec.get("channels").i, x: spec.get("x").i, y: spec.get("y").i, defaultValue: spec.get("defaultValue").i)
    }

    private func effects(_ v: JSONValue) throws -> LayerEffects {
        LayerEffects(enabled: v.get("enabled").b, scale: v.get("scale").numberValue, items: try v.get("items").a.map { try LayerEffect(json: $0) })
    }

    private func buildLayer(_ s: JSONValue) -> RasterLayer {
        let mask = s.get("mask") == .null ? nil : RasterMask(
            surface: surface(s.get("mask").get("pixels")),
            defaultValue: s.get("mask").get("pixels").get("defaultValue").i,
            density: s.get("mask").get("density").numberValue,
            feather: s.get("mask").get("feather").numberValue,
            enabled: s.get("mask").get("enabled").boolValue
        )
        let edge = s.get("edge") == .null ? nil : LayerEdgeColor(ambient: s.get("edge").get("ambient").numberValue, ambientColor: s.get("edge").get("ambientColor").arrayValue?.map(\.n))
        let content: RasterLayer.Content
        if s.get("type").s == "group" {
            content = .group(children: s.get("children").a.map(buildLayer), collapsed: nil)
        } else {
            let offset = s.get("offset") == .null ? LayerOffset(x: 0, y: 0) : LayerOffset(x: s.get("offset").get("x").i, y: s.get("offset").get("y").i)
            content = .pixel(surface: s.get("pixels") == .null ? emptySurface(4) : surface(s.get("pixels")), offset: offset, fillOpacity: s.get("fillOpacity").numberValue)
        }
        return RasterLayer(
            id: s.get("id").s, name: s.get("id").s, visible: s.get("visible").boolValue ?? true, opacity: s.get("opacity").numberValue ?? 1,
            blend: GroupBlendMode(rawValue: s.get("blend").stringValue ?? "normal")!, clipped: s.get("clipped").boolValue ?? false,
            mask: mask, effects: s.get("effects") == .null ? nil : try! effects(s.get("effects")), edge: edge, content: content
        )
    }

    private func stats(_ s: CompositeStats) -> JSONValue {
        .object(JSONObject([("tiles", .number(Double(s.tiles))), ("cached", .number(Double(s.cached))), ("stepsRun", .number(Double(s.stepsRun))), ("effectsBuilt", .number(Double(s.effectsBuilt))), ("effectsPatched", .number(Double(s.effectsPatched)))]))
    }

    private func mappingOf(_ v: JSONValue) -> SurfaceMapping {
        SurfaceMapping(origin: v.get("origin") == .null ? nil : Vec2(x: v.get("origin").get("x").n, y: v.get("origin").get("y").n), pixelsPerUnit: v.get("pixelsPerUnit").numberValue)
    }

    private func viewOf(_ v: JSONValue) -> ViewTransform { ViewTransform(x: v.get("x").n, y: v.get("y").n, zoom: v.get("zoom").n) }

    private func ids(_ list: [Node]) -> JSONValue {
        .array(list.map { n in n.children.map { c in .array([.string(n.id), ids(c)]) } ?? .string(n.id) })
    }
}

/// An editor's own layer kinds (filter, fill, smart object) for the profile vectors.
final class TestLayer: CompositorLayer {
    let id: String
    let type: String
    let visible: Bool
    let opacity: Double
    let blend: GroupBlendMode
    let clipped: Bool
    let mask: RasterMask?
    let surface: PixelSurface?
    let offset: LayerOffset?
    let fillOpacity: Double?
    let effects: LayerEffects?
    let edge: LayerEdgeColor?
    let children: [TestLayer]?
    let color: [UInt8]?

    init(id: String, type: String, visible: Bool, opacity: Double, blend: GroupBlendMode, clipped: Bool, mask: RasterMask?, surface: PixelSurface?, offset: LayerOffset?, fillOpacity: Double?, effects: LayerEffects?, edge: LayerEdgeColor?, children: [TestLayer]?, color: [UInt8]?) {
        self.id = id
        self.type = type
        self.visible = visible
        self.opacity = opacity
        self.blend = blend
        self.clipped = clipped
        self.mask = mask
        self.surface = surface
        self.offset = offset
        self.fillOpacity = fillOpacity
        self.effects = effects
        self.edge = edge
        self.children = children
        self.color = color
    }

    func withChildren(_ children: [TestLayer]) -> TestLayer {
        TestLayer(id: id, type: type, visible: visible, opacity: opacity, blend: blend, clipped: clipped, mask: mask, surface: surface, offset: offset, fillOpacity: fillOpacity, effects: effects, edge: edge, children: children, color: color)
    }

    func solo(blend: GroupBlendMode, opacity: Double, clipped: Bool, edge: LayerEdgeColor?) -> TestLayer {
        TestLayer(id: id, type: type, visible: visible, opacity: opacity, blend: blend, clipped: clipped, mask: mask, surface: surface, offset: offset, fillOpacity: fillOpacity, effects: effects, edge: edge, children: children, color: color)
    }
}

/// A tree node for the layer helpers.
final class Node: RasterNode {
    let id: String
    let children: [Node]?
    var type: String { children == nil ? "pixel" : "group" }
    init(_ id: String, _ children: [Node]? = nil) {
        self.id = id
        self.children = children
    }
    func withChildren(_ children: [Node]) -> Node { Node(id, children) }
}

/// A tile image: the RGBA it was made from.
final class FakeImage {
    let data: [UInt8]
    init(_ data: [UInt8]) { self.data = data }
}

/// Records draw calls and an FNV-1a digest of each drawn image (as the TS test's fake context).
struct FakeDrawing: ViewportDrawing {
    var smoothing = false
    var calls: [[Int]] = []
    var images: [String] = []
    mutating func setImageSmoothing(_ enabled: Bool) { smoothing = enabled }
    mutating func drawImage(_ image: FakeImage, _ dx: Int, _ dy: Int, _ dw: Int, _ dh: Int) {
        calls.append([dx, dy, dw, dh])
        var h: UInt32 = 0x811C_9DC5
        for b in image.data { h = (h ^ UInt32(b)) &* 0x0100_0193 }
        images.append(String(h, radix: 16))
    }
}

extension JSONValue {
    /// A member (`null` when missing).
    func get(_ key: String) -> JSONValue { self[key] ?? .null }
    /// A number (`null`, as JSON writes NaN, reads as NaN).
    var n: Double { numberValue ?? .nan }
    var i: Int { Int(numberValue!) }
    var s: String { stringValue! }
    var b: Bool { boolValue! }
    var a: [JSONValue] { arrayValue! }
}
