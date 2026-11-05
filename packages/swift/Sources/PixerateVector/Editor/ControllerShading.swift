import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Gradient meshes and freeform gradients in the vector controller (`vector/controller.ts`): fill
// paths with a mesh or a freeform gradient, read them back in document units and edit their
// points. The Gradient tool's on-canvas point selection and drags are not ported (#624).

extension VectorEditorController {
    /// The path `id`, or why it cannot take a mesh or freeform fill (`shadingTarget`).
    private func shadingTarget(_ id: String) -> Result<VectorNode, VectorEditorError> {
        guard let n = getNode(id) else { return .failure(VectorEditorError("There is no node \"\(id)\".")) }
        if !n.isPath { return .failure(VectorEditorError("\"\(id)\" is a \(n.typeName): meshes and freeform gradients fill paths.")) }
        if n.isLocked { return .failure(VectorEditorError("\"\(id)\" is locked; unlock it first.")) }
        return .success(n)
    }

    /// Sets each path's fill in one undo step (`setFills`).
    private func setFills(_ label: String, _ fills: [(id: String, paint: JSONObject)]) {
        change(label) {
            setDoc(mapTree(doc.nodes) { n in
                guard n.isPath, let f = fills.first(where: { $0.id == n.id }) else { return n }
                var next = n
                next.fill = .object(f.paint)
                return normalizeVectorPaintStacks(next, prefer: "shorthand")
            })
        }
    }

    /// Gives paths (default: the selection) a gradient mesh over their own bounds
    /// (`setMeshGradient`): `rows` × `columns` patches (1–32), coloured by `colors` (one per
    /// point, row by row), the four `corners` blended, or the current fill colour. One undo step.
    @discardableResult
    public func setMeshGradient(rows: Double, columns: Double, colors: [String]? = nil, corners: [String]? = nil, ids: [String]? = nil) -> VectorActionResult {
        let max = Double(VECTOR_MESH_MAX)
        if rows != rows.rounded() || columns != columns.rounded() || !rows.isFinite || !columns.isFinite || rows < 1 || columns < 1 || rows > max || columns > max {
            return .failure("rows and columns must be whole numbers from 1 to \(VECTOR_MESH_MAX).")
        }
        let n = Int((rows + 1) * (columns + 1))
        if let colors, colors.count != n { return .failure("colors needs \(n) colours ((rows + 1) × (columns + 1), row by row); got \(colors.count).") }
        if let corners, corners.count != 4 { return .failure("corners needs four colours: top-left, top-right, bottom-right, bottom-left.") }
        if let bad = (colors ?? []).first(where: { parseVectorColor($0) == nil }) ?? (corners ?? []).first(where: { parseVectorColor($0) == nil }) {
            return .failure("\"\(bad)\" is not a colour.")
        }
        let list = ids ?? selection
        if list.isEmpty { return .failure("Select a path first.") }
        var fills: [(id: String, paint: JSONObject)] = []
        for id in list {
            let t: VectorNode
            switch shadingTarget(id) {
            case let .failure(e): return .failure(e.message)
            case let .success(n): t = n
            }
            guard let b = vectorPathLocalBounds(t), b.width > 0 && b.height > 0 else { return .failure("\"\(id)\" has no area to fill.") }
            let base = t.fill?.stringValue.flatMap { parseVectorColor($0) != nil ? $0 : nil } ?? "#ffffff"
            let mesh = colors != nil ? createVectorMeshGradient(b, rows, columns, colors: colors)
                : corners != nil ? createVectorMeshGradient(b, rows, columns, corners: corners)
                : createVectorMeshGradient(b, rows, columns, colors: Array(repeating: base, count: n))
            fills.append((id, mesh))
        }
        setFills("Gradient Mesh", fills)
        return .success
    }

