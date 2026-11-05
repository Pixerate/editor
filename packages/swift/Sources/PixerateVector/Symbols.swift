import Foundation
import PixerateCore
import PixerateGeometry

// Symbols and instances (`vector/symbols.ts`): reusable art (`VectorDocument.symbols`) drawn by
// `instance` nodes through an affine transform that may scale and skew.
//
// Instances carry their symbol's art resolved (`art`, the symbol's own `nodes`) so that geometry,
// rendering and export, which see one node at a time, can draw them. The TS keeps the symbol's
// node objects there; the Swift stores their JSON (as lenses store their backdrop) and reads it
// back when drawing (`vectorInstanceDrawn`). The editor resolves after every change
// (`resolveVectorSymbols`); storage leaves it out (`stripVectorSymbolArt`).

/// Instances inside symbols nest at most this deep; deeper ones draw nothing (`VECTOR_SYMBOL_MAX_DEPTH`).
public let VECTOR_SYMBOL_MAX_DEPTH = 16

private func visitAll(_ nodes: [VectorNode], _ fn: (VectorNode) -> Void) {
    for n in nodes {
        fn(n)
        if n.isGroup { visitAll(n.children, fn) }
    }
}

/// An instance's symbol id (`symbolId`).
extension VectorNode {
    public var symbolId: String { self["symbolId"]?.stringValue ?? "" }
}

/// Ids of the symbols instances in `nodes` use (nested groups included, not through other symbols), in first-use order.
public func vectorSymbolsUsedIn(_ nodes: [VectorNode]) -> [String] {
    var out: [String] = []
    visitAll(nodes) { n in if n.isInstance && !out.contains(n.symbolId) { out.append(n.symbolId) } }
    return out
}

/// Whether symbol `symbolId`'s art reaches symbol `target` through its instances (a cycle when they are the same).
public func vectorSymbolUses(_ symbols: [VectorSymbol], _ symbolId: String, _ target: String) -> Bool {
    var byId: [String: VectorSymbol] = [:]
    for s in symbols { byId[s.id] = s }
    var seen = Set<String>()
    func walk(_ id: String, _ depth: Int) -> Bool {
        if depth > VECTOR_SYMBOL_MAX_DEPTH || seen.contains(id) { return false }
        seen.insert(id)
        guard let sym = byId[id] else { return false }
        for used in vectorSymbolsUsedIn(sym.nodes) where used == target || walk(used, depth + 1) { return true }
        return false
    }
    return walk(symbolId, 0)
}

private func hasInstances(_ nodes: [VectorNode]) -> Bool {
    var found = false
    visitAll(nodes) { if $0.isInstance { found = true } }
    return found
}

/// The document with every instance's `art` set to its symbol's art (instances inside symbols
/// included); the same document when nothing changed. An instance of a missing symbol, or one
/// that would draw its own symbol, gets no art.
public func resolveVectorSymbols(_ doc: VectorDocument) -> VectorDocument {
    let symbols = doc.symbols ?? []
    if symbols.isEmpty && !hasInstances(doc.nodes) { return doc }
    // Symbols first: their own instances resolve to the (resolved) art of the symbols they use.
    var resolved: [String: VectorSymbol] = [:]
    var byId: [String: VectorSymbol] = [:]
    for s in symbols { byId[s.id] = s }
    var resolving = Set<String>()
    func symbolOf(_ id: String) -> VectorSymbol? {
        if let hit = resolved[id] { return hit }
        guard let sym = byId[id], !resolving.contains(id) else { return nil }
        resolving.insert(id)
        let nodes = resolveList(sym.nodes)
        resolving.remove(id)
        var next = sym
        if nodes != sym.nodes { next.nodes = nodes }
        resolved[id] = next
        return next
    }
    func resolveNode(_ n: VectorNode) -> VectorNode {
        if n.isInstance {
            let sym = symbolOf(n.symbolId)
            var art = Optional<JSONValue>.none
            if let sym, !resolving.contains(n.symbolId) { art = .array(sym.nodes.map { $0.toJSON() }) }
            if n["art"] == art { return n }
            var next = n
            if let art { next["art"] = art } else { next["art"] = Optional<JSONValue>.none }
            return next
        }
        if n.isGroup {
            let children = resolveList(n.children)
            if children == n.children { return n }
            var next = n
            next.children = children
            return next
        }
        return n
    }
    func resolveList(_ list: [VectorNode]) -> [VectorNode] { list.map(resolveNode) }
    let nextSymbols = symbols.map { symbolOf($0.id) ?? $0 }
    let nodes = resolveList(doc.nodes)
    let symbolsChanged = nextSymbols != symbols
    if nodes == doc.nodes && !symbolsChanged { return doc }
    var out = doc
    if nodes != doc.nodes { out.nodes = nodes }
    if doc.symbols != nil && symbolsChanged { out.symbols = nextSymbols }
    return out
}

/// The document without resolved art on its instances (for storage; `stripVectorSymbolArt`).
public func stripVectorSymbolArt(_ doc: VectorDocument) -> VectorDocument {
    func strip(_ list: [VectorNode]) -> [VectorNode] {
        list.map { n in
            var c = n
            if n.isInstance && truthy(n["art"]) { c["art"] = Optional<JSONValue>.none }
            if n.isGroup { c.children = strip(n.children) }
            return c
        }
    }
    var out = doc
    out.nodes = strip(doc.nodes)
    if let symbols = doc.symbols {
        out.symbols = symbols.map { s in
            var c = s
            c.nodes = strip(s.nodes)
            return c
        }
    }
    return out
}

