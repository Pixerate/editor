import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

private let DISTORT_LABELS = ["smudge": "Smudge", "twirl": "Twirl", "attract": "Attract", "repel": "Repel", "roughen": "Roughen"]

@inline(__always) private func pt(_ p: Vec2) -> PathPoint { PathPoint(p.x, p.y) }

extension VectorEditorController {
    // MARK: Anchors

    /// `d` with `fn` applied to anchors `refs` (unlocked paths only).
    func updateAnchors(_ d: VectorDocument, _ refs: [VectorAnchorRef], _ fn: (VectorAnchor, VectorAnchorRef) -> VectorAnchor) -> VectorDocument {
        var byNode: [String: [VectorAnchorRef]] = [:]
        for r in refs { byNode[r.nodeId, default: []].append(r) }
        let nodes = mapTree(d.nodes) { n in
            guard let list = byNode[n.id], n.isPath, !n.isLocked else { return n }
            var next = n
            next.subpaths = n.subpaths.enumerated().map { s, sp in
                let hits = list.filter { $0.subpath == s }
                if hits.isEmpty { return sp }
                return VectorSubpath(closed: sp.closed, anchors: sp.anchors.enumerated().map { i, a in
                    hits.contains { $0.index == i } ? fn(a, VectorAnchorRef(nodeId: n.id, subpath: s, index: i)) : a
                })
            }
            return next
        }
        var out = d
        if nodes != d.nodes { out.nodes = nodes }
        return out
    }

    /// Moves anchors by a document-space offset (converted into each node's own space).
    func movedAnchors(_ d: VectorDocument, _ refs: [VectorAnchorRef], _ dx: Double, _ dy: Double) throws -> VectorDocument {
        var local: [String: Vec2] = [:]
        for r in refs where local[r.nodeId] == nil { local[r.nodeId] = applyMatrixLinear(invertMatrix(worldOf(r.nodeId, d)), Vec2(dx, dy)) }
        return updateAnchors(d, refs) { a, ref in
            let v = local[ref.nodeId]!
            return translateAnchor(a, v.x, v.y)
        }
    }

    /// Moves one anchor to a document position; with `curvature` (default: the `curvatureMoves`
    /// setting) its two segments bend instead, as the Curvature tool does.
    @discardableResult
    public func moveAnchor(_ ref: VectorAnchorRef, _ to: Vec2, curvature: Bool? = nil) throws -> VectorActionResult {
        guard let a = getAnchorWorld(doc, ref) else { return .failure("There is no such anchor.") }
        let curve = curvature ?? curvatureMoves
        try change("Move Point") {
            doc = curve ? curvatureMoved(doc, ref, to) : try movedAnchors(doc, [ref], to.x - a.x, to.y - a.y)
        }
        return .success
    }

    private func curvatureMoved(_ d: VectorDocument, _ ref: VectorAnchorRef, _ to: Vec2) -> VectorDocument {
        guard let node = findVectorNode(d.nodes, ref.nodeId), node.isPath, !node.isLocked, node.subpaths.indices.contains(ref.subpath) else { return d }
        let q = toLocal(ref.nodeId, to, d)
        var next = node
        next.subpaths = node.subpaths.enumerated().map { i, sp in i == ref.subpath ? curvatureMoveAnchor(sp, ref.index, q) : sp }
        var out = d
        out.nodes = mapTree(d.nodes) { $0.id == ref.nodeId ? next : $0 }
        return out
    }

