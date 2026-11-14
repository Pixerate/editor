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
        // Any CSS colour the TS core reads, normalised as `normalizeDualColor` does (values from the TS core).
        let cases: [(JSONValue, String, String)] = [
            (["light": "rebeccapurple", "dark": "Gold"], "#663399", "#ffd700"),
            (["light": "rgb(255 0 128)", "dark": "rgba(10, 20, 30, 1)"], "#ff0080", "#0a141e"),
            (["light": "hsl(210 50% 40%)", "dark": "hsl(0.5turn 100% 25%)"], "#336699", "#008080"),
            (["light": "oklch(70% 0.1 200)", "dark": "oklch(0.3 0.4 30deg)"], "#40b1b7", "#630000"),
            ("light-dark(oklab(0.6 0.1 -0.1), color(display-p3 1 0 0))", "#9f63ba", "#ff0b0c"),
            ("Navy", "#000080", "#000080"),
        ]
        for (raw, light, dark) in cases {
            o["dualColor"] = raw
            XCTAssertEqual(normalizeBrushStroke(.object(o))?.dualColor, PaintDualColor(light: light, dark: dark), "\(raw.stringified())")
        }
        for bad: JSONValue in ["not a colour", "light-dark(red, blue, green)", "rgb(1 2)", ["light": "red", "dark": 3]] {
            o["dualColor"] = bad
            XCTAssertNil(normalizeBrushStroke(.object(o))?.dualColor, "\(bad.stringified())")
        }
        XCTAssertEqual(normalizeCssColor("transparent"), "#00000000")
        XCTAssertEqual(normalizeCssColor("rgb(% 0 0)"), "#000000")
        XCTAssertNil(normalizeCssColor("hsl(1e999 0% 0%)"))
    }

    /// A tip field that is not a number is NaN in TS (`Math.round(undefined)`), kept in memory and saved as null.
    func testCultureTipFieldsThatAreNotNumbers() throws {
        let tip: JSONObject = ["id": 2, "x": "abc", "y": 2048, "angle": "nope", "energy": .null, "r": "300", "g": [7], "b": true, "age": [:], "seed": "0x10", "reachPx": [], "branchPermille": "x", "wanderPermille": 350, "appetitePermille": 500, "digestPermille": 250, "fusePermille": [[5]], "glowPermille": "12"]
        let c = try cultureFromJSON(["tick": 1, "nextId": 3, "tips": [.object(tip)], "segmentsTotal": 0, "status": "growing"])
        let saved = try XCTUnwrap(c.tips.first?.json)
        // Values from the TS core (`cultureFromJSON` then `JSON.stringify`).
        XCTAssertEqual(saved.asJSON.stringified(), #"{"id":2,"x":null,"y":2048,"angle":0,"energy":0,"widthFp":null,"r":255,"g":7,"b":1,"age":null,"seed":16,"reachPx":1,"branchPermille":null,"wanderPermille":350,"appetitePermille":500,"digestPermille":250,"fusePermille":5,"glowPermille":12}"#)
        // Reopened from memory, the NaN fields stay NaN (not 0), as the TS object keeps them.
        let again = try cultureFromJSON(["tips": [saved]])
        XCTAssertEqual(again.tips.first?.json.asJSON, saved.asJSON)
        XCTAssertEqual(c.tips.first, c.tips.first)
    }

    /// Saved events come back verbatim (TS keeps the object), with only changed fields written over them.
    func testSavedEventsAreKeptVerbatim() throws {
        let wet = try XCTUnwrap(WetEvent(json: ["note": "kept", "clock": 1e20, "kind": "dry", "at": 1.5, "layerId": 7, "data": "text"]))
        XCTAssertEqual(wet.json.stringified(), #"{"note":"kept","clock":100000000000000000000,"kind":"dry","at":1.5,"layerId":7,"data":"text"}"#)
        var moved = wet
        moved.data = ["x": 1]
        XCTAssertEqual(moved.json.stringified(), #"{"note":"kept","clock":100000000000000000000,"kind":"dry","at":1.5,"layerId":7,"data":{"x":1}}"#)
        let paint = try XCTUnwrap(PaintEvent(json: ["why": "kept", "at": 1e18, "kind": "clear", "layerId": "base", "data": 5]))
        XCTAssertEqual(paint.json.stringified(), #"{"why":"kept","at":1000000000000000000,"kind":"clear","layerId":"base","data":5}"#)
        XCTAssertNil(PaintEvent(json: ["at": 1.5, "kind": "clear", "layerId": "base"]))
        XCTAssertNil(WetEvent(json: ["clock": "x", "kind": "tilt"]))
    }

    /// Saved channel rects are read unchecked, as `surfaceFromPixels(…, rect.x, rect.y)` reads them in TS.
    func testSavedRectsReadUnchecked() throws {
        let px: [UInt8] = [10, 20, 30, 40]
        func bounds(_ rect: JSONValue?) throws -> RasterRect? { contentBounds(try surfaceAtSavedRect(rect, width: 2, height: 2, data: px, channels: 1)) }
        XCTAssertEqual(try bounds(["x": 3, "y": 4]), RasterRect(x: 3, y: 4, width: 2, height: 2))
        XCTAssertEqual(try bounds([:]), RasterRect(x: 0, y: 0, width: 2, height: 2))
        XCTAssertEqual(try bounds(["x": .null, "y": true]), RasterRect(x: 0, y: 1, width: 2, height: 2))
        XCTAssertEqual(try bounds(true), RasterRect(x: 0, y: 0, width: 2, height: 2))
        // `"1" + 2` is `"12"`: the rows run 11 pixels wide, reading past each source row (values from the TS core).
        XCTAssertEqual(try bounds(["x": "1", "y": 0]), RasterRect(x: 1, y: 0, width: 4, height: 2))
        XCTAssertNil(try bounds(["x": "abc", "y": 0]))
        // A fractional x writes at the offset typed-array `set` truncates to.
        XCTAssertEqual(try bounds(["x": 2.5, "y": 0]), RasterRect(x: 2, y: 0, width: 2, height: 2))
        let rgba = px + px + px + px
        XCTAssertEqual(contentBounds(try surfaceAtSavedRect(["x": 255.5, "y": 0], width: 2, height: 2, data: rgba, channels: 4)), RasterRect(x: 255, y: 0, width: 3, height: 2))
        XCTAssertThrowsError(try surfaceAtSavedRect(["x": 254.5, "y": 255.5], width: 2, height: 2, data: rgba, channels: 4)) {
            XCTAssertEqual(errorMessage($0), "offset is out of bounds")
        }
    }

    /// Saved channels past the surface range (±8388608 px) are refused, as the TS core refuses them
    /// (#852), instead of being written at the tile their aliased key reads back as.
    func testFarChannelsAreRefused() throws {
        let px: [UInt8] = [10, 20, 30, 40]
        func refused(_ rect: JSONValue) {
            XCTAssertThrowsError(try surfaceAtSavedRect(rect, width: 2, height: 2, data: px, channels: 1)) {
                XCTAssertEqual(errorMessage($0), "it lies outside the surface range, -8388608 to 8388607 px on each axis")
            }
        }
        refused(["x": 255, "y": 70368744177664])
        refused(["x": -3000000000000, "y": 5000000000000])
        refused(["x": 70368744177920, "y": -70368744177920])
        refused(["x": 8388607, "y": 0])
        refused(["x": 0, "y": -8388609])
        refused(["x": 1e300, "y": 0])
        // The first and last tiles of the range hold their pixels, and their keys round-trip.
        let low = try surfaceAtSavedRect(["x": -8388608, "y": -8388608], width: 2, height: 2, data: px, channels: 1)
        XCTAssertEqual(contentBounds(low), RasterRect(x: -8388608, y: -8388608, width: 2, height: 2))
        let high = try surfaceAtSavedRect(["x": 8388606, "y": 8388606], width: 2, height: 2, data: px, channels: 1)
        XCTAssertEqual(contentBounds(high), RasterRect(x: 8388606, y: 8388606, width: 2, height: 2))
        for t in [MIN_TILE, -1, 0, MAX_TILE] {
            for u in [MIN_TILE, 0, MAX_TILE] {
                let back = tileCoord(tileKey(t, u))
                XCTAssertEqual(back.tx, t)
                XCTAssertEqual(back.ty, u)
            }
        }
        // Reads past the range see the default and stop there, however far out they reach.
        XCTAssertEqual(tilesInRect(RasterRect(x: 8388352, y: 0, width: 512, height: 1)).count, 1)
        XCTAssertTrue(tilesInRect(RasterRect(x: Int(1) << 60, y: 0, width: 2, height: 2)).isEmpty)
    }

    /// Deep samples with a fractional or text size are written where JavaScript arithmetic puts them
    /// (values from the TS core's `decodeDeepSurface`).
    func testDeepSamplesWithOddSizes() throws {
        func decode(_ deep: JSONValue) -> (problems: [String], samples: [String]) {
            var problems: [String] = []
            let s = decodeDeepSurface(emptySurface(1), deep, &problems, "L")
            var samples: [String] = []
            for (key, tile) in s.tiles {
                guard case .u16(let a)? = tile.deep else { continue }
                let set: [String] = a.enumerated().filter { (e: (offset: Int, element: UInt16)) -> Bool in e.element != 0 }.map { (e: (offset: Int, element: UInt16)) -> String in "\(e.offset):\(e.element)" }
                samples.append("\(key) " + set.joined(separator: " "))
            }
            return (problems, samples)
        }
        // 1.5 × 2: the first row copies sample 0 (`subarray(0, 1.5)`), the second samples 1 and 2 (`subarray(1.5, 3)`).
        let frac = decode(["depth": 16, "x": 3, "y": 1, "width": 1.5, "height": 2, "data": "eJx7wXyBfQc3AApVAoY="])
        XCTAssertEqual(frac.problems, [])
        XCTAssertEqual(frac.samples, ["2147516416 259:1000 515:2000 516:3000"])
        // "2" × 1: `3 + "2"` is `"32"`, so the row copies up to 29 samples (all 2 there are).
        let text = decode(["depth": 16, "x": 3, "y": 1, "width": "2", "height": 1, "data": "eJx7wXyBHQAFVAHD"])
        XCTAssertEqual(text.problems, [])
        XCTAssertEqual(text.samples, ["2147516416 259:1000 260:2000"])
        // 1.25 samples: never a whole count, so never readable.
        let quarter = decode(["depth": 16, "x": 3, "y": 1, "width": 1.25, "height": 1, "data": "eJx7wQwAAdUA7A=="])
        XCTAssertEqual(quarter.problems, ["L: its 16-bit samples could not be read, so it was opened at 8 bits"])
        XCTAssertEqual(quarter.samples, [])
        // An array is an object in JS (with no depth).
        XCTAssertEqual(decode([16]).problems, ["L: its undefined-bit samples could not be read, so it was opened at 8 bits"])
    }

    /// A replay puts a saved wet event at `event.at ?? 0`, read as a number.
    func testWetEventsReplayAtTheirSavedValue() throws {
        func at(_ v: JSONValue?) throws -> Double {
            var o: JSONObject = ["clock": 0, "kind": "dry"]
            if let v { o["at"] = v }
            return try XCTUnwrap(WetEvent(json: .object(o))).replayAt
        }
        XCTAssertEqual(try at(1.5), 1.5)
        XCTAssertEqual(try at("0.25"), 0.25)
        XCTAssertEqual(try at(true), 1)
        XCTAssertEqual(try at(.null), 0)
        XCTAssertEqual(try at(nil), 0)
        XCTAssertEqual(try at(3), 3)
        XCTAssertTrue(try at(["a": 1]).isNaN)
        XCTAssertEqual(WetEvent(clock: 0, at: 2, kind: "dry", layerId: nil, data: nil).replayAt, 2)
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
