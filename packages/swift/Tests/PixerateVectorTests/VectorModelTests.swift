import Foundation
import PixerateCore
import XCTest
@testable import PixerateVector

/// The model keeps JavaScript's object rules (insertion order, assignment in place, `delete`), and
/// the geometry refuses features that are not ported yet instead of guessing.
final class VectorModelTests: XCTestCase {
    private func node(_ text: String) throws -> VectorNode { try VectorNode(json: JSONValue.parse(text)) }

    func testAnchorKeysFollowJavaScriptAssignment() throws {
        var a = try VectorAnchor(json: JSONValue.parse(#"{"y":2,"x":1,"in":null,"custom":[1]}"#))
        XCTAssertNil(a.in)
        XCTAssertEqual(a.toJSON().stringified(), #"{"y":2,"x":1,"in":null,"custom":[1]}"#)
        a.out = Vec2(3, 4) // a new key goes last
        a.in = Vec2(0, 0) // an existing key keeps its place
        XCTAssertEqual(a.toJSON().stringified(), #"{"y":2,"x":1,"in":{"x":0,"y":0},"custom":[1],"out":{"x":3,"y":4}}"#)
        a.in = nil // delete
        a["custom"] = nil
        a.type = .smooth
        XCTAssertEqual(a.toJSON().stringified(), #"{"y":2,"x":1,"out":{"x":3,"y":4},"type":"smooth"}"#)
        a["type"] = "weird" // an unknown type is kept as stored
        XCTAssertNil(a.type)
        XCTAssertEqual(a["type"], "weird")
        XCTAssertEqual(a.keys, ["y", "x", "out", "type"])
    }

    func testSubpathKeyOrder() throws {
        XCTAssertEqual(VectorSubpath(anchors: [], closed: true).toJSON().stringified(), #"{"anchors":[],"closed":true}"#)
        XCTAssertEqual(VectorSubpath(closed: false, anchors: []).toJSON().stringified(), #"{"closed":false,"anchors":[]}"#)
        let sp = try VectorSubpath(json: JSONValue.parse(#"{"anchors":[{"x":0,"y":0}],"x":1}"#))
        XCTAssertFalse(sp.closed)
        XCTAssertEqual(sp.toJSON().stringified(), #"{"anchors":[{"x":0,"y":0}],"x":1}"#)
    }

    func testNodeMembersAndSlots() throws {
        var n = try node(##"{"id":"a","type":"path","subpaths":[],"fill":"#f00","transform":[1,0,0,1,5,5]}"##)
        n.fill = .null // in place
        n.name = "A" // appended
        n.subpaths = [rectSubpath(VectorBounds(x: 0, y: 0, width: 1, height: 1))]
        n["fill"] = nil
        XCTAssertEqual(n.keys, ["id", "type", "subpaths", "transform", "name"])
        XCTAssertEqual(n.transform, translateMatrix(5, 5))
        let moved = try transformVectorNode(n, rotateMatrix(90))
        XCTAssertEqual(moved.keys.last, "transform", "the TS spreads the node and appends its new transform")
        // A group without children gets the key when they are set; unknown node types stay JSON.
        var g = try node(#"{"id":"g","type":"group","children":[]}"#)
        g.children = [n]
        XCTAssertEqual(try VectorNode(json: g.toJSON()), g)
        let future = try node(#"{"id":"f","type":"blob","children":7}"#)
        XCTAssertNil(future.type)
        XCTAssertEqual(future.toJSON().stringified(), #"{"id":"f","type":"blob","children":7}"#)
        XCTAssertThrowsError(try node(#"{"id":"p","type":"path"}"#))
    }

    func testDocumentSlots() throws {
        var doc = try VectorDocument.fromJSON(#"{"width":10,"height":5,"nodes":[],"symbols":null}"#)
        XCTAssertNil(doc.symbols)
        XCTAssertEqual(doc.toJSON().stringified(), #"{"width":10,"height":5,"nodes":[],"symbols":null}"#)
        doc.symbols = [VectorSymbol(id: "s", name: "S", nodes: [])]
        doc.background = "#fff"
        XCTAssertEqual(doc.toJSON().stringified(), ##"{"width":10,"height":5,"nodes":[],"symbols":[{"id":"s","name":"S","nodes":[]}],"background":"#fff"}"##)
        doc.symbols = nil
        XCTAssertEqual(doc.keys, ["width", "height", "nodes", "background"])
    }

    func testCloneDropsNonFiniteNumbersAsJSONDoes() throws {
        var n = try node(#"{"id":"a","type":"path","subpaths":[],"opacity":1}"#)
        n.opacity = .nan
        XCTAssertEqual(try cloneVectorNode(n)["opacity"], .null)
    }

    func testUnportedFeaturesThrow() throws {
        let effected = try node(#"{"id":"e","type":"path","subpaths":[{"anchors":[{"x":0,"y":0},{"x":4,"y":4}],"closed":false}],"effects":[{"id":"z","type":"bevel","params":{"width":1}}]}"#)
        XCTAssertThrowsError(try vectorNodeBounds(effected)) { XCTAssertTrue($0 is VectorNotPorted) }
        XCTAssertNoThrow(try transformVectorNode(effected, scaleMatrix(2, 2)), "bevel parameters do not follow a transform")
        XCTAssertEqual(try vectorPathWorldBezier(effected, effects: false).count, 2)
        // A disabled effect (or one of an unknown type) does not change the outline.
        let disabled = try node(#"{"id":"e","type":"path","subpaths":[{"anchors":[{"x":0,"y":0},{"x":4,"y":4}],"closed":false}],"effects":[{"id":"z","type":"zigzag","enabled":false,"params":{}}]}"#)
        XCTAssertEqual(try vectorNodeBounds(disabled), VectorBounds(x: 0, y: 0, width: 4, height: 4))
        let text = try node(#"{"id":"t","type":"text","text":"x","font":{"fontFamily":"Inter","fontWeight":400,"fontSize":10},"frame":{"kind":"point","x":0,"y":0}}"#)
        XCTAssertThrowsError(try vectorNodeBounds(text))
        XCTAssertThrowsError(try transformVectorNode(text, translateMatrix(1, 0)))
        XCTAssertNoThrow(try transformVectorNode(text, rotateMatrix(30)), "a rigid move only sets the transform")
        let frameMask = try node(#"{"id":"m","type":"group","mask":{"type":"clip"},"children":[{"id":"f","type":"group","frame":{"x":0,"y":0,"width":4,"height":4},"children":[]},{"id":"a","type":"path","subpaths":[{"anchors":[{"x":0,"y":0},{"x":4,"y":4}],"closed":false}]}]}"#)
        // A frame as a mask covers what it draws (its fill and children, clipped): an empty frame
        // without a fill draws nothing, so it hides everything.
        XCTAssertNil(try vectorNodeBounds(frameMask))
    }
}
