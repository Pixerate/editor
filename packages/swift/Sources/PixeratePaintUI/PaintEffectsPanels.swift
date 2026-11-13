import PixerateCore
import PixeratePaint
import SwiftUI

/**
 * Provider effects in the paint editor (`PaintEffectsPanel` in React and Svelte): effect paper (a
 * generator over the sheet, multiplied so the grain shows), effect layers, effect fills, light baked
 * onto the active layer's dried paint, and effect paint for the brush (along the canvas, along each
 * stroke, or through the effect's own path control, optionally live); the controls of the effect
 * paper, of an active effect layer and of the effect paint; and live effect playback (play, pause,
 * frame rate cap). Each change is one undo step (a slider is one on release). `PaintEditorView`
 * shows it as the Effects tab only while an effects provider is registered.
 */
public struct PaintProviderEffectsPanel: View {
    let model: PaintEditorModel
    let showsHeading: Bool
    @State private var browse: PaintEffectPlace?

    /// `showsHeading: false` leaves out the "Effects" heading, for hosts that title the panel themselves.
    public init(model: PaintEditorModel, showsHeading: Bool = true) {
        self.model = model
        self.showsHeading = showsHeading
    }

    public var body: some View {
        let pixel = model.activeLayer?.type == "pixel"
        VStack(alignment: .leading, spacing: 8) {
            if showsHeading || model.effectsBusy {
                HStack {
                    if showsHeading { PanelHeading("Effects") }
                    Spacer()
                    if model.effectsBusy { ProgressView().controlSize(.mini).accessibilityLabel("Rendering the effect") }
                }
            }
            if model.effectsProvider == nil {
                Text(model.canAuthorEffects ? "No effects provider is registered: write an effect below." : "No effects provider is registered. Effects in the painting are kept.").font(.caption).foregroundStyle(.secondary)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 4)], alignment: .leading, spacing: 4) {
                    ForEach(PaintEffectPlace.allCases) { place in
                        Button(place.label) { browse = browse == place ? nil : place }
                            .buttonStyle(.bordered)
                            .tint(browse == place ? .accentColor : nil)
                            .disabled(place.needsPixelLayer && !pixel)
                            .accessibilityHint(place.title)
                    }
                }
                if let place = browse {
                    EffectBrowserView(model: model, place: place) { id in
                        browse = nil
                        Task { await model.pickEffect(id, for: place) }
                    }
                }
            }
            if let paper = model.paperEffect { PaperEffectSection(model: model, paper: paper) }
            if let paint = model.effectPaint { EffectPaintSection(model: model, paint: paint) }
            if let animation = model.liveAnimation { EffectPlaybackSection(model: model, animation: animation) }
            if let layer = model.activeEffectLayer { EffectLayerSection(model: model, source: layer) }
            if model.canAuthorEffects { PaintAuthoringSection(model: model) }
        }
    }
}

/// A rounded box around one part of the effects panel.
private struct EffectPart<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .padding(6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
    }
}

/// The provider's effects a place takes, searchable (`EffectsBrowser`).
struct EffectBrowserView: View {
    let model: PaintEditorModel
    let place: PaintEffectPlace
    let onPick: (String) -> Void
    @State private var query = ""
    @State private var found: [EffectDescription]?

