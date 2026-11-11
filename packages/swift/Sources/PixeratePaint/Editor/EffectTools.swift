import Foundation
import PixerateCore
import PixerateRaster

/**
 * Agent tools for provider effects in the paint editor (`paint-editor/effect-tools.ts` on the
 * shared `effects/tools.ts`): `search_effects`, `describe_effect`, `list_applied_effects`,
 * `apply_effect` (a filter baked into a layer's dried paint), `update_effect`, `remove_effect`, and
 * `set_paper_effect`, `set_effect_paint`, `set_effect_playback`, `add_effect_layer` and
 * `fill_layer_with_effect`. The target `paper` is the effect paper and `paint` the effect paint.
 * Definitions come from the contracts; without a provider the read tools say so and the write
 * tools refuse with the reason.
 */

private let PAPER_TARGET = "paper"
private let PAINT_TARGET = "paint"
/// What `apply_effect` takes in the paint editor.
private let APPLY_USES = ["filter"]

private typealias ToolError = EffectToolError

private func refJSON(_ s: PaintEffectSource) -> JSONObject {
    var o: JSONObject = ["effect": .string(s.effect)]
    if let n = s.name, !n.isEmpty { o["name"] = .string(n) }
    if let p = s.provider, !p.isEmpty { o["provider"] = .string(p) }
    return o
}

