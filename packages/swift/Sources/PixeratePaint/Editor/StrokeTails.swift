import Foundation
import PixerateCore
import PixerateRaster

/**
 * Editable strokes on pixel layers (#902, `paint-editor/stroke-tails.ts`). A pixel layer keeps the
 * strokes painted on it since its last flattening point as a `StrokeTail`: the pixels and light
 * under them (`base`, `baseLight`) and the ids of those strokes in the stroke log. Only strokes a
 * stroke layer could redraw exactly join a tail (`liveStrokeRefusal`, see the controller's
 * `tailEligible`); any other stroke or change to the layer replaces its surface, which ends the
 * tail, and the strokes after it start a new one over the pixels as they are then.
 *
 * Editing a tail's stroke changes the log itself (the stroke is replaced, reordered or removed in
 * `PaintDocumentState.strokes`), so the colour-scheme replay, `renderHighRes` and the time-lapse
 * paint the edited strokes too. Removing a logged stroke moves the events after it (`at`) down by
 * one, so they keep their place between the strokes.
 */

/**
 * The strokes of a pixel layer that can still be edited: `ids` are logged strokes painted one after
 * another since the layer's last flattening point, bottom first, and `base` / `baseLight` are the
 * layer's pixels and light under them. Valid only while the layer's surface is still `top` and its
 * light `topLight` (by identity, as the TS core compares objects). A class, so a document tells a
 * changed tail from the one it had by identity (`withUnlogged`).
 */
public final class StrokeTail {
    public let base: TiledSurface
    public let baseLight: TiledSurface?
    public let ids: [String]
    public let top: TiledSurface
    public let topLight: TiledSurface?

    public init(base: TiledSurface, baseLight: TiledSurface?, ids: [String], top: TiledSurface, topLight: TiledSurface?) {
        self.base = base
        self.baseLight = baseLight
        self.ids = ids
        self.top = top
        self.topLight = topLight
    }

    /// A copy with other ids and top.
    func with(ids: [String], top: TiledSurface, topLight: TiledSurface?) -> StrokeTail {
        StrokeTail(base: base, baseLight: baseLight, ids: ids, top: top, topLight: topLight)
    }
}

/// A stroke tail as saved: `{ ids, base: { rect, pixels } | null, baseLight? }` (PNG data URLs).
func strokeTailToJSON(_ tail: StrokeTail) -> JSONValue {
    var o: JSONObject = ["ids": .array(tail.ids.map { .string($0) })]
    if let b = tail.base.bounds {
        o["base"] = ["rect": b.json, "pixels": .string(pngDataUrl(b.width, b.height, readRegion(tail.base, b), 4))]
    } else {
        o["base"] = .null
    }
    if let l = tail.baseLight, let saved = lightToJSON(l) { o["baseLight"] = saved }
    return .object(o)
}

/// Saved form → the tail's base, base light and ids (its `top` is the layer as opened); throws a
/// sentence when it cannot be read.
func strokeTailFromJSON(_ raw: JSONValue) throws -> (base: TiledSurface, baseLight: TiledSurface?, ids: [String]) {
    guard let r = raw.objectValue, let list = r["ids"]?.arrayValue else { throw PaintEditorError("it has no list of stroke ids") }
    let ids = list.compactMap(\.stringValue)
    if ids.count != list.count { throw PaintEditorError("it has no list of stroke ids") }
    var base = emptySurface(4)
    if let b = r["base"], jsTruthy(b) {
        guard let o = b.objectValue, let rect = o["rect"], jsTruthy(rect), let pixels = o["pixels"]?.stringValue else { throw PaintEditorError("its base pixels are not a rect and a PNG") }
        guard let parsed = parseDataUrl(pixels) else { throw PaintEditorError("its base pixels are not a PNG data URL") }
        let img = try decodePng(parsed.bytes)
        let rw = rect.objectValue?["width"]?.numberValue, rh = rect.objectValue?["height"]?.numberValue
        if rw != Double(img.width) || rh != Double(img.height) { throw PaintEditorError("its base PNG is not the size of its rect") }
        base = try surfaceAtSavedRect(rect, width: img.width, height: img.height, data: img.data, channels: 4)
    }
    let baseLight = try r["baseLight"].flatMap { jsTruthy($0) ? try lightFromJSON($0) : nil }
    return (base, baseLight, ids)
}

/**
 * The log with a tail's strokes replaced by `list` (the tail after an edit, bottom first): the
 * strokes still there take the tail's places in the log in their new order, and the places of the
 * removed ones go, moving later events (`at`) down. Every stroke of `list` must have an id among `ids`.
 */
func withTailLog(_ doc: PaintDocumentState, _ ids: [String], _ list: [RecordedStroke]) -> (strokes: [RecordedStroke], wetEvents: [WetEvent]?, paintEvents: [PaintEvent]?) {
    let keep = Set(list.map(\.id))
    let wanted = Set(ids)
    var places: [Int] = []
    var removed: [Int] = []
    for (i, s) in doc.strokes.enumerated() where wanted.contains(s.id) {
        if keep.contains(s.id) { places.append(i) } else { removed.append(i) }
    }
    var strokes = doc.strokes
    for (i, at) in places.enumerated() where i < list.count { strokes[at] = list[i] }
    if removed.isEmpty { return (strokes, doc.wetEvents, doc.paintEvents) }
    let gone = Set(removed)
    // An event at `at` comes after `at` strokes: it moves down by the removed strokes before it.
    func shift(_ at: Int) -> Int { at - removed.filter { $0 < at }.count }
    // A moved event is another event object in TS (`{ ...e, at }`): a new key here.
    let wetEvents = doc.wetEvents.map { list in
        list.map { e -> WetEvent in
            guard let at = e.at, shift(at) != at else { return e }
            var x = e
            x.at = shift(at)
            x.key = newStrokeKey()
            return x
        }
    }
    let paintEvents = doc.paintEvents.map { list in
        list.map { e -> PaintEvent in
            guard shift(e.at) != e.at else { return e }
            var x = e
            x.at = shift(e.at)
            x.key = newStrokeKey()
            return x
        }
    }
    return (strokes.enumerated().filter { !gone.contains($0.offset) }.map(\.element), wetEvents, paintEvents)
}

/// The sentence `list_strokes` gives for a logged stroke on a pixel layer that can't be edited.
let BAKED_STROKE_REASON =
    "Painted before its layer was last flattened (by a stroke or change that can’t be redrawn exactly: wet paint, a smudge, blender or pick-up, a fill, a filter, a transform, an import), so its pixels are baked. Strokes painted after that stay editable."