    /// Bends a segment so the curve passes through document point `to` at parameter `t`.
    @discardableResult
    public func bendSegment(_ ref: VectorSegmentRef, _ to: Vec2, t: Double = 0.5) throws -> VectorActionResult {
        let node = getNode(ref.nodeId)
        guard let node, node.isPath, node.subpaths.indices.contains(ref.subpath) else { return .failure("There is no such segment.") }
        let sp = node.subpaths[ref.subpath]
        if ref.segment < 0 || ref.segment >= (sp.closed ? sp.anchors.count : sp.anchors.count - 1) || sp.anchors.count < 2 { return .failure("There is no such segment.") }
        if node.isLocked { return .failure("The path is locked.") }
        change("Bend Segment") {
            let q = toLocal(ref.nodeId, to)
            var next = node
            next.subpaths = node.subpaths.enumerated().map { i, s in i == ref.subpath ? bendSubpathSegment(s, ref.segment, t, q) : s }
            setDoc(mapTree(doc.nodes) { $0.id == ref.nodeId ? next : $0 })
        }
        return .success
    }

    /// Deletes anchors; subpaths left with one anchor and empty paths go too. With `keepShape`
    /// (default: the `keepShapeOnDelete` setting) the neighbours' handles are refitted.
    @discardableResult
    public func deleteAnchors(_ refs: [VectorAnchorRef]? = nil, keepShape: Bool? = nil) throws -> VectorActionResult {
        let list = refs ?? anchors
        if list.isEmpty { return .failure("Select points to delete.") }
        let keep = keepShape ?? keepShapeOnDelete
        change("Delete Points") {
            setDoc(mapTree(doc.nodes) { n in
                guard n.isPath, !n.isLocked else { return n }
                let mine = list.filter { $0.nodeId == n.id }
                if mine.isEmpty { return n }
                let subpaths = n.subpaths.enumerated().map { s, sp -> VectorSubpath in
                    let indices = mine.filter { $0.subpath == s }.map(\.index)
                    if indices.isEmpty { return sp }
                    return keep ? removeAnchorsKeepingShape(sp, indices) : removeAnchors(sp, indices)
                }.filter { $0.anchors.count > 1 }
                if subpaths.isEmpty { return nil }
                var next = n
                next.subpaths = subpaths
                return next
            })
            anchors = []
            selection = selection.filter { getNode($0) != nil }
            if let e = editingId, getNode(e) == nil { editingId = nil }
            if let p = pen, getNode(p.nodeId) == nil { pen = nil }
        }
        return .success
    }

    // MARK: Clean-up, Scissors, Knife and Eraser

    /// Unlocked path nodes in the given roots (default: the paths being edited, else the selection), bottom to top.
    func pathTargets(_ ids: [String]?) -> [VectorNode] {
        var roots = ids ?? selection
        if ids == nil && tool == "direct" && !anchors.isEmpty {
            roots = []
            for r in anchors where !roots.contains(r.nodeId) { roots.append(r.nodeId) }
        }
        var found: [String: VectorNode] = [:]
        for id in roots {
            guard let node = getNode(id), !node.isLocked else { continue }
            for p in collectPathNodes(node) where !p.isLocked { found[p.id] = p }
        }
        var order: [VectorNode] = []
        walkVectorNodes(doc.nodes) { n, _, _ in if let p = found[n.id] { order.append(p) } }
        return order
    }

    /// Subpaths of node `from` mapped into node `to`'s own space.
    func subpathsIn(_ from: VectorNode, _ to: String) -> [VectorSubpath] {
        let m = multiplyMatrices(worldOf(from.id), invertMatrix(worldOf(to)))
        if isRootMatrix(m) { return from.subpaths }
        return from.subpaths.map { sp in
            VectorSubpath(closed: sp.closed, anchors: sp.anchors.map { a in
                let p = applyMatrix(m, Vec2(a.x, a.y))
                var b = VectorAnchor(x: p.x, y: p.y)
                if let h = a.in { b.in = applyMatrix(m, h) }
                if let h = a.out { b.out = applyMatrix(m, h) }
                if let t = a.rawTypeName, !t.isEmpty { b["type"] = .string(t) }
                if let c = a.corner { b.corner = c }
                if let id = a.id, !id.isEmpty { b.id = id }
                return b
            })
        }
    }

