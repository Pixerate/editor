import Foundation
import PixerateCore
import PixerateRaster

/**
 * `PaintEditorController` (`paint-editor/controller.ts`): the natural-media paint editor's state,
 * framework-free.
 *
 * - The document (canvas, paper, the shared raster layer stack, recorded strokes) is immutable
 *   and tiled copy-on-write; each undo step is a reference to a whole document state.
 * - `paintStroke` paints a whole stroke from data (agents, tests, replays).
 * - The brush, colour, Mixer Brush load, view and hand are editor state, not undo steps.
 * - Rendering goes through the shared compositor with the paper as its bottom layer.
 *
 * This port covers the dry engine: dab and eraser brushes, the Mixer Brush, blender, smudge, and
 * dab brushes that pick up paint or paint gradients. Wet media, thick paint, light, stickers,
 * particles, bristles, stamp tips and effects are refused with a message naming what is missing.
 */

/// A refusal with a message that says what is wrong and how to fix it.
public struct PaintEditorError: Error, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

/// The view: zoom, pan, rotation and mirroring (view state only).
public struct PaintView: Equatable {
    public var zoom: Double = 1
    public var panX: Double = 0
    public var panY: Double = 0
    public var rotation: Double = 0
    public var mirror: Bool = false

    public var json: JSONValue { ["zoom": .number(zoom), "pan": pointJSON(panX, panY), "rotation": .number(rotation), "mirror": .bool(mirror)] }
}

public let MIN_ZOOM = 0.02
public let MAX_ZOOM = 64.0

/// Degrees into -180..180.
func normalizeRotation(_ deg: Double) -> Double {
    if !deg.isFinite { return 0 }
    var r = deg.truncatingRemainder(dividingBy: 360)
    if r > 180 { r -= 360 }
    if r <= -180 { r += 360 }
    return JS.round(r * 1000) / 1000
}

func viewMatrix(_ view: PaintView, _ canvas: PaintCanvas, _ vw: Double, _ vh: Double) -> Affine {
    let a = (view.rotation * Double.pi) / 180
    let z = view.zoom
    let m = view.mirror ? -1.0 : 1.0
    let cos = JS.cos(a) * z
    let sin = JS.sin(a) * z
    let cx = Double(canvas.width) / 2, cy = Double(canvas.height) / 2
    let sx = vw / 2 + view.panX, sy = vh / 2 + view.panY
    let A = cos * m, B = -sin, C = sin * m, D = cos
    return [A, B, C, D, sx - (A * cx + B * cy), sy - (C * cx + D * cy)]
}

/// The lighting of thick paint (`thick.ts`): kept for `get_canvas_info`.
public struct PaintLighting: Equatable {
    public var azimuth = 315.0
    public var elevation = 40.0
    public var relief = 0.7
    public var json: JSONValue { ["azimuth": .number(azimuth), "elevation": .number(elevation), "relief": .number(relief)] }
}

/// A swatch: a colour and its name.
public struct Swatch: Equatable, Sendable {
    public var color: String
    public var name: String?
    /// A gradient swatch's gradient.
    public var paint: PaintGradientSource?
    public init(color: String, name: String? = nil) {
        self.color = color
        self.name = name
    }
    public var json: JSONValue {
        var o: JSONObject = ["color": .string(color)]
        if let name { o["name"] = .string(name) }
        if let paint { o["paint"] = paint.json }
        return .object(o)
    }
}

public let DEFAULT_SWATCHES: [Swatch] = [
    Swatch(color: "#f7f5ee", name: "Warm white"), Swatch(color: "#f3d23a", name: "Lemon yellow"), Swatch(color: "#c8912f", name: "Yellow ochre"),
    Swatch(color: "#d23a2a", name: "Warm red"), Swatch(color: "#9e1f3d", name: "Crimson"), Swatch(color: "#8a4a2b", name: "Burnt earth"),
    Swatch(color: "#2f3f9e", name: "Deep blue"), Swatch(color: "#1d6f8f", name: "Cool blue"), Swatch(color: "#4f6e2c", name: "Leaf green"),
    Swatch(color: "#25221f", name: "Warm black"),
]

/// A layer as panels and tools describe it.
public struct PaintLayerInfo {
    public var id: String
    public var name: String
    public var type: String
    public var visible: Bool
    public var opacity: Double
    public var blend: String
    public var clipped: Bool
    public var locks: JSONObject
    public var active: Bool
    public var bounds: RasterRect?
    public var liveStrokes: Int?
    public var effects: Int?
    public var parentId: String?
    public var depth: Int

    public var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "name": .string(name), "type": .string(type), "visible": .bool(visible), "opacity": .number(opacity), "blend": .string(blend), "clipped": .bool(clipped), "locks": .object(locks), "active": .bool(active), "bounds": rectJSON(bounds)]
        if let liveStrokes { o["liveStrokes"] = .number(Double(liveStrokes)) }
        if let effects { o["effects"] = .number(Double(effects)) }
        o["parentId"] = parentId.map { .string($0) } ?? .null
        o["depth"] = .number(Double(depth))
        return .object(o)
    }
}

/// What a stroke starts from (all optional: the editor's brush, colour and active layer by default).
public struct PaintStrokeInit {
    public var layerId: String?
    public var color: String?
    /// A paint source (colour or gradient) for this stroke.
    public var paint: JSONValue?
    public var brushId: String?
    /// Engine settings over the brush (`brushChanges` of a facet patch).
    public var brush: JSONObject?
    public var seed: Int?
    public var copies: [Affine]?
    public var load: MixerLoad?
    /// A whole engine brush laid over the brush (a replay's recorded brush): it keeps that brush's id.
    public var fixedBrush: PaintBrush?
    /// Snap the points to the perspective guide (default false).
    public var snapToPerspective: Bool?
    /// Use the editor's stencils (default true); `maskStencils` replaces its mask stencils.
    public var stencils: Bool?
    public var maskStencils: [Stencil]?
    /// Where the stroke starts (a tracing image that samples colours gives a stroke without colour its colour there).
    public var start: Point2?
    public init(layerId: String? = nil, color: String? = nil, paint: JSONValue? = nil, brushId: String? = nil, brush: JSONObject? = nil, seed: Int? = nil, copies: [Affine]? = nil, load: MixerLoad? = nil) {
        self.layerId = layerId
        self.color = color
        self.paint = paint
        self.brushId = brushId
        self.brush = brush
        self.seed = seed
        self.copies = copies
        self.load = load
    }
}

final class HistoryEntry {
    let label: String
    let before: PaintDocumentState
    var after: PaintDocumentState
    var guides: (before: PaintGuides, after: PaintGuides)?
    init(label: String, before: PaintDocumentState, after: PaintDocumentState) {
        self.label = label
        self.before = before
        self.after = after
    }
}

