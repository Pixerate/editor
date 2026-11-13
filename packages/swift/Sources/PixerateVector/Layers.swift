import Foundation
import PixerateCore

// The vector document as a layers panel shows it (`vector/layers.ts`): one row per node, top
// first, groups indented with their children when expanded. Hosts draw the rows themselves and act
// on them with the controller (`select`, `updateNode` for `visible` / `locked`, `rename`, `moveNode`).

/// What a layer is, for its icon and its default name (`VectorLayerKind`).
public let VECTOR_LAYER_KINDS = ["path", "connector", "lens", "text", "instance", "group", "frame", "mask", "blend", "boolean", "symmetry"]

/// `VECTOR_LAYER_KIND_LABELS`.
public let VECTOR_LAYER_KIND_LABELS: [String: String] = [
    "path": "Path", "connector": "Connector", "lens": "Lens", "text": "Text", "instance": "Symbol", "group": "Group",
    "frame": "Frame", "mask": "Clipping Group", "blend": "Blend", "boolean": "Live Boolean", "symmetry": "Symmetry",
]

/// One row of the layers panel (`VectorLayerRow`).
public struct VectorLayerRow: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// One of `VECTOR_LAYER_KINDS`.
    public var kind: String
    /// 0 for the document's own nodes.
    public var depth: Int
    public var parentId: String?
    public var visible: Bool
    public var locked: Bool
    /// Children the row can show (a blend's generated steps are not counted).
    public var childCount: Int
    public var expanded: Bool
}

/// What a layer is (`vectorLayerKind`).
public func vectorLayerKind(_ node: VectorNode) -> String {
    if node.isText { return "text" }
    if node.isInstance { return "instance" }
    if node.isPath { return isVectorConnector(node) ? "connector" : isVectorLens(node) ? "lens" : "path" }
    if isVectorFrame(node) { return "frame" }
    if isVectorMaskGroup(node) { return "mask" }
    if isVectorBlendGroup(node) { return "blend" }
    if truthy(node["liveBoolean"]) { return "boolean" }
    if isVectorSymmetryGroup(node) { return "symmetry" }
    return "group"
}

/// The node's name, else its text (for text), else its kind (`vectorLayerName`).
public func vectorLayerName(_ node: VectorNode) -> String {
    let name = (node.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty { return name }
    if node.isText {
        let text = (node["text"]?.stringValue ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if !text.isEmpty {
            let units = Array(text.utf16)
            return units.count > 40 ? String(decoding: units.prefix(39), as: UTF16.self) + "…" : text
        }
    }
    return VECTOR_LAYER_KIND_LABELS[vectorLayerKind(node)] ?? "Path"
}

/// A group's children as the layers panel lists them: a blend's generated steps are left out (`vectorLayerChildren`).
public func vectorLayerChildren(_ node: VectorNode) -> [VectorNode] {
    node.isGroup ? node.children.filter { !truthy($0["blendStep"]) } : []
}

/// The rows for `nodes` (bottom to top, as documents keep them), top first. A group's children
/// follow it, indented, when `expanded` says so (`vectorLayerRows`).
public func vectorLayerRows(_ nodes: [VectorNode], expanded: (String) -> Bool = { _ in false }) -> [VectorLayerRow] {
    var rows: [VectorLayerRow] = []
    func visit(_ list: [VectorNode], _ depth: Int, _ parentId: String?) {
        for node in list.reversed() {
            let children = vectorLayerChildren(node)
            let open = !children.isEmpty && expanded(node.id)
            rows.append(VectorLayerRow(id: node.id, name: vectorLayerName(node), kind: vectorLayerKind(node), depth: depth, parentId: parentId,
                                       visible: node["visible"] != .bool(false), locked: truthy(node["locked"]), childCount: children.count, expanded: open))
            if open { visit(children, depth + 1, node.id) }
        }
    }
    visit(nodes, 0, nil)
    return rows
}
