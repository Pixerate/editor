import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

/// The selection box (`VectorSelectionFrame`): `angle` is the shared rotation of the selected
/// nodes (0 when they differ), `x / y / width / height` the bounds in the box's own frame
/// (document space rotated by −angle).
public struct VectorSelectionFrame: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var angle: Double

    var box: VectorBounds { VectorBounds(x: x, y: y, width: width, height: height) }
}

/// `((((a + 180) % 360) + 360) % 360) - 180` (JavaScript `%` keeps the dividend's sign).
func normalizeAngle(_ a: Double) -> Double {
    (((a + 180).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)) - 180
}

/// The selection frame of nodes `ids` (`getVectorSelectionFrame`), or nil when they have no points.
public func getVectorSelectionFrame(_ doc: VectorDocument, _ ids: [String]) throws -> VectorSelectionFrame? {
    let nodes = ids.compactMap { id in findVectorNode(doc.nodes, id).map { (node: $0, parent: vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX) } }
    if nodes.isEmpty { return nil }
    let angles = nodes.map { matrixRotation(multiplyMatrices(nodeMatrix($0.node), $0.parent)) }
    let same = angles.allSatisfy { abs(normalizeAngle($0 - angles[0])) < 1e-6 }
    let angle = same ? angles[0] : 0
    let unrotate = rotateMatrix(-angle)
    guard let b = unionBounds(try nodes.map { try vectorNodeBounds($0.node, multiplyMatrices($0.parent, unrotate)) }) else { return nil }
    return VectorSelectionFrame(x: b.x, y: b.y, width: b.width, height: b.height, angle: angle)
}

/// A box's corners clockwise from the top left (`vectorBoxCorners`).
func vectorBoxCorners(_ b: VectorBounds) -> [Vec2] {
    [Vec2(b.x, b.y), Vec2(b.x + b.width, b.y), Vec2(b.x + b.width, b.y + b.height), Vec2(b.x, b.y + b.height)]
}

/// `isRoot`: the identity matrix (exactly).
func isRootMatrix(_ m: VectorMatrix) -> Bool { m.a == 1 && m.b == 0 && m.c == 0 && m.d == 1 && m.e == 0 && m.f == 0 }

extension VectorEditorController {
    // MARK: Frames and bounds

    func boundsOf(_ ids: [String]) throws -> VectorBounds? {
        unionBounds(try ids.map { id in
            guard let n = getNode(id) else { return nil }
            return try vectorNodeBounds(n, vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX)
        })
    }

    func frameOf(_ ids: [String]) throws -> VectorSelectionFrame? { try getVectorSelectionFrame(doc, ids) }

    /// `m`, given in a frame rotated by `angle`, as a document-space matrix.
    func inFrame(_ angle: Double, _ m: VectorMatrix) -> VectorMatrix {
        if angle == 0 { return m }
        return multiplyMatrices(multiplyMatrices(rotateMatrix(-angle), m), rotateMatrix(angle))
    }

    /// The selection frame's corners in document space, clockwise from the top left.
    func frameCorners(_ frame: VectorSelectionFrame) -> [Vec2] {
        let rot = rotateMatrix(frame.angle)
        return vectorBoxCorners(frame.box).map { frame.angle != 0 ? applyMatrix(rot, $0) : $0 }
    }

    /// The selection frame's centre in document space.
    func frameCenter(_ frame: VectorSelectionFrame) -> Vec2 {
        applyMatrix(rotateMatrix(frame.angle), Vec2(frame.x + frame.width / 2, frame.y + frame.height / 2))
    }

    // MARK: Transforms

    /// Applies a matrix to the selected (or given) nodes as one undo step.
    @discardableResult
    public func transform(_ matrix: VectorMatrix, ids: [String]? = nil, label: String? = nil) throws -> VectorActionResult {
        let set = Set(ids ?? selectedRoots())
        if set.isEmpty { return .failure("Nothing is selected.") }
        try change(label ?? "Transform") { doc = try transformed(doc, set, matrix) }
        return .success
    }

