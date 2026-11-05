import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// Boolean operations, Pathfinder, the Shape Builder and the paint bucket (`vector/controller.ts`
// and `vector/builder.ts`). Everything works in document space: each path is mapped through its
// own transform and its parents', with live corners cut; results are mapped back into the space
// of the node that receives them.

private let BOOLEAN_OPS: [String: PathBooleanOperation] = ["union": .union, "subtract": .difference, "intersect": .intersection, "exclude": .xor]
private let BOOLEAN_LABELS = ["union": "Union", "subtract": "Subtract", "intersect": "Intersect", "exclude": "Exclude"]

/// Names of the Pathfinder operations (`VECTOR_PATHFINDER_LABELS`).
public let VECTOR_PATHFINDER_LABELS = ["divide": "Divide", "trim": "Trim", "merge": "Merge", "crop": "Crop", "outline": "Outline", "minusBack": "Minus Back"]

/// The result of a Shape Builder gesture (`VectorShapeBuilderResult`).
public struct VectorShapeBuilderResult: Sendable {
    public var ok: Bool
    public var message: String?
    /// The merged shape's id, when one was made.
    public var merged: String?
    public var faces: Int
    public var lines: Int
    public var edges: Int

    static func none(_ message: String) -> VectorShapeBuilderResult { VectorShapeBuilderResult(ok: false, message: message, merged: nil, faces: 0, lines: 0, edges: 0) }
}

// MARK: - Path entries (`builder.ts`)

/// A path node with the matrix of its parent space (parent → document).
struct VectorPathEntry {
    var node: VectorNode
    var parent: VectorMatrix
}

/// The path nodes inside `roots` (every node when nil), bottom to top, with their parent matrices
/// (`vectorPathEntries`). Hidden nodes are skipped, and locked ones unless `locked`; live nodes
/// take part as drawn unless `expand` is false.
func vectorPathEntries(_ doc: VectorDocument, _ roots: [String]?, locked: Bool = false, expand: Bool = true) throws -> [VectorPathEntry] {
    var out: [VectorPathEntry] = []
    func visit(_ stored: VectorNode, _ parent: VectorMatrix, _ inside: Bool) throws {
        if !stored.isVisible || (stored.isLocked && !locked) { return }
        // As drawn: effects and live booleans evaluated, mask groups as their masked shapes.
        let node = expand ? try expandVectorAppearance(try vectorMaskedGeometry(stored)) : stored
        let picked = inside || roots == nil || roots!.contains(node.id)
        if node.isGroup {
            let m = multiplyMatrices(nodeMatrix(node), parent)
            for c in node.children { try visit(c, m, picked) }
        } else if picked && node.isPath {
            out.append(VectorPathEntry(node: node, parent: parent))
        }
    }
    for n in doc.nodes { try visit(n, IDENTITY_MATRIX, false) }
    return out
}

private func usable(_ sp: VectorSubpath) -> Bool { sp.anchors.count > 1 }

/// The entry's outline in document space with the given subpaths.
private func entryWorld(_ entry: VectorPathEntry, _ subpaths: [VectorSubpath]) throws -> BezierPath {
    var n = entry.node
    n.subpaths = subpaths
    return try vectorPathWorldBezier(n, entry.parent)
}

private func closedCopy(_ sp: VectorSubpath) -> VectorSubpath {
    var c = sp
    c.closed = true
    return c
}

private func fillRuleOf(_ node: VectorNode) -> PolygonFillRule { PolygonFillRule(rawValue: node.fillRule ?? "nonzero") ?? .nonzero }

/// Whether a subpath, closed, encloses an area (rather than retracing itself).
func subpathEnclosesArea(_ sp: VectorSubpath) -> Bool {
    guard let contour = pathToContours(.commands(subpathsToBezier([closedCopy(sp)]))).first else { return false }
    let segs = closeContour(contour, true)
    guard let b = bezierPathBounds(.commands(contoursToPath([BezierContour(segments: segs, closed: true)]))) else { return false }
    let w = b.maxX - b.minX
    let h = b.maxY - b.minY
    return abs(contourSignedArea(segs)) > 1e-9 * (w * w + h * h)
}

