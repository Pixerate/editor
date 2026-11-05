import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Symbols and instances on the controller (the "Symbols and instances" section of
// `vector/controller.ts`) and the symbols panel's data (`vector/symbolsPanel.ts`): Make Symbol,
// Place Symbol, instance options and overrides, Replace, Rename, Delete, Detach, and editing a
// symbol in isolation mode, where the controller's document is the symbol's art. The Swift
// controller has no viewport, so entering and leaving isolation do not move the view.

/// Isolation mode (`SymbolEditContext`): `doc` holds a symbol's art; `host` is the document it belongs to.
struct VectorSymbolEditContext: Equatable {
    var symbolId: String
    /// The instance it was entered from (its placement lines the art up with the document), if any.
    var instanceId: String?
    var host: VectorDocument
    /// Where the instance put the symbol's origin, and its scale (√|det|).
    var origin: Vec2?
    var scale: Double
}

/// The symbol being edited in isolation (`state.symbolEdit`).
public struct VectorSymbolEditState: Equatable {
    public var symbolId: String
    public var name: String
    public var instanceId: String?
    /// The whole document, the edited symbol's art included.
    public var host: VectorDocument
    /// The document in symbol space, lined up with the instance it was entered from (nil without one).
    public var hostTransform: VectorMatrix?
}

/// Whether node `id` or one of its ancestors is hidden or locked (`hiddenOrLocked`).
private func hiddenOrLocked(_ nodes: [VectorNode], _ id: String) -> Bool {
    guard let loc = locateVectorNode(nodes, id) else { return false }
    let n = nodes[path: loc.path]
    if n.isLocked || !n.isVisible { return true }
    return loc.parent.map { hiddenOrLocked(nodes, $0.id) } ?? false
}

/// `list` with the entry for `id` set (in first-set order, as a JS `Map`).
private func setEntry(_ list: inout [(id: String, node: VectorNode)], _ id: String, _ node: VectorNode) {
    if let i = list.firstIndex(where: { $0.id == id }) { list[i].node = node } else { list.append((id, node)) }
}

extension VectorEditorController {
    /// The whole document (`storedDocument`): in isolation mode, the host with the edited symbol's art.
    func storedDocument() -> VectorDocument {
        guard let edit = symbolEdit else { return doc }
        var host = edit.host
        host.symbols = (edit.host.symbols ?? []).map { s in
            if s.id == edit.symbolId {
                var c = s
                c.nodes = doc.nodes
                return c
            }
            return doc.symbols?.first { $0.id == s.id } ?? s
        }
        return resolveVectorSymbols(host)
    }

    /// The symbol being edited in isolation, or nil (`state.symbolEdit`).
    public var symbolEditState: VectorSymbolEditState? {
        guard let edit = symbolEdit else { return nil }
        let host = storedDocument()
        let sym = host.symbols?.first { $0.id == edit.symbolId }
        let hostTransform = edit.origin.map { o in VectorMatrix(1 / edit.scale, 0, 0, 1 / edit.scale, -o.x / edit.scale + 0, -o.y / edit.scale + 0) }
        return VectorSymbolEditState(symbolId: edit.symbolId, name: sym?.name ?? edit.symbolId, instanceId: edit.instanceId, host: host, hostTransform: hostTransform)
    }

    /// The document's symbols (the stored ones, also while one is being edited).
    public func getSymbols() -> [VectorSymbol] { storedDocument().symbols ?? [] }

    /// Ids of the instances of symbol `symbolId` in the whole document (inside other symbols too).
    public func getSymbolInstances(_ symbolId: String) -> [String] {
        let d = storedDocument()
        var out: [String] = []
        func visit(_ list: [VectorNode]) {
            for n in list {
                if n.isInstance && n.symbolId == symbolId { out.append(n.id) }
                if n.isGroup { visit(n.children) }
            }
        }
        visit(d.nodes)
        for s in d.symbols ?? [] { visit(s.nodes) }
        return out
    }

    private func newSymbolId() -> String {
        let used = Set(getSymbols().map(\.id))
        var id = "symbol-\(createId())"
        while used.contains(id) { id = "symbol-\(createId())" }
        return id
    }

    /// Make Symbol: turns the selected (or given) objects, which must share a parent, into a new
    /// symbol whose registration point is their centre, and puts an instance in their place. One
    /// undo step. Returns the symbol's and the instance's ids.
    public func makeSymbol(ids idsIn: [String]? = nil, name: String? = nil) throws -> (result: VectorActionResult, symbolId: String?, instanceId: String?) {
        let ids = idsIn ?? selectedRoots()
        if ids.isEmpty { return (.failure("Select the objects to make a symbol from."), nil, nil) }
        let locs = ids.map { locateVectorNode(doc.nodes, $0) }
        if let i = locs.firstIndex(where: { $0 == nil }) { return (.failure("There is no node \"\(ids[i])\"."), nil, nil) }
        let parent = locs[0]!.parent?.id
        if locs.contains(where: { $0!.parent?.id != parent }) { return (.failure("The objects must share a parent (the same group) to make one symbol."), nil, nil) }
        if ids.contains(where: { hiddenOrLocked(doc.nodes, $0) }) { return (.failure("Unlock and show the objects first."), nil, nil) }
        guard let box = unionBounds(try ids.map { try vectorNodeBounds(getNode($0)!, IDENTITY_MATRIX) }) else {
            return (.failure("The objects have no geometry to make a symbol from."), nil, nil)
        }
        let cx = box.x + box.width / 2
        let cy = box.y + box.height / 2
        let symbolId = newSymbolId()
        let instanceId = newId()
        let trimmed = name?.jsTrimmed ?? ""
        let symbolName = trimmed.isEmpty ? "Symbol \(getSymbols().count + 1)" : trimmed
        let set = Set(ids)
        try change("Make Symbol") {
            func replace(_ list: [VectorNode]) throws -> [VectorNode] {
                let members = list.filter { set.contains($0.id) }
                let top = members.compactMap { m in list.firstIndex { $0.id == m.id } }.max() ?? -1
                let art = try members.map { try transformVectorNode($0, translateMatrix(-cx, -cy)) }
                doc.symbols = (doc.symbols ?? []) + [VectorSymbol(id: symbolId, name: symbolName, nodes: art)]
                var out: [VectorNode] = []
                for (i, n) in list.enumerated() {
                    if i == top {
                        out.append(VectorNode(props: JSONObject([
                            ("id", .string(instanceId)), ("type", "instance"), ("name", .string(symbolName)), ("symbolId", .string(symbolId)),
                            ("transform", translateMatrix(cx, cy).json),
                        ])))
                    }
                    if !set.contains(n.id) { out.append(n) }
                }
                return out
            }
            if let parent {
                setDoc(try mapTree(doc.nodes) { n in
                    guard n.id == parent && n.isGroup else { return n }
                    var g = n
                    g.children = try replace(n.children)
                    return g
                })
            } else {
                setDoc(try replace(doc.nodes))
            }
            selection = [instanceId]
            anchors = []
        }
        return (.success, symbolId, instanceId)
    }

    /// Places an instance of symbol `symbolId` with its registration point at (`x`, `y`) (default the
    /// artboard's centre), or through `transform`. One undo step. Returns its id.
    public func placeSymbol(_ symbolId: String, x: Double? = nil, y: Double? = nil, transform: VectorMatrix? = nil, name: String? = nil, parentId: String? = nil) throws -> (result: VectorActionResult, id: String?) {
        guard let sym = getSymbols().first(where: { $0.id == symbolId }) else {
            return (.failure("There is no symbol \"\(symbolId)\"; vector.listSymbols lists them."), nil)
        }
        if let edit = symbolEdit, symbolId == edit.symbolId || vectorSymbolUses(getSymbols(), symbolId, edit.symbolId) {
            return (.failure("\"\(sym.name)\" would contain itself: a symbol cannot hold an instance of itself."), nil)
        }
        let t = transform ?? translateMatrix(x ?? doc.width / 2, y ?? doc.height / 2)
        if ![t.a, t.b, t.c, t.d, t.e, t.f].allSatisfy(\.isFinite) { return (.failure("transform must be six finite numbers [a, b, c, d, e, f]."), nil) }
        var props = JSONObject([("id", .string(newId())), ("type", "instance"), ("name", .string(name ?? sym.name)), ("symbolId", .string(symbolId))])
        if !isIdentityMatrix(t) { props["transform"] = t.json }
        let id = try addNode(VectorNode(props: props), AddVectorNodeOptions(parentId: parentId, label: "Place Symbol"))
        return (.success, id)
    }

    /// The instances `ids` (default the selection) name, or why not.
    private func instanceTargets(_ ids: [String]?) -> (nodes: [VectorNode], error: String?) {
        let list = ids ?? selection
        if list.isEmpty { return ([], "Select an instance.") }
        var out: [VectorNode] = []
        for id in list {
            guard let n = getNode(id) else { return ([], "There is no node \"\(id)\".") }
            if !n.isInstance { return ([], "\"\(id)\" is a \(n.typeName), not a symbol instance.") }
            out.append(n)
        }
        return (out, nil)
    }

    /// An instance as a group of its art as drawn, with fresh ids inside (the instance's id and name kept).
    private func detached(_ n: VectorNode) throws -> VectorNode {
        var g = try freshIds(try vectorInstanceDrawn(n))
        g.id = n.id
        g["name"] = .string(n.name ?? "Group")
        return g
    }

    /// Detach: replaces instances by groups of their symbol's art as drawn (placed, strokes scaled,
    /// overrides applied), unlinked from the symbol. One undo step. Returns the groups' ids (the
    /// instances' own).
    public func detachInstances(ids: [String]? = nil) throws -> (result: VectorActionResult, ids: [String]) {
        let targets = instanceTargets(ids)
        if let error = targets.error { return (.failure(error), []) }
        var next: [(id: String, node: VectorNode)] = []
        for t in targets.nodes { setEntry(&next, t.id, try detached(t)) }
        change("Detach Instance") {
            setDoc(mapTree(doc.nodes) { n in next.first { $0.id == n.id }?.node ?? n })
        }
        return (.success, next.map(\.id))
    }

    /// Replace Symbol: instances draw symbol `symbolId` instead, keeping their placement. One undo step.
    public func replaceSymbol(_ symbolId: String, ids: [String]? = nil) -> VectorActionResult {
        let targets = instanceTargets(ids)
        if let error = targets.error { return .failure(error) }
        guard let sym = getSymbols().first(where: { $0.id == symbolId }) else { return .failure("There is no symbol \"\(symbolId)\"; vector.listSymbols lists them.") }
        if let edit = symbolEdit, symbolId == edit.symbolId || vectorSymbolUses(getSymbols(), symbolId, edit.symbolId) {
            return .failure("\"\(sym.name)\" would contain itself.")
        }
        let set = Set(targets.nodes.map(\.id))
        change("Replace Symbol") {
            setDoc(mapTree(doc.nodes) { n in
                guard set.contains(n.id), n.isInstance else { return n }
                var rest = n
                rest["art"] = Optional<JSONValue>.none
                rest["symbolId"] = .string(symbolId)
                // Hidden art ids belong to the old symbol.
                var overrides = n["overrides"]?.objectValue
                overrides?["hidden"] = Optional<JSONValue>.none
                if let overrides, !overrides.isEmpty { rest["overrides"] = .object(overrides) } else { rest["overrides"] = Optional<JSONValue>.none }
                return rest
            })
        }
        return .success
    }

    /// Instance options (`setInstanceOptions`): `scaleStrokes` (strokes of the art scale with the
    /// instance), and overrides — `fill` / `stroke` (every fill or stroke of the art in one paint;
    /// JSON `null` clears), `hidden` (art node ids not drawn; `null` or `[]` clears). Members of
    /// `patch` that are absent stay as they are. One undo step.
    public func setInstanceOptions(_ patch: JSONObject, ids: [String]? = nil) throws -> VectorActionResult {
        let targets = instanceTargets(ids)
        if let error = targets.error { return .failure(error) }
        var next: [(id: String, node: VectorNode)] = []
        for t in targets.nodes {
            var n = t
            if let s = patch["scaleStrokes"]?.boolValue {
                if s { n["scaleStrokes"] = Optional<JSONValue>.none } else { n["scaleStrokes"] = false }
            }
            var o = t["overrides"]?.objectValue ?? JSONObject()
            for key in ["fill", "stroke"] {
                guard let v = patch[key] else { continue }
                if v == .null { remove(&o, key) } else { o[key] = v }
            }
            if let hidden = patch["hidden"] {
                if let list = hidden.arrayValue, !list.isEmpty {
                    var known = Set<String>()
                    walkVectorNodes(try vectorInstanceArt(t)) { a, _, _ in known.insert(a.id) }
                    let unknown = list.compactMap(\.stringValue).filter { !known.contains($0) }
                    if !unknown.isEmpty {
                        return .failure("The symbol's art has no nodes \(unknown.map { "\"\($0)\"" }.joined(separator: ", ")); vector.listSymbols lists its node ids.")
                    }
                    o["hidden"] = hidden
                } else {
                    remove(&o, "hidden")
                }
            }
            if !o.isEmpty { n["overrides"] = .object(o) } else { n["overrides"] = Optional<JSONValue>.none }
            setEntry(&next, t.id, n)
        }
        change("Instance Options") {
            setDoc(mapTree(doc.nodes) { n in next.first { $0.id == n.id }?.node ?? n })
        }
        return .success
    }

    /// Renames symbol `symbolId`. One undo step.
    public func renameSymbol(_ symbolId: String, _ name: String) -> VectorActionResult {
        let trimmed = name.jsTrimmed
        if trimmed.isEmpty { return .failure("A symbol needs a name.") }
        if !getSymbols().contains(where: { $0.id == symbolId }) { return .failure("There is no symbol \"\(symbolId)\".") }
        func renamed(_ list: [VectorSymbol]) -> [VectorSymbol] {
            list.map { s in
                guard s.id == symbolId else { return s }
                var c = s
                c["name"] = .string(trimmed)
                return c
            }
        }
        change("Rename Symbol") {
            doc.symbols = renamed(doc.symbols ?? [])
            if var edit = symbolEdit {
                edit.host.symbols = renamed(edit.host.symbols ?? [])
                symbolEdit = edit
            }
        }
        return .success
    }

    /// Deletes symbol `symbolId`. With instances in use it refuses unless `detach` (they become plain
    /// groups first). One undo step.
    public func deleteSymbol(_ symbolId: String, detach: Bool = false) throws -> VectorActionResult {
        if symbolEdit != nil { return .failure("Leave the symbol being edited first (exitSymbolEdit).") }
        guard let sym = getSymbols().first(where: { $0.id == symbolId }) else { return .failure("There is no symbol \"\(symbolId)\".") }
        let used = getSymbolInstances(symbolId)
        if !used.isEmpty && !detach {
            return .failure("\"\(sym.name)\" has \(used.count) instance\(used.count == 1 ? "" : "s"); pass detach to turn them into groups, or delete them first.")
        }
        let before = snapshot()
        func detachAll(_ list: [VectorNode]) throws -> [VectorNode] {
            try list.map { n in
                if n.isInstance && n.symbolId == symbolId { return try detached(n) }
                if n.isGroup {
                    var g = n
                    g.children = try detachAll(n.children)
                    return g
                }
                return n
            }
        }
        let nodes = try detachAll(doc.nodes)
        let symbols = try (doc.symbols ?? []).filter { $0.id != symbolId }.map { s in
            var c = s
            c.nodes = try detachAll(s.nodes)
            return c
        }
        doc.nodes = nodes
        doc.symbols = symbols
        commit("Delete Symbol", before)
        return .success
    }

    /// Edit Symbol (isolation mode): the document becomes the art of symbol `id` (or of instance
    /// `id`'s symbol), in its own space. Edits are ordinary undo steps; `exitSymbolEdit` returns to
    /// the document with every instance updated. Not an undo step itself.
    public func editSymbol(_ id: String) throws -> VectorActionResult {
        let node = getNode(id)
        let symbolId = node?.isInstance == true ? node!.symbolId : id
        let host = storedDocument()
        guard let sym = host.symbols?.first(where: { $0.id == symbolId }) else {
            return .failure(node.map { "\"\(id)\" is a \($0.typeName), not a symbol instance." } ?? "There is no symbol or instance \"\(id)\".")
        }
        if symbolEdit != nil { exitSymbolEdit() }
        finishPath()
        let fresh = storedDocument()
        var origin: Vec2?
        var scale = 1.0
        if let node, node.isInstance, let world = vectorWorldMatrix(fresh.nodes, node.id) {
            let det = abs(world.a * world.d - world.b * world.c)
            if det > 1e-12 {
                origin = Vec2(world.e, world.f)
                scale = det.squareRoot()
            }
        }
        var o = JSONObject([("width", .number(fresh.width)), ("height", .number(fresh.height))])
        if let bg = fresh.background, !bg.isEmpty { o["background"] = .string(bg) }
        o["nodes"] = .array(sym.nodes.map { $0.toJSON() })
        if let symbols = fresh.symbols { o["symbols"] = .array(symbols.map { $0.toJSON() }) }
        let art = try VectorDocument(json: .object(o))
        symbolEdit = VectorSymbolEditContext(symbolId: symbolId, instanceId: origin != nil ? node!.id : nil, host: fresh, origin: origin, scale: scale)
        doc = art
        selection = []
        anchors = []
        editingId = nil
        notify()
        return .success
    }

    /// Leaves isolation mode: back to the whole document, the symbol's instances showing the edits.
    public func exitSymbolEdit() {
        guard let edit = symbolEdit else { return }
        finishPath()
        doc = storedDocument()
        symbolEdit = nil
        selection = edit.instanceId.flatMap { getNode($0) != nil ? [$0] : nil } ?? []
        anchors = []
        editingId = nil
        history.endGesture()
        notify()
    }

    // MARK: Panel

    /// The symbols panel (`getVectorSymbolsPanel`): each symbol with its instance count, a preview
    /// (`scene` in an `<svg viewBox>`) and whether it is being edited; whether the selection can
    /// become a symbol; the one selected instance's options; the symbol being edited.
    public func symbolsPanel(idPrefix: String = "vsym-") throws -> JSONValue {
        let host = symbolEdit?.host ?? doc
        var counts: [String: Int] = [:]
        func count(_ list: [VectorNode]) {
            for n in list {
                if n.isInstance { counts[n.symbolId, default: 0] += 1 }
                if n.isGroup { count(n.children) }
            }
        }
        count(host.nodes)
        for s in host.symbols ?? [] { count(s.nodes) }
        func fmt(_ n: Double) -> String { JSONValue.jsNumber(round2(n)) }
        let symbols: [JSONValue] = try (host.symbols ?? []).map { s in
            let b = unionBounds(try s.nodes.map { try vectorNodeBounds($0, IDENTITY_MATRIX) }) ?? VectorBounds(x: -10, y: -10, width: 20, height: 20)
            let pad = JS.max(b.width, b.height) * 0.08 + 1
            let scene = try getVectorSceneRenderData(VectorDocument(width: 0, height: 0, nodes: s.nodes), idPrefix: "\(idPrefix)\(s.id)-")
            return .object(JSONObject([
                ("id", .string(s.id)), ("name", .string(s.name)), ("instances", .number(Double(counts[s.id] ?? 0))),
                ("viewBox", .string("\(fmt(b.x - pad)) \(fmt(b.y - pad)) \(fmt(b.width + 2 * pad)) \(fmt(b.height + 2 * pad))")),
                ("scene", scene), ("editing", .bool(symbolEdit?.symbolId == s.id)),
            ]))
        }
        let one = selection.count == 1 ? findVectorNode(doc.nodes, selection[0]) : nil
        let inst = one?.isInstance == true ? one : nil
        let instance: JSONValue = inst.map { i in
            let o = i["overrides"]?.objectValue
            return .object(JSONObject([
                ("id", .string(i.id)), ("symbolId", .string(i.symbolId)), ("scaleStrokes", .bool(i["scaleStrokes"] != .bool(false))),
                ("fill", o?["fill"] ?? .null), ("stroke", o?["stroke"] ?? .null), ("hidden", .number(Double(o?["hidden"]?.arrayValue?.count ?? 0))),
            ]))
        } ?? .null
        let state = symbolEditState
        return .object(JSONObject([
            ("symbols", .array(symbols)),
            ("canMake", .bool(!selection.isEmpty && !(selection.count == 1 && inst != nil))),
            ("instance", instance),
            ("editing", state.map { .object(JSONObject([("symbolId", .string($0.symbolId)), ("name", .string($0.name))])) } ?? .null),
        ]))
    }

    /// The document behind a symbol edited in isolation, to draw dimmed under the art
    /// (`getVectorSymbolEditBackground`): its scene placed so the instance it was entered from lines
    /// up with the art (that instance left out), and the symbol's name. Nil outside isolation mode,
    /// or when the symbol was entered without an instance.
    public func symbolEditBackground(idPrefix: String = "ve-host-") throws -> JSONValue? {
        guard let e = symbolEditState, let m = e.hostTransform else { return nil }
        func drop(_ list: [VectorNode]) -> [VectorNode] {
            list.filter { $0.id != e.instanceId }.map { n in
                guard n.isGroup else { return n }
                var g = n
                g.children = drop(n.children)
                return g
            }
        }
        var host = e.host
        host.nodes = drop(e.host.nodes)
        guard case var .object(scene) = try getVectorSceneRenderData(host, viewport: VectorViewport(zoom: zoom), idPrefix: idPrefix) else { return nil }
        let parts = [m.a, m.b, m.c, m.d, m.e, m.f].map { JSONValue.jsNumber(JS.round($0 * 1e6) / 1e6) }
        scene["transform"] = .string("\(scene["transform"]?.stringValue ?? "") matrix(\(parts.joined(separator: " ")))")
        scene["name"] = .string(e.name)
        return .object(scene)
    }
}
