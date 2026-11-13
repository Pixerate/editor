import Foundation
import PixerateCore
import PixerateRaster
import XCTest
@testable import PixeratePaint

/// Dual-colour (light / dark) paint in the viewer's colour scheme (#718, #720): stroke layers
/// redrawn in the scheme's side, pixel layers replayed from the stroke log, the document never
/// changed. Ports of `paint-editor-dual-colour.test.ts` and `paint-editor-scheme-replay.test.ts`.
final class PaintColorSchemeTests: XCTestCase {
    private let ink = PaintDualColor(light: "#111827", dark: "#f9fafb")
    private let blue = PaintDualColor(light: "#1d4ed8", dark: "#93c5fd")
    private let red = PaintDualColor(light: "#b91c1c", dark: "#fca5a5")

    // MARK: - Stroke layers (#718)

    private func editor(_ scheme: String = "light") throws -> PaintEditorController {
        try PaintEditorController(width: 200, height: 140, paperPreset: "smooth", colorScheme: scheme)
    }

    private func line(_ y: Double, _ n: Int = 24) -> [PenPoint] {
        (0..<n).map { (i: Int) -> PenPoint in
            let t = Double(i)
            return PenPoint(x: 20 + t * 7, y: y + sin(t / 3) * 8, pressure: 0.8)
        }
    }

    private func stroke(_ c: PaintEditorController, _ y: Double, color: String? = nil, dual: PaintDualColor? = nil, seed: Int, brushId: String = "ink-pen") throws {
        var i = PaintStrokeInit(color: color, seed: seed)
        i.dualColor = dual
        i.brushId = brushId
        _ = try c.paintStroke(i, points: line(y))
    }

    private func liveStrokes(_ c: PaintEditorController) -> [RecordedStroke] {
        (c.doc.liveStrokes ?? OrderedMap()).values.flatMap { $0 }
    }

    /// The strokes as the scheme shows them: dual-colour ones in its side.
    private func shown(_ strokes: [RecordedStroke], _ scheme: String) -> [RecordedStroke] {
        strokes.map { s in
            guard let d = s.dualColor else { return s }
            var o = s
            o.color = d.side(scheme)
            return o
        }
    }

    /// The strokes painted fresh in their colours on a new stroke layer of a new editor.
    private func freshPaint(_ strokes: [RecordedStroke]) throws -> [UInt8] {
        let d = try editor()
        _ = try d.addLayer(type: "strokes")
        for s in strokes {
            var i = PaintStrokeInit(color: s.color, seed: s.seed)
            i.fixedBrush = s.brush
            _ = try d.paintStroke(i, points: s.points)
        }
        return d.compositePixels().data
    }

    /// The saved document with layer ids numbered (they differ between editors).
    private func saved(_ c: PaintEditorController) -> String {
        var o = c.toJSON()
        o["activeLayerId"] = .null
        var text = JSONValue.object(o).stringified()
        for (i, l) in flattenLayers(c.doc.layers).enumerated() { text = text.replacingOccurrences(of: l.id, with: "layer\(i)") }
        return text
    }

