import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Blends, envelopes and live symmetry groups of `VectorEditorController` (`vector/controller.ts`).
// The Blend tool, the Envelope tool and drawing into an entered symmetry group are pointer input,
// which is not ported; the TS `merge` option (slider drags folded into one undo step) is not
// ported either.

private let BLEND_OPTION_KEYS = ["spacing", "steps", "distance", "orientToSpine", "linear"]

/// The valid blend options in `input`, in the TS order (`blendOptionsOf`).
func blendOptionsOf(_ input: JSONObject) -> JSONObject {
    var out = JSONObject()
    if let s = input["spacing"]?.stringValue, VECTOR_BLEND_SPACINGS.contains(s) { out["spacing"] = .string(s) }
    if let n = input["steps"]?.numberValue, n.isFinite { out["steps"] = .number(JS.min(1000, JS.max(1, JS.round(n)))) }
    if let n = input["distance"]?.numberValue, n.isFinite, n > 0 { out["distance"] = .number(n) }
    if let b = input["orientToSpine"]?.boolValue { out["orientToSpine"] = .bool(b) }
    if let b = input["linear"]?.boolValue { out["linear"] = .bool(b) }
    return out
}

/// What `releaseSymmetry` returns: the ids expanding added, or why it could not.
public struct VectorSymmetryReleaseResult: Equatable, Sendable {
    public var result: VectorActionResult
    public var ids: [String]
}

extension VectorEditorController {
    // MARK: Blends

    /// Selected (or given) blend groups; a selected key or step counts as its blend (`blendTargets`).
    func blendTargets(_ ids: [String]?) -> [VectorNode] {
        var out = OrderedPaths()
        for id in ids ?? selection {
            let node = getNode(id)
            let group = isVectorBlendGroup(node) ? node : locateVectorNode(doc.nodes, id)?.parent
            if let group, isVectorBlendGroup(group) { out.set(group) }
        }
        return out.values
    }

    /// Sets the options new blends get (`setBlendDefaults`).
    public func setBlendDefaults(_ patch: JSONObject) {
        for (k, v) in blendOptionsOf(patch) { blendDefaults[k] = v }
        notify()
    }

