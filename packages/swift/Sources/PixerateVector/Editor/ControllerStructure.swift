import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

/// A blend group: a group with `blend` (`isVectorBlendGroup`).
func isVectorBlendGroup(_ node: VectorNode?) -> Bool {
    guard let node else { return false }
    return node.isGroup && truthy(node["blend"])
}

extension VectorEditorController {
    /// Groups the selected (or given) nodes; they must share a parent. Returns the group id.
    public func group(ids: [String]? = nil, name: String? = nil) throws -> String? {
        let list = ids ?? selectedRoots()
        if list.isEmpty { return nil }
        let locs = list.map { locateVectorNode(doc.nodes, $0) }
        if locs.contains(where: { $0 == nil }) { return nil }
        let parent = locs[0]!.parent?.id
        if locs.contains(where: { $0!.parent?.id != parent }) { return nil }
        let id = newId()
        change("Group") {
            let set = Set(list)
            func regroup(_ nodes: [VectorNode]) -> [VectorNode] {
                let members = nodes.filter { set.contains($0.id) }
                let top = members.compactMap { m in nodes.firstIndex { $0.id == m.id } }.max() ?? -1
                var out: [VectorNode] = []
                for (i, n) in nodes.enumerated() {
                    if i == top { out.append(VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(name ?? "Group"))]), children: members)) }
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
        }
        return id
    }

    /// Replaces the selected (or given) groups with their children.
    @discardableResult
    public func ungroup(ids: [String]? = nil) throws -> VectorActionResult {
        let groups = (ids ?? selection).compactMap { getNode($0) }.filter(\.isGroup)
        if groups.isEmpty { return .failure("Select a group to ungroup.") }
        let set = Set(groups.map(\.id))
        try change("Ungroup") {
            func flatten(_ list: [VectorNode]) throws -> [VectorNode] {
                var out: [VectorNode] = []
                for n in list {
                    if set.contains(n.id) && n.isGroup {
                        let opacity = n.opacity
                        let m = nodeMatrix(n)
                        for c0 in n.children {
                            var c = c0
                            if truthy(c["blendStep"]) {
                                c["blendStep"] = Optional<JSONValue>.none
                                c["locked"] = Optional<JSONValue>.none
                            }
                            if truthy(c["booleanOperation"]) { c["booleanOperation"] = Optional<JSONValue>.none }
                            if n.has("transform") && n["transform"] != nil && truthy(n["transform"]) { c = try transformVectorNode(c, m) }
                            if let opacity, opacity < 1 { c.opacity = (c.opacity ?? 1) * opacity }
                            out.append(c)
                        }
                    } else if n.isGroup {
                        var g = n
                        let children = try flatten(n.children)
                        if children != n.children { g.children = children }
                        out.append(g)
                    } else {
                        out.append(n)
                    }
                }
                return out
            }
            setDoc(try flatten(doc.nodes))
            selection = groups.flatMap { $0.children.map(\.id) }
        }
        return .success
    }

    /// Changes stacking order within each node's parent (`front`, `forward`, `backward`, `back`).
    @discardableResult
    public func arrange(_ op: String, ids: [String]? = nil) throws -> VectorActionResult {
        let set = Set(ids ?? selectedRoots())
        if set.isEmpty { return .failure("Nothing is selected.") }
        func reorder(_ list: [VectorNode]) -> [VectorNode] {
            var out = list.map { n -> VectorNode in
                guard n.isGroup else { return n }
                var g = n
                g.children = reorder(n.children)
                return g
            }
            if op == "front" { return out.filter { !set.contains($0.id) } + out.filter { set.contains($0.id) } }
            if op == "back" { return out.filter { set.contains($0.id) } + out.filter { !set.contains($0.id) } }
            if op == "forward" {
                var i = out.count - 2
                while i >= 0 {
                    if set.contains(out[i].id) && !set.contains(out[i + 1].id) { out.swapAt(i, i + 1) }
                    i -= 1
                }
            } else {
                var i = 1
                while i < out.count {
                    if set.contains(out[i].id) && !set.contains(out[i - 1].id) { out.swapAt(i, i - 1) }
                    i += 1
                }
            }
            return out
        }
        let labels = ["front": "Bring to Front", "forward": "Bring Forward", "backward": "Send Backward", "back": "Send to Back"]
        change(labels[op] ?? "undefined") { setDoc(reorder(doc.nodes)) }
        return .success
    }

    /// Moves a node into group `parentId` (`.some(nil)`: the top level; nil: where it is) at
    /// `index` among its new siblings (default: the top), keeping it in place on the canvas.
    @discardableResult
    public func moveNode(_ id: String, parentId: String?? = nil, index: Double? = nil) throws -> VectorActionResult {
        guard let node = getNode(id), let at = locateVectorNode(doc.nodes, id) else { return .failure("No node \"\(id)\".") }
        func fixed(_ g: VectorNode?) -> Bool { g.map { isVectorMaskGroup($0) || isVectorBlendGroup($0) } ?? false }
        if fixed(at.parent) { return .failure("The order inside a clipping group or blend is fixed.") }
        let parent: String? = parentId == nil ? at.parent?.id : parentId!
        let target = parent.flatMap { getNode($0) }
        if let parent {
            if target?.isGroup != true { return .failure("\"\(parent)\" is not a group.") }
            if parent == id || findVectorNode([node], parent) != nil { return .failure("A layer cannot go inside itself.") }
            if fixed(target) { return .failure("The order inside a clipping group or blend is fixed.") }
        }
        let groupId = target?.id
        // The tree without the node, so its new siblings come from there.
        let without = mapTree(doc.nodes) { $0.id == id ? nil : $0 }
        let inGroup = groupId.flatMap { findVectorNode(without, $0) }
        let siblings = inGroup?.isGroup == true ? inGroup!.children : without
        let to = Int(JS.max(0, JS.min(Double(siblings.count), JS.round(index ?? Double(siblings.count)))))
        if groupId == at.parent?.id && to == at.index { return .success }
        let from = vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX
        let into = groupId == nil ? IDENTITY_MATRIX : (vectorWorldMatrix(doc.nodes, groupId!) ?? IDENTITY_MATRIX)
        let m = multiplyMatrices(from, invertMatrix(into))
        var next = siblings
        next.insert(isIdentityMatrix(m) ? node : try transformVectorNode(node, m), at: to)
        change("Move Layer") {
            if let groupId {
                setDoc(mapTree(without) { n in
                    guard n.id == groupId, n.isGroup else { return n }
                    var g = n
                    g.children = next
                    return g
                })
            } else {
                setDoc(next)
            }
        }
        return .success
    }
}
