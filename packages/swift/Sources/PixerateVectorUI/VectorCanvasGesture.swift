import Foundation
import PixerateCore
import PixerateGeometry
import PixerateVector

/// A pointer event on the canvas, in view points (`VectorPointerInput` in the TS core).
public struct VectorPointerEvent: Sendable {
    public var x: Double
    public var y: Double
    /// 0 primary, 1 middle (pans).
    public var button: Int
    public var shift: Bool
    public var alt: Bool
    /// Command (macOS) / Control.
    public var mod: Bool
    /// `mouse`, `pen` or `touch`.
    public var pointerType: String
    /// 0–1 for pens; nil when the device has none.
    public var pressure: Double?
    /// 2 for a double click or tap.
    public var clickCount: Int

    public init(x: Double, y: Double, button: Int = 0, shift: Bool = false, alt: Bool = false, mod: Bool = false, pointerType: String = "mouse", pressure: Double? = nil, clickCount: Int = 1) {
        self.x = x
        self.y = y
        self.button = button
        self.shift = shift
        self.alt = alt
        self.mod = mod
        self.pointerType = pointerType
        self.pressure = pressure
        self.clickCount = clickCount
    }
}

/// The eight resize handles of the selection box.
public enum VectorBoxHandle: String, CaseIterable, Sendable {
    case nw, n, ne, e, se, s, sw, w

    /// Where the handle sits on the box, 0–1 on each axis.
    var unit: (x: Double, y: Double) {
        switch self {
        case .nw: (0, 0)
        case .n: (0.5, 0)
        case .ne: (1, 0)
        case .e: (1, 0.5)
        case .se: (1, 1)
        case .s: (0.5, 1)
        case .sw: (0, 1)
        case .w: (0, 0.5)
        }
    }
}

/// The tools the canvas drives (the others are offered to agents through the commands).
public let VECTOR_CANVAS_TOOLS: Set<String> = [
    "select", "direct", "pen", "pencil", "rect", "ellipse", "polygon", "star", "line", "frame",
    "scissors", "knife", "eraser", "shapeBuilder", "paintBucket", "blend", "type", "distort",
]

/// What the canvas draws over the scene while a gesture runs (document space).
public struct VectorCanvasOverlay: Equatable, Sendable {
    /// The marquee being dragged.
    public var marquee: VectorBounds?
    /// A freehand stroke in progress (pencil, knife, eraser, Shape Builder, distortion brushes).
    public var stroke: [Vec2] = []
    /// The width of the eraser stroke (document units), 0 for a line.
    public var strokeWidth: Double = 0
    /// The pen path's anchors while it is being drawn.
    public var pen: [VectorAnchor] = []
    /// The Blend tool's first pick.
    public var blendStart: String?
}

/**
 * Pointer and keyboard input on the vector canvas, fed to `VectorEditorController` (the
 * `pointerDown` / `pointerMove` / `pointerUp` state machine of `vector/controller.ts`, which the
 * Swift controller does not port): Select picks, Shift-toggles, moves and resizes by the box
 * handles or drags a marquee; Direct Selection picks paths inside groups and drags their anchors;
 * the shape and Frame tools drag out a box (Shift square, Alt from the centre); the Pen places
 * points (drag pulls smooth handles; click the first point, double-click, Return or Escape
 * finishes); the Pencil fits curves to the stroke (`fitCubics`, as the TS); Scissors, Knife,
 * Eraser, Shape Builder (Alt erases), Paint Bucket, Blend, Type and the distortion brush call the
 * controller method of the same command. The middle button, Space or a two-finger scroll pans and
 * pinch / wheel zooms.
 *
 * Every drag is one undo step: it takes a history mark when it starts, and each move takes the
 * history back to it (`HistoryManager.revertTo`) and applies the whole edit again from the start,
 * so the document shows the real result while dragging.
 */
