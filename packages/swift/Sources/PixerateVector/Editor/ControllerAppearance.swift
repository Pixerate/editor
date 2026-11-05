import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Gradients, fill and stroke stacks, blend modes, filters, path effects, Expand Appearance,
// masks and lenses of `VectorEditorController` (`vector/controller.ts`). The TS `merge` option
// (consecutive edits folded into one undo step while a slider drags) is not ported: every call
// is its own step.

/// What `makeMask` returns: the new group's id, or why it could not (`VectorMaskResult`).
public struct VectorMaskResult: Equatable, Sendable {
    public var ok: Bool
    public var id: String?
    public var message: String?
}

/// A node's place and state (transform, visibility, lock, operand operation), for a node taking its place (`placementOf`).
private func placementOf(_ n: VectorNode, into node: inout VectorNode) {
    if truthy(n["transform"]) { node["transform"] = n["transform"] }
    if !n.isVisible { node["visible"] = false }
    if n.isLocked { node["locked"] = true }
    if truthy(n["booleanOperation"]) { node["booleanOperation"] = n["booleanOperation"] }
}

extension VectorEditorController {
    // MARK: Gradients

    /// Unlocked paths of `ids` (default: the selection), each once, in first-seen order (`gradientPaths`).
    private func gradientPaths(_ ids: [String]) -> [VectorNode] {
        var out = OrderedPaths()
        for id in ids {
            guard let node = getNode(id), !node.isLocked else { continue }
            for p in collectPathNodes(node) where !p.isLocked { out.set(p) }
        }
        return out.values
    }

