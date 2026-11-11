import Foundation
import PixerateCore

/**
 The effect authoring agent tools (`effects/authoring-tools.ts`, `createEffectAuthoringToolProvider`):
 handlers for every `effect_authoring_*` tool except `effect_authoring_view` (Swift hosts have no
 preview capture yet). Results and error messages are the TS core's; a thrown `EffectToolError`
 becomes an `isError` result. Tool definitions come from the editor's contracts.
 */

/// What the tools say when no session is open (unless the host says otherwise).
public let NO_EFFECT_AUTHORING_SESSION = "No effect authoring session is currently open. Open an effect using EffectProvider.openAuthoring() or in an authoring editor before calling effect authoring tools."

/// What an editor gives the authoring tools (`EffectAuthoringToolHost`).
public struct EffectAuthoringToolHost {
    /// The open session, or nil (the tools then refuse with `noSession`).
    public var session: () -> EffectAuthoringSession?
    /// What the tools say when no session is open (how this host opens one); default `NO_EFFECT_AUTHORING_SESSION`.
    public var noSession: String?
    /// List `effect_authoring_set_source` even while no session (or one without source) is open; it then refuses with the reason.
    public var alwaysListSetSource: Bool

    public init(session: @escaping () -> EffectAuthoringSession?, noSession: String? = nil, alwaysListSetSource: Bool = false) {
        self.session = session
        self.noSession = noSession
        self.alwaysListSetSource = alwaysListSetSource
    }
}

/// The authoring tools listed now, in the TS order (`set_source` only with a session that edits source, or `alwaysListSetSource`; no `view`).
public func effectAuthoringToolNames(_ host: EffectAuthoringToolHost) -> [String] {
    var names = ["effect_authoring_describe", "effect_authoring_get_source"]
    if host.session()?.canEditSource == true || host.alwaysListSetSource { names.append("effect_authoring_set_source") }
    names += [
        "effect_authoring_set_values", "effect_authoring_reset_values", "effect_authoring_apply_preset", "effect_authoring_save_preset", "effect_authoring_set_keyframe",
        "effect_authoring_remove_keyframe", "effect_authoring_clear_track", "effect_authoring_set_timing", "effect_authoring_set_paint_hint", "effect_authoring_seek", "effect_authoring_undo", "effect_authoring_redo",
    ]
    return names
}

/// A value as JavaScript's `String(value)` prints it (for easing refusals).
private func jsString(_ v: JSONValue) -> String {
    switch v {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .number(let n): return n.isNaN ? "NaN" : n.isInfinite ? (n > 0 ? "Infinity" : "-Infinity") : JSONValue.jsNumber(n)
    case .string(let s): return s
    case .array(let a): return a.map { $0 == .null ? "" : jsString($0) }.joined(separator: ",")
    case .object: return "[object Object]"
    }
}

