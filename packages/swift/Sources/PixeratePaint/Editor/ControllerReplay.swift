import Foundation
import PixerateCore
import PixerateRaster

/// A replay's variation (`StrokeVariation` plus what `replay_strokes` takes).
public struct ReplayOptions {
    public var strokeIds: [String]
    public var dx: Double?
    public var dy: Double?
    public var scale: Double?
    public var rotate: Double?
    public var flipX: Bool?
    public var origin: (x: Double, y: Double)?
    public var pressureScale: Double?
    public var layerId: String?
    public var color: String?
    public var brushId: String?
    public var repeatCount: Int?
}

/// The affine map of a variation about `origin`.
func variationAffine(_ v: ReplayOptions, _ origin: (x: Double, y: Double)) -> Affine {
    let s = v.scale ?? 1
    let a = ((v.rotate ?? 0) * Double.pi) / 180
    let cos = JS.cos(a) * s
    let sin = JS.sin(a) * s
    let fx = v.flipX == true ? -1.0 : 1.0
    // Translate to the origin, flip, rotate (clockwise with y down) and scale, translate back, move.
    let linear: Affine = [cos * fx, -sin, sin * fx, cos, 0, 0]
    let toOrigin: Affine = [1, 0, 0, 1, -origin.x, -origin.y]
    let back: Affine = [1, 0, 0, 1, origin.x + (v.dx ?? 0), origin.y + (v.dy ?? 0)]
    return composeAffine(back, composeAffine(linear, toOrigin))
}