/// `paintKey`: a colour trimmed and lower-cased, anything else as JSON.
private func paintKey(_ paint: JSONValue?) -> String {
    if let s = paint?.stringValue { return s.jsTrimmed.jsLowercased }
    return (paint ?? .null).stringified()
}

/// How an operand takes part in a Pathfinder operation.
enum VectorPathfinderPaint: String {
    case fill, stroke, line, outline
}

/// The Pathfinder shape of a path (document space), and what it stands for.
private func vectorPathfinderShape(_ entry: VectorPathEntry, _ op: String) throws -> (shape: PathfinderShape, paint: VectorPathfinderPaint) {
    let node = entry.node
    let subpaths = node.subpaths.filter(usable)
    let closed = subpaths.map(closedCopy)
    let rule = fillRuleOf(node)
    if hasPaint(node.fill) { return (PathfinderShape(path: .commands(try entryWorld(entry, closed)), fillRule: rule, key: .string("fill:\(paintKey(node.fill))")), .fill) }
    let open = !subpaths.isEmpty && subpaths.allSatisfy { !$0.closed }
    if op == "divide" && open { return (PathfinderShape(path: .commands(try entryWorld(entry, subpaths)), line: true), .line) }
    if hasPaint(node.stroke) && (node.strokeWidth ?? 1) > 0 {
        // not ported yet: a stroke's painted area (vectorStrokeOutline) (#624)
        throw VectorNotPorted("Pathfinder on unfilled stroked paths (vectorStrokeOutline)")
    }
    return (PathfinderShape(path: .commands(try entryWorld(entry, closed)), fillRule: rule, key: .string("none")), .outline)
}

private let STROKE_KEYS = ["stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeAlign", "startArrow", "endArrow", "arrowAlign", "startArrowScale", "endArrowScale", "strokeWidthProfile"]

/// Style of a Pathfinder or Shape Builder result taken from `node` (`vectorResultStyle`).
func vectorResultStyle(_ node: VectorNode, _ paint: VectorPathfinderPaint, edge: Bool = false) -> JSONObject {
    var base = JSONObject()
    for k in node.keys where !["id", "subpaths", "transform", "effects", "booleanOperation"].contains(k) { base[k] = node[k] }
    base["fillRule"] = "nonzero"
    if edge {
        for k in STROKE_KEYS { base[k] = Optional<JSONValue>.none }
        let stroke = paint == .stroke || !hasPaint(node.fill) ? node.stroke : node.fill
        base["fill"] = .null
        base["stroke"] = stroke ?? "#000000"
        base["strokeWidth"] = .number(node.strokeWidth ?? 1)
        return base
    }
    if paint == .stroke {
        for k in STROKE_KEYS { base[k] = Optional<JSONValue>.none }
        base["fill"] = node.stroke ?? .null
        base["stroke"] = .null
        return base
    }
    return base
}

// MARK: - Shape Builder map

/// A run of a path between the points where other paths meet it.
struct VectorBuilderLinePiece {
    var path: BezierPath
    var chain: PlanarChain
    var bounds: PathBounds
    var source: Int { chain.source }
}

/// The Shape Builder's planar map of a set of paths (`VectorShapeBuilderMap`).
final class VectorShapeBuilderMap {
    let entries: [VectorPathEntry]
    let map: PlanarMap
    /// Entries with no closed subpath (cutting lines).
    let lines: [Bool]
    let tolerance: Double
    private var chainCache: [PlanarChain]?
    private(set) lazy var pieces: [VectorBuilderLinePiece] = lines.contains(true) ? runs(true) : []
    /// The edges of the other entries' outlines, cut where paths meet.
    private(set) lazy var edges: [VectorBuilderLinePiece] = runs(false)

    init(entries: [VectorPathEntry], map: PlanarMap, lines: [Bool], tolerance: Double) {
        self.entries = entries
        self.map = map
        self.lines = lines
        self.tolerance = tolerance
    }

