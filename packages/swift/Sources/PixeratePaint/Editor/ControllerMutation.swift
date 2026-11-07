import Foundation
import PixerateCore
import PixerateRaster

/**
 * Mutation paint (`paint-editor/mutation.ts`, `paint-editor/mutation-tools.ts`, and the controller's
 * mutation section): you paint one or more strokes with a brush carrying `mutation`, pause for
 * `settle` seconds, and an agent claims the mutation with `read_mutation` (starting its fade) and
 * paints its own answer with `answer_mutation`. If no agent answers before `patience` runs out (or
 * the agent declines with `decline_mutation`), the paint stays as ordinary paint.
 */

/// One stroke belonging to a mutation exchange.
public struct PaintMutationStroke: Equatable, Sendable {
    public var id: String
    public var color: String
    public var brushId: String
    public var brushName: String
    public var size: Double
    public var points: [PenPoint]
    public var bounds: RasterRect?

    public var json: JSONValue {
        [
            "id": .string(id),
            "color": .string(color),
            "brushId": .string(brushId),
            "brushName": .string(brushName),
            "size": .number(size),
            "points": .array(points.map(\.json)),
            "bounds": rectJSON(bounds),
        ]
    }
}

/// Summary of a mutation exchange (`list_mutations`, `onMutationRequest`, `decline_mutation`).
public struct PaintMutationInfo: Equatable, Sendable {
    public var id: String
    public var state: String
    public var layerId: String
    public var medium: String
    public var bounds: RasterRect?
    public var strokeCount: Int
    public var age: Double
    public var settle: Double
    public var patience: Double
    public var fade: Double
    public var claimedBy: String?
    public var answerStrokeIds: [String]?
    public var declineReason: String?

    public var json: JSONValue {
        var o: JSONObject = [
            "id": .string(id),
            "state": .string(state),
            "layerId": .string(layerId),
            "medium": .string(medium),
            "bounds": rectJSON(bounds),
            "strokeCount": .number(Double(strokeCount)),
            "age": .number(age),
            "settle": .number(settle),
            "patience": .number(patience),
            "fade": .number(fade),
        ]
        if let claimedBy { o["claimedBy"] = .string(claimedBy) }
        if let answerStrokeIds { o["answerStrokeIds"] = .array(answerStrokeIds.map { .string($0) }) }
        if let declineReason { o["declineReason"] = .string(declineReason) }
        return .object(o)
    }
}

/// Internal mutable state for a tracked mutation in `PaintEditorController`.
final class MutationEntry {
    let id: String
    var state: String
    let layerId: String
    var tempLayerId: String?
    let medium: String
    var strokes: [PaintMutationStroke] = []
    var bounds: RasterRect?
    var settle: Double
    var patience: Double
    var fade: Double
    var age: Double = 0
    var sinceLastStroke: Double = 0
    var sincePending: Double = 0
    var fadeRemaining: Double
    var claimedBy: String?
    var answerStrokeIds: [String]?
    var declineReason: String?

    init(id: String, state: String, layerId: String, tempLayerId: String?, medium: String, settle: Double, patience: Double, fade: Double) {
        self.id = id
        self.state = state
        self.layerId = layerId
        self.tempLayerId = tempLayerId
        self.medium = medium
        self.settle = settle
        self.patience = patience
        self.fade = fade
        self.fadeRemaining = fade
    }
}

/// Why `brush` cannot use `mutation`, or `nil` when it can (`mutationBrushRefusal` in `mutation.ts`).
public func mutationBrushRefusal(_ brush: PaintBrush) -> String? {
    guard brush.mutation != nil else { return nil }
    if ["eraser", "blender", "smudge", "mixer", "sticker"].contains(brush.engine) {
        return "Mutation paint adds strokes that fade when an agent reads them; \(brush.engine) brushes cannot use mutation."
    }
    if brush.behavior.pickup > 0 || brush.behavior.dirty {
        return "Mutation brushes cannot pick up canvas colour (behavior.pickup must be 0 and behavior.dirty false)."
    }
    if brush.engine == "wet" {
        let tool = brush.wet.tool
        if tool != "paint" {
            return "Wet mutation brushes must use wet.tool: \"paint\" (got \"\(tool)\")."
        }
        if brush.light.amount > 0 {
            return "Wet mutation brushes use the wet light channel to track fading paint, so light.amount must be 0."
        }
    }
    return nil
}

