import Foundation
import PixerateCore
import PixerateRaster

/**
 * Paint proposals (`paint-editor/collaboration.ts`): an agent suggests paint as a ghost the user
 * accepts (painted on a new layer of its own, one undo step) or dismisses, instead of painting it
 * outright. Ops: a dry `stroke`, a `wash` over the layer, or an `echo` of strokes already painted.
 */

private let DRY_ENGINES: Set<String> = ["dab", "particle", "bristle", "mixer"]

private func suggestionBrushRefusal(_ brush: PaintBrush) -> String? {
    if !DRY_ENGINES.contains(brush.engine) { return "The \(brush.name) brush (\(brush.engine)) can't paint a suggestion: suggestions are dry paint on a layer of their own. Use a dab, particle, bristle or mixer brush." }
    if brush.behavior.pickup > 0 { return "The \(brush.name) brush picks up paint, which a suggestion on its own layer can't; choose a brush without pickup." }
    return nil
}

public struct PaintProposal {
    public var id: String
    public var title: String
    public var rationale: String?
    public var origin: String
    public var ops: [JSONObject]
    public var placement: JSONObject
    public var bounds: RasterRect?
    public var ghost: [UInt8]
    public var anchors: [String]
    public var createdAt: Date
    public var strokeGenome: [RecordedStroke]? = nil
}

public final class PaintProposals {
    let controller: PaintEditorController
    private let origin: String?
    private let maxPoints: Int
    private var seq = 0
    public private(set) var proposals: [PaintProposal] = []

    public init(controller: PaintEditorController, origin: String? = nil, maxPoints: Int = 4000) {
        self.controller = controller
        self.origin = origin
        self.maxPoints = maxPoints
        controller.attachProposals(self)
    }

    public func get(_ id: String) -> PaintProposal? {
        proposals.first { $0.id == id }
    }

    private func find(_ id: String) throws -> PaintProposal {
        guard let p = proposals.first(where: { $0.id == id }) else { throw PaintEditorError("No pending paint proposal \"\(id)\". Call list_paint_proposals for the ids.") }
        return p
    }

    private func strokeIds() -> Set<String> { Set(controller.doc.strokes.map(\.id)) }

    private func isHex(_ v: JSONValue?) -> Bool { v?.stringValue.map(isHexColor) ?? false }

