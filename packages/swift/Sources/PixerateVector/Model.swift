import Foundation
import PixerateCore

// The vector document model (`vector/types.ts` in the TS core).
//
// TypeScript nodes are plain objects: their keys keep insertion order, an assignment to a key
// that is already there keeps its place, a new key goes to the end, and `delete` removes it.
// `toJSON` (`JSON.stringify`) writes them in that order and leaves out `undefined`. The Swift
// model keeps the same rules so a document reads and writes back exactly:
//
// - Anchors and subpaths, which the geometry works on, are typed structs. They remember their
//   key order: reading keeps the order read, setting an absent field appends it, setting it to
//   `nil` removes it. Fields they do not type (and explicit `null`s of the typed ones) are kept as
//   JSON, in place.
// - Nodes, symbols and the document are JSON objects with typed slots for the arrays the geometry
//   walks (`subpaths`, `children`, `nodes`, `symbols`). Everything else (style, gradients,
//   effects, filters, masks, frames, symmetry, text, provider effects, unknown fields, …) stays
//   JSON, so it round-trips before its feature is ported. Typed accessors read and write it.
//
// Handle points (`in` / `out`) keep only `x` and `y`.

/// A point in document coordinates (`Vec2`).
public struct Vec2: Equatable, Hashable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }

    /// `{ x, y }`.
    public var json: JSONValue { .object(JSONObject([("x", .number(x)), ("y", .number(y))])) }

    /// A point from `{ x, y }` with numeric members, or nil.
    public init?(json: JSONValue?) {
        guard let o = json?.objectValue, let x = o["x"]?.numberValue, let y = o["y"]?.numberValue else { return nil }
        self.x = x
        self.y = y
    }
}

/// How an anchor's handles relate (default `corner`).
public enum VectorAnchorType: String, Sendable, CaseIterable {
    case corner, smooth, symmetric
}

/// Live corner shapes.
public enum VectorCornerKind: String, Sendable, CaseIterable {
    case round, inverted, chamfer
}

