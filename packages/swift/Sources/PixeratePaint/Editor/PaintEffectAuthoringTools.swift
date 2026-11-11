import Foundation
import PixerateCore

/**
 * Agent tools for writing effects at run time in the paint editor and keeping them in the
 * painting (`paint-editor/effect-authoring-tools.ts`): `open_effect_authoring` (a pixel expression
 * template, an authored effect or a provider effect), the shared `effect_authoring_*` tools on the
 * open session (source, values, keyframes, presets, timing, undo), `save_authored_effect` (a trial
 * render, then an `authored.<name>` id usable anywhere an effect id is), `list_authored_effects`,
 * `remove_authored_effect` and `close_effect_authoring`. Definitions come from the contracts
 * (provider `paint-effect-authoring`); results and messages are the TS core's.
 */

/// What the authoring tools say when no session is open in a paint editor.
public let PAINT_NO_AUTHORING_SESSION = "No effect is open for authoring; open one with open_effect_authoring (start from pixel.blank to write a new effect), then use the effect_authoring_* tools."

/// The effect authoring tools of a paint editor (`createPaintEffectAuthoringToolProvider`). `readOnly` returns a reason while the painting can't be edited (saving and removing are then refused).
public func createPaintEffectAuthoringToolProvider(_ c: PaintEditorController, readOnly: (() -> String?)? = nil) throws -> AgentToolProvider {
    func writable() throws {
        if let r = readOnly?() { throw EffectToolError("\(r) Authored effects can't be saved or removed.") }
    }
    func opened() -> JSONValue {
        guard let s = c.authoringSession else { return .null }
        let st = s.getState()
        var o: JSONObject = ["from": c.authoringFrom.map { .string($0) } ?? .null, "name": .string(st.name), "sourceLanguage": st.sourceLanguage.map { .string($0) } ?? .null]
        if let source = st.source { o["source"] = .string(source) }
        o["controls"] = .array(effectParameterFields(st.description).map { .object($0) })
        o["values"] = .object(st.values)
        o["issues"] = .array(st.issues.map(\.json))
        o["compiled"] = st.compiled.map { .bool($0) } ?? .null
        o["duration"] = .number(st.duration)
        o["loop"] = .bool(st.loop)
        return .object(o)
    }

    var h: [String: PaintToolHandler] = effectAuthoringToolHandlers(host: EffectAuthoringToolHost(session: { c.authoringSession }, noSession: PAINT_NO_AUTHORING_SESSION, alwaysListSetSource: true))
    h["open_effect_authoring"] = { a in
        _ = try await c.openEffectAuthoring(a["effect"]?.stringValue ?? "")
        return opened()
    }
    h["save_authored_effect"] = { a in
        try writable()
        let saved = try await c.saveAuthoredEffect(name: a["name"]?.stringValue)
        let id = saved.effect.id
        guard let d = await c.listAuthoredEffects().first(where: { $0.id == id }) else { throw EffectToolError("The authored effect \"\(id)\" was saved but is not listed; call list_authored_effects.") }
        var o: JSONObject = ["id": .string(id), "name": .string(saved.effect.name), "controls": .array(d.controls.map { .string($0) }), "animated": .array(d.animated.map { .string($0) })]
        if let duration = d.duration { o["duration"] = duration }
        if let loop = d.loop { o["loop"] = loop }
        return .object(o)
    }
    h["list_authored_effects"] = { _ in
        let open: JSONValue = c.authoringSession.map { ["from": c.authoringFrom.map { .string($0) } ?? .null, "name": .string($0.getState().name)] } ?? .null
        return ["policy": .string(c.authoredPolicy.rawValue), "open": open, "effects": .array(await c.listAuthoredEffects().map { .object($0.json) })]
    }
    h["remove_authored_effect"] = { a in
        try writable()
        let r = try c.removeAuthoredEffect(a["id"]?.stringValue ?? "")
        return ["removed": .string(r.removed), "name": .string(r.name)]
    }
    h["close_effect_authoring"] = { _ in
        ["closed": c.closeEffectAuthoring().map { .string($0) } ?? .null]
    }
    return try contractProvider("paint-effect-authoring", h)
}
