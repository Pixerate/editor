import Foundation
import PixerateCore

/**
 The effects authoring contract (`effects/authoring.ts`): editing an effect's control values,
 keyframes, presets, timing and (for a source backend) its source, with undo, playback and a
 preview renderer. `GenericEffectAuthoringSession` (`effects/authoring-session.ts`,
 `createEffectAuthoringSession`) implements it over any `EffectProvider`.

 Values, tracks, documents and states write the same JSON as the TS core (`json`), and the
 session refuses with the same messages, so agent tool results match it.
 */

// MARK: - Contract

/// What to open (`EffectAuthoringSource`): a catalog effect (optionally with a preset applied), or a document saved earlier by `exportDocument` (as JSON).
public enum EffectAuthoringSource: Sendable {
    case effect(String, preset: String? = nil)
    case document(JSONValue)
}

/// One keyframe of an animated control (`EffectKeyframe`).
public struct EffectKeyframe: Equatable, Sendable {
    /// Ms from the start of the effect.
    public var time: Double
    /// The value at this keyframe.
    public var value: JSONValue
    /// Easing into the next keyframe (default `linear`).
    public var easing: AnimationEasing?
    public init(time: Double, value: JSONValue, easing: AnimationEasing? = nil) {
        self.time = time
        self.value = value
        self.easing = easing
    }

    /// A keyframe from JSON (`{ time, value, easing? }`), nil when `time` is not a number. A missing value is `null`; an unusable easing is dropped.
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let time = o["time"]?.numberValue else { return nil }
        self.time = time
        value = o["value"] ?? .null
        easing = o["easing"].flatMap { AnimationEasing(json: $0) }
    }

    /// `{ time, value, easing? }`.
    public var json: JSONValue {
        var o: JSONObject = ["time": .number(time), "value": value]
        if let easing { o["easing"] = easing.json }
        return .object(o)
    }
}

/// Keyframes per control, in JavaScript object order (integer-like names first, then as added), as the TS core's `tracks` record.
public struct EffectTracks: Equatable, Sendable, Sequence {
    private var order: [String] = []
    private var storage: [String: [EffectKeyframe]] = [:]

    public init() {}

    /// The controls with a track, in JavaScript's key order.
    public var keys: [String] {
        func isIndex(_ k: String) -> Bool {
            guard !k.isEmpty, k.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), !(k.count > 1 && k.hasPrefix("0")), let n = UInt64(k) else { return false }
            return n < 4_294_967_295
        }
        return order.filter(isIndex).sorted { UInt64($0)! < UInt64($1)! } + order.filter { !isIndex($0) }
    }

    public var count: Int { order.count }
    public var isEmpty: Bool { order.isEmpty }

    /// A control's keyframes; setting nil removes the track.
    public subscript(control: String) -> [EffectKeyframe]? {
        get { storage[control] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: control) == nil { order.append(control) }
            } else if storage.removeValue(forKey: control) != nil {
                order.removeAll { $0 == control }
            }
        }
    }

    public func makeIterator() -> IndexingIterator<[(control: String, keyframes: [EffectKeyframe])]> {
        keys.map { (control: $0, keyframes: storage[$0]!) }.makeIterator()
    }

    public static func == (a: EffectTracks, b: EffectTracks) -> Bool { a.keys == b.keys && a.keys.allSatisfy { a.storage[$0] == b.storage[$0] } }

    /// `{ control: [keyframe, …] }`.
    public var json: JSONObject {
        var o = JSONObject()
        for (c, kfs) in self { o[c] = .array(kfs.map(\.json)) }
        return o
    }
}

/// A document saved by `exportDocument`, reopened with `.document(doc.json)` (`EffectAuthoringDocument`).
public struct EffectAuthoringDocument: Equatable, Sendable {
    public var version: Int = 1
    public var providerId: String
    public var effectId: String
    public var name: String
    public var values: JSONObject
    public var tracks: EffectTracks
    /// Saved presets, `{ name, values }` each.
    public var presets: [JSONObject]
    public var duration: Double
    public var loop: Bool
    /// The effect's own source, for sessions that edit it (e.g. pixel expressions).
    public var source: String?
    /// The language of `source` (`glsl`, `svg` or `pixel`).
    public var sourceLanguage: String?

    public init(providerId: String, effectId: String, name: String, values: JSONObject = [:], tracks: EffectTracks = EffectTracks(), presets: [JSONObject] = [], duration: Double = 1000, loop: Bool = false, source: String? = nil, sourceLanguage: String? = nil) {
        self.providerId = providerId
        self.effectId = effectId
        self.name = name
        self.values = values
        self.tracks = tracks
        self.presets = presets
        self.duration = duration
        self.loop = loop
        self.source = source
        self.sourceLanguage = sourceLanguage
    }

    /// The document as the TS core exports it: `source` and `sourceLanguage` first when there is a source.
    public var json: JSONObject {
        var o = JSONObject()
        if let source { o["source"] = .string(source) }
        if let sourceLanguage { o["sourceLanguage"] = .string(sourceLanguage) }
        o["version"] = .number(Double(version))
        o["providerId"] = .string(providerId)
        o["effectId"] = .string(effectId)
        o["name"] = .string(name)
        o["values"] = .object(values)
        o["tracks"] = .object(tracks.json)
        o["presets"] = .array(presets.map { .object($0) })
        o["duration"] = .number(duration)
        o["loop"] = .bool(loop)
        return o
    }
}

/// The observable state of a session (`EffectAuthoringState`). A session returns the same instance until something changes (compare with `===`).
public final class EffectAuthoringState {
    /// Stable id of the provider that owns this effect.
    public let providerId: String
    /// The id the effect was opened from.
    public let effectId: String?
    /// Display name of the effect.
    public let name: String
    /// How the effect is drawn (`shader`, `vector`, …).
    public let kind: String
    /// The current controls, defaults and presets (saved presets first). They change when the source changes.
    public let description: EffectDescription
    /// Editable source, or nil (see `sourceLanguage`).
    public let source: String?
    /// Language of `source`, or nil when source editing is not supported.
    public let sourceLanguage: String?
    /// Every control's value at the playhead (keyframes applied).
    public let values: JSONObject
    /// Keyframes per control. A control with no entry is not animated.
    public let tracks: EffectTracks
    /// Compile errors and warnings.
    public let issues: [EffectAuthoringIssue]
    /// Whether the source compiled: true, false, or nil when not known yet (no preview has compiled it).
    public let compiled: Bool?
    /// Why `createPreview` could not make a pixel preview, or nil.
    public let previewError: String?
    /// Playhead (ms).
    public let time: Double
    /// Length of one play (ms).
    public let duration: Double
    public let loop: Bool
    public let playing: Bool
    public let canUndo: Bool
    public let canRedo: Bool