    /// Replaces a path with pieces: the first keeps the node's id and place, the others go just
    /// above it with the same style. Returns the ids of the paths now standing in for it.
    func replaceWithPieces(_ node: VectorNode, _ pieces: [[VectorSubpath]]) -> [String] {
        var nodes: [VectorNode] = []
        for (i, subpaths) in pieces.filter({ !$0.isEmpty }).enumerated() {
            var n = node
            n.id = i == 0 ? node.id : newId()
            n.subpaths = subpaths
            nodes.append(n)
        }
        setDoc(spliceTree(doc.nodes, node.id, nodes))
        return nodes.map(\.id)
    }

    /// Join: the open subpaths of the paths become one open path (a single open one is closed).
    @discardableResult
    public func joinPaths(ids: [String]? = nil, tolerance: Double? = nil) throws -> VectorActionResult {
        let paths = pathTargets(ids)
        guard let base = paths.first else { return .failure("Select paths to join.") }
        let all = paths.flatMap { subpathsIn($0, base.id) }
        if !all.contains(where: { !$0.closed && $0.anchors.count > 1 }) { return .failure("There are no open paths to join.") }
        let subpaths = joinSubpaths(all, tolerance ?? self.tolerance())
        let drop = Set(paths.dropFirst().map(\.id))
        change("Join") {
            var joined = base
            joined.subpaths = subpaths
            setDoc(mapTree(doc.nodes) { n in n.id == base.id ? joined : drop.contains(n.id) ? nil : n })
            selection = [base.id]
            anchors = []
            if let e = editingId, drop.contains(e) { editingId = base.id }
            dropStaleRefs()
        }
        return .success
    }

    /// Average: moves anchors onto their average position along `axis`, in document space.
    @discardableResult
    public func averageAnchors(_ axis: String = "both", _ refs: [VectorAnchorRef]? = nil) throws -> VectorActionResult {
        let points = (refs ?? anchors).compactMap { r in getAnchorWorld(doc, r).map { (ref: r, at: $0) } }
        if points.count < 2 { return .failure("Select at least two points to average.") }
        let cx = points.reduce(0) { $0 + $1.at.x } / Double(points.count)
        let cy = points.reduce(0) { $0 + $1.at.y } / Double(points.count)
        try change("Average") {
            for (ref, at) in points {
                let dx = axis == "horizontal" ? 0 : cx - at.x
                let dy = axis == "vertical" ? 0 : cy - at.y
                if dx != 0 || dy != 0 { doc = try movedAnchors(doc, [ref], dx, dy) }
            }
        }
        return .success
    }

    /// Applies `fn` to every subpath of the target paths as one undo step.
    private func editSubpaths(_ label: String, _ ids: [String]?, _ fn: (VectorSubpath, VectorNode, Int) -> VectorSubpath) throws -> VectorActionResult {
        let paths = pathTargets(ids)
        if paths.isEmpty { return .failure("Select a path.") }
        let set = Set(paths.map(\.id))
        change(label) {
            setDoc(mapTree(doc.nodes) { n in
                guard n.isPath, set.contains(n.id) else { return n }
                var next = n
                next.subpaths = n.subpaths.enumerated().map { i, sp in fn(sp, n, i) }
                return next
            })
            dropStaleRefs()
        }
        return .success
    }

    /// Remove Redundant Points within `tolerance` document units (default 0.5).
    @discardableResult
    public func removeRedundantPoints(ids: [String]? = nil, tolerance: Double? = nil) throws -> VectorActionResult {
        let tol = tolerance ?? 0.5
        return try editSubpaths("Remove Redundant Points", ids) { sp, _, _ in removeRedundantSubpathPoints(sp, tol) }
    }

