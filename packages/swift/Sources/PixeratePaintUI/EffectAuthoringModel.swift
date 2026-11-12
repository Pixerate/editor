import Foundation
import Observation
import PixerateCore
import PixeratePaint

/// One control of the open effect as the editor shows it: a parameter field (`effectParameterFields`).
public struct EffectAuthoringField: Identifiable, Sendable {
    /// The field as the TS core builds it (`ParameterField`).
    public let json: JSONObject
    public var id: String { json["id"]?.stringValue ?? "" }
    /// The label shown: the schema title, else the control name with a capital.
    public var label: String {
        if let l = json["label"]?.stringValue, !l.isEmpty { return l }
        return id.prefix(1).uppercased() + id.dropFirst()
    }
    /// `number`, `int`, `choice`, `boolean`, `color`, `text` or `vector`.
    public var type: String { json["type"]?.stringValue ?? "" }
    public var min: Double? { json["min"]?.numberValue }
    public var max: Double? { json["max"]?.numberValue }
    public var step: Double? { json["step"]?.numberValue }
    public var defaultValue: JSONValue { json["default"] ?? .null }
    /// A choice's options as (value, label).
    public var options: [(value: JSONValue, label: String)] {
        (json["options"]?.arrayValue ?? []).map { o in
            if let obj = o.objectValue { return (obj["value"] ?? .null, obj["label"]?.stringValue ?? obj["value"]?.stringValue ?? "") }
            return (o, o.stringValue ?? o.numberValue.map(JSONValue.jsNumber) ?? "")
        }
    }
    /// A vector's component count.
    public var size: Int { Int(json["size"]?.numberValue ?? 0) }

    public init(json: JSONObject) { self.json = json }
}

/// How a control's keyframe toggle shows (`renderControlAddon` in `<EffectAuthoringEditor>`).
public enum EffectKeyframeMark: Equatable, Sendable {
    /// Not animated: the toggle adds a keyframe at the playhead.
    case none
    /// Animated, with no keyframe at the playhead: the toggle adds one.
    case animated
    /// A keyframe sits at the playhead: the toggle removes it.
    case atPlayhead
}

/// One animated control's row in the timeline: its keyframe times and where each sits (0…1 of the duration).
public struct EffectTimelineTrack: Identifiable, Equatable, Sendable {
    public var control: String
    public var times: [Double]
    public var positions: [Double]
    public var id: String { control }
}

/**
 * The view model of `EffectAuthoringEditor` (React's `useEffectAuthoring` and the editor's
 * handlers): follows an `EffectAuthoringSession` (whoever changes it, the person here or an agent
 * through the `effect_authoring_*` tools), keeps the source as typed and applies it after a pause,
 * and renders the preview one frame at a time at the playhead, on the GPU (`PixelMetalRenderer`)
 * for `pixel` sources that compile when Metal is available, else through the session's own
 * preview renderer on the CPU. Every action is the session call the matching agent tool makes.
 * Call `detach()` when the editor goes away.
 */
@MainActor
@Observable
public final class EffectAuthoringModel {
    public let session: EffectAuthoringSession
    /// The session's latest state.
    public private(set) var state: EffectAuthoringState
    /// The source as typed; applied to the session after `sourceDelay` or on `commitSource()`.
    public private(set) var sourceDraft: String
    /// The latest preview frame, or nil (none yet, or it failed: see `previewError`).
    public private(set) var preview: EffectPixels?
    /// Why the preview shows nothing: it could not be made, or its last frame failed.
    public private(set) var previewError: String?
    /// Whether the latest frame was drawn by Metal (else on the CPU).
    public private(set) var previewOnGPU = false
    /// The last refusal from an action (an invalid value, a preset name, a duration), or nil.
    public var message: String?
    /// Draw `pixel` sources on the GPU when Metal is available (default true).
    public var preferGPU: Bool { didSet { if preferGPU != oldValue { requestFrame() } } }
    /// The preview's size in pixels.
    public let previewWidth: Int
    public let previewHeight: Int
    /// How long typing pauses before the source is applied (seconds, default 0.3 as in React).
    @ObservationIgnored public var sourceDelay: Double = 0.3

    @ObservationIgnored private var subscription: Cancellable?
    @ObservationIgnored private var renderer: EffectRenderer?
    /// The source a preview renderer failed for, so it is not retried until the source changes.
    @ObservationIgnored private var failedSource: String??
    @ObservationIgnored private var gpu: (source: String, renderer: EffectRenderer)?
    @ObservationIgnored private var sourceTask: Task<Void, Never>?
    @ObservationIgnored private var rendering = false
    @ObservationIgnored private var pending = false
    @ObservationIgnored private var detached = false