@MainActor
public final class VectorCanvasGesture {
    public let controller: VectorEditorController
    /// Called when the overlay or the hover state changes (the document notifies on its own).
    public var onChange: () -> Void = {}
    /// Called with a refusal to show the user (nil clears it).
    public var onMessage: (String?) -> Void = { _ in }
    /// The overlay to draw.
    public private(set) var overlay = VectorCanvasOverlay()
    /// The anchors picked with Direct Selection.
    public private(set) var anchors: [VectorAnchorRef] = []
    /// Space held: drags pan.
    public var spaceHeld = false
    /// Pick radius in screen points.
    public var hitRadius = 6.0
    /// Anchor and handle size in screen points.
    public var handleSize = 8.0

    private enum Drag {
        case pan(start: (Double, Double), viewport: VectorViewport)
        case move(start: Vec2, ids: [String], moved: Bool, clickId: String?, mark: HistoryMark)
        case scale(handle: VectorBoxHandle, box: VectorBounds, start: Vec2, ids: [String], mark: HistoryMark)
        case marquee(start: Vec2, base: [String], add: Bool)
        case anchor(ref: VectorAnchorRef, start: Vec2, origin: Vec2, mark: HistoryMark)
        case shape(kind: String, start: Vec2, mark: HistoryMark)
        case pencil(points: [Vec2])
        case stroke(tool: String, points: [Vec2], alt: Bool)
        case penPull(index: Int)
    }

    private var drag: Drag?
    /// The pen path being drawn: its anchors, the history mark before it and the node it is now.
    private var pen: (anchors: [VectorAnchor], mark: HistoryMark, nodeId: String?, closed: Bool)?

    public init(controller: VectorEditorController) {
        self.controller = controller
    }

    // MARK: Coordinates

    var viewport: VectorViewport { controller.viewport }

    /// A view point in document space.
    public func toDocument(_ x: Double, _ y: Double) -> Vec2 {
        let v = viewport
        return Vec2((x - v.x) / v.zoom, (y - v.y) / v.zoom)
    }

    /// A document point in view space.
    public func toScreen(_ p: Vec2) -> (x: Double, y: Double) {
        let v = viewport
        return (p.x * v.zoom + v.x, p.y * v.zoom + v.y)
    }

    var tolerance: Double { hitRadius / viewport.zoom }

    /// Whether a drag is in progress.
    public var isDragging: Bool { drag != nil }
    /// Whether the pen is drawing a path.
    public var isDrawingPath: Bool { pen != nil }

    // MARK: Selection box

    /// The bounds of the selected top-level nodes (document space), or nil.
    public func selectionBounds() -> VectorBounds? {
        let doc = controller.document
        let ids = Set(controller.selectedIds)
        if ids.isEmpty { return nil }
        var list: [VectorBounds?] = []
        func visit(_ nodes: [VectorNode], _ parent: VectorMatrix) {
            for n in nodes {
                if ids.contains(n.id) {
                    list.append(try? vectorNodeBounds(n, parent))
                } else if n.isGroup {
                    visit(n.children, multiplyMatrices(nodeMatrix(n), parent))
                }
            }
        }
        visit(doc.nodes, IDENTITY_MATRIX)
        return unionBounds(list)
    }

    /// The handle of the selection box under a view point, if any.
    public func handle(at x: Double, _ y: Double) -> VectorBoxHandle? {
        guard controller.currentTool == "select", let b = selectionBounds() else { return nil }
        let reach = handleSize / 2 + 3
        for h in VectorBoxHandle.allCases {
            let s = toScreen(Vec2(b.x + b.width * h.unit.x, b.y + b.height * h.unit.y))
            if abs(s.x - x) <= reach && abs(s.y - y) <= reach { return h }
        }
        return nil
    }

    /// The anchors Direct Selection shows: those of the selected paths.
    public func visibleAnchors() -> [(ref: VectorAnchorRef, point: Vec2)] {
        guard controller.currentTool == "direct" else { return [] }
        var out: [(ref: VectorAnchorRef, point: Vec2)] = []
        let doc = controller.document
        for id in controller.selectedIds {
            guard let node = controller.getNode(id), node.isPath else { continue }
            for (s, sp) in node.subpaths.enumerated() {
                for i in sp.anchors.indices {
                    let ref = VectorAnchorRef(nodeId: id, subpath: s, index: i)
                    if let p = getAnchorWorld(doc, ref) { out.append((ref, p)) }
                }
            }
        }
        return out
    }

    // MARK: Pointer

