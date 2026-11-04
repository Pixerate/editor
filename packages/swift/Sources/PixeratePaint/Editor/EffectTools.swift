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

private let NO_PROVIDER = "No effects provider is registered with this editor, so there are no effects to search, describe or apply. The host app must register one (setEffectsProvider); effects already in the document are kept and shown as placeholders."
private let PAPER_TARGET = "paper"
private let PAINT_TARGET = "paint"
/// Most tags `search_effects` lists from its matches.
private let TAG_LIMIT = 40
/// What `apply_effect` takes in the paint editor.
private let APPLY_USES = ["filter"]

private struct ToolError: Error, LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// A catalog entry as the tools return it (`summaryOut`).
private func summaryOut(_ e: EffectDescription) -> JSONObject {
    let j = e.json
    var o: JSONObject = ["id": .string(e.id), "name": .string(e.name), "kind": .string(e.kind), "category": .string(e.category), "uses": .array(e.uses.map { .string($0) })]
    if let d = j["description"]?.stringValue, !d.isEmpty { o["description"] = .string(d) }
    if !e.tags.isEmpty { o["tags"] = .array(e.tags.map { .string($0) }) }
    o["transparent"] = j["transparent"] ?? false
    o["loop"] = j["loop"] ?? false
    if let d = j["duration"] { o["duration"] = d }
    if let c = j["camera"] { o["camera"] = c }
    if let a = j["accepts"]?.arrayValue, !a.isEmpty { o["accepts"] = .array(a) }
    return o
}

/// Catalog tags close to an unknown one (`nearestTags`).
private func nearestTags(_ tag: String, _ known: [(tag: String, count: Int)]) -> [String] {
    let t = normaliseEffectTag(tag)
    let stem = String(t.prefix(4))
    return known.filter { $0.tag.contains(t) || t.contains($0.tag) || (stem.count == 4 && $0.tag.hasPrefix(stem)) }.prefix(5).map(\.tag)
}

private func tagsJSON(_ tags: [(tag: String, count: Int)]) -> JSONValue { .array(tags.map { ["tag": .string($0.tag), "count": .number(Double($0.count))] }) }

private func refJSON(_ s: PaintEffectSource) -> JSONObject {
    var o: JSONObject = ["effect": .string(s.effect)]
    if let n = s.name, !n.isEmpty { o["name"] = .string(n) }
    if let p = s.provider, !p.isEmpty { o["provider"] = .string(p) }
    return o
}

