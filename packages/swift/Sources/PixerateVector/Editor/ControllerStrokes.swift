import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Strokes in the vector controller (`vector/controller.ts`): width profiles and width points, live
// corner radii, Outline Stroke, brushstroke layers and the brush colour scheme / lock. The width
// tool's on-canvas state (selected width points, the open width-point editor) is not ported (#624).

/// The centre line a path's stroke follows and its half width (`vectorStrokeWidthGeometry`), or
/// nil when the path has no visible stroke.
public func vectorStrokeWidthGeometry(_ node: VectorNode) -> (line: BezierPath, unit: Double)? {
    if !hasPaint(node.stroke) || !((node.strokeWidth ?? 1) > 0) { return nil }
    let parts = vectorStrokeParts(subpathsToBezier(node.subpaths), node)
    return parts.line.isEmpty ? nil : (parts.line, parts.drawWidth / 2)
}

extension VectorEditorController {
    // MARK: Width profiles

    /// Sets the variable-width profile of the selected (or given) paths (`setWidthProfile`): a
    /// preset id (`uniform` removes the profile), points (nil removes it), or a taper / wave.
    @discardableResult
    public func setWidthProfile(preset: String? = nil, points: JSONValue? = nil, taper: VectorTaperOptions? = nil, wave: VectorWaveOptions? = nil, ids: [String]? = nil) throws -> VectorActionResult {
        var list: [VectorWidthPoint]
        if let preset {
            guard let p = widthProfilePreset(preset) else { return .failure("There is no width profile \"\(preset)\".") }
            list = p
        } else if let points, points != .null {
            list = sanitizeWidthProfile(points)
        } else if taper != nil || wave != nil {
            list = generateWidthProfile(taper: taper, wave: wave)
        } else {
            list = []
        }
        return try setStyle(["strokeWidthProfile": list.isEmpty ? .null : widthProfileJSON(list)], ids: ids ?? selection, label: list.isEmpty ? "Uniform Width" : "Width Profile")
    }

    /// Sets one width point of a path's stroke profile in document units (`setWidthPoint`):
    /// `index` names an existing point, nil adds one at `t`. `left` / `right` are side widths
    /// (how far the stroke reaches on each side). A point moved onto another one's `t` makes a step.
    @discardableResult
    public func setWidthPoint(_ nodeId: String, index existing: Int? = nil, t tIn: Double? = nil, left leftIn: Double? = nil, right rightIn: Double? = nil) throws -> VectorActionResult {
        guard let node = getNode(nodeId), node.isPath else { return .failure("There is no such path.") }
        guard let g = vectorStrokeWidthGeometry(node), g.unit > 0 else { return .failure("The path has no visible stroke.") }
        func num(_ v: Double?) -> Double? { v.flatMap { $0.isFinite ? $0 : nil } }
        let t = num(tIn)
        func scale(_ w: Double?) -> Double? { num(w).map { Swift.max(0, $0) / g.unit } }
        let profile = sanitizeWidthProfile(node["strokeWidthProfile"])
        var points: [VectorWidthPoint]
        if let existing {
            guard profile.indices.contains(existing) else { return .failure("There is no such width point.") }
            let p = profile[existing]
            let left = scale(leftIn) ?? p.left
            let right = scale(rightIn) ?? p.right
            let tt = t.map { Swift.min(Swift.max($0, 0), 1) } ?? p.t
            if abs(tt - p.t) <= VECTOR_WIDTH_SAME_T {
                points = PixerateVector.setWidthPoint(profile, existing, left: left, right: right)
            } else {
                // Free to pass its neighbours: take it out and put it back at its new place.
                let rest = removeWidthPoints(profile, [existing])
                points = rest.isEmpty ? [VectorWidthPoint(t: tt, left: left, right: right)] : insertWidthPoint(rest, tt, left: left, right: right, step: true).points
            }
        } else {
            guard let t else { return .failure("A new width point needs a position t.") }
            if profile.count >= VECTOR_WIDTH_PROFILE_MAX_POINTS { return .failure("The profile has too many width points.") }
            points = insertWidthPoint(profile.isEmpty ? nil : profile, t, left: scale(leftIn), right: scale(rightIn), step: true).points
        }
        try change("Width Point") { try replaceNode(node.id, try withStyle(node, ["strokeWidthProfile": widthProfileJSON(points)])) }
        return .success
    }