    /// `d` with nodes `ids` moved by `m`, given in document space.
    func transformed(_ d: VectorDocument, _ ids: Set<String>, _ m: VectorMatrix) throws -> VectorDocument {
        func visit(_ list: [VectorNode], _ parent: VectorMatrix) throws -> [VectorNode] {
            try list.map { n in
                if ids.contains(n.id) && !n.isLocked {
                    // `m` in the node's parent space: parent → document, m, document → parent.
                    let local = isRootMatrix(parent) ? m : multiplyMatrices(multiplyMatrices(parent, m), invertMatrix(parent))
                    return try transformVectorNode(n, local)
                }
                if n.isGroup {
                    var g = n
                    let children = try visit(n.children, multiplyMatrices(nodeMatrix(n), parent))
                    if children != n.children { g.children = children }
                    return g
                }
                return n
            }
        }
        var out = d
        let nodes = try visit(d.nodes, IDENTITY_MATRIX)
        if nodes != d.nodes { out.nodes = nodes }
        return out
    }

    @discardableResult
    public func translate(_ dx: Double, _ dy: Double, ids: [String]? = nil) throws -> VectorActionResult {
        if tool == "direct" && !anchors.isEmpty && ids == nil {
            try change("Move Points") { doc = try movedAnchors(doc, anchors, dx, dy) }
            return .success
        }
        return try transform(translateMatrix(dx, dy), ids: ids, label: "Move")
    }

    /// Scales along the selection box's own axes around `origin` (default: the box centre).
    @discardableResult
    public func scale(_ sx: Double, _ sy: Double, ids: [String]? = nil, origin: Vec2? = nil) throws -> VectorActionResult {
        guard let frame = try frameOf(ids ?? selectedRoots()) else { return .failure("Nothing is selected.") }
        let o = applyMatrix(rotateMatrix(-frame.angle), origin ?? frameCenter(frame))
        return try transform(inFrame(frame.angle, scaleMatrix(sx, sy, o)), ids: ids, label: "Scale")
    }

    /// Rotates clockwise by `degrees` around `origin` (default: the selection centre).
    @discardableResult
    public func rotate(_ degrees: Double, ids: [String]? = nil, origin: Vec2? = nil) throws -> VectorActionResult {
        guard let frame = try frameOf(ids ?? selectedRoots()) else { return .failure("Nothing is selected.") }
        return try transform(rotateMatrix(degrees, origin ?? frameCenter(frame)), ids: ids, label: "Rotate")
    }

    /// Sets each selected (or given) node's rotation to `degrees`, turning it around its own centre.
    @discardableResult
    public func setRotation(_ degrees: Double, ids: [String]? = nil) throws -> VectorActionResult {
        let list = ids ?? selectedRoots()
        if list.isEmpty { return .failure("Nothing is selected.") }
        try change("Set Rotation") {
            for id in list {
                guard let frame = try frameOf([id]) else { continue }
                let delta = normalizeAngle(degrees - frame.angle)
                if abs(delta) > 1e-9 { doc = try transformed(doc, [id], rotateMatrix(delta, frameCenter(frame))) }
            }
        }
        return .success
    }

    /// Skews along the selection box's own axes by `ax` / `ay` degrees about `origin` (default: the box centre).
    @discardableResult
    public func skew(_ ax: Double, _ ay: Double = 0, ids: [String]? = nil, origin: Vec2? = nil) throws -> VectorActionResult {
        guard let frame = try frameOf(ids ?? selectedRoots()) else { return .failure("Nothing is selected.") }
        if ![ax, ay].allSatisfy({ $0.isFinite && abs($0) < 89.9 }) { return .failure("Skew angles must be between −89.9° and 89.9°.") }
        let o = applyMatrix(rotateMatrix(-frame.angle), origin ?? frameCenter(frame))
        return try transform(inFrame(frame.angle, skewMatrix(ax, ay, o)), ids: ids, label: "Skew")
    }

    /// Distorts the nodes so the corners of their selection box (clockwise from the top left, in
    /// the box's own rotation) land on `corners` (document space): a projective map. One undo step.
    @discardableResult
    public func distort(_ corners: [Vec2], ids: [String]? = nil, tolerance: Double? = nil) throws -> VectorActionResult {
        let list = ids ?? selectedRoots()
        guard let frame = try frameOf(list) else { return .failure("Nothing is selected.") }
        if !(frame.width > 0 && frame.height > 0) { return .failure("The selection has no area to distort.") }
        let from = frameCorners(frame)
        let h = corners.count == 4 ? homographyFromPoints(from, corners) : nil
        guard let h, homographyKeepsQuad(h, from) else { return .failure("The four corners must make a convex quadrilateral, clockwise from the top left.") }
        try change("Distort") {
            doc = try distorted(doc, Set(list), { applyHomography(h, $0) ?? $0 }, tolerance ?? VECTOR_DISTORT_TOLERANCE)
        }
        return .success
    }

