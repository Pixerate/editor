import CoreGraphics
import PixerateCore
import PixerateGeometry
import PixerateVector
import XCTest
@testable import PixerateVectorUI

/// The view model: agents and the user on one document, keys, panels and the scene.
@MainActor
final class VectorEditorModelTests: XCTestCase {
    private func model() throws -> VectorEditorModel {
        var n = 0
        let c = try VectorEditorController(createId: {
            n += 1
            return "n\(n)"
        })
        // Leave the process's text shaper alone (the conformance tests share it).
        return try VectorEditorModel(controller: c, textShaper: nil)
    }

    private func text(_ r: McpToolResult) -> String {
        r.content.compactMap { (c: McpToolContent) -> String? in
            if case let .text(t) = c { return t }
            return nil
        }.joined()
    }

    func testTheRegistryHasTheVectorTools() throws {
        let m = try model()
        let names = Set(m.registry.listTools().map(\.name))
        // The style tools carry their provider's prefix, as in the conformance host.
        for name in ["list_commands", "run_command", "run_commands", "vector-style__check_vector_style", "vector-style__fix_vector_style"] {
            XCTAssertTrue(names.contains(name), "\(name) in \(names.sorted())")
        }
        // No effects provider or models: no effect or generation tools.
        XCTAssertFalse(names.contains("apply_effect"))
        XCTAssertFalse(names.contains("generate_vector_art"))
        XCTAssertEqual(m.tables.tools.order.count, VECTOR_TOOLS.count)
    }

    func testAgentEditsShowInTheModel() async throws {
        let m = try model()
        let before = m.revision
        // The style tools answer to their bare names too.
        let style = await m.registry.callTool("check_vector_style", [:])
        XCTAssertFalse(style.isError, text(style))
        let r = await m.registry.callTool("run_command", ["id": "vector.addShape", "params": ["kind": "rect", "x": 10, "y": 20, "width": 100, "height": 50]])
        XCTAssertFalse(r.isError, text(r))
        XCTAssertGreaterThan(m.revision, before)
        XCTAssertEqual(m.layerRows.map(\.name), ["Rectangle"])
        let scene = m.scene
        XCTAssertNil(scene.issue)
        XCTAssertEqual(scene.data?["nodes"]?.arrayValue?.count, 1)
        // The user's edit goes into the same document the agent reads.
        m.selectAll()
        m.setStyle(["fill": "#ff0000"])
        let list = await m.registry.callTool("run_command", ["id": "vector.list"])
        XCTAssertTrue(text(list).contains("#ff0000"), text(list))
        // An agent switching the tool switches the toolbar.
        _ = await m.registry.callTool("run_command", ["id": "vector.setTool", "params": ["tool": "pen"]])
        XCTAssertEqual(m.tool, "pen")
    }

    func testBadAgentCallsFailWithoutChangingTheDocument() async throws {
        let m = try model()
        let r = await m.registry.callTool("run_command", ["id": "vector.addShape", "params": ["kind": "hexagon"]])
        XCTAssertTrue(r.isError)
        XCTAssertTrue(m.document.nodes.isEmpty)
    }