/// The effect tools of a paint editor (`createPaintEffectsToolProvider`).
public func createPaintEffectsToolProvider(_ c: PaintEditorController) throws -> AgentToolProvider {
    func requireProvider() throws -> EffectProvider {
        guard let p = c.effectsCatalog else { throw ToolError(NO_EFFECTS_PROVIDER) }
        return p
    }
    func paperInfo() -> [JSONObject] {
        guard let p = c.getPaperEffect() else { return [] }
        var o: JSONObject = ["id": .string(PAPER_TARGET)]
        for (k, v) in refJSON(p.source) { o[k] = v }
        o["role"] = "effect paper"
        o["enabled"] = true
        o["opacity"] = .number(p.opacity)
        o["blend"] = .string(p.blend)
        o["values"] = .object(p.source.values)
        if let t = p.source.time, t != 0 { o["time"] = .number(t) }
        return [o]
    }
    func paintInfo() -> [JSONObject] {
        guard let p = c.getEffectPaint() else { return [] }
        var o: JSONObject = ["id": .string(PAINT_TARGET), "effect": .string(p.effect), "provider": .string(p.provider), "role": .string(c.effectPaintRendering ? "effect paint (rendering)" : "effect paint"), "enabled": true, "values": .object(p.values)]
        if p.time != 0 { o["time"] = .number(p.time) }
        if let m = p.map { o["map"] = m.json }
        if p.live { o["live"] = true }
        return [o]
    }
    func layerInfo(_ id: String) -> [JSONObject] {
        guard let s = c.getEffectLayer(id) else { return [] }
        var o: JSONObject = ["id": "effect"]
        for (k, v) in refJSON(s) { o[k] = v }
        o["role"] = "effect layer"
        o["enabled"] = true
        o["values"] = .object(s.values)
        if let t = s.time, t != 0 { o["time"] = .number(t) }
        return [o]
    }
    func requireLayer(_ id: String) throws -> PaintLayer {
        guard let l = c.getLayer(id) else {
            let ids = c.listLayers().map { "\"\($0.id)\"" }
            throw ToolError("There is no layer \"\(id)\"; the targets are \"\(PAPER_TARGET)\" and the layers \(ids.isEmpty ? "(none)" : ids.joined(separator: ", ")) (list_layers lists them).")
        }
        return l
    }
    func effectsOf(_ target: String) -> [JSONObject] { target == PAPER_TARGET ? paperInfo() : target == PAINT_TARGET ? paintInfo() : layerInfo(target) }
    func instanceCheck(_ target: String, _ instance: String) throws {
        let want = target == PAPER_TARGET || target == PAINT_TARGET ? target : "effect"
        if target != PAPER_TARGET && target != PAINT_TARGET { _ = try requireLayer(target) }
        if instance != want || effectsOf(target).isEmpty {
            let have = effectsOf(target).compactMap { $0["id"]?.stringValue }.map { "\"\($0)\"" }
            let who = target == PAPER_TARGET ? "The paper" : target == PAINT_TARGET ? "The paint" : "Layer \"\(target)\""
            throw ToolError("\(who) has no provider effect \"\(instance)\"; its effects are \(have.isEmpty ? "none" : have.joined(separator: ", ")) (list_applied_effects). Light baked into paint is part of the pixels: undo takes it back.")
        }
    }
    func noStackArgs(_ a: JSONObject) throws {
        if a["index"] != nil { throw ToolError("index does not apply: the paper and each effect layer have one effect.") }
        if a["enabled"] != nil { throw ToolError("enabled does not apply here: hide an effect layer with update_layer visible false, or remove the effect paper.") }
    }
    func change(_ target: String, _ effects: [JSONObject], extra: JSONObject = [:]) -> JSONValue {
        var o: JSONObject = ["target": .string(target), "effect": effects.first.map { .object($0) } ?? .null, "effects": .array(effects.map { .object($0) })]
        for (k, v) in extra { o[k] = v }
        return .object(o)
    }
    func list(_ target: String?) throws -> [JSONObject] {
        func entry(_ t: String, _ name: String, _ e: [JSONObject]) -> JSONObject { ["target": .string(t), "name": .string(name), "effects": .array(e.map { .object($0) })] }
        if target == PAPER_TARGET { return [entry(PAPER_TARGET, "Paper", paperInfo())] }
        if target == PAINT_TARGET { return [entry(PAINT_TARGET, "Paint", paintInfo())] }
        if let target { return [entry(target, try requireLayer(target).name, layerInfo(target))] }
        var out: [JSONObject] = []
        if !paintInfo().isEmpty { out.append(entry(PAINT_TARGET, "Paint", paintInfo())) }
        if !paperInfo().isEmpty { out.append(entry(PAPER_TARGET, "Paper", paperInfo())) }
        for e in c.listEffectLayers() { out.append(entry(e.layerId, e.name, layerInfo(e.layerId))) }
        return out
    }

    let host = EffectToolHost(
        applyUses: APPLY_USES,
        // The registered provider with the painting's authored effects (`effectsCatalog`).
        provider: { c.effectsCatalog },
        list: list,
        apply: { target, effect, a in
            if target == PAPER_TARGET { throw ToolError("The paper takes generator effects through set_paper_effect; apply_effect runs a filter on a layer's paint.") }
            if target == PAINT_TARGET { throw ToolError("Brushes paint with an effect through set_effect_paint; apply_effect runs a filter on a layer's paint.") }
            try noStackArgs(a)
            _ = try requireLayer(target)
            let r = try await c.applyLightEffect(target, effect, values: a["values"]?.objectValue, amount: a["opacity"]?.numberValue)
            var applied: JSONObject = ["id": "light"]
            for (k, v) in refJSON(r.source) { applied[k] = v }
            applied["role"] = "baked light"
            applied["enabled"] = true
            applied["opacity"] = .number(r.amount)
            applied["values"] = .object(r.source.values)
            return ["target": .string(target), "effect": .object(applied), "effects": .array(layerInfo(target).map { .object($0) }), "baked": true]
        },
        update: { target, instance, a in
            try instanceCheck(target, instance)
            try noStackArgs(a)
            let values = a["values"]?.objectValue
            if target == PAINT_TARGET {
                if a["opacity"] != nil { throw ToolError("opacity does not apply to the effect paint: change the brush opacity (set_brush tip.opacity).") }
                let p = c.getEffectPaint()!
                var merged = p.values
                for (k, v) in values ?? [:] { merged[k] = v }
                _ = try await c.setEffectPaint(p.effect, values: merged, time: p.time, map: p.map?.json, live: p.live)
                return change(target, paintInfo())
            }
            if target == PAPER_TARGET {
                _ = try await c.updatePaperEffect(values: values, opacity: a["opacity"]?.numberValue)
                return change(target, paperInfo())
            }
            if a["opacity"] != nil { throw ToolError("An effect layer's opacity is the layer's: change it with update_layer.") }
            _ = try await c.updateEffectLayer(target, values: values)
            return change(target, layerInfo(target))
        },
        remove: { target, instance in
            try instanceCheck(target, instance)
            let was = effectsOf(target)[0]
            if target == PAINT_TARGET {
                _ = try c.setColor(c.color)
                return ["target": .string(target), "effect": .object(was), "effects": []]
            }
            if target == PAPER_TARGET { _ = try await c.setPaperEffect(nil) } else { _ = try c.rasterizeEffectLayer(target) }
            var o: JSONObject = ["target": .string(target), "effect": .object(was), "effects": []]
            if target != PAPER_TARGET { o["keptPixels"] = true }
            return .object(o)
        }
    )
    var h: [String: PaintToolHandler] = effectToolHandlers(host)
    h["set_paper_effect"] = { a in
        let effect = a["effect"]?.stringValue
        if effect != nil { _ = try requireProvider() }
        let p = try await c.setPaperEffect(effect, values: a["values"]?.objectValue, opacity: a["opacity"]?.numberValue, blend: a["blend"]?.stringValue, time: a["time"]?.numberValue)
        return ["paperEffect": p.map { .object($0.json) } ?? .null]
    }
    h["set_effect_paint"] = { a in
        _ = try requireProvider()
        let p = try await c.setEffectPaint(a["effect"]?.stringValue ?? "", values: a["values"]?.objectValue, time: a["time"]?.numberValue, map: a["map"], live: a["live"]?.boolValue)
        return ["effectPaint": p.json]
    }
    h["set_effect_playback"] = { a in
        var o = try c.setEffectPlayback(playing: a["playing"]?.boolValue, fps: a["fps"]?.numberValue)
        o["animation"] = c.getAnimation()
        return .object(o)
    }
    h["add_effect_layer"] = { a in
        _ = try requireProvider()
        let r = try await c.addEffectLayer(a["effect"]?.stringValue ?? "", values: a["values"]?.objectValue, name: a["name"]?.stringValue, aboveId: a["aboveId"]?.stringValue, opacity: a["opacity"]?.numberValue, blend: a["blend"]?.stringValue, time: a["time"]?.numberValue)
        return ["layer": r.layer.json, "effects": .array(layerInfo(r.layer.id).map { .object($0) })]
    }
    h["fill_layer_with_effect"] = { a in
        _ = try requireProvider()
        let r = try await c.fillLayerWithEffect(a["effect"]?.stringValue ?? "", layerId: a["layerId"]?.stringValue, values: a["values"]?.objectValue, opacity: a["opacity"]?.numberValue, lockTransparency: a["lockTransparency"]?.boolValue, time: a["time"]?.numberValue)
        return ["layerId": .string(r.layerId), "source": .object(r.source.json)]
    }
    return try contractProvider("paint-effects", h)
}
