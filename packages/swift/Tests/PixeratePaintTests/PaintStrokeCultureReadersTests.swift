import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// `normalizeBrushStroke` and `culturesExtensionFromJSON` read back what `strokeToJSON` and
/// `culturesJSON` write (write → read → write gives the same JSON), and drop or report what they
/// cannot read with the TS core's wording.
final class PaintStrokeCultureReadersTests: XCTestCase {
    private func line(_ y: Double, pressure: Double = 0.7) -> [PenPoint] {
        (0..<8).map { PenPoint(x: 20 + Double($0) * 12, y: y + Double($0 % 3), pressure: pressure, t: Double($0) * 16) }
    }

    private func assertRoundTrips(_ stroke: RecordedStroke, file: StaticString = #filePath, line: UInt = #line) {
        let saved = strokeToJSON(stroke)
        guard let back = normalizeBrushStroke(saved) else { return XCTFail("\(stroke.brush.id) did not read back", file: file, line: line) }
        XCTAssertEqual(strokeToJSON(back), saved, "\(stroke.brush.id)", file: file, line: line)
    }

    func testPaintedStrokesRoundTrip() throws {
        let c = try PaintEditorController(width: 160, height: 160)
        let under = try c.addLayer(name: "Under")
        _ = try c.paintStroke(PaintStrokeInit(layerId: under.id, color: "#3366aa", brushId: "marker", seed: 1), points: line(30))
        _ = try c.addLayer(name: "Top")
        var y = 40.0
        for id in ["ink-pen", "paint-scraper", "pencil-hb", "gradient-round", "pressure-ombre", "mixer-brush", "watercolor-round", "bristle-round", "sparkle-dust", "mycelial-ink", "antimatter", "vortex"] {
            _ = try c.paintStroke(PaintStrokeInit(color: "#aa3311", brushId: id, seed: Int(y)), points: line(y))
            y += 8
        }
        // Mirror copies and mask stencils are recorded with the stroke.
        var mirrored = PaintStrokeInit(color: "#118844", brushId: "marker", seed: 9, copies: [[-1, 0, 0, 1, 160, 0]])
        mirrored.maskStencils = [try normalizeStencil(["kind": "shape", "shape": "rect", "mode": "mask", "rect": ["x": 0, "y": 0, "width": 120, "height": 120]], "st1")]
        _ = try c.paintStroke(mirrored, points: line(100))
        let strokes = c.strokes
        XCTAssertEqual(strokes.count, 14)
        for s in strokes { assertRoundTrips(s) }
        // The engines' recorded fields survive.
        let byBrush = Dictionary(strokes.map { ($0.brush.id, $0) }, uniquingKeysWith: { a, _ in a })
        XCTAssertNotNil(byBrush["mixer-brush"]?.load)
        XCTAssertNotNil(byBrush["antimatter"]?.targets)
        XCTAssertNotNil(byBrush["watercolor-round"]?.steps)
        XCTAssertNotNil(byBrush["gradient-round"]?.paint)
        XCTAssertNotNil(strokes.last?.copies)
        XCTAssertNotNil(strokes.last?.stencils)
        // The brush reads back as the engine painted it (the built-in flag is not saved).
        for id in ["paint-scraper", "gradient-round", "watercolor-round", "mycelial-ink", "vortex"] {
            let s = try XCTUnwrap(byBrush[id])
            let back = try XCTUnwrap(normalizeBrushStroke(strokeToJSON(s)))
            XCTAssertEqual(back.brush.json(builtin: false), s.brush.json(builtin: false), id)
        }
        // Scraper strokes keep the layers they cut through.
        var scraped = try XCTUnwrap(strokeToJSON(byBrush["paint-scraper"]!).objectValue)
        scraped["scrapeLayerIds"] = [.string(under.id), "other"]
        let back = try XCTUnwrap(normalizeBrushStroke(.object(scraped)))
        XCTAssertEqual(back.scrapeLayerIds, [under.id, "other"])
        assertRoundTrips(back)
    }