    /// `d` with nodes `ids` sent through `f` (a map of document space), each in its own space.
    func distorted(_ d: VectorDocument, _ ids: Set<String>, _ f: @escaping (Vec2) -> Vec2, _ tolerance: Double) throws -> VectorDocument {
        func visit(_ list: [VectorNode], _ parent: VectorMatrix) throws -> [VectorNode] {
            try list.map { n in
                if ids.contains(n.id) && !n.isLocked { return try distortVectorNode(n, parent, f, tolerance) }
                if n.isGroup {
                    var g = n
                    let children = try visit(n.children, multiplyMatrices(nodeMatrix(n), parent))
                    if children != n.children { g.children = children }
                    return g
                }
                return n
            }
        }
        var out = d
        let nodes = try visit(d.nodes, IDENTITY_MATRIX)
        if nodes != d.nodes { out.nodes = nodes }
        return out
    }

    // MARK: Align and distribute

    /// Aligns the nodes to their combined bounds, or to the artboard when one node is given (or `to: "artboard"`).
    @discardableResult
    public func align(_ edge: String, ids: [String]? = nil, to: String? = nil) throws -> VectorActionResult {
        let list = ids ?? selectedRoots()
        if list.isEmpty { return .failure("Nothing is selected.") }
        let target = to == "artboard" || list.count == 1 ? VectorBounds(x: 0, y: 0, width: doc.width, height: doc.height) : try boundsOf(list)!
        let label = "Align \(edge.prefix(1).uppercased())\(edge.dropFirst())"
        try change(label) {
            for id in list {
                guard let b = try boundsOf([id]) else { continue }
                var dx = 0.0, dy = 0.0
                if edge == "left" { dx = target.x - b.x }
                if edge == "center" { dx = target.x + target.width / 2 - (b.x + b.width / 2) }
                if edge == "right" { dx = target.x + target.width - (b.x + b.width) }
                if edge == "top" { dy = target.y - b.y }
                if edge == "middle" { dy = target.y + target.height / 2 - (b.y + b.height / 2) }
                if edge == "bottom" { dy = target.y + target.height - (b.y + b.height) }
                if dx != 0 || dy != 0 { doc = try transformed(doc, [id], translateMatrix(dx, dy)) }
            }
        }
        return .success
    }

    /// Spaces three or more nodes evenly (equal gaps).
    @discardableResult
    public func distribute(_ direction: String, ids: [String]? = nil) throws -> VectorActionResult {
        let list = ids ?? selectedRoots()
        var items: [(id: String, b: VectorBounds)] = []
        for id in list { if let b = try boundsOf([id]) { items.append((id, b)) } }
        if items.count < 3 { return .failure("Select at least three objects to distribute.") }
        let horizontal = direction == "horizontal"
        func pos(_ b: VectorBounds) -> Double { horizontal ? b.x : b.y }
        func size(_ b: VectorBounds) -> Double { horizontal ? b.width : b.height }
        items = jsSorted(items) { pos($0.b) - pos($1.b) }
        let first = items[0].b
        let last = items[items.count - 1].b
        let total = pos(last) + size(last) - pos(first)
        let gap = (total - items.reduce(0) { $0 + size($1.b) }) / Double(items.count - 1)
        try change(horizontal ? "Distribute Horizontally" : "Distribute Vertically") {
            var cursor = pos(first)
            for item in items {
                let d = cursor - pos(item.b)
                if abs(d) > 1e-9 { doc = try transformed(doc, [item.id], horizontal ? translateMatrix(d, 0) : translateMatrix(0, d)) }
                cursor += size(item.b) + gap
            }
        }
        return .success
    }
}

// MARK: - Isometric blocks (`addIsoBoxes`, `geom/iso.ts`)

