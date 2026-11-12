import CoreGraphics
import PixerateCore
import PixeratePaint
import SwiftUI
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/**
 * The effect authoring editor (`<EffectAuthoringEditor>` in React and Svelte): a toolbar (play,
 * the playhead, undo, redo, save preset), the preview (Metal for `pixel` sources when available,
 * else the session's CPU preview), the source pane with line numbers and issue markers, the
 * parameters with a keyframe toggle per control, and the timeline (duration, loop, scrubber and
 * a row of keyframes per animated control). It follows the session, so an agent's changes through
 * the `effect_authoring_*` tools show here too.
 */
public struct EffectAuthoringEditor: View {
    let model: EffectAuthoringModel
    let showSource: Bool
    let showTimeline: Bool

    public init(model: EffectAuthoringModel, showSource: Bool = true, showTimeline: Bool = true) {
        self.model = model
        self.showSource = showSource
        self.showTimeline = showTimeline
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AuthoringToolbar(model: model)
            Divider()
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) { workspace }
                VStack(alignment: .leading, spacing: 12) { workspace }
            }
            if let message = model.message {
                Text(message).font(.caption).foregroundStyle(.red).accessibilityAddTraits(.isStaticText)
            }
            Divider()
            AuthoringParameters(model: model)
            if showTimeline {
                Divider()
                AuthoringTimeline(model: model)
            }
        }
        .font(.caption)
        .task { await model.renderFrames() }
        .onDisappear { Task { await model.commitSource() } }
    }

    @ViewBuilder
    private var workspace: some View {
        AuthoringPreviewPane(model: model).frame(minWidth: 240, maxWidth: 360)
        if showSource && model.hasSource {
            AuthoringSourcePane(model: model).frame(minWidth: 280)
        }
    }
}

/// Play / pause, the playhead, undo, redo and saving a preset.
private struct AuthoringToolbar: View {
    let model: EffectAuthoringModel
    @State private var savingPreset = false
    @State private var presetName = ""

    var body: some View {
        let state: EffectAuthoringState = model.state
        HStack(spacing: 8) {
            Button(state.playing ? "Pause" : "Play") { model.togglePlayback() }
                .accessibilityLabel(state.playing ? "Pause playback" : "Start playback")
            Text(model.timeReadout).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Button("Undo") { model.undo() }.disabled(!state.canUndo)
            Button("Redo") { model.redo() }.disabled(!state.canRedo)
            if savingPreset {
                TextField("Preset name", text: $presetName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)
                    .onSubmit(save)
                Button("Save", action: save).disabled(presetName.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Cancel") { savingPreset = false }
            } else {
                Button("Save preset…") { savingPreset = true }
            }
        }
        .buttonStyle(.bordered)
    }

    private func save() {
        if model.savePreset(presetName) {
            savingPreset = false
            presetName = ""
        }
    }
}

/// The preview frame, why it is missing, and the source's issues.
private struct AuthoringPreviewPane: View {
    let model: EffectAuthoringModel

    var body: some View {
        let aspect: CGFloat = CGFloat(model.previewWidth) / CGFloat(model.previewHeight)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                PanelHeading("Preview")
                Spacer()
                if model.preview != nil {
                    Text(model.previewOnGPU ? "Metal" : "CPU").font(.caption2).foregroundStyle(.secondary)
                }
            }
            ZStack {
                Rectangle().fill(Color.black)
                if let image = model.preview.flatMap(effectPreviewImage) {
                    Image(decorative: image, scale: 1).resizable().interpolation(.medium).aspectRatio(contentMode: .fit)
                }
                if let error = model.previewError {
                    Text(error).font(.caption).foregroundStyle(.white.opacity(0.8)).multilineTextAlignment(.center).padding(8)
                }
            }
            .aspectRatio(aspect, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Effect preview")
            AuthoringIssues(issues: model.state.issues)
        }
    }
}

/// The compile issues, with their lines.
private struct AuthoringIssues: View {
    let issues: [EffectAuthoringIssue]