    func testDualColourAndEffectPaintRoundTrip() throws {
        let c = try PaintEditorController(width: 120, height: 120)
        _ = try c.paintStroke(PaintStrokeInit(color: "#123456", brushId: "ink-pen", seed: 3), points: line(40))
        var o = try XCTUnwrap(strokeToJSON(c.strokes[0]).objectValue)
        o["dualColor"] = ["light": "#123456", "dark": "#ABCDEF"]
        o["paint"] = ["type": "effect", "effect": "plasma", "provider": "flair", "values": ["speed": 2], "time": 1.5, "live": true]
        let s = try XCTUnwrap(normalizeBrushStroke(.object(o)))
        XCTAssertEqual(s.dualColor, PaintDualColor(light: "#123456", dark: "#abcdef"))
        XCTAssertEqual(s.effect?.effect, "plasma")
        XCTAssertNil(s.paint)
        assertRoundTrips(s)
        // light-dark() and short hex normalise; a translucent side is dropped, as TS drops it.
        o["dualColor"] = "light-dark(#fff, #000000)"
        XCTAssertEqual(normalizeBrushStroke(.object(o))?.dualColor, PaintDualColor(light: "#ffffff", dark: "#000000"))
        o["dualColor"] = ["light": "#ffffff80", "dark": "#000"]
        XCTAssertNil(normalizeBrushStroke(.object(o))?.dualColor)
    }

    /// A version 1 stroke (flat engine brush) reads and saves its brush as a facet brush.
    func testVersionOneFlatBrushStroke() throws {
        let flat = normalizePaintBrush(["id": "my-ink", "name": "My ink", "engine": "dab", "tip": ["size": 14, "opacity": 0.8]])
        let raw: JSONValue = [
            "id": "s1", "layerId": "layer-1", "color": "#FF8800", "seed": 4_294_967_297.5,
            "points": [["x": 1, "y": 2, "pressure": 0.5], ["x": "bad"], ["x": 5, "y": 6, "twist": 30]],
            "brush": .object(flat.json(builtin: false)),
            "copies": [[1, 0, 0, 1, 0, 0], [1, 2, 3]],
            "load": ["reservoir": [2, 0.5, -1], "amount": 3, "pickup": nil],
            "steps": [0, 1, 2],
            "targets": ["a", "", 3],
            "scrapeLayerIds": ["a", 1],
        ]
        let s = try XCTUnwrap(normalizeBrushStroke(raw))
        XCTAssertEqual(s.color, "#ff8800")
        XCTAssertEqual(s.seed, 1)
        XCTAssertEqual(s.points.count, 2)
        XCTAssertEqual(s.points[1].twist, 30)
        XCTAssertEqual(s.copies, [[1, 0, 0, 1, 0, 0]])
        XCTAssertEqual(s.load, MixerLoad(reservoir: [1, 0.5, 0], amount: 1, pickup: nil))
        XCTAssertNil(s.steps, "steps must match the points")
        XCTAssertEqual(s.targets, ["a"])
        XCTAssertNil(s.scrapeLayerIds)
        XCTAssertEqual(s.brush, flat)
        let saved = strokeToJSON(s)
        XCTAssertEqual(saved.objectValue?["brush"], .object(migrateBrushV1(flat)))
        XCTAssertNotNil(saved.objectValue?["brush"]?.objectValue?["kind"])
        XCTAssertEqual(strokeToJSON(try XCTUnwrap(normalizeBrushStroke(saved))), saved)
    }

    func testMalformedStrokesAreNil() {
        XCTAssertNil(normalizeBrushStroke(.null))
        XCTAssertNil(normalizeBrushStroke("stroke"))
        XCTAssertNil(normalizeBrushStroke(["id": "s1", "layerId": "l"]))
        XCTAssertNil(normalizeBrushStroke(["id": 1, "layerId": "l", "points": [["x": 0, "y": 0]]]))
        XCTAssertNil(normalizeBrushStroke(["id": "s1", "layerId": "l", "points": [["x": 0], "nope"]]))
        // A stroke with only id, layer and points takes the defaults.
        let s = normalizeBrushStroke(["id": "s1", "layerId": "l", "points": [["x": 0, "y": 0]], "color": "red", "brush": "nope"])
        XCTAssertEqual(s?.color, "#000000")
        XCTAssertEqual(s?.seed, 0)
        XCTAssertEqual(s?.brush, normalizePaintBrush([:]))
    }

    // MARK: - Cultures

    private func cultureDoc() throws -> (PaintEditorController, String) {
        let c = try PaintEditorController(width: 140, height: 140)
        _ = try c.paintStroke(PaintStrokeInit(brushId: "mycelial-ink", seed: 12), points: line(50))
        _ = try c.growCultures(steps: 30)
        _ = c.setCultureOptions(growWhileClosed: true)
        return (c, try XCTUnwrap(c.doc.cultures?.keys.first))
    }