/// `r` cut to the canvas, or `nil` when nothing of it is on the canvas.
private func clipMutationRect(_ r: RasterRect, _ width: Int, _ height: Int) -> RasterRect? {
    let x0 = Swift.max(0, r.x)
    let y0 = Swift.max(0, r.y)
    let x1 = Swift.min(width, r.x + r.width)
    let y1 = Swift.min(height, r.y + r.height)
    return x1 > x0 && y1 > y0 ? RasterRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0) : nil
}

extension PaintEditorController {
    /// Whether a mutation-answering agent is connected (`state.hasMutationAgent`).
    public var hasMutationAgent: Bool {
        mutationAgentConnected || !mutationListeners.isEmpty
    }

    /**
     * Hears each mutation once it has settled (`settle` seconds after the user's last mutation
     * stroke). Registering a listener marks an agent as connected (`hasMutationAgent`).
     */
    public func onMutationRequest(_ listener: @escaping (PaintMutationInfo) -> Void) -> Cancellable {
        let had = !mutationListeners.isEmpty
        let id = UUID()
        mutationListeners[id] = listener
        if !had { emit([]) }
        return Cancellable { [weak self] in
            guard let self else { return }
            self.mutationListeners[id] = nil
            if self.mutationListeners.isEmpty { self.emit([]) }
        }
    }

    /// Marks whether a mutation-answering agent is connected (for hosts that wake agents via tools).
    public func setMutationAgentConnected(_ connected: Bool) {
        if mutationAgentConnected == connected { return }
        mutationAgentConnected = connected
        emit([])
    }

    /// Lists pending mutations (or all mutations when `includeAll` is true).
    public func listMutations(includeAll: Bool = false) -> [PaintMutationInfo] {
        let list = includeAll ? mutations : mutations.filter { $0.state == "pending" || $0.state == "settling" }
        return list.map(toMutationInfo)
    }

    /// One mutation by id (`nil` when unknown).
    public func getMutation(_ id: String) -> PaintMutationInfo? {
        mutations.first(where: { $0.id == id }).map(toMutationInfo)
    }