    /// Smooth: pulls handles towards smooth tangents by `amount` (0–1, default 1).
    @discardableResult
    public func smoothPaths(ids: [String]? = nil, amount: Double? = nil, refs: [VectorAnchorRef]? = nil) throws -> VectorActionResult {
        let only = refs ?? (ids == nil && tool == "direct" && !anchors.isEmpty ? anchors : nil)
        var targetIds = ids
        if targetIds == nil, let only {
            var seen: [String] = []
            for r in only where !seen.contains(r.nodeId) { seen.append(r.nodeId) }
            targetIds = seen
        }
        return try editSubpaths("Smooth", targetIds) { sp, node, i in
            let set = only.map { Set($0.filter { $0.nodeId == node.id && $0.subpath == i }.map(\.index)) }
            if let set, set.isEmpty { return sp }
            return smoothSubpath(sp, amount ?? 1, only: set)
        }
    }

    /// Splits a cut subpath into pieces: separate paths for a one-subpath node, subpaths in place otherwise.
    private func applyCuts(_ node: VectorNode, _ cut: (VectorSubpath, Int) -> [VectorSubpath]?) throws -> [String]? {
        let results = node.subpaths.enumerated().map { i, sp in cut(sp, i) }
        if results.allSatisfy({ $0 == nil }) { return nil }
        let subpaths = node.subpaths.enumerated().flatMap { i, sp in results[i] ?? [sp] }
        if node.subpaths.count == 1 { return replaceWithPieces(node, subpaths.map { [$0] }) }
        var next = node
        next.subpaths = subpaths
        try replaceNode(node.id, next)
        return [node.id]
    }

    /// Scissors: cuts path `nodeId` at the outline point nearest document point `point`.
    public func cutPathAt(_ nodeId: String, _ point: Vec2) throws -> [String]? {
        guard let node = getNode(nodeId), node.isPath, !node.isLocked else { return nil }
        let local = toLocal(nodeId, point)
        guard let hit = nearestSegment(node, local) else { return nil }
        let sp = node.subpaths[hit.subpath]
        let n = sp.anchors.count
        let near = [hit.segment, (hit.segment + 1) % n].first { JS.hypot(sp.anchors[$0].x - hit.point.x, sp.anchors[$0].y - hit.point.y) <= tolerance() }
        if !sp.closed && n > 1 && (near == 0 || near == n - 1) && !(hit.t > 1e-6 && hit.t < 1 - 1e-6) { return nil }
        var ids: [String]?
        try change("Cut Path") {
            ids = try applyCuts(node) { s, i in i != hit.subpath ? nil : near.map { cutSubpathAt(s, [$0]) } ?? splitSubpathAt(s, hit.segment, hit.t) }
            if let ids {
                selection = ids
                anchors = []
                if editingId == nodeId { editingId = nil }
            }
            dropStaleRefs()
        }
        return ids
    }

    /// Scissors on anchors: each cuts its subpath there.
    @discardableResult
    public func cutAtAnchors(_ refs: [VectorAnchorRef]? = nil) throws -> VectorActionResult {
        var byNode: [(id: String, refs: [VectorAnchorRef])] = []
        for r in refs ?? anchors where getAnchor(doc, r) != nil {
            if let i = byNode.firstIndex(where: { $0.id == r.nodeId }) { byNode[i].refs.append(r) } else { byNode.append((r.nodeId, [r])) }
        }
        if byNode.isEmpty { return .failure("Select points to cut at.") }
        var created: [String] = []
        try change("Cut Path") {
            for (id, list) in byNode {
                guard let node = getNode(id), !node.isLocked else { continue }
                let ids = try applyCuts(node) { sp, i in
                    let at = list.filter { $0.subpath == i }.map(\.index)
                    let pieces = at.isEmpty ? nil : cutSubpathAt(sp, at)
                    if let pieces, !(pieces.count == 1 && pieces[0].closed == sp.closed) { return pieces }
                    return nil
                }
                if let ids { created += ids }
            }
            if !created.isEmpty { selection = created }
            anchors = []
            dropStaleRefs()
        }
        return created.isEmpty ? .failure("Points at the ends of open paths do not cut.") : .success
    }