/// Thrown when a document's JSON is not a vector document.
public struct VectorModelError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Thrown where the TS geometry reaches into a feature this port does not have yet (#624).
public struct VectorNotPorted: Error, CustomStringConvertible, Sendable {
    public let feature: String
    public init(_ feature: String) { self.feature = feature }
    public var description: String { "not ported yet: \(feature) (#624)" }
}

// MARK: - JavaScript value semantics

/// JavaScript truthiness of an optional member (`!!value`): absent, `null`, `false`, `0`, `NaN`
/// and `""` are false.
@inline(__always) func truthy(_ v: JSONValue?) -> Bool {
    switch v {
    case .none, .some(.null): return false
    case .some(.bool(let b)): return b
    case .some(.number(let n)): return n != 0 && !n.isNaN
    case .some(.string(let s)): return !s.isEmpty
    case .some(.array), .some(.object): return true
    }
}

/// An array member's length when it is an array (`value?.length`), else nil.
@inline(__always) func arrayLength(_ v: JSONValue?) -> Int? { v?.arrayValue?.count }

/// Removes `key` from an object (a statement that cannot be read as writing JSON `null`).
@inline(__always) func remove(_ o: inout JSONObject, _ key: String) { o[key] = Optional<JSONValue>.none }

// MARK: - Corner

/// A live corner (`VectorCorner`): `{ radius, kind?, smoothing? }`, kept as its JSON object so
/// unknown members survive.
public struct VectorCorner: Equatable, Sendable {
    public var json: JSONObject

    public init(_ json: JSONObject) { self.json = json }

    /// `{ radius, kind?, smoothing? }` in that order.
    public init(radius: Double, kind: String? = nil, smoothing: Double? = nil) {
        var o = JSONObject([("radius", .number(radius))])
        if let kind { o["kind"] = .string(kind) }
        if let smoothing { o["smoothing"] = .number(smoothing) }
        json = o
    }

    /// The radius when it is a number.
    public var radius: Double? {
        get { json["radius"]?.numberValue }
        set { json["radius"] = newValue.map { .number($0) } }
    }

    /// The kind as stored (any string).
    public var kindName: String? {
        get { json["kind"]?.stringValue }
        set { json["kind"] = newValue.map { .string($0) } }
    }

    /// The kind when it is a known one.
    public var kind: VectorCornerKind? { kindName.flatMap(VectorCornerKind.init(rawValue:)) }

    /// The smoothing when it is a number.
    public var smoothing: Double? {
        get { json["smoothing"]?.numberValue }
        set { json["smoothing"] = newValue.map { .number($0) } }
    }
}

// MARK: - Anchor

/// One anchor of a subpath (`VectorAnchor`). Handles are absolute positions; a missing handle
/// sits on the anchor.
public struct VectorAnchor: Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// Control point of the segment arriving at this anchor.
    public var `in`: Vec2? { didSet { track("in", `in` != nil) } }
    /// Control point of the segment leaving this anchor.
    public var out: Vec2? { didSet { track("out", out != nil) } }
    public var type: VectorAnchorType? { didSet { track("type", type != nil) } }
    public var corner: VectorCorner? { didSet { track("corner", corner != nil) } }
    public var id: String? { didSet { track("id", id != nil) } }
    /// Members not typed above, and typed members whose JSON was not of their type (`null`).
    private var extra: JSONObject
    /// The JSON key order.
    private var order: [String]

    private static let typedKeys: Set<String> = ["x", "y", "in", "out", "type", "corner", "id"]

    /// An anchor with its keys in the order `x, y, in, out, type, corner, id` (those given).
    public init(x: Double, y: Double, in hin: Vec2? = nil, out hout: Vec2? = nil, type: VectorAnchorType? = nil, corner: VectorCorner? = nil, id: String? = nil) {
        self.x = x
        self.y = y
        self.in = hin
        self.out = hout
        self.type = type
        self.corner = corner
        self.id = id
        extra = JSONObject()
        var keys = ["x", "y"]
        if hin != nil { keys.append("in") }
        if hout != nil { keys.append("out") }
        if type != nil { keys.append("type") }
        if corner != nil { keys.append("corner") }
        if id != nil { keys.append("id") }
        order = keys
    }

    /// Reads an anchor (`x` and `y` must be numbers).
    public init(json value: JSONValue) throws {
        guard let o = value.objectValue else { throw VectorModelError("An anchor must be an object.") }
        guard let x = o["x"]?.numberValue, let y = o["y"]?.numberValue else { throw VectorModelError("An anchor needs numeric x and y.") }
        self.x = x
        self.y = y
        var extra = JSONObject()
        var hin: Vec2?, hout: Vec2?, type: VectorAnchorType?, corner: VectorCorner?, id: String?
        for (k, v) in o {
            switch k {
            case "x", "y": break
            case "in": if let p = Vec2(json: v) { hin = p } else { extra[k] = v }
            case "out": if let p = Vec2(json: v) { hout = p } else { extra[k] = v }
            case "type": if let t = v.stringValue.flatMap(VectorAnchorType.init(rawValue:)) { type = t } else { extra[k] = v }
            case "corner": if let c = v.objectValue { corner = VectorCorner(c) } else { extra[k] = v }
            case "id": if let s = v.stringValue { id = s } else { extra[k] = v }
            default: extra[k] = v
            }
        }
        self.in = hin
        self.out = hout
        self.type = type
        self.corner = corner
        self.id = id
        self.extra = extra
        order = o.keys
    }

    private mutating func track(_ key: String, _ present: Bool) {
        remove(&extra, key)
        if present {
            if !order.contains(key) { order.append(key) }
        } else {
            order.removeAll { $0 == key }
        }
    }

    /// The anchor's keys in JSON order.
    public var keys: [String] { order }

    /// A member as JSON (typed members encoded), or nil when absent.
    public subscript(key: String) -> JSONValue? {
        get {
            switch key {
            case "x": return .number(x)
            case "y": return .number(y)
            case "in": return `in`?.json ?? extra[key]
            case "out": return out?.json ?? extra[key]
            case "type": return type.map { .string($0.rawValue) } ?? extra[key]
            case "corner": return corner.map { .object($0.json) } ?? extra[key]
            case "id": return id.map { .string($0) } ?? extra[key]
            default: return extra[key]
            }
        }
        set {
            switch key {
            case "x": x = newValue?.numberValue ?? .nan
            case "y": y = newValue?.numberValue ?? .nan
            default:
                // Clear the typed member, then store what it decodes to (or the raw JSON).
                if Self.typedKeys.contains(key) {
                    switch key {
                    case "in": `in` = nil
                    case "out": out = nil
                    case "type": type = nil
                    case "corner": corner = nil
                    default: id = nil
                    }
                }
                guard let v = newValue else {
                    remove(&extra, key)
                    order.removeAll { $0 == key }
                    return
                }
                if !order.contains(key) { order.append(key) }
                switch key {
                case "in": if let p = Vec2(json: v) { `in` = p; return }
                case "out": if let p = Vec2(json: v) { out = p; return }
                case "type": if let t = v.stringValue.flatMap(VectorAnchorType.init(rawValue:)) { type = t; return }
                case "corner": if let c = v.objectValue { corner = VectorCorner(c); return }
                case "id": if let s = v.stringValue { id = s; return }
                default: break
                }
                extra[key] = v
            }
        }
    }

    /// The type as stored, known or not (`a.type` reads it in the TS).
    var rawTypeName: String? { type?.rawValue ?? extra["type"]?.stringValue }

    /// The anchor as JSON, keys in order.
    public func toJSON() -> JSONValue {
        var o = JSONObject()
        for k in order { if let v = self[k] { o[k] = v } }
        return .object(o)
    }
}