    public init(providerId: String, effectId: String?, name: String, kind: String, description: EffectDescription, source: String?, sourceLanguage: String?, values: JSONObject, tracks: EffectTracks, issues: [EffectAuthoringIssue], compiled: Bool?, previewError: String?, time: Double, duration: Double, loop: Bool, playing: Bool, canUndo: Bool, canRedo: Bool) {
        self.providerId = providerId
        self.effectId = effectId
        self.name = name
        self.kind = kind
        self.description = description
        self.source = source
        self.sourceLanguage = sourceLanguage
        self.values = values
        self.tracks = tracks
        self.issues = issues
        self.compiled = compiled
        self.previewError = previewError
        self.time = time
        self.duration = duration
        self.loop = loop
        self.playing = playing
        self.canUndo = canUndo
        self.canRedo = canRedo
    }

    /// The state as the TS core's object, field for field.
    public var json: JSONObject {
        [
            "providerId": .string(providerId), "effectId": effectId.map { .string($0) } ?? .null, "name": .string(name), "kind": .string(kind),
            "description": .object(description.json), "source": source.map { .string($0) } ?? .null, "sourceLanguage": sourceLanguage.map { .string($0) } ?? .null,
            "values": .object(values), "tracks": .object(tracks.json), "issues": .array(issues.map(\.json)), "compiled": compiled.map { .bool($0) } ?? .null,
            "previewError": previewError.map { .string($0) } ?? .null, "time": .number(time), "duration": .number(duration), "loop": .bool(loop),
            "playing": .bool(playing), "canUndo": .bool(canUndo), "canRedo": .bool(canRedo),
        ]
    }
}

/// The result of a session edit (`EffectAuthoringResult`): done, or refused with the reason.
public enum EffectAuthoringResult: Equatable, Sendable {
    case ok
    case refused(String)
    public var isOK: Bool { self == .ok }
    /// The reason it was refused, or nil.
    public var message: String? { if case .refused(let m) = self { return m }; return nil }
}

/// The result of `setSource`: the compile issues (an edit that doesn't compile is still applied, with errors), or refused with the reason.
public enum EffectSourceResult: Equatable, Sendable {
    case ok(issues: [EffectAuthoringIssue])
    case refused(String)
    public var isOK: Bool { if case .ok = self { return true }; return false }
    public var message: String? { if case .refused(let m) = self { return m }; return nil }
}

/// A live editing session for an effect (`EffectAuthoringSession`).
public protocol EffectAuthoringSession: AnyObject {
    /// The current state; the same instance until something changes.
    func getState() -> EffectAuthoringState
    /// Called after every change.
    func subscribe(_ listener: @escaping (EffectAuthoringState) -> Void) -> Cancellable
    /// Whether `setSource` is available (the TS session's optional `setSource`).
    var canEditSource: Bool { get }
    /// Replaces the source and recompiles it (one undo step).
    func setSource(_ source: String) async -> EffectSourceResult
    /// Sets a control at the playhead (a keyframe there when the control is animated). Calls with the same `gesture` key merge into one undo step.
    func setValue(_ name: String, _ value: JSONValue, gesture: String?) -> EffectAuthoringResult
    /// Sets several controls as one undo step, all or nothing.
    func setValues(_ values: JSONObject, gesture: String?) -> EffectAuthoringResult
    /// Puts controls back to their defaults (nil: all of them).
    func resetValues(_ names: [String]?) -> EffectAuthoringResult
    func applyPreset(_ name: String) -> EffectAuthoringResult
    /// Saves the current values as a preset (replacing one with the same name).
    func savePreset(_ name: String) -> EffectAuthoringResult
    /// Adds or replaces a keyframe; `value` defaults to the control's value at that time.
    func setKeyframe(_ name: String, time: Double, value: JSONValue?, easing: AnimationEasing?) -> EffectAuthoringResult
    func removeKeyframe(_ name: String, time: Double) -> EffectAuthoringResult
    /// Removes a control's keyframes; its value at the playhead becomes its static value.
    func clearTrack(_ name: String) -> EffectAuthoringResult
    func setTiming(duration: Double?, loop: Bool?) -> EffectAuthoringResult
    func play()
    func pause()
    /// Moves the playhead (clamped to 0...duration).
    func seek(_ time: Double)
    func undo() -> Bool
    func redo() -> Bool
    /// A renderer drawing this session's current effect, with the keyframed values at each request's time unless it gives `values`.
    func createPreview(width: Int, height: Int) async throws -> EffectRenderer
    func exportDocument() -> EffectAuthoringDocument
    /// Stops playback, drops listeners and disposes previews.
    func dispose()
}

extension EffectAuthoringSession {
    public var canEditSource: Bool { false }
    public func setSource(_ source: String) async -> EffectSourceResult { .refused("this effect has no source to edit") }
    public func setValue(_ name: String, _ value: JSONValue) -> EffectAuthoringResult { setValue(name, value, gesture: nil) }
    public func setValues(_ values: JSONObject) -> EffectAuthoringResult { setValues(values, gesture: nil) }
    public func resetValues() -> EffectAuthoringResult { resetValues(nil) }
    public func setKeyframe(_ name: String, time: Double, value: JSONValue? = nil) -> EffectAuthoringResult { setKeyframe(name, time: time, value: value, easing: nil) }
}

/// A provider that opens authoring sessions (`EffectProvider.openAuthoring`).
public protocol AuthoringEffectProvider: EffectProvider {
    func openAuthoring(_ from: EffectAuthoringSource) async throws -> EffectAuthoringSession
}

