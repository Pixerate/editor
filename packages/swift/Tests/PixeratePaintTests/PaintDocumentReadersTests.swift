import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// The document readers round-trip their writers (write → read → write gives the same JSON) and
/// throw the TS core's messages.
final class PaintDocumentReadersTests: XCTestCase {
    private let rect = RasterRect(x: 250, y: 3, width: 12, height: 9)

    /// A surface with a gradient of bytes over `rect` (crossing a tile edge).
    private func surface(_ channels: Int, seed: Int) -> TiledSurface {
        var data = [UInt8](repeating: 0, count: rect.width * rect.height * channels)
        for i in 0..<data.count { data[i] = UInt8((i * 37 + seed * 11) % 251 + 1) }
        return writeRegion(emptySurface(channels, 0), rect, data)
    }

    private func message(_ body: () throws -> Any) -> String {
        do { _ = try body(); return "(no error)" } catch { return "\(error)" }
    }

    func testThickRoundTripsWithAndWithoutFilm() throws {
        for film in [emptySurface(4, 0), surface(4, seed: 3)] {
            let ch = ThickChannels(height: surface(1, seed: 1), material: surface(4, seed: 2), film: film)
            let saved = try XCTUnwrap(thickToJSON(ch))
            XCTAssertEqual(thickToJSON(try thickFromJSON(saved)), saved)
        }
    }

    func testThickErrors() {
        XCTAssertEqual(message { try thickFromJSON(["rect": ["x": 0, "y": 0], "height": "x"]) }, "not saved thick-paint channels")
        XCTAssertEqual(message { try thickFromJSON(.null) }, "not saved thick-paint channels")
        XCTAssertEqual(message { try thickFromJSON(["rect": ["x": 0, "y": 0], "height": "nope", "material": "nope"]) }, "a channel is not a PNG data URL")
    }

    func testLightRoundTrips() throws {
        let saved = try XCTUnwrap(lightToJSON(surface(1, seed: 4)))
        XCTAssertEqual(lightToJSON(try lightFromJSON(saved)), saved)
        XCTAssertEqual(message { try lightFromJSON(["light": "x"]) }, "not a saved light channel")
        XCTAssertEqual(message { try lightFromJSON(["rect": ["x": 0, "y": 0], "light": "x"]) }, "the light is not a PNG data URL")
    }

    func testFluorAndThermoRoundTrip() throws {
        let fluor = try XCTUnwrap(fluorToJSON(surface(4, seed: 5)))
        XCTAssertEqual(fluorToJSON(try fluorFromJSON(fluor)), fluor)
        let thermo = try XCTUnwrap(thermoToJSON(surface(4, seed: 6)))
        XCTAssertEqual(thermoToJSON(try thermoFromJSON(thermo)), thermo)
        XCTAssertEqual(message { try fluorFromJSON(["rect": ["x": 0, "y": 0]]) }, "not a saved fluorescence channel")
        XCTAssertEqual(message { try fluorFromJSON(["rect": ["x": 0, "y": 0], "fluor": "x"]) }, "the fluorescence channel is not a PNG data URL")
        XCTAssertEqual(message { try thermoFromJSON(["rect": ["x": 0, "y": 0]]) }, "not a saved thermochromic channel")
        XCTAssertEqual(message { try thermoFromJSON(["rect": ["x": 0, "y": 0], "thermo": "x"]) }, "the thermochromic channel is not a PNG data URL")
    }

