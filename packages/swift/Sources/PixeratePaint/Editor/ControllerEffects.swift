import Foundation
import PixerateCore
import PixerateRaster

/// Layer styles (live layer effects) on paint layers (`controller.ts`, layer effects section): one undo step each.
extension PaintEditorController {
    private func effectGuard<T>(_ fn: () throws -> T) throws -> T {
        do { return try fn() } catch let e as LayerEffectError { throw PaintEditorError(e.message) }
    }

    /// A layer's live effects (an empty, enabled list when it has none).
    public func getLayerEffects(_ id: String) throws -> LayerEffects {
        guard let l = getLayer(id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        return l.effects ?? LayerEffects(enabled: true, items: [])
    }

    private func effectsLayer(_ id: String, _ action: String) throws -> PaintLayer {
        guard let l = getLayer(id) else { throw PaintEditorError("Unknown layer \"\(id)\". Call list_layers for the ids.") }
        if isLayerLocked(l.locks, .all) { throw PaintEditorError("Layer \"\(l.name)\" is fully locked, so it can't \(action); unlock it first (locks {all: false}).") }
        return l
    }

    private func requireEffect(_ id: String, _ effectId: String) throws -> Int {
        let l = getLayer(id)!
        let items = l.effects?.items ?? []
        guard let i = items.firstIndex(where: { $0.id == effectId }) else {
            let list = items.map { "\($0.id) (\($0.kind.rawValue))" }.joined(separator: ", ")
            throw PaintEditorError("Layer \"\(l.name)\" has no effect \"\(effectId)\". Effects: \(list.isEmpty ? "none" : list); call list_layer_effects.")
        }
        return i
    }

    /// Writes a layer's effects (dropped when empty, enabled and unscaled) as an undo step.
    private func writeLayerEffects(_ id: String, _ effects: LayerEffects?, _ label: String) {
        let l = getLayer(id)!
        let keep = effects.map { !$0.items.isEmpty || $0.psd != nil || $0.scale != nil || !$0.enabled } ?? false
        let next = l.copy(effects: .some(keep ? effects : nil))
        commit(label, doc.with { $0.layers = mapLayer(doc.layers, id) { _ in next } })
    }

    /// Adds a live effect of `kind` with Photoshop's defaults and `settings` applied (one undo step).
    public func addLayerEffect(_ id: String, _ kindName: String, _ settings: JSONObject, index: Int?) throws -> LayerEffect {
        guard let kind = LayerEffectKind(rawValue: kindName) else { throw PaintEditorError("Unknown effect kind \"\(kindName)\". Kinds: \(LAYER_EFFECT_KINDS.map(\.rawValue).joined(separator: ", ")).") }
        let current = try effectsLayer(id, "add effects").effects ?? LayerEffects(enabled: true, items: [])
        let ids = Set(current.items.map(\.id))
        var effectId = newEffectId()
        while ids.contains(effectId) { effectId = newEffectId() }
        let effect = try effectGuard { try mergeLayerEffect(defaultLayerEffect(kind, effectId), settings.without("id", "kind")) }
        var items = current.items
        let at = index.map { Swift.max(0, Swift.min(items.count, $0)) } ?? items.count
        items.insert(effect, at: at)
        var next = current
        next.items = items
        writeLayerEffects(id, next, "Add \(layerEffectLabel(kind))")
        return effect
    }

    /// Changes one effect: only the given settings (one undo step).
    public func updateLayerEffect(_ id: String, _ effectId: String, _ changes: JSONObject) throws {
        var current = try effectsLayer(id, "change its effects").effects!
        let i = try requireEffect(id, effectId)
        current.items[i] = try effectGuard { try mergeLayerEffect(current.items[i], changes) }
        writeLayerEffects(id, current, "Change \(layerEffectLabel(current.items[i].kind))")
    }

    /// Removes one effect (one undo step).
    public func removeLayerEffect(_ id: String, _ effectId: String) throws {
        var current = try effectsLayer(id, "change its effects").effects!
        let i = try requireEffect(id, effectId)
        let kind = current.items[i].kind
        current.items.removeAll { $0.id == effectId }
        writeLayerEffects(id, current, "Remove \(layerEffectLabel(kind))")
    }

    /// Turns all of a layer's effects on or off and, when given, sets Scale Effects (0.01..10).
    public func setLayerEffectsEnabled(_ id: String, _ enabled: Bool, scale: Double?) throws {
        var next = try effectsLayer(id, "change its effects").effects ?? LayerEffects(enabled: true, items: [])
        if let scale, !(scale.isFinite && scale >= 0.01 && scale <= 10) { throw PaintEditorError("scale must be from 0.01 to 10 (1 = 100 %), got \(jsText(scale)).") }
        next.enabled = enabled
        if let scale { next.scale = scale == 1 ? nil : scale }
        writeLayerEffects(id, next, "Layer effects")
    }
}

/// A layer's effects for agents: the master switch, scale, reach and every effect with its settings.
func describeLayerEffects(_ effects: LayerEffects) -> JSONObject {
    ["enabled": .bool(effects.enabled), "scale": .number(effects.scale ?? 1), "margin": .number(Double(effectsMargin(effects))), "fromPsd": .bool(effects.psd != nil),
     "effects": .array(effects.items.map { e in var o = e.json.objectValue!; o["label"] = .string(layerEffectLabel(e.kind)); return .object(o) })]
}

/// A layer's effects as a document stores them.
func serializeEffects(_ effects: LayerEffects) -> JSONValue {
    var o: JSONObject = ["enabled": .bool(effects.enabled), "items": .array(effects.items.map(\.json))]
    if let s = effects.scale, s != 1 { o["scale"] = .number(s) }
    if let psd = effects.psd { o["psd"] = ["key": .string(psd.key), "data": .string(bytesToBase64(psd.data))] }
    return .object(o)
}

/// The handlers of the layer effect tools (`image-editor/effect-tools.ts` on paint layers).
func paintEffectHandlers(_ c: PaintEditorController) -> [String: PaintToolHandler] {
    func layerArg(_ v: JSONValue?) throws -> String {
        guard let id = v?.stringValue, !id.isEmpty else { throw PaintEditorError("layerId is required (a layer id from list_layers).") }
        _ = try c.getLayerEffects(id)
        return id
    }
    func result(_ id: String, _ extra: JSONObject = [:]) throws -> JSONValue {
        var o: JSONObject = ["layerId": .string(id)]
        for (k, v) in extra { o[k] = v }
        for (k, v) in describeLayerEffects(try c.getLayerEffects(id)) { o[k] = v }
        return .object(o)
    }
    var h: [String: PaintToolHandler] = [:]
    h["list_layer_effects"] = { a in
        let id = try layerArg(a["layerId"])
        let patterns: [JSONValue] = builtinPatternIds().map { pid in
            let p = builtinPattern(pid)!
            return ["id": .string(pid), "name": .string(p.name), "width": .number(Double(p.width)), "height": .number(Double(p.height)), "builtin": true]
        }
        return try result(id, ["globalLight": ["angle": .number(DEFAULT_GLOBAL_LIGHT.angle), "altitude": .number(DEFAULT_GLOBAL_LIGHT.altitude)], "patterns": .array(patterns), "kinds": .array(LAYER_EFFECT_KINDS.map { .string($0.rawValue) })])
    }
    h["add_layer_effect"] = { a in
        let id = try layerArg(a["layerId"])
        let kind = a["kind"]?.stringValue ?? ""
        if !isLayerEffectKind(kind) { throw PaintEditorError("kind must be one of \(LAYER_EFFECT_KINDS.map(\.rawValue).joined(separator: ", ")).") }
        let effect = try c.addLayerEffect(id, kind, a["settings"]?.objectValue ?? [:], index: a["index"]?.numberValue.map { Int($0) })
        return try result(id, ["effectId": .string(effect.id)])
    }
    h["update_layer_effect"] = { a in
        let id = try layerArg(a["layerId"])
        let changes = a["settings"]?.objectValue ?? [:]
        if changes.isEmpty { throw PaintEditorError("Give at least one setting to change.") }
        try c.updateLayerEffect(id, a["effectId"]?.stringValue ?? "", changes)
        return try result(id)
    }
    h["remove_layer_effect"] = { a in
        let id = try layerArg(a["layerId"])
        try c.removeLayerEffect(id, a["effectId"]?.stringValue ?? "")
        return try result(id)
    }
    h["set_layer_effects_enabled"] = { a in
        let id = try layerArg(a["layerId"])
        try c.setLayerEffectsEnabled(id, a["enabled"]?.boolValue ?? true, scale: a["scale"]?.numberValue)
        return try result(id)
    }
    return h
}
