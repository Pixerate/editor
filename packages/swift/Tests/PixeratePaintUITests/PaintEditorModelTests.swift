import CoreGraphics
import Foundation
import PixerateCore
import PixeratePaint
import PixerateRaster
import XCTest
@testable import PixeratePaintUI

/// A mouse event at viewport point (x, y).
private func mouse(_ x: Double, _ y: Double, t: Double = 0) -> PaintPointerEvent {
    PaintPointerEvent(x: x, y: y, sample: PaintPointerSample(pointerType: "mouse", pressure: 0.5, timeStamp: t))
}

/// A pen event at (x, y) with pressure and tilt.
private func pen(_ x: Double, _ y: Double, pressure: Double, t: Double, coalesced: [PaintPointerEvent] = []) -> PaintPointerEvent {
    PaintPointerEvent(pointerId: 7, x: x, y: y, sample: PaintPointerSample(pointerType: "pen", pressure: pressure, altitudeAngle: 0.9, azimuthAngle: 0.5, timeStamp: t), coalesced: coalesced)
}

@MainActor
final class PaintEditorModelTests: XCTestCase {
    /// A model on a 256 × 256 canvas shown at 1:1 in a 256 × 256 viewport (screen = document).
    private func makeModel(width: Double = 256, height: Double = 256) throws -> PaintEditorModel {
        let model = try PaintEditorModel(controller: PaintEditorController(width: width, height: height))
        model.viewport = (width, height)
        _ = model.controller.setView(zoom: 1, pan: (0, 0))
        return model
    }

    private func call(_ registry: ToolRegistry, _ name: String, _ args: JSONObject = [:]) async throws -> JSONObject {
        let r = await registry.callTool(name, args)
        if r.isError { XCTFail("\(name): \(r.text ?? "")") }
        return try XCTUnwrap(r.structuredContent)
    }

    // MARK: - Tools and shortcuts

    func testToolSwitchingFromShortcutsAndToolbarRows() throws {
        let model = try makeModel()
        XCTAssertEqual(model.tool, "brush")
        XCTAssertTrue(model.handleKey("i"))
        XCTAssertEqual(model.tool, "eyedropper")
        XCTAssertTrue(model.handleKey("g"))
        XCTAssertEqual(model.tool, "fill")
        XCTAssertTrue(model.handleKey("H"))
        XCTAssertEqual(model.tool, "pan")
        XCTAssertTrue(model.handleKey("r"))
        XCTAssertEqual(model.tool, "rotate")
        XCTAssertTrue(model.handleKey("v"))
        XCTAssertEqual(model.tool, "stroke")
        // Stickers are not ported: the key is not handled and the tool stays.
        XCTAssertFalse(model.handleKey("s"))
        XCTAssertEqual(model.tool, "stroke")
        XCTAssertTrue(model.handleKey("b"))
        XCTAssertEqual(model.tool, "brush")
        XCTAssertFalse(model.handleKey("q"))
        // The gesture follows the model's tool.
        model.tool = "eyedropper"
        XCTAssertEqual(model.gesture.tool, "eyedropper")
    }

    func testShortcutsRunTheSameControllerCallsAsTheirTools() async throws {
        let model = try makeModel()
        let c = model.controller
        XCTAssertEqual(paintShortcutFor(model.commands, key: "z", mod: true)?.id, "undo")
        XCTAssertEqual(paintShortcutFor(model.commands, key: "Z", mod: true, shift: true)?.id, "redo")
        XCTAssertEqual(paintShortcutFor(model.commands, key: "y", mod: true)?.id, "redo")
        XCTAssertEqual(paintShortcutFor(model.commands, key: "escape")?.id, "view.reset")
        XCTAssertNil(paintShortcutFor(model.commands, key: "z"))

        _ = try await call(model.registry, "add_layer", ["name": "Sky"])
        XCTAssertEqual(c.listLayers().count, 2)
        XCTAssertTrue(model.handleKey("z", mod: true))
        XCTAssertEqual(c.listLayers().count, 1)
        XCTAssertTrue(model.handleKey("z", mod: true, shift: true))
        XCTAssertEqual(c.listLayers().count, 2)

        let size = c.brush.tip.size
        XCTAssertTrue(model.handleKey("]"))
        XCTAssertEqual(c.brush.tip.size, size + max(1, (size * 0.15).rounded()))
        XCTAssertTrue(model.handleKey("["))
        XCTAssertEqual(c.brush.tip.size, size)

        let (paint, second) = (c.color, c.secondaryColor)
        XCTAssertTrue(model.handleKey("x"))
        XCTAssertEqual(c.color, second)
        XCTAssertEqual(c.secondaryColor, paint)

        XCTAssertTrue(model.handleKey("m"))
        XCTAssertTrue(c.view.mirror)
        _ = c.setView(zoom: 3, rotation: 30)
        XCTAssertTrue(model.handleKey("Escape"))
        XCTAssertEqual([c.view.zoom, c.view.panX, c.view.panY, c.view.rotation], [1, 0, 0, 0])
        XCTAssertFalse(c.view.mirror)
    }