/// The effect tools of a paint editor (`createPaintEffectsToolProvider`).
public func createPaintEffectsToolProvider(_ c: PaintEditorController) throws -> AgentToolProvider {
    func requireProvider() throws -> EffectProvider {
        guard let p = c.effectsProvider else { throw ToolError(NO_PROVIDER) }
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

    var h: [String: PaintToolHandler] = [:]
    h["search_effects"] = { a in
        guard let p = c.effectsProvider else { return ["available": false, "reason": .string(NO_PROVIDER), "effects": [], "total": 0] }
        let tags = a["tags"]?.arrayValue?.compactMap(\.stringValue)
        let accepts = a["accepts"]?.arrayValue?.compactMap(\.stringValue)
        var found = try await p.search(a["query"]?.stringValue ?? "", EffectSearchOptions(kind: a["kind"]?.stringValue, category: a["category"]?.stringValue, use: a["use"]?.stringValue, tags: tags, accepts: accepts?.isEmpty == false ? accepts : nil)).filter { hasEffectTags($0, tags) }
        if accepts?.contains("path") == true {
            var kept: [EffectDescription] = []
            for e in found {
                if let acc = e.json["accepts"]?.arrayValue?.compactMap(\.stringValue) {
                    if accepts!.allSatisfy(acc.contains) { kept.append(e) }
                } else if kept.count < 200, !pathControlsOf(try await p.describe(e.id)).isEmpty { kept.append(e) }
            }
            found = kept
        }
        let limit = Int(a["limit"]?.numberValue ?? 20)
        var out: JSONObject = [
            "available": true, "provider": ["id": .string(p.id), "name": .string(p.name), "capabilities": .object(p.capabilities)],
            "effects": .array(found.prefix(limit).map { .object(summaryOut($0)) }), "total": .number(Double(found.count)), "tags": tagsJSON(Array(countEffectTags(found).prefix(TAG_LIMIT))),
        ]
        if let tags, !tags.isEmpty, found.isEmpty {
            let known = countEffectTags(try await p.list())
            let have = Set(known.map(\.tag))
            let unknown = tags.filter { !have.contains(normaliseEffectTag($0)) }
            if !unknown.isEmpty { out["unknownTags"] = .array(unknown.map { ["tag": .string($0), "nearest": .array(nearestTags($0, known).map { .string($0) })] }) }
        }
        return .object(out)
    }
    h["describe_effect"] = { a in
        guard let p = c.effectsProvider else { return ["available": false, "reason": .string(NO_PROVIDER)] }
        let d = try await p.describe(a["effect"]?.stringValue ?? "")
        var o: JSONObject = ["available": true]
        for (k, v) in summaryOut(d) { o[k] = v }
        o["controls"] = d.json["controls"] ?? Optional<JSONValue>.none
        o["defaults"] = d.json["defaults"] ?? Optional<JSONValue>.none
        o["presets"] = d.json["presets"] ?? Optional<JSONValue>.none
        o["inputs"] = d.json["inputs"] ?? Optional<JSONValue>.none
        o["appliesHere"] = .bool(effectOffered(d, APPLY_USES))
        let paths = pathControlsOf(d)
        if !paths.isEmpty { o["pathControls"] = .array(paths.map { .string($0) }) }
        return .object(o)
    }
    h["list_applied_effects"] = { a in
        let p = c.effectsProvider
        let known = Set(try await p?.list().map(\.id) ?? [])
        func unavailable(_ e: JSONObject) -> String? {
            guard let p else { return nil }
            if let ep = e["provider"]?.stringValue, ep != p.id { return "It comes from the \"\(ep)\" provider, but \"\(p.id)\" (\(p.name)) is registered: register \"\(ep)\" again, or remove it and apply one from search_effects." }
            let id = e["effect"]?.stringValue ?? ""
            return known.contains(id) ? nil : "\(p.name) has no effect \"\(id)\": remove it and apply one from search_effects."
        }
        let targets: [JSONValue] = try list(a["target"]?.stringValue).map { t in
            var t = t
            t["effects"] = .array((t["effects"]?.arrayValue ?? []).map { ev in
                var e = ev.objectValue ?? [:]
                let why = unavailable(e)
                e["available"] = .bool(p != nil && why == nil)
                if let why { e["reason"] = .string(why) }
                return .object(e)
            })
            return .object(t)
        }
        var o: JSONObject = ["provider": p.map { ["id": .string($0.id), "name": .string($0.name)] } ?? .null]
        if p == nil { o["reason"] = .string(NO_PROVIDER) }
        o["targets"] = .array(targets)
        return .object(o)
    }
    h["apply_effect"] = { a in
        _ = try requireProvider()
        let target = a["target"]?.stringValue ?? ""
        let effect = a["effect"]?.stringValue ?? ""
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
    }
    h["update_effect"] = { a in
        _ = try requireProvider()
        if a["values"] == nil && a["enabled"] == nil && a["opacity"] == nil && a["index"] == nil { throw ToolError("Give at least one of values, enabled, opacity, index to change.") }
        let target = a["target"]?.stringValue ?? ""
        try instanceCheck(target, a["effect"]?.stringValue ?? "")
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
    }
    h["remove_effect"] = { a in
        _ = try requireProvider()
        let target = a["target"]?.stringValue ?? ""
        try instanceCheck(target, a["effect"]?.stringValue ?? "")
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
