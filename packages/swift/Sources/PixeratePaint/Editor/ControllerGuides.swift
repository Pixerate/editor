import Foundation
import PixerateCore
import PixerateRaster

/// The painting guides of the editor (`controller.ts`, guides section): editor state saved with the document, not undo steps.
extension PaintEditorController {
    /// Mirror and kaleidoscope painting: every new stroke paints its copies too.
    public func setSymmetry(_ update: JSONObject) -> SymmetryGuide {
        guides.symmetry = normalizeSymmetry(update, guides.symmetry)
        return guides.symmetry
    }

    /// Perspective guides with one to three vanishing points that strokes snap to.
    public func setPerspective(_ update: JSONObject) throws -> PerspectiveGuide {
        guides.perspective = try normalizePerspective(update, guides.perspective)
        return guides.perspective
    }

    /// Lays a stencil on the canvas (a ruler or arc to follow, a straight edge or shape to mask).
    public func addStencil(_ input: JSONObject) throws -> Stencil {
        let stencil = try normalizeStencil(input, "stencil\(nextStencilId)")
        nextStencilId += 1
        guides.stencils.append(stencil)
        return stencil
    }

    private func requireStencil(_ id: String) throws -> Stencil {
        guard let s = guides.stencils.first(where: { $0.id == id }) else { throw PaintEditorError("Unknown stencil \"\(id)\". Call get_guides for the stencil ids.") }
        return s
    }

    /// Moves, reshapes, switches (guide / mask, invert) or hides a stencil.
    public func updateStencil(_ id: String, _ update: JSONObject) throws -> Stencil {
        let base = try requireStencil(id)
        var raw = update
        raw["kind"] = .string(base.kind)
        let next = try normalizeStencil(raw, id, base)
        guides.stencils = guides.stencils.map { $0.id == id ? next : $0 }
        return next
    }

    /// Takes stencils away (`ids`, or all of them). Returns the ids removed.
    public func removeStencils(_ ids: [String]?) throws -> [String] {
        if let ids { for id in ids { _ = try requireStencil(id) } }
        let removed = ids ?? guides.stencils.map(\.id)
        guides.stencils = guides.stencils.filter { !removed.contains($0.id) }
        return removed
    }
}

/// The tracing image as tools report it (its data URL left out).
func tracingInfo(_ t: TracingImage?) -> JSONValue {
    guard let t else { return .null }
    return ["width": .number(Double(t.width)), "height": .number(Double(t.height)), "rect": t.rect.json, "opacity": .number(t.opacity), "visible": .bool(t.visible), "sampleColors": .bool(t.sampleColors)]
}

/// A reference image as tools report it (its data URL left out).
func refInfo(_ r: ReferenceImage) -> JSONValue { .object(r.json.without("src")) }

/// The handlers of the guide tools (`guide-tools.ts`) this port implements.
func paintGuideHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["get_guides"] = { _ in
        let g = c.guides
        var symmetry = g.symmetry.json
        symmetry["copies"] = .number(Double(symmetryCopies(g.symmetry).count))
        return ["symmetry": .object(symmetry), "perspective": .object(g.perspective.json), "tracing": tracingInfo(g.tracing), "references": .array(g.references.map(refInfo)), "stencils": .array(g.stencils.map { .object($0.json) })]
    }
    h["set_symmetry"] = { a in
        let s = c.setSymmetry(a)
        var o = s.json
        o["copies"] = .number(Double(symmetryCopies(s).count))
        return .object(o)
    }
    h["set_perspective_guide"] = { a in .object(try c.setPerspective(a).json) }
    h["add_stencil"] = { a in .object(try c.addStencil(a).json) }
    h["update_stencil"] = { a in .object(try c.updateStencil(a["id"]?.stringValue ?? "", a.without("id")).json) }
    h["remove_stencils"] = { a in ["removed": .array(try c.removeStencils(a["ids"]?.arrayValue?.compactMap(\.stringValue)).map { .string($0) })] }
    return h
}
