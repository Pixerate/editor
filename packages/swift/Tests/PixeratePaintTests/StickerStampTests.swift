import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// `renderStickerStamp` (#738): one sticker stamp as the canvas draws it, checked against its own
/// canvas and against the TS core's vectors (`packages/core/tests/fixtures/swift-sticker-stamp-vectors.json`,
/// written by `swift-sticker-stamp-vectors.test.ts`).
final class StickerStampTests: XCTestCase {
    /// The TS tests' `syntheticArt` (`packages/core/tests/helpers/sticker-art.ts`).
    private func syntheticArt(_ width: Int, _ height: Int, _ frames: Int, _ tintable: Bool) -> StickerArt {
        let all: [[UInt8]] = (0..<frames).map { f in
            var d = [UInt8](repeating: 0, count: width * height * 4)
            for y in 0..<height {
                for x in 0..<width {
                    let i = (y * width + x) * 4
                    let a = (x + y + f) % 4 == 0 ? 0 : (x * 37 + y * 11 + f * 53) % 256
                    d[i + 3] = UInt8(a)
                    if a == 0 { continue }
                    d[i] = UInt8((x * 20 + f * 40) % 256)
                    d[i + 1] = UInt8((y * 30 + f * 7) % 256)
                    d[i + 2] = UInt8((x * y * 7 + f * 50) % 256)
                }
            }
            return d
        }
        return StickerArt(width: width, height: height, data: all[0], tintable: tintable, frames: frames > 1 ? all : nil, frameDelay: frames > 1 ? 100 : nil)
    }

    private func load(_ ref: String, dark: Bool = false) throws -> StickerArt {
        try XCTUnwrap(StickerArtCache().ensure(createFakeStickerProvider(), ref, dark: dark))
    }

    private func pixel(_ s: (width: Int, height: Int, data: [UInt8]), _ x: Int, _ y: Int) -> [UInt8] {
        Array(s.data[((y * s.width + x) * 4)..<((y * s.width + x) * 4 + 4)])
    }

    func testTintableIsTheColourWithTheArtsAlpha() throws {
        let art = try load("fake:weather-sun")
        let stamp = renderStickerStamp(art, colour: "#3366CC", size: 40)
        XCTAssertEqual(stamp.width, 40)
        XCTAssertEqual(stamp.data.count, 40 * 40 * 4)
        let own = renderStickerStamp(StickerArt(width: art.width, height: art.height, data: art.data, tintable: false), colour: "#3366cc", size: 40)
        var painted = 0
        for i in stride(from: 0, to: stamp.data.count, by: 4) {
            XCTAssertEqual(stamp.data[i + 3], own.data[i + 3])
            if stamp.data[i + 3] == 0 { continue }
            painted += 1
            XCTAssertEqual(Array(stamp.data[i..<(i + 3)]), [0x33, 0x66, 0xcc])
        }
        XCTAssertGreaterThan(painted, 600)
    }

    func testNonTintableKeepsItsPixels() throws {
        let art = try load("fake:fruit-apple")
        let a = renderStickerStamp(art, colour: "#00ff00", size: 32)
        XCTAssertEqual(renderStickerStamp(art, colour: "#123456", size: 32).data, a.data)
        XCTAssertEqual(pixel(a, 16, 8), [0x16, 0x65, 0x34, 255])
        XCTAssertEqual(pixel(a, 16, 24), [0xdc, 0x26, 0x26, 255])
        let exact = syntheticArt(10, 10, 1, false)
        XCTAssertEqual(renderStickerStamp(exact, colour: "#000000", size: 10).data, exact.data)
    }

    func testFramesWrap() throws {
        let art = try load("fake:weather-wind")
        XCTAssertEqual(art.frames?.count, 4)
        func f(_ frame: Int) -> [UInt8] { renderStickerStamp(art, colour: "#14b8a6", size: 36, frame: frame).data }
        XCTAssertNotEqual(f(1), f(0))
        XCTAssertEqual(f(4), f(0))
        XCTAssertEqual(f(5), f(1))
        XCTAssertEqual(f(-1), f(3))
        XCTAssertEqual(f(-4), f(0))
        XCTAssertEqual(stickerArtFrame(art, -1), art.frames![3])
        XCTAssertEqual(stickerArtFrame(art, nil), art.data)
        let sun = try load("fake:weather-sun")
        XCTAssertEqual(renderStickerStamp(sun, colour: "#14b8a6", size: 36, frame: 3).data, renderStickerStamp(sun, colour: "#14b8a6", size: 36).data)
    }

    func testRotationIsClockwiseAboutTheCentre() {
        let art = syntheticArt(10, 10, 1, false)
        func delta(_ a: [UInt8], _ b: [UInt8]) -> Int {
            var m = 0
            for i in stride(from: 0, to: a.count, by: 4) where !(a[i + 3] == 0 && b[i + 3] == 0) {
                for k in 0..<4 { m = max(m, abs(Int(a[i + k]) - Int(b[i + k]))) }
            }
            return m
        }
        var flipped = [UInt8](repeating: 0, count: art.data.count)
        var turned = [UInt8](repeating: 0, count: art.data.count)
        for y in 0..<10 {
            for x in 0..<10 {
                for k in 0..<4 {
                    flipped[((9 - y) * 10 + (9 - x)) * 4 + k] = art.data[(y * 10 + x) * 4 + k]
                    turned[(x * 10 + (9 - y)) * 4 + k] = art.data[(y * 10 + x) * 4 + k]
                }
            }
        }
        XCTAssertLessThanOrEqual(delta(renderStickerStamp(art, colour: "#000000", size: 10, rotation: 180).data, flipped), 1)
        XCTAssertLessThanOrEqual(delta(renderStickerStamp(art, colour: "#000000", size: 10, rotation: 90).data, turned), 1)
        XCTAssertEqual(renderStickerStamp(art, colour: "#000000", size: 10, rotation: .nan).data, art.data)
    }