/// One isometric block to add: its box in grid units, colours and name.
public struct VectorIsoBoxRequest: Sendable {
    public var box: IsoBox
    /// One colour (sides shaded darker) or one per face.
    public var fill: String?
    public var faces: (top: String, left: String, right: String)?
    /// Edge colour; `.some(nil)` for none, `nil` for a shade of each face.
    public var stroke: String??
    public var name: String?
    public init(box: IsoBox, fill: String? = nil, faces: (top: String, left: String, right: String)? = nil, stroke: String?? = nil, name: String? = nil) {
        self.box = box; self.fill = fill; self.faces = faces; self.stroke = stroke; self.name = name
    }
}

extension VectorEditorController {
    /// Adds isometric blocks as one group of face paths, back to front, as one undo step
    /// (`addIsoBoxes` in `controller.ts`). Returns the result and the JSON the command returns.
    public func addIsoBoxes(_ boxes: [VectorIsoBoxRequest], angle: Double? = nil, scale: Double? = nil, origin: Vec2? = nil, grid: Double? = nil, name: String? = nil) throws -> (result: VectorActionResult, json: JSONValue?) {
        if boxes.isEmpty { return (.failure("Give at least one box."), nil) }
        for (i, b) in boxes.enumerated() {
            let problems = isoBoxProblems(b.box)
            if !problems.isEmpty { return (.failure("Box \(i): \(problems.joined(separator: "; "))."), nil) }
        }
        if let grid, !(grid > 0) { return (.failure("The grid step must be a positive number of grid units, not \(grid)."), nil) }
        var projector: IsoProjector
        do {
            projector = try IsoProjector(angle: angle, scale: scale, origin: PixerateRaster.Vec2(x: 0, y: 0))
            if let origin {
                projector = try IsoProjector(angle: angle, scale: scale, origin: PixerateRaster.Vec2(x: origin.x, y: origin.y))
            } else {
                let all = boxes.flatMap { projector.box($0.box).outline }
                let minX = all.map(\.x).reduce(Double.infinity) { JS.min($0, $1) }
                let maxX = all.map(\.x).reduce(-Double.infinity) { JS.max($0, $1) }
                let minY = all.map(\.y).reduce(Double.infinity) { JS.min($0, $1) }
                let maxY = all.map(\.y).reduce(-Double.infinity) { JS.max($0, $1) }
                projector = try IsoProjector(angle: angle, scale: scale, origin: PixerateRaster.Vec2(x: doc.width / 2 - (minX + maxX) / 2, y: doc.height / 2 - (minY + maxY) / 2))
            }
        } catch let error as IsoError {
            return (.failure(error.description), nil)
        }
        func path(_ id: String, _ name: String, _ pts: [PixerateRaster.Vec2], _ fill: String, _ stroke: String?) -> VectorNode {
            VectorNode(
                props: JSONObject([("id", .string(id)), ("type", "path"), ("name", .string(name)), ("fill", .string(fill)), ("stroke", stroke.map { .string($0) } ?? .null), ("strokeWidth", 1)]),
                subpaths: [VectorSubpath(anchors: pts.map { VectorAnchor(x: $0.x, y: $0.y) }, closed: true)]
            )
        }
        let rootId = newId()
        let order = isoOrder(boxes.map(\.box), projector)
        var made = [JSONValue?](repeating: nil, count: boxes.count)
        var children: [VectorNode] = []
        for index in order {
            let b = boxes[index]
            let faces = projector.box(b.box)
            let colors = b.faces ?? isoFaceColors(b.fill ?? "#cbd5e1")
            func strokeOf(_ c: String) -> String? {
                if let s = b.stroke { return s }
                return isoShade(c, 0.25)
            }
            let groupId = newId()
            var parts: [VectorNode] = []
            var ids: [(String, JSONValue)] = [("top", "")]
            var leftId: String?
            var rightId: String?
            if !faces.left.isEmpty {
                leftId = newId()
                parts.append(path(leftId!, "Left", faces.left, colors.left, strokeOf(colors.left)))
            }
            if !faces.right.isEmpty {
                rightId = newId()
                parts.append(path(rightId!, "Right", faces.right, colors.right, strokeOf(colors.right)))
            }
            let topId = newId()
            parts.append(path(topId, "Top", faces.top, colors.top, strokeOf(colors.top)))
            ids[0] = ("top", .string(topId))
            if let leftId { ids.append(("left", .string(leftId))) }
            if let rightId { ids.append(("right", .string(rightId))) }
            var gridId: String?
            if let grid {
                let lines = try projector.gridLines(b.box, step: grid)
                let all = lines.left + lines.right + lines.top
                if !all.isEmpty {
                    gridId = newId()
                    parts.append(VectorNode(
                        props: JSONObject([("id", .string(gridId!)), ("type", "path"), ("name", "Grid"), ("fill", .null), ("stroke", .string(isoShade(colors.right, 0.2))), ("strokeWidth", 0.5)]),
                        subpaths: all.map { VectorSubpath(anchors: [VectorAnchor(x: $0.0.x, y: $0.0.y), VectorAnchor(x: $0.1.x, y: $0.1.y)], closed: false) }
                    ))
                }
            }
            children.append(VectorNode(props: JSONObject([("id", .string(groupId)), ("type", "group"), ("name", .string(b.name ?? "Block \(index + 1)"))]), children: parts))
            var entry: [(String, JSONValue)] = [("id", .string(groupId)), ("faces", .object(JSONObject(ids)))]
            if let gridId { entry.append(("grid", .string(gridId))) }
            entry.append(("outline", .array(faces.outline.map { .object(JSONObject([("x", .number($0.x)), ("y", .number($0.y))])) })))
            made[index] = .object(JSONObject(entry))
        }
        let id = try addNode(VectorNode(props: JSONObject([("id", .string(rootId)), ("type", "group"), ("name", .string(name ?? "Isometric"))]), children: children), AddVectorNodeOptions(label: "Add Isometric Blocks"))
        return (.success, .object(JSONObject([("id", .string(id)), ("boxes", .array(made.map { $0 ?? .null }))])))
    }
}