/// What a source backend's compile gives: the description (nil when it doesn't compile) and the issues.
public struct AuthoringCompileResult: Sendable {
    public var description: EffectDescription?
    public var issues: [EffectAuthoringIssue]
    public init(description: EffectDescription?, issues: [EffectAuthoringIssue]) {
        self.description = description
        self.issues = issues
    }
}

/// What a session needs to edit an effect's source (`AuthoringSourceBackend`, e.g. the pixel expression provider).
public protocol AuthoringSourceBackend {
    /// `glsl`, `svg` or `pixel`.
    var language: String { get }
    /// The source of a catalog effect, to start from when opened by id (throws `unknown_effect` for an unknown id).
    func sourceOf(_ effectId: String) throws -> String
    /// Compiles a source.
    func compile(_ source: String, effectId: String) -> AuthoringCompileResult
    /// Refuses a source before compiling it (e.g. too long): a message, or nil.
    func refuse(_ source: String) -> String?
    /// A renderer for a source that compiles.
    func createRenderer(_ source: String, effectId: String, width: Int, height: Int) async throws -> EffectRenderer
}

extension AuthoringSourceBackend {
    public func refuse(_ source: String) -> String? { nil }
}

// MARK: - Interpolation

/// `#rrggbb` / `#rrggbbaa` channels, or nil.
private func parseHex(_ hex: String) -> (r: Double, g: Double, b: Double, a: Double, hasAlpha: Bool)? {
    guard isHexColour(hex) else { return nil }
    let body = Array(hex.utf8.dropFirst())
    func byte(_ i: Int) -> Double { Double(Int(String(decoding: body[i..<(i + 2)], as: UTF8.self), radix: 16)!) }
    let hasAlpha = body.count == 8
    return (byte(0), byte(2), byte(4), hasAlpha ? byte(6) : 255, hasAlpha)
}

private func toHex2(_ n: Double) -> String {
    let clamped = Int((Swift.max(0, Swift.min(255, n)) + 0.5).rounded(.down))
    let s = String(clamped, radix: 16)
    return s.count < 2 ? "0" + s : s
}

private func lerpHex(_ c1: String, _ c2: String, _ t: Double) -> String {
    guard let p1 = parseHex(c1), let p2 = parseHex(c2) else { return t >= 1 ? c2 : c1 }
    let r = p1.r + (p2.r - p1.r) * t
    let g = p1.g + (p2.g - p1.g) * t
    let b = p1.b + (p2.b - p1.b) * t
    let a = p1.a + (p2.a - p1.a) * t
    return "#" + toHex2(r) + toHex2(g) + toHex2(b) + (p1.hasAlpha || p2.hasAlpha ? toHex2(a) : "")
}

private func interpolateValue(_ v1: JSONValue, _ v2: JSONValue, _ progress: Double) -> JSONValue {
    if let a = v1.numberValue, let b = v2.numberValue { return .number(a + (b - a) * progress) }
    if let a = v1.arrayValue, let b = v2.arrayValue, a.count == b.count {
        return .array(zip(a, b).map { x, y in
            if let n = x.numberValue, let m = y.numberValue { return .number(n + (m - n) * progress) }
            return x
        })
    }
    if let a = v1.stringValue, let b = v2.stringValue, a.hasPrefix("#"), b.hasPrefix("#") { return .string(lerpHex(a, b, progress)) }
    // Booleans, strings and enums hold the earlier keyframe's value.
    return progress >= 1 ? v2 : v1
}

private func valuesAtTime(_ time: Double, _ base: JSONObject, _ tracks: EffectTracks) -> JSONObject {
    var result = base
    for (control, kfs) in tracks {
        if kfs.isEmpty { continue }
        if kfs.count == 1 || time <= kfs[0].time {
            result[control] = kfs[0].value
            continue
        }
        let last = kfs[kfs.count - 1]
        if time >= last.time {
            result[control] = last.value
            continue
        }
        var idx = 0
        while idx < kfs.count - 1 && kfs[idx + 1].time <= time { idx += 1 }
        let kf1 = kfs[idx], kf2 = kfs[idx + 1]
        let span = kf2.time - kf1.time
        let raw = span > 0 ? (time - kf1.time) / span : 0
        let eased = evaluateEasing(kf1.easing ?? .named("linear"), raw)
        result[control] = interpolateValue(kf1.value, kf2.value, eased)
    }
    return result
}

/// A saved document's control values at `time` ms (`authoringValuesAt`): keyframed controls follow their tracks (wrapping at `duration` when it loops), the others keep their value.
public func authoringValuesAt(_ doc: EffectAuthoringDocument, _ time: Double) -> JSONObject {
    authoringValuesAt(values: doc.values, tracks: doc.tracks, duration: doc.duration, loop: doc.loop, time)
}

/// `authoringValuesAt` from the parts of a document.
public func authoringValuesAt(values: JSONObject, tracks: EffectTracks, duration: Double, loop: Bool, _ time: Double) -> JSONObject {
    let t = loop && duration > 0 ? (time.truncatingRemainder(dividingBy: duration) + duration).truncatingRemainder(dividingBy: duration) : time
    return valuesAtTime(t, values, tracks)
}

/// Keyframes sorted by time (stable, as `Array.prototype.sort`).
private func sortedByTime(_ kfs: [EffectKeyframe]) -> [EffectKeyframe] {
    kfs.enumerated().sorted { $0.element.time != $1.element.time ? $0.element.time < $1.element.time : $0.offset < $1.offset }.map(\.element)
}

// MARK: - Validation

/// `effectValueErrors` for any JSON (nil: none).
private func valueErrors(_ d: EffectDescription, _ values: JSONValue?) -> [SchemaValidationError] {
    guard let values else { return [] }
    if let o = values.objectValue { return effectValueErrors(d, o) }
    var schema = d.controls
    schema["required"] = []
    return validateJSONSchema(values, .object(schema))
}