    /**
     * Claims a mutation (`id`) and starts its fade. Returns the strokes (points, colour, brush), a
     * PNG of the area around them (`cropPng`), and a preview of the whole painting (`canvasPng`) so
     * the agent can choose where to answer. Refused if already claimed, answered or declined.
     */
    public func readMutation(_ id: String, actor: String? = nil, padding: Int? = nil, maxSide: Double? = nil) throws -> JSONObject {
        guard let m = mutations.first(where: { $0.id == id }) else {
            throw PaintEditorError("Unknown mutation \"\(id)\". Call list_mutations for the pending ids.")
        }
        if m.state == "claimed" || m.state == "answered" {
            let by = m.claimedBy.map { " by \($0)" } ?? ""
            throw PaintEditorError("Mutation \"\(id)\" has already been claimed\(by).")
        }
        if m.state == "declined" {
            throw PaintEditorError("Mutation \"\(id)\" was already declined.")
        }

        let width = doc.canvas.width, height = doc.canvas.height
        let pad = Swift.max(0, padding ?? 32)
        let baseRect = m.bounds ?? RasterRect(x: 0, y: 0, width: width, height: height)
        let cropRect = clipMutationRect(
            RasterRect(x: baseRect.x - pad, y: baseRect.y - pad, width: baseRect.width + pad * 2, height: baseRect.height + pad * 2),
            width,
            height
        ) ?? RasterRect(x: 0, y: 0, width: width, height: height)

        // Capture the crop and canvas preview before the fade begins so the agent sees the full strokes.
        let full = compositePixels(wet: "display")
        var cropData = [UInt8](repeating: 0, count: cropRect.width * cropRect.height * 4)
        let rowBytes = cropRect.width * 4
        for y in 0..<cropRect.height {
            let srcRow = ((cropRect.y + y) * width + cropRect.x) * 4
            let dstRow = y * rowBytes
            cropData.replaceSubrange(dstRow..<(dstRow + rowBytes), with: full.data[srcRow..<(srcRow + rowBytes)])
        }
        let cropPngBase64 = bytesToBase64(encodePng(cropRect.width, cropRect.height, cropData))
        let preview = renderPreview(maxSide: maxSide ?? 512)
        let canvasPngBase64 = bytesToBase64(encodePng(preview.width, preview.height, preview.data))

        let actorId = actor ?? "agent"
        m.state = "claimed"
        m.claimedBy = actorId
        m.fadeRemaining = m.fade

        if m.medium == "wet" {
            releaseMutationEvaporation(m.layerId)
            wet.releaseGhost(m.layerId, linger: m.fade)
            recordWetSetting("ghost-release", layerId: m.layerId, data: ["linger": .number(m.fade)])
        }

        emit([])
        return [
            "id": .string(m.id),
            "state": .string("claimed"),
            "layerId": .string(m.layerId),
            "medium": .string(m.medium),
            "bounds": rectJSON(m.bounds),
            "fade": .number(m.fade),
            "strokes": .array(m.strokes.map(\.json)),
            "cropPng": [
                "width": .number(Double(cropRect.width)),
                "height": .number(Double(cropRect.height)),
                "rect": cropRect.json,
                "data": .string(cropPngBase64),
            ],
            "canvasPng": [
                "width": .number(Double(preview.width)),
                "height": .number(Double(preview.height)),
                "data": .string(canvasPngBase64),
            ],
        ]
    }

    /**
     * Paints the agent's answer to a claimed mutation (`id`). All strokes commit as one undo step.
     * A second answer to the same id is refused.
     */
    public func answerMutation(_ id: String, strokes rawStrokes: [JSONObject], layerId: String? = nil, note _: String? = nil) async throws -> JSONObject {
        guard let m = mutations.first(where: { $0.id == id }) else {
            throw PaintEditorError("Unknown mutation \"\(id)\". Call list_mutations for the pending ids.")
        }
        if m.state == "answered" {
            throw PaintEditorError("Mutation \"\(id)\" has already been answered.")
        }
        if m.state == "declined" {
            throw PaintEditorError("Mutation \"\(id)\" was declined and cannot be answered.")
        }
        if m.state != "claimed" {
            throw PaintEditorError("Mutation \"\(id)\" has not been claimed yet; call read_mutation(\"\(id)\") first.")
        }
        if rawStrokes.isEmpty {
            throw PaintEditorError("strokes is empty; give at least one stroke with points.")
        }

        let targetLayerId = layerId ?? m.layerId
        _ = try paintTarget(targetLayerId, "paint on")

        var cleanedStrokes: [(initValues: PaintStrokeInit, points: [PenPoint])] = []
        for s in rawStrokes {
            let pts = try checkPoints((s["points"]?.arrayValue ?? []).compactMap(PenPoint.init(json:)))
            let strokeLayerId = s["layerId"]?.stringValue ?? targetLayerId
            _ = try paintTarget(strokeLayerId, "paint on")
            let brushId = s["brushId"]?.stringValue
            let baseBrush = try brushId.map { try requireEntry($0).brush } ?? brush
            var changes = try (s["brush"]?.objectValue).map { try brushChanges($0, from: brushId) } ?? [:]
            let hasExplicitGhost = s["brush"]?.objectValue?["ghost"] != nil
            let stripAutoGhost = baseBrush.ghost?.trigger == "agent" && !hasExplicitGhost
            changes["mutation"] = .null
            if stripAutoGhost { changes["ghost"] = .null }
            var i = PaintStrokeInit(
                layerId: strokeLayerId,
                color: s["color"]?.stringValue,
                paint: s["paint"],
                brushId: brushId,
                brush: changes,
                seed: s["seed"]?.numberValue.map { Int($0) }
            )
            i.snapToPerspective = s["snapToPerspective"]?.boolValue
            cleanedStrokes.append((i, pts))
        }

        m.state = "answered"
        do {
            for item in cleanedStrokes {
                try await prepareStrokePathEffect(item.initValues, item.points)
            }
        } catch {
            m.state = "claimed"
            throw error
        }

        answeringMutation = true
        defer { answeringMutation = false }
        do {
            return try group("Mutation answer") {
                var bounds: RasterRect? = nil
                var dabs = 0
                var strokeIds: [String] = []
                var wetResult: Bool? = nil
                for item in cleanedStrokes {
                    let r = try paintStroke(item.initValues, points: item.points)
                    bounds = unionRectOpt(bounds, r.bounds)
                    dabs += r.dabs
                    if let sid = r.strokeId { strokeIds.append(sid) }
                    if let w = r.wet { wetResult = w }
                }
                m.answerStrokeIds = strokeIds
                var out: JSONObject = [
                    "id": .string(m.id),
                    "state": .string("answered"),
                    "layerId": .string(targetLayerId),
                    "strokeIds": .array(strokeIds.map { .string($0) }),
                    "bounds": rectJSON(bounds),
                    "dabs": .number(Double(dabs)),
                ]
                if let wetResult { out["wet"] = .bool(wetResult) }
                return out
            }
        } catch {
            m.state = "claimed"
            throw error
        }
    }