    // MARK: Live corners

    /// Anchors a corner change applies to (`cornerTargets`): `refs`, else the selected anchors
    /// (direct tool), else every anchor of the `ids` / selected unlocked paths.
    private func cornerTargets(_ refs: [VectorAnchorRef]?, _ ids: [String]?) -> [VectorAnchorRef] {
        if let refs { return refs.filter { getAnchor(doc, $0) != nil } }
        if ids == nil && tool == "direct" && !anchors.isEmpty { return anchors }
        var out: [VectorAnchorRef] = []
        for id in ids ?? selection {
            guard let node = getNode(id) else { continue }
            for p in collectPathNodes(node) where !p.isLocked {
                for (s, sp) in p.subpaths.enumerated() { for i in sp.anchors.indices { out.append(VectorAnchorRef(nodeId: p.id, subpath: s, index: i)) } }
            }
        }
        return out
    }

    /// Sets the live corner radius (and optionally the kind and smoothing) of anchors
    /// (`setCornerRadius`). Radius 0 makes the corners sharp again.
    @discardableResult
    public func setCornerRadius(_ radius: Double, kind: String? = nil, smoothing: Double? = nil, refs: [VectorAnchorRef]? = nil, ids: [String]? = nil) -> VectorActionResult {
        if !radius.isFinite || radius < 0 { return .failure("The radius must be a number of at least 0.") }
        if let smoothing, !(smoothing >= 0 && smoothing <= 1) { return .failure("Corner smoothing must be from 0 to 1.") }
        let targets = cornerTargets(refs, ids)
        if targets.isEmpty { return .failure("Nothing is selected.") }
        change(radius > 0 ? "Corner Radius" : "Sharpen Corners") {
            doc = updateAnchors(doc, targets) { a, _ in setAnchorCorner(a, radius, kind, smoothing) }
        }
        return .success
    }

    /// Sets corner smoothing (squircle, 0–1) of the same anchors, keeping their radii (`setCornerSmoothing`).
    @discardableResult
    public func setCornerSmoothing(_ smoothing: Double, refs: [VectorAnchorRef]? = nil, ids: [String]? = nil) -> VectorActionResult {
        if !(smoothing >= 0 && smoothing <= 1) { return .failure("Corner smoothing must be from 0 to 1.") }
        let targets = cornerTargets(refs, ids).filter { (getAnchor(doc, $0)?.corner?.radius ?? 0) > 0 }
        if targets.isEmpty { return .failure("Give the corners a radius first: smoothing shapes rounded corners.") }
        change("Corner Smoothing") {
            doc = updateAnchors(doc, targets) { a, _ in setAnchorCorner(a, a.corner?.radius ?? 0, nil, smoothing) }
        }
        return .success
    }

    /// Sets the live corner kind of the same anchors, keeping their radii (`setCornerKind`).
    @discardableResult
    public func setCornerKind(_ kind: String, refs: [VectorAnchorRef]? = nil, ids: [String]? = nil) -> VectorActionResult {
        let targets = cornerTargets(refs, ids)
        if targets.isEmpty { return .failure("Nothing is selected.") }
        change("Corner Kind") {
            doc = updateAnchors(doc, targets) { a, _ in setAnchorCorner(a, a.corner?.radius ?? 0, kind) }
        }
        return .success
    }

    // MARK: Outline Stroke

