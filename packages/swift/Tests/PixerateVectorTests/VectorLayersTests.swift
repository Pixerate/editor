import PixerateCore
import XCTest
@testable import PixerateVector

/// `vectorLayerRows` (`vector/layers.ts`): the layers panel's rows.
final class VectorLayersTests: XCTestCase {
    func testRowsAreTopFirstWithGroupsOpenedOnRequest() throws {
        let c = try VectorEditorController()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 10, height: 10))
        let b = try c.addShape(VectorShapeInput(kind: "ellipse", x: 20, y: 0, width: 10, height: 10))
        let g = try XCTUnwrap(try c.group(ids: [a, b]))
        let t = try c.addText(VectorTextInput(text: "  A   long\nheading that goes on and on past forty characters "))
        _ = try c.updateNode(a, ["visible": false, "locked": true])
        var rows = vectorLayerRows(c.document.nodes)
        XCTAssertEqual(rows.map(\.id), [t, g])
        XCTAssertEqual(rows[0].kind, "text")
        XCTAssertEqual(rows[0].name, vectorLayerName(try XCTUnwrap(c.getNode(t))))
        // Without a name, text shows its words (40 code units at most), else its kind.
        let unnamed = VectorNode(props: ["id": "x", "type": "text", "text": "  A   long\nheading that goes on and on past forty characters "])
        XCTAssertEqual(vectorLayerName(unnamed), "A long heading that goes on and on past…")
        XCTAssertEqual(vectorLayerName(VectorNode(props: ["id": "y", "type": "text", "text": " "])), "Text")
        XCTAssertEqual(rows[1].kind, "group")
        XCTAssertEqual(rows[1].name, "Group")
        XCTAssertEqual(rows[1].childCount, 2)
        XCTAssertFalse(rows[1].expanded)
        rows = vectorLayerRows(c.document.nodes) { $0 == g }
        XCTAssertEqual(rows.map(\.id), [t, g, b, a])
        XCTAssertEqual(rows.map(\.depth), [0, 0, 1, 1])
        XCTAssertEqual(rows[2].parentId, g)
        XCTAssertEqual(rows[3].name, "Rectangle")
        XCTAssertFalse(rows[3].visible)
        XCTAssertTrue(rows[3].locked)
        XCTAssertTrue(rows[1].expanded)
    }

    func testKindsAndLabelsMatchTheUITables() throws {
        let tables = try VectorContracts.uiTables()
        XCTAssertEqual(tables.labels.layerKinds, VECTOR_LAYER_KIND_LABELS)
        XCTAssertEqual(Set(VECTOR_LAYER_KINDS), Set(VECTOR_LAYER_KIND_LABELS.keys))
        XCTAssertEqual(tables.tools.order, VECTOR_TOOLS)
    }
}