    /**
     * Blends two or more selected (or given) paths or groups (`blend`): they become the keys of a
     * live blend group (bottom to top, or in the order given with `keepOrder`) whose in-betweens
     * are regenerated whenever a key or the options change. The keys must share a parent. `input`
     * holds the blend options, `starts` (key id → anchor) and `name`. Returns the group's id, or nil.
     */
    public func blend(ids idsIn: [String]? = nil, _ input: JSONObject = JSONObject(), keepOrder: Bool = false) -> String? {
        var ids: [String] = []
        for id in idsIn ?? selectedRoots() where !ids.contains(id) {
            guard let n = getNode(id), !truthy(n["blendStep"]), !n.isLocked else { continue }
            ids.append(id)
        }
        if ids.count < 2 { return nil }
        let locs = ids.map { locateVectorNode(doc.nodes, $0)! }
        let parent = locs[0].parent?.id
        if locs.contains(where: { $0.parent?.id != parent }) { return nil }
        let order = keepOrder ? ids : jsSorted(ids) { a, b in Double(locs[ids.firstIndex(of: a)!].index - locs[ids.firstIndex(of: b)!].index) }
        var merged = blendDefaults
        for (k, v) in input { merged[k] = v }
        var blend = blendOptionsOf(merged)
        if let raw = input["starts"]?.objectValue {
            var starts = JSONObject()
            for (k, v) in raw where order.contains(k) {
                if let n = v.numberValue, n == n.rounded(), n.isFinite, n >= 0 { starts[k] = v }
            }
            if !starts.isEmpty { blend["starts"] = .object(starts) }
        }
        let id = newId()
        change("Blend") {
            let set = Set(order)
            func regroup(_ list: [VectorNode]) -> [VectorNode] {
                let members = order.map { m in list.first { $0.id == m }! }
                let top = members.compactMap { m in list.firstIndex { $0.id == m.id } }.max() ?? -1
                var out: [VectorNode] = []
                for (i, n) in list.enumerated() {
                    if i == top {
                        out.append(VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(input["name"]?.stringValue ?? "Blend")), ("blend", .object(blend))]), children: members))
                    }
                    if !set.contains(n.id) { out.append(n) }
                }
                return out
            }
            if let parent {
                setDoc(mapTree(doc.nodes) { n in
                    guard n.id == parent, n.isGroup else { return n }
                    var g = n
                    g.children = regroup(n.children)
                    return g
                })
            } else {
                setDoc(regroup(doc.nodes))
            }
            selection = [id]
            anchors = []
            editingId = nil
        }
        return id
    }

    /// Changes the spacing, steps, distance, orientation or morph of the selected (or given) blends (`setBlendOptions`).
    @discardableResult
    public func setBlendOptions(_ patch: JSONObject, ids: [String]? = nil) -> VectorActionResult {
        let groups = blendTargets(ids)
        if groups.isEmpty { return .failure("Select a blend.") }
        let clean = blendOptionsOf(patch)
        if clean.isEmpty { return .failure("No valid blend options were given.") }
        let set = Set(groups.map(\.id))
        change("Blend Options") {
            setDoc(mapTree(doc.nodes) { n in
                guard set.contains(n.id), n.isGroup, var blend = n["blend"]?.objectValue else { return n }
                for (k, v) in clean { blend[k] = v }
                var g = n
                g["blend"] = .object(blend)
                return g
            })
        }
        return .success
    }

    /// Expand (`expandBlend`): the selected (or given) blends become plain groups of their keys and
    /// steps (fresh ids). Returns their ids.
    @discardableResult
    public func expandBlend(ids: [String]? = nil) -> [String] {
        let groups = blendTargets(ids)
        if groups.isEmpty { return [] }
        let set = Set(groups.map(\.id))
        var used = Set<String>()
        walkVectorNodes(doc.nodes) { n, _, _ in used.insert(n.id) }
        func fresh() -> String {
            var id = createId()
            while used.contains(id) { id = createId() }
            used.insert(id)
            return id
        }
        change("Expand Blend") {
            setDoc(mapTree(doc.nodes) { n in set.contains(n.id) && n.isGroup ? expandVectorBlend(n, fresh) : n })
            selection = groups.map(\.id)
            anchors = []
        }
        return groups.map(\.id)
    }

    /// Release (`releaseBlend`): the selected (or given) blends are replaced by their keys (and a
    /// replaced spine as an unpainted path). Returns their ids.
    @discardableResult
    public func releaseBlend(ids: [String]? = nil) throws -> [String] {
        let groups = blendTargets(ids)
        if groups.isEmpty { return [] }
        var released: [String] = []
        try change("Release Blend") {
            for g in groups {
                let nodes = try releaseVectorBlend(g, { self.newId() })
                released += nodes.map(\.id)
                setDoc(spliceTree(doc.nodes, g.id, nodes))
            }
            selection = released
            anchors = []
        }
        return released
    }

    /**
     * Replace Spine (`replaceBlendSpine`): the selected blend's steps follow the selected path
     * instead of the straight lines between its keys. The path's first subpath becomes the spine
     * (the path is removed) and the keys move onto it, spread evenly by arc length.
     */
    @discardableResult
    public func replaceBlendSpine(ids: [String]? = nil) throws -> VectorActionResult {
        let roots = ids ?? selectedRoots()
        let groups = blendTargets(roots)
        let paths = roots.compactMap { getNode($0) }.filter { n in n.isPath && !truthy(n["blendStep"]) && !isVectorBlendGroup(locateVectorNode(doc.nodes, n.id)?.parent) }
        if groups.count != 1 || paths.count != 1 { return .failure("Select one blend and one path to be its spine.") }
        let group = groups[0]
        let path = paths[0]
        guard let first = path.subpaths.first(where: { $0.anchors.count >= 2 }) else { return .failure("The spine needs a path with at least two points.") }
        // The path's first subpath in the blend group's own space.
        let m = multiplyMatrices(worldOf(path.id), invertMatrix(worldOf(group.id)))
        let spine = try transformVectorNode(VectorNode(props: JSONObject([("id", ""), ("type", "path")]), subpaths: [first]), m).subpaths[0]
        try change("Replace Spine") {
            var withSpine = group
            var blend = group["blend"]?.objectValue ?? JSONObject()
            blend["spine"] = spine.toJSON()
            withSpine["blend"] = .object(blend)
            let targets = try vectorBlendKeyTargets(withSpine)
            var k = 0
            withSpine.children = try withSpine.children.map { c in
                if truthy(c["blendStep"]) { return c }
                let target = k < targets.count ? targets[k] : nil
                k += 1
                guard let target, let b = try vectorNodeBounds(c) else { return c }
                let dx = target[0] - (b.x + b.width / 2)
                let dy = target[1] - (b.y + b.height / 2)
                return JS.hypot(dx, dy) > 1e-9 ? try transformVectorNode(c, translateMatrix(dx, dy)) : c
            }
            setDoc(mapTree(doc.nodes) { n in n.id == path.id ? nil : n.id == group.id ? withSpine : n })
            selection = [group.id]
            anchors = []
            if editingId == path.id { editingId = nil }
        }
        return .success
    }

    // MARK: Envelopes

    /// Selected (or given) roots that can carry an envelope (`envelopeTargets`).
    private func envelopeTargets(_ ids: [String]?) -> [VectorNode] { effectTargets(ids).filter { !$0.isLocked } }

    /// Envelope parameters for `node` after `patch`: a preset switched to a mesh becomes the mesh it stood for (`envelopeParams`).
    func envelopeParams(_ node: VectorNode, _ current: JSONObject?, _ patch: JSONObject) throws -> JSONObject {
        guard patch["style"] == "mesh", patch["mesh"] == nil, let current, current["params"]?["style"] != "mesh", let id = current["id"]?.stringValue else { return patch }
        guard let frame = try vectorEnvelopeFrame(node, id) else { return patch }
        let rows = patch["rows"]?.numberValue ?? current["params"]?["rows"]?.numberValue ?? .nan
        let columns = patch["columns"]?.numberValue ?? current["params"]?["columns"]?.numberValue ?? .nan
        var out = patch
        out["mesh"] = resizeVectorMesh(frame.mesh, columns, rows).json
        return out
    }

    /**
     * Gives the selected (or given) nodes an envelope distortion, or changes the one they have
     * (`envelope`): a warp preset (`style` with `bend`, `horizontal`, `vertical` in percent and
     * `orientation`) or a mesh (`style: 'mesh'` with `rows`, `columns` and optionally `mesh`). The
     * envelope stays live (an `envelope` effect). One undo step. Returns each node's envelope.
     */
    @discardableResult
    public func envelope(_ params: JSONObject, ids: [String]? = nil) throws -> [(nodeId: String, effectId: String)] {
        let targets = envelopeTargets(ids)
        if targets.isEmpty { return [] }
        var out: [(nodeId: String, effectId: String)] = []
        var next: [String: VectorNode] = [:]
        for node in targets {
            let list = node["effects"]?.arrayValue ?? []
            if let ci = list.firstIndex(where: { $0["type"] == "envelope" }), let current = list[ci].objectValue {
                let p = try normalizeVectorEffectParams("envelope", try envelopeParams(node, current, params), current["params"]?.objectValue)!
                var rest = current
                rest["enabled"] = Optional<JSONValue>.none
                rest["params"] = .object(p)
                var effects = list
                effects[ci] = .object(rest)
                var n = node
                n["effects"] = .array(effects)
                next[node.id] = n
                out.append((node.id, current["id"]?.stringValue ?? ""))
            } else {
                var k = list.count + 1
                while list.contains(where: { $0["id"]?.stringValue == "fx\(k)" }) { k += 1 }
                let effect = try createVectorEffect("envelope", "fx\(k)", params)!
                var n = node
                n["effects"] = .array(list + [.object(effect)])
                next[node.id] = n
                out.append((node.id, "fx\(k)"))
            }
        }
        let made = out.contains { o in !(targets.first { $0.id == o.nodeId }?["effects"]?.arrayValue?.contains { $0["id"]?.stringValue == o.effectId } ?? false) }
        try change(made ? (params["style"] == "mesh" ? "Make Envelope with Mesh" : "Make Envelope with Warp") : "Edit Envelope") {
            try setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 })
        }
        return out
    }

    /**
     * Make with Top Object (`makeEnvelopeWithTopObject`): the topmost selected object's outline (a
     * closed path) becomes the envelope of the other selected objects (grouped when there are
     * several; they must share a parent), as a mesh of `columns × rows` patches whose border follows
     * the outline. The top object is used up. One undo step; returns the enveloped node's id.
     */
    public func makeEnvelopeWithTopObject(ids idsIn: [String]? = nil, rows: Double? = nil, columns: Double? = nil) throws -> (result: VectorActionResult, nodeId: String?) {
        func fail(_ m: String) -> (result: VectorActionResult, nodeId: String?) { (.failure(m), nil) }
        let ids = idsIn ?? selectedRoots()
        if ids.count < 2 { return fail("Select the objects and, on top of them, the shape to use as the envelope.") }
        var order: [String: Int] = [:]
        walkVectorNodes(doc.nodes) { n, _, _ in order[n.id] = order.count }
        let sorted = jsSorted(ids.filter { order[$0] != nil }) { Double(order[$0]! - order[$1]!) }
        guard let topId = sorted.last, let top = getNode(topId), top.isPath, let outline = top.subpaths.first(where: { $0.closed && $0.anchors.count > 1 }) else {
            return fail("The top object must be a path with a closed outline.")
        }
        let contents = sorted.dropLast().map { getNode($0)! }
        if contents.contains(where: \.isLocked) { return fail("Locked objects cannot be enveloped.") }
        let parents = contents.map { locateVectorNode(doc.nodes, $0.id)?.parent?.id }
        if parents.contains(where: { $0 != parents[0] }) { return fail("The objects to envelope must be in the same group.") }
        // The node that gets the envelope: the one object, or a new group of them in place of the topmost.
        let target = contents.count == 1 ? contents[0] : VectorNode(props: JSONObject([("id", .string(newId())), ("type", "group"), ("name", "Envelope")]), children: Array(contents))
        let parentToDoc = parents[0].map { worldOf($0) } ?? IDENTITY_MATRIX
        let targetToDoc = multiplyMatrices(nodeMatrix(target), parentToDoc)
        let toLocal = multiplyMatrices(worldOf(topId), invertMatrix(targetToDoc))
        let local = VectorSubpath(closed: true, anchors: outline.anchors.map { a in
            let p = applyMatrix(toLocal, Vec2(a.x, a.y))
            return VectorAnchor(x: p.x, y: p.y, in: a.in.map { applyMatrix(toLocal, $0) }, out: a.out.map { applyMatrix(toLocal, $0) })
        })
        guard let mesh = vectorMeshFromOutline(local, columns ?? 4, rows ?? 4) else { return fail("The top object’s outline is too small to use as an envelope.") }
        let list = target["effects"]?.arrayValue ?? []
        var k = list.count + 1
        while list.contains(where: { $0["id"]?.stringValue == "fx\(k)" }) { k += 1 }
        let effect = try createVectorEffect("envelope", "fx\(k)", JSONObject([("style", "mesh"), ("mesh", mesh.json)]))!
        var enveloped = target
        enveloped["effects"] = .array(list + [.object(effect)])
        change("Make Envelope with Top Object") {
            var nodes = spliceTree(doc.nodes, topId, [])
            if contents.count == 1 {
                nodes = spliceTree(nodes, target.id, [enveloped])
            } else {
                for n in contents.dropLast() { nodes = spliceTree(nodes, n.id, []) }
                nodes = spliceTree(nodes, contents[contents.count - 1].id, [enveloped])
            }
            setDoc(nodes)
            selection = [target.id]
            anchors = []
            editingId = nil
        }
        return (.success, target.id)
    }

    /// Release (`releaseEnvelope`): the selected (or given) nodes lose their envelope, and its shape
    /// (the mesh's border) comes back as a path above each of them. Returns the new paths' ids.
    @discardableResult
    public func releaseEnvelope(ids: [String]? = nil) throws -> [String] {
        let targets = envelopeTargets(ids).filter { $0["effects"]?.arrayValue?.contains { $0["type"] == "envelope" } == true }
        if targets.isEmpty { return [] }
        var created: [String] = []
        var replace: [(String, [VectorNode])] = []
        for node in targets {
            let list = node["effects"]!.arrayValue!
            let i = list.firstIndex { $0["type"] == "envelope" }!
            let frame = try vectorEnvelopeFrame(node, list[i]["id"]?.stringValue)
            var kept = node
            var rest = list
            rest.remove(at: i)
            kept["effects"] = Optional<JSONValue>.none
            if !rest.isEmpty { kept["effects"] = .array(rest) }
            guard let frame else {
                replace.append((node.id, [kept]))
                continue
            }
            let id = newId()
            created.append(id)
            var props = JSONObject([("id", .string(id)), ("type", "path"), ("name", "Envelope")])
            if truthy(node["transform"]) { props["transform"] = node["transform"] }
            props["subpaths"] = .null
            props["fill"] = .null
            props["stroke"] = "#808080"
            props["strokeWidth"] = 1
            replace.append((node.id, [kept, VectorNode(props: props, subpaths: [vectorMeshOutline(frame.mesh)])]))
        }
        change("Release Envelope") {
            var nodes = doc.nodes
            for (id, list) in replace { nodes = spliceTree(nodes, id, list) }
            setDoc(nodes)
            selection = targets.map(\.id) + created
            anchors = []
        }
        return created
    }

    // MARK: Symmetry

    /**
     * Make Symmetry (`makeSymmetry`): puts objects that share a parent (default: the selection) into
     * a live symmetry group that draws them with their mirrored or rotated copies, the axes through
     * `center` (default: the objects' centre, or the artboard's when there are none, making an empty
     * group to draw into). `input` holds `mode`, `center`, `rotation`, `copies`, `mirror` and `name`.
     * One undo step; selects the group (and enters it when empty).
     */
    public func makeSymmetry(_ input: JSONObject, ids idsIn: [String]? = nil) throws -> VectorMaskResult {
        func fail(_ m: String) -> VectorMaskResult { VectorMaskResult(ok: false, id: nil, message: m) }
        var raw = input
        if raw["center"] == nil { raw["center"] = Vec2(0, 0).json }
        guard let symmetry = sanitizeVectorSymmetry(.object(raw)) else { return fail("Unknown symmetry \"\(input["mode"]?.stringValue ?? "undefined")\": use \(VECTOR_SYMMETRY_MODES.joined(separator: ", ")).") }
        if let copies = input["copies"], !((copies.numberValue ?? .nan) >= 2 && (copies.numberValue ?? .nan) <= 64) { return fail("copies must be from 2 to 64.") }
        var ids: [String] = []
        for id in idsIn ?? selectedRoots() where !ids.contains(id) { ids.append(id) }
        for id in ids {
            guard let n = getNode(id) else { return fail("There is no node \"\(id)\".") }
            if n.isLocked { return fail("\"\(id)\" is locked; unlock it first.") }
        }
        let locs = ids.map { locateVectorNode(doc.nodes, $0)! }
        let parent = locs.first?.parent
        if locs.contains(where: { $0.parent?.id != parent?.id }) { return fail("The objects must share a parent (pick objects at one level).") }
        let b = unionBounds(try ids.map { try vectorNodeBounds(getNode($0)!) })
        let center = Vec2(json: input["center"]) ?? b.map { Vec2($0.x + $0.width / 2, $0.y + $0.height / 2) } ?? Vec2(doc.width / 2, doc.height / 2)
        let id = newId()
        var settings = symmetry
        settings["center"] = center.json
        let props = JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(input["name"]?.stringValue ?? "Symmetry")), ("symmetry", .object(settings))])
        let order = jsSorted(ids) { a, c in Double(locs[ids.firstIndex(of: a)!].index - locs[ids.firstIndex(of: c)!].index) }
        let set = Set(order)
        change("Make Symmetry") {
            if order.isEmpty {
                setDoc(doc.nodes + [VectorNode(props: props, children: [])])
            } else {
                func regroup(_ list: [VectorNode]) -> [VectorNode] {
                    let members = order.map { m in list.first { $0.id == m }! }
                    let top = members.compactMap { m in list.firstIndex { $0.id == m.id } }.max() ?? -1
                    var out: [VectorNode] = []
                    for (i, n) in list.enumerated() {
                        if i == top { out.append(VectorNode(props: props, children: members)) }
                        if !set.contains(n.id) { out.append(n) }
                    }
                    return out
                }
                if let parent {
                    setDoc(mapTree(doc.nodes) { n in
                        guard n.id == parent.id, n.isGroup else { return n }
                        var g = n
                        g.children = regroup(n.children)
                        return g
                    })
                } else {
                    setDoc(regroup(doc.nodes))
                }
            }
            selection = [id]
            anchors = []
            editingId = nil
            if order.isEmpty && parent == nil { symmetryTarget = id }
        }
        return VectorMaskResult(ok: true, id: id, message: nil)
    }

    /// Symmetry groups among `ids` (default: the selection, or the group holding it; `symmetryTargets`).
    func symmetryTargets(_ ids: [String]?) -> [VectorNode] {
        var out = OrderedPaths()
        for id in ids ?? selection {
            if let n = getNode(id), isVectorSymmetryGroup(n) { out.set(n) }
            else if ids == nil, let p = locateVectorNode(doc.nodes, id)?.parent, isVectorSymmetryGroup(p) { out.set(p) }
        }
        return out.values
    }

    /// Changes symmetry groups (`setSymmetry`; default: the selected one, or the one holding the
    /// selection): mode, centre (the group's space), rotation, radial copies and mirroring. One undo step.
    @discardableResult
    public func setSymmetry(_ patch: JSONObject, ids: [String]? = nil) -> VectorActionResult {
        if let ids { for id in ids where !isVectorSymmetryGroup(getNode(id)) { return .failure("\"\(id)\" is not a symmetry group (make one with vector.makeSymmetry).") } }
        let groups = symmetryTargets(ids)
        if groups.isEmpty { return .failure("Select a symmetry group (or something in one).") }
        if let mode = patch["mode"], !VECTOR_SYMMETRY_MODES.contains(mode.stringValue ?? "") { return .failure("Unknown symmetry \"\(mode.stringValue ?? mode.stringified())\": use \(VECTOR_SYMMETRY_MODES.joined(separator: ", ")).") }
        if let copies = patch["copies"], !((copies.numberValue ?? .nan) >= 2 && (copies.numberValue ?? .nan) <= 64) { return .failure("copies must be from 2 to 64.") }
        var next: [String: JSONObject] = [:]
        for g in groups {
            var merged = g["symmetry"]?.objectValue ?? JSONObject()
            for (k, v) in patch { merged[k] = v }
            guard let s = sanitizeVectorSymmetry(.object(merged)) else { return .failure("center must be { x, y } numbers.") }
            next[g.id] = s
        }
        change("Symmetry") {
            setDoc(mapTree(doc.nodes) { n in
                guard let s = next[n.id], n.isGroup else { return n }
                var g = n
                g["symmetry"] = .object(s)
                return g
            })
        }
        return .success
    }

    /**
     * Release Symmetry (`releaseSymmetry`): the groups stop repeating their children. With `expand`,
     * the copies become real objects in the group (new ids); otherwise they go. One undo step.
     * Returns the ids of the objects expanding added.
     */
    public func releaseSymmetry(ids: [String]? = nil, expand: Bool = false) throws -> VectorSymmetryReleaseResult {
        let groups = symmetryTargets(ids)
        if groups.isEmpty { return VectorSymmetryReleaseResult(result: .failure("Select a symmetry group (or something in one)."), ids: []) }
        var added: [String] = []
        var next: [String: VectorNode] = [:]
        for g in groups {
            var rest = g
            rest["symmetry"] = Optional<JSONValue>.none
            if !expand {
                next[g.id] = rest
                continue
            }
            let drawn = try vectorSymmetryDrawn(g)
            func fresh(_ n: VectorNode) -> VectorNode {
                let id = newId()
                added.append(id)
                var plain = n
                plain["locked"] = Optional<JSONValue>.none
                plain.id = id
                if plain.isGroup { plain.children = plain.children.map(fresh) }
                return plain
            }
            rest.children = g.children + drawn.children.dropFirst(g.children.count).map(fresh)
            next[g.id] = rest
        }
        change(expand ? "Expand Symmetry" : "Release Symmetry") {
            setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 })
            if let t = symmetryTarget, next[t] != nil { symmetryTarget = nil }
        }
        return VectorSymmetryReleaseResult(result: .success, ids: added.filter { getNode($0) != nil })
    }

    /// Enters a top-level symmetry group (`enterSymmetry`): new drawn art goes into it until `exitSymmetry`.
    @discardableResult
    public func enterSymmetry(_ id: String) -> VectorActionResult {
        guard let n = doc.nodes.first(where: { $0.id == id }), isVectorSymmetryGroup(n) else { return .failure("\"\(id)\" is not a top-level symmetry group.") }
        if truthy(n["transform"]) { return .failure("Drawing into a turned symmetry group is not supported; draw beside it and move the art in.") }
        symmetryTarget = id
        selection = [id]
        notify()
        return .success
    }

    /// Stops drawing into the entered symmetry group (`exitSymmetry`).
    public func exitSymmetry() {
        if symmetryTarget == nil { return }
        symmetryTarget = nil
        notify()
    }

    /// The symmetry group new drawn art goes into, while it is entered and still a top-level,
    /// unturned, unlocked symmetry group (`state.symmetryTarget`).
    public var enteredSymmetry: String? {
        guard let id = symmetryTarget, let n = doc.nodes.first(where: { $0.id == id }), isVectorSymmetryGroup(n), !truthy(n["transform"]), !n.isLocked else { return nil }
        return id
    }
}
