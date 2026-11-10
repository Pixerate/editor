import Foundation
import PixerateContracts
import PixerateCore
import PixerateRaster

/**
 * Version 1 brushes (`PaintBrush`, the flat engine form) to facet brushes (`brushes/migrate.ts`):
 * each becomes the sparse facet brush that resolves back to it. What the engine reads survives
 * exactly; settings of engine blocks the brush's engine never reads are dropped, and the
 * category is derived again.
 */

private let CATEGORY_MEDIUM: [String: (String, String?)] = [
    "pencil": ("dry", "pencil"), "pastel": ("dry", "pastel"), "charcoal": ("dry", "charcoal"), "airbrush": ("spray", "airbrush"),
    "marker": ("ink", "marker"), "ink": ("ink", nil), "paint": ("paint", nil),
]

private func tipShapeOf(_ b: PaintBrush) -> String {
    if b.engine == "bristle" { return "bristle" }
    if b.engine == "sticker" || (b.engine == "particle" && !(b.particle["dotTextures"]?.arrayValue ?? []).isEmpty) || (b.engine == "dab" && b.stamp != nil) { return "stamp" }
    if b.tip.roundness >= 1 { return "round" }
    let a = abs(b.tip.angle.truncatingRemainder(dividingBy: 180))
    return abs(a - 45) < 1e-9 || abs(a - 135) < 1e-9 ? "chisel" : "flat"
}

/// The facet brush's identity and the facets that pick its engine, with nothing else set.
private func skeleton(_ b: PaintBrush) -> JSONObject {
    var brush: JSONObject = ["id": .string(b.id), "name": .string(b.name), "kind": "mark", "tip": ["shape": .string(tipShapeOf(b))]]
    if b.engine == "eraser" || b.engine == "blender" || b.engine == "smudge" {
        brush["kind"] = "tool"
        brush["tool"] = .string(b.engine)
        return brush
    }
    if b.engine == "wet" && b.wet.tool == "vortex" {
        brush["medium"] = "paint"
        brush["variety"] = .string(b.wet.medium)
        brush["marks"] = ["kind": "vortex"]
        brush["behaviour"] = ["surface": "wet"]
        if b.iridescence != nil { brush["iridescence"] = [:] }
        if b.mutation != nil { brush["mutation"] = [:] }
        return brush
    }
    if b.engine == "wet" && b.wet.tool != "paint" {
        brush["kind"] = "tool"
        brush["tool"] = .string(WET_TOOL_OF.first { $0.1 == b.wet.tool }!.0)
        return brush
    }
    switch b.engine {
    case "wet":
        brush["medium"] = "paint"
        brush["variety"] = .string(b.wet.medium)
        brush["behaviour"] = ["surface": "wet"]
        if b.ghost != nil && b.mutation == nil { brush["ghost"] = [:] }
    case "impasto":
        brush["medium"] = "paint"
        brush["behaviour"] = ["surface": "thick"]
    case "mixer":
        brush["medium"] = "paint"
        brush["variety"] = "mixer"
        brush["behaviour"] = ["exchange": ["reservoir": [:]]]
    case "bristle":
        brush["medium"] = "paint"
    case "particle":
        brush["marks"] = ["kind": "particles"]
    case "sticker":
        brush["marks"] = ["kind": "objects"]
    case "antimatter":
        brush["medium"] = "paint"
        brush["marks"] = ["kind": "antimatter"]
    case "scraper":
        brush["marks"] = ["kind": "scraper"]
    case "vortex":
        let (medium, variety) = CATEGORY_MEDIUM[b.category] ?? ("paint", nil)
        brush["medium"] = .string(medium)
        if let variety { brush["variety"] = .string(variety) }
        brush["marks"] = ["kind": "vortex"]
    default:
        if let (medium, variety) = CATEGORY_MEDIUM[b.category] {
            brush["medium"] = .string(medium)
            if let variety { brush["variety"] = .string(variety) }
        }
        if b.engine == "dab" && b.spray != nil { brush["marks"] = ["kind": "scatter"] }
    }
    if b.iridescence != nil { brush["iridescence"] = [:] }
    if b.mutation != nil { brush["mutation"] = [:] }
    if b.culture != nil { brush["culture"] = [:] }
    return brush
}

/**
 * The facet brush a v1 brush amounts to: its engine's settings, stored only where they differ
 * from that engine's defaults. `resolveBrush(migrateBrushV1(b))` paints exactly as `b` does.
 */
public func migrateBrushV1(_ raw: PaintBrush) -> Brush {
    let b = renormalized(raw)
    var brush = skeleton(b)
    let defaults = resolveBrush(brush)
    let bj = JSONValue.object(b.json())
    let dj = JSONValue.object(defaults.json())
    let shape = brush.path("tip.shape")?.stringValue ?? ""
    let marksKind = brush.path("marks.kind")?.stringValue ?? "continuous"
    for field in BRUSH_FIELDS {
        if !field.engines.contains(b.engine) || (field.shapes.map { !$0.contains(shape) } ?? false) || (field.marks.map { !$0.contains(marksKind) } ?? false) { continue }
        let v = getPath(bj, field.engine)
        if v != getPath(dj, field.engine) {
            let value = field.map.map { $0.toFacet(v ?? .null) } ?? v
            if let value { setPath(&brush, field.facet, value) }
        }
    }
    if let paint = b.paint { setPath(&brush, "colour.default", paint.json) }
    return orderedBrush(brush)
}