    /// Outline Stroke (`outlineStroke`): replaces each selected (or given) path's stroke with a
    /// filled path of the area it paints (alignment, joins, caps, dashes and arrowheads included),
    /// placed above a copy of the path that keeps the fill (left out when there is none). One
    /// filled path per drawn stroke layer, bottom to top. Returns the new paths' ids.
    public func outlineStroke(ids: [String]? = nil) throws -> [String] {
        let roots = ids ?? selectedRoots()
        func strokesOf(_ p: VectorNode) -> [VectorPaintLayerNode] {
            vectorPaintLayerNodes(p).filter { $0.kind == "stroke" && $0.drawn && ($0.node.strokeWidth ?? 1) > 0 }
        }
        var paths: [VectorNode] = []
        for id in roots {
            guard let node = getNode(id) else { continue }
            for p in collectPathNodes(node) where !p.isLocked && !strokesOf(p).isEmpty { paths.append(p) }
        }
        if paths.isEmpty { return [] }
        var created: [String] = []
        var replace: [(String, [VectorNode])] = []
        for p in paths {
            var rest = try cloneVectorNode(p)
            let effects = rest["effects"]
            rest["effects"] = Optional<JSONValue>.none
            var unstroked = withVectorStrokes(rest, [])
            for key in VECTOR_STROKE_SETTING_KEYS { unstroked[key] = Optional<JSONValue>.none }
            var list: [VectorNode] = []
            if !vectorFills(p).isEmpty {
                var keep = unstroked
                if let effects { keep["effects"] = effects }
                list.append(keep)
            }
            let layers = strokesOf(p)
            // In the node's own space (the new paths keep its transform), as drawn (path effects applied).
            let outlineSource = try vectorAppearanceOutline(p)
            for l in layers {
                let outline = bezierToSubpaths(.commands(try vectorStrokeOutlinePath(outlineSource, l.node)))
                if outline.isEmpty { continue }
                let id = newId()
                var plain = unstroked
                plain["strokes"] = Optional<JSONValue>.none
                plain["fills"] = Optional<JSONValue>.none
                let base = p.name ?? "Path"
                plain.id = id
                plain["name"] = .string(layers.count > 1 ? "\(base) Stroke \(l.index + 1)" : "\(base) Stroke")
                plain.subpaths = outline
                plain["stroke"] = .null
                plain["fillRule"] = "nonzero"
                var fill = JSONObject([("paint", l.layer["paint"] ?? .null)])
                if let o = l.layer["opacity"] { fill["opacity"] = o }
                if truthy(l.layer["blendMode"]) { fill["blendMode"] = l.layer["blendMode"]! }
                list.append(withVectorFills(plain, [fill]))
                created.append(id)
            }
            replace.append((p.id, list))
        }
        if created.isEmpty { return [] }
        change("Outline Stroke") {
            var nodes = doc.nodes
            for (id, list) in replace { nodes = spliceTree(nodes, id, list) }
            setDoc(nodes)
            selection = created
            anchors = []
            editingId = nil
        }
        return created
    }

    // MARK: Brushstrokes

    /// Adds a brushstroke to the selected (or given) paths (`addBrushstroke`): a stroke layer that
    /// paints the path with brush `brush.brushId` in `color` (default the brush's own default
    /// colour, unless `keepColour` or the colour is locked; else the top stroke's paint, else
    /// black) at `opacity`, on top of the stroke stack or at `index`. One undo step.
    @discardableResult
    public func addBrushstroke(_ brush: JSONObject, ids: [String]? = nil, index: Double? = nil, color: String? = nil, keepColour: Bool = false, opacity: Double? = nil) throws -> VectorActionResult {
        let brushId = brush["brushId"]?.stringValue
        let brushError = brushId.map { vectorBrushstrokeBrushError($0) } ?? "brushId must be a brush id (vector.listBrushes lists them)."
        let clean = brushError == nil ? sanitizeVectorBrushstroke(.object(brush)) : nil
        guard let clean else { return .failure(brushError ?? "Brush \"\(brushId ?? "")\" can't paint a brushstroke (vector.listBrushes lists the ones that can).") }
        if let size = brush["size"], !((size.numberValue ?? .nan) > 0 && (size.numberValue ?? .nan) <= 500) { return .failure("size must be above 0 and at most 500 (document units).") }
        if let e = vectorBrushstrokeCharacterError(seed: brush["seed"], paper: brush["paper"]) { return .failure(e) }
        if let paint = brush["paint"], let e = vectorBrushstrokePaintError(paint) { return .failure(e) }
        if let color, parseVectorColor(color) == nil { return .failure("\"\(color)\" is not a colour.") }
        if let opacity, !(opacity >= 0 && opacity <= 1) { return .failure("opacity must be from 0 to 1.") }
        let own = keepColour || colorLocked ? nil : vectorBrushstrokeDefaultColour(clean["brushId"]!.stringValue!, scheme: colorScheme)
        return try editStacks("stroke", ids, "Add Brushstroke") { stack, path in
            let top = stack.last { ($0["kind"]?.stringValue ?? "paint") == "paint" }
            let topPaint = top?["paint"]?.stringValue.flatMap { $0 != "none" ? $0 : nil }
            let pathStroke = path.stroke?.stringValue.flatMap { $0 != "none" ? $0 : nil }
            let paint = color ?? own ?? topPaint ?? pathStroke ?? "#000000"
            var layer = JSONObject([("kind", "brushstroke"), ("paint", .string(paint)), ("brush", .object(clean))])
            if let opacity, opacity < 1 { layer["opacity"] = .number(opacity) }
            let at = index.map { Int(Swift.min(Double(stack.count), Swift.max(0, JS.round($0)))) } ?? stack.count
            var next = stack
            next.insert(layer, at: at)
            return .success(next)
        }
    }