    func testPaperEffectRoundTripsThroughTheDocumentWriter() throws {
        let c = try PaintEditorController(width: 8, height: 6)
        let data = (0..<(8 * 6 * 4)).map { UInt8($0 % 256) }
        let source = PaintEffectSource(effect: "noise", provider: "fake", name: "Noise", values: ["scale": 2, "tint": "#ff0000"], time: 120)
        let paper = PaintPaperEffect(source: source, opacity: 0.4, blend: "screen", image: ImageNodeImage(width: 8, height: 6, data: data), version: 1)
        let doc = c.doc.with { $0.paperEffect = paper }
        let saved = try XCTUnwrap(c.providerEffectsJSON(doc)["paperEffect"])
        let read = try paperEffectFromJSON(saved, width: 8, height: 6)
        XCTAssertEqual(read.source, source)
        XCTAssertEqual(read.image.data, data)
        XCTAssertEqual(c.providerEffectsJSON(c.doc.with { $0.paperEffect = read })["paperEffect"], saved)

        // Lenient fields fall back like TS.
        var o = try XCTUnwrap(saved.objectValue)
        o["opacity"] = 2
        o["blend"] = "nope"
        let fallback = try paperEffectFromJSON(.object(o), width: 8, height: 6)
        XCTAssertEqual(fallback.opacity, 1)
        XCTAssertEqual(fallback.blend, "multiply")

        XCTAssertEqual(message { try paperEffectFromJSON(["effect": "noise"], width: 8, height: 6) }, "it is not an effect (effect id and values)")
        XCTAssertEqual(message { try paperEffectFromJSON(["effect": "noise", "values": [:]], width: 8, height: 6) }, "its pixels are missing")
        XCTAssertEqual(message { try paperEffectFromJSON(saved, width: 9, height: 6) }, "its pixels are 8×6, not the canvas size 9×6")
    }

    func testReadPaintEffectSource() {
        let s = PaintEffectSource(effect: "noise", provider: "p", name: "N", values: ["a": 1], time: 5)
        XCTAssertEqual(readPaintEffectSource(.object(s.json))?.json, s.json)
        XCTAssertNil(readPaintEffectSource(["effect": "", "values": [:]]))
        XCTAssertNil(readPaintEffectSource(["effect": "x", "values": [1]]))
        XCTAssertNil(readPaintEffectSource(nil))
        XCTAssertNil(readPaintEffectSource(["effect": "x", "values": [:], "time": -1])?.time)
    }

    func testWetGhostRoundTripsAndNormalises() throws {
        let ghost = WetGhostState(pigment: [0.1, 0.2, 0.3, 0.4], remaining: 12, total: 30, linger: 6)
        XCTAssertEqual(readWetGhost(ghost.json)?.json, ghost.json)
        XCTAssertNil(readWetGhost(["pigment": [1, 2, 3], "remaining": 5]))
        XCTAssertNil(readWetGhost(["pigment": [1, 2, 3, "x"], "remaining": 5]))
        XCTAssertNil(readWetGhost(["pigment": [1, 2, 3, 4], "remaining": 0.4]))
        let n = try XCTUnwrap(readWetGhost(["pigment": [1, 2, 3, 4], "remaining": 2.5, "linger": 100]))
        XCTAssertEqual(n.remaining, 3)
        XCTAssertEqual(n.total, 3)
        XCTAssertEqual(n.linger, 60)
        XCTAssertNil(n.trigger)
    }

    func testSwatchRoundTrips() throws {
        let plain = Swatch(color: "#a1b2c3", name: "Mud")
        XCTAssertEqual(readSwatch(plain.json), plain)
        XCTAssertEqual(readSwatch(["color": "#A1B2C3", "name": "  Mud  "]), plain)
        let paint: JSONValue = ["type": "gradient", "stops": [["offset": 0, "color": "secondary"], ["offset": 1, "color": "#112233"]]]
        let g = try XCTUnwrap(readSwatch(["paint": paint]))
        XCTAssertEqual(g.color, "#ffffff")
        XCTAssertNotNil(g.paint)
        XCTAssertEqual(readSwatch(g.json)?.json, g.json)
        XCTAssertNil(readSwatch(["color": "#a1b2c3\n"]))
        XCTAssertNil(readSwatch(["color": "red"]))
        XCTAssertEqual(readSwatch(["color": "#000000", "name": .string(String(repeating: "a", count: 100))])?.name?.count, 80)
    }