    func testRecordsThePairAndTheDocumentDrawsAStrokeLayerInTheLightSide() throws {
        let c = try editor("dark")
        _ = try c.addLayer(type: "strokes")
        try stroke(c, 50, dual: ink, seed: 1)
        let s = liveStrokes(c)[0]
        XCTAssertEqual(s.color, "#111827")
        XCTAssertEqual(s.dualColor, ink)
        // The view shows the dark side; the document's pixels are the light side.
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown([s], "dark")))
        let light = try editor()
        try light.loadJSON(.object(c.toJSON()))
        XCTAssertEqual(light.compositePixels().data, try freshPaint([s]))
    }

    func testShowsDualStrokesInTheSchemeWithoutChangingTheDocumentOrHistory() throws {
        let c = try editor()
        _ = try c.addLayer(type: "strokes")
        try stroke(c, 40, dual: ink, seed: 1)
        try stroke(c, 90, color: "#dc2626", seed: 2)
        let light = c.compositePixels().data
        let doc = c.doc
        let json = saved(c)
        let undo = c.undoStack.count
        let revision = c.documentRevision
        c.setColorScheme("dark")
        XCTAssertTrue(c.doc === doc)
        XCTAssertEqual(saved(c), json)
        XCTAssertEqual(c.undoStack.count, undo)
        XCTAssertEqual(c.documentRevision, revision)
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
        XCTAssertEqual(liveStrokes(c)[1].color, "#dc2626")
        XCTAssertEqual(c.colorSchemeView().layers.map(\.view), ["strokes"])
        c.setColorScheme("light")
        XCTAssertEqual(c.compositePixels().data, light)
    }

    func testSavesTheSameDocumentWhicheverSchemeItWasPaintedIn() throws {
        func paint(_ scheme: String) throws -> PaintEditorController {
            let c = try editor(scheme)
            _ = try c.addLayer(type: "strokes")
            try stroke(c, 40, dual: ink, seed: 1)
            var a = PaintStrokeInit(seed: 2)
            a.brushId = "ink-pen"
            a.dualColor = blue
            let s = try c.beginStroke(a)
            s.push(line(90))
            try s.end()
            var b = PaintStrokeInit(color: "#dc2626", seed: 3)
            b.brushId = "ink-pen"
            let t = try c.beginStroke(b)
            t.push(line(70))
            try t.end()
            return c
        }
        let l = try paint("light"), d = try paint("dark")
        XCTAssertEqual(saved(d), saved(l))
        XCTAssertEqual(d.compositePixels().data, try freshPaint(shown(liveStrokes(d), "dark")))
        XCTAssertEqual(l.compositePixels().data, try freshPaint(liveStrokes(l)))
    }

    func testPaintsAPointerStrokeOnTheViewOfTheScheme() throws {
        let c = try editor("dark")
        _ = try c.addLayer(type: "strokes")
        try stroke(c, 40, dual: ink, seed: 1)
        let before = c.compositePixels().data
        var i = PaintStrokeInit(color: "#dc2626", seed: 2)
        i.brushId = "ink-pen"
        let s = try c.beginStroke(i)
        s.push(Array(line(110).prefix(3)))
        // Away from the new stroke, the view is unchanged (the first stroke still in its dark side).
        let mid = c.compositePixels().data
        let p = liveStrokes(c)[0].points[5]
        let at = (Int(JS.round(p.y)) * 200 + Int(JS.round(p.x))) * 4
        XCTAssertEqual(Array(mid[at..<at + 4]), Array(before[at..<at + 4]))
        s.push(Array(line(110).dropFirst(3)))
        try s.end()
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
    }

    func testKeepsUndoAndRedoInTheSchemeAndTheyRestoreTheSameDocuments() throws {
        let c = try editor()
        _ = try c.addLayer(type: "strokes")
        try stroke(c, 40, dual: ink, seed: 1)
        let one = c.doc
        try stroke(c, 90, dual: blue, seed: 2)
        let two = c.doc
        c.setColorScheme("dark")
        _ = c.undo()
        XCTAssertTrue(c.doc === one)
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
        c.setColorScheme("light")
        _ = c.redo()
        XCTAssertTrue(c.doc === two)
        XCTAssertEqual(c.compositePixels().data, try freshPaint(liveStrokes(c)))
        c.setColorScheme("dark")
        _ = c.undo()
        _ = c.undo()
        XCTAssertTrue(liveStrokes(c).isEmpty)
        _ = c.redo()
        _ = c.redo()
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
        // Edits, reorders and removals in the dark scheme keep the view in step.
        let ab = liveStrokes(c)
        _ = try c.updateStroke(ab[0].id, brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: 9)
        _ = try c.reorderStroke(ab[1].id, 0)
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
        _ = try c.removeStrokes([ab[0].id])
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
    }

    func testShowsLoadedStrokesInTheSchemeOfTheViewerAndExportsIt() throws {
        let c = try editor()
        let layer = try c.addLayer(type: "strokes")
        try stroke(c, 40, dual: ink, seed: 1)
        let json = c.toJSON()
        XCTAssertEqual(json["strokes"]?.arrayValue?.first?.objectValue?["dualColor"], ink.json)
        let d = try editor("dark")
        XCTAssertEqual(try d.loadJSON(.object(json)), [])
        XCTAssertEqual(liveStrokes(d)[0].dualColor, ink)
        XCTAssertEqual(d.compositePixels().data, try freshPaint(shown(liveStrokes(d), "dark")))
        XCTAssertEqual(saved(d), saved(c))
        // Pixel-locked layers show the scheme too; PNG exports follow it.
        _ = try c.updateLayer(layer.id, ["locks": ["pixels": true]])
        c.setColorScheme("dark")
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
        let dark = try c.exportPng()
        c.setColorScheme("light")
        XCTAssertNotEqual(try c.exportPng(), dark)
    }

    func testRecordsThePairFromSetColorAndUpdateStrokeAndDropsItForAPlainColour() throws {
        let c = try editor("dark")
        _ = try c.addLayer(type: "strokes")
        XCTAssertEqual(try c.setColor(dual: ink), "#f9fafb")
        try stroke(c, 40, seed: 1)
        let s = liveStrokes(c)[0]
        XCTAssertEqual(s.color, "#111827")
        XCTAssertEqual(s.dualColor, ink)
        c.setColorScheme("light")
        XCTAssertEqual(c.color, "#111827")
        XCTAssertNil(try c.updateStroke(s.id, brushId: nil, brushChanges: nil, color: "#22c55e", paint: nil, seed: nil).stroke.dualColor)
        let r = try c.updateStroke(s.id, brushId: nil, brushChanges: nil, color: nil, paint: nil, seed: nil, dualColor: PaintDualColor(light: "red", dark: "blue"))
        XCTAssertEqual(r.stroke.color, "#ff0000")
        XCTAssertEqual(r.stroke.dualColor, PaintDualColor(light: "#ff0000", dark: "#0000ff"))
        XCTAssertThrowsError(try c.setColor(dual: PaintDualColor(light: "nope", dark: "#000"))) { e in
            XCTAssertTrue(errorMessage(e).contains("not a colour"), errorMessage(e))
        }
    }

    func testSetColorDualColorThroughTheTool() async throws {
        let c = try editor()
        let registry = ToolRegistry()
        _ = try registry.register(createPaintEditorToolProvider(c))
        let r = await registry.callTool("set_color", ["dualColor": ["light": "#111827", "dark": "#F9FAFB"]])
        XCTAssertNotEqual(r.isError, true)
        XCTAssertEqual(r.structuredContent?["color"], "#111827")
        XCTAssertEqual(r.structuredContent?["dualColor"], ink.json)
        _ = try c.addLayer(type: "strokes")
        try stroke(c, 40, seed: 1)
        c.setColorScheme("dark")
        XCTAssertEqual(c.compositePixels().data, try freshPaint(shown(liveStrokes(c), "dark")))
        let both = await registry.callTool("set_color", ["color": "#000000", "dualColor": ink.json])
        XCTAssertEqual(both.isError, true)
        let half = await registry.callTool("set_color", ["dualColor": ["light": "#000000"]])
        XCTAssertEqual(half.isError, true)
        let locked = await registry.callTool("set_color", ["locked": true])
        XCTAssertNil(locked.structuredContent?["dualColor"])
    }

    func testBakesTheSidePaintedOnAPixelLayer() throws {
        let c = try editor("dark")
        try stroke(c, 40, dual: ink, seed: 1)
        let before = c.compositePixels().data
        c.setColorScheme("light")
        // The document keeps the side painted (the view only changes once the scheme's replay is ready).
        XCTAssertEqual(c.compositePixels().data, before)
        XCTAssertEqual(c.doc.strokes[0].color, "#f9fafb")
        XCTAssertEqual(c.doc.strokes[0].dualColor, ink)
    }

    // MARK: - Pixel layers, replayed from the stroke log (#720)

    private enum Step {
        case stroke(y: Double, color: String?, dual: PaintDualColor?, seed: Int)
        case wait(Int)
        case live(y: Double, color: String?, dual: PaintDualColor?, seed: Int)
    }

    private func wetEditor(_ scheme: String = "light") throws -> PaintEditorController {
        try PaintEditorController(width: 160, height: 120, paperPreset: "cold-pressed", wet: PaintWetOptions(gpu: "off"), colorScheme: scheme)
    }

    private func wave(_ y: Double, _ n: Int = 16, _ x0: Double = 20, _ x1: Double = 140) -> [PenPoint] {
        (0..<n).map { (i: Int) -> PenPoint in
            let t = Double(i)
            let x: Double = x0 + ((x1 - x0) * t) / Double(n - 1)
            return PenPoint(x: x, y: y + sin(t / 3) * 8, pressure: 0.7)
        }
    }

    private func paint(_ c: PaintEditorController, _ steps: [Step]) throws {
        for s in steps {
            switch s {
            case .wait(let n):
                _ = try c.advanceWet(steps: n, seconds: nil)
            case .stroke(let y, let color, let dual, let seed):
                var i = PaintStrokeInit(color: color, seed: seed)
                i.dualColor = dual
                i.brushId = "watercolor-round"
                _ = try c.paintStroke(i, points: wave(y))
            case .live(let y, let color, let dual, let seed):
                // A pointer stroke with the simulation running between its points.
                var i = PaintStrokeInit(color: color, seed: seed)
                i.dualColor = dual
                i.brushId = "watercolor-round"
                let st = try c.beginStroke(i)
                for (k, p) in wave(y).enumerated() {
                    st.push([p])
                    // Not after the last point: a replay ends the stroke there (it records no clock for the end).
                    if k % 4 == 3 && k < 15 { _ = try c.advanceWet(steps: 2, seconds: nil) }
                }
                try st.end()
            }
        }
    }

    /// `steps` with every dual colour replaced by its `side`.
    private func sided(_ steps: [Step], _ side: String) -> [Step] {
        steps.map { s in
            switch s {
            case .stroke(let y, let color, let dual, let seed): return .stroke(y: y, color: dual?.side(side) ?? color, dual: nil, seed: seed)
            case .live(let y, let color, let dual, let seed): return .live(y: y, color: dual?.side(side) ?? color, dual: nil, seed: seed)
            case .wait: return s
            }
        }
    }

    /// The pixels of `steps` painted fresh in `side` (no dual colours at all).
    private func fresh(_ steps: [Step], _ side: String) throws -> (display: [UInt8], dried: [UInt8]) {
        let d = try wetEditor()
        try paint(d, sided(steps, side))
        return (d.compositePixels(wet: "display").data, d.compositePixels(wet: "dried").data)
    }

    func testWetPaintShowsTheDarkSideAfterSetColorSchemeAndSwitchingBackRestoresIt() async throws {
        let steps: [Step] = [.stroke(y: 40, color: nil, dual: blue, seed: 3), .wait(12)]
        let c = try wetEditor()
        try paint(c, steps)
        let light = c.compositePixels(wet: "display").data
        let json = JSONValue.object(c.toJSON())
        let undo = c.undoStack.count
        let doc = c.doc
        c.setColorScheme("dark")
        // Until the replay has caught up, the layer shows its own pixels.
        XCTAssertEqual(c.colorSchemeView().replayState, "building")
        XCTAssertEqual(c.compositePixels(wet: "display").data, light)
        let view = await c.colorSchemeViewReady()
        XCTAssertEqual(view.scheme, "dark")
        XCTAssertEqual(view.replayState, "ready")
        XCTAssertEqual(view.layers.map(\.view), ["replay"])
        XCTAssertEqual(view.layers.first?.state, "ready")
        let dark = try fresh(steps, "dark")
        XCTAssertEqual(c.compositePixels(wet: "display").data, dark.display)
        XCTAssertEqual(c.compositePixels(wet: "dried").data, dark.dried)
        // View only: the document, history and the saved file don't change.
        XCTAssertTrue(c.doc === doc)
        XCTAssertEqual(c.undoStack.count, undo)
        XCTAssertEqual(JSONValue.object(c.toJSON()), json)
        c.setColorScheme("light")
        XCTAssertEqual(c.colorSchemeView().replayState, "none")
        XCTAssertEqual(c.compositePixels(wet: "display").data, light)
    }

    func testMixesDualColoursAsTheDarkSidesWouldHaveMixed() async throws {
        let steps: [Step] = [
            .stroke(y: 50, color: nil, dual: blue, seed: 1), .wait(4),
            .stroke(y: 56, color: nil, dual: red, seed: 2), .wait(4),
            .stroke(y: 62, color: "#15803d", dual: nil, seed: 4), .wait(20),
        ]
        let c = try wetEditor()
        try paint(c, steps)
        XCTAssertEqual(try fresh(steps, "light").display, c.compositePixels(wet: "display").data)
        c.setColorScheme("dark")
        _ = await c.colorSchemeViewReady()
        let dark = try fresh(steps, "dark")
        XCTAssertEqual(c.compositePixels(wet: "display").data, dark.display)
        XCTAssertEqual(c.compositePixels(wet: "dried").data, dark.dried)
    }

    func testKeepsTheViewCurrentFromNewStrokesLiveOnesIncludedWithoutAFullReplay() async throws {
        let before: [Step] = [.stroke(y: 30, color: nil, dual: blue, seed: 1), .wait(6)]
        // Painted in the dark scheme: a dual colour's dark side goes into the document, a plain colour as it is.
        let after: [Step] = [.live(y: 60, color: nil, dual: red, seed: 2), .wait(5), .stroke(y: 90, color: "#a16207", dual: nil, seed: 5), .wait(7)]
        let c = try wetEditor()
        try paint(c, before)
        c.setColorScheme("dark")
        _ = await c.colorSchemeViewReady()
        let made = c.replayTargetsMade
        // The replay follows as it goes (a view's clock runs it between the editor's changes).
        for s in after {
            try paint(c, [s])
            await c.runSchemeReplay()
        }
        let view = await c.colorSchemeViewReady()
        XCTAssertEqual(c.replayTargetsMade, made)
        XCTAssertEqual(view.replayState, "ready")
        XCTAssertEqual(view.items, c.doc.strokes.count + (c.doc.wetEvents?.count ?? 0) + (c.doc.paintEvents?.count ?? 0))
        // The replay is stepped to the editor's clock.
        _ = try c.advanceWet(steps: 9, seconds: nil)
        _ = await c.colorSchemeViewReady()
        let dark = try fresh(before + after + [.wait(9)], "dark")
        XCTAssertEqual(c.compositePixels(wet: "display").data, dark.display)
    }

    func testFollowsALiveWetStrokePointByPoint() async throws {
        let c = try wetEditor()
        try paint(c, [.stroke(y: 30, color: nil, dual: blue, seed: 1)])
        c.setColorScheme("dark")
        _ = await c.colorSchemeViewReady()
        func px(_ img: [UInt8], _ p: PenPoint) -> [Int] {
            let at = (Int(JS.round(p.y)) * 160 + Int(JS.round(p.x))) * 4
            return img[at..<at + 3].map { Int($0) }
        }
        let old = wave(30)[5]
        let before = c.compositePixels(wet: "display").data
        var i = PaintStrokeInit(seed: 2)
        i.dualColor = red
        i.brushId = "watercolor-round"
        let s = try c.beginStroke(i)
        let pts = wave(80)
        for p in pts.prefix(8) { s.push([p]) }
        _ = try c.advanceWet(steps: 2, seconds: nil)
        _ = await c.colorSchemeViewReady()
        let mid = c.compositePixels(wet: "display").data
        // The new stroke shows while it is painted (the replay follows it)…
        XCTAssertNotEqual(px(mid, pts[2]), px(before, pts[2]))
        // …and the old one is still its dark side, not the document's light pixels.
        func dist(_ a: [Int], _ b: [Int]) -> Double { hypot(hypot(Double(a[0] - b[0]), Double(a[1] - b[1])), Double(a[2] - b[2])) }
        XCTAssertLessThan(dist(px(mid, old), [0x93, 0xc5, 0xfd]), dist(px(mid, old), [0x1d, 0x4e, 0xd8]))
        for p in pts.dropFirst(8) { s.push([p]) }
        try s.end()
        let made = c.replayTargetsMade
        _ = await c.colorSchemeViewReady()
        XCTAssertEqual(c.replayTargetsMade, made)
    }

    func testNeverShowsTheOtherSchemeAfterUndoAndRedoAcrossASwitch() async throws {
        let a: [Step] = [.stroke(y: 40, color: nil, dual: blue, seed: 1), .wait(6)]
        let b: [Step] = [.stroke(y: 70, color: nil, dual: red, seed: 2)]
        let c = try wetEditor()
        try paint(c, a + b)
        let json = JSONValue.object(c.toJSON())
        c.setColorScheme("dark")
        _ = await c.colorSchemeViewReady()
        let made = c.replayTargetsMade
        _ = c.undo()
        _ = await c.colorSchemeViewReady()
        // Back to a checkpoint of the replay, not a fresh one; the dark side of what is left.
        XCTAssertEqual(c.replayTargetsMade, made)
        XCTAssertEqual(c.compositePixels(wet: "dried").data, try fresh(a, "dark").dried)
        _ = c.redo()
        _ = await c.colorSchemeViewReady()
        XCTAssertEqual(c.replayTargetsMade, made)
        XCTAssertEqual(c.compositePixels(wet: "dried").data, try fresh(a + b, "dark").dried)
        // The document stays as it was painted.
        c.setColorScheme("light")
        XCTAssertEqual(JSONValue.object(c.toJSON()), json)
    }

    func testWorksForLoadedDocumentsAndSavesTheSameFileInEitherScheme() async throws {
        let steps: [Step] = [.live(y: 40, color: nil, dual: blue, seed: 7), .wait(5), .stroke(y: 60, color: nil, dual: red, seed: 8)]
        let c = try wetEditor()
        try paint(c, steps)
        let json = JSONValue.object(c.toJSON())
        let d = try wetEditor("dark")
        try d.loadJSON(json)
        _ = await d.colorSchemeViewReady()
        XCTAssertEqual(d.colorSchemeView().layers.map(\.view), ["replay"])
        XCTAssertEqual(d.compositePixels(wet: "dried").data, try fresh(steps, "dark").dried)
        XCTAssertEqual(JSONValue.object(d.toJSON()), json)
    }

    func testKeepsALayerWithPixelsOutsideTheStrokeLogInItsColoursAndSaysWhy() async throws {
        let c = try wetEditor()
        let under = c.doc.activeLayerId!
        var pastel = PaintStrokeInit(color: "#ca8a04", seed: 1)
        pastel.brushId = "soft-pastel"
        _ = try c.paintStroke(pastel, points: wave(80))
        let top = try c.addLayer(name: "Wash").id
        try paint(c, [.stroke(y: 40, color: nil, dual: blue, seed: 3)])
        _ = try c.mergeDown(top)
        XCTAssertEqual(c.doc.unlogged?.keys, [under])
        try paint(c, [.stroke(y: 70, color: nil, dual: red, seed: 4)])
        _ = try c.dryPaint()
        let light = c.compositePixels(wet: "display").data
        c.setColorScheme("dark")
        let view = await c.colorSchemeViewReady()
        XCTAssertEqual(view.replayState, "none")
        XCTAssertEqual(view.layers.count, 1)
        XCTAssertEqual(view.layers.first?.layerId, under)
        XCTAssertEqual(view.layers.first?.view, "kept")
        XCTAssertTrue(view.layers.first?.reason?.contains("stroke log doesn't have") == true)
        XCTAssertEqual(c.compositePixels(wet: "display").data, light)
        // Saved with the document (it holds dual-colour strokes), so a loaded copy knows too.
        let d = try wetEditor("dark")
        try d.loadJSON(.object(c.toJSON()))
        XCTAssertEqual(d.colorSchemeView().layers.first?.view, "kept")
        // Clearing the layer makes it replayable again.
        _ = try c.clearLayer(under)
        XCTAssertNil(c.doc.unlogged)
    }

    func testNeverRecoloursPlainColours() async throws {
        let c = try wetEditor()
        try paint(c, [.stroke(y: 40, color: "#1d4ed8", dual: nil, seed: 3)])
        let light = c.compositePixels(wet: "display").data
        c.setColorScheme("dark")
        let view = await c.colorSchemeViewReady()
        XCTAssertEqual(view, PaintColorSchemeView(scheme: "dark", replayState: "none", items: 0, total: 0, error: nil, layers: []))
        XCTAssertEqual(c.compositePixels(wet: "display").data, light)
    }

    func testGetColorSchemeViewReportsEachLayerAndWaitsForTheReplay() async throws {
        let c = try wetEditor()
        try paint(c, [.stroke(y: 40, color: nil, dual: blue, seed: 3)])
        c.setColorScheme("dark")
        let registry = ToolRegistry(validateArguments: true)
        _ = try registry.register(createPaintEditorToolProvider(c))
        let first = await registry.callTool("get_color_scheme_view", [:])
        XCTAssertEqual(first.structuredContent?["replay"]?.objectValue?["state"], "building")
        let r = await registry.callTool("get_color_scheme_view", ["wait": true])
        XCTAssertNotEqual(r.isError, true)
        let replay = r.structuredContent?["replay"]?.objectValue
        XCTAssertEqual(replay?["state"], "ready")
        XCTAssertEqual(replay?["error"], .null)
        XCTAssertEqual(replay?["items"], replay?["total"])
        XCTAssertEqual(r.structuredContent?["layers"]?.arrayValue?.first?.objectValue?["layerId"], .string(c.doc.activeLayerId!))
        let again = await registry.callTool("get_color_scheme_view", [:])
        XCTAssertEqual(again.structuredContent?["replay"]?.objectValue?["state"], "ready")
        let bad = await registry.callTool("get_color_scheme_view", ["wait": "yes"])
        XCTAssertEqual(bad.isError, true)
        let extra = await registry.callTool("get_color_scheme_view", ["scheme": "dark"])
        XCTAssertEqual(extra.isError, true)
    }
}