/// The authoring tools' handlers by name.
public func effectAuthoringToolHandlers(host: EffectAuthoringToolHost) -> [String: EffectToolHandler] {
    func requireSession() throws -> EffectAuthoringSession {
        guard let s = host.session() else { throw EffectToolError(host.noSession ?? NO_EFFECT_AUTHORING_SESSION) }
        return s
    }
    func check(_ r: EffectAuthoringResult) throws {
        if let m = r.message { throw EffectToolError(m) }
    }
    func valuesOut(_ s: EffectAuthoringSession) -> JSONValue { ["values": .object(s.getState().values)] }
    func trackOut(_ s: EffectAuthoringSession, _ control: String) -> JSONValue {
        ["control": .string(control), "keyframes": .array((s.getState().tracks[control] ?? []).map(\.json))]
    }

    var h: [String: EffectToolHandler] = [:]
    h["effect_authoring_describe"] = { _ in
        let state = try requireSession().getState()
        let d = state.description
        let presets = (d.json["presets"]?.arrayValue ?? []).map { $0["name"] ?? .null }
        let o: JSONObject = [
            "name": .string(d.name), "kind": .string(d.kind), "sourceLanguage": state.sourceLanguage.map { .string($0) } ?? .null,
            "controls": .array(effectParameterFields(d).map { .object($0) }), "values": .object(state.values), "presets": .array(presets),
            "tracks": .array(state.tracks.map { ["control": .string($0.control), "keyframes": .number(Double($0.keyframes.count))] }),
            "time": .number(state.time), "duration": .number(state.duration), "loop": .bool(state.loop), "paint": d.json["paint"] ?? .null, "issues": .array(state.issues.map(\.json)),
            "previewError": state.previewError.map { .string($0) } ?? .null,
        ]
        return .object(o)
    }
    h["effect_authoring_get_source"] = { _ in
        let state = try requireSession().getState()
        guard let language = state.sourceLanguage, let source = state.source else {
            throw EffectToolError("The currently open effect (\(state.description.name)) does not use shader or script source code.")
        }
        return ["language": .string(language), "source": .string(source)]
    }
    h["effect_authoring_set_source"] = { a in
        let session = try requireSession()
        if !session.canEditSource {
            throw EffectToolError("The open effect (\(session.getState().name)) has no source to edit: it is a catalog effect of its provider. Open an effect written in pixel expressions to edit source.")
        }
        switch await session.setSource(a["source"]?.stringValue ?? "") {
        case .refused(let m): throw EffectToolError(m)
        case .ok(let issues): return ["issues": .array(issues.map(\.json))]
        }
    }
    h["effect_authoring_set_values"] = { a in
        let session = try requireSession()
        try check(session.setValues(a["values"]?.objectValue ?? [:], gesture: nil))
        return valuesOut(session)
    }
    h["effect_authoring_reset_values"] = { a in
        let session = try requireSession()
        try check(session.resetValues(a["names"]?.arrayValue?.compactMap(\.stringValue)))
        return valuesOut(session)
    }
    h["effect_authoring_apply_preset"] = { a in
        let session = try requireSession()
        try check(session.applyPreset(a["name"]?.stringValue ?? ""))
        return valuesOut(session)
    }
    h["effect_authoring_save_preset"] = { a in
        let session = try requireSession()
        try check(session.savePreset(a["name"]?.stringValue ?? ""))
        return ["name": a["name"] ?? .null, "values": .object(session.getState().values)]
    }
    h["effect_authoring_set_keyframe"] = { a in
        let session = try requireSession()
        let control = a["control"]?.stringValue ?? ""
        // An unusable easing reaches the session as its text, which it refuses (`invalid easing: …`), after the control and time checks.
        let easing = a["easing"].map { e in AnimationEasing(json: e) ?? .named(jsString(e)) }
        try check(session.setKeyframe(control, time: a["time"]?.numberValue ?? .nan, value: a["value"], easing: easing))
        return trackOut(session, control)
    }
    h["effect_authoring_remove_keyframe"] = { a in
        let session = try requireSession()
        let control = a["control"]?.stringValue ?? ""
        try check(session.removeKeyframe(control, time: a["time"]?.numberValue ?? .nan))
        return trackOut(session, control)
    }
    h["effect_authoring_clear_track"] = { a in
        let session = try requireSession()
        let control = a["control"]?.stringValue ?? ""
        try check(session.clearTrack(control))
        var o: JSONObject = ["control": .string(control)]
        o["value"] = session.getState().values[control]
        return .object(o)
    }
    h["effect_authoring_set_timing"] = { a in
        let session = try requireSession()
        let duration = a["duration"]?.numberValue, loop = a["loop"]?.boolValue
        if a["duration"] == nil && a["loop"] == nil { throw EffectToolError("Provide at least one of duration or loop to change.") }
        try check(session.setTiming(duration: duration, loop: loop))
        let state = session.getState()
        return ["duration": .number(state.duration), "loop": .bool(state.loop)]
    }
    h["effect_authoring_set_paint_hint"] = { a in
        let session = try requireSession()
        try check(session.setPaintHint(a["paint"] ?? .null))
        return ["paint": session.getState().description.json["paint"] ?? .null]
    }
    h["effect_authoring_seek"] = { a in
        let session = try requireSession()
        guard let time = a["time"]?.numberValue, time.isFinite, time >= 0 else { throw EffectToolError("time must be a finite non-negative number.") }
        session.seek(time)
        let state = session.getState()
        return ["time": .number(state.time), "values": .object(state.values)]
    }
    h["effect_authoring_undo"] = { _ in
        let session = try requireSession()
        let changed = session.undo()
        let state = session.getState()
        return ["changed": .bool(changed), "canUndo": .bool(state.canUndo), "canRedo": .bool(state.canRedo)]
    }
    h["effect_authoring_redo"] = { _ in
        let session = try requireSession()
        let changed = session.redo()
        let state = session.getState()
        return ["changed": .bool(changed), "canUndo": .bool(state.canUndo), "canRedo": .bool(state.canRedo)]
    }
    return h
}