    /// Visible, unlocked paths a stroke over `points` can reach: in `ids`, the selection, or (with
    /// neither) any whose bounds it crosses.
    func strokeTargets(_ points: [Vec2], _ ids: [String]?, _ pad: Double) throws -> [VectorNode] {
        var blocked = Set<String>()
        walkVectorNodes(doc.nodes) { n, parent, _ in
            if !n.isVisible || n.isLocked || (parent.map { blocked.contains($0.id) } ?? false) { blocked.insert(n.id) }
        }
        if (ids.map { !$0.isEmpty } ?? false) || !selection.isEmpty { return pathTargets(ids ?? selection).filter { !blocked.contains($0.id) } }
        guard let box = polylineBounds(points, pad) else { return [] }
        var out: [VectorNode] = []
        var failure: Error?
        walkVectorNodes(doc.nodes) { n, _, _ in
            guard failure == nil, n.isPath, !blocked.contains(n.id) else { return }
            do {
                if let b = try vectorNodeBounds(n, vectorParentMatrix(doc.nodes, n.id) ?? IDENTITY_MATRIX), boundsIntersect(b, box) { out.append(n) }
            } catch { failure = error }
        }
        if let failure { throw failure }
        return out
    }

    /// `base` with the target paths distorted by the dabs, and the ids of the paths changed.
    private func distortedDoc(_ base: VectorDocument, _ targets: [String], _ mode: String, _ dabs: [VectorDistortDab]) -> (VectorDocument, Set<String>) {
        if dabs.isEmpty || targets.isEmpty { return (base, []) }
        var changed = Set<String>()
        let nodes = mapTree(base.nodes) { n in
            guard targets.contains(n.id), n.isPath, !n.isLocked else { return n }
            let world = vectorWorldMatrix(base.nodes, n.id) ?? IDENTITY_MATRIX
            let inv = invertMatrix(world)
            let det = abs(world.a * world.d - world.b * world.c)
            let k = 1 / (det != 0 && !det.isNaN ? det : 1).squareRoot()
            let local = dabs.map { d -> VectorDistortDab in
                let c = applyMatrix(inv, Vec2(d.x, d.y))
                var out = d
                out.x = c.x
                out.y = c.y
                out.radius = d.radius * k
                if d.dx != nil || d.dy != nil {
                    let moved = applyMatrix(inv, Vec2(d.x + (d.dx ?? 0), d.y + (d.dy ?? 0)))
                    out.dx = moved.x - c.x
                    out.dy = moved.y - c.y
                }
                return out
            }
            guard let distorted = distortVectorPath(subpathsToBezier(n.subpaths), mode, local) else { return n }
            changed.insert(n.id)
            var next = n
            next.subpaths = bezierToSubpaths(.commands(distorted))
            return next
        }
        var out = base
        if nodes != base.nodes { out.nodes = nodes }
        return (out, changed)
    }