// MARK: - Subpath

/// A chain of anchors joined by line or cubic segments (`VectorSubpath`).
public struct VectorSubpath: Equatable, Sendable {
    public var anchors: [VectorAnchor] { didSet { if !order.contains("anchors") { order.append("anchors") } } }
    /// Joins the last anchor back to the first.
    public var closed: Bool { didSet { if !order.contains("closed") { order.append("closed") } } }
    private var extra: JSONObject
    private var order: [String]

    /// `{ anchors, closed }`.
    public init(anchors: [VectorAnchor], closed: Bool) {
        self.anchors = anchors
        self.closed = closed
        extra = JSONObject()
        order = ["anchors", "closed"]
    }

    /// `{ closed, anchors }` (the key order some TS builders use).
    public init(closed: Bool, anchors: [VectorAnchor]) {
        self.anchors = anchors
        self.closed = closed
        extra = JSONObject()
        order = ["closed", "anchors"]
    }

    public init(json value: JSONValue) throws {
        guard let o = value.objectValue else { throw VectorModelError("A subpath must be an object.") }
        guard let list = o["anchors"]?.arrayValue else { throw VectorModelError("A subpath needs an anchors array.") }
        anchors = try list.map { try VectorAnchor(json: $0) }
        switch o["closed"] {
        case .none: closed = false
        case .some(.bool(let b)): closed = b
        default: throw VectorModelError("A subpath's closed must be a boolean.")
        }
        var extra = JSONObject()
        for (k, v) in o where k != "anchors" && k != "closed" { extra[k] = v }
        self.extra = extra
        order = o.keys
    }

    /// The subpath's keys in JSON order.
    public var keys: [String] { order }

    /// A member not typed above (`anchors` and `closed` are the properties).
    public subscript(key: String) -> JSONValue? {
        get {
            switch key {
            case "anchors": return .array(anchors.map { $0.toJSON() })
            case "closed": return order.contains("closed") ? .bool(closed) : nil
            default: return extra[key]
            }
        }
        set {
            precondition(key != "anchors" && key != "closed", "set anchors and closed through their properties")
            if let v = newValue {
                if !order.contains(key) { order.append(key) }
                extra[key] = v
            } else {
                remove(&extra, key)
                order.removeAll { $0 == key }
            }
        }
    }

