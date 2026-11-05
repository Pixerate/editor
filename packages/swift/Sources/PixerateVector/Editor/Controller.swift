import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The vector editor's headless state (`VectorEditorController` in `vector/controller.ts`): the
// document, selection, tool, history and editing options the commands work on. It is ported
// method by method as the commands need it; pointer handling, the viewport and the features
// that are not ported yet (#624) are left out.
//
// The TS controller replaces its document object on every change and compares documents with
// `===`. The Swift document is a value, so "the document changed" is `!=` here: an edit that
// produces an equal document records no undo step where the TS would record an empty one.

/// An anchor of a path node: subpath `subpath`, anchor `index` (`VectorAnchorRef`).
public struct VectorAnchorRef: Equatable, Hashable, Sendable {
    public var nodeId: String
    public var subpath: Int
    public var index: Int

    public init(nodeId: String, subpath: Int, index: Int) {
        self.nodeId = nodeId
        self.subpath = subpath
        self.index = index
    }

    public var json: JSONValue {
        .object(JSONObject([("nodeId", .string(nodeId)), ("subpath", .number(Double(subpath))), ("index", .number(Double(index)))]))
    }
}

/// A segment of a path node: from anchor `segment` to the next (`VectorSegmentRef`).
public struct VectorSegmentRef: Equatable, Sendable {
    public var nodeId: String
    public var subpath: Int
    public var segment: Int

    public init(nodeId: String, subpath: Int, segment: Int) {
        self.nodeId = nodeId
        self.subpath = subpath
        self.segment = segment
    }
}

/// The path the pen tool is drawing.
public struct VectorPenState: Equatable, Sendable {
    public var nodeId: String
    public var subpath: Int
}

/// What an edit returns: `ok`, or why it did nothing (`VectorActionResult`).
public struct VectorActionResult: Equatable, Sendable {
    public var ok: Bool
    public var message: String?

    public static let success = VectorActionResult(ok: true, message: nil)
    public static func failure(_ message: String) -> VectorActionResult { VectorActionResult(ok: false, message: message) }
}

/// Where `addNode` puts a node (`AddVectorNodeOptions`).
public struct AddVectorNodeOptions: Sendable {
    /// A group to add into (default: the document).
    public var parentId: String?
    /// Index among the siblings (default: on top).
    public var index: Int?
    /// Select the new node (default true).
    public var select: Bool
    /// Undo step label.
    public var label: String?

    public init(parentId: String? = nil, index: Int? = nil, select: Bool = true, label: String? = nil) {
        self.parentId = parentId
        self.index = index
        self.select = select
        self.label = label
    }
}

/// The editor state an undo step puts back (`Snapshot`).
struct VectorSnapshot {
    var doc: VectorDocument
    var selection: [String]
    var anchors: [VectorAnchorRef]
    var editingId: String?
    var pen: VectorPenState?
}

/// Every vector tool, in toolbar order (`VECTOR_TOOLS`).
public let VECTOR_TOOLS = ["select", "direct", "pen", "pencil", "rect", "ellipse", "polygon", "star", "line", "scissors", "knife", "eraser", "width", "shapeBuilder", "paintBucket", "blend", "gradient", "envelope", "type", "typePath", "frame", "connector", "distort"]