    /// An editor model on `session`, with a `previewWidth` × `previewHeight` preview (default 240 × 135).
    public init(session: EffectAuthoringSession, previewWidth: Int = 240, previewHeight: Int = 135, preferGPU: Bool = true) {
        self.session = session
        let s = session.getState()
        state = s
        sourceDraft = s.source ?? ""
        self.previewWidth = Swift.max(1, previewWidth)
        self.previewHeight = Swift.max(1, previewHeight)
        self.preferGPU = preferGPU
        subscription = session.subscribe { [weak self] next in
            MainActor.assumeIsolated { self?.update(next) }
        }
    }

    /// Stops following the session and drops the preview renderers (the session itself stays open).
    public func detach() {
        detached = true
        subscription?.cancel()
        subscription = nil
        sourceTask?.cancel()
        sourceTask = nil
        renderer?.dispose()
        renderer = nil
        gpu?.renderer.dispose()
        gpu = nil
    }

    private func update(_ next: EffectAuthoringState) {
        let sourceChanged = next.source != state.source
        state = next
        // The source as typed wins while an edit is waiting to be applied.
        if sourceChanged, sourceTask == nil, let source = next.source { sourceDraft = source }
        requestFrame()
    }

    // MARK: - What the editor shows

    /// Whether the source pane shows: the effect has source and the session can edit it.
    public var hasSource: Bool { state.sourceLanguage != nil && session.canEditSource }
    /// Whether the gutter marks issue lines (`pixel` sources number their issues).
    public var marksIssueLines: Bool { state.sourceLanguage == "pixel" }
    /// The source draft's line count (at least 1).
    public var sourceLineCount: Int { sourceDraft.split(separator: "\n", omittingEmptySubsequences: false).count }
    /// The lines with an issue, and the worst severity on each (`error` over `warning`).
    public var issueLines: [Int: String] {
        var out: [Int: String] = [:]
        for issue in state.issues {
            guard let line = issue.line else { continue }
            if out[line] != "error" { out[line] = issue.severity }
        }
        return out
    }
    /// `time / duration` as the toolbar shows it (`120ms / 1000ms`).
    public var timeReadout: String { "\(JSONValue.jsNumber(state.time))ms / \(JSONValue.jsNumber(state.duration))ms" }
    /// The effect's controls as fields, in schema order.
    public var fields: [EffectAuthoringField] { effectParameterFields(state.description).map(EffectAuthoringField.init(json:)) }
    /// The effect's preset names, in order.
    public var presetNames: [String] {
        (state.description.json["presets"]?.arrayValue ?? []).compactMap { $0["name"]?.stringValue }
    }

    /// A control's value at the playhead, or its field's default.
    public func value(_ field: EffectAuthoringField) -> JSONValue {
        if let v = state.values[field.id], v != .null { return v }
        return field.defaultValue
    }

    /// How a control's keyframe toggle shows.
    public func keyframeMark(_ control: String) -> EffectKeyframeMark {
        guard let track = state.tracks[control], !track.isEmpty else { return .none }
        return track.contains(where: { $0.time == state.time }) ? .atPlayhead : .animated
    }

    /// The animated controls, in track order, with their keyframes along the duration.
    public var timelineTracks: [EffectTimelineTrack] {
        let length: Double = state.duration > 0 ? state.duration : 1
        var out: [EffectTimelineTrack] = []
        for track in state.tracks where !track.keyframes.isEmpty {
            let times: [Double] = track.keyframes.map(\.time)
            let positions: [Double] = times.map { Swift.min(1, Swift.max(0, $0 / length)) }
            out.append(EffectTimelineTrack(control: track.control, times: times, positions: positions))
        }
        return out
    }

    // MARK: - Actions (each is the session call its agent tool makes)

    private func check(_ r: EffectAuthoringResult) {
        message = r.message
    }

    /// Plays or pauses the effect.
    public func togglePlayback() {
        if state.playing { session.pause() } else { session.play() }
    }

    public func undo() { _ = session.undo() }
    public func redo() { _ = session.redo() }

    /// Moves the playhead (ms; clamped to the duration).
    public func seek(_ time: Double) { session.seek(time) }

    /// Sets a control at the playhead (a keyframe there when it is animated). Calls with the same `gesture` merge into one undo step (a slider drag).
    public func setValue(_ control: String, _ value: JSONValue, gesture: String? = nil) {
        check(session.setValue(control, value, gesture: gesture))
    }

    /// Puts a control back to its default.
    public func resetValue(_ control: String) { check(session.resetValues([control])) }

    public func applyPreset(_ name: String) { check(session.applyPreset(name)) }