    func testEmptySizesAndInvalidColours() {
        let art = syntheticArt(12, 8, 1, true)
        for size in [0, -3] {
            let s = renderStickerStamp(art, colour: "#ffffff", size: size)
            XCTAssertEqual(s.width, 0)
            XCTAssertEqual(s.height, 0)
            XCTAssertTrue(s.data.isEmpty)
        }
        let black = renderStickerStamp(art, colour: "#000000", size: 16).data
        XCTAssertEqual(renderStickerStamp(art, colour: "red", size: 16).data, black)
        XCTAssertEqual(renderStickerStamp(art, colour: "#fff", size: 16).data, black)
    }

    /// The stamp is the canvas's own pixels: stickers added to a layer read back the same bytes.
    func testStampMatchesTheCanvas() throws {
        let c = try PaintEditorController(width: 160, height: 80, stickers: createFakeStickerProvider())
        let cases: [(ref: String, x: Int, y: Int, size: Int, rotation: Double, color: String, frame: Int)] = [
            ("fake:weather-sun", 10, 6, 40, 0, "#3366cc", 0),
            ("fake:fruit-apple", 60, 9, 33, 30, "#3366cc", 0),
            ("fake:weather-wind", 104, 20, 41, -45, "#e11d48", 2),
        ]
        try c.prepareStickers(cases.map(\.ref))
        _ = try c.addStickers(nil, cases.map { s in
            var o: JSONObject = [
                "ref": .string(s.ref), "x": .number(Double(s.x) + Double(s.size) / 2), "y": .number(Double(s.y) + Double(s.size) / 2),
                "size": .number(Double(s.size)), "rotation": .number(s.rotation), "color": .string(s.color),
            ]
            if s.frame != 0 { o["frame"] = .number(Double(s.frame)) }
            return o
        })
        let surface = findLayer(c.doc.layers, c.doc.activeLayerId!)!.layer.pixelSurface
        for s in cases {
            let art = try XCTUnwrap(c.stickerArt.get(s.ref))
            let stamp = renderStickerStamp(art, colour: s.color, size: s.size, frame: s.frame, rotation: s.rotation)
            XCTAssertEqual(stamp.data, readRegion(surface, RasterRect(x: s.x, y: s.y, width: s.size, height: s.size)), s.ref)
        }
    }

    func testProviderOverload() throws {
        let cache = StickerArtCache()
        let stamp = try renderStickerStamp(createFakeStickerProvider(), ref: "fake:fruit-apple", colour: "#000000", size: 24, cache: cache)
        XCTAssertEqual(cache.status("fake:fruit-apple").status, "ready")
        XCTAssertEqual(stamp.data, renderStickerStamp(try XCTUnwrap(cache.get("fake:fruit-apple")), colour: "#000000", size: 24).data)
        let dark = try renderStickerStamp(createFakeStickerProvider(), ref: "fake:fruit-apple", colour: "#000000", size: 24, dark: true)
        XCTAssertEqual(Array(pixel(dark, 12, 6).prefix(3)), [0xf8, 0xfa, 0xfc])
        XCTAssertThrowsError(try renderStickerStamp(createFakeStickerProvider(), ref: "fake:nope", colour: "#000000", size: 8)) { err in
            XCTAssertTrue("\(err)".contains("No sticker \"fake:nope\""), "\(err)")
        }
    }

    func testMatchesTheTSCore() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../core/tests/fixtures/swift-sticker-stamp-vectors.json")
        let root = try JSONValue.parse(Data(contentsOf: url))
        guard case .array(let cases)? = root.objectValue?["cases"] else { return XCTFail("no cases") }
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        let fake = createFakeStickerProvider()
        for v in cases {
            let o = try XCTUnwrap(v.objectValue)
            let name = o["name"]?.stringValue ?? "?"
            let colour = o["colour"]?.stringValue ?? ""
            let size = Int(o["size"]?.numberValue ?? 0)
            let frame = Int(o["frame"]?.numberValue ?? 0)
            let rotation = o["rotation"]?.numberValue ?? 0
            let stamp: (width: Int, height: Int, data: [UInt8])
            if let syn = o["synthetic"]?.objectValue {
                let art = syntheticArt(Int(syn["width"]?.numberValue ?? 0), Int(syn["height"]?.numberValue ?? 0), Int(syn["frames"]?.numberValue ?? 1), syn["tintable"]?.boolValue ?? false)
                stamp = renderStickerStamp(art, colour: colour, size: size, frame: frame, rotation: rotation)
            } else {
                stamp = try renderStickerStamp(fake, ref: o["ref"]?.stringValue ?? "", colour: colour, size: size, frame: frame, rotation: rotation, dark: o["dark"]?.boolValue ?? false)
            }
            XCTAssertEqual(stamp.width, Int(o["width"]?.numberValue ?? -1), name)
            XCTAssertEqual(stamp.height, Int(o["height"]?.numberValue ?? -1), name)
            let want = [UInt8](Data(base64Encoded: o["data"]?.stringValue ?? "") ?? Data())
            XCTAssertEqual(stamp.data.count, want.count, name)
            if stamp.data != want {
                let delta = zip(stamp.data, want).map { abs(Int($0) - Int($1)) }.max() ?? 0
                XCTFail("\(name): bytes differ from TS (max delta \(delta))")
            }
        }
    }
}