    private func validate(_ input: JSONObject, _ strokeGenome: [RecordedStroke]? = nil) throws {
        if (input["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty { throw PaintEditorError("A proposal needs a title: what it adds, in a few words.") }
        guard let ops = input["ops"]?.arrayValue, !ops.isEmpty else { throw PaintEditorError("A proposal needs at least one op (stroke, wash or echo).") }
        let place = input["place"]?.stringValue ?? "top"
        if place == "above" {
            guard let layerId = input["layerId"]?.stringValue else { throw PaintEditorError("place \"above\" needs layerId: the layer to put the suggestion above (list_layers).") }
            if !controller.listLayers().contains(where: { $0.id == layerId }) { throw PaintEditorError("Unknown layer \"\(layerId)\". Call list_layers for the ids.") }
        }
        let known = strokeIds()
        var points = 0
        for (i, opValue) in ops.enumerated() {
            let op = opValue.objectValue ?? [:]
            let at = "ops[\(i)]"
            switch op["kind"]?.stringValue {
            case "stroke":
                guard let pts = op["points"]?.arrayValue, !pts.isEmpty else { throw PaintEditorError("\(at): a stroke needs points in document pixels.") }
                points += pts.count
                if let c = op["color"], !isHex(c) { throw PaintEditorError("\(at): color \"\(c.stringValue ?? "")\" is not #rrggbb.") }
                let brushId = op["brushId"]?.stringValue
                guard let brush = brushId.map({ controller.getBrush($0) }) ?? controller.brush else { throw PaintEditorError("\(at): unknown brush \"\(brushId ?? "")\". Call list_brush_presets for the ids.") }
                if let refusal = suggestionBrushRefusal(brush) { throw PaintEditorError("\(at): \(refusal)") }
                if let size = op["size"]?.numberValue, !(size > 0) { throw PaintEditorError("\(at): size must be above 0 (document pixels).") }
            case "wash":
                if !isHex(op["color"]) { throw PaintEditorError("\(at): a wash needs color as #rrggbb.") }
                if let o = op["opacity"]?.numberValue, !(o > 0 && o <= 1) { throw PaintEditorError("\(at): opacity must be in (0, 1].") }
            case "echo":
                guard let ids = op["strokeIds"]?.arrayValue?.compactMap(\.stringValue), !ids.isEmpty else { throw PaintEditorError("\(at): an echo needs strokeIds (list_strokes).") }
                let unknown = ids.filter { !known.contains($0) }
                if !unknown.isEmpty { throw PaintEditorError("\(at): unknown stroke \(unknown.map { "\"\($0)\"" }.joined(separator: ", ")). Call list_strokes for the ids.") }
                if let c = op["color"], !isHex(c) { throw PaintEditorError("\(at): color \"\(c.stringValue ?? "")\" is not #rrggbb.") }
                if let r = op["repeat"]?.numberValue, !(r.rounded() == r && r >= 1 && r <= 50) { throw PaintEditorError("\(at): repeat must be a whole number from 1 to 50.") }
                for id in ids {
                    let stroke = controller.doc.strokes.first { $0.id == id }!
                    if let refusal = suggestionBrushRefusal(stroke.brush) { throw PaintEditorError("\(at): stroke \"\(id)\": \(refusal)") }
                    points += stroke.points.count * Int(op["repeat"]?.numberValue ?? 1)
                }
            case "strokes":
                guard let genome = strokeGenome, !genome.isEmpty else { throw PaintEditorError("\(at): strokes needs at least one recorded stroke.") }
                for s in genome {
                    if s.points.isEmpty { throw PaintEditorError("\(at): each stroke needs points in document pixels.") }
                    points += s.points.count
                    if !isHexColor(s.color) { throw PaintEditorError("\(at): color \"\(s.color)\" is not #rrggbb.") }
                    if let refusal = liveStrokeRefusal(s.brush) ?? suggestionBrushRefusal(s.brush) { throw PaintEditorError("\(at): \(refusal)") }
                }
            default:
                throw PaintEditorError("\(at): unknown kind \"\(op["kind"]?.stringValue ?? "undefined")\"; use stroke, wash or echo.")
            }
        }
        if points > maxPoints { throw PaintEditorError("The proposal paints \(points) points; the most is \(maxPoints). Suggest less, or echo fewer strokes.") }
    }

    private func paint(_ ops: [JSONObject], _ layerId: String, _ strokeGenome: [RecordedStroke]? = nil) throws -> [String] {
        let before = strokeIds()
        for op in ops {
            switch op["kind"]?.stringValue {
            case "stroke":
                var i = PaintStrokeInit(layerId: layerId, color: op["color"]?.stringValue, brushId: op["brushId"]?.stringValue)
                if let size = op["size"]?.numberValue, size != 0 { i.brush = ["tip": ["size": .number(size)]] }
                i.stencils = false
                _ = try controller.paintStroke(i, points: (op["points"]?.arrayValue ?? []).compactMap(PenPoint.init(json:)))
            case "wash":
                _ = try controller.fillLayer(layerId: layerId, color: op["color"]?.stringValue, opacity: op["opacity"]?.numberValue ?? 0.35, grain: op["grain"]?.numberValue ?? 0.4)
            case "strokes":
                for s in strokeGenome ?? [] {
                    var i = PaintStrokeInit(layerId: layerId, color: s.color, seed: s.seed, copies: s.copies ?? [], load: s.load)
                    i.fixedBrush = s.brush
                    i.paint = s.effect?.json ?? s.paint?.json
                    i.snapToPerspective = false
                    i.stencils = false
                    i.maskStencils = s.stencils ?? []
                    _ = try controller.paintStroke(i, points: s.points)
                }
            default:
                let o = op["origin"]?.objectValue
                _ = try controller.replayStrokes(ReplayOptions(
                    strokeIds: op["strokeIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], dx: op["dx"]?.numberValue, dy: op["dy"]?.numberValue,
                    scale: op["scale"]?.numberValue, rotate: op["rotate"]?.numberValue, flipX: op["flipX"]?.boolValue,
                    origin: o.map { ($0["x"]?.numberValue ?? 0, $0["y"]?.numberValue ?? 0) }, pressureScale: nil,
                    layerId: layerId, color: op["color"]?.stringValue, brushId: nil, repeatCount: op["repeat"]?.numberValue.map { Int($0) }
                ))
            }
        }
        return controller.doc.strokes.map(\.id).filter { !before.contains($0) }
    }

    /// Echoed strokes of a proposal that are gone.
    public func missing(_ id: String) -> [String] {
        guard let p = proposals.first(where: { $0.id == id }) else { return [] }
        let known = strokeIds()
        return p.anchors.filter { !known.contains($0) }
    }

    private func topLayerId() -> String? { controller.listLayers().first { $0.parentId == nil }?.id }

    public func propose(_ input: JSONObject, strokeGenome: [RecordedStroke]? = nil) throws -> PaintProposal {
        try validate(input, strokeGenome)
        var placement: JSONObject = ["place": .string(input["place"]?.stringValue ?? "top")]
        if let l = input["layerId"]?.stringValue, !l.isEmpty { placement["layerId"] = .string(l) }
        if let n = input["layerName"]?.stringValue, !n.isEmpty { placement["layerName"] = .string(n) }
        let place = placement["place"]!.stringValue!
        let ops = (input["ops"]?.arrayValue ?? []).compactMap(\.objectValue)
        let preview = try controller.previewPaint(aboveId: place == "bottom" ? nil : place == "above" ? placement["layerId"]?.stringValue : topLayerId(), bottom: place == "bottom") { layerId in
            _ = try paint(ops, layerId, strokeGenome)
        }
        seq += 1
        var anchors: [String] = []
        for op in ops where op["kind"] == "echo" { for id in op["strokeIds"]?.arrayValue?.compactMap(\.stringValue) ?? [] where !anchors.contains(id) { anchors.append(id) } }
        let p = PaintProposal(
            id: "paint-proposal-\(seq)", title: String(input["title"]!.stringValue!.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)),
            rationale: input["rationale"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }, origin: input["origin"]?.stringValue ?? origin ?? "agent:anonymous",
            ops: ops, placement: placement, bounds: preview.bounds, ghost: preview.composite, anchors: anchors, createdAt: Date(), strokeGenome: strokeGenome
        )
        proposals.append(p)
        return p
    }

    public func proposeStrokes(title: String, rationale: String?, origin: String? = nil, strokes: [RecordedStroke]) throws -> PaintProposal {
        var input: JSONObject = [
            "title": .string(title),
            "ops": .array([.object(["kind": "strokes", "strokes": .array(strokes.map(strokeToJSON))])]),
        ]
        if let rationale, !rationale.isEmpty { input["rationale"] = .string(rationale) }
        if let origin, !origin.isEmpty { input["origin"] = .string(origin) }
        return try propose(input, strokeGenome: strokes)
    }

    public func accept(_ id: String) throws -> JSONObject {
        let p = try find(id)
        let gone = missing(id)
        if !gone.isEmpty { throw PaintEditorError("Paint proposal \"\(p.title)\" echoes strokes that are no longer on the canvas (\(gone.joined(separator: ", "))); dismiss it or propose it again.") }
        let place = p.placement["place"]?.stringValue
        let above = p.placement["layerId"]?.stringValue
        if place == "above" && !controller.listLayers().contains(where: { $0.id == above }) {
            throw PaintEditorError("Paint proposal \"\(p.title)\" goes above layer \"\(above ?? "")\", which is gone; dismiss it or propose it again.")
        }
        let active = controller.doc.activeLayerId
        let result = try controller.group(p.title) { () throws -> (String, [String]) in
            let layer = try controller.addLayer(name: p.placement["layerName"]?.stringValue ?? p.title, aboveId: place == "above" ? above : place == "top" ? topLayerId() : nil)
            if place == "bottom" { _ = try controller.moveLayer(layer.id, 0, parentId: .some(nil)) }
            return (layer.id, try paint(p.ops, layer.id, p.strokeGenome))
        }
        // The suggestion's layer is the agent's; keep the user on the layer they were painting.
        if let active, controller.listLayers().contains(where: { $0.id == active }) { try controller.setActiveLayer(active) }
        proposals.removeAll { $0.id == id }
        return ["proposalId": .string(id), "layerId": .string(result.0), "strokeIds": .array(result.1.map { .string($0) }), "label": .string(p.title)]
    }

    public func reject(_ id: String) throws -> PaintProposal {
        let p = try find(id)
        proposals.removeAll { $0.id == id }
        return p
    }
}

/// `Date.prototype.toISOString`.
private func isoString(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: d)
}

/// The proposal tools (`collaboration-tools.ts`).
public func createPaintProposalToolProvider(_ proposals: PaintProposals) throws -> AgentToolProvider {
    func describe(_ p: PaintProposal) -> JSONObject {
        var o: JSONObject = ["id": .string(p.id), "title": .string(p.title)]
        if let r = p.rationale { o["rationale"] = .string(r) }
        o["origin"] = .string(p.origin)
        o["ops"] = .array(p.ops.map { $0["kind"] ?? .null })
        o["placement"] = .object(p.placement)
        o["bounds"] = rectJSON(p.bounds)
        o["anchors"] = .array(p.anchors.map { .string($0) })
        o["missing"] = .array(proposals.missing(p.id).map { .string($0) })
        o["createdAt"] = .string(isoString(p.createdAt))
        return o
    }
    var h: [String: PaintToolHandler] = [:]
    h["propose_paint"] = { a in
        let p = try proposals.propose(a)
        var o: JSONObject = ["proposalId": .string(p.id)]
        for (k, v) in describe(p).without("id", "missing", "createdAt") { o[k] = v }
        return .object(o)
    }
    h["list_paint_proposals"] = { _ in ["proposals": .array(proposals.proposals.map { .object(describe($0)) }), "readOnly": .null] }
    h["accept_paint_proposal"] = { a in .object(try proposals.accept(a["proposalId"]?.stringValue ?? "")) }
    h["reject_paint_proposal"] = { a in
        let p = try proposals.reject(a["proposalId"]?.stringValue ?? "")
        return ["proposalId": .string(p.id), "title": .string(p.title), "rejected": true]
    }
    return try contractProvider("paint-proposals", h)
}
