import Foundation
import PixerateCore
import PixeratePaint

// Provider vector effects in the vector editor (`vectorEffectGroups`, `addVectorEffect`,
// `updateVectorEffect`, `detachVectorEffect` and the effects slot of `vector/controller.ts`): a
// vector effect (a lower third, a sticker, a badge) brings its own picture as SVG, which is read
// with the SVG importer and added as a group that keeps the effect (`providerEffect`: effect id,
// provider, name and values), so it can be drawn again with new values. The group draws as any
// group does; the effect itself is not part of the drawing (its motion plays in the animation
// editor), so render data and SVG export show its shapes.

extension VectorEditorController {
    /// The registered effects provider, or nil.
    public var effectsProvider: EffectProvider? { effectsSlot }

    /// Registers (or with nil removes) the effects provider. Not an edit: no undo step.
    public func setEffectsProvider(_ provider: EffectProvider?) {
        if provider === effectsSlot { return }
        effectsSlot = provider
    }

    /// Registers `provider` and returns a function that removes it again (if it is still the one set).
    public func useEffects(_ provider: EffectProvider) -> () -> Void {
        setEffectsProvider(provider)
        return { [weak self] in
            if self?.effectsSlot === provider { self?.setEffectsProvider(nil) }
        }
    }

    func requireEffects() throws -> EffectProvider {
        guard let p = effectsSlot else { throw EffectError("no_provider", "No effects provider is registered with this editor. The host must call setEffectsProvider(provider) first.") }
        return p
    }

    /// The groups that show provider vector effects, in document order.
    public func vectorEffectGroups() -> [VectorNode] {
        var out: [VectorNode] = []
        walkVectorNodes(doc.nodes) { n, _, _ in if n.isGroup && truthy(n["providerEffect"]) { out.append(n) } }
        return out
    }

    /// The effect's picture as group children with fresh ids, its natural size and the effect it records.
    private func vectorEffectPicture(_ effect: String, _ values: JSONObject?) async throws -> (children: [VectorNode], width: Double, height: Double, tag: JSONObject) {
        let provider = try requireEffects()
        guard let vector = provider as? VectorEffectProvider else { throw EffectError.unsupported("\(provider.name) has no vector effects.") }
        let d = try await provider.describe(effect)
        if d.kind != "vector" {
            throw EffectError.unsupported("\"\(d.id)\" (\(d.name)) is a \(d.kind) effect; the vector editor adds vector effects, which bring their own picture\(d.kind == "motion" ? " (apply motion in the animation editor)" : "").", d.id)
        }
        let resolved = try resolveEffectValues(d, values)
        let motion = try await vector.applyVectorEffect(d.id, target: EffectVectorTarget(svg: try toSvg()), values: resolved)
        let parsed = try parseVectorSvg(motion.svg)
        if parsed.nodes.isEmpty { throw VectorEditorError("\"\(d.name)\" drew no shapes the editor can read.") }
        let children = try parsed.nodes.map { try freshIds($0) }
        let tag = JSONObject([("effect", .string(d.id)), ("provider", .string(provider.id)), ("name", .string(d.name)), ("values", .object(resolved))])
        return (children, parsed.width, parsed.height, tag)
    }

    /**
     * Adds a provider vector effect's picture (at rest: its SVG without the motion) as a group,
     * fitted into `box` (default the middle half of the document), selected. One undo step.
     * Returns the group id.
     */
    @discardableResult
    public func addVectorEffect(_ effect: String, values: JSONObject? = nil, box: VectorBounds? = nil, parentId: String? = nil) async throws -> String {
        let (children, width, height, tag) = try await vectorEffectPicture(effect, values)
        let b = box ?? VectorBounds(x: doc.width / 4, y: doc.height / 4, width: doc.width / 2, height: doc.height / 2)
        let k = Swift.min(b.width / width, b.height / height)
        let name = tag["name"]?.stringValue ?? tag["effect"]!.stringValue!
        let transform: JSONValue = .array([k, 0, 0, k, b.x + (b.width - width * k) / 2, b.y + (b.height - height * k) / 2].map { .number($0) })
        let props = JSONObject([("type", "group"), ("id", .string(newId())), ("name", .string(name)), ("children", .null), ("transform", transform), ("providerEffect", .object(tag))])
        return try addNode(VectorNode(props: props, children: children), AddVectorNodeOptions(parentId: parentId, label: "Add \(name)"))
    }

    /**
     * Draws a vector effect group again with new `values` (merged over its own; `null` resets a
     * control), keeping its place and transform. One undo step. Returns the group's effect.
     */
    @discardableResult
    public func updateVectorEffect(_ id: String, _ values: JSONObject) async throws -> JSONObject {
        guard let node = getNode(id), node.isGroup, let was = node["providerEffect"]?.objectValue else { throw VectorEditorError("\"\(id)\" is not a vector effect group; list_applied_effects lists them.") }
        let effect = was["effect"]?.stringValue ?? ""
        let d = try await requireEffects().describe(effect)
        var merged = was["values"]?.objectValue ?? JSONObject()
        let controls = d.controls["properties"]?.objectValue ?? JSONObject()
        for (k, v) in values {
            if v == .null {
                if !controls.contains(k) { throw VectorEditorError("\"\(k)\" is not a control of \"\(d.id)\"; its controls are \(controls.keys.joined(separator: ", ")).") }
                merged[k] = d.defaults[k]
            } else {
                merged[k] = v
            }
        }
        let (children, _, _, tag) = try await vectorEffectPicture(effect, merged)
        try change("Change \(tag["name"]?.stringValue ?? effect)") {
            var next = node
            next.children = children
            next["providerEffect"] = .object(tag)
            try replaceNode(id, next)
        }
        return tag
    }

    /// Keeps a vector effect group's shapes as a plain group (drops its effect). One undo step.
    public func detachVectorEffect(_ id: String) throws {
        guard let node = getNode(id), node.isGroup, truthy(node["providerEffect"]) else { throw VectorEditorError("\"\(id)\" is not a vector effect group.") }
        try change("Detach effect") {
            var rest = node
            rest["providerEffect"] = nil
            try replaceNode(id, rest)
        }
    }
}
