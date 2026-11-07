import Foundation
import PixerateCore
import PixeratePaint

/**
 * A pointer event as `PaintGesture` reads it (`PaintPointerEvent` in `paint-editor/ui.ts`):
 * Pointer Events' fields, with the position in viewport points (origin top-left). The canvas view
 * fills it from AppKit mouse and tablet events or UIKit touches (Apple Pencil included).
 */
public struct PaintPointerEvent: Sendable {
    public var pointerId: Int
    /// Viewport points from the top-left of the canvas view.
    public var x: Double
    public var y: Double
    /// Pointer type, pressure, tilt, twist and time.
    public var sample: PaintPointerSample
    /// 0 primary, 1 middle (pans), 2 secondary.
    public var button: Int
    public var shiftKey: Bool
    public var altKey: Bool
    /// Command on macOS (Ctrl elsewhere): `Mod` in the shortcuts.
    public var modKey: Bool
    /// The samples this event stands for, oldest first (UIKit's coalesced touches); empty means just this one.
    public var coalesced: [PaintPointerEvent]
    /// Where the pointer is predicted to go next (UIKit's predicted touches), drawn as a thin preview.
    public var predicted: [PaintPointerEvent]

    public init(pointerId: Int = 1, x: Double, y: Double, sample: PaintPointerSample = PaintPointerSample(pointerType: "mouse"), button: Int = 0, shiftKey: Bool = false, altKey: Bool = false, modKey: Bool = false, coalesced: [PaintPointerEvent] = [], predicted: [PaintPointerEvent] = []) {
        self.pointerId = pointerId
        self.x = x
        self.y = y
        self.sample = sample
        self.button = button
        self.shiftKey = shiftKey
        self.altKey = altKey
        self.modKey = modKey
        self.coalesced = coalesced
        self.predicted = predicted
    }
}

/// The paint tools this port's canvas handles (`PaintUITables.tools` rows it shows). Stickers are not ported yet.
public let PAINT_UI_TOOLS: Set<String> = ["brush", "fill", "eyedropper", "stroke", "pan", "rotate"]

/// Options the Fill tool (`tool == "fill"`) passes to `fillRegion`.
public struct PaintFillOptions: Equatable, Sendable {
    public var reference: String = "all"
    public var tolerance: Double = 32
    public var closeGap: Double = 4
    public var expand: Double = 1
    public var antialias: Bool = true
    public var wet: Bool = false
    public init(reference: String = "all", tolerance: Double = 32, closeGap: Double = 4, expand: Double = 1, antialias: Bool = true, wet: Bool = false) {
        self.reference = reference
        self.tolerance = tolerance
        self.closeGap = closeGap
        self.expand = expand
        self.antialias = antialias
        self.wet = wet
    }
}

/**
 * Turns pointer events into strokes (with coalesced samples and a predicted tail), colour picks,
 * stroke picks and moves, pans, view rotation and zoom, with palm rejection while a pen is down
 * (`PaintGesture` in `paint-editor/ui.ts`). UI-free, so tests drive it with plain events.
 */
@MainActor
public final class PaintGesture {
    private enum Mode {
        case stroke(pointerId: Int)
        /// Filling a region: dragging horizontally adjusts the tolerance live (one undo step).
        case fill(pointerId: Int, startX: Double, p: Point2, baseTolerance: Double, lastTolerance: Double)
        /// Dragging a stroke of a stroke layer: where the pointer went down and where it is now.
        case moveStroke(pointerId: Int, id: String, from: Point2, to: Point2)
        case pan(pointerId: Int, x: Double, y: Double, panX: Double, panY: Double)
        case rotate(pointerId: Int, angle: Double, rotation: Double)

        var pointerId: Int {
            switch self {
            case .stroke(let p), .fill(let p, _, _, _, _), .moveStroke(let p, _, _, _), .pan(let p, _, _, _, _), .rotate(let p, _, _): return p
            }
        }
    }

    public var tool = "brush"
    public var fillOptions = PaintFillOptions()
    /// The last refusal (a hidden or locked layer), for the editor to show.
    public var error: String?
    /// The predicted tail of the current stroke in document pixels (draw it as a thin preview).
    public private(set) var predicted: [PenPoint] = []
    /// Called when the Select stroke tool picks a stroke (or clears the pick with nil).
    public var onSelectStroke: ((String?) -> Void)?
    private var mode: Mode?
    private var penAt: Point2?
    private var penDown = false
    private let controller: PaintEditorController
    private let box: () -> (width: Double, height: Double)

    /// `box` gives the canvas view's size in points.
    public init(controller: PaintEditorController, box: @escaping () -> (width: Double, height: Double)) {
        self.controller = controller
        self.box = box
    }

    private func doc(_ e: PaintPointerEvent) -> Point2 {
        let b = box()
        return screenToDocument(controller.view, controller.doc.canvas, viewport: b.width, b.height, e.x, e.y)
    }

