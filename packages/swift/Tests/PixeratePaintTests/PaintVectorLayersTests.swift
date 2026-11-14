import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// The image editor's vector parts in a paint document (`ImageLayers.swift`): vector masks read,
/// normalised and saved as the TS core does, and shape, type and annotation layers checked with
/// its messages. Expected values come from running the TS core (`@pixerate/editor`).
final class PaintVectorLayersTests: XCTestCase {
    private func load(_ layers: [JSONValue]) throws -> (problems: [String], saved: JSONObject) {
        let c = try PaintEditorController(width: 8, height: 8)
        let doc: JSONValue = ["format": "pixerate-paint", "version": 2, "width": 8, "height": 8, "paper": ["color": "#ffffff"], "layers": .array(layers), "assets": [:]]
        let problems = try c.loadJSON(doc)
        return (problems, try c.toJSON())
    }

    private func message(_ body: () throws -> Any) -> String {
        do { _ = try body(); return "(no error)" } catch { return errorMessage(error) }
    }

    func testTanMatchesV8() {
        // `Math.tan` in Node; the platform's `tan(π/8)` is 0.4142135623730951.
        let cases: [(Double, Double)] = [
            (0.39269908169872414, 0.41421356237309503), (0.3, 0.30933624960962325), (-0.7, -0.8422883804630794),
            (1, 1.5574077246549023), (2.5, -0.7470222972386603), (100, -0.5872139151569291), (-3.3, -0.15974574766003222),
        ]
        for (x, want) in cases { XCTAssertEqual(JS.tan(x).bitPattern, want.bitPattern, "tan(\(x))") }
    }

