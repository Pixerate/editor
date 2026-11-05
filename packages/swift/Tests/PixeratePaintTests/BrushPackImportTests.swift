import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Brush pack import (#646): the `.abr`, ZIP and binary plist readers and the mapping to brushes
/// and sources, on the fixture packs the TS tests read (`packages/core/tests/fixtures/brush-packs`,
/// written by `tests/helpers/brush-packs.ts`), and `import_brush_pack` through the registry.
final class BrushPackImportTests: XCTestCase {
    private func fixture(_ name: String) throws -> [UInt8] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../core/tests/fixtures/brush-packs/\(name)")
        return [UInt8](try Data(contentsOf: url))
    }

    /// `tipMask` of the TS helpers: a disc with a notch on its right.
    private func tipMask(_ w: Int, _ h: Int) -> [UInt8] {
        var m = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let d = JS.hypot(Double(x) - Double(w - 1) / 2, Double(y) - Double(h - 1) / 2) / (Double(Swift.min(w, h)) / 2)
                m[y * w + x] = d < 0.9 && !(Double(x) > Double(w) * 0.7 && abs(Double(y) - Double(h) / 2) < Double(h) * 0.15) ? 255 : 0
            }
        }
        return m
    }

    func testAbrVersion2SampledAndComputedTips() throws {
        let f = try readAbr(try fixture("tiny-v2.abr"))
        XCTAssertEqual(f.version, 2)
        XCTAssertEqual(f.tips.map(\.name), ["Notched", "Raw", nil])
        guard case .sampled(_, let w, let h, let mask, let spacing) = f.tips[0], case .sampled(_, 9, 9, let raw, _) = f.tips[1] else { return XCTFail("not sampled") }
        XCTAssertEqual([Double(w), Double(h), spacing ?? 0], [20, 16, 0.3])
        XCTAssertEqual(mask, tipMask(20, 16))
        XCTAssertEqual(raw, tipMask(9, 9))
        XCTAssertEqual(f.tips[2], .computed(name: nil, diameter: 30, roundness: 0.6, angle: 45, hardness: 0.8, spacing: 0.15))
    }

    func testAbrVersion6NamesSpacingAndPatterns() throws {
        let f = try readAbr(try fixture("tiny-v6.abr"))
        let read = f.tips.compactMap { t -> String? in
            guard case .sampled(let n, let w, let h, _, let s) = t else { return nil }
            return "\(n ?? "-") \(w)×\(h) \(s.map { jsText($0) } ?? "-")"
        }
        XCTAssertEqual(read, ["Dry stamp 24×24 0.4", "Dot 10×12 1.2"])
        if case .sampled(_, _, _, let mask, _) = f.tips[0] { XCTAssertEqual(mask, tipMask(24, 24)) }
        XCTAssertTrue(f.unsupported.joined(separator: " ").contains("Patterns (the brushes' textures) are not imported"))
    }

    func testAbrRefusesWhatIsNotABrushFileAndSurvivesTruncation() throws {
        XCTAssertThrowsError(try readAbr([])) { XCTAssertEqual(($0 as? AbrError)?.message, "Not a brush file: it is empty.") }
        XCTAssertThrowsError(try readAbr([0, 3, 0, 0])) { XCTAssertTrue(($0 as? AbrError)?.message.contains("version 3") == true) }
        let good = try fixture("tiny-v2.abr")
        // Cut anywhere: either the tips before the cut are kept (and the rest reported), or the file is refused.
        for n in stride(from: 2, to: good.count, by: 7) {
            do {
                let f = try readAbr(Array(good.prefix(n)))
                XCTAssertGreaterThan(f.tips.count + f.unsupported.count, 0)
            } catch {
                XCTAssertTrue(error is AbrError, "\(error)")
            }
        }
    }

    func testZipAndKeyedArchive() throws {
        let entries = try readZip(try fixture("test-set.brushset"))
        XCTAssertTrue(entries.map(\.name).contains("A1/Shape.png"))
        let archive = try XCTUnwrap(entries.first { $0.name == "A1/Brush.archive" }).read()
        let root = try XCTUnwrap(keyedArchiveRoot(try readBinaryPlist(archive)))
        XCTAssertEqual(root["name"], .string("Dry ink"))
        XCTAssertEqual(root["plotSpacing"], .number(0.15))
        XCTAssertThrowsError(try readZip([UInt8](repeating: 0, count: 100))) { XCTAssertEqual(($0 as? ZipError)?.message, "Not a ZIP archive: no end of central directory.") }
        XCTAssertThrowsError(try readBinaryPlist([UInt8](repeating: 0, count: 10))) { XCTAssertEqual(($0 as? PlistError)?.message, "Not a binary property list.") }
    }

    func testBrushsetMapsShapesGrainNamesSpacingAndLicence() throws {
        let pack = try readBrushPack(try fixture("test-set.brushset"), fileName: "Test set.brushset", licence: "Personal use only.")
        XCTAssertEqual(pack.format, "brushset")
        XCTAssertEqual(pack.brushes.map { JSONValue.object($0) }, [
            ["id": "test-set-dry-ink", "name": "Dry ink", "kind": "mark", "tags": ["imported", "procreate"], "description": "Imported from Test set.", "tip": ["shape": "stamp", "size": 40, "spacing": 0.15, "stamps": ["source:test-set-dry-ink-shape"], "grain": ["source": "source:test-set-dry-ink-grain", "mode": "moving"]]],
            ["id": "test-set-soft-round", "name": "Soft round", "kind": "mark", "tags": ["imported", "procreate"], "description": "Imported from Test set.", "tip": ["shape": "stamp", "size": 40, "spacing": 0.05, "stamps": ["source:test-set-soft-round-shape"]]],
        ])
        XCTAssertEqual(pack.sources.map(\.id), ["test-set-dry-ink-shape", "test-set-dry-ink-grain", "test-set-soft-round-shape"])
        XCTAssertEqual(pack.licence, ["Personal use only.", "LICENSE: Made for the Pixerate tests. CC0: no rights reserved."])
        XCTAssertEqual(pack.sources[0].licence, "Personal use only.\n\nLICENSE: Made for the Pixerate tests. CC0: no rights reserved.")
        XCTAssertEqual(pack.sources[0].origin, "Test set/A1/Shape.png")
        // White on black: the white marks paint.
        let shape = try decodeBrushSource(pack.sources[0].image)
        XCTAssertEqual(shape.mask[12 * 24 + 12], 255)
        XCTAssertEqual(shape.mask[0], 0)
        XCTAssertTrue(pack.unsupported.joined(separator: " ").contains("not mapped"))
        var problems: [String] = []
        for b in pack.brushes { XCTAssertNoThrow(try normalizeBrushSpec(.object(b), &problems)) }
    }

    func testSingleBrushAndBothAbrVersions() throws {
        let leafy = try readBrushPack(try fixture("leafy.brush"), fileName: "leafy.brush")
        XCTAssertEqual(leafy.brushes.map { [$0["id"], $0["name"], $0.path("tip.spacing")] }, [["leafy-leafy", "Leafy", 0.4]])
        let v2 = try readBrushPack(try fixture("tiny-v2.abr"), fileName: "Tiny.abr", prefix: "ink")
        XCTAssertEqual(v2.brushes.map { [$0["id"], $0["name"], $0.path("tip.shape"), $0.path("tip.size")] }, [["ink-notched", "Notched", "stamp", 20], ["ink-raw", "Raw", "stamp", 9], ["ink-3", "Tiny 3", "flat", 30]])
        // Spacing 0 in the file: the default.
        XCTAssertEqual(v2.brushes[1].path("tip.spacing"), 0.25)
        XCTAssertEqual(try readBrushPack(try fixture("tiny-v6.abr"), fileName: "tiny-v6.abr").brushes.compactMap { $0["id"]?.stringValue }, ["tiny-v6-dry-stamp", "tiny-v6-dot"])
    }

    func testCorruptedPacksFailWithABrushPackErrorNeverACrash() throws {
        for name in ["leafy.brush", "test-set.brushset", "tiny-v2.abr", "tiny-v6.abr"] {
            let good = try fixture(name)
            // The TS test's generator, so both corrupt the same bytes.
            var seed = 7
            func rand() -> Double {
                seed = (seed &* 1_103_515_245 &+ 12345) & 0x7FFF_FFFF
                return Double(seed) / Double(0x7FFF_FFFF)
            }
            for round in 0..<150 {
                var bad = good
                for _ in 0..<(1 + round % 6) { bad[Swift.min(bad.count - 1, Int(rand() * Double(bad.count)))] = UInt8(Swift.min(255, Int(rand() * 256))) }
                do {
                    let pack = try readBrushPack(bad, fileName: name)
                    var problems: [String] = []
                    for b in pack.brushes { _ = try? normalizeBrushSpec(.object(b), &problems) }
                } catch {
                    XCTAssertTrue(error is BrushPackError, "\(name) round \(round): \(error)")
                }
            }
        }
    }

    func testRefusalsSayWhatToGive() {
        XCTAssertThrowsError(try readBrushPack(Array("hello".utf8), fileName: "notes.txt")) { XCTAssertTrue(($0 as? BrushPackError)?.message.contains(".abr (Photoshop), .brush or .brushset (Procreate)") == true) }
        XCTAssertThrowsError(try readBrushPack([0, 0, 0, 0], fileName: "x.brushset")) { XCTAssertTrue(($0 as? BrushPackError)?.message.contains("can't be read as a Procreate brush pack") == true) }
    }

    func testImportBrushPackThroughTheRegistry() async throws {
        let host = try PaintConformanceHost(setup: ["width": 48, "height": 32])
        let abr = await host.callTool("import_brush_pack", ["file": .string(bytesToBase64(try fixture("tiny-v6.abr"))), "fileName": "tiny-v6.abr", "licence": "Bought for personal use."])
        XCTAssertFalse(abr.isError, "\(abr.content)")
        let s = try XCTUnwrap(abr.structuredContent)
        XCTAssertEqual(s["format"], "abr")
        XCTAssertEqual(s["brushes"], [["id": "tiny-v6-dry-stamp", "name": "Dry stamp", "renderable": true], ["id": "tiny-v6-dot", "name": "Dot", "renderable": true]])
        XCTAssertEqual(s["sources"], ["tiny-v6-dry-stamp-shape", "tiny-v6-dot-shape"])
        XCTAssertEqual(s["licence"], ["Bought for personal use."])
        XCTAssertEqual(host.controller.brushLibrary.getSource("tiny-v6-dot-shape")?.licence, "Bought for personal use.")
        let set = await host.callTool("import_brush_pack", ["file": .string("data:application/octet-stream;base64,\(bytesToBase64(try fixture("test-set.brushset")))"), "fileName": "Test set.brushset"])
        XCTAssertEqual(set.structuredContent?["brushes"]?.arrayValue?.compactMap { $0.objectValue?["id"]?.stringValue }, ["test-set-dry-ink", "test-set-soft-round"])
        // Again: the ids are taken, so they are skipped.
        let again = await host.callTool("import_brush_pack", ["file": .string(bytesToBase64(try fixture("test-set.brushset"))), "fileName": "Test set.brushset"])
        XCTAssertEqual(again.structuredContent?["skipped"], ["test-set-dry-ink", "test-set-soft-round"])
        // The imported brush paints with its image tip and its grain.
        let r = try host.controller.paintStroke(PaintStrokeInit(brushId: "test-set-dry-ink", seed: 1), points: [PenPoint(x: 4, y: 16), PenPoint(x: 44, y: 16)])
        XCTAssertGreaterThan(r.dabs, 5)
        XCTAssertEqual(host.controller.getBrush("test-set-dry-ink")?.tipGrain?.source, "source:test-set-dry-ink-grain")
    }

    func testImportRefusesBadInputImportingNothing() async throws {
        let host = try PaintConformanceHost(setup: ["width": 16, "height": 16])
        let notBase64 = await host.callTool("import_brush_pack", ["file": "%%%%", "fileName": "a.abr"])
        XCTAssertTrue(notBase64.isError)
        XCTAssertTrue(notBase64.structuredContent?["error"]?.objectValue?["message"]?.stringValue?.contains("not base64") == true)
        let notPack = await host.callTool("import_brush_pack", ["file": .string(bytesToBase64(Array("hello there".utf8))), "fileName": "readme.txt"])
        XCTAssertTrue(notPack.isError)
        XCTAssertTrue(notPack.structuredContent?["error"]?.objectValue?["message"]?.stringValue?.hasSuffix("Nothing was imported.") == true)
        let badFormat = await host.callTool("import_brush_pack", ["file": "AAAA", "fileName": "a.abr", "format": "psd"])
        XCTAssertTrue(badFormat.isError)
        let noName = await host.callTool("import_brush_pack", ["file": "AAAA"])
        XCTAssertTrue(noName.isError)
        XCTAssertTrue(host.controller.brushLibrary.list(BrushFilter(source: "user")).isEmpty)
        XCTAssertTrue(host.controller.brushLibrary.listSources().isEmpty)
    }
}