    /**
     * Gives up on a mutation (`id`) without answering. The user's paint stays as ordinary paint (wet
     * strokes stay in the wet layer, and dry temporary layers merge down into their target layer).
     */
    public func declineMutation(_ id: String, reason: String? = nil) throws -> PaintMutationInfo {
        guard let m = mutations.first(where: { $0.id == id }) else {
            throw PaintEditorError("Unknown mutation \"\(id)\". Call list_mutations for the pending ids.")
        }
        if m.state == "answered" {
            throw PaintEditorError("Mutation \"\(id)\" has already been answered.")
        }
        if m.state == "declined" {
            return toMutationInfo(m)
        }
        m.state = "declined"
        if let r = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !r.isEmpty {
            m.declineReason = r
        }
        keepMutationPaint(m)
        emit()
        return toMutationInfo(m)
    }

    /**
     * Advances mutation timers (`settle`, `patience`, and dry temporary-layer `fade`) by `seconds`
     * of simulated time. Called automatically from `tickMutations` and `advanceWet`.
     */
    public func advanceMutations(_ seconds: Double) {
        if !(seconds > 0) || mutations.isEmpty { return }
        var changed = false
        var dirtyAll = false
        for m in Array(mutations) {
            let wasState = m.state
            if wasState == "settling" || wasState == "pending" || wasState == "claimed" {
                m.age += seconds
                changed = true
            }
            if wasState == "settling" {
                m.sinceLastStroke += seconds
                if m.sinceLastStroke >= m.settle - 1e-9 {
                    m.state = "pending"
                    m.sincePending = Swift.max(0, m.sinceLastStroke - m.settle)
                    let info = toMutationInfo(m)
                    for listener in Array(mutationListeners.values) {
                        listener(info)
                    }
                    if m.state == "pending" && m.sincePending >= m.patience - 1e-9 {
                        expireMutation(m)
                        dirtyAll = true
                    }
                }
            } else if wasState == "pending" {
                m.sincePending += seconds
                if m.sincePending >= m.patience - 1e-9 {
                    expireMutation(m)
                    dirtyAll = true
                }
            } else if wasState == "claimed" || wasState == "answered" {
                if m.medium == "dry", let tempId = m.tempLayerId {
                    changed = true
                    m.fadeRemaining = Swift.max(0, m.fadeRemaining - seconds)
                    if m.fadeRemaining <= 1e-9 {
                        removeTempMutationLayer(m)
                        dirtyAll = true
                    } else {
                        let opacity = m.fade > 0 ? Swift.max(0, Swift.min(1, m.fadeRemaining / m.fade)) : 0
                        if findLayer(doc.layers, tempId) != nil {
                            setDocSilently(doc.with { $0.layers = mapLayer($0.layers, tempId) { $0.copy(opacity: opacity) } })
                            dirtyAll = true
                        }
                    }
                }
            }
        }
        if changed {
            emit(dirtyAll ? nil : [])
        }
    }