    public func toJSON() -> JSONValue {
        var o = JSONObject()
        for k in order { if let v = self[k] { o[k] = v } }
        return .object(o)
    }
}

// MARK: - Node

/// The kinds of vector node.
public enum VectorNodeType: String, Sendable, CaseIterable {
    case path, group, text, instance
}

/// A vector node (`VectorNode`: a path, group, text or instance), as its JSON object with typed
/// `subpaths` (paths) and `children` (groups). Other members are read and written as JSON, by
/// `subscript` or the typed accessors.
public struct VectorNode: Equatable, Sendable {
    /// The members, in order; the slots' places hold `null` placeholders.
    private var props: JSONObject
    private var hasSubpaths: Bool
    private var hasChildren: Bool

    /// A path's subpaths (empty for other nodes). Setting it on a node without them adds the key.
    public var subpaths: [VectorSubpath] {
        didSet {
            if !hasSubpaths {
                props["subpaths"] = .null
                hasSubpaths = true
            }
        }
    }

    /// A group's children (empty for other nodes). Setting it on a node without them adds the key.
    public var children: [VectorNode] {
        didSet {
            if !hasChildren {
                props["children"] = .null
                hasChildren = true
            }
        }
    }

    /// A node from its members; `subpaths` / `children` are added at the end unless `props`
    /// already has the key (then they take its place).
    public init(props: JSONObject, subpaths: [VectorSubpath]? = nil, children: [VectorNode]? = nil) {
        var p = props
        if subpaths != nil { p["subpaths"] = .null }
        if children != nil { p["children"] = .null }
        self.props = p
        hasSubpaths = subpaths != nil
        hasChildren = children != nil
        self.subpaths = subpaths ?? []
        self.children = children ?? []
    }

    /// Reads a node. Paths need a `subpaths` array and groups a `children` array; other members
    /// are kept as they are.
    public init(json value: JSONValue) throws {
        guard var o = value.objectValue else { throw VectorModelError("A node must be an object.") }
        guard o["type"]?.stringValue != nil else { throw VectorModelError("A node needs a type.") }
        var subs: [VectorSubpath] = []
        var kids: [VectorNode] = []
        var hasS = false, hasC = false
        switch o["type"]?.stringValue {
        case "path":
            guard let list = o["subpaths"]?.arrayValue else { throw VectorModelError("Path \(o["id"]?.stringValue ?? "?") needs a subpaths array.") }
            subs = try list.map { try VectorSubpath(json: $0) }
            o["subpaths"] = .null
            hasS = true
        case "group":
            guard let list = o["children"]?.arrayValue else { throw VectorModelError("Group \(o["id"]?.stringValue ?? "?") needs a children array.") }
            kids = try list.map { try VectorNode(json: $0) }
            o["children"] = .null
            hasC = true
        default: break
        }
        props = o
        hasSubpaths = hasS
        hasChildren = hasC
        subpaths = subs
        children = kids
    }

    /// The node's keys in JSON order.
    public var keys: [String] { props.keys }

    /// Whether the node has the member.
    public func has(_ key: String) -> Bool { props.contains(key) }

    /// A member as JSON (`subpaths` and `children` encoded), or nil when absent.
    public subscript(key: String) -> JSONValue? {
        get {
            if key == "subpaths" && hasSubpaths { return .array(subpaths.map { $0.toJSON() }) }
            if key == "children" && hasChildren { return .array(children.map { $0.toJSON() }) }
            return props[key]
        }
        set {
            if key == "subpaths" && hasSubpaths {
                if let list = newValue?.arrayValue, let s = try? list.map({ try VectorSubpath(json: $0) }) {
                    subpaths = s
                    return
                }
                hasSubpaths = false
                subpaths = []
                hasSubpaths = false // (the didSet above put the slot back)
            } else if key == "children" && hasChildren {
                if let list = newValue?.arrayValue, let c = try? list.map({ try VectorNode(json: $0) }) {
                    children = c
                    return
                }
                hasChildren = false
                children = []
                hasChildren = false
            }
            props[key] = newValue
        }
    }