    var body: some View {
        EffectPart {
            Text(place.title).font(.caption.weight(.semibold))
            TextField("Search effects", text: $query).textFieldStyle(.roundedBorder)
            if let found {
                if found.isEmpty { Text("No effects match.").font(.caption).foregroundStyle(.secondary) }
                ForEach(found, id: \.id) { d in
                    Button { onPick(d.id) } label: {
                        HStack {
                            Text(d.name)
                            Spacer()
                            Text(d.category).foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .help(d.json["description"]?.stringValue ?? d.name)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .task(id: "\(place.rawValue)|\(query)") { found = await model.effects(for: place, query: query) }
    }
}

/// One effect's controls from the provider's description (`EffectParameters`): numbers as sliders, colours, choices and switches, plus its presets.
struct EffectValuesView: View {
    let model: PaintEditorModel
    let effect: String
    let values: JSONObject
    let apply: (JSONObject) -> Void
    @State private var description: EffectDescription?

    var body: some View {
        Group {
            if model.effectsProvider == nil {
                Text("No effects provider: \"\(effect)\" is kept as it was drawn.").font(.caption).foregroundStyle(.secondary)
            } else if let d = description {
                let presets = (d.json["presets"]?.arrayValue ?? []).compactMap(\.objectValue)
                if !presets.isEmpty {
                    Menu("Presets") {
                        ForEach(Array(presets.enumerated()), id: \.offset) { _, p in
                            Button(p["name"]?.stringValue ?? "Preset") { apply(p["values"]?.objectValue ?? [:]) }
                        }
                    }
                    .controlSize(.small)
                }
                ForEach(d.controlNames, id: \.self) { name in control(d, name) }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .font(.caption)
        .task(id: effect) { description = await model.describeProviderEffect(effect) }
    }

    @ViewBuilder
    private func control(_ d: EffectDescription, _ name: String) -> some View {
        let schema = d.controls["properties"]?.objectValue?[name]?.objectValue ?? [:]
        let value = values[name] ?? d.defaults[name]
        let label = effectControlLabel(name, schema)
        if let options = schema["enum"]?.arrayValue?.compactMap(\.stringValue), !options.isEmpty {
            PaintPickerRow(label: label, selection: Binding(get: { value?.stringValue ?? options[0] }, set: { apply([name: .string($0)]) })) {
                ForEach(options, id: \.self) { Text(humanizeParameterId($0)).tag($0) }
            }
        } else if schema["type"]?.stringValue == "number" || schema["type"]?.stringValue == "integer", let min = schema["minimum"]?.numberValue, let max = schema["maximum"]?.numberValue, max > min {
            let step = schema["type"]?.stringValue == "integer" ? 1 : (max - min) / 100
            PaintSliderRow(label: label, value: value?.numberValue ?? min, range: min...max, step: step, onCommit: { apply([name: .number($0)]) })
        } else if schema["type"]?.stringValue == "boolean" {
            Toggle(label, isOn: Binding(get: { value?.boolValue ?? false }, set: { apply([name: .bool($0)]) }))
        } else if schema["type"]?.stringValue == "string", schema["pattern"]?.stringValue?.contains("#") == true {
            HexColorPicker(label: label, hex: value?.stringValue ?? "#000000") { apply([name: .string($0)]) }
        }
    }
}

/// The effect paper: remove, opacity, blend and its controls.
private struct PaperEffectSection: View {
    let model: PaintEditorModel
    let paper: PaintPaperEffect

    var body: some View {
        EffectPart {
            HStack {
                Text("Paper: \(paper.source.name ?? paper.source.effect)").lineLimit(1)
                Spacer()
                Button { Task { await model.removePaperEffect() } } label: { Image(systemName: "xmark.circle") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove the effect paper")
            }
            PaintSliderRow(label: "Opacity", value: paper.opacity, range: 0...1, step: 0.01, displayScale: 100, unit: "%", onCommit: { o in Task { await model.updatePaperEffect(opacity: o) } })
            PaintPickerRow(label: "Blend", selection: Binding(get: { paper.blend }, set: { b in Task { await model.updatePaperEffect(blend: b) } })) {
                ForEach(PAPER_EFFECT_BLENDS, id: \.self) { Text(humanizeParameterId($0)).tag($0) }
            }
            .font(.caption)
            EffectValuesView(model: model, effect: paper.source.effect, values: paper.source.values) { v in Task { await model.updatePaperEffect(values: v) } }
        }
    }
}

/// The effect paint: stop, where it follows (the canvas, each stroke, the effect's own path), live, and its controls.
private struct EffectPaintSection: View {
    let model: PaintEditorModel
    let paint: PaintEffectPaint
    @State private var name: String?
    @State private var hasPathControl = false
    @State private var length = ""

    var body: some View {
        EffectPart {
            HStack {
                Text("Paint: \(name ?? paint.effect)").lineLimit(1)
                if model.effectPaintRendering { ProgressView().controlSize(.mini).accessibilityLabel("Rendering the effect paint") }
                Spacer()
                Button { model.stopEffectPaint() } label: { Image(systemName: "xmark.circle") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop painting with the effect")
            }
            HStack(spacing: 8) {
                Text("Follows").foregroundStyle(.secondary).fixedSize()
                Picker("Follows", selection: Binding(get: { paint.map?.by ?? "canvas" }, set: { by in
                    let map: JSONValue = by == "stroke" ? PaintEffectStrokeMap().json : by == "path" ? PaintEffectStrokeMap(by: "path").json : .string("canvas")
                    Task { await model.repaintEffect(map: map) }
                })) {
                    Text("Canvas").tag("canvas")
                    Text("Stroke").tag("stroke")
                    if hasPathControl || paint.map?.by == "path" { Text("Path").tag("path") }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .help("Fix the effect to the canvas, lay it along each stroke, or pass each stroke to the effect's own path control")
            }
            if let map = paint.map, map.by == "stroke" {
                HStack(spacing: 8) {
                    Text("Length").foregroundStyle(.secondary).fixedSize()
                    Spacer(minLength: 0)
                    TextField("Length", text: $length)
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 64)
                        .accessibilityLabel("Effect length along the stroke")
                        .onSubmit {
                            if let n = Int(length), n != map.length { Task { await model.repaintEffect(map: PaintEffectStrokeMap(length: n, repeatMode: map.repeatMode, width: map.width).json) } }
                        }
                }
                .onAppear { length = String(map.length) }
                .onChange(of: map.length) { _, n in length = String(n) }
                PaintPickerRow(label: "At the end", selection: Binding(get: { map.repeatMode }, set: { r in
                    Task { await model.repaintEffect(map: PaintEffectStrokeMap(length: map.length, repeatMode: r, width: map.width).json) }
                })) {
                    Text("Repeat").tag("repeat")
                    Text("Mirror").tag("mirror")
                    Text("Clamp").tag("clamp")
                }
            }
            Toggle("Live", isOn: Binding(get: { paint.live }, set: { on in Task { await model.repaintEffect(live: on) } }))
                .help("Strokes on a stroke layer keep playing the effect")
            EffectValuesView(model: model, effect: paint.effect, values: paint.values) { v in Task { await model.repaintEffect(values: v) } }
        }
        .font(.caption)
        .task(id: paint.effect) {
            let description = await model.describeProviderEffect(paint.effect)
            name = description?.name
            hasPathControl = description.map { !pathControlsOf($0).isEmpty } ?? false
        }
    }
}

/// Live effect playback: how many strokes play, play / pause and the frame rate cap.
private struct EffectPlaybackSection: View {
    let model: PaintEditorModel
    let animation: PaintLiveAnimation

    var body: some View {
        let playback = model.effectPlayback
        EffectPart {
            HStack {
                Text("Live paint: \(animation.strokes) \(animation.strokes == 1 ? "stroke" : "strokes")")
                Spacer()
                Button(playback.playing ? "Pause" : "Play") { model.setEffectPlayback(playing: !playback.playing) }
                    .accessibilityValue(playback.playing ? "Playing" : "Paused")
            }
            Stepper("\(playback.fps) fps", value: Binding(get: { playback.fps }, set: { model.setEffectPlayback(fps: $0) }), in: 1...60)
                .accessibilityLabel("Live paint frame rate")
        }
        .font(.caption)
    }
}

/// The active effect layer: rasterize, and its controls.
private struct EffectLayerSection: View {
    let model: PaintEditorModel
    let source: PaintEffectSource

    var body: some View {
        EffectPart {
            HStack {
                Text("Layer: \(source.name ?? source.effect)").lineLimit(1)
                Spacer()
                Button("Rasterize") { model.rasterizeEffectLayer() }.help("Keep the pixels as a plain layer")
            }
            EffectValuesView(model: model, effect: source.effect, values: source.values) { v in Task { await model.updateEffectLayer(values: v) } }
        }
        .font(.caption)
    }
}