    func testCulturesRoundTrip() throws {
        let (c, layerId) = try cultureDoc()
        c.doc.lastGrownAt = 1_700_000_000_123.4
        let saved = c.culturesJSON(c.doc)
        let ext = try XCTUnwrap(saved["cultures"])
        XCTAssertNotNil(ext.objectValue?["layers"]?.objectValue?[layerId]?.objectValue?["occupancy"])
        var problems: [String] = []
        let read = culturesExtensionFromJSON(ext, validLayerIds: [layerId], problems: &problems)
        XCTAssertEqual(problems, [])
        XCTAssertEqual(read.growWhileClosed, true)
        XCTAssertEqual(read.lastGrownAt, 1_700_000_000_123)
        let culture = try XCTUnwrap(read.cultures?[layerId])
        XCTAssertEqual(culture.tips, c.doc.cultures?[layerId]?.tips)
        let doc = c.doc.with { d in
            d.cultures = read.cultures
            d.growWhileClosed = read.growWhileClosed
            d.lastGrownAt = read.lastGrownAt
        }
        XCTAssertEqual(c.culturesJSON(doc), saved)
    }

    func testCultureReaderDropsAndReports() throws {
        let (c, layerId) = try cultureDoc()
        var layer = try XCTUnwrap(c.culturesJSON(c.doc)["cultures"]?.objectValue?["layers"]?.objectValue?[layerId]?.objectValue)
        var problems: [String] = []
        // Unknown layers are dropped silently; unreadable cultures are reported and skipped.
        var bad = layer
        bad["occupancy"] = "nope"
        let ext: JSONValue = ["layers": ["gone": .object(layer), layerId: .object(bad), "x": 5], "growWhileClosed": "yes", "lastGrownAt": "1"]
        let read = culturesExtensionFromJSON(ext, validLayerIds: [layerId, "x"], problems: &problems)
        XCTAssertNil(read.cultures)
        XCTAssertNil(read.growWhileClosed)
        XCTAssertNil(read.lastGrownAt)
        XCTAssertEqual(problems, [
            "Layer \"\(layerId)\" culture could not be read (culture occupancy is not a PNG data URL); skipped.",
            "Layer \"x\" culture could not be read (not a saved layer culture); skipped.",
        ])
        problems = []
        bad["occupancy"] = "data:image/png;base64,AAAA"
        _ = culturesExtensionFromJSON(["layers": [layerId: .object(bad)]], validLayerIds: [layerId], problems: &problems)
        XCTAssertEqual(problems, ["Layer \"\(layerId)\" culture could not be read (Not a PNG image.); skipped."])
        // Not an extension at all.
        problems = []
        let none = culturesExtensionFromJSON(nil, validLayerIds: [layerId], problems: &problems)
        XCTAssertNil(none.cultures)
        XCTAssertNil(culturesExtensionFromJSON("x", validLayerIds: [], problems: &problems).growWhileClosed)
        XCTAssertEqual(problems, [])
        // Tips are rounded and clamped as TS does; status follows the tips.
        layer["tips"] = [["id": 2.6, "x": 10.5, "y": -3.5, "angle": 1030, "energy": 4, "widthFp": 5, "r": 300, "g": -2, "b": 7, "age": -1, "seed": -1, "reachPx": 0, "branchPermille": 1200, "wanderPermille": 5, "appetitePermille": 5, "digestPermille": 5, "fusePermille": 5, "glowPermille": -5], ["id": "3"]]
        layer["status"] = "growing"
        layer["nextId"] = 0
        let one = try cultureFromJSON(.object(layer))
        XCTAssertEqual(one.tips.count, 1)
        let t = one.tips[0]
        XCTAssertEqual([t.id, t.x, t.y, t.angle, t.widthFp, t.r, t.g, t.age, t.reachPx, t.branchPermille, t.glowPermille], [3, 11, -3, 6, 32, 255, 0, 0, 1, 1000, 0])
        XCTAssertEqual(t.seed, 4_294_967_295)
        XCTAssertEqual(one.nextId, 1)
        XCTAssertEqual(one.status, "growing")
        layer["tips"] = []
        layer["status"] = "growing"
        XCTAssertEqual(try cultureFromJSON(.object(layer)).status, "extinct")
    }
}