/// Schema errors as one sentence naming each control (`control "color": Must match …`).
private func valueErrorMessage(_ errors: [SchemaValidationError]) -> String {
    errors.map { e in
        var path = e.path
        if path.hasPrefix("/") { path.removeFirst() }
        let parts = path.components(separatedBy: "/")
        let rest = parts.dropFirst()
        return "control \"\(parts[0])\"\(rest.isEmpty ? "" : " (item \(rest.joined(separator: "/")))"): \(e.message)"
    }.joined(separator: "; ")
}

private func isFiniteNumber(_ v: JSONValue?) -> Bool { v?.numberValue?.isFinite == true }

/// Problems with a saved document against the effect it names (empty when it is valid).
private func documentErrors(_ doc: JSONObject, _ description: EffectDescription) -> [SchemaValidationError] {
    var errors: [SchemaValidationError] = []
    let controls = description.controlNames
    func prefixed(_ list: [SchemaValidationError], _ at: String, keepPath: Bool = true) -> [SchemaValidationError] {
        list.map { SchemaValidationError(path: keepPath ? at + $0.path : at, message: $0.message) }
    }
    if let values = doc["values"] {
        if values.objectValue == nil { errors.append(SchemaValidationError(path: "/values", message: "must be an object of control values")) }
        else { errors += prefixed(valueErrors(description, values), "/values") }
    }
    if let tracks = doc["tracks"] {
        if let o = tracks.objectValue {
            for (control, kfs) in o {
                let at = "/tracks/\(control)"
                if !controls.contains(control) {
                    errors.append(SchemaValidationError(path: at, message: "there is no control \"\(control)\"; the controls are \(controls.joined(separator: ", "))"))
                } else if let list = kfs.arrayValue {
                    for (i, kf) in list.enumerated() {
                        guard let k = kf.objectValue else {
                            errors.append(SchemaValidationError(path: "\(at)/\(i)", message: "must be a keyframe object"))
                            continue
                        }
                        if !(isFiniteNumber(k["time"]) && k["time"]!.numberValue! >= 0) { errors.append(SchemaValidationError(path: "\(at)/\(i)/time", message: "must be a finite number of ms >= 0")) }
                        var one = JSONObject()
                        one[control] = k["value"]
                        errors += prefixed(valueErrors(description, .object(one)), "\(at)/\(i)/value", keepPath: false)
                        if let e = k["easing"], !isAnimationEasing(e) { errors.append(SchemaValidationError(path: "\(at)/\(i)/easing", message: "is not a valid easing")) }
                    }
                } else {
                    errors.append(SchemaValidationError(path: at, message: "must be a list of keyframes"))
                }
            }
        } else {
            errors.append(SchemaValidationError(path: "/tracks", message: "must be an object of keyframe lists"))
        }
    }
    if let presets = doc["presets"] {
        if let list = presets.arrayValue {
            for (i, p) in list.enumerated() {
                guard let o = p.objectValue, let name = o["name"]?.stringValue, !name.isEmpty else {
                    errors.append(SchemaValidationError(path: "/presets/\(i)", message: "must have a name"))
                    continue
                }
                errors += prefixed(valueErrors(description, o["values"]), "/presets/\(i)/values")
            }
        } else {
            errors.append(SchemaValidationError(path: "/presets", message: "must be a list of presets"))
        }
    }
    if let d = doc["duration"], !(isFiniteNumber(d) && d.numberValue! > 0) { errors.append(SchemaValidationError(path: "/duration", message: "must be a finite number of ms > 0")) }
    if let l = doc["loop"], l.boolValue == nil { errors.append(SchemaValidationError(path: "/loop", message: "must be a boolean")) }
    return errors
}

/// `EffectControlError`: `invalid_values`, naming every problem.
private func controlError(_ effectId: String, _ details: [SchemaValidationError]) -> EffectError {
    let lines = details.map { "- \($0.path.isEmpty ? "/" : $0.path): \($0.message)" }.joined(separator: "\n")
    return EffectError("invalid_values", "Invalid values for effect \"\(effectId)\":\n\(lines)", effectId: effectId)
}

private func disposedError(_ effectId: String) -> EffectError {
    EffectError("disposed", "The renderer for \"\(effectId)\" was disposed. Create a new renderer.", effectId: effectId)
}

private func authoringErrorMessage(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? "\(error)"
}

// MARK: - Playback clock

/// Calls `frame` with a time in ms until cancelled (`GenericAuthoringOptions.schedule`).
public typealias EffectAuthoringSchedule = (_ frame: @escaping (Double) -> Void) -> () -> Void

private final class UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// The default playback clock: a 60 Hz timer on the main run loop, with the system uptime in ms.
public func defaultEffectAuthoringSchedule(_ frame: @escaping (Double) -> Void) -> () -> Void {
    let box = UncheckedBox(frame)
    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in box.value(ProcessInfo.processInfo.systemUptime * 1000) }
    RunLoop.main.add(timer, forMode: .common)
    let t = UncheckedBox(timer)
    return { t.value.invalidate() }
}

// MARK: - Generic session

/// Options for `GenericEffectAuthoringSession` (`GenericAuthoringOptions`).
public struct GenericAuthoringOptions {
    /// The provider whose `describe` and `createRenderer` the session uses.
    public var provider: EffectProvider
    /// Undo history to record into (default: a new one).
    public var history: HistoryManager?
    /// Playback clock (default `defaultEffectAuthoringSchedule`); tests pass a manual one.
    public var schedule: EffectAuthoringSchedule?
    /// Ms within which `setValue` calls on one control with no gesture merge (default 400).
    public var mergeWindowMs: Double
    /// Where the playhead starts (ms, clamped to 0...duration). Default: half the duration.
    public var startTime: Double?
    /// Source editing: the session gets `setSource`, `source`, `issues` and `compiled`, and its controls follow the source.
    public var source: AuthoringSourceBackend?

    public init(provider: EffectProvider, history: HistoryManager? = nil, schedule: EffectAuthoringSchedule? = nil, mergeWindowMs: Double = 400, startTime: Double? = nil, source: AuthoringSourceBackend? = nil) {
        self.provider = provider
        self.history = history
        self.schedule = schedule
        self.mergeWindowMs = mergeWindowMs
        self.startTime = startTime
        self.source = source
    }
}