    public func pointerDown(_ e: VectorPointerEvent) {
        onMessage(nil)
        if e.button == 1 || spaceHeld {
            drag = .pan(start: (e.x, e.y), viewport: viewport)
            return
        }
        if e.button != 0 { return }
        let p = toDocument(e.x, e.y)
        let tool = controller.currentTool
        if tool != "pen" && pen != nil { finishPath() }
        switch tool {
        case "select": downSelect(e, p)
        case "direct": downDirect(e, p)
        case "pen": downPen(e, p)
        case "pencil": drag = .pencil(points: [p])
        case "rect", "ellipse", "polygon", "star", "line", "frame":
            drag = .shape(kind: tool, start: p, mark: controller.history.mark())
        case "knife", "eraser", "shapeBuilder", "distort":
            drag = .stroke(tool: tool, points: [p], alt: e.alt)
            overlay.strokeWidth = tool == "eraser" ? (controller.editingOptions["eraserSize"]?.numberValue ?? 10) : 0
        case "scissors": scissors(p)
        case "paintBucket": attempt { _ = try self.controller.fillRegion(p) }
        case "blend": downBlend(p)
        case "type": attempt { _ = try self.controller.addText(VectorTextInput(text: "Text", x: p.x, y: p.y)) }
        default:
            onMessage("The \(tool) tool is not on the Swift canvas yet: agents can use its commands (#533).")
        }
        sync()
    }

    public func pointerMove(_ e: VectorPointerEvent) {
        guard let drag else { return }
        let p = toDocument(e.x, e.y)
        switch drag {
        case let .pan(start, v):
            controller.setViewport(x: v.x + e.x - start.0, y: v.y + e.y - start.1)
        case let .move(start, ids, moved, clickId, mark):
            var dx = p.x - start.x
            var dy = p.y - start.y
            if e.shift {
                if abs(dx) > abs(dy) { dy = 0 } else { dx = 0 }
            }
            let far = moved || hypot(dx, dy) * viewport.zoom > 3
            if !far { return }
            self.drag = .move(start: start, ids: ids, moved: true, clickId: clickId, mark: mark)
            replay(mark) { _ = try self.controller.translate(dx, dy, ids: ids) }
        case let .scale(handle, box, _, ids, mark):
            let s = scaleFactors(handle, box, p, uniform: e.shift)
            replay(mark) { _ = try self.controller.scale(s.sx, s.sy, ids: ids, origin: s.origin) }
        case let .marquee(start, base, add):
            overlay.marquee = boundsFromPoints(start, p)
            let hit = VectorHitTest.marquee(controller.document, start, p)
            var next = add ? base : []
            for id in hit where !next.contains(id) { next.append(id) }
            if next != controller.selectedIds { controller.select(next) }
        case let .anchor(ref, start, origin, mark):
            let to = Vec2(origin.x + p.x - start.x, origin.y + p.y - start.y)
            replay(mark) { _ = try self.controller.moveAnchor(ref, to) }
        case let .shape(kind, start, mark):
            let box = shapeBox(kind, start, p, square: e.shift, centred: e.alt)
            if hypot(box.width, box.height) * viewport.zoom < 2 { return }
            replay(mark) {
                if kind == "frame" {
                    _ = try self.controller.addFrame(x: box.x, y: box.y, width: box.width, height: box.height)
                } else {
                    _ = try self.controller.addShape(VectorShapeInput(kind: kind, x: box.x, y: box.y, width: box.width, height: box.height))
                }
            }
        case var .pencil(points):
            points.append(p)
            self.drag = .pencil(points: points)
            overlay.stroke = points
        case .stroke(let tool, var points, let alt):
            points.append(p)
            self.drag = .stroke(tool: tool, points: points, alt: alt || e.alt)
            overlay.stroke = points
        case let .penPull(index):
            guard var path = pen, path.anchors.indices.contains(index) else { return }
            let a = path.anchors[index]
            let out = Vec2(p.x, p.y)
            let back = Vec2(2 * a.x - p.x, 2 * a.y - p.y)
            if hypot(p.x - a.x, p.y - a.y) * viewport.zoom < 2 { return }
            path.anchors[index] = VectorAnchor(x: a.x, y: a.y, in: back, out: out, type: .symmetric)
            pen = path
            rebuildPath()
        }
        sync()
    }

