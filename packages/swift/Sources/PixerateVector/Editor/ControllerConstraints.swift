import Foundation
import PixerateCore
import PixerateRaster

// Constraints on the controller (the "Constraints" section of `vector/controller.ts`): adding,
// removing and auto-adding constraints, values and named parameters. The solve after every edit
// is `solved` in `Controller.swift`, called from `refreshed`.

/// What the last solve could not satisfy (`conflicts`) or interpret (`skipped`; `state.constraintIssues`).
public struct VectorConstraintIssues: Equatable, Sendable {
    public struct Skipped: Equatable, Sendable {
        public var id: String
        public var message: String
    }
    public var conflicts: [String]
    public var skipped: [Skipped]

    /// `{ conflicts, skipped: [{ id, message }] }`.
    public var json: JSONValue {
        .object(JSONObject([
            ("conflicts", .array(conflicts.map { .string($0) })),
            ("skipped", .array(skipped.map { .object(JSONObject([("id", .string($0.id)), ("message", .string($0.message))])) })),
        ]))
    }
}

/// What a constraint edit returns: `ok`, or why it did nothing, with the new constraint's `id`
/// or the ids involved (`VectorActionResult & { id?, ids? }`).
public struct VectorConstraintResult: Equatable, Sendable {
    public var ok: Bool
    public var message: String?
    public var id: String?
    public var ids: [String]?

    static func failure(_ message: String, _ ids: [String]? = nil) -> VectorConstraintResult { VectorConstraintResult(ok: false, message: message, id: nil, ids: ids) }
}

/// `String(value)` of a number or string param.
private func jsText(_ v: JSONValue) -> String {
    switch v {
    case let .string(s): s
    case let .number(n): jsString(n)
    case let .bool(b): b ? "true" : "false"
    case .null: "null"
    default: v.stringified()
    }
}

extension VectorEditorController {
    /// The document's constraints.
    public func getConstraints() -> [VectorConstraint] { vectorConstraints(doc) }

    /// The document's named parameters, as stored.
    public func getParameters() -> [JSONValue] { doc["parameters"]?.arrayValue ?? [] }

    /// Degrees of freedom the constraints leave, and whether any are redundant.
    public func getConstraintDof() -> VectorDofReport { vectorConstraintDof(doc) }

    /// The constraints panel for the selection (the direct tool's anchors, else the selected paths;
    /// `getVectorConstraintPanel`).
    public func constraintPanel() -> JSONValue {
        vectorConstraintPanel(doc, anchors: tool == "direct" ? anchors : [], nodes: selection, conflicts: constraintIssues?.conflicts ?? [])
    }

    /// References from loose input (`{ nodeId, subpath, index }`, or `anchor`, `handle`, `segment`,
    /// `circle`) to stable ones: anchors given by `subpath` / `index` get ids (the path is updated in
    /// `nodes`). Throws on a missing path or anchor.
    private func resolveRefs(_ refs: [JSONValue], _ nodes: inout [String: VectorNode]) throws -> [JSONValue] {
        try refs.enumerated().map { i, r in
            let nodeId = r["nodeId"]?.stringValue ?? ""
            guard let node = nodes[nodeId] ?? getNode(nodeId) else { throw VectorConstraintError("refs[\(i)]: there is no node \"\(nodeId)\".") }
            if !node.isPath { throw VectorConstraintError("refs[\(i)]: \"\(nodeId)\" is a \(node.typeName); constraints refer to paths.") }
            if truthy(r["circle"]) { return .object(JSONObject([("nodeId", .string(nodeId)), ("circle", true)])) }
            var anchor: String
            if let given = r["anchor"] {
                anchor = given.stringValue ?? jsText(given)
                if findVectorAnchorById(node, anchor) == nil { throw VectorConstraintError("refs[\(i)]: \"\(nodeId)\" has no anchor \"\(anchor)\".") }
            } else {
                guard let s = r["subpath"]?.numberValue, let x = r["index"]?.numberValue else { throw VectorConstraintError("refs[\(i)]: give an anchor (subpath and index, or its id), or circle: true.") }
                let subpath = Int(s), index = Int(x)
                guard node.subpaths.indices.contains(subpath), node.subpaths[subpath].anchors.indices.contains(index) else {
                    throw VectorConstraintError("refs[\(i)]: \"\(nodeId)\" has no anchor \(jsString(x)) on subpath \(jsString(s)).")
                }
                let withIds = withVectorAnchorIds(node)
                nodes[node.id] = withIds
                anchor = withIds.subpaths[subpath].anchors[index].id!
            }
            var o = JSONObject([("nodeId", .string(nodeId)), ("anchor", .string(anchor))])
            if truthy(r["handle"]) { o["handle"] = r["handle"]! }
            if truthy(r["segment"]) { o["segment"] = true }
            return .object(o)
        }
    }