/// Opens a generic authoring session (`createEffectAuthoringSession`).
public func createEffectAuthoringSession(_ from: EffectAuthoringSource, options: GenericAuthoringOptions) async throws -> EffectAuthoringSession {
    try await GenericEffectAuthoringSession(from, options: options)
}

/**
 An authoring session over any provider (`createEffectAuthoringSession`): values, presets,
 keyframes, timing, undo, playback and previews, plus source editing with a source backend.
 Use it from one thread (the main actor in an app).
 */
public final class GenericEffectAuthoringSession: EffectAuthoringSession {
    private let provider: EffectProvider
    private let history: HistoryManager
    private let scheduleFn: EffectAuthoringSchedule
    private let mergeWindowMs: Double
    private let backend: AuthoringSourceBackend?
    public let effectId: String
    private let docName: String?

    private var sourceText: String?
    private var compiledSource: String?
    private var sourceIssues: [EffectAuthoringIssue] = []
    private var description: EffectDescription
    private var disposed = false
    private var playing = false
    private var cancelSchedule: (() -> Void)?
    private var lastScheduleTime: Double?
    private var duration: Double
    private var playheadTime: Double
    private var previewError: String?
    private var loop: Bool
    private var compiled: Bool?
    private var savedPresets: [JSONObject]
    private var baseValues: JSONObject
    private var tracks: EffectTracks
    private var livePreviews: [ObjectIdentifier: EffectRenderer] = [:]
    private var listeners: [(id: Int, fn: (EffectAuthoringState) -> Void)] = []
    private var nextListener = 0
    private var cachedState: EffectAuthoringState?

    public init(_ from: EffectAuthoringSource, options: GenericAuthoringOptions) async throws {
        let provider = options.provider
        let backend = options.source
        var requestedPreset: String?
        var initialDoc: JSONObject?
        let effectId: String
        switch from {
        case .document(let value):
            guard let doc = value.objectValue else { throw EffectError.unsupported("Invalid effect authoring source") }
            guard doc["version"] == .number(1), let id = doc["effectId"]?.stringValue, !id.isEmpty else {
                throw EffectError.unsupported("Invalid effect authoring document: version 1 required")
            }
            effectId = id
            initialDoc = doc
        case .effect(let id, let preset):
            effectId = id
            requestedPreset = preset
        }

        let description: EffectDescription
        if let backend {
            let docSource = initialDoc?["source"]?.stringValue
            let text = try docSource ?? backend.sourceOf(effectId)
            if let refused = backend.refuse(text) { throw EffectError.unsupported("The effect's source can't be opened: \(refused)", effectId) }
            let first = backend.compile(text, effectId: effectId)
            guard let d = first.description else {
                let errs = first.issues.filter { $0.severity == "error" }.map { i in i.line.map { "line \($0): \(i.message)" } ?? i.message }
                throw EffectError.unsupported("The effect's source doesn't compile (\(errs.joined(separator: "; "))); fix it in the document, or open a catalog effect instead.", effectId)
            }
            description = d
            sourceText = text
            compiledSource = text
            sourceIssues = first.issues
        } else {
            // The provider's own errors (unknown_effect for a bad id, anything else as it is) pass through.
            description = try await provider.describe(effectId)
        }
        if let initialDoc {
            let problems = documentErrors(initialDoc, description)
            if !problems.isEmpty { throw controlError(effectId, problems) }
        }
        if description.kind == "motion" { throw EffectError.unsupported("Motion effects cannot be authored as pixel effects", effectId) }

        var duration = initialDoc?["duration"]?.numberValue ?? description.duration ?? 1000
        if !(duration > 0) { duration = 1000 }
        let playheadTime: Double
        if let start = options.startTime, start.isFinite { playheadTime = Swift.max(0, Swift.min(duration, start)) } else { playheadTime = duration / 2 }

        var base = description.defaults
        if let values = initialDoc?["values"]?.objectValue {
            for (k, v) in values { base[k] = v }
        } else if let requestedPreset {
            let presets = (description.json["presets"]?.arrayValue ?? []).compactMap(\.objectValue)
            guard let found = presets.first(where: { $0["name"]?.stringValue == requestedPreset }) else {
                let names = presets.map { "\"\($0["name"]?.stringValue ?? "")\"" }.joined(separator: ", ")
                throw EffectError.unsupported("Unknown preset \"\(requestedPreset)\" for effect \"\(effectId)\". Valid presets are: \(names.isEmpty ? "none" : names)", effectId)
            }
            for (k, v) in found["values"]?.objectValue ?? [:] { base[k] = v }
        }

        var tracks = EffectTracks()
        for (k, kfs) in initialDoc?["tracks"]?.objectValue ?? [:] {
            tracks[k] = sortedByTime((kfs.arrayValue ?? []).compactMap { EffectKeyframe(json: $0) })
        }

        self.provider = provider
        self.backend = backend
        self.effectId = effectId
        history = options.history ?? HistoryManager()
        scheduleFn = options.schedule ?? defaultEffectAuthoringSchedule
        mergeWindowMs = options.mergeWindowMs
        docName = initialDoc?["name"]?.stringValue
        self.duration = duration
        self.playheadTime = playheadTime
        loop = initialDoc?["loop"]?.boolValue ?? description.json["loop"]?.boolValue ?? false
        compiled = backend != nil ? true : nil
        savedPresets = (initialDoc?["presets"]?.arrayValue ?? []).compactMap(\.objectValue)
        baseValues = base
        self.tracks = tracks
        self.description = description
    }

    // MARK: State

    private func mergePresets() -> [JSONObject] {
        var result: [JSONObject] = []
        var seen = Set<String>()
        for p in savedPresets {
            result.append(p)
            seen.insert(p["name"]?.stringValue ?? "")
        }
        for p in (description.json["presets"]?.arrayValue ?? []).compactMap(\.objectValue) {
            let name = p["name"]?.stringValue ?? ""
            if seen.insert(name).inserted { result.append(p) }
        }
        return result
    }