    public func pointerUp(_ e: VectorPointerEvent) {
        guard let drag else { return }
        self.drag = nil
        let p = toDocument(e.x, e.y)
        switch drag {
        case let .move(_, _, moved, clickId, _):
            // A click on a node of a selection picks it alone.
            if !moved, let clickId { controller.select([clickId]) }
        case .marquee:
            overlay.marquee = nil
        case let .shape(kind, start, mark):
            let box = shapeBox(kind, start, p, square: e.shift, centred: e.alt)
            if hypot(box.width, box.height) * viewport.zoom < 2 { _ = controller.history.revertTo(mark) }
        case let .pencil(points):
            overlay.stroke = []
            commitPencil(points)
        case let .stroke(tool, points, alt):
            overlay.stroke = []
            overlay.strokeWidth = 0
            commitStroke(tool, points, alt: alt || e.alt)
        case .pan, .scale, .anchor, .penPull:
            break
        }
        sync()
    }

    /// Abandons the drag in progress: the document goes back to how it was before it.
    public func cancel() {
        guard let drag else { return }
        self.drag = nil
        switch drag {
        case let .move(_, _, _, _, mark), let .scale(_, _, _, _, mark), let .anchor(_, _, _, mark), let .shape(_, _, mark):
            _ = controller.history.revertTo(mark)
        case let .marquee(_, base, _):
            controller.select(base)
        default:
            break
        }
        overlay.marquee = nil
        overlay.stroke = []
        sync()
    }

    // MARK: View

    /// Zooms by `factor` keeping the view point (`x`, `y`) still.
    public func zoom(by factor: Double, aboutX x: Double, y: Double) {
        let v = viewport
        let next = Swift.min(64, Swift.max(0.05, v.zoom * factor))
        let k = next / v.zoom
        controller.setViewport(x: x - (x - v.x) * k, y: y - (y - v.y) * k, zoom: next)
    }

    /// Pans the view by view points.
    public func pan(dx: Double, dy: Double) {
        let v = viewport
        controller.setViewport(x: v.x + dx, y: v.y + dy)
    }

    // MARK: Tools

    private func downSelect(_ e: VectorPointerEvent, _ p: Vec2) {
        if let h = handle(at: e.x, e.y), let box = selectionBounds() {
            drag = .scale(handle: h, box: box, start: p, ids: controller.selectedIds, mark: controller.history.mark())
            return
        }
        if let id = VectorHitTest.topLevel(controller.document, p, tolerance: tolerance) {
            let selected = controller.selectedIds.contains(id)
            if e.shift {
                controller.select([id], toggle: true)
                if selected { return }
            } else if !selected {
                controller.select([id])
            }
            drag = .move(start: p, ids: controller.selectedIds, moved: false, clickId: selected && !e.shift ? id : nil, mark: controller.history.mark())
            return
        }
        let base = e.shift ? controller.selectedIds : []
        if !e.shift { controller.clearSelection() }
        drag = .marquee(start: p, base: base, add: e.shift)
        overlay.marquee = VectorBounds(x: p.x, y: p.y, width: 0, height: 0)
    }

    private func downDirect(_ e: VectorPointerEvent, _ p: Vec2) {
        let reach = (handleSize / 2 + 3) / viewport.zoom
        if let hit = visibleAnchors().last(where: { abs($0.point.x - p.x) <= reach && abs($0.point.y - p.y) <= reach }) {
            if e.shift {
                if let i = anchors.firstIndex(of: hit.ref) { anchors.remove(at: i) } else { anchors.append(hit.ref) }
            } else if !anchors.contains(hit.ref) {
                anchors = [hit.ref]
            }
            drag = .anchor(ref: hit.ref, start: p, origin: hit.point, mark: controller.history.mark())
            return
        }
        anchors = []
        if let id = VectorHitTest.deep(controller.document, p, tolerance: tolerance) {
            controller.select([id], toggle: e.shift)
        } else if !e.shift {
            controller.clearSelection()
        }
    }