    /// Steps mutation timers with the wall clock (in ms).
    public func tickMutations(_ now: Double) {
        if !now.isFinite { return }
        guard let last = lastMutationTick else {
            lastMutationTick = now
            return
        }
        let dt = Swift.max(0, Swift.min(1, (now - last) / 1000))
        lastMutationTick = now
        if dt > 0 && liveStroke == nil {
            advanceMutations(dt)
        }
    }

    func toMutationInfo(_ m: MutationEntry) -> PaintMutationInfo {
        PaintMutationInfo(
            id: m.id,
            state: m.state,
            layerId: m.layerId,
            medium: m.medium,
            bounds: m.bounds,
            strokeCount: m.strokes.count,
            age: JS.round(m.age * 100) / 100,
            settle: m.settle,
            patience: m.patience,
            fade: m.fade,
            claimedBy: m.claimedBy,
            answerStrokeIds: m.answerStrokeIds,
            declineReason: m.declineReason
        )
    }

    func recordMutationStroke(_ stroke: RecordedStroke, _ bounds: RasterRect?) {
        guard let mut = stroke.brush.mutation, !answeringMutation, !previewing else { return }
        let medium = isWetBrush(stroke.brush) ? "wet" : "dry"
        let tempLayerId = medium == "dry" && tempLayerTargets[stroke.layerId] != nil ? stroke.layerId : nil
        let targetLayerId = tempLayerId.flatMap { tempLayerTargets[$0] } ?? stroke.layerId

        let entry: MutationEntry
        if let existing = mutations.first(where: { $0.state == "settling" && $0.layerId == targetLayerId && $0.medium == medium }) {
            existing.settle = mut.settle
            existing.patience = mut.patience
            existing.fade = mut.fade
            existing.fadeRemaining = mut.fade
            existing.sinceLastStroke = 0
            if let tempLayerId, existing.tempLayerId == nil { existing.tempLayerId = tempLayerId }
            entry = existing
        } else {
            let created = MutationEntry(
                id: "m\(nextMutationId)",
                state: "settling",
                layerId: targetLayerId,
                tempLayerId: tempLayerId,
                medium: medium,
                settle: mut.settle,
                patience: mut.patience,
                fade: mut.fade
            )
            nextMutationId += 1
            mutations.append(created)
            if medium == "wet" { holdMutationEvaporation(targetLayerId) }
            entry = created
        }

        let fallbackBounds: RasterRect? = {
            let b = strokeBounds(stroke.points)
            return RasterRect(x: Int(JS.floor(b.x)), y: Int(JS.floor(b.y)), width: Int(JS.ceil(b.width)), height: Int(JS.ceil(b.height)))
        }()
        let strokeRect = bounds ?? fallbackBounds
        entry.strokes.append(PaintMutationStroke(
            id: stroke.id,
            color: stroke.color,
            brushId: stroke.brush.id,
            brushName: stroke.brush.name,
            size: stroke.brush.tip.size,
            points: stroke.points,
            bounds: strokeRect
        ))
        entry.bounds = unionRectOpt(entry.bounds, strokeRect)
    }

    func holdMutationEvaporation(_ layerId: String) {
        if heldEvaporation[layerId] != nil { return }
        let currentEvap = (wet.settings.get(layerId)?.params ?? wet.info(layerId).params).evaporation
        heldEvaporation[layerId] = currentEvap
        _ = try? wet.setParams(layerId, ["evaporation": .number(0)])
    }

    func releaseMutationEvaporation(_ layerId: String) {
        let stillWaiting = mutations.contains {
            $0.medium == "wet" && $0.layerId == layerId && ($0.state == "settling" || $0.state == "pending")
        }
        if stillWaiting { return }
        guard let saved = heldEvaporation.removeValue(forKey: layerId) else { return }
        if findLayer(doc.layers, layerId) != nil {
            _ = try? wet.setParams(layerId, ["evaporation": .number(saved)])
        }
    }