/// A node's stroke widths (every stroke layer, the shorthand; profiles are relative) times `k`;
/// groups pass it on (`scaleVectorStrokeWidths`).
public func scaleVectorStrokeWidths(_ node: VectorNode, _ k: Double) -> VectorNode {
    if k == 1 || !(k > 0) { return node }
    var out = node
    if node.isGroup {
        out.children = node.children.map { scaleVectorStrokeWidths($0, k) }
        return out
    }
    if node.isInstance { return node }
    if node.has("strokeWidth") || truthy(node["stroke"]) { out.strokeWidth = (node.strokeWidth ?? 1) * k }
    if let strokes = node["strokes"]?.arrayValue {
        out["strokes"] = .array(strokes.map { l in
            var o = l.objectValue ?? JSONObject()
            o["strokeWidth"] = .number((o["strokeWidth"]?.numberValue ?? 1) * k)
            return .object(o)
        })
    }
    return out
}

/// A node's fills and / or strokes all painted with the overrides' `fill` / `stroke` (members that
/// are present; groups pass them on; `tintVectorNode`).
public func tintVectorNode(_ node: VectorNode, _ overrides: JSONObject) -> VectorNode {
    let fill = overrides["fill"]
    let stroke = overrides["stroke"]
    if fill == nil && stroke == nil { return node }
    var out = node
    if node.isGroup {
        out.children = node.children.map { tintVectorNode($0, overrides) }
        return out
    }
    if node.isInstance {
        var own = node["overrides"]?.objectValue ?? JSONObject()
        if let fill { own["fill"] = fill }
        if let stroke { own["stroke"] = stroke }
        out["overrides"] = .object(own)
        return out
    }
    func has(_ p: JSONValue?) -> Bool { p != nil && p != .null && p != "none" }
    func painted(_ list: [JSONValue], _ paint: JSONValue) -> JSONValue {
        .array(list.map { l in
            var o = l.objectValue ?? JSONObject()
            o["paint"] = paint
            return .object(o)
        })
    }
    if let fill {
        let fills = node["fills"]?.arrayValue
        if let fills { out["fills"] = painted(fills, fill) }
        if has(node["fill"]) || fills != nil { out["fill"] = fill }
    }
    if let stroke {
        let strokes = node["strokes"]?.arrayValue
        if let strokes { out["strokes"] = painted(strokes, stroke) }
        if has(node["stroke"]) || strokes != nil { out["stroke"] = stroke }
    }
    return out
}

/// Copies of `nodes` with ids prefixed `<prefix>~` (all the way down; `prefixVectorIds`).
public func prefixVectorIds(_ nodes: [VectorNode], _ prefix: String) -> [VectorNode] {
    nodes.map { n in
        var c = n
        c.id = "\(prefix)~\(n.id)"
        if n.isGroup { c.children = prefixVectorIds(n.children, prefix) }
        return c
    }
}

/// An instance's resolved art (`art`) as nodes.
public func vectorInstanceArt(_ node: VectorNode) throws -> [VectorNode] {
    try (node["art"]?.arrayValue ?? []).map { try VectorNode(json: $0) }
}

/// What an instance draws, as a plain group in its parent's space (`vectorInstanceGroup`): its art
/// placed through its transform (the rotation on the group, scale and skew baked into the art so
/// transforms stay rigid), strokes scaled unless `scaleStrokes` is false, overrides applied, ids
/// `<instance>~<art>`.
public func vectorInstanceDrawn(_ node: VectorNode) throws -> VectorNode {
    let m = node.transform ?? IDENTITY_MATRIX
    let (rigid, residual) = decomposeRigid(m)
    let k = abs(residual.a * residual.d - residual.b * residual.c).squareRoot()
    let overrides = node["overrides"]?.objectValue
    let hidden = Set((overrides?["hidden"]?.arrayValue ?? []).compactMap(\.stringValue))
    func keep(_ list: [VectorNode]) -> [VectorNode] {
        list.filter { !hidden.contains($0.id) }.map { n in
            guard n.isGroup else { return n }
            var g = n
            g.children = keep(n.children)
            return g
        }
    }
    var children = prefixVectorIds(keep(try vectorInstanceArt(node)), node.id)
    if !isIdentityMatrix(residual) { children = try children.map { try transformVectorNode($0, residual) } }
    if node["scaleStrokes"] != .bool(false) && abs(k - 1) > 1e-12 { children = children.map { scaleVectorStrokeWidths($0, k) } }
    if let overrides, overrides["fill"] != nil || overrides["stroke"] != nil { children = children.map { tintVectorNode($0, overrides) } }
    var group = VectorNode(props: JSONObject([("id", .string(node.id)), ("type", "group")]), children: children)
    if !isIdentityMatrix(rigid) { group.transform = rigid }
    if let name = node["name"] { group["name"] = name }
    if !node.isVisible { group["visible"] = false }
    if node.isLocked { group["locked"] = true }
    if let o = node["opacity"] { group["opacity"] = o }
    if truthy(node["blendMode"]) { group["blendMode"] = node["blendMode"] }
    if let n = arrayLength(node["filters"]), n > 0 { group["filters"] = node["filters"] }
    if let n = arrayLength(node["effects"]), n > 0 { group["effects"] = node["effects"] }
    if truthy(node["booleanOperation"]) { group["booleanOperation"] = node["booleanOperation"] }
    if truthy(node["blendStep"]) { group["blendStep"] = true }
    return group
}