    private func runs(_ line: Bool) -> [VectorBuilderLinePiece] {
        if chainCache == nil { chainCache = map.chains() }
        return chainCache!.filter { lines[$0.source] == line && !(line && $0.closed) }.map { c in
            let path = contoursToPath([BezierContour(segments: c.segments, closed: c.closed)])
            return VectorBuilderLinePiece(path: path, chain: c, bounds: bezierPathBounds(.commands(path))!)
        }
    }
}

/// The Shape Builder map of `entries` (bottom to top), or nil (`vectorShapeBuilderMap`).
func vectorShapeBuilderMap(_ entries: [VectorPathEntry]) throws -> VectorShapeBuilderMap? {
    var lines: [Bool] = []
    var inputs: [PlanarInput] = []
    var paths: [BezierPath] = []
    for entry in entries {
        let filled = hasPaint(entry.node.fill)
        let subpaths = entry.node.subpaths.filter(usable).map { sp in !sp.closed && filled && subpathEnclosesArea(sp) ? closedCopy(sp) : sp }
        lines.append(!subpaths.contains { $0.closed })
        let path = try entryWorld(entry, subpaths)
        paths.append(path)
        inputs.append(PlanarInput(path: .commands(path), fillRule: fillRuleOf(entry.node)))
    }
    guard let map = PlanarMap.build(inputs) else { return nil }
    var size = 0.0
    for p in paths { if let b = bezierPathBounds(.commands(p)) { size = JS.max(size, JS.max(b.maxX - b.minX, b.maxY - b.minY)) } }
    return VectorShapeBuilderMap(entries: entries, map: map, lines: lines, tolerance: 0.2 * JS.max(size / 2000, 0.25))
}

/// What a Shape Builder gesture touches at a point.
enum VectorBuilderHit {
    case face(Int), line(Int), edge(Int)
}

/// The faces, line pieces and edges a gesture touched, in the order touched.
struct VectorBuilderTouched {
    var faces: [Int] = []
    var lines: [Int] = []
    var edges: [Int] = []
}

private func pieceNear(_ pieces: [VectorBuilderLinePiece], _ p: Vec2, _ tol: Double) -> (index: Int, d: Double)? {
    var best: (index: Int, d: Double)?
    for (index, piece) in pieces.enumerated() {
        let b = piece.bounds
        if p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol { continue }
        let d = distanceToBezierPath(.commands(piece.path), PathPoint(p.x, p.y))
        if d <= tol && (best == nil || d < best!.d) { best = (index, d) }
    }
    return best
}

/// The face under `p`, or (erasing) first the nearer of the line piece and outline edge that close.
func vectorShapeBuilderHit(_ m: VectorShapeBuilderMap, _ p: Vec2, _ lineTolerance: Double?) -> VectorBuilderHit? {
    if let tol = lineTolerance, tol > 0 {
        let line = pieceNear(m.pieces, p, tol)
        let edge = pieceNear(m.edges, p, tol)
        if let edge, line == nil || edge.d < line!.d { return .edge(edge.index) }
        if let line { return .line(line.index) }
    }
    let face = m.map.faceAt(PathPoint(p.x, p.y))
    return face >= 0 ? .face(face) : nil
}

/// Points along a polyline no more than `step` apart.
func samplePolyline(_ points: [Vec2], _ step: Double) -> [Vec2] {
    var out: [Vec2] = []
    let s = JS.max(step, 1e-3)
    for (i, p) in points.enumerated() {
        if i > 0 {
            let a = points[i - 1]
            let n = Int(JS.min(4000, JS.ceil(JS.hypot(p.x - a.x, p.y - a.y) / s)))
            if n > 1 { for k in 1 ..< n { out.append(Vec2(a.x + ((p.x - a.x) * Double(k)) / Double(n), a.y + ((p.y - a.y) * Double(k)) / Double(n))) } }
        }
        out.append(p)
    }
    return out
}

