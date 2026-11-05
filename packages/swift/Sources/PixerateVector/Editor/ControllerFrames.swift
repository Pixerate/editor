import Foundation
import PixerateCore
import PixerateGeometry
import PixerateRaster

// The controller's frames (artboards) and resizing constraints, pages and master pages,
// connectors, snapping options and perspective grid (`vector/controller.ts`), and the viewport
// going to a page moves.

/// The zoom range of the view (`MIN_ZOOM`, `MAX_ZOOM`).
let VECTOR_MIN_ZOOM = 0.05
let VECTOR_MAX_ZOOM = 64.0

/// A result with the id of what was made (`VectorMaskResult`).
public typealias VectorIdResult = (result: VectorActionResult, id: String?)

private func failed(_ message: String) -> VectorIdResult { (.failure(message), nil) }

/// `{ x, y, width, height }` of a frame's rectangle.
private func frameBox(_ f: VectorNode) -> JSONValue {
    let r = vectorFrameRect(f.frame ?? JSONObject())
    return VectorBounds(x: r.x, y: r.y, width: r.width, height: r.height).json
}

/// `e && typeof e.nodeId === 'string'`: a glued end rather than a free point.
private func isGlued(_ e: JSONValue?) -> Bool { truthy(e) && e?["nodeId"]?.stringValue != nil }

/// A glued end as stored: `{ nodeId, side? }` (no `auto` side), or null.
private func storedEnd(_ e: JSONValue?) -> JSONValue {
    guard truthy(e), let id = e?["nodeId"]?.stringValue else { return .null }
    var o = JSONObject([("nodeId", .string(id))])
    if let side = e?["side"]?.stringValue, !side.isEmpty, side != "auto" { o["side"] = .string(side) }
    return .object(o)
}

extension VectorEditorController {
    // MARK: Snapping

    /// Changes the snapping options (`setSnap`): `patch` is merged over them.
    public func setSnap(_ patch: JSONObject) {
        for (k, v) in patch { snap[k] = v }
        notify()
    }

    // MARK: Connectors

    /// Sets the route the Connector tool draws with.
    @discardableResult
    public func setConnectorRoute(_ route: String) -> VectorActionResult {
        if !VECTOR_CONNECTOR_ROUTES.contains(route) { return .failure("Unknown route \"\(route)\": use \(VECTOR_CONNECTOR_ROUTES.joined(separator: ", ")).") }
        connectorRoute = route
        notify()
        return .success
    }

    /// The route the Connector tool draws with.
    public func getConnectorRoute() -> String { connectorRoute }

    /// Checks a connector end given by an API caller: the object must exist and not be a connector.
    private func checkConnectorEnd(_ end: JSONValue?, _ me: String? = nil) throws -> String? {
        guard truthy(end), let id = end?["nodeId"]?.stringValue else { return "A glued end needs a nodeId." }
        guard let n = getNode(id) else { return "There is no node \"\(id)\"." }
        if id == me { return "A connector cannot be glued to itself." }
        if isVectorConnector(n) { return "\"\(id)\" is a connector: glue ends to shapes, text, groups or instances." }
        if let side = end?["side"], side.stringValue.map({ !VECTOR_CONNECTOR_SIDES.contains($0) }) ?? true {
            return "Unknown side \"\(side.stringValue ?? side.stringified())\": use \(VECTOR_CONNECTOR_SIDES.joined(separator: ", "))."
        }
        if try vectorConnectionSites(doc.nodes, id).isEmpty { return "\"\(id)\" has no extent (or is hidden) to connect to." }
        return nil
    }