    /// Distortion brush (Smudge, Twirl, Attract, Repel, Roughen) along `points` (document space).
    /// One undo step. Returns the changed ids.
    public func distortBrush(_ mode: String, _ points: [Vec2], ids: [String]? = nil, radius: Double? = nil, strength: Double? = nil, angle: Double? = nil, seed: Double? = nil) throws -> (VectorActionResult, [String]?) {
        if !VECTOR_DISTORT_BRUSH_MODES.contains(mode) { return (.failure("Unknown brush \"\(mode)\": use \(VECTOR_DISTORT_BRUSH_MODES.joined(separator: ", ")).") , nil) }
        if points.isEmpty || points.contains(where: { !$0.x.isFinite || !$0.y.isFinite }) { return (.failure("points must be one or more { x, y } numbers."), nil) }
        if mode == "smudge" && points.count < 2 { return (.failure("Smudge needs two or more points: the stroke pushes the outlines along it."), nil) }
        let r = radius ?? editing["distortSize"]!.numberValue!
        let s = strength ?? editing["distortStrength"]!.numberValue!
        if !(r > 0) { return (.failure("radius must be more than 0."), nil) }
        if !(s >= 0 && s <= 1) { return (.failure("strength must be from 0 to 1."), nil) }
        if let ids {
            for id in ids {
                guard let n = getNode(id) else { return (.failure("There is no node \"\(id)\"."), nil) }
                if n.isLocked { return (.failure("\"\(id)\" is locked; unlock it first."), nil) }
            }
        }
        var targets: [String] = []
        for n in try strokeTargets(points, ids, r) where !targets.contains(n.id) { targets.append(n.id) }
        let dabs: [VectorDistortDab] = mode == "smudge"
            ? points.dropFirst().enumerated().map { i, q in VectorDistortDab(x: points[i].x, y: points[i].y, radius: r, strength: s, dx: q.x - points[i].x, dy: q.y - points[i].y) }
            : points.enumerated().map { i, q in VectorDistortDab(x: q.x, y: q.y, radius: r, strength: s, angle: angle ?? 15, seed: (seed ?? 1) + Double(i)) }
        let (next, changedSet) = distortedDoc(doc, targets, mode, dabs)
        let changed = targets.filter { changedSet.contains($0) }
        if changed.isEmpty { return (.failure("The brush reached no outline: put the points within radius of a path (or pass its id)."), nil) }
        change(DISTORT_LABELS[mode]!) {
            doc = next
            anchors = []
        }
        return (.success, changed)
    }

    /// A stroke's points in node `id`'s own space.
    private func localPoints(_ id: String, _ points: [Vec2]) -> [PathPoint] {
        let inv = invertMatrix(worldOf(id))
        return points.map { pt(applyMatrix(inv, $0)) }
    }

    /// Knife: cuts closed paths along the polyline `points` (document space) wherever it crosses
    /// them from edge to edge. Returns the ids of the pieces (empty when nothing was cut).
    public func knife(_ points: [Vec2], ids: [String]? = nil) throws -> [String] {
        let pts = simplifyPolyline(points.map(pt), 0.25 / zoom).map { Vec2($0[0], $0[1]) }
        if pts.count < 2 { return [] }
        var plan: [(node: VectorNode, pieces: [[VectorSubpath]])] = []
        for node in try strokeTargets(pts, ids, 0) {
            let closed = node.subpaths.filter { $0.anchors.count > 1 }
            if closed.isEmpty || closed.contains(where: { !$0.closed }) { continue }
            let rule = PolygonFillRule(rawValue: node.fillRule ?? "nonzero") ?? .nonzero
            if let result = try knifePath(.commands(subpathsToBezier(closed)), rule, localPoints(node.id, pts)) {
                plan.append((node, result.map { bezierToSubpaths(.commands($0)) }))
            }
        }
        if plan.isEmpty { return [] }
        var created: [String] = []
        change("Knife") {
            for (node, pieces) in plan { created += replaceWithPieces(node, pieces) }
            selection = created
            anchors = []
            dropStaleRefs()
        }
        return created
    }