    private func buildState() -> EffectAuthoringState {
        var desc = description.json
        desc["presets"] = .array(mergePresets().map { .object($0) })
        let h = history.state
        return EffectAuthoringState(
            providerId: provider.id, effectId: effectId, name: docName ?? description.name, kind: description.kind, description: EffectDescription(desc),
            source: sourceText, sourceLanguage: backend?.language, values: valuesAtTime(playheadTime, baseValues, tracks), tracks: tracks, issues: sourceIssues,
            compiled: compiled, previewError: previewError, time: playheadTime, duration: duration, loop: loop, playing: playing, canUndo: h.canUndo, canRedo: h.canRedo)
    }

    public func getState() -> EffectAuthoringState {
        if let cachedState { return cachedState }
        let s = buildState()
        cachedState = s
        return s
    }

    private func invalidateState() {
        cachedState = nil
        let next = getState()
        for l in listeners { l.fn(next) }
    }

    public func subscribe(_ listener: @escaping (EffectAuthoringState) -> Void) -> Cancellable {
        let id = nextListener
        nextListener += 1
        listeners.append((id, listener))
        return Cancellable { [weak self] in self?.listeners.removeAll { $0.id == id } }
    }

    private var controlNames: [String] { description.controlNames }

    private func unknownControl(_ name: String) -> EffectAuthoringResult? {
        let names = controlNames
        return names.contains(name) ? nil : .refused("there is no control \"\(name)\"; the controls are \(names.joined(separator: ", "))")
    }

    private func one(_ name: String, _ value: JSONValue?) -> JSONValue {
        var o = JSONObject()
        o[name] = value
        return .object(o)
    }

    private static let closed = EffectAuthoringResult.refused("the session is closed")

    // MARK: Source

    public var canEditSource: Bool { backend != nil }

    private struct SourceSnapshot {
        var sourceText: String?
        var compiledSource: String?
        var sourceIssues: [EffectAuthoringIssue]
        var compiled: Bool?
        var description: EffectDescription
        var baseValues: JSONObject
        var tracks: EffectTracks
    }

    /// Values and tracks carried over to new controls: kept where the control is still there and the value still fits.
    private func carryOver(_ next: EffectDescription) -> (base: JSONObject, tracks: EffectTracks) {
        var base = next.defaults
        for name in next.controlNames {
            if let v = baseValues[name], valueErrors(next, one(name, v)).isEmpty { base[name] = v }
        }
        var kept = EffectTracks()
        let names = next.controlNames
        for (name, kfs) in tracks where names.contains(name) && kfs.allSatisfy({ valueErrors(next, one(name, $0.value)).isEmpty }) { kept[name] = kfs }
        return (base, kept)
    }

    public func setSource(_ src: String) async -> EffectSourceResult {
        if disposed { return .refused("the session is closed") }
        guard let backend else { return .refused("this effect has no source to edit") }
        if let refused = backend.refuse(src) { return .refused(refused) }
        let result = backend.compile(src, effectId: effectId)
        let before = SourceSnapshot(sourceText: sourceText, compiledSource: compiledSource, sourceIssues: sourceIssues, compiled: compiled, description: description, baseValues: baseValues, tracks: tracks)
        var after = before
        if let d = result.description {
            let carried = carryOver(d)
            after = SourceSnapshot(sourceText: src, compiledSource: src, sourceIssues: result.issues, compiled: true, description: d, baseValues: carried.base, tracks: carried.tracks)
        } else {
            after.sourceText = src
            after.sourceIssues = result.issues
            after.compiled = false
        }
        let apply: (SourceSnapshot) -> Void = { [weak self] s in
            guard let self else { return }
            sourceText = s.sourceText
            compiledSource = s.compiledSource
            sourceIssues = s.sourceIssues
            compiled = s.compiled
            description = s.description
            baseValues = s.baseValues
            tracks = s.tracks
        }
        history.execute(Command(name: "Edit source", execute: { apply(after) }, undo: { apply(before) }))
        invalidateState()
        return .ok(issues: result.issues)
    }

    // MARK: Values

    private func record(_ command: Command, gesture: String?, merge: Bool) {
        if let gesture, !gesture.isEmpty { history.executeMerged(command, key: gesture) }
        else if merge { history.executeMerged(command, windowMs: mergeWindowMs) }
        else { history.execute(command) }
    }

    public func setValue(_ name: String, _ value: JSONValue, gesture: String?) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        if let r = unknownControl(name) { return r }
        let errors = valueErrors(description, one(name, value))
        if !errors.isEmpty { return .refused(valueErrorMessage(errors)) }

        if !(tracks[name]?.isEmpty ?? true) {
            let oldTracks = tracks
            let t = playheadTime
            let execute = { [weak self] in
                guard let self else { return }
                var track = tracks[name] ?? []
                if let idx = track.firstIndex(where: { $0.time == t }) {
                    track[idx].value = value
                } else {
                    track.append(EffectKeyframe(time: t, value: value))
                    track = sortedByTime(track)
                }
                tracks[name] = track
                invalidateState()
            }
            let undo = { [weak self] in
                guard let self else { return }
                tracks = oldTracks
                invalidateState()
            }
            record(Command(name: "Set \(name)", tag: name, execute: execute, undo: undo), gesture: gesture, merge: true)
            invalidateState()
            return .ok
        }

