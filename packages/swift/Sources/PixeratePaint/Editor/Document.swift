import Foundation
import PixerateCore
import PixerateRaster

/**
 * The paint editor's document (`paint-editor/document.ts`): a canvas (size and resolution), a
 * paper, and the shared raster layer stack (pixel layers and groups with masks, clipping, locks
 * and blend modes). Layers are immutable and share tiles, so a history entry is a reference to a
 * whole document state.
 */

/// A layer of the paint editor: the shared stack's pixel layers and groups.
public typealias PaintLayer = RasterLayer

/// Canvas size limits (pixels per side).
public let MIN_CANVAS_SIDE = 1
public let MAX_CANVAS_SIDE = 16384
public let DEFAULT_DPI = 300.0

public struct PaintCanvas: Equatable, Sendable {
    public var width: Int
    public var height: Int
    /// Pixels per inch, for print sizes and PSD resolution (default 300).
    public var dpi: Double

    public var json: JSONValue { ["width": .number(Double(width)), "height": .number(Double(height)), "dpi": .number(dpi)] }
}

/// A change a replay repeats besides strokes, recorded with how many strokes came before it.
public struct PaintEvent: Equatable {
    public var at: Int
    public var kind: String
    public var layerId: String
    public var data: JSONObject?
    /// A `live-strokes` event's strokes as painted (in memory only; saved, they are `data.strokes`).
    var strokes: [RecordedStroke]?

    public static func == (a: PaintEvent, b: PaintEvent) -> Bool { a.at == b.at && a.kind == b.kind && a.layerId == b.layerId && a.data == b.data }

    public var json: JSONValue {
        var o: JSONObject = ["at": .number(Double(at)), "kind": .string(kind), "layerId": .string(layerId)]
        if let data { o["data"] = .object(data) }
        return .object(o)
    }
}

/// Everything one undo step restores. Treated as immutable: changes make a copy (`with`).
public final class PaintDocumentState {
    public var canvas: PaintCanvas
    public var paper: PaperSettings
    /// Bottom to top.
    public var layers: [PaintLayer]
    public var activeLayerId: String?
    /// Every committed stroke, oldest first.
    public var strokes: [RecordedStroke]
    /// Changes besides strokes that a replay repeats (fills, clears), in order.
    public var paintEvents: [PaintEvent]?
    /// Live stroke layers: each layer's strokes, bottom first (its pixels are drawn from them).
    public var liveStrokes: OrderedMap<String, [RecordedStroke]>?
    /// Light paint: each layer's light channel (layers without light are missing).
    public var light: OrderedMap<String, TiledSurface>?
    /// Where this document's (0, 0) is in the coordinates of the canvas it grew from (missing = 0, 0).
    public var origin: LayerOffset?
    /// Effect layers: the provider effect each is drawn from (layer id → effect).
    public var effectLayers: OrderedMap<String, PaintEffectSource>?
    /// Effect paper: a provider generator drawn over the paper, under the paint.
    public var paperEffect: PaintPaperEffect?
    /// Sticker layers: each layer's stickers, bottom first (its pixels are drawn from them).
    public var stickers: OrderedMap<String, [Sticker]>?

    public init(canvas: PaintCanvas, paper: PaperSettings, layers: [PaintLayer], activeLayerId: String?, strokes: [RecordedStroke]) {
        self.canvas = canvas
        self.paper = paper
        self.layers = layers
        self.activeLayerId = activeLayerId
        self.strokes = strokes
    }

    /// A copy with `change` applied (`{ ...doc, ... }`).
    public func with(_ change: (PaintDocumentState) -> Void) -> PaintDocumentState {
        let d = PaintDocumentState(canvas: canvas, paper: paper, layers: layers, activeLayerId: activeLayerId, strokes: strokes)
        d.paintEvents = paintEvents
        d.liveStrokes = liveStrokes
        d.light = light
        d.origin = origin
        d.effectLayers = effectLayers
        d.paperEffect = paperEffect
        d.stickers = stickers
        change(d)
        return d
    }
}

private let nextLayerId = Locked(1)

/// A new layer id, unique in this session: `pl` and a base-36 counter (the TS core adds the clock).
public func newPaintLayerId() -> String {
    let n = nextLayerId.with { v -> Int in defer { v += 1 }; return v }
    return "pl\(String(n, radix: 36).leftPad(9))"
}