    var body: some View {
        if !issues.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
                    Text(issueText(issue)).foregroundStyle(issue.severity == "error" ? Color.red : Color.orange)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.red.opacity(0.08)))
        }
    }

    private func issueText(_ issue: EffectAuthoringIssue) -> String {
        if let line = issue.line { return "Line \(line): \(issue.message)" }
        return issue.message
    }
}

/// The source with line numbers; lines with issues are marked in the gutter (`pixel` sources).
private struct AuthoringSourcePane: View {
    let model: EffectAuthoringModel

    var body: some View {
        let lineCount: Int = model.sourceLineCount
        let issues: [Int: String] = model.marksIssueLines ? model.issueLines : [:]
        let height: CGFloat = CGFloat(lineCount) * SourceMetrics.lineHeight + SourceMetrics.inset * 2 + 8
        VStack(alignment: .leading, spacing: 6) {
            PanelHeading("Source (\(model.state.sourceLanguage ?? ""))")
            ScrollView(.vertical) {
                HStack(alignment: .top, spacing: 0) {
                    SourceGutter(lineCount: lineCount, issues: issues)
                    TextEditor(text: Binding(get: { model.sourceDraft }, set: { model.editSource($0) }))
                        .font(SourceMetrics.font)
                        .autocorrectionDisabled()
                        .scrollDisabled(true)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: height)
                        .accessibilityLabel("Effect source code")
                }
            }
            .frame(minHeight: 160, maxHeight: 280)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.secondary.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(.quaternary))
        }
    }
}

/// The line numbers beside the source.
private struct SourceGutter: View {
    let lineCount: Int
    let issues: [Int: String]

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            ForEach(1...Swift.max(1, lineCount), id: \.self) { line in
                SourceGutterLine(line: line, severity: issues[line])
            }
        }
        .padding(.top, SourceMetrics.inset)
        .padding(.horizontal, 4)
        .background(Color.secondary.opacity(0.1))
        .accessibilityHidden(true)
    }
}

private struct SourceGutterLine: View {
    let line: Int
    let severity: String?

    var body: some View {
        let color: Color = severity == "error" ? .red : severity == nil ? .secondary : .orange
        HStack(spacing: 2) {
            Circle().fill(severity == nil ? Color.clear : color).frame(width: 5, height: 5)
            Text("\(line)").font(SourceMetrics.font).fontWeight(severity == nil ? .regular : .bold).foregroundStyle(color)
        }
        .frame(height: SourceMetrics.lineHeight)
    }
}

/// The source pane's font and line metrics, so the gutter lines up with the text.
enum SourceMetrics {
    static let size: CGFloat = 12
    static let font: Font = .system(size: size, design: .monospaced)
    #if canImport(AppKit)
    static let lineHeight: CGFloat = NSLayoutManager().defaultLineHeight(for: NSFont.monospacedSystemFont(ofSize: size, weight: .regular))
    /// The text view's top inset.
    static let inset: CGFloat = 0
    #elseif canImport(UIKit)
    static let lineHeight: CGFloat = UIFont.monospacedSystemFont(ofSize: size, weight: .regular).lineHeight
    static let inset: CGFloat = 8
    #else
    static let lineHeight: CGFloat = 15
    static let inset: CGFloat = 0
    #endif
}

/// The effect's controls, each with a keyframe toggle and a reset, and its presets.
private struct AuthoringParameters: View {
    let model: EffectAuthoringModel

    var body: some View {
        let fields: [EffectAuthoringField] = model.fields
        let presets: [String] = model.presetNames
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                PanelHeading("Parameters")
                Spacer()
                if !presets.isEmpty {
                    Menu("Presets") {
                        ForEach(presets, id: \.self) { name in Button(name) { model.applyPreset(name) } }
                    }
                    .fixedSize()
                }
            }
            if fields.isEmpty { Text("This effect has no controls.").foregroundStyle(.secondary) }
            ForEach(fields) { field in AuthoringFieldRow(model: model, field: field) }
        }
    }
}