    private func pen(_ e: PaintPointerEvent) -> PenPoint {
        let p = doc(e)
        return pointerToPenPoint(e.sample, p.x, p.y, view: controller.view)
    }

    /// Pointer down; returns true when the gesture took the pointer (keep sending its moves).
    @discardableResult
    public func down(_ e: PaintPointerEvent) -> Bool {
        error = nil
        if mode != nil { return false }
        if e.sample.pointerType == "pen" {
            penDown = true
            penAt = Point2(x: e.x, y: e.y)
        } else if e.sample.pointerType == "touch" && (penDown || isPalmTouch(Point2(x: e.x, y: e.y), penAt, hand: controller.hand)) {
            return false
        }
        let tool = e.button == 1 ? "pan" : self.tool
        if tool == "pan" {
            mode = .pan(pointerId: e.pointerId, x: e.x, y: e.y, panX: controller.view.panX, panY: controller.view.panY)
            return true
        }
        if tool == "rotate" {
            let b = box()
            mode = .rotate(pointerId: e.pointerId, angle: atan2(e.y - b.height / 2, e.x - b.width / 2), rotation: controller.view.rotation)
            return true
        }
        if tool == "stroke" { return strokeDown(e) }
        if tool == "eyedropper" || e.altKey {
            pick(e)
            return false
        }
        if tool == "fill" { return fillDown(e) }
        if !PAINT_UI_TOOLS.contains(tool) {
            error = "The \(tool) tool is not available in the Swift paint editor yet."
            return false
        }
        do {
            let p = pen(e)
            var i = PaintStrokeInit()
            i.start = Point2(x: p.x, y: p.y)
            let stroke = try controller.beginStroke(i)
            stroke.push([p])
            mode = .stroke(pointerId: e.pointerId)
            return true
        } catch {
            self.error = "\(error)"
            return false
        }
    }

    /**
     * The Select stroke tool, on a stroke layer: pressing a stroke picks it and dragging moves it
     * (one undo step at the drop); pressing where no stroke painted clears the pick.
     */
    private func strokeDown(_ e: PaintPointerEvent) -> Bool {
        let p = doc(e)
        guard let layerId = controller.doc.activeLayerId, controller.doc.liveStrokes?.get(layerId) != nil else {
            error = "Pick a stroke layer in the Layers panel (or add one) to select its strokes."
            return false
        }
        do {
            let hit = try controller.liveStrokeAt(layerId, p.x, p.y)
            onSelectStroke?(hit?.id)
            guard let hit else { return false }
            mode = .moveStroke(pointerId: e.pointerId, id: hit.id, from: p, to: p)
            return true
        } catch {
            self.error = "\(error)"
            return false
        }
    }

    /// While a stroke is dragged: how far it has moved (document pixels), to draw its outline there.
    public var strokeDrag: (id: String, dx: Double, dy: Double)? {
        guard case .moveStroke(_, let id, let from, let to)? = mode else { return nil }
        return (id, to.x - from.x, to.y - from.y)
    }

    private func pick(_ e: PaintPointerEvent) {
        let p = doc(e)
        let c = controller.doc.canvas
        if p.x < 0 || p.y < 0 || p.x >= Double(c.width) || p.y >= Double(c.height) { return }
        do {
            if let hex = try controller.pickColor(p.x, p.y)["color"]?.stringValue { _ = try controller.setColor(hex) }
        } catch {
            self.error = "\(error)"
        }
    }

    private func fillDown(_ e: PaintPointerEvent) -> Bool {
        let p = doc(e)
        let baseTol = fillOptions.tolerance
        do {
            _ = try controller.fillRegion(
                x: p.x,
                y: p.y,
                reference: fillOptions.reference,
                tolerance: baseTol,
                closeGap: fillOptions.closeGap,
                expand: fillOptions.expand,
                antialias: fillOptions.antialias,
                wet: fillOptions.wet
            )
            mode = .fill(pointerId: e.pointerId, startX: e.x, p: p, baseTolerance: baseTol, lastTolerance: baseTol)
            return true
        } catch {
            self.error = "\(error)"
            return false
        }
    }

