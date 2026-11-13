import PixerateCore
import PixerateGeometry
import PixerateVector
import XCTest
@testable import PixerateVectorUI

/// Canvas input fed to the controller: each tool's pointer gestures, one undo step per drag, and the view.
@MainActor
final class VectorCanvasGestureTests: XCTestCase {
    private func editor() throws -> (VectorEditorController, VectorCanvasGesture) {
        var n = 0
        let c = try VectorEditorController(createId: {
            n += 1
            return "n\(n)"
        })
        return (c, VectorCanvasGesture(controller: c))
    }

    private func drag(_ g: VectorCanvasGesture, from a: (Double, Double), to b: (Double, Double), steps: Int = 4, shift: Bool = false, alt: Bool = false) {
        g.pointerDown(VectorPointerEvent(x: a.0, y: a.1, shift: shift, alt: alt))
        for i in 1...steps {
            let t: Double = Double(i) / Double(steps)
            let x: Double = a.0 + (b.0 - a.0) * t
            let y: Double = a.1 + (b.1 - a.1) * t
            g.pointerMove(VectorPointerEvent(x: x, y: y, shift: shift, alt: alt))
        }
        g.pointerUp(VectorPointerEvent(x: b.0, y: b.1, shift: shift, alt: alt))
    }

    private func click(_ g: VectorCanvasGesture, _ x: Double, _ y: Double, shift: Bool = false, count: Int = 1) {
        g.pointerDown(VectorPointerEvent(x: x, y: y, shift: shift, clickCount: count))
        g.pointerUp(VectorPointerEvent(x: x, y: y, shift: shift, clickCount: count))
    }

    private func bounds(_ c: VectorEditorController, _ id: String) throws -> VectorBounds {
        let node = try XCTUnwrap(c.getNode(id))
        return try XCTUnwrap(try vectorNodeBounds(node))
    }

    func testRectangleToolDragsOutOneShapeInOneUndoStep() throws {
        let (c, g) = try editor()
        c.setTool("rect")
        drag(g, from: (100, 100), to: (300, 200))
        XCTAssertEqual(c.document.nodes.count, 1)
        let node = c.document.nodes[0]
        XCTAssertEqual(node.name, "Rectangle")
        let b = try bounds(c, node.id)
        XCTAssertEqual(b.x, 100, accuracy: 1e-9)
        XCTAssertEqual(b.y, 100, accuracy: 1e-9)
        XCTAssertEqual(b.width, 200, accuracy: 1e-9)
        XCTAssertEqual(b.height, 100, accuracy: 1e-9)
        XCTAssertEqual(c.selectedIds, [node.id])
        XCTAssertEqual(c.history.state.undoCount, 1)
        c.undo()
        XCTAssertTrue(c.document.nodes.isEmpty)
    }

    func testShapeDragModifiersAndClickWithoutDrag() throws {
        let (c, g) = try editor()
        c.setTool("ellipse")
        // Shift: a circle; Alt: from the centre.
        drag(g, from: (200, 200), to: (260, 220), shift: true, alt: true)
        let b = try bounds(c, c.document.nodes[0].id)
        XCTAssertEqual(b.width, 120, accuracy: 1e-6)
        XCTAssertEqual(b.height, 120, accuracy: 1e-6)
        XCTAssertEqual(b.x, 140, accuracy: 1e-6)
        // A click draws nothing.
        click(g, 50, 50)
        XCTAssertEqual(c.document.nodes.count, 1)
        // A line keeps its direction.
        c.setTool("line")
        drag(g, from: (300, 300), to: (200, 350))
        XCTAssertEqual(c.document.nodes.count, 2)
        XCTAssertEqual(c.document.nodes[1].name, "Line")
        XCTAssertFalse(hasPaint(c.document.nodes[1].fill))
    }

