import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Image brush sources, stamp tips and tip grain (#646): the library, its tools through the
/// registry, and what strokes and saved paintings do with them. The pixels are checked against the
/// TS core by the `brush-tips-and-grain` and `stamp-tips` paint scenarios.
final class BrushSourceTests: XCTestCase {
    /// A `w`×`h` RGBA PNG data URL: a dark square in the middle of white paper, or of nothing with `transparent`.
    private func pngURL(_ w: Int, _ h: Int, transparent: Bool = false) -> String {
        var data = [UInt8](repeating: 0, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let inside = x >= w / 4 && x < 3 * w / 4 && y >= h / 4 && y < 3 * h / 4
                let i = (y * w + x) * 4
                if transparent {
                    data[i + 3] = inside ? 255 : 0
                } else {
                    let v: UInt8 = inside ? 0 : 255
                    data[i] = v
                    data[i + 1] = v
                    data[i + 2] = v
                    data[i + 3] = 255
                }
            }
        }
        return pngDataUrl(w, h, data)
    }

    func testMakeBrushSourceReadsTheChannelAndScales() throws {
        var problems: [String] = []
        let s = try makeBrushSource(BrushSourceInput(name: "Big Scan!", image: pngURL(1024, 512)), &problems)
        XCTAssertEqual(s.id, "big-scan")
        XCTAssertEqual([s.width, s.height], [512, 256])
        XCTAssertEqual(problems, ["channel auto read the marks from the dark parts (dark marks on a light background).", "The image was scaled from 1024×512 to 512×256 (sources are kept at most 512 px)."])
        let mask = try decodeBrushSource(s.image)
        XCTAssertEqual(mask.mask[128 * 512 + 256], 255)
        XCTAssertEqual(mask.mask[0], 0)

        problems = []
        let alpha = try makeBrushSource(BrushSourceInput(name: "Cut-out", image: pngURL(8, 8, transparent: true), invert: true), &problems)
        XCTAssertEqual(problems, ["channel auto read the marks from the transparency."])
        XCTAssertEqual(try decodeBrushSource(alpha.image).mask[0], 255)

        XCTAssertThrowsError(try makeBrushSource(BrushSourceInput(name: "Blank", image: pngDataUrl(4, 4, [UInt8](repeating: 255, count: 64)), channel: "darkness"), &problems)) { e in
            XCTAssertEqual((e as? BrushSourceError)?.message, "\"Blank\" has no marks: every pixel is empty. Pick another channel (alpha, darkness or lightness) or set invert.")
        }
        XCTAssertThrowsError(try makeBrushSource(BrushSourceInput(name: "Text", image: "data:text/plain;base64,aGVsbG8="), &problems)) { e in
            XCTAssertTrue((e as? BrushSourceError)?.message.hasPrefix("The image can't be read as a PNG (") == true)
        }
    }

    func testReadBrushSourceSkipsBadEntries() {
        var problems: [String] = []
        XCTAssertNil(readBrushSource(["id": "x", "width": 0, "height": 4, "image": "data:image/png;base64,AA=="], "sources[0]", &problems))
        XCTAssertNil(readBrushSource(["id": "Bad Id"], "sources[1]", &problems))
        XCTAssertNotNil(readBrushSource(["id": "ok", "name": "  ", "width": 4, "height": 4, "image": "data:image/png;base64,AA=="], "sources[2]", &problems))
        XCTAssertEqual(problems, ["sources[0] (\"x\") has no valid width and height (1..512); skipped.", "sources[1] has no valid id; skipped."])
    }

    func testLibraryFilesCarryTheSourcesTheirBrushesUse() throws {
        let library = BrushLibrary()
        let added = try library.addSource(BrushSourceInput(name: "Dot", image: pngURL(8, 8)))
        XCTAssertFalse(added.replaced)
        _ = try library.addSource(BrushSourceInput(name: "Dot", image: pngURL(6, 6)))
        XCTAssertEqual(library.listSources().map(\.id), ["dot", "dot-2"])
        XCTAssertThrowsError(try library.addSource(BrushSourceInput(id: "dot", name: "Dot", image: pngURL(6, 6)))) { e in
            XCTAssertEqual((e as? BrushLibraryError)?.code, .exists)
        }
        _ = try library.save(["id": "dotty", "name": "Dotty", "kind": "mark", "tip": ["shape": "stamp", "stamps": ["source:dot"]]])
        let file = try library.exportFile()
        XCTAssertEqual(file["sources"]?.arrayValue?.compactMap { $0.objectValue?["id"]?.stringValue }, ["dot"])

        let other = BrushLibrary()
        let r = try other.importFile(.object(file))
        XCTAssertEqual(r.added, ["dotty"])
        XCTAssertEqual(r.sources, ["dot"])
        XCTAssertEqual(other.getSource("dot")?.image, library.getSource("dot")?.image)
        // Importing it again changes nothing: the same image is no change.
        XCTAssertNil(try other.importFile(.object(file)).sources)
    }

    func testSourceToolsThroughTheRegistry() async throws {
        let host = try PaintConformanceHost(setup: ["width": 32, "height": 32])
        let added = await host.callTool("add_brush_source", ["name": "Scan", "image": .string(pngURL(12, 12)), "origin": "test pack"])
        XCTAssertFalse(added.isError)
        XCTAssertEqual(added.structuredContent?["ref"], "source:scan")
        XCTAssertEqual(added.structuredContent?["replaced"], false)

        let bad = await host.callTool("add_brush_source", ["name": "Scan", "image": "data:image/png;base64,AAAA"])
        XCTAssertTrue(bad.isError)

        let made = await host.callTool("create_brush", ["id": "scan-tip", "name": "Scan tip", "kind": "mark", "tip": ["shape": "stamp", "size": 8, "stamps": ["source:scan"], "grain": ["source": "source:scan", "mode": "moving"]], "dynamics": ["count": 3, "flip": "xy"]])
        XCTAssertFalse(made.isError, "\(made.content)")
        let missing = await host.callTool("create_brush", ["id": "no-grain", "name": "No grain", "kind": "mark", "tip": ["shape": "round", "grain": ["source": "source:scab"]]])
        XCTAssertTrue(missing.isError)
        XCTAssertEqual(missing.structuredContent?["error"]?.objectValue?["message"], "Paint editor can't use this brush: tip.grain.source: There is no image source \"scab\" in the brush library. Closest: scan. Add it with add_brush_source, or use a ref list_brush_sources lists. (check_brush lists every issue; nothing was saved.)")

        let listed = await host.callTool("list_brush_sources", ["text": "test"])
        XCTAssertEqual(listed.structuredContent?["total"], 1)
        XCTAssertEqual(listed.structuredContent?["sources"]?.arrayValue?.first?.objectValue?["usedBy"], ["scan-tip"])
        let none = await host.callTool("list_brush_sources", ["text": "charcoal"])
        XCTAssertEqual(none.structuredContent?["total"], 0)

        // A grain on a particle brush is dropped with the reason.
        let particles = await host.callTool("create_brush", ["id": "dots", "name": "Dots", "kind": "mark", "tip": ["shape": "round", "grain": ["source": "rough"]], "marks": ["kind": "particles"]])
        XCTAssertEqual(particles.structuredContent?["problems"], ["tip.grain dropped: particles marks are not dabs."])
    }

    func testStrokesWithImageTipsAreSavedWithTheirSources() async throws {
        let host = try PaintConformanceHost(setup: ["width": 32, "height": 32])
        _ = await host.callTool("add_brush_source", ["name": "Scan", "image": .string(pngURL(12, 12))])
        _ = await host.callTool("create_brush", ["id": "scan-tip", "name": "Scan tip", "kind": "mark", "tip": ["shape": "stamp", "size": 8, "stamps": ["source:scan"]], "dynamics": ["count": 2]])
        let c = host.controller
        let r = try c.paintStroke(PaintStrokeInit(brushId: "scan-tip", seed: 3), points: [PenPoint(x: 4, y: 4), PenPoint(x: 28, y: 20)])
        XCTAssertNotNil(r.bounds)
        // Two dabs at every spacing step.
        XCTAssertEqual(r.dabs % 2, 0)
        let saved = c.toJSON()
        XCTAssertEqual(saved["brushSources"]?.arrayValue?.compactMap { $0.objectValue?["id"]?.stringValue }, ["scan"])
        XCTAssertEqual(saved["strokes"]?.arrayValue?.first?.objectValue?["brush"]?.objectValue?["dynamics"]?.objectValue?["count"], 2)
        // A repaint target draws with the same sources.
        XCTAssertNotNil(try c.createReplayTarget().brushSources.source("scan"))
    }

    func testHostStickerStampsAreRefusedWithTheReason() throws {
        let c = try PaintEditorController(width: 32, height: 32)
        var brush = c.brush
        brush.stamp = "openmoji:1f600"
        XCTAssertFalse(c.canPaint(brush))
        brush.stamp = "source:anything"
        XCTAssertTrue(c.canPaint(brush))
        brush.stamp = "editor:star"
        XCTAssertTrue(c.canPaint(brush))
        // A host library's sticker paints once that library is set, unless its art failed to load.
        let f = try PaintEditorController(width: 32, height: 32, stickers: try combineStickerProviders([editorStickers(), createFakeStickerProvider(FakeStickerProviderOptions(failIds: ["badge-sale"]))]))
        var b = f.brush
        b.stamp = "fake:weather-wind"
        XCTAssertTrue(f.canPaint(b))
        b.stamp = "fake:no-such-sticker"
        XCTAssertFalse(f.canPaint(b))
        b.stamp = "openmoji:1f600"
        XCTAssertFalse(f.canPaint(b))
        b.stamp = "fake:badge-sale"
        XCTAssertTrue(f.canPaint(b))
        XCTAssertThrowsError(try f.prepareStickers(["fake:badge-sale"]))
        XCTAssertFalse(f.canPaint(b))
    }
}