    // MARK: - Strokes

    func testAGestureStrokeChangesTheDocumentAndPixelsAsPaintStrokeDoes() async throws {
        let model = try makeModel()
        let before = model.revision
        XCTAssertTrue(model.pointerDown(pen(40, 60, pressure: 0.3, t: 0)))
        let open = try XCTUnwrap(model.controller.activeStroke)
        // Coalesced samples arrive together with their move.
        model.pointerMove(pen(120, 90, pressure: 0.7, t: 32, coalesced: [pen(80, 70, pressure: 0.5, t: 16), pen(120, 90, pressure: 0.7, t: 32)]))
        model.pointerMove(pen(200, 180, pressure: 0.9, t: 48))
        XCTAssertEqual(open.points.count, 4)
        XCTAssertNil(model.controller.undoLabel, "nothing is recorded until the pen lifts")
        model.pointerUp(pen(200, 180, pressure: 0, t: 64))
        XCTAssertNil(model.controller.activeStroke)
        XCTAssertGreaterThan(model.revision, before)
        XCTAssertEqual(model.controller.undoLabel, "\(model.controller.brush.name) stroke")
        let stroke = try XCTUnwrap(model.controller.strokes.last)
        XCTAssertEqual(stroke.points.map(\.x), [40, 80, 120, 200])
        XCTAssertEqual(stroke.points[1].pressure, 0.5)
        XCTAssertNotNil(stroke.points[0].altitude, "pen tilt reaches the samples")

        // The same stroke through the agent tool on a fresh editor.
        let other = try makeModel()
        let result = try await call(other.registry, "paint_stroke", ["points": .array(stroke.points.map(\.json)), "seed": .number(Double(stroke.seed))])
        XCTAssertEqual(result["strokeId"], .string("s1"))
        let a = model.controller.compositePixels(), b = other.controller.compositePixels()
        XCTAssertEqual(a.data, b.data, "the gesture paints the same pixels as paint_stroke")
        XCTAssertNotEqual(a.data, try makeModel().controller.compositePixels().data, "the stroke changed pixels")
        var docA = model.controller.toJSON(), docB = other.controller.toJSON()
        // Layer ids are made from the clock; compare the rest.
        for k in ["layers", "activeLayerId", "assets"] { docA[k] = nil; docB[k] = nil }
        var strokesA = docA["strokes"]?.arrayValue ?? [], strokesB = docB["strokes"]?.arrayValue ?? []
        for i in strokesA.indices { if var o = strokesA[i].objectValue { o["layerId"] = nil; strokesA[i] = .object(o) } }
        for i in strokesB.indices { if var o = strokesB[i].objectValue { o["layerId"] = nil; strokesB[i] = .object(o) } }
        docA["strokes"] = nil
        docB["strokes"] = nil
        XCTAssertEqual(strokesA, strokesB)
        XCTAssertEqual(docA, docB)
        XCTAssertEqual(model.controller.toJSON()["layers"]?.arrayValue?.first?["png"], other.controller.toJSON()["layers"]?.arrayValue?.first?["png"])
    }

    func testALiveStrokeIsDrawnWhilePaintedAndCancelPutsItBack() throws {
        let model = try makeModel()
        let presenter = PaintCanvasPresenter(controller: model.controller)
        XCTAssertEqual(presenter.render(), 1, "a 256 × 256 canvas is one tile")
        let blank = model.controller.compositePixels().data
        XCTAssertTrue(model.pointerDown(mouse(30, 30)))
        model.pointerMove(mouse(220, 200))
        XCTAssertNotEqual(model.controller.compositePixels().data, blank, "the open stroke shows")
        XCTAssertEqual(presenter.render(), 1)
        model.pointerCancel()
        XCTAssertNil(model.controller.activeStroke)
        XCTAssertEqual(model.controller.compositePixels().data, blank)
        XCTAssertNil(model.controller.undoLabel)
        XCTAssertEqual(presenter.render(), 1)
        XCTAssertEqual(presenter.render(), 0, "nothing changed since")
    }