    private func downPen(_ e: VectorPointerEvent, _ p: Vec2) {
        if e.clickCount >= 2, pen != nil {
            finishPath()
            return
        }
        if var path = pen {
            if path.anchors.count >= 2 {
                let first = toScreen(Vec2(path.anchors[0].x, path.anchors[0].y))
                if abs(first.x - e.x) <= handleSize && abs(first.y - e.y) <= handleSize {
                    path.closed = true
                    pen = path
                    rebuildPath()
                    finishPath()
                    return
                }
            }
            var q = p
            if e.shift, let last = path.anchors.last {
                // Shift keeps the segment at a multiple of 45°.
                let a = (atan2(p.y - last.y, p.x - last.x) / (Double.pi / 4)).rounded() * (Double.pi / 4)
                let r = hypot(p.x - last.x, p.y - last.y)
                q = Vec2(last.x + cos(a) * r, last.y + sin(a) * r)
            }
            path.anchors.append(VectorAnchor(x: q.x, y: q.y))
            pen = path
            rebuildPath()
            drag = .penPull(index: path.anchors.count - 1)
            return
        }
        pen = (anchors: [VectorAnchor(x: p.x, y: p.y)], mark: controller.history.mark(), nodeId: nil, closed: false)
        rebuildPath()
        drag = .penPull(index: 0)
    }

    /// Puts the pen path in the document again from its anchors, as one undo step.
    private func rebuildPath() {
        guard var path = pen else { return }
        if !controller.history.isMarkValid(path.mark) {
            // The history moved on under the pen (an agent's edit, undo): start a new path from here.
            path.mark = controller.history.mark()
        }
        let d = bezierPathToSvg(.commands(subpathsToBezier([VectorSubpath(anchors: path.anchors, closed: path.closed)])), BezierPathToSvgOptions(precision: 3))
        let closed = path.closed
        let mark = path.mark
        var id: String?
        replay(mark) {
            // An open path takes no fill, as the pen's paths in the TS editor.
            let style: JSONObject = closed ? JSONObject() : JSONObject([("fill", .null)])
            id = try self.controller.addPath(d, style: style, name: "Path")
        }
        path.nodeId = id
        pen = path
        overlay.pen = path.anchors
    }

    /// Ends the pen path (a single point is taken back).
    public func finishPath() {
        guard let path = pen else { return }
        pen = nil
        overlay.pen = []
        if path.anchors.count < 2 { _ = controller.history.revertTo(path.mark) }
        sync()
    }

    private func scissors(_ p: Vec2) {
        guard let id = VectorHitTest.deep(controller.document, p, tolerance: tolerance), controller.getNode(id)?.isPath == true else {
            onMessage("Click on a path's outline to cut it.")
            return
        }
        attempt {
            if try self.controller.cutPathAt(id, p) == nil { self.onMessage("A path can't be cut at its end.") }
        }
    }

    private func downBlend(_ p: Vec2) {
        guard let id = VectorHitTest.topLevel(controller.document, p, tolerance: tolerance) else {
            overlay.blendStart = nil
            return
        }
        guard let start = overlay.blendStart, start != id, controller.getNode(start) != nil else {
            overlay.blendStart = id
            controller.select([id])
            return
        }
        overlay.blendStart = nil
        if controller.blend(ids: [start, id], keepOrder: true) == nil { onMessage("Those two can't be blended.") }
    }

    private func commitPencil(_ points: [Vec2]) {
        if points.count < 2 { return }
        let pts = points.map { PathPoint($0.x, $0.y) }
        let fitted = fitCubics(pts, 1.5 / viewport.zoom, FitCubicsOptions(cornerAngleDeg: 60))
        if fitted.isEmpty { return }
        var anchors: [VectorAnchor] = []
        for c in fitted {
            if anchors.isEmpty { anchors.append(VectorAnchor(x: c.p0[0], y: c.p0[1])) }
            anchors[anchors.count - 1].out = Vec2(c.p1[0], c.p1[1])
            anchors.append(VectorAnchor(x: c.p3[0], y: c.p3[1], in: Vec2(c.p2[0], c.p2[1])))
        }
        let d = bezierPathToSvg(.commands(subpathsToBezier([VectorSubpath(anchors: anchors, closed: false)])), BezierPathToSvgOptions(precision: 3))
        attempt {
            _ = try self.controller.addPath(d, style: JSONObject([("fill", .null), ("strokeLinecap", "round"), ("strokeLinejoin", "round")]), name: "Pencil")
        }
    }