    func testTransformedRectangleMaskCutsItsCornersFirst() throws {
        let vm: JSONValue = ["components": [["live": ["kind": "rect", "x": 1, "y": 1, "width": 4, "height": 3, "radius": 1, "transform": [1, 0.2, 0, 1, 2, 3]]]]]
        let (problems, saved) = try load([["id": "a", "type": "pixel", "vectorMask": vm]])
        XCTAssertEqual(problems, [])
        let layer = try XCTUnwrap(saved["layers"]?.arrayValue?.first?.objectValue)
        let want = try JSONValue.parse(#"""
        {"components":[{"op":"combine","subpaths":[{"closed":true,"anchors":[{"x":4,"y":4.4,"in":{"x":3.4477152501692068,"y":4.289543050033841}},{"x":6,"y":4.8,"out":{"x":6.552284749830793,"y":4.910456949966159}},{"x":7,"y":6,"in":{"x":7,"y":5.447715250169207}},{"x":7,"y":7,"out":{"x":7,"y":7.552284749830793}},{"x":6,"y":7.8,"in":{"x":6.552284749830793,"y":7.910456949966159}},{"x":4,"y":7.4,"out":{"x":3.4477152501692068,"y":7.289543050033841}},{"x":3,"y":6.2,"in":{"x":3,"y":6.752284749830793}},{"x":3,"y":5.2,"out":{"x":3,"y":4.647715250169206}}]}],"live":{"kind":"rect","x":1,"y":1,"width":4,"height":3,"radii":[1,1,1,1],"transform":[1,0.2,0,1,2,3]}}]}
        """#)
        XCTAssertEqual(layer["vectorMask"]?.stringified(), want.stringified())
        // Keys follow the TS objects: the mask goes after `mask`, before `locks`.
        XCTAssertEqual(layer.keys.firstIndex(of: "vectorMask"), layer.keys.firstIndex(of: "blend").map { $0 + 1 })
    }

    func testVectorMaskProblemsComeBeforeTheLayersOwn() throws {
        let (problems, _) = try load([
            ["id": "x", "name": "Adj", "type": "adjustment", "kind": "nope", "vectorMask": ["components": [["op": 3]]]],
            ["id": "s", "type": "shape", "vectorMask": ["components": 5], "components": [["subpaths": []]]],
            ["id": "p", "type": "pixel", "vectorMask": ["edges": []]],
        ])
        XCTAssertEqual(problems, [
            "The vector mask of layer \"Adj\" could not be read (components[0].op must be one of combine, subtract, intersect, exclude, got 3.); it was left out.",
            "Layer \"Adj\": unknown adjustment kind \"nope\"",
            "The vector mask of layer \"p\" could not be read (its components are missing); it was left out.",
            "Layer \"\" is an image editor shape layer, which the paint editor does not have; it was left out.",
        ])
    }

    func testImageEditorCssColours() {
        let cases: [(String, String?, Double)] = [
            ("#AbC", "#aabbcc", 1), ("#11223344", "#112233", 0.26666666666666666), (" Red ", "#ff0000", 1), ("transparent", "#000000", 0),
            ("rgb(10%, 20, 300)", "#1a14ff", 1), ("rgba(1 2 3 / 50%)", "#010203", 0.5), ("hsl(120deg 50% 50%)", "#40bf40", 1),
            ("hsla(-30, 100%, 25%, 0.2)", "#800040", 0.2), ("rgb(1, 2)", nil, 0), ("hsl(1, 2)", nil, 0), ("oklch(0.5 0.1 20)", nil, 0),
            ("Constructor", "#function Object() { [native code] }", 1), ("__proto__", "#[object Object]", 1), ("tostring", nil, 0),
            ("#12345", nil, 0), ("rgb(1e2, 2, 3)", nil, 0), ("rgb(.5.5, 2, 3)", "#010203", 1),
        ]
        for (text, hex, alpha) in cases {
            let c = imageCssColor(.string(text))
            XCTAssertEqual(c?.hex, hex, text)
            if let c { XCTAssertEqual(c.alpha, alpha, text) }
        }
        XCTAssertNil(imageCssColor(.number(5)))
    }

    func testShapeAndTypeChecks() {
        XCTAssertNil(shapeLayerProblem(["components": [["live": ["kind": "ellipse", "x": 0, "y": 0, "width": 2, "height": 2]]], "fill": "constructor"]))
        XCTAssertEqual(shapeLayerProblem(["annotation": ["type": "pen", "strokeColor": "#00f"]]), "points must be an array of { x, y } points.")
        XCTAssertEqual(shapeLayerProblem(["components": [["subpaths": []]], "fill": ["type": "gradient", "gradient": ["stops": [.null]]]]), "Cannot read properties of null (reading 'position')")
        XCTAssertEqual(shapeLayerProblem(["components": [["subpaths": []]], "stroke": ["width": 1, "paint": "#000", "join": .null]]), "stroke.join must be one of miter, round, bevel, got null.")
        XCTAssertEqual(typeLayerProblem(["text": "x", "runs": [.null, ["style": ["bold"]]]]), "runs[1].style.0 is not a character style field; use fontFamily, fontWeight, italic, fontSize, color, opacity, tracking, leading, baselineShift, underline, strikethrough, upright, postScriptName.")
        XCTAssertEqual(typeLayerProblem(["text": "x", "runs": [["style": ["fontWeight": "heavy"]]]]), "runs[0].style.fontWeight must be a number from 1 to 1000, got \"heavy\".")
        XCTAssertNil(typeLayerProblem(["runs": [["style": ["fontWeight": "bold", "opacity": .null]]]]))
    }

    func testAnnotationsReportTheLayerTheyMigrateTo() throws {
        XCTAssertEqual(try migratedAnnotationType(["type": "rect", "x": 1, "y": 1, "width": 4, "height": 3, "strokeColor": "#f00"]), "shape")
        XCTAssertEqual(try migratedAnnotationType(["type": "circle", "strokeColor": "red", "fillColor": "nope"]), "annotation")
        XCTAssertEqual(try migratedAnnotationType(["type": "text", "x": 2, "y": 2, "text": "a", "color": "#123", "fontWeight": "600"]), "type")
        XCTAssertEqual(try migratedAnnotationType(["type": "text", "text": "a", "color": "#123", "fontWeight": "heavy"]), "annotation")
        XCTAssertEqual(try migratedAnnotationType(["type": "image"]), "annotation")
        XCTAssertEqual(message { try migratedAnnotationType(["type": "rect", "x": 1, "y": 1, "width": "4", "height": 3, "strokeColor": "#f00"]) }, "width must be a finite number.")
        XCTAssertEqual(message { try migratedAnnotationType(["type": "text", "x": 2, "y": 2, "color": "#123", "text": "a", "fontWeight": true]) }, "fontWeight must be normal, bold or a number from 1 to 1000.")
        // #848: a malformed annotation is reported and left out; the rest of the document loads.
        let loaded = try load([
            ["id": "p", "name": "Kept", "type": "pixel"],
            ["id": "a", "type": "annotation", "annotation": ["type": "text", "x": 2, "y": 2, "color": "#000", "text": 5]],
            ["id": "b", "type": "annotation", "annotation": ["type": "pen", "strokeColor": "#000", "rotation": 5, "points": ["length": 2]]],
            ["id": "c", "type": "annotation", "annotation": ["type": "pen", "strokeColor": "#000", "points": [["x": 1, "y": 1], .null]]],
        ])
        XCTAssertEqual(loaded.problems, [
            "Layer \"a\": the annotation could not be read (text must be a string.)",
            "Layer \"b\": the annotation could not be read (points must be an array of { x, y } points.)",
            "Layer \"c\": the annotation could not be read (points[1] must be a point { x, y } with finite numbers.)",
        ])
        let ids: [String] = (loaded.saved["layers"]?.arrayValue ?? []).compactMap { (layer: JSONValue) -> String? in layer.objectValue?["id"]?.stringValue }
        XCTAssertEqual(ids, ["p"])
    }
}