    func testFillDragNeverUndoesAnEarlierEditWhenItsFillMadeNoUndoStep() throws {
        let model = try makeModel()
        // A closed 30 px box: contracting its inside by 16 px empties the fill, so it commits nothing.
        let corners = [PenPoint(x: 40, y: 40), PenPoint(x: 70, y: 40), PenPoint(x: 70, y: 70), PenPoint(x: 40, y: 70), PenPoint(x: 40, y: 40)]
        let box = (0..<4).flatMap { k in (0..<10).map { i -> PenPoint in
            let a = corners[k], b = corners[k + 1], t = Double(i) / 10
            return PenPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        } } + [corners[0]]
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: box)
        XCTAssertEqual(model.controller.strokes.count, 1)
        model.tool = "fill"
        model.gesture.fillOptions = PaintFillOptions(reference: "layer", tolerance: 32, closeGap: 0, expand: -16)
        XCTAssertTrue(model.gesture.down(mouse(55, 55)))
        model.gesture.move(mouse(95, 55))
        model.gesture.move(mouse(135, 55))
        model.gesture.cancel()
        XCTAssertEqual(model.controller.strokes.count, 1, "the box stroke is still there")
    }

    func testThePresenterRedrawsOnlyChangedTiles() throws {
        let model = try makeModel(width: 1024, height: 768)
        let presenter = PaintCanvasPresenter(controller: model.controller)
        XCTAssertEqual(presenter.render(), 12)
        XCTAssertEqual(presenter.render(), 0)
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: [PenPoint(x: 20, y: 20), PenPoint(x: 60, y: 40)])
        XCTAssertEqual(presenter.render(), 1)
        let image = try XCTUnwrap(presenter.image())
        XCTAssertEqual(image.width, 1024)
        XCTAssertEqual(image.height, 768)
    }

    func testThePresenterDrawsTileImagesAndRebuildsOnlyTheChangedOnes() throws {
        let model = try makeModel(width: 600, height: 300)
        let presenter = PaintCanvasPresenter(controller: model.controller)
        let first = presenter.tiles()
        // Rows top to bottom, each reaching 2 pixels into its right and lower neighbours (clipped to the canvas).
        XCTAssertEqual(first.map { [$0.tx, $0.ty] }, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]])
        XCTAssertEqual(first.map(\.rect), [
            CGRect(x: 0, y: 0, width: 258, height: 258), CGRect(x: 256, y: 0, width: 258, height: 258), CGRect(x: 512, y: 0, width: 88, height: 258),
            CGRect(x: 0, y: 256, width: 258, height: 44), CGRect(x: 256, y: 256, width: 258, height: 44), CGRect(x: 512, y: 256, width: 88, height: 44),
        ])
        XCTAssertTrue(presenter.tiles().elementsEqual(first) { $0.image === $1.image }, "nothing changed: the same images")
        // A stroke inside tile (1, 0) rebuilds it and the tile to its left, whose image reaches into it.
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: [PenPoint(x: 300, y: 100), PenPoint(x: 400, y: 150)])
        let next = presenter.tiles()
        XCTAssertEqual(presenter.lastTilesDrawn, 1)
        XCTAssertEqual(zip(first, next).filter { $0.image !== $1.image }.map { [$1.tx, $1.ty] }, [[0, 0], [1, 0]])
        // The tiles hold the composite, premultiplied BGRA.
        let composite = model.controller.compositePixels(wet: "display").data
        for tile in next {
            let bytes = try XCTUnwrap(tile.image.dataProvider?.data as Data?)
            XCTAssertEqual(tile.image.bitmapInfo, CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue))
            let w = Int(tile.rect.width)
            for y in 0..<Int(tile.rect.height) {
                for x in 0..<w {
                    let s = ((Int(tile.rect.minY) + y) * 600 + Int(tile.rect.minX) + x) * 4
                    let d = (y * w + x) * 4
                    let a = UInt16(composite[s + 3])
                    let expect = [2, 1, 0].map { UInt8((UInt16(composite[s + $0]) * a + 127) / 255) } + [UInt8(a)]
                    if Array(bytes[d..<(d + 4)]) != expect { return XCTFail("tile (\(tile.tx), \(tile.ty)) pixel (\(x), \(y))") }
                }
            }
        }
    }

    func testTileLayersKeepTheirImagesUntilTheirTileChanges() throws {
        let model = try makeModel(width: 600, height: 300)
        let presenter = PaintCanvasPresenter(controller: model.controller)
        let view = PaintTilesLayerView()
        let t = CGAffineTransform(a: 0.5, b: 0, c: 0, d: 0.5, tx: 10, ty: 20)
        view.update(PaintTilesView(tiles: presenter.tiles(), transform: t, smooth: true))
        let layers = view.tileLayers
        XCTAssertEqual(layers.map(\.frame), presenter.tiles().map(\.rect), "one layer per tile, in drawing order")
        XCTAssertEqual(layers.first?.superlayer?.affineTransform(), t)
        XCTAssertEqual(layers.first?.magnificationFilter, .linear)
        let before = layers.map { $0.contents as AnyObject? }
        _ = try model.controller.paintStroke(PaintStrokeInit(seed: 3), points: [PenPoint(x: 300, y: 100), PenPoint(x: 400, y: 150)])
        view.update(PaintTilesView(tiles: presenter.tiles(), transform: .identity, smooth: false))
        XCTAssertTrue(view.tileLayers.elementsEqual(layers) { $0 === $1 }, "the same layers")
        let changed = zip(before, view.tileLayers).enumerated().filter { $1.0 !== ($1.1.contents as AnyObject?) }.map(\.offset)
        XCTAssertEqual(changed, [0, 1], "only the painted tile and the one reaching into it get new images")
        XCTAssertEqual(view.tileLayers.first?.magnificationFilter, .nearest, "zoomed in: square pixels")
        XCTAssertTrue(zip(view.tileLayers, presenter.tiles()).allSatisfy { ($0.contents as AnyObject?) === $1.image })
    }

    func testRefusalsShowAsErrorsAndOtherToolsDoNotPaint() throws {
        let model = try makeModel()
        let c = model.controller
        let id = try XCTUnwrap(c.doc.activeLayerId)
        model.updateLayer(id, ["visible": false])
        XCTAssertFalse(model.pointerDown(mouse(10, 10)))
        XCTAssertEqual(model.error, "Layer \"Layer 1\" is hidden; show it (update_layer visible true) to paint on it.")
        model.updateLayer(id, ["visible": true])

        // The eyedropper picks the colour under the pointer (here the paper).
        model.tool = "eyedropper"
        let picked = try c.pickColor(100, 100)["color"]?.stringValue
        XCTAssertFalse(model.pointerDown(mouse(100, 100)))
        XCTAssertEqual(c.color, picked)

        // Pan moves the view by the drag; nothing is painted.
        model.tool = "pan"
        XCTAssertTrue(model.pointerDown(mouse(100, 100)))
        model.pointerMove(mouse(130, 90))
        model.pointerUp(mouse(130, 90))
        XCTAssertEqual(c.view.panX, 30)
        XCTAssertEqual(c.view.panY, -10)
        XCTAssertTrue(c.strokes.isEmpty)

        // A touch next to a pen that is down is the palm.
        model.tool = "brush"
        _ = c.resetView()
        XCTAssertTrue(model.pointerDown(pen(100, 100, pressure: 0.5, t: 0)))
        XCTAssertFalse(model.pointerDown(PaintPointerEvent(pointerId: 9, x: 150, y: 160, sample: PaintPointerSample(pointerType: "touch"))))
        model.pointerUp(pen(100, 100, pressure: 0, t: 10))
        XCTAssertEqual(c.strokes.count, 1)
    }

    func testWheelZoomsAboutThePointer() throws {
        let model = try makeModel()
        let c = model.controller
        let under = screenToDocument(c.view, c.doc.canvas, viewport: 256, 256, 200, 50)
        model.gesture.wheel(x: 200, y: 50, deltaY: -200)
        XCTAssertGreaterThan(c.view.zoom, 1)
        let after = screenToDocument(c.view, c.doc.canvas, viewport: 256, 256, 200, 50)
        XCTAssertEqual(after.x, under.x, accuracy: 1e-9)
        XCTAssertEqual(after.y, under.y, accuracy: 1e-9)
        model.gesture.wheel(x: 0, y: 0, deltaY: 10, shiftKey: true)
        XCTAssertEqual(c.view.rotation, 5)
    }

    // MARK: - Layers

    func testLayerPanelActionsAreUndoSteps() throws {
        let model = try makeModel()
        let c = model.controller
        model.addLayer()
        XCTAssertEqual(model.layers.map(\.name), ["Layer 2", "Layer 1"])
        XCTAssertEqual(model.activeLayer?.name, "Layer 2")
        model.duplicateLayer()
        XCTAssertEqual(model.layers.map(\.name), ["Layer 2 copy", "Layer 2", "Layer 1"])
        model.moveLayer(-1)
        XCTAssertEqual(model.layers.map(\.name), ["Layer 2", "Layer 2 copy", "Layer 1"])
        model.moveLayer(1)
        XCTAssertEqual(model.layers.map(\.name), ["Layer 2 copy", "Layer 2", "Layer 1"])
        let top = try XCTUnwrap(model.activeLayer)
        model.toggleVisible(top)
        XCTAssertEqual(model.activeLayer?.visible, false)
        model.updateLayer(top.id, ["opacity": 0.4, "blend": "multiply"])
        XCTAssertEqual(model.activeLayer?.opacity, 0.4)
        XCTAssertEqual(model.activeLayer?.blend, "multiply")
        model.mergeDown()
        XCTAssertEqual(model.layers.count, 2)
        model.removeLayer()
        XCTAssertEqual(model.layers.count, 1)
        // The panel keeps the last layer (React disables Delete), and says why.
        model.removeLayer()
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.layers.count, 1)
        // Each action was one step: undo walks them back.
        while c.undoLabel != nil { model.undo() }
        XCTAssertEqual(model.layers.map(\.name), ["Layer 1"])
        model.addLayer(type: "strokes")
        XCTAssertNotNil(model.liveStrokes)
        model.addLayer(type: "group")
        XCTAssertEqual(model.activeLayer?.type, "group")
    }

    func testStrokeLayerEditsAndLayerStyles() throws {
        let model = try makeModel()
        let c = model.controller
        model.addLayer(type: "strokes")
        XCTAssertTrue(model.pointerDown(mouse(40, 40)))
        model.pointerMove(mouse(120, 60))
        model.pointerUp(mouse(120, 60))
        let stroke = try XCTUnwrap(model.liveStrokes?.first)
        // The Select stroke tool picks it and drags it.
        model.tool = "stroke"
        XCTAssertTrue(model.pointerDown(mouse(80, 50)))
        XCTAssertEqual(model.selectedStroke, stroke.id)
        model.pointerMove(mouse(90, 70))
        XCTAssertEqual(model.strokeDrag?.dx, 10)
        model.pointerUp(mouse(90, 70))
        XCTAssertEqual(model.liveStrokes?.first?.points.first?.x, 50)
        model.updateSelectedStroke(brushChanges: patchPath([:], "tip.size", .number(12)))
        XCTAssertEqual(model.liveStrokes?.first?.brush.tip.size, 12)
        model.updateSelectedStroke(color: "#ff0000")
        XCTAssertEqual(model.liveStrokes?.first?.color, "#ff0000")
        XCTAssertEqual(c.undoLabel, "Edit stroke")

        model.addEffect("drop-shadow")
        let fx = try XCTUnwrap(model.layerEffects?.items.first)
        XCTAssertEqual(fx.kind, .dropShadow)
        XCTAssertEqual(model.selectedEffect, fx.id)
        model.setEffectControl(fx, "distance", .number(12))
        XCTAssertEqual(layerEffectControls(try XCTUnwrap(model.layerEffects?.items.first)).first { $0.key == "distance" }?.json["value"], .number(12))
        model.setEffectsEnabled(false)
        XCTAssertEqual(model.layerEffects?.enabled, false)
        model.removeEffect(fx.id)
        XCTAssertEqual(model.layerEffects?.items.count, 0)
    }

    func testAgentCallsRefreshTheModel() async throws {
        let model = try makeModel()
        let before = model.revision
        _ = try await call(model.registry, "set_color", ["color": "#336699"])
        XCTAssertGreaterThan(model.revision, before)
        XCTAssertEqual(model.color, "#336699")
        XCTAssertTrue(model.registry.hasTool("paint_stroke"))
        XCTAssertTrue(model.registry.hasTool("list_brush_presets"))
    }

    // MARK: - Panels from the contract tables

    func testPanelsListTheContractRows() throws {
        let model = try makeModel()
        let t = model.tables
        XCTAssertEqual(model.toolRows.map(\.id), t.tools.map(\.id).filter { $0 != "sticker" })
        XCTAssertEqual(model.toolRows.map(\.label), ["Brush", "Fill", "Eyedropper", "Select stroke", "Pan", "Rotate view"])
        // Every brush option row maps to a facet and reads the engine brush.
        XCTAssertEqual(t.brushOptions.map(\.id), ["size", "hardness", "opacity", "flow", "smoothing"])
        for item in t.brushOptions { XCTAssertNotNil(PAINT_BRUSH_OPTION_PATHS[item.id], item.id) }
        let size = try XCTUnwrap(t.brushOptions.first)
        model.setBrushOption(size, 42)
        XCTAssertEqual(model.brushOption(size), 42)
        XCTAssertEqual(model.controller.brush.tip.size, 42)
        // Paper: every row of the table, in its order (wet media read absorption, permeability and roughness).
        XCTAssertEqual(model.paperSliders.map(\.path), t.sliders.paper.map(\.path))
        XCTAssertEqual(model.paperSliders.map(\.label), t.sliders.paper.filter { PAINT_PAPER_SLIDER_PATHS.contains($0.path) }.map(\.label))
        model.setPaperValue("dry.contrast", 2)
        XCTAssertEqual(model.paperValue("dry.contrast"), 2)
        XCTAssertEqual(model.controller.undoLabel != nil, true)
        // Stroke sliders read the stroke's brush.
        XCTAssertEqual(t.sliders.stroke.map(\.path), ["tip.size", "tip.opacity", "tip.flow"])
        XCTAssertEqual(strokeSliderValue(model.brush, "tip.size"), 42)
        // The blend menu: the standard modes, then the paint modes, as the layers offer them.
        XCTAssertEqual(t.blendMenu.map(\.label), ["Standard", "Paint"])
        XCTAssertEqual(Set(t.blendMenu.flatMap(\.modes).map(\.id)), Set(BLEND_MODES.map(\.id.rawValue)))
        // Layer styles: one row per kind, and the controls the panel draws for a new style are the table's.
        XCTAssertEqual(t.layerEffects.map(\.kind), LAYER_EFFECT_MENU.map(\.kind.rawValue))
        for row in t.layerEffects {
            let kind = try XCTUnwrap(LayerEffectKind(rawValue: row.kind))
            let controls = layerEffectControls(defaultLayerEffect(kind, "fx"))
            XCTAssertEqual(controls.map(\.key), row.controls.map(\.key), row.kind)
            XCTAssertEqual(controls.map { $0.json["label"]?.stringValue }, row.controls.map(\.label), row.kind)
        }
        // Every built-in brush is in the picker, stamp tips included (they lay the editor's stamps); wet, impasto, particle, bristle and sticker brushes too.
        XCTAssertFalse(model.brushes.isEmpty)
        XCTAssertTrue(model.brushes.allSatisfy { ["dab", "eraser", "mixer", "blender", "smudge", "wet", "impasto", "particle", "bristle", "sticker", "vortex"].contains($0.engine) })
        XCTAssertEqual(model.brushes.count, model.controller.brushes.count)
        XCTAssertTrue(model.brushes.contains { $0.engine == "wet" })
        XCTAssertTrue(model.brushes.contains { $0.engine == "impasto" })
        XCTAssertTrue(model.brushes.contains { $0.engine == "particle" })
        XCTAssertTrue(model.brushes.contains { $0.engine == "bristle" })
        XCTAssertLessThanOrEqual(model.brushes.count, model.controller.brushes.count)
    }

    func testReadPathAndPatchPath() {
        let o: JSONObject = ["dry": ["contrast": 1, "bias": 0.2], "depth": 0.5]
        XCTAssertEqual(readPath(o, "dry.contrast"), 1)
        XCTAssertEqual(readPath(o, "depth"), 0.5)
        XCTAssertEqual(readPath(o, "missing.x"), 0)
        XCTAssertEqual(patchPath(o, "depth", 0.7), ["depth": 0.7])
        XCTAssertEqual(patchPath(o, "dry.contrast", 2), ["dry": ["contrast": 2, "bias": 0.2]])
    }

    // MARK: - Wet paint, thick paint and light

    func testWetLightAndSpillPanelsListTheirTableRows() throws {
        let model = try makeModel()
        let t = model.tables
        XCTAssertTrue(PaintPanelTab.allCases.contains(.wet))
        // Wet settings: every row is a wet parameter, in the table's order.
        XCTAssertEqual(model.wetSliders.map(\.path), t.sliders.wet.map(\.path))
        XCTAssertEqual(Set(model.wetSliders.map(\.path)), Set(WET_PARAM_KEYS))
        for c in model.wetSliders { XCTAssertEqual(model.wetParam(c.path), DEFAULT_WET_PARAMS[c.path], c.path) }
        XCTAssertEqual(model.wetTiltSliders.map(\.path), ["angle", "direction"])
        XCTAssertEqual(model.wetSpeedSlider.path, "speed")
        XCTAssertEqual(model.wetGpuOptions.map(\.value), ["auto", "off"])
        XCTAssertEqual(model.lightSliders.map(\.path), ["azimuth", "elevation", "relief"])
        XCTAssertEqual(model.lightSliders.map(\.label), t.sliders.light.map(\.label))
        // Each row sets what it shows, through the same controller calls as the agent tools.
        model.setWetParam("bloom", 0.9)
        XCTAssertEqual(model.wetParam("bloom"), 0.9)
        model.setTilt("angle", 30)
        XCTAssertEqual(model.tiltValue("angle"), 30)
        model.setWetSpeed(240)
        XCTAssertEqual(model.wet.speed, 240)
        model.setLighting("elevation", 60)
        XCTAssertEqual(model.lightingValue("elevation"), 60)
        model.setFlowKind("swirl")
        XCTAssertEqual(model.wetLayer?.flow.kind, "swirl")
        model.setWetEngine("off")
        XCTAssertEqual(model.wet.gpuMode, "off")
        // Light spill shows for a layer with light paint.
        XCTAssertEqual(model.activeLight?.hasLight, false)
    }

    func testTickingAdvancesTheWetClockAndRedrawsOnlyChangedTiles() async throws {
        let model = try makeModel(width: 600, height: 300)
        let presenter = PaintCanvasPresenter(controller: model.controller)
        _ = try await call(model.registry, "paint_stroke", ["points": [["x": 20, "y": 30], ["x": 90, "y": 60, "pressure": 0.8]], "brushId": "watercolor-round", "color": "#2255aa", "seed": 3])
        XCTAssertTrue(model.wet.isWet())
        XCTAssertEqual(presenter.render(), 6)
        // The first tick only starts the clock; then the speed (120 steps a second) sets the steps.
        XCTAssertEqual(model.tick(now: 1000), 0)
        XCTAssertEqual(model.tick(now: 1050), 6)
        XCTAssertEqual(model.wetClock, 6)
        // Only the tile with wet paint is drawn again.
        XCTAssertEqual(presenter.render(), 1)
        XCTAssertEqual(model.tick(now: 1100), 6)
        XCTAssertEqual(model.wetClock, 12)
        // Paused: time stops.
        model.toggleWetPaused()
        XCTAssertEqual(model.tick(now: 2000), 0)
        XCTAssertEqual(model.wetClock, 12)
        model.toggleWetPaused()
        // The water overlay is drawn over the wet tile only.
        XCTAssertTrue(model.waterOverlayTiles.isEmpty)
        model.toggleWaterOverlay()
        XCTAssertEqual(model.waterOverlayTiles.map { [$0.tx, $0.ty] }, [[0, 0]])
        // Drying ends the flow.
        model.dryNow()
        XCTAssertFalse(model.wet.isWet())
        XCTAssertEqual(model.tick(now: 3000), 0)
    }

    func testBrushesFollowAnEditThatKeepsTheId() throws {
        let model = try makeModel()
        var saved = try model.controller.brushLibrary.duplicate("pencil-6b", newId: "mine", name: "Before")
        XCTAssertEqual(model.brushes.first { $0.id == "mine" }?.name, "Before")
        saved["name"] = .string("After")
        _ = try model.controller.brushLibrary.save(.object(saved), overwrite: true)
        XCTAssertEqual(model.brushes.first { $0.id == "mine" }?.name, "After")
    }
}