// MARK: - Free Distort (`distort.ts`, `geom/homography.ts`, `pathMap.ts`)

/// Default tolerance (document units) of Free Distort's adaptive path mapping.
public let VECTOR_DISTORT_TOLERANCE = 0.05

/// A 3×3 projective map, row-major, normalised so that the last entry is 1.
typealias Homography = [Double]

/// Gaussian elimination with partial pivoting on an 8×8 system (`solve8`). Nil when singular.
func solve8(_ rows: [[Double]]) -> [Double]? {
    var m = rows
    for col in 0 ..< 8 {
        var pivot = col
        for r in (col + 1) ..< 8 where abs(m[r][col]) > abs(m[pivot][col]) { pivot = r }
        if !(abs(m[pivot][col]) >= 1e-12) { return nil }
        m.swapAt(col, pivot)
        let p = m[col]
        for r in 0 ..< 8 where r != col {
            let f = m[r][col] / p[col]
            if f != 0 { for k in 0 ..< 9 { m[r][k] -= f * p[k] } }
        }
    }
    var out: [Double] = []
    for i in 0 ..< 8 {
        let v = m[i][8] / m[i][i]
        if !v.isFinite { return nil }
        out.append(v)
    }
    return out
}

/// The image of `p`, or nil where the map sends it to infinity (`applyHomography`).
func applyHomography(_ h: Homography, _ p: Vec2) -> Vec2? {
    let w = h[6] * p.x + h[7] * p.y + h[8]
    if !w.isFinite || abs(w) < 1e-12 { return nil }
    let x = (h[0] * p.x + h[1] * p.y + h[2]) / w
    let y = (h[3] * p.x + h[4] * p.y + h[5]) / w
    return x.isFinite && y.isFinite ? Vec2(x, y) : nil
}

/// The projective map taking each of `from` to the point at the same index of `to` (`homographyFromPoints`).
func homographyFromPoints(_ from: [Vec2], _ to: [Vec2]) -> Homography? {
    if from.count != 4 || to.count != 4 || !(from + to).allSatisfy({ $0.x.isFinite && $0.y.isFinite }) { return nil }
    var rows: [[Double]] = []
    for i in 0 ..< 4 {
        let (x, y) = (from[i].x, from[i].y)
        let (u, v) = (to[i].x, to[i].y)
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y, v])
    }
    guard let h = solve8(rows) else { return nil }
    let out: Homography = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
    for i in 0 ..< 4 {
        let q = to[i]
        let scale = 1 + JS.max(abs(q.x), abs(q.y))
        guard let r = applyHomography(out, from[i]), !(abs(r.x - q.x) > 1e-6 * scale || abs(r.y - q.y) > 1e-6 * scale) else { return nil }
    }
    return out
}