    /// The node as JSON, keys in order.
    public func toJSON() -> JSONValue {
        var o = JSONObject()
        for (k, v) in props {
            if k == "subpaths" && hasSubpaths { o[k] = .array(subpaths.map { $0.toJSON() }) }
            else if k == "children" && hasChildren { o[k] = .array(children.map { $0.toJSON() }) }
            else { o[k] = v }
        }
        return .object(o)
    }

    // MARK: Typed accessors

    public var id: String {
        get { props["id"]?.stringValue ?? "" }
        set { props["id"] = .string(newValue) }
    }

    /// The `type` member as stored.
    public var typeName: String { props["type"]?.stringValue ?? "" }
    /// The node type, or nil for one this version does not know.
    public var type: VectorNodeType? { VectorNodeType(rawValue: typeName) }
    public var isPath: Bool { typeName == "path" }
    public var isGroup: Bool { typeName == "group" }
    public var isText: Bool { typeName == "text" }
    public var isInstance: Bool { typeName == "instance" }

    public var name: String? {
        get { props["name"]?.stringValue }
        set { props["name"] = newValue.map { .string($0) } }
    }

    /// `visible !== false`.
    public var isVisible: Bool { props["visible"] != .bool(false) }
    /// `!!locked`.
    public var isLocked: Bool { truthy(props["locked"]) }

    public var opacity: Double? {
        get { props["opacity"]?.numberValue }
        set { props["opacity"] = newValue.map { .number($0) } }
    }

    /// The rigid placement matrix, when it is six numbers.
    public var transform: VectorMatrix? {
        get { VectorMatrix(json: props["transform"]) }
        set { props["transform"] = newValue?.json }
    }

    /// Paints (`VectorPaint`: a CSS colour string, a gradient object or `null`).
    public var fill: JSONValue? {
        get { props["fill"] }
        set { props["fill"] = newValue }
    }

    public var stroke: JSONValue? {
        get { props["stroke"] }
        set { props["stroke"] = newValue }
    }

    public var strokeWidth: Double? {
        get { props["strokeWidth"]?.numberValue }
        set { props["strokeWidth"] = newValue.map { .number($0) } }
    }

    /// `nonzero` or `evenodd` when set.
    public var fillRule: String? {
        get { props["fillRule"]?.stringValue }
        set { props["fillRule"] = newValue.map { .string($0) } }
    }

    /// A text node's `frame`, or a group's frame (`VectorFrame`) object.
    public var frame: JSONObject? { props["frame"]?.objectValue }
}

// MARK: - Symbol

/// A symbol (`VectorSymbol`): `{ id, name, nodes }` with typed `nodes`.
public struct VectorSymbol: Equatable, Sendable {
    private var props: JSONObject
    public var nodes: [VectorNode] { didSet { if props["nodes"] == nil { props["nodes"] = .null } } }

    public init(id: String, name: String, nodes: [VectorNode]) {
        props = JSONObject([("id", .string(id)), ("name", .string(name)), ("nodes", .null)])
        self.nodes = nodes
    }

    public init(json value: JSONValue) throws {
        guard var o = value.objectValue else { throw VectorModelError("A symbol must be an object.") }
        guard let list = o["nodes"]?.arrayValue else { throw VectorModelError("A symbol needs a nodes array.") }
        nodes = try list.map { try VectorNode(json: $0) }
        o["nodes"] = .null
        props = o
    }

    public var id: String { props["id"]?.stringValue ?? "" }
    public var name: String { props["name"]?.stringValue ?? "" }