extension PaintEditorController {
    /**
     * Brushes vector path data (SVG `d`, document pixels) with the active brush, or `brushId` /
     * `brush`, as if drawn by hand: one recorded stroke per subpath, sampled every `spacing` px
     * with an optional `pressure` profile along each. All of it is one undo step.
     */
    public func strokePath(_ path: String, spacing: Double?, pressure: [Double]?, speed: Double? = nil, _ i: PaintStrokeInit) throws -> JSONObject {
        if path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw PaintEditorError("path is empty; give SVG path data in document pixels, e.g. \"M 10 10 C 40 0 80 60 120 30\".") }
        let subpaths = try samplePath(path, spacing: spacing, pressure: pressure, speed: speed)
        let before = doc
        var d = doc
        var bounds: RasterRect? = nil
        var dabs = 0
        var strokeIds: [String] = []
        var last: (doc: PaintDocumentState, result: PaintStrokeResult, brush: PaintBrush)? = nil
        for (k, points) in subpaths.enumerated() {
            var init_ = i
            if let s = i.seed { init_.seed = s + k }
            init_.start = Point2(x: points[0].x, y: points[0].y)
            let run: (doc: PaintDocumentState, result: PaintStrokeResult, brush: PaintBrush)
            do { run = try runStroke(d, init_, points) } catch {
                wetOp = nil
                wet.driver = nil
                throw error
            }
            last = run
            d = run.doc
            bounds = unionRectOpt(bounds, run.result.bounds)
            dabs += run.result.dabs
            if let id = run.result.strokeId { strokeIds.append(id) }
        }
        if let run = last, let load = run.result.mixerLoad { keepLoad(run.brush, load) }
        if d !== before || wetOp != nil { commit("\(last?.brush.name ?? "Brush") path stroke", withWetEvents(d), before: before) } else { emit() }
        let layerId = last?.result.layerId ?? i.layerId ?? doc.activeLayerId ?? ""
        var out: JSONObject = ["layerId": .string(layerId), "bounds": rectJSON(bounds), "dabs": .number(Double(dabs)), "strokeIds": .array(strokeIds.map { .string($0) })]
        if let load = last?.result.mixerLoad { out["mixerLoad"] = loadResult(load) }
        if let w = last?.result.wet { out["wet"] = .bool(w) }
        return out
    }

    /**
     * Replays recorded strokes, varied (moved, scaled, rotated, flipped, recoloured, with another
     * brush or layer), `repeat` times: all of it one undo step. Returns the new strokes.
     */
    public func replayStrokes(_ options: ReplayOptions) throws -> JSONObject {
        if options.strokeIds.isEmpty { throw PaintEditorError("strokeIds is empty; pass ids from list_strokes.") }
        let strokes = try options.strokeIds.map { id in
            guard let s = doc.strokes.first(where: { $0.id == id }) else { throw PaintEditorError("Unknown stroke \"\(id)\". Call list_strokes for the ids.") }
            return s
        }
        let repeatCount = options.repeatCount ?? 1
        if repeatCount < 1 || repeatCount > 100 { throw PaintEditorError("repeat \(repeatCount) is out of range; use 1..100.") }
        if let s = options.scale, !(s > 0 && s <= 20) { throw PaintEditorError("scale \(jsText(s)) is out of range; use above 0 up to 20.") }
        if let c = options.color { _ = try parseColor(.string(c)) }
        if let b = options.brushId { _ = try requireEntry(b) }
        if let l = options.layerId { _ = try paintTarget(l, "replay onto") }
        var origin = options.origin
        if origin == nil {
            let b = strokeBounds(strokes.flatMap(\.points))
            origin = (b.x + b.width / 2, b.y + b.height / 2)
        }
        let step = variationAffine(options, origin!)
        var d = doc
        var bounds: RasterRect? = nil
        var ids: [String] = []
        var layerIds: [String] = []
        var m: Affine = IDENTITY_AFFINE
        for _ in 0..<repeatCount {
            m = [step[0] * m[0] + step[1] * m[2], step[0] * m[1] + step[1] * m[3], step[2] * m[0] + step[3] * m[2], step[2] * m[1] + step[3] * m[3], step[0] * m[4] + step[1] * m[5] + step[4], step[2] * m[4] + step[3] * m[5] + step[5]]
            for s in strokes {
                let v = varyStroke(s, m, pressureScale: options.pressureScale ?? 1)
                var brush = v.brush
                if let bid = options.brushId {
                    let b = try requireEntry(bid).brush
                    var tip = b.tip.json.objectValue!
                    tip["size"] = .number(b.tip.size * (v.brush.tip.size / s.brush.tip.size))
                    brush = normalizePaintBrush(["tip": .object(tip)], b)
                }
                let layerId = options.layerId ?? s.layerId
                if findLayer(d.layers, layerId) == nil { throw PaintEditorError("Stroke \"\(s.id)\" was painted on layer \"\(layerId)\", which no longer exists; pass layerId to replay it elsewhere.") }
                // The recorded load replays the stroke exactly; a recolour reloads the reservoir with the new colour.
                var load = s.load
                if var l = load, let c = options.color, l.reservoir != nil {
                    l.reservoir = hexToRgb8(c).map { Double($0) / 255 }
                    load = l
                }
                var i = PaintStrokeInit(layerId: layerId, color: options.color ?? s.color, brush: nil, seed: s.seed, copies: v.copies ?? [])
                i.fixedBrush = brush
                i.stencils = false
                i.maskStencils = []
                // Gradient paint replays as recorded; a recolour paints the one new colour.
                if let e = v.effect, options.color == nil { i.paint = e.json } else if let p = v.paint, options.color == nil { i.paint = p.json }
                if let load, options.brushId == nil { i.load = load }
                let run = try runStroke(d, i, v.points)
                d = run.doc
                bounds = unionRectOpt(bounds, run.result.bounds)
                if let id = run.result.strokeId { ids.append(id) }
                if !layerIds.contains(layerId) { layerIds.append(layerId) }
            }
        }
        if d !== doc { commit(strokes.count == 1 && repeatCount == 1 ? "Replay stroke" : "Replay strokes", d) }
        return ["strokeIds": .array(ids.map { .string($0) }), "bounds": rectJSON(bounds), "layerIds": .array(layerIds.map { .string($0) })]
    }

    /// Pre-renders effect paints for `replayStrokes(options)`, including path-mapped effects whose paths change per varied repeat.
    func prepareReplayEffectPaints(_ options: ReplayOptions) async throws {
        let picked = options.strokeIds.compactMap { id in doc.strokes.first(where: { $0.id == id }) }
        guard !picked.isEmpty else { return }
        let repeatCount = Swift.max(1, Swift.min(100, options.repeatCount ?? 1))
        var origin = options.origin
        if origin == nil {
            let b = strokeBounds(picked.flatMap(\.points))
            origin = (b.x + b.width / 2, b.y + b.height / 2)
        }
        let step = variationAffine(options, origin!)
        var paints: [PaintEffectPaint] = []
        var m: Affine = IDENTITY_AFFINE
        for _ in 0..<repeatCount {
            m = [step[0] * m[0] + step[1] * m[2], step[0] * m[1] + step[1] * m[3], step[2] * m[0] + step[3] * m[2], step[2] * m[1] + step[3] * m[3], step[0] * m[4] + step[1] * m[5] + step[4], step[2] * m[4] + step[3] * m[5] + step[5]]
            for s in picked {
                if let e = varyStroke(s, m, pressureScale: options.pressureScale ?? 1).effect { paints.append(e) }
            }
        }
        try await prepareEffectPaints(paints)
    }
}