        let prev = baseValues[name]
        let cmd = Command(name: "Set \(name)", tag: name, execute: { [weak self] in self?.baseValues[name] = value; return }, undo: { [weak self] in self?.baseValues[name] = prev; return })
        record(cmd, gesture: gesture, merge: true)
        invalidateState()
        return .ok
    }

    public func setValues(_ values: JSONObject, gesture: String?) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        for (k, v) in values {
            if let r = unknownControl(k) { return r }
            let errors = valueErrors(description, one(k, v))
            if !errors.isEmpty { return .refused(valueErrorMessage(errors)) }
        }
        let prevBase = baseValues, prevTracks = tracks
        let t = playheadTime
        let execute = { [weak self] in
            guard let self else { return }
            for (k, v) in values {
                if var track = tracks[k], !track.isEmpty {
                    if let idx = track.firstIndex(where: { $0.time == t }) {
                        track[idx].value = v
                    } else {
                        track.append(EffectKeyframe(time: t, value: v))
                        track = sortedByTime(track)
                    }
                    tracks[k] = track
                } else {
                    baseValues[k] = v
                }
            }
        }
        let undo = { [weak self] in
            guard let self else { return }
            baseValues = prevBase
            tracks = prevTracks
        }
        record(Command(name: "Set values", execute: execute, undo: undo), gesture: gesture, merge: false)
        invalidateState()
        return .ok
    }

    public func resetValues(_ names: [String]?) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        let targets = names ?? controlNames
        let prevBase = baseValues, prevTracks = tracks
        let execute = { [weak self] in
            guard let self else { return }
            let defaults = description.defaults
            for name in targets {
                if let d = defaults[name] { baseValues[name] = d }
                tracks[name] = nil
            }
        }
        let undo = { [weak self] in
            guard let self else { return }
            baseValues = prevBase
            tracks = prevTracks
        }
        history.execute(Command(name: "Reset values", execute: execute, undo: undo))
        invalidateState()
        return .ok
    }

    public func applyPreset(_ name: String) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        let all = mergePresets()
        guard let preset = all.first(where: { $0["name"]?.stringValue == name }) else {
            let available = all.map { "\"\($0["name"]?.stringValue ?? "")\"" }.joined(separator: ", ")
            return .refused("unknown preset \"\(name)\"; available presets are: \(available.isEmpty ? "none" : available)")
        }
        let prevBase = baseValues, prevTracks = tracks
        let values = preset["values"]?.objectValue ?? [:]
        let execute = { [weak self] in
            guard let self else { return }
            for (k, v) in values {
                baseValues[k] = v
                tracks[k] = nil
            }
        }
        let undo = { [weak self] in
            guard let self else { return }
            baseValues = prevBase
            tracks = prevTracks
        }
        history.execute(Command(name: "Apply preset \"\(name)\"", execute: execute, undo: undo))
        invalidateState()
        return .ok
    }

    public func savePreset(_ name: String) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .refused("preset name cannot be empty") }
        let current = valuesAtTime(playheadTime, baseValues, tracks)
        let prevSaved = savedPresets
        let execute = { [weak self] in
            guard let self else { return }
            var next = savedPresets.filter { $0["name"]?.stringValue != trimmed }
            next.append(["name": .string(trimmed), "values": .object(current)])
            savedPresets = next
        }
        history.execute(Command(name: "Save preset \"\(trimmed)\"", execute: execute, undo: { [weak self] in self?.savedPresets = prevSaved; return }))
        invalidateState()
        return .ok
    }

    // MARK: Keyframes

    public func setKeyframe(_ name: String, time: Double, value: JSONValue?, easing: AnimationEasing?) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        if let r = unknownControl(name) { return r }
        if !time.isFinite || time < 0 { return .refused("keyframe time must be a finite number >= 0") }
        if let easing, !isAnimationEasing(easing.json) {
            let shown: String = { if case .named(let s) = easing { return s }; return "[object Object]" }()
            return .refused("invalid easing: \(shown)")
        }
        let target = value ?? valuesAtTime(time, baseValues, tracks)[name]
        let errors = valueErrors(description, one(name, target))
        if !errors.isEmpty { return .refused(valueErrorMessage(errors)) }

        let prevTrack = tracks[name]
        let execute = { [weak self] in
            guard let self else { return }
            var track = prevTrack ?? []
            let kf = EffectKeyframe(time: time, value: target ?? .null, easing: easing)
            if let idx = track.firstIndex(where: { $0.time == time }) {
                track[idx] = kf
            } else {
                track.append(kf)
                track = sortedByTime(track)
            }
            tracks[name] = track
        }
        let undo = { [weak self] in self?.tracks[name] = prevTrack; return }
        history.execute(Command(name: "Set keyframe on \(name)", execute: execute, undo: undo))
        invalidateState()
        return .ok
    }

    public func removeKeyframe(_ name: String, time: Double) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        if let r = unknownControl(name) { return r }
        let track = tracks[name]
        guard let track, track.contains(where: { $0.time == time }) else {
            let times = (track ?? []).map { JSONValue.jsNumber($0.time) }.joined(separator: ", ")
            return .refused(times.isEmpty ? "control \"\(name)\" has no keyframes" : "no keyframe at \(JSONValue.jsNumber(time)) ms on control \"\(name)\"; its keyframes are at \(times) ms")
        }
        let execute = { [weak self] in
            guard let self else { return }
            let next = (tracks[name] ?? []).filter { $0.time != time }
            tracks[name] = next.isEmpty ? nil : next
        }
        history.execute(Command(name: "Remove keyframe on \(name)", execute: execute, undo: { [weak self] in self?.tracks[name] = track; return }))
        invalidateState()
        return .ok
    }

    public func clearTrack(_ name: String) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        if let r = unknownControl(name) { return r }
        guard let prevTrack = tracks[name], !prevTrack.isEmpty else {
            let animated = tracks.filter { !$0.keyframes.isEmpty }.map(\.control)
            return .refused("control \"\(name)\" is not animated, so there is nothing to clear; \(animated.isEmpty ? "no control is animated" : "the animated controls are \(animated.joined(separator: ", "))")")
        }
        let current = valuesAtTime(playheadTime, baseValues, tracks)[name]
        let prevBase = baseValues[name]
        let execute = { [weak self] in
            guard let self else { return }
            tracks[name] = nil
            baseValues[name] = current
        }
        let undo = { [weak self] in
            guard let self else { return }
            tracks[name] = prevTrack
            baseValues[name] = prevBase
        }
        history.execute(Command(name: "Clear animation on \(name)", execute: execute, undo: undo))
        invalidateState()
        return .ok
    }

    public func setTiming(duration newDuration: Double?, loop newLoop: Bool?) -> EffectAuthoringResult {
        if disposed { return Self.closed }
        if let d = newDuration, !(d > 0) || !d.isFinite { return .refused("duration must be a finite number > 0") }
        let prevDuration = duration, prevLoop = loop, prevTime = playheadTime
        let execute = { [weak self] in
            guard let self else { return }
            if let d = newDuration {
                duration = d
                if playheadTime > d { playheadTime = d }
            }
            if let l = newLoop { loop = l }
        }
        let undo = { [weak self] in
            guard let self else { return }
            duration = prevDuration
            loop = prevLoop
            playheadTime = prevTime
        }
        history.execute(Command(name: "Set timing", execute: execute, undo: undo))
        invalidateState()
        return .ok
    }

    // MARK: Playback

    private func pauseInternal() {
        if !playing { return }
        playing = false
        cancelSchedule?()
        cancelSchedule = nil
        lastScheduleTime = nil
        invalidateState()
    }

    private func seekInternal(_ t: Double) {
        let clamped = Swift.max(0, Swift.min(duration, t))
        if clamped != playheadTime {
            playheadTime = clamped
            invalidateState()
        }
    }

    public func play() {
        if disposed || playing { return }
        playing = true
        lastScheduleTime = nil
        cancelSchedule = scheduleFn { [weak self] now in
            guard let self, playing else { return }
            let delta = lastScheduleTime.map { Swift.max(0, now - $0) } ?? 0
            lastScheduleTime = now
            var next = playheadTime + delta
            if next >= duration {
                if loop {
                    next = duration > 0 ? next.truncatingRemainder(dividingBy: duration) : 0
                } else {
                    next = duration
                    pauseInternal()
                }
            }
            seekInternal(next)
        }
        invalidateState()
    }

    public func pause() { pauseInternal() }

    public func seek(_ time: Double) {
        if disposed { return }
        seekInternal(time)
    }

    public func undo() -> Bool {
        if disposed { return false }
        let changed = history.undo()
        if changed { invalidateState() }
        return changed
    }

    public func redo() -> Bool {
        if disposed { return false }
        let changed = history.redo()
        if changed { invalidateState() }
        return changed
    }

    // MARK: Previews

    /// The keyframed values at `time` (for previews).
    fileprivate func previewValues(_ time: Double) -> JSONObject { valuesAtTime(time, baseValues, tracks) }
    fileprivate var isDisposed: Bool { disposed }
    fileprivate var latestCompiledSource: String? { compiledSource }

    fileprivate func markCompiled() {
        if compiled != true {
            compiled = true
            invalidateState()
        }
    }

    fileprivate func previewDisposed(_ renderer: EffectRenderer) { livePreviews[ObjectIdentifier(renderer)] = nil }

    public func createPreview(width: Int, height: Int) async throws -> EffectRenderer {
        if disposed { throw disposedError(effectId) }
        let renderer: EffectRenderer
        do {
            if let backend, let src = compiledSource {
                let inner = try await backend.createRenderer(src, effectId: effectId, width: width, height: height)
                renderer = SourceRenderer(session: self, backend: backend, drawn: src, inner: inner)
            } else {
                renderer = try provider.createRenderer(effectId, width: width, height: height)
            }
        } catch {
            // Kept in the state so editors and agents can say why there is no picture.
            let message = authoringErrorMessage(error)
            let reason = description.kind == "vector" ? "No pixel preview for this vector effect: \(message)" : "No pixel preview: \(message)"
            if previewError != reason {
                previewError = reason
                invalidateState()
            }
            throw error
        }
        livePreviews[ObjectIdentifier(renderer)] = renderer
        if previewError != nil {
            previewError = nil
            invalidateState()
        }
        return AuthoringPreview(session: self, inner: renderer)
    }

    public func exportDocument() -> EffectAuthoringDocument {
        EffectAuthoringDocument(
            providerId: provider.id, effectId: effectId, name: docName ?? description.name, values: valuesAtTime(playheadTime, baseValues, tracks), tracks: tracks,
            presets: savedPresets, duration: duration, loop: loop, source: backend != nil ? sourceText : nil, sourceLanguage: backend != nil && sourceText != nil ? backend!.language : nil)
    }

    public func dispose() {
        if disposed { return }
        disposed = true
        pauseInternal()
        listeners.removeAll()
        for p in livePreviews.values { p.dispose() }
        livePreviews.removeAll()
    }
}

