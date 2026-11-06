import Foundation
import PixerateCore
import PixeratePaint

/**
 * Agent tools for provider effects in the vector editor (`vector/effect-tools.ts`,
 * `createVectorEffectsToolProvider`): the shared effect tools (`effectToolHandlers`), where
 * `apply_effect` adds a provider vector effect's picture (a lower third, a sticker, a badge) as a
 * group, `update_effect` draws it again with new values and `remove_effect` keeps its shapes as a
 * plain group. Motion is applied in the animation editor. Definitions come from the vector
 * contracts (`tools.json`, provider `vector-effects`).
 */

/// A vector tool handler: arguments in, the tool output out.
typealias VectorToolHandler = (JSONObject) async throws -> ToolOutput

/// The tools of a vector contract provider with their handlers; `readOnly` gives the reason the
/// write tools are hidden now (nil while they show).
func vectorContractProvider(_ id: String, namespace: String? = nil, description: String, _ handlers: [String: VectorToolHandler], readOnly: (() -> String?)? = nil, subscribe: ((@escaping () -> Void) -> Cancellable)? = nil) throws -> AgentToolProvider {
    guard let contract = try VectorContracts.toolProviders().first(where: { $0.id == id }) else { throw ContractError("tools.json has no provider \(id).") }
    let tools: [AgentTool] = try contract.tools.map { def in
        guard let handler = handlers[def.name] else { throw ContractError("No handler for the \(id) tool \(def.name).") }
        return AgentTool(name: def.name, title: def.title, description: def.description, inputSchema: def.inputSchema, outputSchema: def.outputSchema, annotations: def.annotations) { args, _ in try await handler(args) }
    }
    return AgentToolProvider(id: id, namespace: namespace, title: contract.title, description: description, skill: contract.skill, tools: {
        guard readOnly?() != nil else { return tools }
        return tools.filter { $0.definition.annotations?.readOnlyHint == true }
    }, subscribe: subscribe)
}

/// Options for `createVectorEffectsToolProvider`.
public struct VectorEffectsToolProviderOptions {
    /// Tool-name prefix (`<namespace>__<name>`); nil for the provider id (bare names unless they collide), `""` for bare names.
    public var namespace: String?
    /// Why the document cannot be edited now (write tools are hidden), or nil.
    public var readOnly: (() -> String?)?
    public init(namespace: String? = nil, readOnly: (() -> String?)? = nil) {
        self.namespace = namespace
        self.readOnly = readOnly
    }
}

/// The effect a vector effect group shows, as the tools report it (`AppliedEffectInfo`).
private func pictureInfo(_ g: VectorNode) -> JSONObject {
    let e = g["providerEffect"]?.objectValue ?? JSONObject()
    var o = JSONObject([("id", "picture"), ("effect", e["effect"] ?? .string(""))])
    if truthy(e["name"]) { o["name"] = e["name"] }
    if truthy(e["provider"]) { o["provider"] = e["provider"] }
    o["role"] = "vector picture"
    o["enabled"] = true
    o["values"] = e["values"] ?? .object(JSONObject())
    return o
}

/// The effect tools of a vector editor (`search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`, `remove_effect`).
public func createVectorEffectsToolProvider(_ controller: VectorEditorController, _ options: VectorEffectsToolProviderOptions = VectorEffectsToolProviderOptions()) throws -> AgentToolProvider {
    func group(_ id: String) throws -> VectorNode {
        let groups = controller.vectorEffectGroups()
        guard let g = groups.first(where: { $0.id == id }) else {
            let ids = groups.map { "\"\($0.id)\"" }.joined(separator: ", ")
            throw EffectToolError("\"\(id)\" is not a vector effect group; the groups are \(ids.isEmpty ? "none" : ids) (list_applied_effects).")
        }
        return g
    }
    func result(_ id: String, _ removed: JSONObject? = nil) -> JSONObject {
        let g = controller.getNode(id)
        let effects = g.map { truthy($0["providerEffect"]) ? [pictureInfo($0)] : [] } ?? []
        var o = JSONObject([("target", .string(id))])
        o["effect"] = (removed ?? effects.first).map { .object($0) }
        o["effects"] = .array(effects.map { .object($0) })
        return o
    }
    let host = EffectToolHost(
        applyUses: ["title", "overlay", "generator", "interactive"],
        provider: { controller.effectsProvider },
        readOnlyReason: { options.readOnly?() },
        list: { target in
            let groups = try target.map { [try group($0)] } ?? controller.vectorEffectGroups()
            return groups.map { g in
                var o = JSONObject([("target", .string(g.id))])
                if let n = g.name, !n.isEmpty { o["name"] = .string(n) }
                o["effects"] = [.object(pictureInfo(g))]
                return o
            }
        },
        apply: { target, effect, args in
            if args["index"] != nil || args["opacity"] != nil || args["enabled"] == .bool(false) { throw EffectToolError("index, opacity and enabled do not apply to vector effects; set the group's opacity with the style commands.") }
            if target != "document" {
                guard let parent = controller.getNode(target), parent.isGroup else { throw EffectToolError("\"\(target)\" is not a group; pass \"document\" for the top level or a group id.") }
            }
            let id = try await controller.addVectorEffect(effect, values: args["values"]?.objectValue, parentId: target != "document" ? target : nil)
            var o = result(id)
            o["group"] = .string(id)
            return .object(o)
        },
        update: { target, instance, changes in
            if instance != "picture" { throw EffectToolError("A vector effect group has one effect, \"picture\".") }
            let extra = ["enabled", "opacity", "index"].filter { changes[$0] != nil }
            if !extra.isEmpty { throw EffectToolError("A vector effect only takes values; \(extra.joined(separator: ", ")) do not apply.") }
            _ = try group(target)
            try await controller.updateVectorEffect(target, changes["values"]?.objectValue ?? JSONObject())
            return .object(result(target))
        },
        remove: { target, instance in
            if instance != "picture" { throw EffectToolError("A vector effect group has one effect, \"picture\".") }
            let was = pictureInfo(try group(target))
            try controller.detachVectorEffect(target)
            return .object(result(target, was))
        }
    )
    let handlers = effectToolHandlers(host).mapValues { h -> VectorToolHandler in { args in .value(try await h(args)) } }
    return try vectorContractProvider("vector-effects", namespace: options.namespace, description: "Provider effects placed in the vector document as effect groups.", handlers, readOnly: options.readOnly, subscribe: { notify in controller.subscribe(notify) })
}