extension String {
    func leftPad(_ n: Int, _ c: Character = "0") -> String { count >= n ? self : String(repeating: c, count: n - count) + self }
}

/// Whether a string is an id this editor generates (layers `pl…`, layer styles `fx_…_…`).
public func isGeneratedPaintId(_ value: String) -> Bool {
    value.range(of: "^(pl[0-9a-z]{9,}|[a-z]+_[0-9a-z]{8,}_[0-9a-z]+)$", options: .regularExpression) != nil
}

/// An empty, visible, normal pixel layer.
public func createPaintLayer(_ name: String, id: String = newPaintLayerId()) -> PaintLayer {
    RasterLayer(id: id, name: name, content: .pixel(surface: emptySurface(4), offset: LayerOffset(x: 0, y: 0), fillOpacity: nil))
}

public struct PaintDocumentError: Error, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Validates and rounds a canvas size; throws a `PaintDocumentError` that says what is wrong.
public func normalizeCanvas(width: Double?, height: Double?, dpi rawDpi: Double?) throws -> PaintCanvas {
    func side(_ v: Double?, _ what: String) throws -> Int {
        guard let v, v.isFinite else { throw PaintDocumentError("\(what) must be a number of pixels (\(MIN_CANVAS_SIDE)..\(MAX_CANVAS_SIDE)).") }
        let n = JS.round(v)
        if n < Double(MIN_CANVAS_SIDE) || n > Double(MAX_CANVAS_SIDE) { throw PaintDocumentError("\(what) \(jsText(n)) is out of range; use \(MIN_CANVAS_SIDE)..\(MAX_CANVAS_SIDE) pixels.") }
        return Int(n)
    }
    let dpi = rawDpi ?? DEFAULT_DPI
    if !dpi.isFinite || dpi < 1 || dpi > 10000 { throw PaintDocumentError("dpi \(jsText(dpi)) is out of range; use 1..10000.") }
    return PaintCanvas(width: try side(width, "width"), height: try side(height, "height"), dpi: JS.round(dpi * 100) / 100)
}

/// A blank document: one empty layer over the paper.
public func createPaintDocument(width: Double?, height: Double?, dpi: Double?, paper: JSONObject) throws -> PaintDocumentState {
    let canvas = try normalizeCanvas(width: width ?? 2048, height: height ?? 1536, dpi: dpi)
    let layer = createPaintLayer("Layer 1")
    return PaintDocumentState(canvas: canvas, paper: normalizePaper(paper), layers: [layer], activeLayerId: layer.id, strokes: [])
}

// MARK: - Layer helpers

extension RasterLayer {
    var isPixel: Bool { type == "pixel" }
    var pixelSurface: TiledSurface { surface ?? emptySurface(4) }
    var pixelOffset: LayerOffset { offset ?? LayerOffset(x: 0, y: 0) }

    /// A copy with any property replaced (name and locks too, which `with` keeps).
    func copy(id: String? = nil, name: String? = nil, visible: Bool? = nil, opacity: Double? = nil, blend: GroupBlendMode? = nil, clipped: Bool? = nil, mask: RasterMask?? = nil, locks: LayerLocks?? = nil, effects: LayerEffects?? = nil, content: Content? = nil) -> RasterLayer {
        RasterLayer(
            id: id ?? self.id, name: name ?? self.name, visible: visible ?? self.visible, opacity: opacity ?? self.opacity, blend: blend ?? self.blend,
            clipped: clipped ?? self.clipped, mask: mask ?? self.mask, locks: locks ?? self.locks, effects: effects ?? self.effects, edge: edge,
            content: content ?? self.content
        )
    }

    /// A pixel layer with other pixels (and offset).
    func withSurface(_ surface: TiledSurface, offset: LayerOffset? = nil) -> RasterLayer {
        guard case .pixel(_, let o, let f) = content else { return self }
        return copy(content: .pixel(surface: surface, offset: offset ?? o, fillOpacity: f))
    }
}

/// Layer locks as JSON (only the locks that are set).
func locksJSON(_ l: LayerLocks?) -> JSONObject {
    var o = JSONObject()
    guard let l else { return o }
    if let v = l.pixels { o["pixels"] = .bool(v) }
    if let v = l.transparency { o["transparency"] = .bool(v) }
    if let v = l.position { o["position"] = .bool(v) }
    if let v = l.all { o["all"] = .bool(v) }
    return o
}