    /**
     * Edits the gradient of the `target` paint (`fill` or `stroke`) of the selected (or given)
     * paths with `patch` (`setGradient`): a colour or no paint becomes a gradient (`patch.type`,
     * default linear, from the colour to white). `layer` picks a layer of the stack (default: the
     * shorthand, its top layer). One undo step.
     */
    @discardableResult
    public func setGradient(_ patch: JSONObject, ids: [String]? = nil, target: String = "fill", layer: Int? = nil, label: String? = nil) -> VectorActionResult {
        let paths = gradientPaths(ids ?? selection)
        if paths.isEmpty { return .failure("Nothing is selected.") }
        var next: [String: VectorNode] = [:]
        for path in paths {
            let paint = vectorTargetPaint(path, target, layer)
            let base = isVectorGradient(paint) ? paint!.objectValue! : defaultVectorGradient(patch["type"]?.stringValue ?? "linear", paint)
            guard let g = applyVectorGradientPatch(base, patch) else {
                return .failure("That is not a valid gradient: it needs at least one stop with an offset and a colour.")
            }
            next[path.id] = withVectorTargetPaint(path, target, layer, .object(g))
        }
        change(label ?? "Gradient") { setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 }) }
        return .success
    }

    // MARK: Fill and stroke stacks

    /// Paths (and text) of the selected (or given) nodes whose stacks can be edited (`stackTargets`).
    func stackTargets(_ ids: [String]?) -> Result<[VectorNode], VectorEditorError> {
        let list = ids ?? selection
        if list.isEmpty { return .failure(VectorEditorError("Nothing is selected.")) }
        var out = OrderedPaths()
        for id in list {
            guard let node = getNode(id) else { return .failure(VectorEditorError("There is no node \"\(id)\".")) }
            for p in collectPaintedNodes(node) where !truthy(p["blendStep"]) { out.set(p) }
        }
        if out.values.isEmpty { return .failure(VectorEditorError("The selection has no paths or text (fills and strokes belong to them).")) }
        return .success(out.values)
    }

    /// Applies `fn` to the `kind` stack of every target path as one undo step; an error string from
    /// any path cancels it (`editStacks`).
    func editStacks(_ kind: String, _ ids: [String]?, _ label: String, _ fn: ([JSONObject], VectorNode) throws -> Result<[JSONObject], VectorEditorError>) throws -> VectorActionResult {
        let targets: [VectorNode]
        switch stackTargets(ids) {
        case .failure(let e): return .failure(e.message)
        case .success(let t): targets = t
        }
        var next: [String: VectorNode] = [:]
        for path in targets {
            let stack = kind == "fill" ? vectorFills(path) : vectorStrokes(path)
            switch try fn(stack, path) {
            case .failure(let e): return .failure(e.message)
            case .success(let result): next[path.id] = kind == "fill" ? withVectorFills(path, result) : withVectorStrokes(path, result)
            }
        }
        change(label) { setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 }) }
        return .success
    }

    /// A layer patch from untrusted input (`layerPatch`): paint, opacity, blend mode, visibility and
    /// (strokes) the stroke settings, where `null` removes a setting.
    private func layerPatch(_ kind: String, _ patch: JSONObject) throws -> Result<(set: JSONObject, unset: [String]), VectorEditorError> {
        var set = JSONObject()
        var unset: [String] = []
        func bad(_ m: String) -> Result<(set: JSONObject, unset: [String]), VectorEditorError> { .failure(VectorEditorError(m)) }
        if let paint = patch["paint"] {
            if paint == .null { set["paint"] = .null }
            else if let s = paint.stringValue, !s.jsTrimmed.isEmpty { set["paint"] = .string(s.jsTrimmed) }
            else {
                guard let g = sanitizeVectorGradient(paint) else { return bad("paint must be a CSS colour, a gradient { type, stops: [{ offset, color }] } or null.") }
                set["paint"] = .object(g)
            }
        }
        if let v = patch["opacity"] {
            guard let o = v.numberValue, o.isFinite else { return bad("opacity must be a number from 0 to 1.") }
            let c = JS.min(1, JS.max(0, o))
            if c < 1 { set["opacity"] = .number(c) } else { unset.append("opacity") }
        }
        if let v = patch["blendMode"] {
            if !isVectorBlendMode(v) { return bad("Unknown blend mode \"\(v.stringValue ?? v.stringified())\". Use one of: \(VECTOR_BLEND_MODES.joined(separator: ", ")).") }
            if v != "normal" { set["blendMode"] = v } else { unset.append("blendMode") }
        }
        if let v = patch["visible"] {
            guard let b = v.boolValue else { return bad("visible must be true or false.") }
            if b { unset.append("visible") } else { set["visible"] = false }
        }
        if kind == "stroke" {
            let settings = try sanitizeVectorStrokeSettings(patch)
            for key in VECTOR_STROKE_SETTING_KEYS {
                guard let v = patch[key] else { continue }
                if v == .null || (key == "strokeDasharray" && v.arrayValue?.isEmpty == true) { unset.append(key) }
                else if let s = settings[key] { set[key] = s }
                else { return bad("Invalid \(key): \(v.stringified()).") }
            }
        }
        return .success((set, unset))
    }

    /// Adds a fill or stroke layer to the selected (or given) paths (groups: every path inside), at
    /// the top of the stack or at `index` (0 is the bottom). A new stroke takes the settings of the
    /// stack's top stroke unless `layer` gives them. One undo step (`addPaintLayer`).
    @discardableResult
    public func addPaintLayer(_ kind: String, _ layer: JSONObject = JSONObject(), ids: [String]? = nil, index: Double? = nil) throws -> VectorActionResult {
        let patch: (set: JSONObject, unset: [String])
        switch try layerPatch(kind, layer) {
        case .failure(let e): return .failure(e.message)
        case .success(let p): patch = p
        }
        return try editStacks(kind, ids, kind == "fill" ? "Add Fill" : "Add Stroke") { stack, path in
            var added = kind == "fill" ? JSONObject([("paint", "#808080")]) : newVectorStrokeLayer(path)
            for (k, v) in patch.set { added[k] = v }
            for key in patch.unset { added[key] = Optional<JSONValue>.none }
            let at = index.map { Int(JS.min(Double(stack.count), JS.max(0, JS.round($0)))) } ?? stack.count
            var out = stack
            out.insert(added, at: at)
            return .success(out)
        }
    }

    /// Changes layer `index` (0 is the bottom) of the fill or stroke stack of the selected (or
    /// given) paths (`updatePaintLayer`). Fails, changing nothing, when a path has no layer `index`.
    @discardableResult
    public func updatePaintLayer(_ kind: String, _ index: Int, _ patch: JSONObject, ids: [String]? = nil) throws -> VectorActionResult {
        let parsed: (set: JSONObject, unset: [String])
        switch try layerPatch(kind, patch) {
        case .failure(let e): return .failure(e.message)
        case .success(let p): parsed = p
        }
        return try editStacks(kind, ids, kind == "fill" ? "Edit Fill" : "Edit Stroke") { stack, path in
            guard stack.indices.contains(index) else { return .failure(VectorEditorError("Path \"\(path.id)\" has no \(kind) \(index) (it has \(stack.count); 0 is the bottom).")) }
            var layer = stack[index]
            for (k, v) in parsed.set { layer[k] = v }
            for key in parsed.unset { layer[key] = Optional<JSONValue>.none }
            var out = stack
            out[index] = layer
            return .success(out)
        }
    }

    /// Removes layer `index` of the fill or stroke stack of the selected (or given) paths (`removePaintLayer`).
    @discardableResult
    public func removePaintLayer(_ kind: String, _ index: Int, ids: [String]? = nil) throws -> VectorActionResult {
        try editStacks(kind, ids, kind == "fill" ? "Remove Fill" : "Remove Stroke") { stack, path in
            guard stack.indices.contains(index) else { return .failure(VectorEditorError("Path \"\(path.id)\" has no \(kind) \(index) (it has \(stack.count); 0 is the bottom).")) }
            var out = stack
            out.remove(at: index)
            return .success(out)
        }
    }

    /// Moves layer `from` of the fill or stroke stack to position `to` (0 is the bottom) (`movePaintLayer`).
    @discardableResult
    public func movePaintLayer(_ kind: String, _ from: Int, _ to: Double, ids: [String]? = nil) throws -> VectorActionResult {
        try editStacks(kind, ids, kind == "fill" ? "Reorder Fills" : "Reorder Strokes") { stack, path in
            guard stack.indices.contains(from) else { return .failure(VectorEditorError("Path \"\(path.id)\" has no \(kind) \(from) (it has \(stack.count); 0 is the bottom).")) }
            var out = stack
            let layer = out.remove(at: from)
            out.insert(layer, at: Int(JS.min(Double(out.count), JS.max(0, JS.round(to)))))
            return .success(out)
        }
    }

    /// Replaces the whole fill or stroke stack of the selected (or given) paths (malformed layers dropped; `setPaintLayers`).
    @discardableResult
    public func setPaintLayers(_ kind: String, _ layers: [JSONValue], ids: [String]? = nil) throws -> VectorActionResult {
        let clean = kind == "fill" ? try sanitizeVectorFills(.array(layers)) : try sanitizeVectorStrokes(.array(layers))
        return try editStacks(kind, ids, kind == "fill" ? "Set Fills" : "Set Strokes") { _, _ in .success(clean) }
    }

    // MARK: Blend modes and filters

    /// Sets the blend mode of the selected (or given) nodes; `normal` removes it (`setBlendMode`).
    @discardableResult
    public func setBlendMode(_ mode: String, ids: [String]? = nil) -> VectorActionResult {
        if !VECTOR_BLEND_MODES.contains(mode) { return .failure("Unknown blend mode \"\(mode)\". Use one of: \(VECTOR_BLEND_MODES.joined(separator: ", ")).") }
        let list = ids ?? selectedRoots()
        if list.isEmpty { return .failure("Nothing is selected.") }
        for id in list where getNode(id) == nil { return .failure("There is no node \"\(id)\".") }
        let set = Set(list)
        change("Blend Mode") {
            setDoc(mapTree(doc.nodes) { n in
                if !set.contains(n.id) || (n["blendMode"]?.stringValue ?? "normal") == mode { return n }
                var rest = n
                rest["blendMode"] = Optional<JSONValue>.none
                if mode != "normal" { rest["blendMode"] = .string(mode) }
                return rest
            })
        }
        return .success
    }

    /// Selected (or given) nodes that can carry effects and filters: the roots of the selection, blend steps left out (`effectTargets`).
    func effectTargets(_ ids: [String]?) -> [VectorNode] {
        (ids ?? selectedRoots()).compactMap { getNode($0) }.filter { !truthy($0["blendStep"]) }
    }

    /// Adds a filter of `type` to the selected (or given) nodes, at the end of each stack (or at
    /// `index`), defaults merged with `params`. One undo step; returns the new filter ids (`addFilter`).
    @discardableResult
    public func addFilter(_ type: String, ids: [String]? = nil, params: JSONObject? = nil, index: Double? = nil) -> [String] {
        if !VECTOR_FILTER_TYPES.contains(type) { return [] }
        let targets = effectTargets(ids)
        if targets.isEmpty { return [] }
        var created: [String] = []
        var next: [String: VectorNode] = [:]
        for node in targets {
            let list = node["filters"]?.arrayValue ?? []
            var k = list.count + 1
            while list.contains(where: { $0["id"]?.stringValue == "filter\(k)" }) { k += 1 }
            let filter = createVectorFilter(type, "filter\(k)", params)!
            let at = index.map { Int(JS.min(Double(list.count), JS.max(0, JS.round($0)))) } ?? list.count
            var filters = list
            filters.insert(.object(filter), at: at)
            var n = node
            n["filters"] = .array(filters)
            next[node.id] = n
            created.append("filter\(k)")
        }
        change("Add \(VECTOR_FILTER_LABELS[type]!)") { setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 }) }
        return created
    }

    private func editFilters(_ nodeId: String, _ label: String, _ fn: ([JSONValue]) -> Result<[JSONValue], VectorEditorError>) throws -> VectorActionResult {
        guard var node = getNode(nodeId) else { return .failure("There is no node \"\(nodeId)\".") }
        switch fn(node["filters"]?.arrayValue ?? []) {
        case .failure(let e): return .failure(e.message)
        case .success(let result):
            node["filters"] = result.isEmpty ? Optional<JSONValue>.none : .array(result)
            try change(label) { try replaceNode(nodeId, node) }
            return .success
        }
    }

    /// Turns a filter on or off and changes its parameters (invalid values ignored; `updateFilter`).
    @discardableResult
    public func updateFilter(_ nodeId: String, _ filterId: String, params: JSONObject? = nil, enabled: Bool? = nil) throws -> VectorActionResult {
        let current = getNode(nodeId)?["filters"]?.arrayValue?.first { $0["id"]?.stringValue == filterId }
        let label = "Edit \(current?["type"]?.stringValue.flatMap { VECTOR_FILTER_LABELS[$0] } ?? "Filter")"
        return try editFilters(nodeId, label) { list in
            guard let i = list.firstIndex(where: { $0["id"]?.stringValue == filterId }), var f = list[i].objectValue else {
                return .failure(VectorEditorError("Node \"\(nodeId)\" has no filter \"\(filterId)\"."))
            }
            if let params { f["params"] = normalizeVectorFilterParams(f["type"]?.stringValue ?? "", params, f["params"]?.objectValue).map { .object($0) } ?? .null }
            if let enabled { f["enabled"] = .bool(enabled) }
            if f["enabled"] != .bool(false) { f["enabled"] = Optional<JSONValue>.none }
            var out = list
            out[i] = .object(f)
            return .success(out)
        }
    }

    /// Removes a filter from a node's stack (`removeFilter`).
    @discardableResult
    public func removeFilter(_ nodeId: String, _ filterId: String) throws -> VectorActionResult {
        try editFilters(nodeId, "Remove Filter") { list in
            list.contains { $0["id"]?.stringValue == filterId } ? .success(list.filter { $0["id"]?.stringValue != filterId }) : .failure(VectorEditorError("Node \"\(nodeId)\" has no filter \"\(filterId)\"."))
        }
    }

    /// Moves a filter to position `index` of its node's stack (`moveFilter`).
    @discardableResult
    public func moveFilter(_ nodeId: String, _ filterId: String, _ index: Double) throws -> VectorActionResult {
        try editFilters(nodeId, "Reorder Filters") { list in
            guard let i = list.firstIndex(where: { $0["id"]?.stringValue == filterId }) else { return .failure(VectorEditorError("Node \"\(nodeId)\" has no filter \"\(filterId)\".")) }
            var out = list
            let f = out.remove(at: i)
            out.insert(f, at: Int(JS.min(Double(out.count), JS.max(0, JS.round(index)))))
            return .success(out)
        }
    }

    // MARK: Path effects

    /// Adds an effect of `type` to the selected (or given) nodes, at the bottom of each stack (or at
    /// `index`), defaults merged with `params`. A repeater's copies start one shape width apart.
    /// One undo step; returns the new effect ids (`addEffect`).
    @discardableResult
    public func addEffect(_ type: String, ids: [String]? = nil, params: JSONObject? = nil, index: Double? = nil) throws -> [String] {
        let targets = effectTargets(ids)
        if targets.isEmpty || VECTOR_EFFECT_DEFAULTS[type] == nil { return [] }
        var created: [String] = []
        var next: [String: VectorNode] = [:]
        for node in targets {
            let list = node["effects"]?.arrayValue ?? []
            var k = list.count + 1
            while list.contains(where: { $0["id"]?.stringValue == "fx\(k)" }) { k += 1 }
            var p = params ?? JSONObject()
            if type == "repeater" && p["position"] == nil {
                if let b = bezierPathBounds(.commands(try vectorAppearanceOutline(node))), b.maxX - b.minX > 0 {
                    p["position"] = Vec2(JS.round((b.maxX - b.minX) * 1.25 * 100) / 100, 0).json
                }
            }
            guard let effect = try createVectorEffect(type, "fx\(k)", p) else { return [] }
            let at = index.map { Int(JS.min(Double(list.count), JS.max(0, JS.round($0)))) } ?? list.count
            var effects = list
            effects.insert(.object(effect), at: at)
            var n = node
            n["effects"] = .array(effects)
            next[node.id] = n
            created.append("fx\(k)")
        }
        try change("Add \(VECTOR_EFFECT_LABELS[type]!)") { try setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 }) }
        return created
    }

    private func editEffects(_ nodeId: String, _ label: String, _ fn: (VectorNode, [JSONValue]) throws -> Result<[JSONValue], VectorEditorError>) throws -> VectorActionResult {
        guard var node = getNode(nodeId) else { return .failure("There is no node \"\(nodeId)\".") }
        switch try fn(node, node["effects"]?.arrayValue ?? []) {
        case .failure(let e): return .failure(e.message)
        case .success(let result):
            node["effects"] = result.isEmpty ? Optional<JSONValue>.none : .array(result)
            try change(label) { try replaceNode(nodeId, node) }
            return .success
        }
    }

    /// Turns an effect on or off and changes its parameters (`updateEffect`). Unknown or invalid
    /// values are ignored; an envelope preset switched to `mesh` becomes the mesh it stood for.
    @discardableResult
    public func updateEffect(_ nodeId: String, _ effectId: String, params: JSONObject? = nil, enabled: Bool? = nil) throws -> VectorActionResult {
        let current = getNode(nodeId)?["effects"]?.arrayValue?.first { $0["id"]?.stringValue == effectId }
        let label = current?["type"]?.stringValue.flatMap { VECTOR_EFFECT_LABELS[$0] } ?? "Effect"
        return try editEffects(nodeId, "Edit \(label)") { node, list in
            guard let i = list.firstIndex(where: { $0["id"]?.stringValue == effectId }), var e = list[i].objectValue else {
                return .failure(VectorEditorError("Node \"\(nodeId)\" has no effect \"\(effectId)\"."))
            }
            let type = e["type"]?.stringValue ?? ""
            if let params {
                // A preset switched to a mesh becomes the mesh it stood for.
                let raw = type == "envelope" ? try envelopeParams(node, e, params) : params
                e["params"] = try normalizeVectorEffectParams(type, raw, e["params"]?.objectValue).map { .object($0) } ?? .null
            }
            if let enabled { e["enabled"] = .bool(enabled) }
            if e["enabled"] != .bool(false) { e["enabled"] = Optional<JSONValue>.none }
            var out = list
            out[i] = .object(e)
            return .success(out)
        }
    }

    /// Removes an effect from a node's stack (`removeEffect`).
    @discardableResult
    public func removeEffect(_ nodeId: String, _ effectId: String) throws -> VectorActionResult {
        try editEffects(nodeId, "Remove Effect") { _, list in
            list.contains { $0["id"]?.stringValue == effectId } ? .success(list.filter { $0["id"]?.stringValue != effectId }) : .failure(VectorEditorError("Node \"\(nodeId)\" has no effect \"\(effectId)\"."))
        }
    }

    /// Moves an effect to position `index` of its stack (0 is applied first; `moveEffect`).
    @discardableResult
    public func moveEffect(_ nodeId: String, _ effectId: String, _ index: Double) throws -> VectorActionResult {
        try editEffects(nodeId, "Reorder Effects") { _, list in
            guard let i = list.firstIndex(where: { $0["id"]?.stringValue == effectId }) else { return .failure(VectorEditorError("Node \"\(nodeId)\" has no effect \"\(effectId)\".")) }
            let to = Int(JS.min(Double(list.count - 1), JS.max(0, JS.round(index))))
            var out = list
            let e = out.remove(at: i)
            out.insert(e, at: to)
            return .success(out)
        }
    }

    /**
     * Expand Appearance (`expandAppearance`): bakes the path effects and live booleans of the
     * selected (or given) nodes, and of everything inside them, into plain paths. A node keeps its
     * id (a group when it draws as several shapes); the shapes it made get new ids. Returns the
     * ids of the expanded nodes (empty when none was live).
     */
    @discardableResult
    public func expandAppearance(ids: [String]? = nil) throws -> [String] {
        let roots = (ids ?? selectedRoots()).compactMap { getNode($0) }.filter(hasVectorAppearance)
        if roots.isEmpty { return [] }
        func fresh(_ n: VectorNode) -> VectorNode {
            var c = n
            if n.id.contains("~fx") { c.id = newId() }
            if n.isGroup { c.children = n.children.map(fresh) }
            return c
        }
        func bake(_ n: VectorNode) throws -> VectorNode {
            if !hasVectorAppearance(n) { return n }
            if !hasOwnVectorAppearance(n) {
                var g = n
                g.children = try n.children.map(bake)
                return g
            }
            var e = try expandVectorAppearance(n)
            // A live group that draws as one shape becomes that path, in the group's place.
            if e.isGroup && e.children.count == 1 && e.children[0].isPath {
                let only = e.children[0]
                var child = only
                child["id"] = Optional<JSONValue>.none
                child["opacity"] = Optional<JSONValue>.none
                child["name"] = Optional<JSONValue>.none
                let k = (e.opacity ?? 1) * (only.opacity ?? 1)
                child.id = e.id
                if let name = e["name"] ?? only["name"] { child["name"] = name }
                placementOf(e, into: &child)
                if k < 1 { child.opacity = k }
                e = child
            }
            return fresh(e)
        }
        var next: [String: VectorNode] = [:]
        for n in roots { next[n.id] = try bake(n) }
        change("Expand Appearance") {
            setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 })
            anchors = []
            editingId = nil
        }
        return roots.map(\.id)
    }

    // MARK: Masks

    /**
     * Make Clipping Mask (`clip`) / Make Opacity Mask (`alpha`, `luminance`; `makeMask`): groups the
     * selected (or given) objects into a mask group whose mask is the topmost of them (or
     * `maskId`), moved to the bottom of the group. They must be two or more, unlocked, with one
     * parent. One undo step.
     */
    public func makeMask(_ type: String, ids: [String]? = nil, maskId: String? = nil, invert: Bool = false, name: String? = nil) -> VectorMaskResult {
        func fail(_ m: String) -> VectorMaskResult { VectorMaskResult(ok: false, id: nil, message: m) }
        if !VECTOR_MASK_TYPES.contains(type) { return fail("Unknown mask type \"\(type)\": use clip, alpha or luminance.") }
        var list: [String] = []
        for id in ids ?? selectedRoots() where !list.contains(id) { list.append(id) }
        if list.count < 2 { return fail("Select at least two objects: the topmost becomes the mask, the ones below show through it.") }
        for id in list {
            guard let n = getNode(id) else { return fail("There is no node \"\(id)\".") }
            if n.isLocked { return fail("\"\(id)\" is locked; unlock it first.") }
            if truthy(n["blendStep"]) { return fail("\"\(id)\" is a blend step; select its blend instead.") }
        }
        let locs = list.map { locateVectorNode(doc.nodes, $0)! }
        let parent = locs[0].parent?.id
        if locs.contains(where: { $0.parent?.id != parent }) { return fail("The objects must share a parent (group them, or pick objects at one level).") }
        let order = jsSorted(list) { a, b in Double(locs[list.firstIndex(of: a)!].index - locs[list.firstIndex(of: b)!].index) }
        let mask = maskId ?? order[order.count - 1]
        if !order.contains(mask) { return fail("The mask \"\(mask)\" must be one of the objects (\(order.map { "\"\($0)\"" }.joined(separator: ", "))).") }
        let id = newId()
        let settings: JSONValue = invert ? .object(JSONObject([("type", .string(type)), ("invert", true)])) : .object(JSONObject([("type", .string(type))]))
        change(type == "clip" ? "Make Clipping Mask" : "Make Opacity Mask") {
            let set = Set(order)
            func regroup(_ nodes: [VectorNode]) -> [VectorNode] {
                let members = order.map { m in nodes.first { $0.id == m }! }
                let top = members.compactMap { m in nodes.firstIndex { $0.id == m.id } }.max() ?? -1
                let children = [members.first { $0.id == mask }!] + members.filter { $0.id != mask }
                var out: [VectorNode] = []
                for (i, n) in nodes.enumerated() {
                    if i == top {
                        out.append(VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(name ?? (type == "clip" ? "Clip Group" : "Opacity Mask"))), ("mask", settings)]), children: children))
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
        return VectorMaskResult(ok: true, id: id, message: nil)
    }

    /// The mask groups of `ids` (default: the selection), or the mask groups holding them (`maskTargets`).
    func maskTargets(_ ids: [String]?) -> [VectorNode] {
        var out = OrderedPaths()
        for id in ids ?? selection {
            if let n = getNode(id), isVectorMaskGroup(n) { out.set(n) }
            else if let parent = locateVectorNode(doc.nodes, id)?.parent, isVectorMaskGroup(parent) { out.set(parent) }
        }
        return out.values
    }

    /**
     * Release (`releaseMask`): the selected (or given) mask groups stop masking. The mask goes back
     * on top of the contents. A group with appearance of its own (filters, a blend mode, path
     * effects) stays a plain group; otherwise it is replaced by its children. One undo step.
     * Returns the released nodes' ids (the mask last).
     */
    @discardableResult
    public func releaseMask(ids: [String]? = nil) throws -> [String] {
        let groups = maskTargets(ids)
        if groups.isEmpty { return [] }
        var released: [String] = []
        try change("Release Mask") {
            for g in groups {
                let children = Array(g.children.dropFirst()) + [g.children[0]]
                released += children.map(\.id)
                var rest = g
                rest["mask"] = Optional<JSONValue>.none
                let keep = (arrayLength(g["filters"]) ?? 0) > 0 || (truthy(g["blendMode"]) && g["blendMode"] != "normal") || (arrayLength(g["effects"]) ?? 0) > 0
                if keep {
                    rest.children = children
                    try replaceNode(g.id, rest)
                    continue
                }
                let m = nodeMatrix(g)
                let opacity = g.opacity
                let flat = try children.map { c -> VectorNode in
                    var n = truthy(g["transform"]) ? try transformVectorNode(c, m) : c
                    if let opacity, opacity < 1 { n.opacity = (n.opacity ?? 1) * opacity }
                    return n
                }
                setDoc(spliceTree(doc.nodes, g.id, flat))
            }
            selection = released
            anchors = []
            editingId = nil
        }
        return released
    }

    /// Changes the type or inversion of the selected (or given) mask groups, or turns their masks
    /// off (`enabled: false` hides the mask) and on. One undo step (`setMaskOptions`).
    @discardableResult
    public func setMaskOptions(type: String? = nil, invert: Bool? = nil, enabled: Bool? = nil, ids: [String]? = nil) -> VectorActionResult {
        if let type, !VECTOR_MASK_TYPES.contains(type) { return .failure("Unknown mask type \"\(type)\": use clip, alpha or luminance.") }
        let groups = maskTargets(ids)
        if groups.isEmpty { return .failure("Select a mask group (made with Make Clipping Mask or Make Opacity Mask).") }
        let set = Set(groups.map(\.id))
        change("Mask Options") {
            setDoc(mapTree(doc.nodes) { n in
                guard set.contains(n.id), isVectorMaskGroup(n) else { return n }
                let t = type ?? n["mask"]?["type"]?.stringValue ?? "clip"
                let inv = invert ?? truthy(n["mask"]?["invert"])
                var g = n
                g["mask"] = inv ? .object(JSONObject([("type", .string(t)), ("invert", .bool(inv))])) : .object(JSONObject([("type", .string(t))]))
                let source = n.children[0]
                if let enabled, enabled != source.isVisible {
                    var shown = source
                    if enabled { shown["visible"] = Optional<JSONValue>.none } else { shown["visible"] = false }
                    g.children = [shown] + n.children.dropFirst()
                }
                return g
            })
        }
        return .success
    }

    // MARK: Lenses

    /**
     * Makes closed paths lenses or changes their lens (`setLens`): `lens` is merged over the
     * current settings (a different `type` starts from that type's defaults), and nil makes them
     * plain paths again. One undo step. Returns each path's id and resulting lens (nil: removed).
     */
    public func setLens(_ lens: JSONObject?, ids: [String]? = nil) -> (result: VectorActionResult, lenses: [(id: String, lens: JSONObject?)]) {
        func fail(_ m: String) -> (result: VectorActionResult, lenses: [(id: String, lens: JSONObject?)]) { (.failure(m), []) }
        let list = ids ?? selection
        if list.isEmpty { return fail("Select a closed path to make a lens first.") }
        if let t = lens?["type"], t.stringValue.map({ !VECTOR_LENS_TYPES.contains($0) }) ?? true {
            return fail("Unknown lens \"\(t.stringValue ?? t.stringified())\": use \(VECTOR_LENS_TYPES.joined(separator: ", ")).")
        }
        if let c = lens?["color"], c != .null, c.stringValue.map({ parseVectorColor($0) == nil }) ?? true {
            return fail("\"\(c.stringValue ?? c.stringified())\" is not a colour: use a CSS colour such as #ff0000.")
        }
        var next: [(id: String, lens: JSONObject?)] = []
        for id in list {
            guard let n = getNode(id) else { return fail("There is no node \"\(id)\".") }
            if n.isLocked { return fail("\"\(id)\" is locked; unlock it first.") }
            guard let lens else {
                if n.isPath && truthy(n["lens"]) && !next.contains(where: { $0.id == id }) { next.append((id, nil)) }
                continue
            }
            if !n.isPath || !n.subpaths.contains(where: \.closed) || truthy(n["connector"]) { return fail("\"\(id)\" is not a closed path: only closed paths can be lenses.") }
            guard let type = lens["type"]?.stringValue ?? n["lens"]?["type"]?.stringValue else {
                return fail("\"\(id)\" is not a lens yet: pass a type (\(VECTOR_LENS_TYPES.joined(separator: ", "))).")
            }
            let spec = VECTOR_LENS_SPECS[type]!
            if let a = lens["amount"] {
                let v = a.numberValue ?? .nan
                if !(v.isFinite && v >= spec.min && v <= spec.max) {
                    return fail("amount for a \(type) lens must be from \(JSONValue.jsNumber(spec.min)) to \(JSONValue.jsNumber(spec.max)) (\(spec.unit)).")
                }
            }
            var merged = n["lens"]?.objectValue.flatMap { $0["type"]?.stringValue == type ? $0 : nil } ?? JSONObject([("type", .string(type))])
            for (k, v) in lens { merged[k] = v }
            merged["type"] = .string(type)
            let clean = sanitizeVectorLens(.object(merged))
            if let i = next.firstIndex(where: { $0.id == id }) { next[i].lens = clean } else { next.append((id, clean)) }
        }
        if next.isEmpty { return (.success, []) }
        change(lens == nil ? "Remove Lens" : "Lens") {
            setDoc(mapTree(doc.nodes) { n in
                guard n.isPath, let entry = next.first(where: { $0.id == n.id }) else { return n }
                var c = n
                if let l = entry.lens { c["lens"] = .object(l) } else {
                    c["lens"] = Optional<JSONValue>.none
                    c["lensView"] = Optional<JSONValue>.none
                }
                return c
            })
        }
        return (.success, next)
    }
}

/// Nodes by id in first-seen order, a later node with the same id replacing the earlier one in
/// its place (a JS `Map` keyed by id).
struct OrderedPaths {
    private(set) var values: [VectorNode] = []
    private var index: [String: Int] = [:]

    mutating func set(_ node: VectorNode) {
        if let i = index[node.id] { values[i] = node } else {
            index[node.id] = values.count
            values.append(node)
        }
    }
}