/// One control: its editor, the keyframe toggle (◆ removes the keyframe at the playhead, ◇ adds one) and a reset.
private struct AuthoringFieldRow: View {
    let model: EffectAuthoringModel
    let field: EffectAuthoringField

    var body: some View {
        let mark: EffectKeyframeMark = model.keyframeMark(field.id)
        HStack(spacing: 6) {
            AuthoringFieldControl(model: model, field: field, value: model.value(field))
            Button(mark == .atPlayhead ? "◆" : "◇") { model.toggleKeyframe(field.id) }
                .buttonStyle(.plain)
                .foregroundStyle(mark == .none ? Color.secondary : Color.accentColor)
                .fontWeight(mark == .atPlayhead ? .bold : .regular)
                .help(mark == .atPlayhead ? "Remove keyframe at playhead" : "Add keyframe at playhead")
                .accessibilityLabel(mark == .atPlayhead ? "Remove keyframe for \(field.id)" : "Add keyframe for \(field.id)")
            Button { model.resetValue(field.id) } label: { Image(systemName: "arrow.uturn.backward") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Reset to the default")
                .accessibilityLabel("Reset \(field.id)")
        }
    }
}

/// The editor for one field's type.
private struct AuthoringFieldControl: View {
    let model: EffectAuthoringModel
    let field: EffectAuthoringField
    let value: JSONValue

    var body: some View {
        switch field.type {
        case "number", "int": numberControl
        case "boolean":
            Toggle(field.label, isOn: Binding(get: { value.boolValue ?? false }, set: { model.setValue(field.id, .bool($0)) }))
        case "color":
            HexColorPicker(label: field.label, hex: value.stringValue ?? "#000000") { model.setValue(field.id, .string($0), gesture: "color:\(field.id)") }
        case "choice": choiceControl
        case "vector": VectorFieldControl(model: model, field: field, value: value)
        default: TextFieldControl(label: field.label, text: value.stringValue ?? "") { model.setValue(field.id, .string($0)) }
        }
    }

    @ViewBuilder
    private var numberControl: some View {
        let number: Double = value.numberValue ?? 0
        if let lo = field.min, let hi = field.max, hi > lo {
            let step: Double = field.step ?? (field.type == "int" ? 1 : (hi - lo) / 100)
            let gesture: String = "slider:\(field.id)"
            PaintSliderRow(label: field.label, value: number, range: lo...hi, step: step,
                           onChange: { model.setValue(field.id, .number($0), gesture: gesture) },
                           onCommit: { model.setValue(field.id, .number($0), gesture: gesture) })
        } else {
            TextFieldControl(label: field.label, text: JSONValue.jsNumber(number)) { text in
                if let n = Double(text) { model.setValue(field.id, .number(n)) }
            }
        }
    }

    @ViewBuilder
    private var choiceControl: some View {
        let options: [(value: JSONValue, label: String)] = field.options
        Picker(field.label, selection: Binding(get: { options.firstIndex(where: { $0.value == value }) ?? 0 }, set: { i in
            if options.indices.contains(i) { model.setValue(field.id, options[i].value) }
        })) {
            ForEach(options.indices, id: \.self) { i in Text(options[i].label).tag(i) }
        }
    }
}

/// A text field that applies on Return (or when it loses focus).
private struct TextFieldControl: View {
    let label: String
    let text: String
    let onCommit: (String) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            TextField(label, text: $draft)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { commit() }
        }
        .onAppear { draft = text }
        .onChange(of: text) { _, next in if !focused { draft = next } }
        .onChange(of: focused) { _, now in if !now { commit() } }
    }

    private func commit() {
        if draft != text { onCommit(draft) }
    }
}

/// A vector control: one number per component.
private struct VectorFieldControl: View {
    let model: EffectAuthoringModel
    let field: EffectAuthoringField
    let value: JSONValue