    /// Adds a connector from `start` to `end` (`addConnector`), each glued to an object
    /// (`{ nodeId, side? }`, side default `auto`) or a free point (`{ x, y }`, document units). It
    /// is routed now and after every later edit. Members: `route`, `radius`, `gap`, `name`,
    /// `stroke`, `strokeWidth`, `startArrow`, `endArrow` (default triangle). One undo step; selects it.
    public func addConnector(_ input: JSONObject) throws -> VectorIdResult {
        for e in [input["start"], input["end"]] {
            if isGlued(e) {
                if let problem = try checkConnectorEnd(e) { return failed(problem) }
            } else if !truthy(e) || !(e?["x"]?.numberValue?.isFinite ?? false) || !(e?["y"]?.numberValue?.isFinite ?? false) {
                return failed("Each end is { nodeId, side? } or a point { x, y }.")
            }
        }
        if isGlued(input["start"]), isGlued(input["end"]), input["start"]?["nodeId"] == input["end"]?["nodeId"] {
            return failed("Both ends are glued to the same object; connect two different objects.")
        }
        let route = input["route"]?.stringValue ?? connectorRoute
        if !VECTOR_CONNECTOR_ROUTES.contains(route) { return failed("Unknown route \"\(route)\": use \(VECTOR_CONNECTOR_ROUTES.joined(separator: ", ")).") }
        if let r = input["radius"], !((r.numberValue?.isFinite ?? false) && r.numberValue! >= 0) { return failed("radius must be zero or more.") }
        if let g = input["gap"], !((g.numberValue?.isFinite ?? false) && g.numberValue! >= 0) { return failed("gap must be zero or more.") }
        func point(_ e: JSONValue?) -> VectorAnchor {
            isGlued(e) ? VectorAnchor(x: 0, y: 0) : VectorAnchor(x: e?["x"]?.numberValue ?? 0, y: e?["y"]?.numberValue ?? 0)
        }
        let id = newId()
        let style = try styleFor(open: true)
        var props = JSONObject([("id", .string(id)), ("type", "path"), ("name", input["name"] ?? "Connector")])
        for (k, v) in style { props[k] = v }
        props["stroke"] = input["stroke"] ?? (style["stroke"].flatMap { $0 == .null ? nil : $0 } ?? "#000000")
        if let w = input["strokeWidth"] { props["strokeWidth"] = w }
        if let a = input["startArrow"] { props["startArrow"] = a }
        props["endArrow"] = input["endArrow"] ?? (style["endArrow"].flatMap { $0 == .null ? nil : $0 } ?? "triangle")
        var connector = JSONObject([("start", storedEnd(input["start"])), ("end", storedEnd(input["end"]))])
        if route != "straight" { connector["route"] = .string(route) }
        if let r = input["radius"]?.numberValue, r != 0 { connector["radius"] = .number(r) }
        if let g = input["gap"] { connector["gap"] = g }
        props["connector"] = .object(connector)
        let node = VectorNode(props: props, subpaths: [VectorSubpath(closed: false, anchors: [point(input["start"]), point(input["end"])])])
        change("Connect") {
            setDoc(doc.nodes + [node])
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (.success, id)
    }

    /// Changes connectors (default: the selected ones; `setConnector`): `start` / `end` glue an end
    /// to an object (`{ nodeId, side? }`) or unglue it (`null`, the end staying where it is), and
    /// `route`, `radius`, `gap` set how they run. Plain open paths given by id become connectors.
    /// One undo step.
    @discardableResult
    public func setConnector(_ patch: JSONObject, ids: [String]? = nil) throws -> VectorActionResult {
        let list = ids ?? selection
        if list.isEmpty { return .failure("Select a connector first.") }
        if let r = patch["route"], r.stringValue.map({ !VECTOR_CONNECTOR_ROUTES.contains($0) }) ?? true {
            return .failure("Unknown route \"\(r.stringValue ?? r.stringified())\": use \(VECTOR_CONNECTOR_ROUTES.joined(separator: ", ")).")
        }
        if let r = patch["radius"], !((r.numberValue?.isFinite ?? false) && r.numberValue! >= 0) { return .failure("radius must be zero or more.") }
        if let g = patch["gap"], !((g.numberValue?.isFinite ?? false) && g.numberValue! >= 0) { return .failure("gap must be zero or more.") }
        for id in list {
            guard let n = getNode(id) else { return .failure("There is no node \"\(id)\".") }
            if n.isLocked { return .failure("\"\(id)\" is locked; unlock it first.") }
            let openPath = n.isPath && n.subpaths.count == 1 && !n.subpaths[0].closed && n.subpaths[0].anchors.count >= 2
            if !isVectorConnector(n) && !openPath {
                return .failure("\"\(id)\" is not a connector or an open path (draw one with vector.connect or the Connector tool).")
            }
            for key in ["start", "end"] where truthy(patch[key]) {
                if let problem = try checkConnectorEnd(patch[key], id) { return .failure(problem) }
            }
        }
        let set = Set(list)
        change("Connector") {
            setDoc(mapTree(doc.nodes) { n in
                guard set.contains(n.id), n.isPath else { return n }
                var c = truthy(n["connector"]) ? (n["connector"]?.objectValue ?? JSONObject()) : JSONObject()
                if let s = patch["start"] { c["start"] = storedEnd(s) }
                if let e = patch["end"] { c["end"] = storedEnd(e) }
                if let route = patch["route"]?.stringValue {
                    if route == "straight" { remove(&c, "route") } else { c["route"] = .string(route) }
                }
                if let r = patch["radius"]?.numberValue {
                    if r > 0 { c["radius"] = .number(r) } else { remove(&c, "radius") }
                }
                if let g = patch["gap"] { c["gap"] = g }
                var next = n
                next["connector"] = .object(c)
                return next
            })
        }
        return .success
    }

    /// Every connector: its ends (glued object and resolved side, or the free point) and route.
    public func getConnectors() -> [JSONObject] {
        var out: [JSONObject] = []
        walkVectorNodes(doc.nodes) { n, _, _ in
            guard isVectorConnector(n) else { return }
            let r = (try? routeVectorConnector(doc.nodes, n.id)) ?? nil
            let world = vectorWorldMatrix(doc.nodes, n.id) ?? IDENTITY_MATRIX
            let sp = n.subpaths.first
            func end(_ e: JSONValue?, _ side: String?, _ a: VectorAnchor?) -> JSONValue {
                var o = JSONObject()
                if truthy(e) {
                    o["nodeId"] = e?["nodeId"] ?? .null
                    o["side"] = e?["side"] ?? "auto"
                    o["resolvedSide"] = side.map { .string($0) } ?? .null
                }
                if let a {
                    let at = applyMatrix(world, Vec2(a.x, a.y))
                    o["x"] = .number(at.x)
                    o["y"] = .number(at.y)
                }
                return .object(o)
            }
            let c = n["connector"]
            var o = JSONObject([("id", .string(n.id))])
            if let name = n.name, !name.isEmpty { o["name"] = .string(name) }
            o["route"] = c?["route"] ?? "straight"
            if let radius = c?["radius"]?.numberValue, radius != 0, !radius.isNaN { o["radius"] = .number(radius) }
            o["start"] = end(c?["start"], r?.startSide, sp?.anchors.first)
            o["end"] = end(c?["end"], r?.endSide, sp?.anchors.last)
            out.append(o)
        }
        return out
    }

    /// The connection sites of node `id` in document space (top, right, bottom, left, centre), or
    /// nil when there is no such node.
    public func getConnectionSites(_ id: String) throws -> [VectorConnectionSite]? {
        if getNode(id) == nil { return nil }
        return try vectorConnectionSites(doc.nodes, id)
    }

    // MARK: Frames

    /// A name for a new frame: "Frame <n>" after the frames there are.
    private func frameName() -> String {
        var n = 0
        walkVectorNodes(doc.nodes) { x, _, _ in if isVectorFrame(x) { n += 1 } }
        return "Frame \(n + 1)"
    }

    /// Adds an empty frame (an artboard when top-level) with its rectangle at `x, y, width, height`
    /// (document units), filled white by default and clipping its contents (`addFrame`). With
    /// `adopt`, the top-level objects it fully encloses move into it. One undo step; selects it.
    public func addFrame(x: Double, y: Double, width: Double, height: Double, name: String? = nil, fill: JSONValue? = nil, clip: Bool? = nil, adopt: Bool = false) throws -> VectorIdResult {
        if ![x, y, width, height].allSatisfy(\.isFinite) { return failed("x, y, width and height must be numbers.") }
        if !(width > 0 && height > 0) { return failed("A frame needs a positive width and height.") }
        let id = newId()
        let rect = VectorBounds(x: x, y: y, width: width, height: height)
        var adopted: [VectorNode] = []
        if adopt {
            for n in doc.nodes where !n.isLocked && n.isVisible && !truthy(n["blendStep"]) {
                if vectorBoundsInside(try vectorNodeBounds(n), rect) { adopted.append(n) }
            }
        }
        var frame = JSONObject([("x", .number(x)), ("y", .number(y)), ("width", .number(width)), ("height", .number(height)), ("fill", fill ?? "#ffffff")])
        if clip == false { frame["clip"] = false }
        let node = VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(name ?? frameName())), ("frame", .object(frame))]), children: adopted)
        let taken = Set(adopted.map(\.id))
        change("Add Frame") {
            setDoc(doc.nodes.filter { !taken.contains($0.id) } + [node])
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (.success, id)
    }

    /// Frame Selection (`frameSelection`): puts the selected (or given) objects, which must share a
    /// parent, into a new frame fitted to their bounds plus `padding` (document units, default 0),
    /// in their place in the stacking order. No fill unless `fill` is given; clips unless `clip` is
    /// false. One undo step; selects the frame.
    public func frameSelection(ids given: [String]? = nil, padding: Double? = nil, name: String? = nil, fill: JSONValue? = nil, clip: Bool? = nil) throws -> VectorIdResult {
        var ids: [String] = []
        for id in given ?? selectedRoots() where !ids.contains(id) { ids.append(id) }
        if ids.isEmpty { return failed("Select the objects to frame first.") }
        let padding = padding ?? 0
        if !(padding.isFinite && padding >= 0) { return failed("padding must be zero or more.") }
        for id in ids {
            guard let n = getNode(id) else { return failed("There is no node \"\(id)\".") }
            if n.isLocked { return failed("\"\(id)\" is locked; unlock it first.") }
            if truthy(n["blendStep"]) { return failed("\"\(id)\" is a blend step; select its blend instead.") }
        }
        let locs = ids.map { locateVectorNode(doc.nodes, $0)! }
        let parent = locs[0].parent
        if locs.contains(where: { $0.parent?.id != parent?.id }) { return failed("The objects must share a parent (pick objects at one level).") }
        guard let b = unionBounds(try ids.map { try vectorNodeBounds(getNode($0)!) }) else { return failed("The objects have no extent to frame.") }
        let id = newId()
        let order = jsSorted(ids) { a, c in Double(locs[ids.firstIndex(of: a)!].index - locs[ids.firstIndex(of: c)!].index) }
        let set = Set(order)
        var frame = JSONObject([("x", .number(b.x - padding)), ("y", .number(b.y - padding)), ("width", .number(b.width + 2 * padding)), ("height", .number(b.height + 2 * padding))])
        if let fill, fill != .null { frame["fill"] = fill }
        if clip == false { frame["clip"] = false }
        change("Frame Selection") {
            func regroup(_ list: [VectorNode]) -> [VectorNode] {
                let members = order.map { m in list.first { $0.id == m }! }
                let top = members.map { m in list.firstIndex { $0.id == m.id }! }.max()!
                var out: [VectorNode] = []
                for (i, n) in list.enumerated() {
                    if i == top {
                        out.append(VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(name ?? frameName())), ("frame", .object(frame))]), children: members))
                    }
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
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (.success, id)
    }

    /// Frames among `ids` (default: the selection), or holding one of them directly.
    private func frameTargets(_ ids: [String]?) -> [VectorNode] {
        var out: [VectorNode] = []
        func add(_ n: VectorNode) { if !out.contains(where: { $0.id == n.id }) { out.append(n) } }
        for id in ids ?? selection {
            if let n = getNode(id), isVectorFrame(n) {
                add(n)
            } else if ids == nil, let parent = locateVectorNode(doc.nodes, id)?.parent, isVectorFrame(parent) {
                add(parent)
            }
        }
        return out
    }

    /// Changes frames (default: the selected ones, or the frame holding the selection; `setFrame`):
    /// `x`, `y`, `width`, `height` move and resize the rectangle (in the frame's own space), and
    /// its children follow their resizing constraints; `fill` (null for none) and `clip` set how it
    /// draws. One undo step.
    @discardableResult
    public func setFrame(_ patch: JSONObject, ids: [String]? = nil) throws -> VectorActionResult {
        for k in ["x", "y", "width", "height"] {
            if let v = patch[k], !(v.numberValue?.isFinite ?? false) { return .failure("\(k) must be a number.") }
        }
        if let w = patch["width"], !((w.numberValue ?? .nan) > 0) { return .failure("A frame needs a positive width and height.") }
        if let h = patch["height"], !((h.numberValue ?? .nan) > 0) { return .failure("A frame needs a positive width and height.") }
        if let c = patch["clip"], c.boolValue == nil { return .failure("clip must be true or false.") }
        if let ids { for id in ids where !isVectorFrame(getNode(id)) { return .failure("\"\(id)\" is not a frame (use frameSelection or addFrame to make one).") } }
        let frames = frameTargets(ids)
        if frames.isEmpty { return .failure("Select a frame (or something in one).") }
        if let locked = frames.first(where: \.isLocked) { return .failure("\"\(locked.id)\" is locked; unlock it first.") }
        var next: [String: VectorNode] = [:]
        for f in frames {
            let from = vectorFrameRect(f.frame!)
            let to = VectorBounds(x: patch["x"]?.numberValue ?? from.x, y: patch["y"]?.numberValue ?? from.y, width: patch["width"]?.numberValue ?? from.width, height: patch["height"]?.numberValue ?? from.height)
            var node = f
            if to.x != from.x || to.y != from.y || to.width != from.width || to.height != from.height {
                // The rectangle's map in the frame's own space, carried into its parent's space.
                let sx = from.width > 1e-9 ? to.width / from.width : 1
                let sy = from.height > 1e-9 ? to.height / from.height : 1
                let local = VectorMatrix(sx, 0, 0, sy, to.x - sx * from.x, to.y - sy * from.y)
                let own = nodeMatrix(f)
                node = try transformVectorNode(f, multiplyMatrices(multiplyMatrices(invertMatrix(own), local), own))
                // Exact numbers (the map can round); the placement is unchanged.
                var fr = node.frame ?? JSONObject()
                fr["x"] = .number(to.x)
                fr["y"] = .number(to.y)
                fr["width"] = .number(to.width)
                fr["height"] = .number(to.height)
                node["frame"] = .object(fr)
                if truthy(f["transform"]) { node["transform"] = f["transform"] }
            }
            var frame = node.frame ?? JSONObject()
            if let fill = patch["fill"] {
                if fill == .null || fill == .string("none") { remove(&frame, "fill") } else { frame["fill"] = fill }
            }
            if let clip = patch["clip"]?.boolValue {
                if clip { remove(&frame, "clip") } else { frame["clip"] = false }
            }
            node["frame"] = .object(frame)
            next[f.id] = node
        }
        change("Frame") {
            setDoc(mapTree(doc.nodes) { next[$0.id] ?? $0 })
        }
        return .success
    }

    /// Sets the resizing constraints of the selected (or given) objects, which must be children of
    /// frames (`setResizing`): how each follows its frame when the frame is resized. A missing axis
    /// keeps its value. One undo step.
    @discardableResult
    public func setResizing(horizontal: String?, vertical: String?, ids: [String]? = nil) -> VectorActionResult {
        if let h = horizontal, !VECTOR_HORIZONTAL_RESIZING.contains(h) { return .failure("Unknown horizontal constraint \"\(h)\": use \(VECTOR_HORIZONTAL_RESIZING.joined(separator: ", ")).") }
        if let v = vertical, !VECTOR_VERTICAL_RESIZING.contains(v) { return .failure("Unknown vertical constraint \"\(v)\": use \(VECTOR_VERTICAL_RESIZING.joined(separator: ", ")).") }
        if (horizontal ?? "").isEmpty && (vertical ?? "").isEmpty { return .failure("Pass horizontal, vertical or both.") }
        let list = ids ?? selection
        if list.isEmpty { return .failure("Select objects inside a frame first.") }
        for id in list {
            if getNode(id) == nil { return .failure("There is no node \"\(id)\".") }
            if !isVectorFrame(locateVectorNode(doc.nodes, id)?.parent) { return .failure("\"\(id)\" is not directly inside a frame: resizing constraints only apply to a frame's children.") }
        }
        let set = Set(list)
        change("Constraints") {
            setDoc(mapTree(doc.nodes) { n in
                guard set.contains(n.id) else { return n }
                var r = n["resizing"]?.objectValue ?? JSONObject()
                if let horizontal { r["horizontal"] = .string(horizontal) }
                if let vertical { r["vertical"] = .string(vertical) }
                var next = n
                next["resizing"] = .object(r)
                return next
            })
        }
        return .success
    }

    /// Every frame in the document (top-level ones are artboards), with its rectangle, parent and
    /// children's constraints (`getFrames`).
    public func getFrames() throws -> [JSONObject] {
        var out: [JSONObject] = []
        func visit(_ list: [VectorNode], _ parent: String?) throws {
            for n in list {
                if isVectorFrame(n) {
                    let bounds = try vectorNodeBounds(n, vectorParentMatrix(doc.nodes, n.id) ?? IDENTITY_MATRIX)
                    let children: [JSONValue] = n.children.map { c in
                        var o = JSONObject([("id", .string(c.id)), ("type", .string(c.typeName))])
                        if let name = c.name, !name.isEmpty { o["name"] = .string(name) }
                        o["horizontal"] = c["resizing"]?["horizontal"] ?? "left"
                        o["vertical"] = c["resizing"]?["vertical"] ?? "top"
                        return .object(o)
                    }
                    out.append(JSONObject([
                        ("id", .string(n.id)), ("name", n["name"].flatMap { $0 == .null ? nil : $0 } ?? "Frame"),
                        ("parentId", parent.map { .string($0) } ?? .null), ("artboard", .bool(parent == nil)),
                        ("frame", n["frame"]!), ("bounds", bounds?.json ?? .null), ("children", .array(children)),
                    ]))
                }
                if n.isGroup { try visit(n.children, n.id) }
            }
        }
        try visit(doc.nodes, nil)
        return out
    }

    /// One frame as an SVG document of its own size, its corner at the origin (`frameToSvg`), or nil
    /// when `id` is not a frame.
    public func frameToSvg(_ id: String, precision: Int? = nil) throws -> String? {
        guard let d = vectorFrameDocument(storedDocument(), id) else { return nil }
        return try vectorDocumentToSvg(d, precision: precision)
    }

    // MARK: Pages

    /// The document's pages (top-level frames that are not master pages, in order: `number` from 1)
    /// with the master each uses, and its master pages (`getPages`).
    public func getPages() -> JSONObject {
        let pages = vectorPages(doc.nodes)
        let masters = vectorMasterPages(doc.nodes)
        let pageList: [JSONValue] = pages.enumerated().map { i, p in
            let mid = p.frame?["masterId"]?.stringValue
            let masterId: JSONValue = mid.map { m in !m.isEmpty && masters.contains { $0.id == m } ? .string(m) : .null } ?? .null
            return .object(JSONObject([
                ("id", .string(p.id)), ("name", p["name"].flatMap { $0 == .null ? nil : $0 } ?? .string("Page \(i + 1)")), ("number", .number(Double(i + 1))),
                ("masterId", masterId), ("bounds", frameBox(p)),
            ]))
        }
        let masterList: [JSONValue] = masters.map { m in
            .object(JSONObject([
                ("id", .string(m.id)), ("name", m["name"].flatMap { $0 == .null ? nil : $0 } ?? "Master"),
                ("usedBy", .array(pages.filter { $0.frame?["masterId"]?.stringValue == m.id }.map { .string($0.id) })), ("bounds", frameBox(m)),
            ]))
        }
        return JSONObject([("pages", .array(pageList)), ("masters", .array(masterList))])
    }

    /// Where a new page or master goes: right of every top-level frame, or below them for a master.
    private func nextPageRect(master: Bool) -> VectorBounds {
        let frames = doc.nodes.filter(isVectorFrame).map { vectorFrameRect($0.frame!) }
        let pages = vectorPages(doc.nodes).map { vectorFrameRect($0.frame!) }
        let like = pages.last ?? frames.last
        let width = like?.width ?? doc.width
        let height = like?.height ?? doc.height
        if frames.isEmpty { return VectorBounds(x: 0, y: 0, width: width, height: height) }
        let gap = JS.max(20, JS.round(width * 0.1))
        if master {
            let bottom = frames.map { $0.y + $0.height }.reduce(-Double.infinity, JS.max)
            let left = frames.map(\.x).reduce(Double.infinity, JS.min)
            return VectorBounds(x: left, y: bottom + gap * 2, width: width, height: height)
        }
        let right = (pages.isEmpty ? frames : pages).map { $0.x + $0.width }.reduce(-Double.infinity, JS.max)
        let top = (pages.isEmpty ? frames : pages).map(\.y).reduce(Double.infinity, JS.min)
        return VectorBounds(x: right + gap, y: top, width: width, height: height)
    }

    /// Adds a page (`addPage`): a frame the size of the last page (or the document), to the right of
    /// the others, after page `after` in the page order (default last), using master page
    /// `masterId` (default: the master the last page uses; `.null` for none). The first page added
    /// to a document without frames covers the artboard and takes the existing top-level art in.
    /// One undo step; selects it.
    public func addPage(name: String? = nil, masterId: JSONValue? = nil, after: String? = nil) -> VectorIdResult {
        let pages = vectorPages(doc.nodes)
        if let m = masterId?.stringValue, !m.isEmpty, !isVectorMasterPage(doc.nodes.first { $0.id == m }) {
            return failed("\"\(m)\" is not a master page (add one with vector.addMasterPage).")
        }
        if let after, !pages.contains(where: { $0.id == after }) { return failed("\"\(after)\" is not a page.") }
        let first = !doc.nodes.contains(where: isVectorFrame)
        let rect = nextPageRect(master: false)
        let id = newId()
        let master: JSONValue = masterId ?? (pages.last?.frame?["masterId"] ?? .null)
        let adopted = first ? doc.nodes.filter { !$0.isLocked && $0.isVisible && !truthy($0["blendStep"]) } : []
        var frame = JSONObject([("x", .number(rect.x)), ("y", .number(rect.y)), ("width", .number(rect.width)), ("height", .number(rect.height)), ("fill", "#ffffff")])
        if truthy(master) { frame["masterId"] = master }
        let page = VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(name ?? "Page \(pages.count + 1)")), ("frame", .object(frame))]), children: adopted)
        let taken = Set(adopted.map(\.id))
        change("Add Page") {
            var rest = doc.nodes.filter { !taken.contains($0.id) }
            let at = after.map { a in (rest.firstIndex { $0.id == a } ?? -1) + 1 } ?? rest.count
            rest.insert(page, at: at)
            setDoc(rest)
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (.success, id)
    }

    /// Adds an empty master page (a frame with `master` set, the size of the last page) below the
    /// pages (`addMasterPage`). With `assignTo` (page ids, or `all`), those pages use it. One undo
    /// step; selects it.
    public func addMasterPage(name: String? = nil, assignTo: JSONValue? = nil) -> VectorIdResult {
        let pages = vectorPages(doc.nodes)
        let assign: [String] = assignTo == .string("all") ? pages.map(\.id) : (assignTo?.arrayValue?.compactMap(\.stringValue) ?? [])
        for pid in assign where !pages.contains(where: { $0.id == pid }) { return failed("\"\(pid)\" is not a page.") }
        let rect = nextPageRect(master: true)
        let id = newId()
        let letter = String(UnicodeScalar(UInt8(65 + vectorMasterPages(doc.nodes).count % 26)))
        let frame = JSONObject([("x", .number(rect.x)), ("y", .number(rect.y)), ("width", .number(rect.width)), ("height", .number(rect.height)), ("master", true)])
        let master = VectorNode(props: JSONObject([("id", .string(id)), ("type", "group"), ("name", .string(name ?? "Master \(letter)")), ("frame", .object(frame))]), children: [])
        let set = Set(assign)
        change("Add Master Page") {
            setDoc(doc.nodes.map { n in
                guard set.contains(n.id), isVectorFrame(n) else { return n }
                var f = n.frame!
                f["masterId"] = .string(id)
                var next = n
                next["frame"] = .object(f)
                return next
            } + [master])
            selection = [id]
            anchors = []
            editingId = nil
        }
        return (.success, id)
    }

    /// Makes pages use master page `masterId`, or none with nil (`setPageMaster`). One undo step.
    @discardableResult
    public func setPageMaster(_ masterId: String?, ids given: [String]? = nil) -> VectorActionResult {
        let pages = vectorPages(doc.nodes)
        let ids = given ?? selection.filter { id in pages.contains { $0.id == id } }
        if ids.isEmpty { return .failure("Select a page (a top-level frame) first.") }
        for id in ids where !pages.contains(where: { $0.id == id }) {
            return .failure("\"\(id)\" is not a page\(isVectorMasterPage(getNode(id)) ? " (it is a master page)" : "").")
        }
        if let masterId, !isVectorMasterPage(doc.nodes.first { $0.id == masterId }) { return .failure("\"\(masterId)\" is not a master page.") }
        let set = Set(ids)
        change(masterId.map { !$0.isEmpty } == true ? "Apply Master Page" : "Remove Master Page") {
            setDoc(doc.nodes.map { n in
                guard set.contains(n.id), isVectorFrame(n) else { return n }
                var f = n.frame!
                remove(&f, "masterId")
                if let masterId, !masterId.isEmpty { f["masterId"] = .string(masterId) }
                var next = n
                next["frame"] = .object(f)
                return next
            })
        }
        return .success
    }

    /// Moves page `id` to position `index` (0-based) in the page order (`movePage`). One undo step.
    /// Returns the new order.
    public func movePage(_ id: String, _ index: Double) -> (result: VectorActionResult, order: [String]) {
        let pages = vectorPages(doc.nodes)
        guard let from = pages.firstIndex(where: { $0.id == id }) else { return (.failure("\"\(id)\" is not a page."), []) }
        if !(index.rounded(.towardZero) == index && index >= 0 && index < Double(pages.count)) { return (.failure("index must be from 0 to \(pages.count - 1)."), []) }
        let to = Int(index)
        if to == from { return (.success, pages.map(\.id)) }
        var order = pages.map(\.id)
        let moved = order.remove(at: from)
        order.insert(moved, at: to)
        // Pages keep their slots in the document; only which page sits in each slot changes.
        let slots = doc.nodes.indices.filter { i in pages.contains { $0.id == doc.nodes[i].id } }
        var byId: [String: VectorNode] = [:]
        for p in pages where byId[p.id] == nil { byId[p.id] = p }
        change("Move Page") {
            var nodes = doc.nodes
            for (k, slot) in slots.enumerated() { nodes[slot] = byId[order[k]]! }
            setDoc(nodes)
        }
        return (.success, order)
    }

    /// Goes to a page (or master page): selects it and brings it into view (`goToPage`), fitted to
    /// a canvas of `size` screen pixels when given, otherwise at the current zoom with its corner
    /// near the canvas's top-left. Not an undo step.
    @discardableResult
    public func goToPage(_ id: String, size: (width: Double, height: Double)? = nil) throws -> VectorActionResult {
        guard let n = doc.nodes.first(where: { $0.id == id }), isVectorFrame(n) else { return .failure("\"\(id)\" is not a page or master page.") }
        let b = try vectorNodeBounds(n) ?? vectorFrameRect(n.frame!)
        selection = [id]
        anchors = []
        if let size { zoomToFit(size, bounds: b) } else { setViewport(x: 40 - b.x * viewport.zoom, y: 40 - b.y * viewport.zoom) }
        notify()
        return .success
    }

    // MARK: Viewport

    /// Moves the view (`setViewport`): the zoom is kept within 0.05–64.
    public func setViewport(x: Double? = nil, y: Double? = nil, zoom: Double? = nil) {
        var next = VectorViewport(x: x ?? viewport.x, y: y ?? viewport.y, zoom: zoom ?? viewport.zoom)
        next.zoom = JS.min(VECTOR_MAX_ZOOM, JS.max(VECTOR_MIN_ZOOM, next.zoom))
        if next == viewport { return }
        viewport = next
        notify()
    }

    /// Fits the artboard (or `bounds`) into a canvas of `size` screen pixels (`zoomToFit`), with
    /// `padding` pixels round it (default 40).
    public func zoomToFit(_ size: (width: Double, height: Double), padding: Double = 40, bounds: VectorBounds? = nil) {
        let b = bounds ?? VectorBounds(x: 0, y: 0, width: doc.width, height: doc.height)
        func orOne(_ v: Double) -> Double { v != 0 && !v.isNaN ? v : 1 }
        let zoom = JS.min(VECTOR_MAX_ZOOM, JS.max(VECTOR_MIN_ZOOM, JS.min((size.width - padding * 2) / orOne(b.width), (size.height - padding * 2) / orOne(b.height))))
        setViewport(x: (size.width - b.width * zoom) / 2 - b.x * zoom, y: (size.height - b.height * zoom) / 2 - b.y * zoom, zoom: zoom)
    }

    // MARK: Perspective

    /// The document's perspective grid, or nil.
    public func getPerspective() -> JSONObject? { doc["perspective"]?.objectValue }

    /// The perspective plane new rectangles, ellipses, polygons and stars are drawn on, or nil
    /// (`state.perspectivePlane`: nil when the grid is gone or no longer has that plane).
    public var perspectivePlane: String? {
        guard let plane = drawingPlane, let grid = getPerspective(), vectorPerspectivePlanes(grid).contains(plane) else { return nil }
        return plane
    }

    /// Sets the document's perspective grid (`setPerspective`): 1 to 3 vanishing points, the origin
    /// where its planes meet, the cell size and extent, and whether it shows; nil removes it. One
    /// undo step. Returns the grid as stored.
    public func setPerspective(_ grid: JSONValue?) -> (result: VectorActionResult, perspective: JSONObject?) {
        var next: JSONObject?
        if let grid, truthy(grid) {
            next = sanitizeVectorPerspective(grid)
            if next == nil { return (.failure("A perspective grid needs 1 to 3 vanishing points { x, y } away from an origin { x, y }."), nil) }
        }
        change(next != nil ? "Perspective Grid" : "Remove Perspective Grid") {
            doc["perspective"] = nil
            if let next { doc["perspective"] = .object(next) }
        }
        if next == nil { drawingPlane = nil }
        return (.success, next)
    }

    /// Draws new rectangles, ellipses, polygons and stars on a plane of the perspective grid, or
    /// flat again with nil (`setPerspectivePlane`).
    @discardableResult
    public func setPerspectivePlane(_ plane: String?) -> VectorActionResult {
        if let plane {
            guard let grid = getPerspective() else { return .failure("There is no perspective grid: set one with vector.setPerspective first.") }
            let planes = vectorPerspectivePlanes(grid)
            if !planes.contains(plane) { return .failure("This grid's planes are \(planes.joined(separator: ", ")).") }
        }
        drawingPlane = plane
        notify()
        return .success
    }

    /// Lays objects onto a plane of the perspective grid (`attachToPerspective`): each is read flat,
    /// relative to the grid's origin (right and up), and projected onto the plane. Paths and groups
    /// are mapped in document space (their transforms baked in); text and instances must be
    /// converted to outlines first. One undo step. Returns the ids changed.
    public func attachToPerspective(_ plane: String, ids given: [String]? = nil) throws -> (result: VectorActionResult, ids: [String]) {
        guard let grid = getPerspective() else { return (.failure("There is no perspective grid: set one with vector.setPerspective first."), []) }
        let planes = vectorPerspectivePlanes(grid)
        if !planes.contains(plane) { return (.failure("This grid's planes are \(planes.joined(separator: ", "))."), []) }
        var ids: [String] = []
        for id in given ?? selectedRoots() where !ids.contains(id) { ids.append(id) }
        if ids.isEmpty { return (.failure("Select objects to put on the plane first."), []) }
        struct Refused: Error { let message: String }
        func project(_ n: VectorNode, _ m: VectorMatrix) throws -> VectorNode {
            let own = truthy(n["transform"]) ? multiplyMatrices(m, nodeMatrix(n)) : m
            if n.isText || n.isInstance {
                throw Refused(message: "\"\(n.id)\" is \(n.isText ? "text" : "a symbol instance"): convert it to outlines first (vector.createOutlines\(n.isInstance ? " after vector.detachInstance" : "")).")
            }
            var rest = n
            rest["transform"] = Optional<JSONValue>.none
            if n.isGroup {
                rest.children = try n.children.map { try project($0, own) }
                return rest
            }
            let flat = transformBezierPath(.commands(subpathsToBezier(n.subpaths)), own.tuple)
            guard let mapped = vectorPerspectiveMapPath(grid, plane, flat) else {
                throw Refused(message: "\"\(n.id)\" reaches beyond the plane's horizon: move it nearer the origin, or the vanishing points further out.")
            }
            rest.subpaths = bezierToSubpaths(.commands(mapped))
            return rest
        }
        var next: [String: VectorNode] = [:]
        for id in ids {
            guard let loc = locateVectorNode(doc.nodes, id), let node = getNode(id) else { return (.failure("There is no node \"\(id)\"."), []) }
            _ = loc
            if node.isLocked { return (.failure("\"\(id)\" is locked; unlock it first."), []) }
            let parentM = vectorParentMatrix(doc.nodes, id) ?? IDENTITY_MATRIX
            let r: VectorNode
            do { r = try project(node, parentM) } catch let e as Refused { return (.failure(e.message), []) }
            // Back into the parent's space.
            let inv = invertMatrix(parentM)
            next[id] = isIdentityMatrix(inv) ? r : try transformVectorNode(r, inv)
        }
        try change("Attach to \(plane.prefix(1).uppercased())\(plane.dropFirst()) Plane") {
            setDoc(try mapTree(doc.nodes) { next[$0.id] ?? $0 })
        }
        return (.success, ids)
    }
}