    func testWetEventsKeepWhatReadDocumentKeeps() throws {
        let e = WetEvent(clock: 7, at: 2, kind: "tilt", layerId: "l1", data: ["angle": 30])
        XCTAssertEqual(WetEvent(json: e.json)?.json, e.json)
        let bare = WetEvent(clock: 0, at: nil, kind: "dry", layerId: nil, data: nil)
        XCTAssertEqual(WetEvent(json: bare.json), bare)
        XCTAssertNil(WetEvent(json: ["clock": 1.5, "kind": "dry"]))
        XCTAssertNil(WetEvent(json: ["clock": 1, "kind": 3]))
        XCTAssertNil(WetEvent(json: ["kind": "dry"]))
    }

    func testPaintEventsKeepWhatReadDocumentKeeps() throws {
        let e = PaintEvent(at: 3, kind: "fill", layerId: "l1", data: ["color": "#ff0000"])
        XCTAssertEqual(PaintEvent(json: e.json)?.json, e.json)
        for kind in PAINT_EVENT_KINDS { XCTAssertNotNil(PaintEvent(json: ["at": 0, "kind": .string(kind), "layerId": "l"])) }
        XCTAssertNil(PaintEvent(json: ["at": 0, "kind": "smudge", "layerId": "l"]))
        XCTAssertNil(PaintEvent(json: ["at": 0.5, "kind": "fill", "layerId": "l"]))
        XCTAssertNil(PaintEvent(json: ["at": 0, "kind": "fill"]))
    }

    /// Opening a saved painting replaces the document: listeners hear it, the history is cleared and the layers come back.
    func testLoadJSONReplacesTheDocument() throws {
        let c = try PaintEditorController(width: 32, height: 32)
        _ = try c.addLayer(name: "Second")
        let saved = JSONValue.object(c.toJSON())
        let other = try PaintEditorController(width: 16, height: 16)
        var replaced = 0
        let handle = other.onDocumentReplaced { replaced += 1 }
        defer { handle.cancel() }
        let problems = try other.loadJSON(saved)
        XCTAssertEqual(problems, [])
        XCTAssertEqual(replaced, 1)
        XCTAssertNil(other.undoLabel)
        XCTAssertEqual(other.doc.layers.map(\.name), c.doc.layers.map(\.name))
        XCTAssertEqual(other.toJSON(), c.toJSON())
        XCTAssertThrowsError(try other.loadJSON(["format": "pixerate-image"])) { e in
            XCTAssertEqual("\(e)", "Not a paint document: format is \"pixerate-image\", expected \"pixerate-paint\".")
        }
        XCTAssertEqual(replaced, 1)
    }
    /// Opening inside a `group` (as TS allows) keeps the group open: no crash, and no undo step for the open.
    func testLoadJSONInsideAGroupRecordsNoStep() throws {
        let c = try PaintEditorController(width: 16, height: 16)
        _ = try c.addLayer(name: "Second")
        let saved = JSONValue.object(c.toJSON())
        let other = try PaintEditorController(width: 8, height: 8)
        _ = try other.addLayer(name: "Before")
        var heard = 0
        let handle = other.subscribe { heard += 1 }
        defer { handle.cancel() }
        let problems = try other.group("Open") { try other.loadJSON(saved) }
        XCTAssertEqual(problems, [])
        XCTAssertNil(other.undoLabel)
        XCTAssertEqual(other.toJSON(), c.toJSON())
        XCTAssertGreaterThan(heard, 0)
    }

    /// Empty `deep` fields (null, false, 0) are not deep pixels, as `if (r.deep)` reads them in TS: nothing to report.
    func testEmptyDeepFieldsReportNothing() throws {
        let c = try PaintEditorController(width: 8, height: 8)
        var saved = c.toJSON()
        var layers = saved["layers"]?.arrayValue ?? []
        var layer = try XCTUnwrap(layers.first?.objectValue)
        layer["deep"] = .null
        layer["mask"] = ["defaultValue": 255, "deep": false]
        layers[0] = .object(layer)
        saved["layers"] = .array(layers)
        XCTAssertEqual(try c.loadJSON(.object(saved)), [])
        layer["deep"] = ["bits": 16]
        layers[0] = .object(layer)
        saved["layers"] = .array(layers)
        XCTAssertEqual(try c.loadJSON(.object(saved)).count, 1)
    }
}