    var body: some View {
        let parts: [Double] = (value.arrayValue ?? []).map { $0.numberValue ?? 0 }
        HStack(spacing: 4) {
            Text(field.label).foregroundStyle(.secondary)
            ForEach(0..<Swift.max(field.size, parts.count), id: \.self) { i in
                let current: Double = i < parts.count ? parts[i] : 0
                TextFieldControl(label: "", text: JSONValue.jsNumber(current)) { text in
                    guard let n = Double(text) else { return }
                    var next: [JSONValue] = parts.map { .number($0) }
                    while next.count <= i { next.append(.number(0)) }
                    next[i] = .number(n)
                    model.setValue(field.id, .array(next))
                }
            }
        }
    }
}

/// Duration, loop, the scrubber and a row of keyframes per animated control.
private struct AuthoringTimeline: View {
    let model: EffectAuthoringModel

    var body: some View {
        let state: EffectAuthoringState = model.state
        let tracks: [EffectTimelineTrack] = model.timelineTracks
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                PanelHeading("Timeline")
                Spacer()
                DurationField(duration: state.duration) { model.setDuration($0) }
                Toggle("Loop", isOn: Binding(get: { state.loop }, set: { model.setLoop($0) }))
                    .accessibilityLabel("Loop playback")
            }
            Slider(value: Binding(get: { Swift.min(state.time, state.duration) }, set: { model.seek($0) }), in: 0...Swift.max(1, state.duration))
                .accessibilityLabel("Timeline scrubber")
            ForEach(tracks) { track in TimelineTrackRow(model: model, track: track) }
        }
    }
}

/// The duration in ms, applied on Return or when the field loses focus (one undo step).
private struct DurationField: View {
    let duration: Double
    let onCommit: (Double) -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 4) {
            Text("Duration")
            TextField("Duration", text: $draft)
                .textFieldStyle(.roundedBorder)
                .frame(width: 64)
                .focused($focused)
                .onSubmit { commit() }
                .accessibilityLabel("Duration")
            Text("ms").foregroundStyle(.secondary)
        }
        .onAppear { draft = JSONValue.jsNumber(duration) }
        .onChange(of: duration) { _, next in draft = JSONValue.jsNumber(next) }
        .onChange(of: focused) { _, now in if !now { commit() } }
    }

    private func commit() {
        if let n = Double(draft), n.isFinite, n >= 1, n != duration { onCommit(n) } else { draft = JSONValue.jsNumber(duration) }
    }
}

/// One animated control: its name, "Clear track", and its keyframes (tap one to seek to it).
private struct TimelineTrackRow: View {
    let model: EffectAuthoringModel
    let track: EffectTimelineTrack

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(track.control).foregroundStyle(.secondary)
                Spacer()
                Button("Clear track") { model.clearTrack(track.control) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Clear animation track for \(track.control)")
            }
            GeometryReader { geo in
                let width: CGFloat = geo.size.width
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.secondary.opacity(0.15))
                    ForEach(track.times.indices, id: \.self) { i in
                        KeyframeDiamond(model: model, control: track.control, time: track.times[i])
                            .position(x: CGFloat(track.positions[i]) * width, y: geo.size.height / 2)
                    }
                }
            }
            .frame(height: 16)
        }
    }
}

private struct KeyframeDiamond: View {
    let model: EffectAuthoringModel
    let control: String
    let time: Double

    var body: some View {
        let label: String = "\(JSONValue.jsNumber(time))ms"
        Button("◆") { model.seek(time) }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .help("\(control) @ \(label)")
            .accessibilityLabel("Seek to \(control) keyframe at \(label)")
    }
}

/// A preview frame (straight-alpha RGBA) as an image.
func effectPreviewImage(_ pixels: EffectPixels) -> CGImage? {
    guard pixels.width > 0, pixels.height > 0, pixels.data.count >= pixels.width * pixels.height * 4,
          let provider = CGDataProvider(data: Data(pixels.data) as CFData),
          let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue)
    return CGImage(width: pixels.width, height: pixels.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: pixels.width * 4, space: space, bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
}