/// Adds what a point hits to `touched` (each face or piece once).
@discardableResult
func addBuilderHit(_ touched: inout VectorBuilderTouched, _ hit: VectorBuilderHit?) -> Bool {
    guard let hit else { return false }
    switch hit {
    case .face(let i):
        if touched.faces.contains(i) { return false }
        touched.faces.append(i)
    case .line(let i):
        if touched.lines.contains(i) { return false }
        touched.lines.append(i)
    case .edge(let i):
        if touched.edges.contains(i) { return false }
        touched.edges.append(i)
    }
    return true
}

/// The faces just either side of the middle of a line piece (-1 outside every face).
private func sides(_ m: VectorShapeBuilderMap, _ piece: VectorBuilderLinePiece) -> [Int] {
    let segs = piece.chain.segments
    let seg = segs[segs.count / 2]
    let mid = segmentPoint(seg, 0.5)
    let t = segmentTangent(seg, 0.5)
    let chord = JS.hypot(seg[seg.count - 1][0] - seg[0][0], seg[seg.count - 1][1] - seg[0][1])
    let off = JS.max(1e-6, JS.min(0.05, 0.05 * chord))
    return [m.map.faceAt(PathPoint(mid[0] - t[1] * off, mid[1] + t[0] * off)), m.map.faceAt(PathPoint(mid[0] + t[1] * off, mid[1] - t[0] * off))]
}

/// The edges a gesture deletes: those it touched that bound none of the faces it touched.
func vectorBuilderErasedEdges(_ m: VectorShapeBuilderMap, _ touched: VectorBuilderTouched) -> [Int] {
    if touched.edges.isEmpty { return [] }
    let faces = Set(touched.faces)
    return touched.edges.filter { k in k < m.edges.count && !sides(m, m.edges[k]).contains { $0 >= 0 && faces.contains($0) } }
}

/// What becomes of one entry (`VectorBuilderReplacement`); nil in the plan removes it.
enum VectorBuilderReplacement {
    case fill(BezierPath), outline(BezierPath), pieces([BezierPath])
}

struct VectorShapeBuilderPlan {
    /// Entry index → its replacement (`.some(nil)` removes it).
    var replace: [Int: VectorBuilderReplacement?] = [:]
    var merged: (path: BezierPath, style: Int, currentFill: Bool)?
}

/// What a gesture does (`planShapeBuilder`).
func planShapeBuilder(_ m: VectorShapeBuilderMap, _ touched: VectorBuilderTouched, _ erase: Bool) throws -> VectorShapeBuilderPlan {
    var plan = VectorShapeBuilderPlan()
    let picked = Set(touched.faces)
    let faces = m.map.faces
    let sourcesOf = faces.indices.map { m.map.faceSources($0) }
    let cuts = erase ? vectorBuilderErasedEdges(m, touched).map { m.edges[$0] } : []
    for (i, entry) in m.entries.enumerated() {
        if m.lines[i] {
            let own = m.pieces.indices.filter { m.pieces[$0].source == i }
            let keep = own.filter { k in !touched.lines.contains(k) && !sides(m, m.pieces[k]).allSatisfy { $0 >= 0 && picked.contains($0) } }
            if keep.count == own.count { continue }
            plan.replace[i] = .some(keep.isEmpty ? nil : .pieces(keep.map { m.pieces[$0].path }))
            continue
        }
        let inUnion = touched.faces.contains { sourcesOf[$0].contains(i) }
        if !inUnion && cuts.isEmpty { continue }
        var rest: BezierPath
        if inUnion {
            let kept = faces.indices.filter { sourcesOf[$0].contains(i) && !picked.contains($0) }
            rest = kept.isEmpty ? [] : m.map.merge(kept)
        } else {
            rest = try entryWorld(entry, entry.node.subpaths.filter(usable))
        }
        let fillCloses = hasPaint(entry.node.fill)
        var cut = false
        for piece in cuts {
            if !rest.isEmpty, let r = cutOutPiece(.commands(rest), piece.chain, fillCloses, m.tolerance) {
                rest = r
                cut = true
            }
        }
        if !inUnion && !cut { continue }
        plan.replace[i] = .some(rest.isEmpty ? nil : (inUnion ? .fill(rest) : .outline(rest)))
    }
    if !erase && !touched.faces.isEmpty {
        let path = m.map.merge(touched.faces)
        let covered = touched.faces.map { sourcesOf[$0] }.first { !$0.isEmpty }
        let lastShape = m.lines.lastIndex(of: false) ?? -1
        let style = covered.map { $0[$0.count - 1] } ?? (lastShape >= 0 ? lastShape : m.entries.count - 1)
        if !path.isEmpty { plan.merged = (path, style, covered == nil) }
    }
    return plan
}