    private func commitStroke(_ tool: String, _ points: [Vec2], alt: Bool) {
        if points.count < 2 && tool != "distort" { return }
        attempt {
            switch tool {
            case "knife":
                if try self.controller.knife(points).isEmpty { self.onMessage("The knife didn't cross a closed shape from edge to edge.") }
            case "eraser":
                _ = try self.controller.erase(points)
            case "shapeBuilder":
                let r = try self.controller.shapeBuilder(points, erase: alt)
                if !r.ok, let m = r.message { self.onMessage(m) }
            case "distort":
                let mode = self.controller.editingOptions["distortMode"]?.stringValue ?? "smudge"
                let (r, _) = try self.controller.distortBrush(mode, points)
                if !r.ok, let m = r.message { self.onMessage(m) }
            default:
                break
            }
        }
    }

    // MARK: Helpers

    /// The box a shape drag makes; a line keeps its direction.
    func shapeBox(_ kind: String, _ start: Vec2, _ p: Vec2, square: Bool, centred: Bool) -> VectorBounds {
        var dx = p.x - start.x
        var dy = p.y - start.y
        if kind == "line" {
            if square {
                let a = (atan2(dy, dx) / (Double.pi / 4)).rounded() * (Double.pi / 4)
                let r = hypot(dx, dy)
                dx = cos(a) * r
                dy = sin(a) * r
            }
            return VectorBounds(x: start.x, y: start.y, width: dx, height: dy)
        }
        if square {
            let side = Swift.max(abs(dx), abs(dy))
            dx = dx < 0 ? -side : side
            dy = dy < 0 ? -side : side
        }
        if centred {
            return VectorBounds(x: start.x - abs(dx), y: start.y - abs(dy), width: abs(dx) * 2, height: abs(dy) * 2)
        }
        return VectorBounds(x: Swift.min(start.x, start.x + dx), y: Swift.min(start.y, start.y + dy), width: abs(dx), height: abs(dy))
    }

    /// Scale factors and origin for dragging `handle` of `box` to `p` (the opposite side stays put).
    func scaleFactors(_ handle: VectorBoxHandle, _ box: VectorBounds, _ p: Vec2, uniform: Bool) -> (sx: Double, sy: Double, origin: Vec2) {
        let u = handle.unit
        let ox = box.x + box.width * (1 - u.x)
        let oy = box.y + box.height * (1 - u.y)
        let hx = box.x + box.width * u.x
        let hy = box.y + box.height * u.y
        let w = hx - ox
        let h = hy - oy
        var sx = u.x == 0.5 || w == 0 ? 1 : (p.x - ox) / w
        var sy = u.y == 0.5 || h == 0 ? 1 : (p.y - oy) / h
        if uniform {
            let k = u.x == 0.5 ? sy : u.y == 0.5 ? sx : Swift.max(abs(sx), abs(sy))
            sx = (sx < 0 ? -1 : 1) * abs(k)
            sy = (sy < 0 ? -1 : 1) * abs(k)
            if u.x == 0.5 { sx = abs(k) }
            if u.y == 0.5 { sy = abs(k) }
        }
        // A box squashed flat can't be scaled back out.
        if abs(sx) < 1e-3 { sx = sx < 0 ? -1e-3 : 1e-3 }
        if abs(sy) < 1e-3 { sy = sy < 0 ? -1e-3 : 1e-3 }
        return (sx, sy, Vec2(ox, oy))
    }

    /// Takes the history back to `mark` and applies `edit` again: the drag stays one undo step.
    private func replay(_ mark: HistoryMark, _ edit: () throws -> Void) {
        _ = controller.history.revertTo(mark)
        attempt(edit)
    }

    private func attempt(_ fn: () throws -> Void) {
        do {
            try fn()
        } catch {
            onMessage("\(error)")
        }
    }

    private func sync() {
        anchors = anchors.filter { getAnchor(controller.document, $0) != nil }
        onChange()
    }
}