    func finishWetMutationsOnDry(_ layerId: String) {
        for m in mutations where m.medium == "wet" && m.layerId == layerId && (m.state == "settling" || m.state == "pending") {
            m.state = "declined"
            m.declineReason = "Dried before an agent claimed it."
        }
        releaseMutationEvaporation(layerId)
    }

    private func expireMutation(_ m: MutationEntry) {
        m.state = "declined"
        m.declineReason = "No agent answered before patience ran out."
        keepMutationPaint(m)
    }

    func keepMutationPaint(_ m: MutationEntry) {
        if m.medium == "wet" {
            releaseMutationEvaporation(m.layerId)
            wet.keepGhost(m.layerId)
            recordWetSetting("ghost-keep", layerId: m.layerId)
            return
        }
        guard let tempId = m.tempLayerId else { return }
        m.tempLayerId = nil
        tempLayerTargets.removeValue(forKey: tempId)
        guard findLayer(doc.layers, tempId) != nil else { return }

        setDocSilently(mergeTempLayerIntoTarget(doc, tempId, m.layerId))
        for e in undoStack {
            if findLayer(e.before.layers, tempId) != nil { e.before = mergeTempLayerIntoTarget(e.before, tempId, m.layerId) }
            if findLayer(e.after.layers, tempId) != nil { e.after = mergeTempLayerIntoTarget(e.after, tempId, m.layerId) }
        }
        while undoStack.count >= 2,
              findLayer(undoStack[undoStack.count - 2].before.layers, tempId) == nil,
              undoStack[undoStack.count - 1].before.strokes.contains(where: { s in m.strokes.contains(where: { $0.id == s.id }) }),
              undoStack[undoStack.count - 2].after.strokes.contains(where: { s in m.strokes.contains(where: { $0.id == s.id }) })
        {
            let top = undoStack.removeLast()
            undoStack[undoStack.count - 1].after = top.after
        }
    }

    func mergeTempLayerIntoTarget(_ d: PaintDocumentState, _ tempLayerId: String, _ targetLayerId: String) -> PaintDocumentState {
        guard let upper = findLayer(d.layers, tempLayerId)?.layer, upper.isPixel else { return d }
        guard let below = findLayer(d.layers, targetLayerId)?.layer, below.isPixel else {
            return d.with { o in
                o.layers = mapLayer(d.layers, tempLayerId) { _ in nil }
                o.strokes = d.strokes.filter { $0.layerId != tempLayerId }
            }
        }
        let rect = unionRectOpt(describeLayer(below).bounds, describeLayer(upper).bounds)
        var surface = below.pixelSurface
        var offset = below.pixelOffset
        if let rect {
            let base = below.copy(visible: true, opacity: 1, blend: .mode(.normal), clipped: false, mask: .some(nil))
            let top = upper.copy(visible: true, opacity: 1)
            let px = createPaintCompositor().composite([ViewLayer(base), ViewLayer(top)], rect, sources())
            surface = surfaceFromPixels(width: rect.width, height: rect.height, data: px, channels: 4, x: rect.x, y: rect.y)
            offset = LayerOffset(x: 0, y: 0)
        }
        let merged = below.withSurface(surface, offset: offset)
        let layers = mapLayer(mapLayer(d.layers, upper.id) { _ in nil }, below.id) { _ in merged }
        let strokes = d.strokes.map { s -> RecordedStroke in
            guard s.layerId == tempLayerId else { return s }
            var copy = s
            copy.layerId = targetLayerId
            return copy
        }
        return d.with { o in
            o.layers = layers
            o.strokes = strokes
        }
    }