/// A renderer that always draws the latest source that compiled: a new inner renderer when the source has changed since the last render.
private final class SourceRenderer: EffectRenderer {
    weak var session: GenericEffectAuthoringSession?
    let backend: AuthoringSourceBackend
    var drawn: String
    var inner: EffectRenderer
    let effectId: String
    let width: Int
    let height: Int

    init(session: GenericEffectAuthoringSession, backend: AuthoringSourceBackend, drawn: String, inner: EffectRenderer) {
        self.session = session
        self.backend = backend
        self.drawn = drawn
        self.inner = inner
        effectId = session.effectId
        width = inner.width
        height = inner.height
    }

    func render(_ request: EffectRenderRequest) async throws -> EffectPixels {
        if let latest = session?.latestCompiledSource, latest != drawn {
            let next = try await backend.createRenderer(latest, effectId: effectId, width: width, height: height)
            inner.dispose()
            inner = next
            drawn = latest
        }
        return try await inner.render(request)
    }

    func dispose() { inner.dispose() }
}

/// A session's preview: renders with the keyframed values at each request's time unless it gives values.
private final class AuthoringPreview: EffectRenderer {
    weak var session: GenericEffectAuthoringSession?
    let inner: EffectRenderer
    let effectId: String
    let width: Int
    let height: Int
    let sessionEffectId: String

    init(session: GenericEffectAuthoringSession, inner: EffectRenderer) {
        self.session = session
        self.inner = inner
        effectId = inner.effectId
        width = inner.width
        height = inner.height
        sessionEffectId = session.effectId
    }

    func render(_ request: EffectRenderRequest) async throws -> EffectPixels {
        guard let session, !session.isDisposed else { throw disposedError(sessionEffectId) }
        var req = request
        req.values = request.values ?? session.previewValues(request.time)
        let pixels = try await inner.render(req)
        session.markCompiled()
        return pixels
    }

    func dispose() {
        session?.previewDisposed(inner)
        inner.dispose()
    }
}