    func testFrameToolAddsAFrame() throws {
        let (c, g) = try editor()
        c.setTool("frame")
        drag(g, from: (10, 10), to: (210, 110))
        XCTAssertEqual(c.document.nodes.count, 1)
        XCTAssertTrue(isVectorFrame(c.document.nodes[0]))
    }

    func testSelectClickMoveAndShiftToggle() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        let b = try c.addShape(VectorShapeInput(kind: "rect", x: 200, y: 0, width: 100, height: 100))
        let steps = c.history.state.undoCount
        c.setTool("select")
        click(g, 50, 50)
        XCTAssertEqual(c.selectedIds, [a])
        click(g, 250, 50, shift: true)
        XCTAssertEqual(c.selectedIds, [a, b])
        click(g, 250, 50, shift: true)
        XCTAssertEqual(c.selectedIds, [a])
        // Clicking nothing clears.
        click(g, 500, 500)
        XCTAssertEqual(c.selectedIds, [])
        XCTAssertEqual(c.history.state.undoCount, steps)
        // Drag moves what is under the pointer, as one step.
        drag(g, from: (250, 50), to: (270, 90))
        XCTAssertEqual(c.selectedIds, [b])
        let moved = try bounds(c, b)
        XCTAssertEqual(moved.x, 220, accuracy: 1e-9)
        XCTAssertEqual(moved.y, 40, accuracy: 1e-9)
        XCTAssertEqual(c.history.state.undoCount, steps + 1)
        c.undo()
        XCTAssertEqual(try bounds(c, b).x, 200, accuracy: 1e-9)
    }

    func testMoveWithShiftKeepsToOneAxis() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        c.setTool("select")
        // Shift-pressing an unselected node adds it and drags.
        c.clearSelection()
        drag(g, from: (50, 50), to: (90, 60), shift: true)
        let b = try bounds(c, a)
        XCTAssertEqual(b.x, 40, accuracy: 1e-9)
        XCTAssertEqual(b.y, 0, accuracy: 1e-9)
    }

    func testMarqueeSelectsWhatItTouches() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 50, height: 50))
        let b = try c.addShape(VectorShapeInput(kind: "ellipse", x: 100, y: 0, width: 50, height: 50))
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 400, y: 400, width: 50, height: 50))
        c.setTool("select")
        drag(g, from: (-10, -10), to: (120, 20))
        XCTAssertEqual(c.selectedIds, [a, b])
        XCTAssertNil(g.overlay.marquee)
    }

    func testResizeHandleScalesFromTheOppositeCorner() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 100, y: 100, width: 100, height: 50))
        c.setTool("select")
        c.select([a])
        XCTAssertEqual(g.handle(at: 200, 150), .se)
        XCTAssertEqual(g.handle(at: 150, 100), .n)
        XCTAssertNil(g.handle(at: 150, 125))
        drag(g, from: (200, 150), to: (300, 200))
        let b = try bounds(c, a)
        XCTAssertEqual(b.x, 100, accuracy: 1e-6)
        XCTAssertEqual(b.y, 100, accuracy: 1e-6)
        XCTAssertEqual(b.width, 200, accuracy: 1e-6)
        XCTAssertEqual(b.height, 100, accuracy: 1e-6)
        XCTAssertEqual(c.history.state.undoCount, 2)
    }

    func testPenPlacesPointsAndFinishesAsOneStep() throws {
        let (c, g) = try editor()
        c.setTool("pen")
        click(g, 10, 10)
        // A drag after placing a point pulls smooth handles.
        drag(g, from: (100, 10), to: (130, 40))
        click(g, 100, 100)
        XCTAssertTrue(g.isDrawingPath)
        XCTAssertEqual(g.overlay.pen.count, 3)
        g.finishPath()
        XCTAssertFalse(g.isDrawingPath)
        XCTAssertEqual(c.document.nodes.count, 1)
        let node = c.document.nodes[0]
        XCTAssertEqual(node.subpaths[0].anchors.count, 3)
        XCTAssertFalse(node.subpaths[0].closed)
        XCTAssertFalse(hasPaint(node.fill))
        let pulled = node.subpaths[0].anchors[1]
        XCTAssertEqual(pulled.out, Vec2(130, 40))
        XCTAssertEqual(pulled.in, Vec2(70, -20))
        XCTAssertEqual(c.history.state.undoCount, 1)
        c.undo()
        XCTAssertTrue(c.document.nodes.isEmpty)
    }

    func testPenClosesOnTheFirstPoint() throws {
        let (c, g) = try editor()
        c.setTool("pen")
        click(g, 10, 10)
        click(g, 100, 10)
        click(g, 100, 100)
        click(g, 11, 11)
        XCTAssertFalse(g.isDrawingPath)
        let node = c.document.nodes[0]
        XCTAssertTrue(node.subpaths[0].closed)
        XCTAssertEqual(node.subpaths[0].anchors.count, 3)
        XCTAssertTrue(hasPaint(node.fill))
    }

    func testPenSinglePointIsTakenBack() throws {
        let (c, g) = try editor()
        c.setTool("pen")
        click(g, 10, 10)
        g.finishPath()
        XCTAssertTrue(c.document.nodes.isEmpty)
        XCTAssertEqual(c.history.state.undoCount, 0)
    }

    func testPencilFitsCurvesToTheStroke() throws {
        let (c, g) = try editor()
        c.setTool("pencil")
        g.pointerDown(VectorPointerEvent(x: 0, y: 100))
        for i in 1...40 {
            let x: Double = Double(i) * 5
            let y: Double = 100 + 40 * sin(Double(i) / 6)
            g.pointerMove(VectorPointerEvent(x: x, y: y))
        }
        XCTAssertEqual(g.overlay.stroke.count, 41)
        g.pointerUp(VectorPointerEvent(x: 200, y: 100))
        XCTAssertTrue(g.overlay.stroke.isEmpty)
        let node = try XCTUnwrap(c.document.nodes.first)
        XCTAssertEqual(node.name, "Pencil")
        XCTAssertFalse(hasPaint(node.fill))
        XCTAssertTrue(hasPaint(node.stroke))
        XCTAssertGreaterThanOrEqual(node.subpaths[0].anchors.count, 2)
        XCTAssertLessThan(node.subpaths[0].anchors.count, 41)
    }

    func testDirectSelectionDragsAnAnchor() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        c.setTool("direct")
        click(g, 50, 50)
        XCTAssertEqual(c.selectedIds, [a])
        XCTAssertEqual(g.visibleAnchors().count, 4)
        drag(g, from: (100, 100), to: (150, 120))
        XCTAssertEqual(g.anchors, [VectorAnchorRef(nodeId: a, subpath: 0, index: 2)])
        let anchor = try XCTUnwrap(getAnchorWorld(c.document, VectorAnchorRef(nodeId: a, subpath: 0, index: 2)))
        XCTAssertEqual(anchor, Vec2(150, 120))
        XCTAssertEqual(c.history.state.undoCount, 2)
    }

    func testKnifeCutsAndScissorsSplit() throws {
        let (c, g) = try editor()
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        c.setTool("knife")
        drag(g, from: (50, -20), to: (50, 120))
        XCTAssertEqual(c.document.nodes.count, 2)
        let line = try c.addShape(VectorShapeInput(kind: "line", x: 200, y: 0, width: 100, height: 0))
        c.setTool("scissors")
        click(g, 250, 0)
        // The line keeps its first half; the second is a new path.
        XCTAssertEqual(c.document.nodes.count, 4)
        XCTAssertEqual(c.getNode(line)?.subpaths[0].anchors.last?.x, 250)
    }

    func testPaintBucketTypeAndBlend() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 40, height: 40))
        let b = try c.addShape(VectorShapeInput(kind: "ellipse", x: 200, y: 0, width: 40, height: 40))
        c.setTool("blend")
        click(g, 20, 20)
        XCTAssertEqual(g.overlay.blendStart, a)
        click(g, 220, 20)
        XCTAssertNil(g.overlay.blendStart)
        XCTAssertEqual(c.document.nodes.count, 1)
        XCTAssertTrue(isVectorBlendGroup(c.document.nodes[0]))
        _ = b
        c.setTool("type")
        click(g, 300, 300)
        XCTAssertEqual(c.document.nodes.last?.isText, true)
        c.setTool("paintBucket")
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 400, y: 400, width: 100, height: 100, style: ["fill": .null]))
        let before = c.document.nodes.count
        click(g, 450, 450)
        XCTAssertEqual(c.document.nodes.count, before + 1)
    }

    func testUnsupportedToolSaysSo() throws {
        let (c, g) = try editor()
        var message: String?
        g.onMessage = { message = $0 }
        c.setTool("width")
        click(g, 10, 10)
        XCTAssertEqual(message?.contains("not on the Swift canvas yet"), true)
    }

    func testCancelPutsTheDragBack() throws {
        let (c, g) = try editor()
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        c.setTool("select")
        g.pointerDown(VectorPointerEvent(x: 50, y: 50))
        g.pointerMove(VectorPointerEvent(x: 150, y: 50))
        XCTAssertEqual(try bounds(c, a).x, 100, accuracy: 1e-9)
        g.cancel()
        XCTAssertEqual(try bounds(c, a).x, 0, accuracy: 1e-9)
        XCTAssertFalse(g.isDragging)
        XCTAssertEqual(c.history.state.undoCount, 1)
    }

    func testPanAndZoomKeepThePointUnderThePointer() throws {
        let (c, g) = try editor()
        let before = g.toDocument(300, 200)
        g.zoom(by: 2, aboutX: 300, y: 200)
        XCTAssertEqual(c.viewport.zoom, 2)
        let after = g.toDocument(300, 200)
        XCTAssertEqual(after.x, before.x, accuracy: 1e-9)
        XCTAssertEqual(after.y, before.y, accuracy: 1e-9)
        g.pan(dx: 10, dy: -5)
        XCTAssertEqual(c.viewport.x, -290, accuracy: 1e-9)
        // The middle button drags the view.
        g.pointerDown(VectorPointerEvent(x: 0, y: 0, button: 1))
        g.pointerMove(VectorPointerEvent(x: 30, y: 40, button: 1))
        g.pointerUp(VectorPointerEvent(x: 30, y: 40, button: 1))
        XCTAssertEqual(c.viewport.x, -260, accuracy: 1e-9)
        XCTAssertEqual(c.history.state.undoCount, 0)
        // Drawing at zoom 2 lands in document space.
        c.setTool("rect")
        let s = g.toScreen(Vec2(10, 10))
        let e = g.toScreen(Vec2(30, 20))
        drag(g, from: (s.x, s.y), to: (e.x, e.y))
        let b = try bounds(c, c.document.nodes[0].id)
        XCTAssertEqual(b.width, 20, accuracy: 1e-9)
        XCTAssertEqual(b.height, 10, accuracy: 1e-9)
    }

    func testHitTestFollowsPaint() throws {
        let (c, _) = try editor()
        let filled = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        let hollow = try c.addShape(VectorShapeInput(kind: "rect", x: 200, y: 0, width: 100, height: 100, style: ["fill": .null]))
        XCTAssertEqual(VectorHitTest.topLevel(c.document, Vec2(50, 50), tolerance: 3), filled)
        XCTAssertNil(VectorHitTest.topLevel(c.document, Vec2(250, 50), tolerance: 3))
        XCTAssertEqual(VectorHitTest.topLevel(c.document, Vec2(201, 50), tolerance: 3), hollow)
        _ = try c.updateNode(filled, ["locked": true])
        XCTAssertNil(VectorHitTest.topLevel(c.document, Vec2(50, 50), tolerance: 3))
    }
}