    /// Gives paths (default: the selection) a freeform gradient (`setFreeformGradient`): `points`
    /// in document units (`{ x, y, color, opacity?, spread? }`) with optional `lines`, or, without
    /// points, four or more placed inside each path and coloured along `colors` (default the
    /// current fill to white). One undo step.
    @discardableResult
    public func setFreeformGradient(points: [JSONValue]? = nil, lines: [JSONValue]? = nil, colors: [String]? = nil, ids: [String]? = nil) -> VectorActionResult {
        let list = ids ?? selection
        if list.isEmpty { return .failure("Select a path first.") }
        var fills: [(id: String, paint: JSONObject)] = []
        for id in list {
            let t: VectorNode
            switch shadingTarget(id) {
            case let .failure(e): return .failure(e.message)
            case let .success(n): t = n
            }
            guard let b = vectorPathLocalBounds(t) else { return .failure("\"\(id)\" has no area to fill.") }
            let f: JSONObject
            if let points, !points.isEmpty {
                let local: [JSONValue] = points.map { q in
                    guard var o = q.objectValue else { return q }
                    let p = toLocal(id, Vec2(q["x"]?.numberValue ?? .nan, q["y"]?.numberValue ?? .nan))
                    o["x"] = .number(p.x)
                    o["y"] = .number(p.y)
                    return .object(o)
                }
                var raw = JSONObject([("type", "freeform"), ("points", .array(local))])
                if let lines { raw["lines"] = .array(lines) }
                guard let s = sanitizeVectorShadedPaint(.object(raw)) else { return .failure("Each point needs x, y (numbers) and a colour.") }
                if let lines, (s["lines"]?.arrayValue?.count ?? 0) != lines.count {
                    return .failure("Each line needs two or more point indices from 0 to \(points.count - 1), none twice in a row.")
                }
                f = s
            } else {
                if let bad = (colors ?? []).first(where: { parseVectorColor($0) == nil }) { return .failure("\"\(bad)\" is not a colour.") }
                let outline = subpathsToBezier(t.subpaths)
                let rule: PolygonFillRule = t.fillRule == "evenodd" ? .evenodd : .nonzero
                let base = t.fill?.stringValue.flatMap { parseVectorColor($0) != nil ? $0 : nil } ?? "#000000"
                f = autoVectorFreeformGradient(b, (colors ?? []).isEmpty ? [base, "#ffffff"] : colors!) { q in pointInBezierPath(.commands(outline), PathPoint(q.x, q.y), rule) }
            }
            fills.append((id, f))
        }
        setFills("Freeform Gradient", fills)
        return .success
    }

    /// The mesh or freeform fill of path `id` with its points in document units, or nil (`getShading`).
    public func getShading(_ id: String) -> JSONObject? {
        guard let n = getNode(id), n.isPath, isVectorShadedPaint(n.fill), let fill = n.fill?.objectValue else { return nil }
        let world = worldOf(id)
        return mapVectorShadedPaint(fill) { applyMatrix(world, $0) }
    }

    /// Checks a shading point edit: the path, its shaded fill and the index (`shadingPoint`).
    private func shadingPoint(_ id: String, _ index: Int, _ kind: String) -> Result<(node: VectorNode, paint: JSONObject), VectorEditorError> {
        let t: VectorNode
        switch shadingTarget(id) {
        case let .failure(e): return .failure(e)
        case let .success(n): t = n
        }
        let mesh = kind == "mesh"
        guard mesh ? isVectorMeshGradient(t.fill) : isVectorFreeformGradient(t.fill), let paint = t.fill?.objectValue else {
            return .failure(VectorEditorError("\"\(id)\" has no \(mesh ? "gradient mesh" : "freeform gradient") fill (add one with \(mesh ? "vector.setMeshGradient" : "vector.setFreeformGradient"))."))
        }
        let count = paint["points"]?.arrayValue?.count ?? 0
        if index < 0 || index >= count { return .failure(VectorEditorError("Point \(index) is out of range: the \(kind) has \(count) points (0 to \(count - 1)).")) }
        return .success((t, paint))
    }

    /// Changes point `index` (row by row) of path `id`'s gradient mesh (`setMeshPoint`): moves it
    /// to `x, y` (document units) and / or sets its `color` and `opacity`. One undo step.
    @discardableResult
    public func setMeshPoint(_ id: String, _ index: Int, x: Double? = nil, y: Double? = nil, color: String? = nil, opacity: Double? = nil) -> VectorActionResult {
        let m: JSONObject
        switch shadingPoint(id, index, "mesh") {
        case let .failure(e): return .failure(e.message)
        case let .success(r): m = r.paint
        }
        if let color, parseVectorColor(color) == nil { return .failure("\"\(color)\" is not a colour.") }
        if (x == nil) != (y == nil) { return .failure("Give both x and y to move the point.") }
        let points = m["points"]?.arrayValue ?? []
        let at = x != nil ? toLocal(id, Vec2(x!, y!)) : Vec2(points[index]["x"]?.numberValue ?? .nan, points[index]["y"]?.numberValue ?? .nan)
        var next = m
        next["points"] = .array(points.enumerated().map { k, q in k == index ? .object(JSONObject([("x", .number(at.x)), ("y", .number(at.y))])) : q })
        next["colors"] = .array((m["colors"]?.arrayValue ?? []).enumerated().map { k, c in k == index && color != nil ? .string(color!) : c })
        if let opacity {
            let ops = m["opacities"]?.arrayValue ?? points.map { _ in 1 }
            next["opacities"] = .array(ops.enumerated().map { k, o in k == index ? .number(Swift.min(1, Swift.max(0, opacity))) : o })
        }
        setFills("Edit Mesh Point", [(id, next)])
        return .success
    }