    /// Saves the current values as a preset; false (with `message`) when the name is empty or refused.
    @discardableResult
    public func savePreset(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            message = "Give the preset a name."
            return false
        }
        let r = session.savePreset(trimmed)
        check(r)
        return r.isOK
    }

    /// Adds a keyframe for `control` at the playhead, or removes the one there.
    public func toggleKeyframe(_ control: String) {
        if keyframeMark(control) == .atPlayhead {
            check(session.removeKeyframe(control, time: state.time))
        } else {
            check(session.setKeyframe(control, time: state.time, value: nil, easing: nil))
        }
    }

    /// Removes a control's keyframes (its value at the playhead stays).
    public func clearTrack(_ control: String) { check(session.clearTrack(control)) }

    /// Sets the duration (ms, at least 1); false and unchanged for anything else, or the same duration.
    @discardableResult
    public func setDuration(_ duration: Double) -> Bool {
        guard duration.isFinite, duration >= 1, duration != state.duration else { return false }
        let r = session.setTiming(duration: duration, loop: nil)
        check(r)
        return r.isOK
    }

    public func setLoop(_ loop: Bool) {
        if loop != state.loop { check(session.setTiming(duration: nil, loop: loop)) }
    }

    /// The source as typed: applied after `sourceDelay` (typing again restarts the wait).
    public func editSource(_ text: String) {
        if text == sourceDraft { return }
        sourceDraft = text
        sourceTask?.cancel()
        let delay = sourceDelay
        sourceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Swift.max(0, delay) * 1_000_000_000))
            if Task.isCancelled { return }
            await self?.commitSource()
        }
    }

    /// Applies the typed source now (one undo step; compile issues show in `state.issues`).
    public func commitSource() async {
        sourceTask?.cancel()
        sourceTask = nil
        guard hasSource, sourceDraft != state.source else { return }
        let result = await session.setSource(sourceDraft)
        message = result.message
    }

    // MARK: - Preview

    /// Asks for a frame: renders now, or once more after the frame being rendered, so the preview never stops on a stale frame.
    public func requestFrame() {
        if detached { return }
        if rendering {
            pending = true
            return
        }
        Task { [weak self] in await self?.renderFrames() }
    }

    /// Renders frames until none is pending (what `requestFrame` runs; tests await it).
    public func renderFrames() async {
        if rendering {
            pending = true
            return
        }
        rendering = true
        defer { rendering = false }
        repeat {
            pending = false
            await renderOnce()
        } while pending && !detached
    }

    private func renderOnce() async {
        let s = state
        if preferGPU, let frame = gpuFrame(s) {
            preview = frame
            previewError = nil
            previewOnGPU = true
            return
        }
        guard let r = await cpuRenderer(s) else { return }
        let request = EffectRenderRequest(time: s.time, inputs: effectSampleInputs(s.description, width: previewWidth, height: previewHeight))
        do {
            let frame = try await r.render(request)
            // A frame from a renderer that has since been replaced is skipped.
            if renderer === r {
                preview = frame
                previewError = nil
                previewOnGPU = false
            }
        } catch {
            if renderer === r {
                preview = nil
                previewError = "\(error)"
            }
        }
    }

    /// The session's preview renderer (made once; not retried after a failure until the source changes).
    private func cpuRenderer(_ s: EffectAuthoringState) async -> EffectRenderer? {
        if let renderer { return renderer }
        if let failed = failedSource, failed == s.source { return nil }
        do {
            let r = try await session.createPreview(width: previewWidth, height: previewHeight)
            if detached {
                r.dispose()
                return nil
            }
            renderer = r
            failedSource = nil
            return r
        } catch {
            failedSource = .some(s.source)
            preview = nil
            previewError = session.getState().previewError ?? "\(error)"
            return nil
        }
    }

    /// A frame drawn by Metal at the playhead with the values there, for a `pixel` source that compiles; nil to draw on the CPU.
    private func gpuFrame(_ s: EffectAuthoringState) -> EffectPixels? {
        guard s.sourceLanguage == "pixel", s.compiled != false, let source = s.source, PixelGPU.isAvailable else { return nil }
        #if canImport(Metal)
        if gpu?.source != source {
            gpu?.renderer.dispose()
            gpu = nil
            let meta = PixelEffectMeta(id: s.effectId ?? "pixel.preview", name: s.name)
            guard let program = describePixelSource(source, meta: meta).program else { return nil }
            guard let r = try? PixelMetalRenderer(program: program, description: s.description, width: previewWidth, height: previewHeight) else { return nil }
            gpu = (source, r)
        }
        guard let r = gpu?.renderer as? PixelMetalRenderer else { return nil }
        return try? r.renderSync(EffectRenderRequest(time: s.time, values: s.values))
        #else
        return nil
        #endif
    }
}