extension VectorEditorController {
    // MARK: Booleans

    /// Whether stored node `rootId` holds `id` as drawn (`id` may be an expanded path inside it).
    private func holds(_ rootId: String, _ id: String) throws -> Bool {
        guard let n = getNode(rootId) else { return false }
        if findVectorNode([n], id) != nil { return true }
        if findVectorNode([try expandVectorAppearance(n)], id) != nil { return true }
        return findVectorNode([try vectorMaskedGeometry(n)], id) != nil
    }

    /// A document-space path mapped into the parent space of node `id`.
    func intoParentSpace(_ id: String, _ path: BezierPath) -> BezierPath {
        let parent = vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX
        return isRootMatrix(parent) ? path : transformBezierPath(.commands(path), invertMatrix(parent).tuple)
    }

    /// Combines the selected (or given) paths with a boolean operation (`booleanOp`); with `live`
    /// they stay editable operands of a live boolean group. Returns the result's id, or nil.
    public func booleanOp(_ op: String, ids: [String]? = nil, live: Bool = false) throws -> String? {
        let roots = ids ?? selectedRoots()
        if live { return try liveBooleanOp(op, roots) }
        let entries = try vectorPathEntries(doc, roots, locked: true)
        if entries.count < 2 { return nil }
        let operands = try entries.map { e -> PathOperand in
            var n = e.node
            n.subpaths = e.node.subpaths.filter { $0.anchors.count > 1 }.map(closedCopy)
            return PathOperand(.commands(try vectorPathWorldBezier(n, e.parent)), fillRule: fillRuleOf(e.node))
        }
        let result = try pathBoolean(BOOLEAN_OPS[op] ?? .union, operands)
        let base = entries[0].node
        let anchorRoot = try roots.first { try holds($0, base.id) } ?? base.id
        let subpaths = bezierToSubpaths(.commands(intoParentSpace(anchorRoot, result.path)))
        if result.report.error != nil || subpaths.isEmpty { return nil }
        let id = newId()
        var node = try cloneVectorNode(base)
        for k in ["transform", "effects", "booleanOperation"] { node[k] = Optional<JSONValue>.none }
        node.id = id
        node.name = BOOLEAN_LABELS[op] ?? op
        node.subpaths = subpaths
        let drop = Set(entries.map(\.node.id) + roots)
        change(BOOLEAN_LABELS[op] ?? op) {
            setDoc(mapTree(doc.nodes) { n in n.id == anchorRoot ? node : drop.contains(n.id) ? nil : n })
            selection = [id]
            anchors = []
            editingId = nil
        }
        return id
    }