    /// Changes brushstroke layer `index` of the selected (or given) paths (`setBrushstroke`).
    /// `patch` may hold `brushId`, `size`, `pressure`, `seed`, `paint` (null removes each), `paper`
    /// (replaced whole), `color`, `keepColour` and `opacity`. Another brush without a `color` takes
    /// that brush's default colour, unless `keepColour` or the colour is locked. One undo step.
    @discardableResult
    public func setBrushstroke(_ index: Int, _ patch: JSONObject, ids: [String]? = nil) throws -> VectorActionResult {
        let brushId = patch["brushId"]?.stringValue
        if let brushId, let e = vectorBrushstrokeBrushError(brushId) { return .failure(e) }
        if let size = patch["size"], size != .null, !((size.numberValue ?? .nan) > 0 && (size.numberValue ?? .nan) <= 500) { return .failure("size must be above 0 and at most 500 (document units).") }
        if let color = patch["color"]?.stringValue, parseVectorColor(color) == nil { return .failure("\"\(color)\" is not a colour.") }
        if let o = patch["opacity"], !((o.numberValue ?? .nan) >= 0 && (o.numberValue ?? .nan) <= 1) { return .failure("opacity must be from 0 to 1.") }
        if let e = vectorBrushstrokeCharacterError(seed: patch["seed"] == .null ? nil : patch["seed"], paper: patch["paper"]) { return .failure(e) }
        if let paint = patch["paint"], paint != .null, let e = vectorBrushstrokePaintError(paint) { return .failure(e) }
        let keepColour = patch["keepColour"]?.boolValue == true
        return try editStacks("stroke", ids, "Edit Brushstroke") { stack, path in
            guard stack.indices.contains(index), stack[index]["kind"] == "brushstroke", var brush = stack[index]["brush"]?.objectValue else {
                return .failure(VectorEditorError("Path \"\(path.id)\" has no brushstroke at stroke \(index) (vector.getAppearance lists its strokes; 0 is the bottom)."))
            }
            let layer = stack[index]
            let before = brush["brushId"]?.stringValue
            // Choosing a brush, even the same one, drops the embedded saved brush: it is looked up again.
            if let brushId, !brushId.isEmpty {
                brush["brushId"] = .string(brushId)
                remove(&brush, "spec")
            }
            for key in ["size", "pressure", "seed", "paint"] {
                guard let v = patch[key] else { continue }
                if v == .null { remove(&brush, key) } else { brush[key] = v }
            }
            if let paper = patch["paper"] { brush["paper"] = paper }
            let own = brushId.map { !$0.isEmpty && $0 != before && !keepColour && !colorLocked } == true ? vectorBrushstrokeDefaultColour(brushId!, scheme: colorScheme) : nil
            var next = layer
            next["brush"] = .object(sanitizeVectorBrushstroke(.object(brush)) ?? layer["brush"]!.objectValue!)
            if let colour = patch["color"]?.stringValue ?? own, !colour.isEmpty { next["paint"] = .string(colour) }
            if let o = patch["opacity"] { next["opacity"] = o }
            var out = stack
            out[index] = next
            return .success(out)
        }
    }

    /// Sets the colour scheme that picks the side of a brush's light / dark default colour
    /// (`setColorScheme`). Existing strokes keep their colour.
    public func setColorScheme(_ scheme: String) {
        let next = scheme == "dark" ? "dark" : "light"
        if colorScheme == next { return }
        colorScheme = next
        notify()
    }

    /// Locks the brushstroke colour ("Keep my colour", `setColorLocked`). Editor state, not an undo step.
    public func setColorLocked(_ locked: Bool) {
        if colorLocked == locked { return }
        colorLocked = locked
        notify()
    }
}