/// Whether `h` maps the whole convex quad without sending any of it through infinity (`homographyKeepsQuad`).
func homographyKeepsQuad(_ h: Homography, _ quad: [Vec2]) -> Bool {
    let ws = quad.map { h[6] * $0.x + h[7] * $0.y + h[8] }
    return ws.allSatisfy { $0 > 1e-9 } || ws.allSatisfy { $0 < -1e-9 }
}

/// Effects after their node's geometry went through a non-affine map (`mapEffects`): envelope
/// meshes follow it (a preset becomes the mesh it stood for). Nil without effects.
private func mapDistortedEffects(_ node: VectorNode, _ f: (Vec2) -> Vec2) throws -> JSONValue? {
    guard let list = node["effects"]?.arrayValue, !list.isEmpty else { return nil }
    return .array(try list.map { e in
        guard e["type"] == "envelope", var o = e.objectValue, var params = o["params"]?.objectValue, let id = o["id"]?.stringValue else { return e }
        if params["style"] == "mesh" {
            guard let mesh = VectorWarpMesh(json: params["mesh"]) else { return e }
            params["mesh"] = mapVectorMeshPoints(mesh, f).json
        } else {
            guard let bounds = try vectorEffectInputBounds(node, id), vectorEnvelopeMap(params, bounds) != nil else { return e }
            let mesh = mapVectorMeshPoints(vectorEnvelopeMesh(params, bounds), f)
            params["style"] = "mesh"
            params["mesh"] = mesh.json
        }
        o["params"] = .object(params)
        return .object(o)
    })
}

/// A node sent through `f`, a map of the space `parentToDoc` maps its parent to (`distortVectorNode`):
/// every anchor and handle is mapped in the node's own space, and it keeps its rigid `transform`.
/// Envelope meshes and a blend's spine are mapped too.
func distortVectorNode(_ node: VectorNode, _ parentToDoc: VectorMatrix, _ f: @escaping (Vec2) -> Vec2, _ tolerance: Double) throws -> VectorNode {
    let toDoc = multiplyMatrices(nodeMatrix(node), parentToDoc)
    let inv = invertMatrix(toDoc)
    let local: (Vec2) -> Vec2 = { p in applyMatrix(inv, f(applyMatrix(toDoc, p))) }
    let effects = try mapDistortedEffects(node, local)
    var next = node
    if node.isGroup {
        next.children = try node.children.map { try distortVectorNode($0, toDoc, f, tolerance) }
        if let effects { next["effects"] = effects }
        if var blend = node["blend"]?.objectValue, let raw = blend["spine"], truthy(raw), let spine = try? VectorSubpath(json: raw) {
            blend["spine"] = mapVectorSubpaths([spine], local, tolerance)[0].toJSON()
            next["blend"] = .object(blend)
        }
        return next
    }
    if !node.isPath { throw VectorNotPorted("distorting \(node.typeName) nodes") }
    if let effects { next["effects"] = effects }
    // Gradients in the node's space have their handles mapped; box ones follow the new bounds.
    if node.fill != nil { next.fill = mapVectorPaint(node.fill, local) }
    if node.stroke != nil { next.stroke = mapVectorPaint(node.stroke, local) }
    next.subpaths = mapVectorSubpaths(node.subpaths, local, tolerance)
    return next
}

// `pathMap.ts`: non-affine maps of paths.

private typealias Cubic = [Vec2]

private let MAX_PIECES = 1 << 20
private let MAX_DEPTH = 6
private let PROBES = [0.25, 0.5, 0.75]

@inline(__always) private func lerp(_ a: Vec2, _ b: Vec2, _ t: Double) -> Vec2 { Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }
@inline(__always) private func dist(_ a: Vec2, _ b: Vec2) -> Double { JS.hypot(a.x - b.x, a.y - b.y) }
@inline(__always) private func same(_ a: Vec2, _ b: Vec2) -> Bool { abs(a.x - b.x) < 1e-9 && abs(a.y - b.y) < 1e-9 }

private func evalCubic(_ s: Cubic, _ t: Double) -> Vec2 {
    let ab = lerp(s[0], s[1], t)
    let bc = lerp(s[1], s[2], t)
    let cd = lerp(s[2], s[3], t)
    return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t)
}