    func removeTempMutationLayer(_ m: MutationEntry) {
        guard let tempId = m.tempLayerId else { return }
        m.tempLayerId = nil
        tempLayerTargets.removeValue(forKey: tempId)
        func strip(_ d: PaintDocumentState) -> PaintDocumentState {
            if findLayer(d.layers, tempId) == nil && !d.strokes.contains(where: { $0.layerId == tempId }) { return d }
            return d.with { o in
                o.layers = mapLayer(d.layers, tempId) { _ in nil }
                o.strokes = d.strokes.filter { $0.layerId != tempId }
            }
        }
        setDocSilently(strip(doc))
        let mutStrokeIds = Set(m.strokes.map(\.id))
        for e in undoStack {
            let isMutationCreationStep =
                !e.before.strokes.contains(where: { mutStrokeIds.contains($0.id) }) &&
                e.after.strokes.contains(where: { mutStrokeIds.contains($0.id) })
            if !isMutationCreationStep {
                e.before = strip(e.before)
                e.after = strip(e.after)
            }
        }
    }

    func reconcileMutationsAfterUndo() {
        if mutations.isEmpty { return }
        let remainingIds = Set(doc.strokes.map(\.id))
        var kept: [MutationEntry] = []
        for m in mutations {
            m.strokes = m.strokes.filter { remainingIds.contains($0.id) }
            if m.strokes.isEmpty {
                if let tempId = m.tempLayerId {
                    tempLayerTargets.removeValue(forKey: tempId)
                    if findLayer(doc.layers, tempId) != nil {
                        setDocSilently(doc.with { o in
                            o.layers = mapLayer(doc.layers, tempId) { _ in nil }
                            o.strokes = doc.strokes.filter { $0.layerId != tempId }
                        })
                    }
                }
                if m.medium == "wet" {
                    releaseMutationEvaporation(m.layerId)
                }
            } else {
                m.bounds = m.strokes.reduce(nil) { unionRectOpt($0, $1.bounds) }
                kept.append(m)
            }
        }
        mutations = kept
    }

    func resetMutations() {
        mutations = []
        heldEvaporation.removeAll()
        tempLayerTargets.removeAll()
        lastMutationTick = nil
    }

    /// The document with any dry temporary mutation layers resolved (for saving/exporting without mutating editor state).
    func savedDocumentState() -> PaintDocumentState {
        var state = doc
        for m in mutations {
            guard m.medium == "dry", let tempId = m.tempLayerId, findLayer(state.layers, tempId) != nil else { continue }
            if m.state == "claimed" || m.state == "answered" {
                state = state.with { o in
                    o.layers = mapLayer(state.layers, tempId) { _ in nil }
                    o.strokes = state.strokes.filter { $0.layerId != tempId }
                }
            } else {
                state = mergeTempLayerIntoTarget(state, tempId, m.layerId)
            }
        }
        for l in flattenLayers(state.layers) where l.isPixel && l.temporary == true {
            if let targetId = tempLayerTargets[l.id], findLayer(state.layers, targetId) != nil {
                state = mergeTempLayerIntoTarget(state, l.id, targetId)
            } else {
                state = state.with { o in
                    o.layers = mapLayer(state.layers, l.id) { _ in nil }
                    o.strokes = state.strokes.filter { $0.layerId != l.id }
                }
            }
        }
        return state
    }
}

/// The handlers of the mutation paint tools (`mutation-tools.ts`).
func paintMutationHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    var h: [String: PaintToolHandler] = [:]
    h["list_mutations"] = { a in
        let x = try ListMutationsArguments(a)
        return ["mutations": .array(c.listMutations(includeAll: x.includeAll ?? false).map(\.json))]
    }
    h["read_mutation"] = { a in
        let x = try ReadMutationArguments(a)
        return .object(try c.readMutation(x.id, padding: x.padding, maxSide: x.maxSide.map(Double.init)))
    }
    h["answer_mutation"] = { a in
        let x = try AnswerMutationArguments(a)
        let strokes = x.strokes.compactMap(\.objectValue)
        return .object(try await c.answerMutation(x.id, strokes: strokes, layerId: x.layerId, note: x.note))
    }
    h["decline_mutation"] = { a in
        let x = try DeclineMutationArguments(a)
        return try c.declineMutation(x.id, reason: x.reason).json
    }
    return h
}