    /// Eraser: rubs out a round stroke of diameter `size` (default: the `eraserSize` setting)
    /// along `points` (document space). Returns the ids of the paths it changed or created.
    public func erase(_ points: [Vec2], ids: [String]? = nil, size: Double? = nil) throws -> [String] {
        let width = size ?? eraserSize
        if !(width > 0) || points.isEmpty { return [] }
        let pts = simplifyPolyline(points.map(pt), JS.min(width * 0.05, 0.25 / zoom))
        let region = try eraserRegion(pts, width)
        if region.isEmpty { return [] }
        var plan: [(node: VectorNode, pieces: [[VectorSubpath]])] = []
        let reach = bezierPathBounds(.commands(region)).map { [Vec2($0.minX, $0.minY), Vec2($0.maxX, $0.maxY)] } ?? points
        for node in try strokeTargets(reach, ids, 0) {
            let local = transformBezierPath(.commands(region), invertMatrix(worldOf(node.id)).tuple)
            let live = node.subpaths.filter { $0.anchors.count > 1 }
            if live.isEmpty { continue }
            if hasPaint(node.fill) && live.allSatisfy(\.closed) {
                let rule = PolygonFillRule(rawValue: node.fillRule ?? "nonzero") ?? .nonzero
                if let faces = try eraseFromFill(.commands(subpathsToBezier(live)), rule, .commands(local)) { plan.append((node, faces.map { bezierToSubpaths(.commands($0)) })) }
                continue
            }
            let results = live.map { eraseFromOutline($0, .commands(local)) }
            if results.allSatisfy({ $0 == nil }) { continue }
            let subpaths = live.enumerated().flatMap { i, sp in results[i] ?? [sp] }
            plan.append((node, live.count == 1 ? subpaths.map { [$0] } : [subpaths]))
        }
        if plan.isEmpty { return [] }
        var changed: [String] = []
        change("Erase") {
            for (node, pieces) in plan { changed += replaceWithPieces(node, pieces) }
            anchors = []
            dropStaleRefs()
            if !selection.isEmpty || ids != nil {
                var next: [String] = []
                for id in selection + changed.filter({ getNode($0) != nil }) where !next.contains(id) { next.append(id) }
                selection = next
            }
        }
        return changed
    }

    // MARK: Drawing by dimensions

    /// Adds a path drawn by typed dimensions (`addPathByDimensions`): from `start`, each step goes
    /// `{ length, angle }`, `{ dx, dy }` or `{ x, y }`. One undo step; selects it.
    public func addPathByDimensions(start: Vec2, steps: [JSONValue], closed: Bool, name: String?) throws -> (String, [Vec2]) {
        if !start.x.isFinite || !start.y.isFinite { throw VectorEditorError("start must be { x, y } in document units.") }
        if steps.isEmpty { throw VectorEditorError("Give at least one step.") }
        var pts = [start]
        for (i, step) in steps.enumerated() {
            let at = pts[pts.count - 1]
            let st = step.objectValue ?? JSONObject()
            func n(_ k: String) -> Double { st[k]?.numberValue ?? .nan }
            var q: Vec2?
            if st.contains("length") && st.contains("angle") {
                let dir = vectorAngleDirection(n("angle"))
                q = Vec2(at.x + dir.x * n("length"), at.y + dir.y * n("length"))
            } else if st.contains("dx") && st.contains("dy") {
                q = Vec2(at.x + n("dx"), at.y + n("dy"))
            } else if st.contains("x") && st.contains("y") {
                q = Vec2(n("x"), n("y"))
            }
            guard let q, q.x.isFinite, q.y.isFinite else { throw VectorEditorError("Step \(i) must be { length, angle }, { dx, dy } or { x, y } with numbers.") }
            pts.append(q)
        }
        let id = newId()
        var props = JSONObject([("id", .string(id)), ("type", "path"), ("name", .string(name ?? "Path"))])
        for (k, v) in try styleFor(open: !closed) { props[k] = v }
        let node = VectorNode(props: props, subpaths: [VectorSubpath(closed: closed, anchors: pts.map { VectorAnchor(x: $0.x, y: $0.y) })])
        change("Add Path") {
            setDoc(doc.nodes + [node])
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (id, pts)
    }
}

/// The unit direction of `deg` degrees counter-clockwise on the page (0 right, 90 up; `vectorAngleDirection`).
func vectorAngleDirection(_ deg: Double) -> Vec2 {
    let r = (deg * Double.pi) / 180
    func exact(_ n: Double) -> Double { abs(n) < 1e-12 ? 0 : n }
    return Vec2(exact(JS.cos(r)), exact(-JS.sin(r)))
}