    private func newConstraintId() -> String {
        let used = Set(getConstraints().map(\.id))
        var id = "k\(used.count + 1)"
        var n = used.count + 1
        while used.contains(id) {
            id = "k\(n)"
            n += 1
        }
        return id
    }

    /// Adds a constraint (`addConstraint`): refs by anchor (`subpath` / `index`, or its id), handle,
    /// segment or circle; dimensional kinds take a `value` expression (default: what the geometry
    /// measures now) and a `name`. Refuses (changing nothing) one that conflicts with the others or
    /// repeats them, naming them. One undo step. Returns the new constraint's id.
    public func addConstraint(_ input: JSONObject) -> VectorConstraintResult {
        var nodes: [String: VectorNode] = [:]
        let refs: [JSONValue]
        do {
            refs = try resolveRefs(input["refs"]?.arrayValue ?? [], &nodes)
        } catch {
            return .failure(constraintErrorMessage(error))
        }
        let kind = input["kind"]?.stringValue ?? ""
        let id = newConstraintId()
        var withIds = doc
        if !nodes.isEmpty { withIds.nodes = mapTree(doc.nodes) { nodes[$0.id] ?? $0 } }
        var c = JSONObject([("id", .string(id)), ("kind", .string(kind)), ("refs", .array(refs))])
        if let v = input["value"] { c["value"] = .string(jsText(v)) }
        if truthy(input["name"]) { c["name"] = input["name"]! }
        if let axis = input["axis"], truthy(axis), axis != "aligned" { c["axis"] = axis }
        let next: VectorDocument
        do {
            next = try addVectorConstraint(withIds, c)
        } catch let e as VectorConstraintError {
            return .failure(e.message, e.ids)
        } catch {
            return .failure(constraintErrorMessage(error))
        }
        let label = kind.isEmpty ? kind : kind.prefix(1).uppercased() + kind.dropFirst()
        change("Add \(label) Constraint") {
            doc = next
            lastSolved = next
        }
        return VectorConstraintResult(ok: true, message: nil, id: id, ids: nil)
    }

    /// Removes constraints by id. One undo step.
    public func removeConstraints(_ ids: [String]) -> VectorActionResult {
        let set = Set(ids)
        let cons = getConstraints()
        let missing = ids.filter { id in !cons.contains { $0.id == id } }
        if !missing.isEmpty { return .failure("There is no constraint \(missing.map { "\"\($0)\"" }.joined(separator: ", ")).") }
        change(ids.count == 1 ? "Remove Constraint" : "Remove Constraints") {
            let kept = cons.filter { !set.contains($0.id) }
            doc = withVectorConstraints(doc, kept)
            if kept.isEmpty { doc["constraints"] = Optional<JSONValue>.none }
        }
        return .success
    }