private func halves(_ s: Cubic) -> (Cubic, Cubic) {
    let ab = lerp(s[0], s[1], 0.5)
    let bc = lerp(s[1], s[2], 0.5)
    let cd = lerp(s[2], s[3], 0.5)
    let abc = lerp(ab, bc, 0.5)
    let bcd = lerp(bc, cd, 0.5)
    let m = lerp(abc, bcd, 0.5)
    return ([s[0], ab, abc, m], [m, bcd, cd, s[3]])
}

private func offLine(_ p: Vec2, _ a: Vec2, _ b: Vec2) -> Double {
    let l = dist(a, b)
    return l < 1e-12 ? dist(p, a) : abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / l
}

private func mapAnchorPoints(_ a: VectorAnchor, _ f: (Vec2) -> Vec2) -> VectorAnchor {
    let p = f(Vec2(a.x, a.y))
    var out = VectorAnchor(x: p.x, y: p.y)
    if let h = a.in { out.in = f(h) }
    if let h = a.out { out.out = f(h) }
    if let t = a.type, t != .corner { out.type = t }
    if let c = a.corner { out.corner = c }
    if let id = a.id, !id.isEmpty { out.id = id }
    return out
}

private func splitMapped(_ seg: Cubic, _ f: (Vec2) -> Vec2, _ tol: Double, _ depth: Int, _ out: inout [Cubic]) {
    let mapped = seg.map(f)
    let fits = PROBES.allSatisfy { dist(f(evalCubic(seg, $0)), evalCubic(mapped, $0)) <= tol }
    if fits || depth == 0 {
        out.append(mapped)
        return
    }
    let (a, b) = halves(seg)
    splitMapped(a, f, tol, depth - 1, &out)
    splitMapped(b, f, tol, depth - 1, &out)
}

@inline(__always) private func pp(_ p: Vec2) -> PathPoint { PathPoint(p.x, p.y) }
@inline(__always) private func vv(_ p: PathPoint) -> Vec2 { Vec2(p[0], p[1]) }

private func refit(_ seg: Cubic, _ pieces: [Cubic], _ f: (Vec2) -> Vec2, _ tol: Double) -> [Cubic] {
    if pieces.count < 3 { return pieces }
    let n = pieces.count * 4
    var samples: [PathPoint] = []
    for i in 0 ... n { samples.append(pp(f(evalCubic(seg, Double(i) / Double(n))))) }
    let first = pieces[0]
    let last = pieces[pieces.count - 1]
    let t0 = !same(first[1], first[0]) ? first[1] : first[2]
    let t1 = !same(last[2], last[3]) ? last[2] : last[1]
    let fitted = fitCubicRun(samples, tol / 2, PathPoint(t0.x - first[0].x, t0.y - first[0].y), PathPoint(last[3].x - t1.x, last[3].y - t1.y))
    if fitted.isEmpty || fitted.count >= pieces.count { return pieces }
    let chain: [BezierSegment] = fitted.map { [$0.p0, $0.p1, $0.p2, $0.p3] }
    for i in 0 ..< n {
        let q = pp(f(evalCubic(seg, (Double(i) + 0.5) / Double(n))))
        var best = Double.infinity
        for c in chain { best = JS.min(best, segmentNearest(c, q).distance) }
        if best > tol { return pieces }
    }
    return fitted.map { [vv($0.p0), vv($0.p1), vv($0.p2), vv($0.p3)] }
}

private func mapSegment(_ seg: Cubic, _ f: (Vec2) -> Vec2, _ tol: Double, _ depth: Int, _ fit: Bool) -> [Cubic] {
    if same(seg[1], seg[0]) && same(seg[2], seg[3]) {
        let a = f(seg[0])
        let b = f(seg[3])
        if PROBES.allSatisfy({ offLine(f(lerp(seg[0], seg[3], $0)), a, b) <= tol }) { return [[a, a, b, b]] }
        let line: Cubic = [seg[0], lerp(seg[0], seg[3], 1.0 / 3.0), lerp(seg[0], seg[3], 2.0 / 3.0), seg[3]]
        var out: [Cubic] = []
        splitMapped(line, f, tol, depth, &out)
        return fit ? refit(line, out, f, tol) : out
    }
    var out: [Cubic] = []
    splitMapped(seg, f, tol, depth, &out)
    return fit ? refit(seg, out, f, tol) : out
}