    func testKeysSwitchToolsUndoDeleteAndRunCommandShortcuts() throws {
        let m = try model()
        XCTAssertTrue(m.handleKey("r"))
        XCTAssertEqual(m.tool, "rect")
        XCTAssertTrue(m.handleKey("P"))
        XCTAssertEqual(m.tool, "pen")
        XCTAssertTrue(m.handleKey("v"))
        XCTAssertEqual(m.tool, "select")
        let c = m.controller
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 10, height: 10))
        _ = try c.addShape(VectorShapeInput(kind: "ellipse", x: 20, y: 0, width: 10, height: 10))
        XCTAssertTrue(m.handleKey("a", mod: true))
        XCTAssertEqual(m.selection.count, 2)
        // ⌘G is the contract's shortcut for vector.group.
        XCTAssertEqual(m.commandFor(key: "g", mod: true, shift: false, alt: false), "vector.group")
        XCTAssertEqual(m.commandFor(key: "g", mod: true, shift: true, alt: false), "vector.ungroup")
        XCTAssertEqual(m.commandFor(key: "7", mod: true, shift: false, alt: true), "vector.releaseMask")
        XCTAssertTrue(m.handleKey("g", mod: true))
        XCTAssertEqual(c.document.nodes.count, 1)
        XCTAssertTrue(c.document.nodes[0].isGroup)
        XCTAssertTrue(m.handleKey("z", mod: true))
        XCTAssertEqual(c.document.nodes.count, 2)
        XCTAssertTrue(m.handleKey("z", mod: true, shift: true))
        XCTAssertEqual(c.document.nodes.count, 1)
        // Arrows nudge, Delete deletes.
        let id = c.document.nodes[0].id
        c.select([id])
        XCTAssertTrue(m.handleKey("ArrowRight", shift: true))
        XCTAssertEqual(try vectorNodeBounds(c.document.nodes[0])?.x ?? -1, 10, accuracy: 1e-9)
        XCTAssertTrue(m.handleKey("Delete"))
        XCTAssertTrue(c.document.nodes.isEmpty)
        XCTAssertFalse(m.handleKey("ü"))
    }

    func testLayersPanelActions() throws {
        let m = try model()
        let c = m.controller
        let a = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 10, height: 10))
        let b = try c.addShape(VectorShapeInput(kind: "ellipse", x: 20, y: 0, width: 10, height: 10))
        XCTAssertEqual(m.layerRows.map(\.id), [b, a])
        m.toggleVisible(a)
        XCTAssertEqual(m.layerRows.last?.visible, false)
        m.toggleLocked(b)
        XCTAssertEqual(m.layerRows.first?.locked, true)
        m.toggleLocked(b)
        m.selectLayer(a)
        m.selectLayer(b, add: true)
        XCTAssertEqual(m.selection, [a, b])
        m.group()
        let g = try XCTUnwrap(c.document.nodes.first)
        XCTAssertEqual(m.layerRows.map(\.id), [g.id])
        m.toggleExpanded(g.id)
        XCTAssertEqual(m.layerRows.map(\.depth), [0, 1, 1])
        m.rename(g.id, "Pair")
        XCTAssertEqual(m.layerRows.first?.name, "Pair")
        c.select([g.id])
        m.ungroup()
        XCTAssertEqual(c.document.nodes.count, 2)
        c.select([a])
        m.arrange("front")
        XCTAssertEqual(c.document.nodes.last?.id, a)
    }

    func testSliderDragIsOneUndoStep() throws {
        let m = try model()
        let c = m.controller
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 10, height: 10))
        let steps = c.history.state.undoCount
        m.beginLiveEdit()
        for w in [3.0, 5.0, 8.0] { m.setStyle(["strokeWidth": .number(w)]) }
        m.endLiveEdit()
        XCTAssertEqual(c.document.nodes[0].strokeWidth, 8)
        XCTAssertEqual(c.history.state.undoCount, steps + 1)
        m.undo()
        XCTAssertEqual(c.document.nodes[0].strokeWidth, 2)
    }

    func testBooleansPathfinderAndRefusals() throws {
        let m = try model()
        let c = m.controller
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        _ = try c.addShape(VectorShapeInput(kind: "ellipse", x: 50, y: 50, width: 100, height: 100))
        c.clearSelection()
        m.boolean("union")
        XCTAssertNotNil(m.error)
        m.selectAll()
        m.boolean("union")
        XCTAssertNil(m.error)
        XCTAssertEqual(c.document.nodes.count, 1)
        m.undo()
        m.selectAll()
        m.pathfinder("divide")
        // Divide leaves its pieces in a group.
        var paths = 0
        walkVectorNodes(c.document.nodes) { (n: VectorNode, _: VectorNode?, _: Int) in if n.isPath { paths += 1 } }
        XCTAssertGreaterThan(paths, 2)
        m.undo()
        c.clearSelection()
        m.addEffect("roundCorners")
        XCTAssertNotNil(m.error)
        m.selectAll()
        m.addEffect("roundCorners")
        XCTAssertNil(m.error)
        XCTAssertEqual(c.document.nodes[0]["effects"]?.arrayValue?.count, 1)
    }

    func testSceneLeavesOutWhatCannotBeDrawnYet() throws {
        let m = try model()
        let c = m.controller
        _ = try c.addShape(VectorShapeInput(kind: "rect", x: 0, y: 0, width: 100, height: 100))
        // Arrowheads wait on the render data's stroke parts (#624).
        _ = try c.addShape(VectorShapeInput(kind: "line", x: 0, y: 200, width: 100, height: 0, style: ["endArrow": "triangle"]))
        let scene = m.scene
        XCTAssertEqual(scene.data?["nodes"]?.arrayValue?.count, 1)
        XCTAssertEqual(scene.issue?.contains("Line"), true, scene.issue ?? "")
    }

    func testZoomToFitCentresTheArtboard() throws {
        let m = try model()
        m.viewSize = (900, 700)
        m.fitOnce()
        // 40 points of padding round the 800 × 600 artboard.
        let v = m.viewport
        XCTAssertEqual(v.zoom, 1.025, accuracy: 1e-9)
        XCTAssertEqual(v.x, 40, accuracy: 1e-9)
        XCTAssertEqual(v.y, 42.5, accuracy: 1e-9)
        m.zoom(by: 2)
        XCTAssertEqual(m.viewport.zoom, 2.05, accuracy: 1e-9)
        XCTAssertTrue(m.handleKey("0", mod: true))
        XCTAssertEqual(m.viewport.zoom, 1.025, accuracy: 1e-9)
    }
}