    /// Adds a point to path `id`'s freeform gradient at `x, y` (document units), coloured `color`
    /// (default: the colour there now) (`addFreeformPoint`). One undo step. Returns its index.
    @discardableResult
    public func addFreeformPoint(_ id: String, x: Double, y: Double, color: String? = nil, opacity: Double? = nil, spread: Double? = nil) -> (result: VectorActionResult, index: Int?) {
        let t: VectorNode
        switch shadingTarget(id) {
        case let .failure(e): return (.failure(e.message), nil)
        case let .success(n): t = n
        }
        guard isVectorFreeformGradient(t.fill), let f = t.fill?.objectValue else {
            return (.failure("\"\(id)\" has no freeform gradient fill (add one with vector.setFreeformGradient)."), nil)
        }
        if !x.isFinite || !y.isFinite { return (.failure("x and y must be numbers."), nil) }
        if let color, parseVectorColor(color) == nil { return (.failure("\"\(color)\" is not a colour."), nil) }
        let local = toLocal(id, Vec2(x, y))
        let b = vectorPathLocalBounds(t)
        let here = sampleVectorFreeform(vectorFreeformField(f, b.map(vectorFreeformSpreadScale) ?? 1), local)
        var point = JSONObject([("x", .number(local.x)), ("y", .number(local.y)), ("color", .string(color ?? vectorRgbaToCss([here[0], here[1], here[2], 1])))])
        if let opacity, opacity < 1 { point["opacity"] = .number(Swift.max(0, opacity)) }
        if let spread, spread != 0, !spread.isNaN { point["spread"] = .number(Swift.min(1, Swift.max(0, spread))) }
        var next = f
        let points = (f["points"]?.arrayValue ?? []) + [.object(point)]
        next["points"] = .array(points)
        setFills("Add Freeform Point", [(id, next)])
        return (.success, points.count - 1)
    }

    /// Changes point `index` of path `id`'s freeform gradient: position (document units), colour,
    /// opacity, spread (`setFreeformPoint`). One undo step.
    @discardableResult
    public func setFreeformPoint(_ id: String, _ index: Int, x: Double? = nil, y: Double? = nil, color: String? = nil, opacity: Double? = nil, spread: Double? = nil) -> VectorActionResult {
        let f: JSONObject
        switch shadingPoint(id, index, "freeform") {
        case let .failure(e): return .failure(e.message)
        case let .success(r): f = r.paint
        }
        if let color, parseVectorColor(color) == nil { return .failure("\"\(color)\" is not a colour.") }
        if (x == nil) != (y == nil) { return .failure("Give both x and y to move the point.") }
        let at = x != nil ? toLocal(id, Vec2(x!, y!)) : nil
        var next = f
        next["points"] = .array((f["points"]?.arrayValue ?? []).enumerated().map { k, q in
            guard k == index else { return q }
            var out = q.objectValue ?? JSONObject()
            if let at {
                out["x"] = .number(at.x)
                out["y"] = .number(at.y)
            }
            if let color { out["color"] = .string(color) }
            if let opacity {
                if opacity >= 1 { out["opacity"] = Optional<JSONValue>.none } else { out["opacity"] = .number(Swift.max(0, opacity)) }
            }
            if let spread {
                if spread <= 0 { out["spread"] = Optional<JSONValue>.none } else { out["spread"] = .number(Swift.min(1, spread)) }
            }
            return .object(out)
        })
        setFills("Edit Freeform Point", [(id, next)])
        return .success
    }

    /// Removes point `index` of path `id`'s freeform gradient (never the last one); lines through
    /// it close up (`removeFreeformPoint`). One undo step.
    @discardableResult
    public func removeFreeformPoint(_ id: String, _ index: Int) -> VectorActionResult {
        let f: JSONObject
        switch shadingPoint(id, index, "freeform") {
        case let .failure(e): return .failure(e.message)
        case let .success(r): f = r.paint
        }
        guard let next = removeVectorFreeformPoint(f, index) else { return .failure("A freeform gradient keeps at least one point.") }
        setFills("Remove Freeform Point", [(id, next)])
        return .success
    }

    /// Replaces the lines of path `id`'s freeform gradient: each a list of two or more point
    /// indices it runs through (`setFreeformLines`). One undo step.
    @discardableResult
    public func setFreeformLines(_ id: String, _ lines: [JSONValue]) -> VectorActionResult {
        let t: VectorNode
        switch shadingTarget(id) {
        case let .failure(e): return .failure(e.message)
        case let .success(n): t = n
        }
        guard isVectorFreeformGradient(t.fill), let fill = t.fill?.objectValue else {
            return .failure("\"\(id)\" has no freeform gradient fill (add one with vector.setFreeformGradient).")
        }
        var withLines = fill
        withLines["lines"] = .array(lines)
        let f = sanitizeVectorShadedPaint(.object(withLines))
        let count = fill["points"]?.arrayValue?.count ?? 0
        if (f?["lines"]?.arrayValue?.count ?? 0) != lines.count {
            return .failure("Each line needs two or more point indices from 0 to \(count - 1), none twice in a row.")
        }
        var rest = fill
        rest["lines"] = Optional<JSONValue>.none
        if !lines.isEmpty { rest["lines"] = f!["lines"]! }
        setFills("Freeform Lines", [(id, rest)])
        return .success
    }
}