    public func move(_ e: PaintPointerEvent) {
        if e.sample.pointerType == "pen" { penAt = Point2(x: e.x, y: e.y) }
        guard let m = mode, m.pointerId == e.pointerId else { return }
        switch m {
        case let .pan(_, x, y, panX, panY):
            _ = controller.setView(pan: (panX + e.x - x, panY + e.y - y))
        case let .rotate(_, angle, rotation):
            let b = box()
            let a = atan2(e.y - b.height / 2, e.x - b.width / 2)
            var r = rotation + ((a - angle) * 180) / Double.pi
            if e.shiftKey { r = (r / 15).rounded() * 15 }
            _ = controller.setView(rotation: r)
        case let .moveStroke(p, id, from, _):
            mode = .moveStroke(pointerId: p, id: id, from: from, to: doc(e))
        case let .fill(pointerId, startX, p, baseTolerance, lastTolerance):
            let dx = e.x - startX
            if abs(dx) < 4 { return }
            let nextTol = Swift.max(0, Swift.min(255, (baseTolerance + dx * 0.5).rounded()))
            if nextTol == lastTolerance { return }
            mode = .fill(pointerId: pointerId, startX: startX, p: p, baseTolerance: baseTolerance, lastTolerance: nextTol)
            do {
                _ = controller.undo()
                _ = try controller.fillRegion(
                    x: p.x,
                    y: p.y,
                    reference: fillOptions.reference,
                    tolerance: nextTol,
                    closeGap: fillOptions.closeGap,
                    expand: fillOptions.expand,
                    antialias: fillOptions.antialias,
                    wet: fillOptions.wet
                )
            } catch {
                self.error = "\(error)"
            }
        case .stroke:
            guard let stroke = controller.activeStroke else { return }
            stroke.push((e.coalesced.isEmpty ? [e] : e.coalesced).map(pen))
            predicted = e.predicted.map(pen)
            if stroke.needsPathPreview { previewPath(stroke) }
        }
    }

    /// Renders a path-mapped effect along the path drawn so far, one render at a time, until it catches up with the pen.
    private func previewPath(_ stroke: PaintLiveStroke) {
        Task { @MainActor in
            while stroke.needsPathPreview { await stroke.renderPreview() }
        }
    }

    public func up(_ e: PaintPointerEvent) {
        if e.sample.pointerType == "pen" { penDown = false }
        guard let m = mode, m.pointerId == e.pointerId else { return }
        mode = nil
        predicted = []
        switch m {
        case .stroke:
            guard let stroke = controller.activeStroke else { break }
            if stroke.needsPathRender {
                // The stroke stays open, so the editor is busy, until its path has rendered.
                Task { @MainActor in
                    do {
                        try await stroke.renderPath()
                        try stroke.end()
                    } catch {
                        stroke.cancel()
                        self.error = "\(error)"
                    }
                }
            } else {
                do { try stroke.end() } catch { self.error = "\(error)" }
            }
        case let .moveStroke(_, id, from, _):
            let p = doc(e)
            let dx = ((p.x - from.x) * 100).rounded() / 100
            let dy = ((p.y - from.y) * 100).rounded() / 100
            if dx != 0 || dy != 0 {
                let transform: JSONObject = ["dx": .number(dx), "dy": .number(dy)]
                if controller.strokeEditNeedsRender(id, points: nil, transform: transform) {
                    // A path-mapped stroke has to render its moved path first.
                    Task { @MainActor [controller] in
                        do {
                            try await controller.prepareEditStrokePointsEffect(id, points: nil, transform: transform)
                            _ = try controller.editStrokePoints(id, points: nil, transform: transform)
                        } catch { self.error = "\(error)" }
                    }
                } else {
                    do { _ = try controller.editStrokePoints(id, points: nil, transform: transform) } catch { self.error = "\(error)" }
                }
            }
        default: break
        }
    }

    /// The pointer was lost (the system took the touch): a stroke in progress is dropped.
    public func cancel() {
        penDown = false
        predicted = []
        if case .stroke? = mode { controller.activeStroke?.cancel() }
        mode = nil
    }

    public var active: Bool { mode != nil }

    /// Wheel: zoom about the pointer, Shift+wheel rotates the view (`deltaY` in pixels, as on the web).
    public func wheel(x: Double, y: Double, deltaY: Double, shiftKey: Bool = false) {
        if shiftKey {
            _ = controller.setView(rotation: controller.view.rotation + (deltaY > 0 ? 5 : -5))
            return
        }
        zoom(by: exp(-deltaY * 0.0015), aboutX: x, y: y)
    }

    /// Multiplies the zoom by `factor`, keeping the point under (x, y) still (pinch and wheel).
    public func zoom(by factor: Double, aboutX x: Double, y: Double) {
        let v = controller.view
        let b = box()
        let zoom = Swift.min(MAX_ZOOM, Swift.max(MIN_ZOOM, v.zoom * factor))
        let k = zoom / v.zoom
        let px = x - b.width / 2
        let py = y - b.height / 2
        _ = controller.setView(zoom: zoom, pan: (px - (px - v.panX) * k, py - (py - v.panY) * k))
    }

    /// Pans the view by (dx, dy) points (trackpad scrolling, two-finger drags).
    public func pan(dx: Double, dy: Double) {
        _ = controller.setView(pan: (controller.view.panX + dx, controller.view.panY + dy))
    }

    /// Turns the view by `degrees` (trackpad and two-finger rotation).
    public func rotate(by degrees: Double) {
        _ = controller.setView(rotation: controller.view.rotation + degrees)
    }
}