private func realign(_ a: VectorAnchor) -> VectorAnchor {
    guard let hin = a.in, let hout = a.out, !same(hin, Vec2(a.x, a.y)), !same(hout, Vec2(a.x, a.y)) else { return a }
    let li = dist(hin, Vec2(a.x, a.y))
    let lo = dist(hout, Vec2(a.x, a.y))
    let dx = (a.x - hin.x) / li + (hout.x - a.x) / lo
    let dy = (a.y - hin.y) / li + (hout.y - a.y) / lo
    let l = JS.hypot(dx, dy)
    if l < 1e-12 { return a }
    let u = Vec2(dx / l, dy / l)
    let type: VectorAnchorType? = a.type == .symmetric && abs(li - lo) > 1e-6 * JS.max(li, lo) ? .smooth : a.type
    var out = a
    out.in = Vec2(a.x - u.x * li, a.y - u.y * li)
    out.out = Vec2(a.x + u.x * lo, a.y + u.y * lo)
    if let type { out.type = type }
    return out
}

private func segmentOf(_ sp: VectorSubpath, _ i: Int) -> Cubic {
    let a = sp.anchors[i]
    let b = sp.anchors[(i + 1) % sp.anchors.count]
    return [Vec2(a.x, a.y), a.out ?? Vec2(a.x, a.y), b.in ?? Vec2(b.x, b.y), Vec2(b.x, b.y)]
}

private func mapSubpath(_ sp: VectorSubpath, _ f: (Vec2) -> Vec2, _ tol: Double, _ depth: Int, _ fit: Bool) -> VectorSubpath {
    let n = sp.anchors.count
    let count = n < 2 ? 0 : sp.closed ? n : n - 1
    if count == 0 { return VectorSubpath(closed: sp.closed, anchors: sp.anchors.map { mapAnchorPoints($0, f) }) }
    var pieces: [[Cubic]] = []
    for i in 0 ..< count { pieces.append(mapSegment(segmentOf(sp, i), f, tol, depth, fit)) }
    var anchors: [VectorAnchor] = []
    func put(_ aIn: VectorAnchor) {
        var a = aIn
        if let h = a.in, same(h, Vec2(a.x, a.y)) { a.in = nil }
        if let h = a.out, same(h, Vec2(a.x, a.y)) { a.out = nil }
        anchors.append(a.type == .smooth || a.type == .symmetric ? realign(a) : a)
    }
    for (i, k) in sp.anchors.enumerated() {
        let incoming: [Cubic]? = i > 0 ? pieces[i - 1] : sp.closed ? pieces[n - 1] : nil
        let outgoing: [Cubic]? = i < pieces.count ? pieces[i] : nil
        let p = f(Vec2(k.x, k.y))
        var a = VectorAnchor(x: p.x, y: p.y)
        let inCtrl: Vec2? = incoming.map { $0[$0.count - 1][2] } ?? k.in.map(f)
        let outCtrl: Vec2? = outgoing.map { $0[0][1] } ?? k.out.map(f)
        if let inCtrl { a.in = inCtrl }
        if let outCtrl { a.out = outCtrl }
        if let t = k.type, t != .corner { a.type = t }
        if let c = k.corner { a.corner = c }
        put(a)
        if let outgoing {
            for w in 1 ..< Swift.max(1, outgoing.count) {
                put(VectorAnchor(x: outgoing[w][0].x, y: outgoing[w][0].y, in: outgoing[w - 1][2], out: outgoing[w][1], type: .smooth))
            }
        }
    }
    return VectorSubpath(closed: sp.closed, anchors: anchors)
}

/// `subpaths` through a smooth, possibly non-linear map `f` (`mapVectorSubpaths`): each segment
/// is halved until its mapped control points follow the mapped curve within `tolerance`, then
/// refitted with fewer cubics where possible.
func mapVectorSubpaths(_ subpaths: [VectorSubpath], _ f: (Vec2) -> Vec2, _ tolerance: Double = 0.1, refit: Bool = true) -> [VectorSubpath] {
    let tol = tolerance.isFinite && tolerance > 0 ? tolerance : 0.1
    let segments = subpaths.reduce(0) { $0 + $1.anchors.count }
    var depth = MAX_DEPTH
    while depth > 0 && Double(segments) * JS.pow(2, Double(depth)) > Double(MAX_PIECES) { depth -= 1 }
    return subpaths.map { mapSubpath($0, f, tol, depth, refit) }
}