    public subscript(key: String) -> JSONValue? {
        get { key == "nodes" ? .array(nodes.map { $0.toJSON() }) : props[key] }
        set {
            precondition(key != "nodes", "set nodes through the property")
            props[key] = newValue
        }
    }

    public func toJSON() -> JSONValue {
        var o = JSONObject()
        for (k, v) in props { o[k] = k == "nodes" ? .array(nodes.map { $0.toJSON() }) : v }
        return .object(o)
    }
}

// MARK: - Document

/// A vector drawing (`VectorDocument`): an artboard and its nodes, bottom to top, with typed
/// `nodes` and `symbols`. Constraints, parameters, perspective and unknown members stay JSON.
public struct VectorDocument: Equatable, Sendable {
    private var props: JSONObject
    private var hasSymbols: Bool

    public var nodes: [VectorNode] { didSet { if props["nodes"] == nil { props["nodes"] = .null } } }

    /// The document's symbols (nil: no `symbols` member, or one that is not a list of symbols).
    public var symbols: [VectorSymbol]? {
        didSet {
            if symbols != nil {
                props["symbols"] = .null
                hasSymbols = true
            } else if hasSymbols {
                remove(&props, "symbols")
                hasSymbols = false
            }
        }
    }

    /// `{ width, height, nodes }`.
    public init(width: Double, height: Double, nodes: [VectorNode] = []) {
        props = JSONObject([("width", .number(width)), ("height", .number(height)), ("nodes", .null)])
        hasSymbols = false
        self.nodes = nodes
        symbols = nil
    }

    /// Reads a document as `get_vector_document` and `VectorEditorController.toJSON` return it.
    public init(json value: JSONValue) throws {
        guard var o = value.objectValue else { throw VectorModelError("A vector document must be an object.") }
        guard let list = o["nodes"]?.arrayValue else { throw VectorModelError("A vector document needs a nodes array.") }
        nodes = try list.map { try VectorNode(json: $0) }
        o["nodes"] = .null
        if let raw = o["symbols"]?.arrayValue {
            symbols = try raw.map { try VectorSymbol(json: $0) }
            o["symbols"] = .null
            hasSymbols = true
        } else {
            symbols = nil
            hasSymbols = false
        }
        props = o
    }

    /// Parses JSON text.
    public static func fromJSON(_ text: String) throws -> VectorDocument { try VectorDocument(json: JSONValue.parse(text)) }

    public var keys: [String] { props.keys }

    public var width: Double {
        get { props["width"]?.numberValue ?? .nan }
        set { props["width"] = .number(newValue) }
    }

    public var height: Double {
        get { props["height"]?.numberValue ?? .nan }
        set { props["height"] = .number(newValue) }
    }

    public var background: String? {
        get { props["background"]?.stringValue }
        set { props["background"] = newValue.map { .string($0) } }
    }

    /// A member as JSON (`nodes` and `symbols` encoded).
    public subscript(key: String) -> JSONValue? {
        get {
            if key == "nodes" { return .array(nodes.map { $0.toJSON() }) }
            if key == "symbols" && hasSymbols { return symbols.map { .array($0.map { $0.toJSON() }) } }
            return props[key]
        }
        set {
            precondition(key != "nodes" && !(key == "symbols" && hasSymbols), "set nodes and symbols through their properties")
            props[key] = newValue
        }
    }

    public func toJSON() -> JSONValue {
        var o = JSONObject()
        for (k, v) in props {
            if k == "nodes" { o[k] = .array(nodes.map { $0.toJSON() }) }
            else if k == "symbols" && hasSymbols { o[k] = .array((symbols ?? []).map { $0.toJSON() }) }
            else { o[k] = v }
        }
        return .object(o)
    }
}

// MARK: - Bounds and references

/// An axis-aligned rectangle (`VectorBounds`).
public struct VectorBounds: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    /// `{ x, y, width, height }`.
    public var json: JSONValue {
        .object(JSONObject([("x", .number(x)), ("y", .number(y)), ("width", .number(width)), ("height", .number(height))]))
    }
}