func parseColor(_ value: JSONValue?, _ what: String = "color") throws -> String {
    guard let s = value?.stringValue, isHexColor(s.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        throw PaintEditorError("\(what) is \(value.map { $0.stringified() } ?? "undefined"); use #rrggbb, e.g. \"#2a4b8d\".")
    }
    return s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

func rgbaOf(_ hex: String) -> [Int] { hexToRgb8(hex) + [255] }

func rgbToHex(_ r: Double, _ g: Double, _ b: Double) -> String {
    "#" + [r, g, b].map { String(Int(JS.round(Swift.min(255, Swift.max(0, $0)))), radix: 16).leftPad(2) }.joined()
}

/// `{ x, y }` moved.
private func movePoint(_ p: LayerOffset, _ dx: Int, _ dy: Int) -> LayerOffset { LayerOffset(x: p.x + dx, y: p.y + dy) }

public final class PaintEditorController {
    public internal(set) var doc: PaintDocumentState
    var undoStack: [HistoryEntry] = []
    var redoStack: [HistoryEntry] = []
    let historyLimit: Int
    public let brushLibrary: BrushLibrary
    public internal(set) var brush: PaintBrush
    /// The active brush as facets (what `get_brush` and the brush editor show).
    var brushSpec: Brush
    var brushEntries: [LibraryBrush]
    public internal(set) var color: String
    public internal(set) var secondaryColor = "#ffffff"
    /// Gradient paint the editor paints with instead of the one colour, or nil.
    var gradient: PaintGradientSource?
    public internal(set) var mixerLoad = EMPTY_MIXER_LOAD
    public internal(set) var view = PaintView()
    public internal(set) var hand: String
    public internal(set) var colorLocked = false
    var colorScheme = "light"
    var brushColour: JSONValue?
    /// Painting guides (symmetry, perspective, tracing, references, stencils).
    public internal(set) var guides: PaintGuides
    var nextStencilId = 1
    var nextReferenceId = 1
    var stencilCache: (key: [Stencil], size: String, mask: PaintSelection?)?
    /// The undo step `group` is building, if any.
    var grouping: (label: String, before: PaintDocumentState, changed: Bool)?
    /// Where each stroke object painted (by `RecordedStroke.key`), as learnt when it was painted or drawn.
    var paintedBounds: [Int: RasterRect?] = [:]
    /// Each layer's light spill (missing: the default).
    var lightSpills: [String: LightSpill] = [:]
    var previewing = false
    /// The mixing pad and the pads kept by name.
    let pad = MixingPad()
    var savedPads: [SavedMixingPad] = []
    var nextPadId = 1
    public internal(set) var swatches: [Swatch] = DEFAULT_SWATCHES
    var seedCounter = 1
    var strokeCounter = 1
    public internal(set) var lighting = PaintLighting()
    private var library: LibraryCancellable?

    private final class LibraryCancellable {
        let c: Cancellable
        init(_ c: Cancellable) { self.c = c }
        deinit { c.cancel() }
    }

    public init(width: Double? = nil, height: Double? = nil, dpi: Double? = nil, paper: JSONObject? = nil, paperPreset presetId: String? = nil, brushId: String? = nil, color: String? = nil, hand: String? = nil, historyLimit: Int? = nil, brushLibrary: BrushLibrary? = nil) throws {
        self.historyLimit = Swift.max(1, historyLimit ?? 200)
        var paperRaw = paper ?? [:]
        if let presetId {
            guard let p = paperPreset(presetId) else { throw PaintEditorError("Unknown paper \"\(presetId)\". Call list_papers for the ids.") }
            paperRaw = p.json
        }
        doc = try createPaintDocument(width: width, height: height, dpi: dpi, paper: paperRaw)
        self.brushLibrary = brushLibrary ?? BrushLibrary()
        brushEntries = builtinLibraryBrushes
        let wanted = brushId ?? "pencil-6b"
        let start = brushEntries.first { $0.brush.id == wanted } ?? brushEntries.first { $0.brush.id == "pencil-6b" }!
        brush = renormalized(start.brush)
        brushSpec = start.spec
        self.color = try color.map { try parseColor(.string($0)) } ?? "#1f2937"
        self.hand = hand == "left" ? "left" : "right"
        guides = defaultGuides(doc.canvas)
        refreshBrushes()
        library = LibraryCancellable(self.brushLibrary.subscribe { [weak self] in self?.refreshBrushes() })
    }

    // MARK: - History

    public var undoLabel: String? { undoStack.last?.label }
    public var redoLabel: String? { redoStack.last?.label }

    func commit(_ label: String, _ next: PaintDocumentState, before: PaintDocumentState? = nil) {
        if grouping != nil {
            // Inside `group`: the change joins the group's one step.
            grouping!.changed = true
            doc = next
            return
        }
        let entry = HistoryEntry(label: label, before: before ?? doc, after: next)
        undoStack.append(entry)
        if undoStack.count > historyLimit { undoStack.removeFirst() }
        redoStack = []
        doc = next
    }

    public func undo() -> String? {
        guard let e = undoStack.popLast() else { return nil }
        redoStack.append(e)
        doc = e.before
        if let g = e.guides { guides = g.before }
        return e.label
    }

    public func redo() -> String? {
        guard let e = redoStack.popLast() else { return nil }
        undoStack.append(e)
        doc = e.after
        if let g = e.guides { guides = g.after }
        return e.label
    }

    /// The document with a paint event appended (for replays).
    func withPaintEvent(_ d: PaintDocumentState, kind: String, layerId: String, data: JSONObject? = nil) -> PaintDocumentState {
        d.with { $0.paintEvents = (d.paintEvents ?? []) + [PaintEvent(at: d.strokes.count, kind: kind, layerId: layerId, data: data)] }
    }

    // MARK: - Canvas and paper

    func resolvePaper(_ preset: String?) throws -> JSONObject? {
        guard let preset else { return nil }
        guard let p = paperPreset(preset) else { throw PaintEditorError("Unknown paper \"\(preset)\". Call list_papers for the ids.") }
        return p.json
    }

    /// Starts a new canvas: one empty layer over the paper (one undo step).
    public func newCanvas(width: Int?, height: Int?, dpi: Double?, paper: String?) throws -> PaintDocumentState {
        var currentPaper = doc.paper
        currentPaper.offset = nil
        let next = try createPaintDocument(width: Double(width ?? doc.canvas.width), height: Double(height ?? doc.canvas.height), dpi: dpi ?? doc.canvas.dpi, paper: try resolvePaper(paper) ?? currentPaper.json)
        guides.symmetry.center = Point2(x: Double(next.canvas.width) / 2, y: Double(next.canvas.height) / 2)
        guides.tracing = nil
        commit("New canvas", next)
        return next
    }

    /// Changes the canvas size (keeping the pixels where they are, anchored top-left) or resolution.
    public func setCanvas(width: Int?, height: Int?, dpi: Double?) throws -> PaintCanvas {
        let canvas: PaintCanvas
        do { canvas = try normalizeCanvas(width: Double(width ?? doc.canvas.width), height: Double(height ?? doc.canvas.height), dpi: dpi ?? doc.canvas.dpi) } catch let e as PaintDocumentError { throw PaintEditorError(e.message) }
        commit("Canvas size", doc.with { $0.canvas = canvas })
        return canvas
    }

    /**
     * Grows the canvas by `left`, `top`, `right` and `bottom` pixels without moving anything
     * relative to anything else (see the TS method). One undo step.
     */
    public func extendCanvas(left: Int?, top: Int?, right: Int?, bottom: Int?) throws -> JSONObject {
        func side(_ v: Int?, _ k: String) throws -> Int {
            let v = v ?? 0
            if v < 0 { throw PaintEditorError("\(k) is \(v); use a whole number of pixels to add, 0 or more.") }
            return v
        }
        let l = try side(left, "left"), t = try side(top, "top"), r = try side(right, "right"), b = try side(bottom, "bottom")
        if l == 0 && t == 0 && r == 0 && b == 0 { throw PaintEditorError("Nothing to extend: give left, top, right or bottom (pixels to add on that side) above 0.") }
        let was = doc.canvas
        let width = was.width + l + r
        let height = was.height + t + b
        if width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE {
            throw PaintEditorError("The canvas would be \(width)×\(height); the limit is \(MAX_CANVAS_SIDE) px per side. Extend by less (it is \(was.width)×\(was.height) now).")
        }
        let next = shiftDocument(doc, l, t).with { $0.canvas = PaintCanvas(width: width, height: height, dpi: was.dpi) }
        // The new centre is (right − left, bottom − top) / 2 from the old one: pan by that on screen.
        let m = viewMatrix(view, was, 0, 0)
        let dx = Double(r - l) / 2, dy = Double(b - t) / 2
        view.panX = view.panX + m[0] * dx + m[1] * dy
        view.panY = view.panY + m[2] * dx + m[3] * dy
        let guidesBefore = guides
        if l != 0 || t != 0 { guides = shiftGuides(guides, l, t) }
        commit("Extend canvas", next)
        if guides != guidesBefore { undoStack.last!.guides = (guidesBefore, guides) }
        let origin = next.origin ?? LayerOffset(x: 0, y: 0)
        return ["canvas": next.canvas.json, "rect": RasterRect(x: -l, y: -t, width: width, height: height).json, "origin": pointJSON(Double(origin.x), Double(origin.y))]
    }

    func shiftDocument(_ d: PaintDocumentState, _ dx: Int, _ dy: Int) -> PaintDocumentState {
        if dx == 0 && dy == 0 { return d }
        var layers = d.layers
        for l in flattenLayers(d.layers) where l.isPixel {
            layers = mapLayer(layers, l.id) { $0.withSurface($0.pixelSurface, offset: movePoint($0.pixelOffset, dx, dy)) }
        }
        let m: Affine = [1, 0, 0, 1, Double(dx), Double(dy)]
        return d.with { o in
            o.layers = layers
            o.paper.offset = movePoint(d.paper.offset ?? LayerOffset(x: 0, y: 0), dx, dy)
            o.origin = movePoint(d.origin ?? LayerOffset(x: 0, y: 0), -dx, -dy)
            o.strokes = d.strokes.map { s in
                var moved = varyStroke(s, m)
                if let st = s.stencils { moved.stencils = st.map { translateStencil($0, Double(dx), Double(dy)) } }
                return moved
            }
            if let live = d.liveStrokes {
                var out = OrderedMap<String, [RecordedStroke]>()
                for (id, list) in live { out.set(id, list.map { varyStroke($0, m) }) }
                o.liveStrokes = out
            }
        }
    }

    /// The guides moved by (dx, dy) document pixels with the paint (reference panels are on screen and stay).
    func shiftGuides(_ g: PaintGuides, _ dx: Int, _ dy: Int) -> PaintGuides {
        var out = g
        let fx = Double(dx), fy = Double(dy)
        out.symmetry.center = Point2(x: g.symmetry.center.x + fx, y: g.symmetry.center.y + fy)
        out.perspective.points = g.perspective.points.map { Point2(x: $0.x + fx, y: $0.y + fy) }
        if var t = g.tracing {
            t.rect.x += fx
            t.rect.y += fy
            out.tracing = t
        }
        out.stencils = g.stencils.map { translateStencil($0, fx, fy) }
        return out
    }

    /// Changes the paper: a library preset, and / or any of its settings (one undo step).
    public func setPaper(_ update: JSONObject) throws -> PaperSettings {
        var base = doc.paper
        if let preset = update["preset"]?.stringValue, preset != doc.paper.preset {
            guard let p = paperPreset(preset) else { throw PaintEditorError("Unknown paper \"\(preset)\". Call list_papers for the ids.") }
            base = p
        }
        var rest = update.without("preset")
        if let c = rest["color"] { _ = try parseColor(c, "paper color") }
        rest["preset"] = .string(base.preset)
        if rest["offset"] == nil, let o = doc.paper.offset { rest["offset"] = pointJSON(Double(o.x), Double(o.y)) }
        var paper = normalizePaper(rest, base)
        let changed = update.without("preset").keys.filter { $0 != "name" }
        if !changed.isEmpty && update["preset"] == nil { paper.preset = base.preset }
        commit("Paper", doc.with { $0.paper = paper })
        return paper
    }

    // MARK: - Layers

    public func getLayer(_ id: String) -> PaintLayer? { findLayer(doc.layers, id)?.layer }

    /// Every layer, top first, as panels and tools describe them.
    public func listLayers() -> [PaintLayerInfo] {
        var out: [PaintLayerInfo] = []
        func walk(_ list: [PaintLayer], _ parentId: String?, _ depth: Int) {
            for l in list.reversed() {
                out.append(describeLayer(l, parentId: parentId, depth: depth))
                if let c = l.children { walk(c, l.id, depth + 1) }
            }
        }
        walk(doc.layers, nil, 0)
        return out
    }

    public func describeLayer(_ l: PaintLayer, parentId: String?? = nil, depth: Int? = nil) -> PaintLayerInfo {
        let loc = findLayer(doc.layers, l.id)
        let parent: String? = parentId ?? loc?.parent?.id
        let d = depth ?? loc?.path.count ?? 0
        var bounds: RasterRect? = nil
        if l.isPixel {
            if let b = contentBounds(l.pixelSurface) { bounds = RasterRect(x: b.x + l.pixelOffset.x, y: b.y + l.pixelOffset.y, width: b.width, height: b.height) }
        } else {
            for c in flattenLayers(l.children ?? []) where c.isPixel { bounds = unionRectOpt(bounds, describeLayer(c, parentId: .some(l.id), depth: d + 1).bounds) }
        }
        let live = doc.liveStrokes?.get(l.id)
        let effects = l.effects.map(\.items.count) ?? 0
        return PaintLayerInfo(id: l.id, name: l.name, type: l.type, visible: l.visible, opacity: l.opacity, blend: l.blend.rawValue, clipped: l.clipped, locks: locksJSON(l.locks), active: l.id == doc.activeLayerId, bounds: bounds, liveStrokes: live.map(\.count), effects: effects > 0 ? effects : nil, parentId: parent, depth: d)
    }

    func requireLayer(_ id: String) throws -> PaintLayer {
        guard let l = getLayer(id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        return l
    }

    /// The pixel layer a paint operation targets, checked for locks and visibility.
    func paintTarget(_ layerId: String?, _ what: String) throws -> PaintLayer {
        guard let id = layerId ?? doc.activeLayerId else { throw PaintEditorError("There is no active layer to \(what); add one with add_layer.") }
        let l = try requireLayer(id)
        if !l.isPixel { throw PaintEditorError("Layer \"\(l.name)\" is a group; \(what) a pixel layer inside it.") }
        if isLayerLocked(l.locks, .pixels) { throw PaintEditorError("Layer \"\(l.name)\" has its pixels locked; unlock it (update_layer locks) before you \(what) it.") }
        if !l.visible { throw PaintEditorError("Layer \"\(l.name)\" is hidden; show it (update_layer visible true) before you \(what) it.") }
        return l
    }

    public func setActiveLayer(_ id: String) throws {
        _ = try requireLayer(id)
        if doc.activeLayerId == id { return }
        // Selection of the active layer is editor state, not an undo step: keep the history's documents.
        doc = doc.with { $0.activeLayerId = id }
    }

    /// Adds a layer above the active one: `pixel` (default), `group`, or `strokes` (a live stroke layer).
    public func addLayer(name: String? = nil, type typeIn: String? = nil, aboveId: String? = nil, parentId: String?? = nil) throws -> PaintLayerInfo {
        let count = flattenLayers(doc.layers).count
        let type = typeIn ?? "pixel"
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let layerName = !trimmed.isEmpty ? trimmed : (type == "group" ? "Group \(count + 1)" : type == "strokes" ? "Strokes \(count + 1)" : "Layer \(count + 1)")
        let layer: PaintLayer = type == "group" ? RasterLayer(id: newPaintLayerId(), name: layerName, blend: .passThrough, content: .group(children: [], collapsed: nil)) : createPaintLayer(layerName)
        var parent: String? = nil
        var index: Int? = nil
        let above = aboveId ?? (parentId == nil ? doc.activeLayerId : nil)
        if let p = parentId ?? nil {
            let g = try requireLayer(p)
            if g.type != "group" { throw PaintEditorError("Layer \"\(g.name)\" is not a group; pass a group id as parentId.") }
            parent = g.id
        } else if let above {
            guard let loc = findLayer(doc.layers, above) else { throw PaintEditorError("Unknown layer \"\(above)\". Call list_layers for the ids.") }
            parent = loc.parent?.id
            index = loc.index + 1
        }
        let layers = insertLayer(doc.layers, layer, parent, index)
        commit(type == "group" ? "Add group" : type == "strokes" ? "Add stroke layer" : "Add layer", doc.with { d in
            d.layers = layers
            d.activeLayerId = layer.id
            if type == "strokes" {
                var live = d.liveStrokes ?? OrderedMap()
                live.set(layer.id, [])
                d.liveStrokes = live
            }
        })
        return describeLayer(layer)
    }

    public func updateLayer(_ id: String, _ update: JSONObject) throws -> PaintLayerInfo {
        let l = try requireLayer(id)
        if isLayerLocked(l.locks, .all) && update.keys.contains(where: { $0 != "locks" }) { throw PaintEditorError("Layer \"\(l.name)\" is fully locked; unlock it first (locks {all: false}).") }
        if let o = update["opacity"]?.numberValue, !(o >= 0 && o <= 1) { throw PaintEditorError("opacity \(jsText(o)) is out of range; use 0..1.") }
        var blend: GroupBlendMode? = nil
        if let b = update["blend"]?.stringValue {
            if isBlendMode(b) { blend = GroupBlendMode(rawValue: b) } else if l.type == "group" && b == "pass-through" { blend = .passThrough } else {
                throw PaintEditorError("Unknown blend mode \"\(b)\". Call get_canvas_info for the blend modes.")
            }
        }
        if let n = update["name"]?.stringValue, n.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw PaintEditorError("name is empty; give the layer a name.") }
        var locks: LayerLocks?? = nil
        if let u = update["locks"]?.objectValue {
            var merged = l.locks ?? LayerLocks()
            if let v = u["pixels"]?.boolValue { merged.pixels = v }
            if let v = u["transparency"]?.boolValue { merged.transparency = v }
            if let v = u["position"]?.boolValue { merged.position = v }
            if let v = u["all"]?.boolValue { merged.all = v }
            let any = merged.pixels == true || merged.transparency == true || merged.position == true || merged.all == true
            locks = .some(any ? merged : nil)
        }
        let next = l.copy(name: update["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), visible: update["visible"]?.boolValue, opacity: update["opacity"]?.numberValue, blend: blend, clipped: update["clipped"]?.boolValue, locks: locks)
        commit("Layer properties", doc.with { $0.layers = mapLayer(doc.layers, id) { _ in next } })
        return describeLayer(next)
    }

    public func removeLayer(_ id: String) throws -> JSONObject {
        let l = try requireLayer(id)
        if isLayerLocked(l.locks, .all) { throw PaintEditorError("Layer \"\(l.name)\" is fully locked; unlock it before removing it.") }
        let layers = mapLayer(doc.layers, id) { _ in nil }
        var active = doc.activeLayerId
        if let a = active, findLayer(layers, a) == nil { active = flattenLayers(layers).filter(\.isPixel).last?.id }
        let removed = Set(flattenLayers([l]).map(\.id))
        commit("Remove layer", doc.with { d in
            d.layers = layers
            d.activeLayerId = active
            d.removingLight(Array(removed))
            if var live = d.liveStrokes {
                for k in removed { _ = live.delete(k) }
                d.liveStrokes = live
            }
        })
        return ["removed": .string(id), "activeLayerId": active.map { .string($0) } ?? .null]
    }

    public func duplicateLayer(_ id: String) throws -> PaintLayerInfo {
        guard let loc = findLayer(doc.layers, id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        var live = doc.liveStrokes
        var lightCopies: [(String, TiledSurface)] = []
        func copy(_ l: PaintLayer) -> PaintLayer {
            let nid = newPaintLayerId()
            if let lit = doc.light?.get(l.id) { lightCopies.append((nid, lit)) }
            if let spill = lightSpills[l.id] { lightSpills[nid] = spill }
            if let list = live?.get(l.id) {
                live!.set(nid, list.map { s in
                    var s = s
                    s.id = "s\(strokeCounter)"
                    strokeCounter += 1
                    s.layerId = nid
                    return s
                })
            }
            if case .group(let children, let collapsed) = l.content { return l.copy(id: nid, content: .group(children: children.map(copy), collapsed: collapsed)) }
            return l.copy(id: nid)
        }
        let dup = copy(loc.layer).copy(name: "\(loc.layer.name) copy")
        let layers = insertLayer(doc.layers, dup, loc.parent?.id, loc.index + 1)
        commit("Duplicate layer", doc.with { d in
            d.layers = layers
            d.activeLayerId = dup.id
            if lightCopies.count > 0 { var l = d.light ?? OrderedMap(); for (k, v) in lightCopies { l.set(k, v) }; d.light = l }
            if live != nil { d.liveStrokes = live }
        })
        return describeLayer(dup)
    }

    /// Moves a layer to `index` (0 = bottom) within `parentId` (default its own parent; `null` = top level).
    public func moveLayer(_ id: String, _ index: Int, parentId: String?? = nil) throws -> PaintLayerInfo {
        guard let loc = findLayer(doc.layers, id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        let target: String? = parentId == nil ? loc.parent?.id : parentId!
        if let target {
            let g = try requireLayer(target)
            if g.type != "group" { throw PaintEditorError("Layer \"\(g.name)\" is not a group; pass a group id as parentId.") }
            if target == id || (loc.layer.type == "group" && findLayer(loc.layer.children ?? [], target) != nil) { throw PaintEditorError("A group cannot move into itself.") }
        }
        let without = mapLayer(doc.layers, id) { _ in nil }
        let siblings = target.map { findLayer(without, $0)!.layer.children ?? [] } ?? without
        if index < 0 || index > siblings.count { throw PaintEditorError("index \(index) is out of range; use 0..\(siblings.count) (0 is the bottom).") }
        let layers = insertLayer(without, loc.layer, target, index)
        commit("Move layer", doc.with { $0.layers = layers })
        return describeLayer(loc.layer)
    }

    /// Merges a pixel layer into the pixel layer below it (keeping the lower one's settings).
    public func mergeDown(_ id: String) throws -> PaintLayerInfo {
        guard let loc = findLayer(doc.layers, id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        let siblings = loc.parent?.children ?? doc.layers
        let below = loc.index > 0 ? siblings[loc.index - 1] : nil
        let upper = loc.layer
        guard upper.isPixel, let below, below.isPixel else { throw PaintEditorError("Merge down needs a pixel layer directly above another pixel layer in the same group.") }
        if isLayerLocked(below.locks, .pixels) { throw PaintEditorError("Layer \"\(below.name)\" has its pixels locked; unlock it to merge into it.") }
        var surface = emptySurface(4)
        if let rect = unionRectOpt(describeLayer(below).bounds, describeLayer(upper).bounds) {
            let base = RasterLayer(id: below.id, name: below.name, visible: true, opacity: 1, blend: .mode(.normal), clipped: false, mask: nil, locks: below.locks, effects: below.effects, edge: below.edge, content: below.content)
            let top = upper.visible ? upper : upper.copy(opacity: 0)
            let px = createPaintCompositor().composite([ViewLayer(base), ViewLayer(top)], rect, sources())
            surface = surfaceFromPixels(width: rect.width, height: rect.height, data: px, channels: 4, x: rect.x, y: rect.y)
        }
        let merged = below.withSurface(surface, offset: LayerOffset(x: 0, y: 0))
        let layers = mapLayer(mapLayer(doc.layers, upper.id) { _ in nil }, below.id) { _ in merged }
        let toDoc = { (t: TiledSurface?, l: PaintLayer) in t.map { translateSurface($0, Double(l.pixelOffset.x), Double(l.pixelOffset.y)) } }
        let lowerLight = doc.light?.get(below.id), upperLight = doc.light?.get(upper.id)
        let mergedLight = lowerLight != nil || upperLight != nil ? mergeLight(toDoc(lowerLight, below), upper.visible ? toDoc(upperLight, upper) : nil, translateSurface(upper.pixelSurface, Double(upper.pixelOffset.x), Double(upper.pixelOffset.y))) : nil
        commit("Merge down", doc.with { d in
            d.layers = layers
            d.activeLayerId = below.id
            d.removingLight([upper.id, below.id])
            if let mergedLight { var l = d.light ?? OrderedMap(); l.set(below.id, mergedLight); d.light = l }
            if var live = d.liveStrokes {
                _ = live.delete(upper.id)
                _ = live.delete(below.id)
                d.liveStrokes = live
            }
        })
        return describeLayer(merged)
    }

    /// Removes every pixel of a layer.
    public func clearLayer(_ layerId: String?) throws -> JSONObject {
        let l = try paintTarget(layerId, "clear")
        let bounds = describeLayer(l).bounds
        commit("Clear layer", withPaintEvent(doc.with { d in
            d.layers = mapLayer(doc.layers, l.id) { $0.withSurface(emptySurface(4)) }
            d.removingLight([l.id])
            if var live = d.liveStrokes, live.get(l.id) != nil {
                live.set(l.id, [])
                d.liveStrokes = live
            }
        }, kind: "clear", layerId: l.id))
        return ["layerId": .string(l.id), "bounds": rectJSON(bounds)]
    }

    /**
     * Fills a layer across the canvas with a colour. With `grain` above 0 the fill follows the paper
     * grain (it catches the peaks, as pastel or charcoal rubbed across the sheet).
     */
    public func fillLayer(layerId: String? = nil, color colorIn: String? = nil, opacity opacityIn: Double? = nil, grain grainIn: Double? = nil, pressure pressureIn: Double? = nil, blend blendIn: String? = nil) throws -> JSONObject {
        let target = try paintTarget(layerId, "fill")
        if doc.liveStrokes?.get(target.id) != nil { throw PaintEditorError("Layer \"\(target.name)\" is a stroke layer (its pixels are drawn from its strokes); fill another layer (add_layer), or rasterize it first (rasterize_stroke_layer).") }
        let l = target
        let color = try colorIn.map { try parseColor(.string($0)) } ?? self.color
        let opacity = opacityIn ?? 1
        if !(opacity >= 0 && opacity <= 1) { throw PaintEditorError("opacity \(jsText(opacity)) is out of range; use 0..1.") }
        let grainAmount = grainIn ?? 0
        if !(grainAmount >= 0 && grainAmount <= 1) { throw PaintEditorError("grain \(jsText(grainAmount)) is out of range; use 0..1.") }
        let pressure = pressureIn ?? 0.5
        let blendName = blendIn ?? "normal"
        guard let blend = BlendMode(rawValue: blendName) else { throw PaintEditorError("Unknown blend mode \"\(blendName)\".") }
        let width = doc.canvas.width, height = doc.canvas.height
        let rect = RasterRect(x: 0, y: 0, width: width, height: height)
        let coverage = CoverageMap()
        let depth = grainAmount * doc.paper.depth
        let grain = depth > 0 ? paperGrain(doc.paper) : nil
        for (tx, ty) in tilesInRect(rect) {
            let r = RasterRect(x: tx * TILE, y: ty * TILE, width: Swift.min(TILE, width - tx * TILE), height: Swift.min(TILE, height - ty * TILE))
            var vals = [Float](repeating: 0, count: r.width * r.height)
            var k = 0
            for y in 0..<r.height {
                for x in 0..<r.width {
                    vals[k] = grain != nil ? Float(grainCatch(grain!.at(Double(r.x + x) + 0.5, Double(r.y + y) + 0.5), depth, pressure)) : 1
                    k += 1
                }
            }
            coverage.accumulate(r, vals, 1)
        }
        let apply = StrokeApply(mode: .paint, color: rgbaOf(color), background: rgbaOf(doc.paper.color), opacity: opacity, blend: blend, lockTransparency: isLayerLocked(l.locks, .transparency), selection: nil, offset: l.pixelOffset)
        let surface = applyCoverage(l, coverage, rect, apply)
        let data: JSONObject = ["color": .string(color), "opacity": .number(opacity), "grain": .number(grainAmount), "pressure": .number(pressure), "blend": .string(blendName)]
        // A fill covers the paint, and its light with it.
        let lit = doc.light?.get(l.id)
        commit("Fill layer", withPaintEvent(doc.with { d in
            d.layers = mapLayer(doc.layers, l.id) { $0.withSurface(surface) }
            if let lit { d.settingLight(l.id, scaleLight(lit, 1 - opacity)) }
        }, kind: "fill", layerId: l.id, data: data))
        return ["layerId": .string(l.id), "bounds": rect.json]
    }

    func applyCoverage(_ l: PaintLayer, _ coverage: CoverageMap, _ rect: RasterRect, _ apply: StrokeApply) -> TiledSurface {
        let base = l.pixelSurface
        var tiles = base.tiles
        let off = l.pixelOffset
        for (tx, ty) in tilesInRect(RasterRect(x: rect.x - off.x, y: rect.y - off.y, width: rect.width, height: rect.height)) {
            let key = tileKey(tx, ty)
            let src = base.tiles.get(key)?.data ?? [UInt8](repeating: 0, count: TILE * TILE * 4)
            if let tile = finishTile(applyStrokeToTile(coverage, src, 4, tx, ty, apply), 4, 0) { tiles.set(key, tile) } else { _ = tiles.delete(key) }
        }
        return TiledSurface(channels: 4, tiles: tiles, defaultValue: 0)
    }

    // MARK: - Brushes

    func findEntry(_ id: String) -> LibraryBrush? { brushEntries.first { $0.brush.id == id } }

    func requireEntry(_ id: String) throws -> LibraryBrush {
        guard let e = findEntry(id) else { throw PaintEditorError("Unknown brush \"\(id)\". \(closestIds(id, brushEntries.map(\.brush.id)))Call list_brush_presets for the ids.") }
        return e
    }

    /// Reads the library again (after a change anywhere it is shared).
    func refreshBrushes() {
        brushEntries = brushLibrary.list().map { libraryBrush($0.brush, $0.builtin) }
    }

    /// A library brush by id, as the engine paints it (nil when unknown).
    public func getBrush(_ id: String) -> PaintBrush? { findEntry(id).map { renormalized($0.brush) } }

    /// A library brush by id as stored (its facets), or without an id the active brush as edited.
    public func getBrushSpec(_ id: String? = nil) -> Brush? { id == nil ? brushSpec : findEntry(id!)?.spec }

    /**
     * Chooses the active brush (`id`) and / or lays a facet patch over it. Editor state, not an
     * undo step. Returns the active brush as the engine paints it, its facets, and what was clamped.
     */
    public func setBrushFacets(_ patch: JSONObject = [:], id: String? = nil, unset: [String] = []) throws -> (brush: PaintBrush, spec: Brush, problems: [String]) {
        let entry = try id.map { try requireEntry($0) }
        let unchanged = patch.isEmpty && unset.isEmpty
        var problems: [String] = []
        var base = entry?.spec ?? brushSpec
        for k in unset { base[k] = nil }
        let spec = try readBrushPatch(base, patch, &problems)
        if entry != nil || patch.path("colour.default") != nil { takeBrushColour(spec) }
        useBrush(unchanged && entry != nil ? entry!.brush : resolveBrush(spec), spec, unchanged && entry?.builtin == true)
        return (brush, brushSpec, problems)
    }

    /// The engine settings a facet patch changes on a brush (`from`: a library brush id; default the active brush).
    public func brushChanges(_ patch: JSONObject, from: String? = nil) throws -> JSONObject {
        let entry = try from.map { try requireEntry($0) }
        let base = entry?.brush ?? brush
        let spec = entry?.spec ?? brushSpec
        var problems: [String] = []
        return engineChanges(base, resolveBrush(try readBrushPatch(spec, patch, &problems)))
    }

    /// The engine settings a facet patch changes on a brush as painted (a stroke's brush).
    public func brushChanges(_ patch: JSONObject, fromBrush: PaintBrush) throws -> JSONObject {
        let base = renormalized(fromBrush)
        var problems: [String] = []
        return engineChanges(base, resolveBrush(try readBrushPatch(migrateBrushV1(base), patch, &problems)))
    }

    func readBrushPatch(_ base: Brush, _ patch: JSONObject, _ problems: inout [String]) throws -> Brush {
        var rest = patch.without("id", "name")
        if let paint = rest.path("colour.default"), paint.objectValue?["type"] == "gradient" { _ = try readStrokePaint(paint) }
        if let name = patch["name"] { rest["name"] = name }
        do { return try normalizeBrushSpec(.object(mergeBrushPatch(base, rest)), &problems) } catch { throw PaintEditorError(error.localizedDescription) }
    }

    func useBrush(_ nextIn: PaintBrush, _ spec: Brush, _ builtin: Bool) {
        var next = renormalized(nextIn)
        next.builtin = builtin ? true : nil
        brush = next
        var s = spec
        s["id"] = .string(next.id)
        s["name"] = .string(next.name)
        brushSpec = s
    }

    // MARK: - Colour

    /// After the user chooses a brush: its solid default colour becomes the paint colour, unless the colour is locked.
    func takeBrushColour(_ spec: Brush) {
        if colorLocked { return }
        guard let d = spec.path("colour.default"), let hex = brushColourHex(d, colorScheme) else { return }
        color = hex
        gradient = nil
        brushColour = d
    }

    public func setColorLocked(_ locked: Bool) { colorLocked = locked }

    /// Sets the paint colour (and goes back to one colour from gradient paint).
    public func setColor(_ c: String) throws -> String {
        color = try parseColor(.string(c))
        brushColour = nil
        gradient = nil
        return color
    }

    public func setSecondaryColor(_ c: String) throws -> String {
        secondaryColor = try parseColor(.string(c))
        return secondaryColor
    }

    /// What strokes paint with: one colour or gradient paint. Not an undo step.
    public func setPaint(_ raw: JSONValue) throws -> PaintSource {
        let p = try readStrokePaint(raw)
        switch p {
        case .color(let c): _ = try setColor(c)
        case .gradient(let g): gradient = g
        }
        return p
    }

    /// The editor's paint: the gradient, or the one colour.
    public var paint: PaintSource { gradient.map { .gradient($0) } ?? .color(color) }

    func readStrokePaint(_ raw: JSONValue) throws -> PaintSource {
        do { return try parsePaintSource(raw) } catch let e as PaintSourceError { throw PaintEditorError(e.message) }
    }

    /// The gradient a stroke paints (resolved against its colours), or nil for one colour.
    func strokeGradient(_ i: PaintStrokeInit, _ brush: PaintBrush, _ color: String) throws -> PaintGradientSource? {
        if !brushTakesPaint(brush) { return nil }
        var g: PaintGradientSource? = nil
        if let p = i.paint {
            if case .gradient(let gg) = try readStrokePaint(p) { g = gg }
        } else {
            g = brush.paint ?? (i.color == nil ? gradient : nil)
        }
        return g.map { resolvePaintGradient($0, paint: color, secondary: secondaryColor) }
    }

    /// The colour at a document pixel: of the composite or of one layer.
    public func pickColor(_ x: Double, _ y: Double, layerId: String? = nil, paper: Bool? = nil) throws -> JSONObject {
        let width = doc.canvas.width, height = doc.canvas.height
        let px = JS.floor(x), py = JS.floor(y)
        if !(px >= 0 && py >= 0 && px < Double(width) && py < Double(height)) { throw PaintEditorError("(\(jsText(x)), \(jsText(y))) is outside the \(width)×\(height) canvas.") }
        if let layerId {
            let l = try requireLayer(layerId)
            if !l.isPixel { throw PaintEditorError("Layer \"\(l.name)\" is a group; pick from a pixel layer or the composite.") }
            let p = readPixel(l.pixelSurface, Int(px) - l.pixelOffset.x, Int(py) - l.pixelOffset.y)
            return ["color": .string(rgbToHex(Double(p[0]), Double(p[1]), Double(p[2]))), "alpha": .number(round3(Double(p[3]) / 255))]
        }
        let d = createPaintCompositor().composite(renderLayers(paper: paper), RasterRect(x: Int(px), y: Int(py), width: 1, height: 1), sources())
        return ["color": .string(rgbToHex(Double(d[0]), Double(d[1]), Double(d[2]))), "alpha": .number(round3(Double(d[3]) / 255))]
    }

    /// Fills the Mixer Brush reservoir with a colour (default the editor colour).
    public func loadMixerBrush(_ c: String? = nil) throws -> MixerLoad {
        let rgb = hexToRgb8(try c.map { try parseColor(.string($0)) } ?? color)
        mixerLoad = loadMixer(mixerLoad, rgb.map { Double($0) / 255 })
        return mixerLoad
    }

    /// Empties the pickup well (and with `emptyReservoir` the loaded paint too).
    public func cleanMixerBrush(_ emptyReservoir: Bool = false) -> MixerLoad {
        mixerLoad = emptyReservoir ? EMPTY_MIXER_LOAD : cleanMixer(mixerLoad)
        return mixerLoad
    }

    // MARK: - View and hand

    public func setView(zoom: Double? = nil, rotation: Double? = nil, mirror: Bool? = nil, pan: (Double, Double)? = nil) -> PaintView {
        if let zoom, zoom.isFinite { view.zoom = Swift.min(MAX_ZOOM, Swift.max(MIN_ZOOM, zoom)) }
        if let pan { view.panX = pan.0; view.panY = pan.1 }
        if let rotation { view.rotation = normalizeRotation(rotation) }
        if let mirror { view.mirror = mirror }
        return view
    }

    public func resetView() -> PaintView {
        view = PaintView()
        return view
    }

    public func setHand(_ h: String) throws -> String {
        if h != "left" && h != "right" { throw PaintEditorError("hand is \(JSONValue.string(h).stringified()); use \"left\" or \"right\".") }
        hand = h
        return h
    }

    // MARK: - Strokes

    func strokeBrush(_ i: PaintStrokeInit) throws -> PaintBrush {
        var b = try i.brushId.map { try requireEntry($0).brush } ?? brush
        if var fixed = i.fixedBrush {
            fixed.id = b.id
            fixed.builtin = nil
            return fixed
        }
        if let changes = i.brush {
            var raw = changes
            raw["id"] = .string(b.id)
            b = normalizePaintBrush(raw, b)
        }
        return b
    }

    /// After a stroke: a Mixer Brush that loads colour keeps its whole load; any other dirty brush keeps only the paint it carries.
    func keepLoad(_ brush: PaintBrush, _ load: MixerLoad) {
        if brush.engine == "mixer" && brush.loadsColor { mixerLoad = load } else if brush.behavior.dirty { mixerLoad = MixerLoad(reservoir: mixerLoad.reservoir, amount: mixerLoad.amount, pickup: load.pickup) }
    }

    /// A brush with its own colour (`colour.own`): that colour now; else nil.
    func ownColour(_ brushId: String?) -> String? {
        let spec = brushId.map { findEntry($0)?.spec } ?? brushSpec
        guard let s = spec, s.path("colour.own") == .bool(true), let d = s.path("colour.default") else { return nil }
        return brushColourHex(d, colorScheme)
    }

    func sessionFor(_ d: PaintDocumentState, _ iIn: PaintStrokeInit) throws -> PaintStrokeSession {
        var i = iIn
        if let p = i.paint {
            switch try readStrokePaint(p) {
            case .color(let c):
                i.color = c
                i.paint = nil
            case .gradient: break
            }
        }
        guard let id = i.layerId ?? d.activeLayerId else { throw PaintEditorError("There is no active layer to paint on; add one with add_layer.") }
        guard let loc = findLayer(d.layers, id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        let layer = loc.layer
        if !layer.isPixel { throw PaintEditorError("Layer \"\(layer.name)\" is a group; paint on a pixel layer inside it.") }
        if isLayerLocked(layer.locks, .pixels) { throw PaintEditorError("Layer \"\(layer.name)\" has its pixels locked; unlock it (update_layer locks) to paint on it.") }
        if !layer.visible { throw PaintEditorError("Layer \"\(layer.name)\" is hidden; show it (update_layer visible true) to paint on it.") }
        let brush = try strokeBrush(i)
        if brush.light.amount > 0 && brush.engine == "sticker" { throw PaintEditorError("The \(brush.name) brush sprays stickers, which don't take light yet; paint light with a dab or particle light brush (glow-gel, neon-marker; list_brush_presets lists them), or set light.amount to 0 (set_brush).") }
        if d.liveStrokes?.get(layer.id) != nil, let why = liveStrokeRefusal(brush) { throw PaintEditorError("Layer \"\(layer.name)\" is a stroke layer. \(why)") }
        var color = try i.color.map { try parseColor(.string($0)) } ?? (ownColour(i.brushId) ?? self.color)
        if i.color == nil, let start = i.start, let t = guides.tracing, t.visible, t.sampleColors { color = try sampleTracingColor(start.x, start.y) ?? color }
        let perspective = guides.perspective
        let snapper = i.snapToPerspective == true && perspective.enabled && perspective.snap ? PerspectiveSnapper(perspective) : nil
        let useStencils = i.stencils != false
        let stencilSnapper = useStencils && guides.stencils.contains(where: { $0.enabled && $0.mode == "guide" }) ? StencilSnapper(guides.stencils) : nil
        let selection = i.maskStencils.map { stencilSelection($0) } ?? (useStencils ? stencilSelection() : nil)
        var inputFilter: ((PenPoint) -> PenPoint)? = nil
        if snapper != nil || stencilSnapper != nil {
            inputFilter = { p in
                let q = snapper?.snap(p) ?? p
                return stencilSnapper?.snap(q) ?? q
            }
        }
        let rgba = rgbaOf(color)
        let seed: Int
        if let s = i.seed { seed = s } else {
            seed = Int(PixerateRandom.mix32(UInt32(truncatingIfNeeded: seedCounter &* 0x9E37_79B1)) & 0x7FFF_FFFF)
            seedCounter += 1
        }
        let copies = (i.copies ?? symmetryCopies(guides.symmetry)).filter { m in m.enumerated().contains { $0.element != IDENTITY_AFFINE[$0.offset] } }
        let initValues = StrokeSessionInit(
            layerId: layer.id, surface: layer.pixelSurface, offset: layer.pixelOffset, lockTransparency: isLayerLocked(layer.locks, .transparency),
            brush: brush, color: rgba, background: rgbaOf(d.paper.color), grain: paperGrain(d.paper), paperDepth: d.paper.depth, seed: seed,
            colorHex: color, affineCopies: copies, copies: ([IDENTITY_AFFINE] + copies).map(affineCopy),
            mixerLoad: i.load ?? brushLoadForStroke(brush, mixerLoad, [Double(rgba[0]) / 255, Double(rgba[1]) / 255, Double(rgba[2]) / 255]),
            secondary: rgbaOf(secondaryColor), selection: selection, inputFilter: inputFilter, paint: try strokeGradient(i, brush, color)
        )
        var withLight = initValues
        if brush.engine != "sticker" && (brush.light.amount > 0 || d.light?.get(layer.id) != nil) { withLight.light = d.light?.get(layer.id) ?? emptyLight() }
        let session = try PaintStrokeSession(withLight)
        session.maskStencils = i.maskStencils
        return session
    }

    func record(_ s: PaintStrokeSession) -> RecordedStroke {
        let i = s.initValues
        var stroke = RecordedStroke(id: "s\(strokeCounter)", layerId: s.layerId, brush: i.brush, color: i.colorHex, points: s.points, seed: i.seed)
        strokeCounter += 1
        if !i.affineCopies.isEmpty { stroke.copies = i.affineCopies }
        if let p = i.paint { stroke.paint = p }
        if i.mixerLoad.reservoir != nil || i.mixerLoad.pickup != nil { stroke.load = i.mixerLoad }
        if i.selection != nil {
            let masks = (s.maskStencils ?? guides.stencils).filter { $0.enabled && $0.mode == "mask" }
            if !masks.isEmpty { stroke.stencils = masks }
        }
        return stroke
    }

    /// Runs a whole stroke against `d` without touching the editor; returns the new document.
    func runStroke(_ d: PaintDocumentState, _ i: PaintStrokeInit, _ points: [PenPoint]) throws -> (doc: PaintDocumentState, result: PaintStrokeResult, brush: PaintBrush) {
        let session = try sessionFor(d, i)
        session.push(points)
        var result = try session.end()
        var out = d
        if let surface = session.surfaceAfter {
            let stroke = record(session)
            result.strokeId = stroke.id
            paintedBounds[stroke.key] = .some(result.bounds)
            out = d.with { o in
                o.layers = mapLayer(d.layers, session.layerId) { $0.withSurface(surface) }
                o.strokes = d.strokes + [stroke]
                o.settingLight(session.layerId, session.lightChannel)
                if var live = o.liveStrokes, let list = live.get(stroke.layerId) {
                    live.set(stroke.layerId, list + [stroke])
                    o.liveStrokes = live
                }
            }
        }
        return (out, result, session.initValues.brush)
    }

    /// Paints one stroke from data (one undo step).
    public func paintStroke(_ i: PaintStrokeInit, points rawPoints: [PenPoint]) throws -> PaintStrokeResult {
        let points = try checkPoints(rawPoints)
        let before = doc
        var i = i
        if i.start == nil { i.start = Point2(x: points[0].x, y: points[0].y) }
        let run = try runStroke(doc, i, points)
        if let load = run.result.mixerLoad { keepLoad(run.brush, load) }
        if run.doc !== before { commit("\(run.brush.name) stroke", run.doc, before: before) }
        return run.result
    }

    /// Checks stroke samples (finite x and y, pressure 0..1).
    public func checkPoints(_ points: [PenPoint]) throws -> [PenPoint] {
        if points.isEmpty { throw PaintEditorError("points is empty; give at least one {x, y} in document pixels.") }
        for (i, p) in points.enumerated() {
            if !p.x.isFinite || !p.y.isFinite { throw PaintEditorError("points[\(i)] needs finite x and y in document pixels.") }
            if let pr = p.pressure, !(pr >= 0 && pr <= 1) { throw PaintEditorError("points[\(i)].pressure \(jsText(pr)) is out of range; use 0..1.") }
        }
        return points
    }

    public var strokes: [RecordedStroke] { doc.strokes }

    /// The mask stencils' coverage over the canvas (cached per stencil list and canvas size), or nil.
    func stencilSelection(_ stencils: [Stencil]? = nil) -> PaintSelection? {
        let list = stencils ?? guides.stencils
        let size = "\(doc.canvas.width)x\(doc.canvas.height)"
        if let c = stencilCache, c.key == list, c.size == size { return c.mask }
        let mask = stencilMask(list, doc.canvas.width, doc.canvas.height)
        stencilCache = (list, size, mask)
        return mask
    }

    // MARK: - Rendering

    func sources() -> BasicRasterSources { BasicRasterSources(width: doc.canvas.width, height: doc.canvas.height) }

    func renderLayers(paper: Bool? = nil, layerIds: [String]? = nil) -> [ViewLayer] {
        var layers = doc.layers
        if let layerIds {
            layers = layerIds.compactMap { getLayer($0) }.map { $0.copy(visible: true) }
        }
        if layerIds == nil { layers = lightLayers(layers) }
        let under: [ViewLayer] = paper == false ? [] : [ViewLayer.paper(doc.paper)]
        return under + layers.map(ViewLayer.init)
    }

    /// Light paint over the layers: glow in each layer's pixels, and its spill as a Linear Dodge (Add) layer directly above it.
    func lightLayers(_ layers: [PaintLayer]) -> [PaintLayer] {
        guard let light = doc.light, !light.isEmpty else { return layers }
        var out = layers
        for (id, lit) in light {
            guard let l = findLayer(out, id)?.layer, l.isPixel else { continue }
            let glowed = glowSurface(l.pixelSurface, lit)
            if glowed !== l.pixelSurface { out = mapLayer(out, id) { $0.withSurface(glowed) } }
            if let committed = findLayer(doc.layers, id)?.layer, committed.isPixel, let spill = computeSpill(committed.pixelSurface, lit, lightSpills[id] ?? DEFAULT_LIGHT_SPILL) {
                let node = RasterLayer(id: "\(id)::light", name: "\(l.name) light", visible: l.visible, opacity: l.opacity, blend: .mode(.linearDodge), content: .pixel(surface: spill, offset: l.pixelOffset, fillOpacity: nil))
                out = insertAfter(out, id, node)
            }
        }
        return out
    }

    private func insertAfter(_ layers: [PaintLayer], _ id: String, _ node: PaintLayer) -> [PaintLayer] {
        if let i = layers.firstIndex(where: { $0.id == id }) { var o = layers; o.insert(node, at: i + 1); return o }
        return layers.map { l in l.children.map { l.withChildren(insertAfter($0, id, node)) } ?? l }
    }

    /// The canvas as canvas-sized RGBA (paper included by default).
    public func compositePixels(paper: Bool? = nil) -> (width: Int, height: Int, data: [UInt8]) {
        let w = doc.canvas.width, h = doc.canvas.height
        let data = createPaintCompositor().composite(renderLayers(paper: paper), RasterRect(x: 0, y: 0, width: w, height: h), sources())
        return (w, h, data)
    }

    /// The canvas (or some layers), scaled so the longest side is at most `maxSide`.
    public func renderPreview(maxSide: Double, layerIds: [String]? = nil, paper: Bool? = nil) -> (width: Int, height: Int, data: [UInt8]) {
        let w = doc.canvas.width, h = doc.canvas.height
        let full = createPaintCompositor().composite(renderLayers(paper: paper, layerIds: layerIds), RasterRect(x: 0, y: 0, width: w, height: h), sources())
        let side = Swift.max(1, JS.round(maxSide))
        let k = Swift.min(1, side / Double(Swift.max(w, h)))
        if k >= 1 { return (w, h, full) }
        let tw = Swift.max(1, Int(JS.round(Double(w) * k))), th = Swift.max(1, Int(JS.round(Double(h) * k)))
        return (tw, th, downsampleRgba(full, w, h, Double(tw), Double(th)))
    }

    /// The canvas as PNG bytes (pure Swift, the same bytes as the TS encoder), scaled down by `scale`.
    public func exportPng(scale: Double? = nil, paper: Bool? = nil) throws -> [UInt8] {
        let full = compositePixels(paper: paper)
        let s = scale ?? 1
        if !(s > 0 && s <= 1) { throw PaintEditorError("scale \(jsText(s)) is out of range; use above 0 up to 1 (exports never upscale pixels).") }
        if s == 1 { return encodePng(full.width, full.height, full.data) }
        let w = Swift.max(1, Int(JS.round(Double(full.width) * s))), h = Swift.max(1, Int(JS.round(Double(full.height) * s)))
        return encodePng(w, h, downsampleRgba(full.data, full.width, full.height, Double(w), Double(h)))
    }

    // MARK: - Save

    /// The document as JSON with inline PNG data URLs (`toJSON`).
    public func toJSON(strokes withStrokes: Bool = true) -> JSONObject {
        let d = doc
        var out: JSONObject = [
            "format": .string(PAINT_FORMAT), "version": .number(Double(PAINT_SCHEMA_VERSION)),
            "width": .number(Double(d.canvas.width)), "height": .number(Double(d.canvas.height)), "dpi": .number(d.canvas.dpi),
            "paper": .object(d.paper.json),
            "activeLayerId": d.activeLayerId.map { .string($0) } ?? .null,
        ]
        if withStrokes && !d.strokes.isEmpty { out["strokes"] = .array(d.strokes.map(strokeToJSON)) }
        out["guides"] = .object(guides.json)
        out["swatches"] = .array(swatches.map(\.json))
        if let pad = mixingPadJSON() { out["mixingPad"] = pad }
        if let events = d.paintEvents, !events.isEmpty { out["paintEvents"] = .array(events.map(\.json)) }
        if let o = d.origin, o.x != 0 || o.y != 0 { out["origin"] = pointJSON(Double(o.x), Double(o.y)) }
        if let light = d.light {
            var ext = JSONObject()
            for (id, t) in light where findLayer(d.layers, id) != nil { if let saved = lightToJSON(t) { ext[id] = saved } }
            if !ext.isEmpty { out["light"] = .object(ext) }
        }
        if let live = d.liveStrokes {
            var ext = JSONObject()
            for (id, list) in live where findLayer(d.layers, id) != nil { ext[id] = .array(list.map(strokeToJSON)) }
            if !ext.isEmpty { out["liveStrokes"] = .object(ext) }
        }
        let (layers, assets) = serializeLayers(d.layers)
        out["layers"] = .array(layers)
        out["assets"] = .object(assets)
        return out
    }

    /// The saved document in the `pixerate.editor-document` envelope, with images kept as asset references.
    public func editorDocument() -> JSONValue {
        let registry = EditorAssetRegistry()
        return ["format": .string(editorDocumentFormat), "kind": "paint", "formatVersion": 1, "document": externalizeAssets(.object(toJSON()), registry)]
    }
}

/// A brush's default colour as #rrggbb for a colour scheme, or nil when it is not a solid colour.
func brushColourHex(_ value: JSONValue, _ scheme: String) -> String? {
    var v = value
    if let o = value.objectValue, o["type"] == nil, let side = o[scheme == "dark" ? "dark" : "light"] { v = side }
    guard let s = v.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return nil }
    if s.range(of: "^#[0-9a-f]{6}([0-9a-f]{2})?$", options: .regularExpression) != nil { return String(s.prefix(7)) }
    // rgb() / rgba()
    let nums = s.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).filter { !$0.isEmpty }.compactMap(Double.init)
    if s.hasPrefix("rgb"), nums.count >= 3 { return rgbToHex(nums[0], nums[1], nums[2]) }
    return nil
}