    private func liveBooleanOp(_ op: String, _ roots: [String]) throws -> String? {
        let nodes = roots.map { getNode($0) }
        if nodes.isEmpty || nodes.contains(where: { $0 == nil }) { return nil }
        let label = "Live \(BOOLEAN_LABELS[op] ?? op)"
        func withoutOperation(_ c: VectorNode) -> VectorNode {
            guard truthy(c["booleanOperation"]) else { return c }
            var r = c
            r["booleanOperation"] = Optional<JSONValue>.none
            return r
        }
        if nodes.count == 1, let lone = nodes[0], isVectorLiveBoolean(lone) {
            var next = lone
            next["liveBoolean"] = .string(op)
            next.children = lone.children.map(withoutOperation)
            try change(label) { try replaceNode(lone.id, next) }
            return lone.id
        }
        let parents = roots.map { locateVectorNode(doc.nodes, $0)?.parent }
        if parents.allSatisfy({ isVectorLiveBoolean($0) }) {
            let set = Set(roots)
            change(label) {
                setDoc(mapTree(doc.nodes) { n in
                    guard n.isGroup, truthy(n["liveBoolean"]), n.children.contains(where: { set.contains($0.id) }) else { return n }
                    var group = n
                    group.children = n.children.map { c in
                        guard set.contains(c.id) else { return c }
                        var rest = c
                        rest["booleanOperation"] = Optional<JSONValue>.none
                        if op != n["liveBoolean"]?.stringValue { rest["booleanOperation"] = .string(op) }
                        return rest
                    }
                    return group
                })
            }
            return parents[0]!.id
        }
        if nodes.count < 2 { return nil }
        let parent = parents[0]?.id
        if parents.contains(where: { $0?.id != parent }) { return nil }
        let id = newId()
        change(label) {
            let set = Set(roots)
            func wrap(_ list: [VectorNode]) -> [VectorNode] {
                let members = list.filter { set.contains($0.id) }.map(withoutOperation)
                let top = list.indices.map { set.contains(list[$0].id) ? $0 : -1 }.max() ?? -1
                var out: [VectorNode] = []
                for (i, n) in list.enumerated() {
                    if i == top { out.append(VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(BOOLEAN_LABELS[op] ?? op)), ("liveBoolean", .string(op))]), children: members)) }
                    if !set.contains(n.id) { out.append(n) }
                }
                return out
            }
            if let parent {
                setDoc(mapTree(doc.nodes) { n in
                    guard n.id == parent, n.isGroup else { return n }
                    var g = n
                    g.children = wrap(n.children)
                    return g
                })
            } else {
                setDoc(wrap(doc.nodes))
            }
            selection = [id]
            anchors = []
            editingId = nil
        }
        return id
    }

    // MARK: Pathfinder

    /// Pathfinder over the selected (or given) paths, in document space. The results replace the
    /// operands at the place of the top-most one, grouped when there are several. Returns the new
    /// path ids (empty when nothing came out).
    public func pathfinder(_ op: String, ids: [String]? = nil) throws -> [String] {
        guard let operation = PathfinderOperation(rawValue: op) else { return [] }
        let roots = ids ?? selectedRoots()
        let entries = try vectorPathEntries(doc, roots)
        if entries.count < (op == "divide" || op == "outline" ? 1 : 2) { return [] }
        let shapes = try entries.map { try vectorPathfinderShape($0, op) }
        let result = try PixerateGeometry.pathfinder(operation, shapes.map(\.shape))
        if result.report.error != nil || result.pieces.isEmpty { return [] }
        let last = entries[entries.count - 1].node.id
        let topRoot = try roots.reversed().first { try holds($0, last) } ?? last
        var nodes: [VectorNode] = []
        for piece in result.pieces {
            let subpaths = bezierToSubpaths(.commands(intoParentSpace(topRoot, piece.path))).map { sp -> VectorSubpath in
                guard piece.open == true else { return sp }
                var o = sp
                o.closed = false
                return o
            }
            if subpaths.isEmpty { continue }
            let source = entries[piece.source].node
            var props = vectorResultStyle(source, shapes[piece.source].paint, edge: op == "outline")
            props["type"] = "path"
            props["id"] = .string(newId())
            props["name"] = .string(source.name ?? "Path")
            nodes.append(VectorNode(props: props, subpaths: subpaths))
        }
        if nodes.isEmpty { return [] }
        let label = VECTOR_PATHFINDER_LABELS[op]!
        let container = nodes.count > 1 ? VectorNode(props: JSONObject([("id", .string(newId())), ("type", "group"), ("name", .string(label))]), children: nodes) : nodes[0]
        let drop = Set(entries.map(\.node.id) + roots)
        change(label) {
            setDoc(mapTree(doc.nodes) { n in n.id == topRoot ? container : drop.contains(n.id) ? nil : n })
            selection = [container.id]
            anchors = []
            editingId = nil
        }
        return nodes.map(\.id)
    }

    // MARK: Shape Builder

    private func shapeBuilderMap(_ ids: [String]?) throws -> VectorShapeBuilderMap? {
        let roots = ids ?? selectedRoots()
        // The Shape Builder edits the shapes it takes area from: their stored geometry.
        let entries = roots.isEmpty ? [] : try vectorPathEntries(doc, roots, expand: false)
        return entries.isEmpty ? nil : try vectorShapeBuilderMap(entries)
    }

    /// The faces the Shape Builder offers for the selected (or given) paths (document units):
    /// `{ index, d, area, sources, point }`.
    public func getShapeBuilderFaces(ids: [String]? = nil) throws -> [JSONValue] {
        guard let m = try shapeBuilderMap(ids) else { return [] }
        return m.map.faces.enumerated().map { index, f in
            let p = m.map.faceInterior(index)
            return .object(JSONObject([
                ("index", .number(Double(index))),
                ("d", .string(bezierPathToSvg(.commands(f.path), BezierPathToSvgOptions(precision: 3)))),
                ("area", .number(f.area)),
                ("sources", .array(m.map.faceSources(index).map { .string(m.entries[$0].node.id) })),
                ("point", p.map { Vec2($0[0], $0[1]).json } ?? .null),
            ]))
        }
    }

    /// Pick distance of the Shape Builder's erase for line pieces (document units).
    private func builderLineTolerance() -> Double { JS.max(hitRadius, 4) / zoom }

    /// Shape Builder gesture along `points` (document units; one point is a click) over the faces
    /// the selected (or given) paths make: merges the faces touched, or with `erase` deletes them.
    public func shapeBuilder(_ points: [Vec2], ids: [String]? = nil, erase: Bool = false, tolerance: Double? = nil) throws -> VectorShapeBuilderResult {
        if points.isEmpty || !points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) { return .none("Give the points of the gesture.") }
        guard let m = try shapeBuilderMap(ids) else { return .none("Select paths that make faces.") }
        let tol = erase ? (tolerance ?? builderLineTolerance()) : nil
        var touched = VectorBuilderTouched()
        let size = m.map.faces.reduce(1.0) { JS.max($0, JS.max($1.bounds.maxX - $1.bounds.minX, $1.bounds.maxY - $1.bounds.minY)) }
        for p in samplePolyline(points, JS.max(size / 2000, 0.25 / zoom)) { addBuilderHit(&touched, vectorShapeBuilderHit(m, p, tol)) }
        if touched.faces.isEmpty && touched.lines.isEmpty && touched.edges.isEmpty { return .none("There is no face under the pointer.") }
        return try applyShapeBuilder(m, touched, erase)
    }

    private func applyShapeBuilder(_ m: VectorShapeBuilderMap, _ touched: VectorBuilderTouched, _ erase: Bool) throws -> VectorShapeBuilderResult {
        let plan = try planShapeBuilder(m, touched, erase)
        var mergedId: String?
        var created: [String: [String]] = [:]
        change(erase ? "Shape Builder Delete" : "Shape Builder") {
            var nodes = doc.nodes
            for (i, entry) in m.entries.enumerated() {
                let node = entry.node
                let inv = invertMatrix(multiplyMatrices(nodeMatrix(node), entry.parent))
                func toLocal(_ path: BezierPath) -> BezierPath { transformBezierPath(.commands(path), inv.tuple) }
                var list: [VectorNode] = []
                let r = plan.replace[i]
                switch r {
                case .none: list.append(node)
                case .some(.some(.fill(let path))):
                    var n = node
                    n.fillRule = "nonzero"
                    n.subpaths = bezierToSubpaths(.commands(toLocal(path)))
                    list.append(n)
                case .some(.some(.outline(let path))):
                    var n = node
                    n.subpaths = bezierToSubpaths(.commands(toLocal(path)))
                    list.append(n)
                case .some(.some(.pieces(let paths))):
                    for (k, path) in paths.enumerated() {
                        var n = node
                        n.id = k == 0 ? node.id : newId()
                        n.subpaths = bezierToSubpaths(.commands(toLocal(path))).map { sp in
                            var o = sp
                            o.closed = false
                            return o
                        }
                        list.append(n)
                    }
                case .some(.none): break
                }
                if let merged = plan.merged, merged.style == i {
                    let id = newId()
                    mergedId = id
                    var props = vectorResultStyle(node, .fill)
                    props["type"] = "path"
                    props["id"] = .string(id)
                    props["name"] = "Shape"
                    if truthy(node["transform"]) { props["transform"] = node["transform"] }
                    var n = VectorNode(props: props, subpaths: bezierToSubpaths(.commands(toLocal(merged.path))))
                    if merged.currentFill || !hasPaint(n.fill) { n.fill = hasPaint(defaults["fill"]) ? defaults["fill"]! : "#808080" }
                    list.append(n)
                }
                if r == nil && list.count == 1 { continue }
                created[node.id] = list.map(\.id)
                nodes = spliceTree(nodes, node.id, list)
            }
            setDoc(nodes)
            // The shapes stay selected so the next gesture works on them too.
            var next = selection.flatMap { created[$0] ?? [$0] }
            if let mergedId, !next.contains(mergedId) { next.append(mergedId) }
            selection = next.enumerated().filter { k, id in getNode(id) != nil && next.firstIndex(of: id) == k }.map(\.element)
            anchors = []
            editingId = nil
        }
        return VectorShapeBuilderResult(ok: true, message: nil, merged: mergedId, faces: touched.faces.count, lines: touched.lines.count, edges: erase ? vectorBuilderErasedEdges(m, touched).count : 0)
    }

    // MARK: Paint bucket

    /// The planar map of every visible path's outline as drawn (`vectorFillMap`).
    private func fillMap(_ gap: Double) throws -> PlanarMap? {
        let entries = try vectorPathEntries(doc, nil, locked: true)
        let inputs = try entries.map { PlanarInput(path: .commands(try entryWorld($0, $0.node.subpaths.filter(usable))), fills: false) }
        return PlanarMap.build(inputs, PlanarMapOptions(gap: gap, maxSegments: 20000))
    }

    /// Paint bucket: the region the visible outlines enclose around `point` becomes a new path in
    /// the current fill, just below the selection (or on top). Returns its id, or nil.
    public func fillRegion(_ point: Vec2, gap: Double? = nil) throws -> String? {
        if !point.x.isFinite || !point.y.isFinite { return nil }
        guard let region = try fillMap(gap ?? editing["fillGap"]?.numberValue ?? 0)?.regionAt(PathPoint(point.x, point.y)), !region.isEmpty else { return nil }
        // Below the lowest selected node, in its parent.
        var below: String?
        let roots = Set(selectedRoots())
        walkVectorNodes(doc.nodes) { n, _, _ in if below == nil && roots.contains(n.id) { below = n.id } }
        let subpaths = bezierToSubpaths(.commands(below.map { intoParentSpace($0, region) } ?? region))
        if subpaths.isEmpty { return nil }
        let id = newId()
        var props = JSONObject([("id", .string(id)), ("type", "path"), ("name", "Fill")])
        for (k, v) in try styleFor(open: false) { props[k] = v }
        props["stroke"] = .null
        props["fillRule"] = "nonzero"
        var node = VectorNode(props: props, subpaths: subpaths)
        if !hasPaint(node.fill) { node.fill = "#808080" }
        let target = below
        change("Fill Region") {
            if let target, let current = getNode(target) {
                setDoc(spliceTree(doc.nodes, target, [node, current]))
            } else {
                setDoc(doc.nodes + [node])
            }
            if target == nil { selection = [id] }
            anchors = []
            editingId = nil
        }
        return id
    }
}