    /// Sets a dimensional constraint's value expression (by id or name), or a named parameter's
    /// (creating it; nil removes a parameter), then solves (`setConstraintValue`). Refuses (changing
    /// nothing) a value that does not evaluate or that the constraints cannot meet. One undo step.
    public func setConstraintValue(_ key: String, _ value: JSONValue?) -> VectorConstraintResult {
        let text = value.flatMap { $0.isNull ? nil : jsText($0).jsTrimmed }
        let cons = getConstraints()
        let ci = cons.firstIndex { $0.id == key || $0.name == key }
        let c = ci.map { cons[$0] }
        var trial = doc
        if let c, let ci {
            if !VECTOR_DIMENSIONAL_KINDS.contains(c.kind) { return .failure("\"\(key)\" is a \(c.kind) constraint, which has no value.") }
            guard let text, !text.isEmpty else { return .failure("A dimensional constraint needs a value; remove the constraint instead.") }
            var list = cons
            list[ci].json["value"] = .string(text)
            trial = withVectorConstraints(doc, list)
        } else {
            if !isValidVectorParameterName(key) { return .failure("\"\(key)\" is not a constraint or a valid parameter name (a letter or _, then letters, digits or _).") }
            let params = getParameters()
            let named = { (p: JSONValue) in p["name"]?.stringValue == key }
            if let text {
                if params.contains(where: named) {
                    trial["parameters"] = .array(params.map { p in
                        guard named(p), var o = p.objectValue else { return p }
                        o["value"] = .string(text)
                        return .object(o)
                    })
                } else {
                    trial["parameters"] = .array(params + [.object(JSONObject([("name", .string(key)), ("value", .string(text))]))])
                }
            } else {
                if !params.contains(where: named) { return .failure("There is no parameter \"\(key)\".") }
                trial["parameters"] = .array(params.filter { !named($0) })
            }
        }
        do {
            if let text { try checkVectorExpression(text) }
            // Every dimensional constraint must still evaluate.
            let env = vectorConstraintEnv(trial)
            for x in vectorConstraints(trial) where VECTOR_DIMENSIONAL_KINDS.contains(x.kind) {
                _ = try x.hasName && env.has(x.name!) ? env.value(x.name!) : env.eval(x.value ?? "")
            }
        } catch {
            return .failure("\(key): \(constraintErrorMessage(error))")
        }
        let r = solveVectorConstraints(trial, nil)
        if !r.converged {
            var unique: [String] = []
            for id in r.conflicts where !unique.contains(id) { unique.append(id) }
            return .failure("The constraints cannot meet \(key) = \(text ?? "null"): it conflicts with \(unique.map { "\"\($0)\"" }.joined(separator: ", ")).", r.conflicts)
        }
        change(c != nil ? "Constraint Value" : "Parameter") {
            doc = r.document
            lastSolved = r.document
        }
        return VectorConstraintResult(ok: true, message: nil, id: nil, ids: nil)
    }

    /// Auto-constrain (`autoConstrain`): constraints the paths `ids` (default the selection, or
    /// every path) nearly satisfy, added one by one (redundant or conflicting ones skipped). One
    /// undo step. Returns the ids of the constraints added.
    public func autoConstrain(ids: [String]? = nil, _ infer: VectorInferOptions = VectorInferOptions()) throws -> VectorConstraintResult {
        let roots = ids ?? (selection.isEmpty ? nil : selection)
        if let roots { for id in roots where getNode(id) == nil { return .failure("There is no node \"\(id)\".") } }
        var used = Set(getConstraints().map(\.id))
        var n = used.count
        let newId = { () -> String in
            n += 1
            var id = "k\(n)"
            while used.contains(id) {
                n += 1
                id = "k\(n)"
            }
            used.insert(id)
            return id
        }
        let pathIds = roots.map { $0.flatMap { collectPathNodes(getNode($0)!).map(\.id) } }
        let r = try autoConstrainVector(doc, pathIds, newId, infer)
        if r.added.isEmpty { return VectorConstraintResult(ok: true, message: nil, id: nil, ids: []) }
        change("Auto Constrain") {
            doc = r.document
            lastSolved = r.document
        }
        return VectorConstraintResult(ok: true, message: nil, id: nil, ids: r.added.map(\.id))
    }
}