/// Every field of `VectorStyle`, in the order style panels and commands list them (`VECTOR_STYLE_KEYS`).
public let VECTOR_STYLE_KEYS = ["fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "fillRule", "strokeAlign", "startArrow", "endArrow", "arrowAlign", "startArrowScale", "endArrowScale", "strokeWidthProfile", "fills", "strokes"]

/// The Distort Brush modes (`VECTOR_DISTORT_BRUSH_MODES`).
public let VECTOR_DISTORT_BRUSH_MODES = ["smudge", "twirl", "attract", "repel", "roughen"]

/// The defaults new shapes get (`DEFAULT_DEFAULTS`).
private let DEFAULT_DEFAULTS = JSONObject([
    ("fill", "#d4d4d8"), ("stroke", "#18181b"), ("strokeWidth", 2), ("polygonSides", 6), ("starPoints", 5), ("starInnerRatio", 0.5), ("cornerRadius", 0),
])

/// How deleting, dragging anchors, the pencil and the eraser behave (`DEFAULT_VECTOR_PATH_EDIT`).
private let DEFAULT_VECTOR_PATH_EDIT = JSONObject([
    ("keepShapeOnDelete", true), ("curvatureMoves", false), ("pencilSmoothing", 0), ("recognizeShapes", false), ("eraserSize", 10),
    ("distortMode", "smudge"), ("distortSize", 20), ("distortStrength", 0.5), ("pencilPressure", "pen"), ("fillGap", 0),
])

/// Smart guides and the grid (`DEFAULT_VECTOR_SNAP`).
private let DEFAULT_VECTOR_SNAP = JSONObject([
    ("grid", 0), ("objects", true), ("guides", true), ("threshold", 6), ("angles", .array([])),
])

nonisolated(unsafe) private var idCounter = 0

/// `vn-<time><counter>`, base 36 (the TS default `createId`).
private func defaultCreateId() -> String {
    idCounter += 1
    return "vn-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))\(String(idCounter, radix: 36))"
}

/**
 * Headless state for a vector editor (`VectorEditorController` in `vector/controller.ts`): a
 * document of paths and groups, the selection, the tool, undo (one step per change, as in TS),
 * the defaults new shapes get and the editing options. The commands (`createVectorCommands`) run
 * against it. Pointer and keyboard input, the viewport and the features marked not ported (#624)
 * are not part of this port yet.
 */
public final class VectorEditorController {
    public let history: HistoryManager
    var doc: VectorDocument
    var selection: [String] = []
    var anchors: [VectorAnchorRef] = []
    var editingId: String?
    var pen: VectorPenState?
    var tool: String
    var defaults: JSONObject
    var snap: JSONObject
    var editing: JSONObject
    let hitRadius: Double
    let zoom: Double = 1
    let createId: () -> String
    var applying = false
    var committing = false
    /// Bumped on every change listeners hear about.
    public private(set) var revision = 0
    private var listeners: [(id: UUID, fn: () -> Void)] = []

    /// - Parameters:
    ///   - document: the drawing to start with (default an 800 × 600 artboard).
    ///   - createId: makes node ids (default `vn-…`); the conformance host counts `n1`, `n2`, ….
    public init(document: VectorDocument? = nil, tool: String = "select", defaults: JSONObject = JSONObject(), editing: JSONObject = JSONObject(), hitRadius: Double = 6, history: HistoryManager? = nil, createId: (() -> String)? = nil) throws {
        self.history = history ?? HistoryManager()
        doc = try document.map(loadedDocument) ?? VectorDocument(width: 800, height: 600)
        self.tool = tool
        var d = DEFAULT_DEFAULTS
        for (k, v) in defaults { d[k] = v }
        self.defaults = d
        snap = DEFAULT_VECTOR_SNAP
        var e = DEFAULT_VECTOR_PATH_EDIT
        for (k, v) in editing { e[k] = v }
        self.editing = e
        self.hitRadius = hitRadius
        self.createId = createId ?? defaultCreateId
        doc = refreshed(doc)
    }

    // MARK: State

    /// The current document.
    public var document: VectorDocument { doc }
    /// Selected node ids, in selection order.
    public var selectedIds: [String] { selection }
    /// Selected anchors (Direct Select).
    public var selectedAnchors: [VectorAnchorRef] { anchors }
    /// The canvas tool.
    public var currentTool: String { tool }
    /// The editing options (`state.editing`).
    public var editingOptions: JSONObject { editing }
    /// The snapping options (`state.snap`).
    public var snapOptions: JSONObject { snap }
    /// The defaults new shapes get (`state.defaults`).
    public var shapeDefaults: JSONObject { defaults }

    public func getNode(_ id: String) -> VectorNode? { findVectorNode(doc.nodes, id) }

    /// Calls `listener` after every change. Returns a `Cancellable` that removes it.
    @discardableResult
    public func subscribe(_ listener: @escaping () -> Void) -> Cancellable {
        let id = UUID()
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    /// The document with its derived parts brought up to date (`refreshed`): shorthand fills and
    /// strokes go to the top layer of their stack, and lenses show what is below them. Blends,
    /// symbols, constraints, connectors and master pages are made only by commands that are not
    /// ported yet (#624), so there is nothing else to refresh.
    func refreshed(_ d: VectorDocument) -> VectorDocument {
        let nodes = normalizeVectorTree(d.nodes, prefer: "shorthand")
        var out = d
        if nodes != d.nodes { out.nodes = nodes }
        return resolveVectorLenses(out)
    }

    func notify() {
        let fresh = refreshed(doc)
        if fresh != doc { doc = fresh }
        revision += 1
        for l in listeners { l.fn() }
    }

    /// Local → document matrix of a node in `d` (default: the current document).
    func worldOf(_ id: String, _ d: VectorDocument? = nil) -> VectorMatrix {
        vectorWorldMatrix((d ?? doc).nodes, id) ?? IDENTITY_MATRIX
    }

    /// A document point in node `id`'s own space.
    func toLocal(_ id: String, _ p: Vec2, _ d: VectorDocument? = nil) -> Vec2 {
        applyMatrix(invertMatrix(worldOf(id, d)), p)
    }

    /// The pick distance in document units.
    func tolerance() -> Double { hitRadius / zoom }

    // MARK: Undoable changes

    func snapshot() -> VectorSnapshot {
        VectorSnapshot(doc: doc, selection: selection, anchors: anchors, editingId: editingId, pen: pen)
    }

    func restore(_ s: VectorSnapshot) {
        committing = false
        applying = true
        doc = s.doc
        selection = s.selection.filter { getNode($0) != nil }
        anchors = s.anchors.filter { getAnchor(doc, $0) != nil }
        editingId = s.editingId.flatMap { getNode($0) != nil ? $0 : nil }
        if let p = s.pen, let n = getNode(p.nodeId), n.isPath, n.subpaths.indices.contains(p.subpath) { pen = p } else { pen = nil }
        applying = false
        notify()
    }

    /// Records the change from `before` to the current state as one undo step.
    func commit(_ name: String, _ before: VectorSnapshot) {
        doc = refreshed(doc)
        let after = snapshot()
        if before.doc == after.doc {
            notify()
            return
        }
        let command = Command(name: name, execute: { [weak self] in self?.restore(after) }, undo: { [weak self] in self?.restore(before) }, redo: { [weak self] in self?.restore(after) })
        committing = true
        history.execute(command)
        committing = false
    }

    /// Runs `fn` (which updates fields) and records it as one undo step. When `fn` throws, the
    /// state is put back and nothing is recorded.
    func change(_ name: String, _ fn: () throws -> Void) rethrows {
        let before = snapshot()
        do {
            try fn()
        } catch {
            doc = before.doc
            selection = before.selection
            anchors = before.anchors
            editingId = before.editingId
            pen = before.pen
            throw error
        }
        commit(name, before)
    }

    func setDoc(_ nodes: [VectorNode]) {
        if nodes != doc.nodes { doc.nodes = nodes }
    }

    func replaceNode(_ id: String, _ next: VectorNode?) throws {
        setDoc(mapTree(doc.nodes) { $0.id == id ? next : $0 })
    }

    /// A copy of `node` with fresh ids for it and everything inside it.
    func freshIds(_ node: VectorNode) throws -> VectorNode {
        var copy = try cloneVectorNode(node)
        var used = Set<String>()
        walkVectorNodes(doc.nodes) { n, _, _ in used.insert(n.id) }
        func next() -> String {
            var id = createId()
            while used.contains(id) { id = createId() }
            used.insert(id)
            return id
        }
        func assign(_ n: inout VectorNode) {
            n.id = next()
            if n.isGroup { for i in n.children.indices { assign(&n.children[i]) } }
        }
        assign(&copy)
        return copy
    }

    func newId() -> String {
        var id = createId()
        while getNode(id) != nil { id = createId() }
        return id
    }

    @discardableResult
    public func undo() -> Bool { history.undo() }

    @discardableResult
    public func redo() -> Bool { history.redo() }

    // MARK: Settings

    /// Switches the canvas tool.
    public func setTool(_ next: String) {
        if next == tool { return }
        finishPath()
        tool = next
        if next != "direct" {
            anchors = []
            editingId = nil
        }
        notify()
    }

    /// Ends the path the pen is drawing.
    func finishPath() {
        pen = nil
    }

    /// Changes how deleting, dragging anchors, the pencil and the eraser behave (`setEditing`).
    public func setEditing(_ patch: JSONObject) {
        var next = editing
        for (k, v) in patch { next[k] = v }
        let smoothing = next["pencilSmoothing"]?.numberValue ?? .nan
        next["pencilSmoothing"] = .number(JS.min(1, JS.max(0, smoothing.isFinite ? smoothing : 0)))
        if !((next["eraserSize"]?.numberValue ?? .nan) > 0) { next["eraserSize"] = editing["eraserSize"] }
        if !VECTOR_DISTORT_BRUSH_MODES.contains(next["distortMode"]?.stringValue ?? "") { next["distortMode"] = editing["distortMode"] }
        if !((next["distortSize"]?.numberValue ?? .nan) > 0) { next["distortSize"] = editing["distortSize"] }
        let strength = next["distortStrength"]?.numberValue ?? .nan
        next["distortStrength"] = .number(JS.min(1, JS.max(0, strength.isFinite ? strength : editing["distortStrength"]!.numberValue!)))
        editing = next
        notify()
    }

    var keepShapeOnDelete: Bool { editing["keepShapeOnDelete"]?.boolValue ?? true }
    var curvatureMoves: Bool { editing["curvatureMoves"]?.boolValue ?? false }
    var eraserSize: Double { editing["eraserSize"]?.numberValue ?? 10 }

    // MARK: Selection

    public func select(_ ids: [String], add: Bool = false, toggle: Bool = false) {
        let valid = ids.filter { getNode($0) != nil }
        var next: [String]
        if toggle {
            var set = selection
            for id in valid {
                if let i = set.firstIndex(of: id) { set.remove(at: i) } else { set.append(id) }
            }
            next = set
        } else if add {
            next = []
            for id in selection + valid where !next.contains(id) { next.append(id) }
        } else {
            next = valid
        }
        selection = next
        if !add && !toggle { anchors = anchors.filter { next.contains($0.nodeId) } }
        notify()
    }

    public func clearSelection() {
        if selection.isEmpty && anchors.isEmpty && editingId == nil { return }
        selection = []
        anchors = []
        editingId = nil
        notify()
    }

    /// Top-level ids of the selection (members of selected groups are covered by the group).
    func selectedRoots() -> [String] {
        selection.filter { id in
            var covered = false
            var parent = locateVectorNode(doc.nodes, id)?.parent
            while let p = parent {
                if selection.contains(p.id) { covered = true }
                parent = locateVectorNode(doc.nodes, p.id)?.parent
            }
            return !covered
        }
    }

    /// Clears anchor selections, editing and pen state that no longer point at anything.
    func dropStaleRefs() {
        selection = selection.filter { getNode($0) != nil }
        anchors = anchors.filter { getAnchor(doc, $0) != nil }
        if let e = editingId, getNode(e) == nil { editingId = nil }
        if let p = pen, getNode(p.nodeId) == nil { pen = nil }
    }

    // MARK: Document

    /// The document as saved (`toJSON`): a copy.
    public func toJSON() throws -> VectorDocument { try cloneVectorDocument(stripVectorLensViews(doc)) }

    /// The `pixerate.editor-document` envelope of kind `vector` (`createVectorEditorDocument`).
    public func editorDocument() throws -> JSONValue {
        EditorDocumentFile(kind: "vector", formatVersion: 1, document: try toJSON().toJSON()).json
    }
}

// MARK: - Tree helpers

/// `nodes` with `fn` applied to every node, depth first (a nil result removes the node; a group's
/// children are visited after `fn` returns it).
func mapTree(_ nodes: [VectorNode], _ fn: (VectorNode) throws -> VectorNode?) rethrows -> [VectorNode] {
    var out: [VectorNode] = []
    for node in nodes {
        guard var next = try fn(node) else { continue }
        if next.isGroup {
            let children = try mapTree(next.children, fn)
            if children != next.children { next.children = children }
        }
        out.append(next)
    }
    return out
}

/// Replaces node `id` anywhere in the tree with `replacements` (none removes it).
func spliceTree(_ nodes: [VectorNode], _ id: String, _ replacements: [VectorNode]) -> [VectorNode] {
    var out: [VectorNode] = []
    for node in nodes {
        if node.id == id {
            out += replacements
            continue
        }
        if node.isGroup {
            let children = spliceTree(node.children, id, replacements)
            if children != node.children {
                var n = node
                n.children = children
                out.append(n)
                continue
            }
        }
        out.append(node)
    }
    return out
}

/// The anchor `ref` points at, if any (`getAnchor`).
public func getAnchor(_ doc: VectorDocument, _ ref: VectorAnchorRef) -> VectorAnchor? {
    guard let node = findVectorNode(doc.nodes, ref.nodeId), node.isPath, node.subpaths.indices.contains(ref.subpath) else { return nil }
    let sp = node.subpaths[ref.subpath]
    return sp.anchors.indices.contains(ref.index) ? sp.anchors[ref.index] : nil
}

/// An anchor's position in document space (its node's transforms applied; `getAnchorWorld`).
public func getAnchorWorld(_ doc: VectorDocument, _ ref: VectorAnchorRef) -> Vec2? {
    guard let a = getAnchor(doc, ref) else { return nil }
    let m = vectorWorldMatrix(doc.nodes, ref.nodeId) ?? IDENTITY_MATRIX
    return applyMatrix(m, Vec2(a.x, a.y))
}

/// Paths (and text) with their fill and stroke stacks reconciled (`normalizeVectorTree`).
func normalizeVectorTree(_ nodes: [VectorNode], prefer: String) -> [VectorNode] {
    nodes.map { n in
        var next = n.isPath || n.isText ? normalizeVectorPaintStacks(n, prefer: prefer) : n
        if next.isGroup {
            let children = normalizeVectorTree(next.children, prefer: prefer)
            if children != next.children { next.children = children }
        }
        return next
    }
}

/// A document as loaded (`loadedDocument`): a copy, stacks preferred over stale shorthands.
func loadedDocument(_ d: VectorDocument) throws -> VectorDocument {
    var copy = try cloneVectorDocument(d)
    copy.nodes = normalizeVectorTree(copy.nodes, prefer: "stack")
    return copy
}

/// `Math.round(n * 100) / 100`.
@inline(__always) func round2(_ n: Double) -> Double { JS.round(n * 100) / 100 }

/// A thrown sentence, as the TS commands `fail` with (`throw new Error(message)`).
public struct VectorEditorError: Error, LocalizedError, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}
