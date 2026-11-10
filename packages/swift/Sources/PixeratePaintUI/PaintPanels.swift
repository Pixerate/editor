import CoreGraphics
import PixerateCore
import PixeratePaint
import PixerateRaster
import SwiftUI

// MARK: - Shared controls

/**
 * A labelled slider (`PaintSlider`). `onChange` runs while dragging; `onCommit` (if given) runs
 * once on release, for settings that are undo steps, and the slider shows its draft meanwhile.
 */
public struct PaintSliderRow: View {
    let label: String
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    /// Shown value = value × scale (percent controls).
    var displayScale: Double = 1
    var unit: String = ""
    var onChange: ((Double) -> Void)?
    var onCommit: ((Double) -> Void)?
    @State private var draft: Double?

    public init(label: String, value: Double, range: ClosedRange<Double>, step: Double, displayScale: Double = 1, unit: String = "", onChange: ((Double) -> Void)? = nil, onCommit: ((Double) -> Void)? = nil) {
        self.label = label
        self.value = value
        self.range = range
        self.step = step
        self.displayScale = displayScale
        self.unit = unit
        self.onChange = onChange
        self.onCommit = onCommit
    }

    private func text(_ v: Double) -> String {
        let shown = v * displayScale
        let digits = step * displayScale >= 1 ? 0 : 2
        return String(format: "%.\(digits)f", shown) + (unit.isEmpty ? "" : " \(unit)")
    }

    public var body: some View {
        let shown = draft ?? value
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label).foregroundStyle(.secondary)
                Spacer()
                Text(text(shown)).monospacedDigit()
            }
            .font(.caption)
            Slider(
                value: Binding(get: { Swift.min(range.upperBound, Swift.max(range.lowerBound, shown)) }, set: { v in
                    if onCommit != nil { draft = v }
                    onChange?(v)
                }),
                in: range,
                step: step,
                onEditingChanged: { editing in
                    if !editing, let d = draft {
                        onCommit?(d)
                        draft = nil
                    }
                }
            )
            .accessibilityLabel(label)
            .controlSize(.small)
        }
    }
}

/// A `#rrggbb` string from a CGColor (converted to sRGB).
func hexOf(_ c: CGColor) -> String? {
    guard let srgb = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil), let comps = srgb.components, comps.count >= 3 else { return nil }
    let v = comps.prefix(3).map { Int((Swift.min(1, Swift.max(0, $0)) * 255).rounded()) }
    return String(format: "#%02x%02x%02x", v[0], v[1], v[2])
}

/// A CGColor for `#rrggbb`.
func cgColor(_ hex: String) -> CGColor {
    let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    let v = UInt32(s.prefix(6), radix: 16) ?? 0
    return CGColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}

/// A colour well that sets a `#rrggbb` value.
struct HexColorPicker: View {
    let label: String
    let hex: String
    let onChange: (String) -> Void

    var body: some View {
        ColorPicker(label, selection: Binding(get: { cgColor(hex) }, set: { c in if let h = hexOf(c), h != hex { onChange(h) } }), supportsOpacity: false)
    }
}

/// A section heading.
struct PanelHeading: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
    }
}

/// The blend menu (`PaintUITables.blendMenu`) as a picker with a section per group.
struct BlendMenuPicker: View {
    let label: String
    let groups: [PaintUIBlendMenuItem]
    let value: String
    var passThrough = false
    let onChange: (String) -> Void

    var body: some View {
        Picker(label, selection: Binding(get: { value }, set: { onChange($0) })) {
            if passThrough { Text("Pass through").tag("pass-through") }
            ForEach(groups, id: \.label) { g in
                Section(g.label) {
                    ForEach(g.modes, id: \.id) { m in Text(m.label).tag(m.id).help(m.description ?? "") }
                }
            }
        }
    }
}

// MARK: - Toolbar

/// A stencil a toolbar lays with one click, centred on the canvas (`quickStencil`).
public func quickStencil(_ kind: String, _ canvas: PaintCanvas) -> JSONObject {
    let w = Double(canvas.width), h = Double(canvas.height)
    func pt(_ x: Double, _ y: Double) -> JSONValue { ["x": .number(x), "y": .number(y)] }
    switch kind {
    case "ruler": return ["kind": "ruler", "from": pt(w * 0.1, h / 2), "to": pt(w * 0.9, h / 2)]
    case "circle": return ["kind": "arc", "center": pt(w / 2, h / 2), "radius": .number(Swift.min(w, h) * 0.3)]
    case "ellipse-mask": return ["kind": "shape", "shape": "ellipse", "rect": ["x": .number(w * 0.2), "y": .number(h * 0.2), "width": .number(w * 0.6), "height": .number(h * 0.6)]]
    default: return ["kind": "line", "from": pt(w / 2, 0), "to": pt(w / 2, h)]
    }
}

/**
 * Tools (from `PaintUITables.tools`, the ones this port handles), undo / redo, view rotation,
 * mirroring, reset and fit, the symmetry and perspective guides, stencils and the drawing hand
 * (`PaintToolbar`).
 */
public struct PaintToolbarView: View {
    let model: PaintEditorModel
    @State private var exportFile: PaintExportFile?
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let guides = model.guides
        let canvas = model.canvas
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Picker("Tool", selection: Binding(get: { model.tool }, set: { model.tool = $0 })) {
                    ForEach(model.toolRows, id: \.id) { t in Text(t.label).tag(t.id).help("\(t.label) (\(t.key.uppercased()))") }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                if model.tool == "fill" {
                    Divider().frame(height: 16)
                    Picker("Fill reference", selection: Binding(get: { model.fillOptions.reference }, set: { model.fillOptions.reference = $0 })) {
                        Text("All layers").tag("all")
                        Text("Active layer").tag("layer")
                        ForEach(model.layers.filter { $0.type == "pixel" }, id: \.id) { l in Text("Ref: \(l.name)").tag(l.id) }
                    }
                    .fixedSize()
                    Stepper("Tol \(Int(model.fillOptions.tolerance))", value: Binding(get: { model.fillOptions.tolerance }, set: { model.fillOptions.tolerance = $0 }), in: 0...255, step: 4)
                        .fixedSize()
                    Stepper("Gap \(Int(model.fillOptions.closeGap))px", value: Binding(get: { model.fillOptions.closeGap }, set: { model.fillOptions.closeGap = $0 }), in: 0...32, step: 1)
                        .fixedSize()
                    Stepper("Expand \(Int(model.fillOptions.expand))px", value: Binding(get: { model.fillOptions.expand }, set: { model.fillOptions.expand = $0 }), in: -16...16, step: 1)
                        .fixedSize()
                    Toggle("Wet", isOn: Binding(get: { model.fillOptions.wet }, set: { model.fillOptions.wet = $0 })).toggleStyle(.button)
                }
                Divider().frame(height: 16)
                Button("Undo") { model.undo() }.disabled(model.undoLabel == nil).help(model.undoLabel.map { "Undo \($0)" } ?? "Undo")
                Button("Redo") { model.redo() }.disabled(model.redoLabel == nil).help(model.redoLabel.map { "Redo \($0)" } ?? "Redo")
                Divider().frame(height: 16)
                Button { model.rotateView(by: -15) } label: { Image(systemName: "rotate.left") }.accessibilityLabel("Rotate view left")
                Button { model.rotateView(by: 15) } label: { Image(systemName: "rotate.right") }.accessibilityLabel("Rotate view right")
                Toggle("Mirror view", isOn: Binding(get: { model.view.mirror }, set: { _ in model.toggleMirror() })).toggleStyle(.button)
                Button("Fit") { model.fitView() }
                Button("Reset view") { model.resetView() }
                Divider().frame(height: 16)
                Picker("Symmetry", selection: Binding(get: { guides.symmetry.mode }, set: { model.setSymmetry($0) })) {
                    ForEach(SYMMETRY_MODES, id: \.self) { Text($0).tag($0) }
                }
                .fixedSize()
                Toggle("Perspective", isOn: Binding(get: { guides.perspective.enabled }, set: { on in
                    model.attempt { _ = try model.controller.setPerspective(on ? ["enabled": true, "points": guides.perspective.points.isEmpty ? [["x": .number(Double(canvas.width) / 2), "y": .number(Double(canvas.height) * 0.4)]] : .array(guides.perspective.points.map { ["x": .number($0.x), "y": .number($0.y)] })] : ["enabled": false]) }
                }))
                .toggleStyle(.button)
                Menu("Stencils") {
                    Button("Ruler") { model.attempt { _ = try model.controller.addStencil(quickStencil("ruler", canvas)) } }
                    Button("Circle") { model.attempt { _ = try model.controller.addStencil(quickStencil("circle", canvas)) } }
                    Button("Mask") { model.attempt { _ = try model.controller.addStencil(quickStencil("ellipse-mask", canvas)) } }
                    if !guides.stencils.isEmpty { Button("Clear stencils") { model.attempt { _ = try model.controller.removeStencils(nil) } } }
                }
                .fixedSize()
                Button(model.hand == "right" ? "Right-handed" : "Left-handed") { model.toggleHand() }.help("Which hand holds the pen (palm rejection)")
                Divider().frame(height: 16)
                Menu("Export") {
                    Button("PNG image…") { Task { exportFile = await model.exportFile(.png) } }
                    Button("PNG at 2× (repainted)…") { Task { exportFile = await model.exportFile(.png, scale: 2) } }
                    Button("Photoshop (PSD)…") { Task { exportFile = await model.exportFile(.psd) } }
                }
                .fixedSize()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .controlSize(.small)
        .fileExporter(
            isPresented: Binding(get: { exportFile != nil }, set: { if !$0 { exportFile = nil } }),
            document: exportFile, contentType: exportFile?.format.contentType ?? .png,
            defaultFilename: "Painting.\(exportFile?.format.rawValue ?? "png")"
        ) { result in
            if case .failure(let e) = result { model.error = e.localizedDescription }
            exportFile = nil
        }
    }
}

// MARK: - Brush

/**
 * The brushes this port paints with, by category, and the active brush's options from
 * `PaintUITables.brushOptions` (size, hardness, opacity, flow, smoothing); what a paint-carrying
 * brush holds, with Load and Clean; and "Keep my colour" (`BrushPanel`).
 */
public struct PaintBrushPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let brush = model.brush
        let brushes = model.brushes
        let categories = brushes.reduce(into: [String]()) { if !$0.contains($1.category) { $0.append($1.category) } }
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("Brush")
            Picker("Brush", selection: Binding(get: { brush.id }, set: { model.selectBrush($0) })) {
                if !brushes.contains(where: { $0.id == brush.id }) { Text(brush.name).tag(brush.id) }
                ForEach(categories, id: \.self) { cat in
                    Section(cat.capitalized) {
                        ForEach(brushes.filter { $0.category == cat }, id: \.id) { b in Text(b.name).tag(b.id) }
                    }
                }
            }
            .labelsHidden()
            ForEach(model.tables.brushOptions, id: \.id) { item in
                PaintSliderRow(label: item.label, value: model.brushOption(item), range: item.min...item.max, step: item.step, displayScale: item.displayScale ?? 1, unit: item.unit) { model.setBrushOption(item, $0) }
            }
            if brush.ghost != nil {
                ForEach(model.ghostSliders, id: \.path) { item in
                    PaintSliderRow(label: item.label, value: model.ghostValue(item.path), range: item.min...item.max, step: item.step) { model.setGhostValue(item.path, $0) }
                }
            }
            if brush.mutation != nil {
                ForEach(model.mutationSliders, id: \.path) { item in
                    PaintSliderRow(label: item.label, value: model.mutationValue(item.path), range: item.min...item.max, step: item.step) { model.setMutationValue(item.path, $0) }
                }
                Text(model.hasMutationAgent ? "Agent connected" : "No agent connected — mutation paint will stay as ordinary paint")
                    .font(.caption2)
                    .foregroundStyle(model.hasMutationAgent ? Color.secondary : Color.orange)
            }
            if brush.engine == "antimatter" {
                Picker("Invert colours in", selection: Binding(get: { model.antimatterInvertMode }, set: { model.setAntimatterInvertMode($0) })) {
                    Text(model.tables.labels.invertModes.rgb).tag("rgb")
                    Text(model.tables.labels.invertModes.oklab).tag("oklab")
                }
                .font(.caption)
                ForEach(model.antimatterSliders, id: \.path) { item in
                    PaintSliderRow(label: item.label, value: model.antimatterValue(item.path), range: item.min...item.max, step: item.step) { model.setAntimatterValue(item.path, $0) }
                }
            }
            if brush.engine == "mixer" || brush.behavior.dirty {
                HStack(spacing: 6) {
                    Text("Carries").foregroundStyle(.secondary)
                    RoundedRectangle(cornerRadius: 3).fill(carried.map { Color(hex: $0) } ?? .clear).frame(width: 16, height: 16).overlay(RoundedRectangle(cornerRadius: 3).stroke(.secondary)).accessibilityLabel("Brush load")
                    if brush.engine == "mixer" { Button("Load") { model.attempt { _ = try model.controller.loadMixerBrush() } } }
                    Button("Clean") { _ = model.controller.cleanMixerBrush(brush.engine == "mixer") }
                }
                .font(.caption)
            }
            Toggle("Keep my colour when choosing a brush", isOn: Binding(get: { model.colorLocked }, set: { model.setColorLocked($0) })).font(.caption)
        }
    }

    /// What the brush carries (picked-up paint, else loaded paint) as #rrggbb (`brushLoadColor`).
    private var carried: String? {
        _ = model.revision
        let load = model.controller.mixerLoad
        guard let c = load.pickup ?? load.reservoir else { return nil }
        let v = c.prefix(3).map { Int(($0 * 255).rounded()) }
        return String(format: "#%02x%02x%02x", v[0], v[1], v[2])
    }
}

// MARK: - Colour

/// The paint and second colours, hex entry, swap, and the swatches (`ColorPanel`).
public struct PaintColorPanel: View {
    let model: PaintEditorModel
    @State private var hexDraft = ""
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let color = model.color
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("Colour")
            HexColorPicker(label: "Paint colour", hex: color) { model.setColor($0) }
            HexColorPicker(label: "Second colour", hex: model.secondaryColor) { model.setSecondaryColor($0) }
            HStack {
                TextField("Hex colour", text: $hexDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .onSubmit { model.setColor(hexDraft.hasPrefix("#") ? hexDraft : "#\(hexDraft)") }
                    .onAppear { hexDraft = color }
                    .onChange(of: color) { _, c in hexDraft = c }
                Button("Swap") { model.swapColors() }.help("Swap colours (X)")
            }
            PanelHeading("Swatches")
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(22), spacing: 4), count: 8), alignment: .leading, spacing: 4) {
                ForEach(Array(model.swatches.enumerated()), id: \.offset) { i, s in
                    Button { model.setColor(s.color) } label: {
                        RoundedRectangle(cornerRadius: 3).fill(Color(hex: s.color)).frame(width: 22, height: 22)
                            .overlay(RoundedRectangle(cornerRadius: 3).stroke(s.color == color ? Color.primary : Color.secondary.opacity(0.4), lineWidth: s.color == color ? 2 : 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Paint with \(s.name ?? s.color)")
                    .contextMenu { Button("Remove swatch") { model.removeSwatch(i) } }
                }
                Button { model.addSwatch() } label: { Image(systemName: "plus").frame(width: 22, height: 22) }.buttonStyle(.plain).accessibilityLabel("Add the paint colour as a swatch")
            }
        }
    }
}

// MARK: - Paper

/**
 * The paper library by family, the paper's colour, the grain sliders this port draws (from
 * `PaintUITables.sliders.paper`; each change one undo step, committed on release), mirror tiling
 * and a new sheet (`PaperPanel`).
 */
public struct PaintPaperPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let paper = model.paper
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("Paper")
            Picker("Paper", selection: Binding(get: { paper.preset }, set: { model.setPaperPreset($0) })) {
                ForEach(PAPER_FAMILIES, id: \.self) { family in
                    Section(family.capitalized) {
                        ForEach(PAPER_LIBRARY.filter { $0.family == family }, id: \.preset) { p in Text(p.name).tag(p.preset) }
                    }
                }
            }
            .labelsHidden()
            HexColorPicker(label: "Paper colour", hex: paper.color) { model.setPaperColor($0) }
            ForEach(model.paperSliders, id: \.path) { c in
                PaintSliderRow(label: c.label, value: model.paperValue(c.path), range: c.min...c.max, step: c.step, onCommit: { model.setPaperValue(c.path, $0) })
            }
            Toggle("Mirror tiling", isOn: Binding(get: { paper.tiling == "mirror" }, set: { on in model.attempt { _ = try model.controller.setPaper(["tiling": .string(on ? "mirror" : "repeat")]) } }))
            Button("New sheet") { model.newSheet() }
            PaintLightPanel(model: model)
            PaintUvHeatPanel(model: model)
            PaintFerroPanel(model: model)
        }
    }
}

/// Ferrofluid & magnets (`FerroPanel`): add/adjust/remove magnets on the canvas, inspect active spike stats, and cure liquid ferrofluid into permanent impasto relief.
public struct PaintFerroPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let magnets = model.magnets
        let ferro = model.ferrofluid
        let hasFerro = ferro?["ferro"] == .bool(true)
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("Ferrofluid & magnets")
            HStack(spacing: 4) {
                Button("Add magnet") { model.addMagnet() }
                if !magnets.isEmpty {
                    Button("Clear magnets") { model.removeMagnets() }
                }
                Button("Cure ferrofluid") { model.cureFerrofluid() }.disabled(!hasFerro)
            }
            .controlSize(.small)
            if hasFerro, let ferro {
                let spikes = Int(ferro["activeSpikeArea"]?.numberValue ?? 0)
                let maxH = Int(ferro["maxSpikeHeight"]?.numberValue ?? 0)
                Text("Liquid ferrofluid · \(spikes) spike px (max \(maxH))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            ForEach(magnets, id: \.id) { m in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("\(m.id) (\(Int(m.x.rounded())), \(Int(m.y.rounded())))").font(.caption).bold()
                        Spacer()
                        Button { model.removeMagnets([m.id]) } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove magnet \(m.id)")
                    }
                    PaintSliderRow(label: "Strength", value: m.strength, range: -1...1, step: 0.05, onCommit: { model.updateMagnet(m.id, strength: $0) })
                    PaintSliderRow(label: "Radius", value: m.radius, range: 8...400, step: 4, unit: "px", onCommit: { model.updateMagnet(m.id, radius: $0) })
                }
            }
        }
    }
}

/// The virtual UV blacklight and thermochromic heat controls (`PaperPanel`'s UV & heat section).
public struct PaintUvHeatPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let uv = model.uvLight
        let heat = model.heatSummary
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("UV blacklight & heat")
            Toggle("UV blacklight", isOn: Binding(get: { uv.on }, set: { model.setUvLight(on: $0) }))
            if uv.on {
                PaintSliderRow(label: "UV strength", value: uv.strength, range: 0...2, step: 0.05, onChange: { model.setUvLight(strength: $0) })
                PaintSliderRow(label: "UV ambient", value: uv.ambient, range: 0...1, step: 0.05, onChange: { model.setUvLight(ambient: $0) })
            }
            HStack(spacing: 4) {
                Button("Spread & cool heat") { model.advanceHeat() }.disabled(heat.hotCells == 0)
                Button("Cool canvas") { model.clearHeat() }.disabled(heat.hotCells == 0)
            }
            .controlSize(.small)
        }
    }
}

/// The light for thick paint, thin-film iridescence and metallic paper (`PaintUITables.sliders.light`, `sliders.viewTilt`; not an undo step), and Flatten relief for the active layer.
public struct PaintLightPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("Light (thick paint, metallic paper)")
            ForEach(model.lightSliders, id: \.path) { c in
                PaintSliderRow(label: c.label, value: model.lightingValue(c.path), range: c.min...c.max, step: c.step, onChange: { model.setLighting(c.path, $0) })
            }
            ForEach(model.viewTiltSliders, id: \.path) { c in
                PaintSliderRow(label: c.label, value: model.viewTiltValue(c.path), range: c.min...c.max, step: c.step, onChange: { model.setViewTilt(c.path, $0) })
            }
            Toggle("Device tilt", isOn: Binding(get: { model.deviceTiltEnabled }, set: { model.deviceTiltEnabled = $0 }))
            Button("Flatten relief") { model.flattenRelief() }
        }
    }
}

/// Light paint on the active layer: how far and how strongly its light spills, and Clear light (`PaintLayersPanel`'s light row).
public struct PaintLightSpillPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        if let light = model.activeLight, light.hasLight {
            VStack(alignment: .leading, spacing: 8) {
                PanelHeading("Light paint")
                PaintSliderRow(label: "Light spill radius", value: light.radius, range: 0...120, step: 1, unit: "px", onChange: { model.setLightSpill(radius: $0) })
                PaintSliderRow(label: "Light spill strength", value: light.strength, range: 0...2, step: 0.05, onChange: { model.setLightSpill(strength: $0) })
                Button("Clear light") { model.clearLight() }
            }
        }
    }
}

// MARK: - Wet paint

/**
 * Wet media (`WetPanel`): whether paint is wet, Dry now, Pause / Resume, the water overlay,
 * instant dry and Wet paper; the speed and canvas tilt (`sliders.wetSpeed`, `sliders.wetTilt`);
 * the active layer's wet settings (`sliders.wet`) and flow map; and the engine (`wetGpu`: this port
 * runs the CPU engine whichever is chosen).
 */
public struct PaintWetPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let wet = model.wet
        let isWet = wet.isWet()
        let layer = model.wetLayerSettings
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                PanelHeading("Wet paint")
                Spacer()
                Text(isWet ? (wet.paused ? "Wet (paused)" : "Wet") : "Dry").font(.caption).foregroundStyle(isWet ? .blue : .secondary)
                WetStepLabel(model: model)
            }
            HStack(spacing: 4) {
                Button("Dry now") { model.dryNow() }.disabled(wet.wetLayerIds().isEmpty)
                Button(wet.paused ? "Resume" : "Pause") { model.toggleWetPaused() }
                Button("Wet paper") { model.wetPaper() }.disabled(layer == nil)
            }
            Toggle("Show water", isOn: Binding(get: { wet.overlay }, set: { _ in model.toggleWaterOverlay() }))
            Toggle("Instant dry", isOn: Binding(get: { wet.instantDry }, set: { _ in model.toggleInstantDry() })).help("Each wet stroke dries as soon as it ends")
            let s = model.wetSpeedSlider
            PaintSliderRow(label: s.label, value: wet.speed, range: s.min...s.max, step: s.step, onChange: { model.setWetSpeed($0) })
            ForEach(model.wetTiltSliders, id: \.path) { c in
                PaintSliderRow(label: c.label, value: model.tiltValue(c.path), range: c.min...c.max, step: c.step, onCommit: { model.setTilt(c.path, $0) })
            }
            if let layer {
                PanelHeading("This layer")
                ForEach(model.wetSliders, id: \.path) { c in
                    PaintSliderRow(label: c.label, value: model.wetParam(c.path), range: c.min...c.max, step: c.step, onCommit: { model.setWetParam(c.path, $0) })
                }
                Picker("Flow map", selection: Binding(get: { layer.flow.kind }, set: { model.setFlowKind($0) })) {
                    ForEach(WET_FLOW_LABELS, id: \.kind) { Text($0.label).tag($0.kind) }
                }
                if layer.flow.kind != "none" {
                    PaintSliderRow(label: "Flow strength", value: layer.flow.strength, range: 0...1, step: 0.01, onCommit: { model.setFlowStrength($0) })
                }
                let lp = model.livePatterns
                Picker("Live patterns", selection: Binding(get: { lp?.pattern ?? "none" }, set: { model.setLivePatternKind($0) })) {
                    ForEach(WET_LIVE_PATTERN_LABELS, id: \.kind) { Text($0.label).tag($0.kind) }
                }
                if let lp {
                    ForEach(model.livePatternSliders, id: \.path) { c in
                        PaintSliderRow(label: c.label, value: model.livePatternParam(c.path), range: c.min...c.max, step: c.step, onCommit: { model.setLivePatternParam(c.path, $0) })
                    }
                    HStack(spacing: 4) {
                        HexColorPicker(label: "2nd colour", hex: lp.secondColor ?? "#2563eb", onChange: { model.setLivePatternSecondColor($0) })
                        if lp.secondColor != nil {
                            Button("Clear") { model.setLivePatternSecondColor(nil) }
                        }
                        Spacer()
                        Button("Seed") { model.seedLivePattern() }
                    }
                }
            }
            Picker("Engine", selection: Binding(get: { wet.gpuMode }, set: { model.setWetEngine($0) })) {
                ForEach(model.wetGpuOptions, id: \.value) { Text($0.label).tag($0.value) }
            }
            Text(model.wetEngineSummary).font(.caption2).foregroundStyle(.secondary)
        }
    }
}

private struct WetStepLabel: View {
    let model: PaintEditorModel
    var body: some View {
        Text("step \(model.wetClock)").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
    }
}

// MARK: - Layers

/**
 * The layer stack, top first: visibility, names, the active layer's opacity (one undo step on
 * release), blend mode (`PaintUITables.blendMenu`), locks and clipping; new layer, group or
 * stroke layer, duplicate, move up / down, merge down and delete (`PaintLayersPanel`).
 */
public struct PaintLayersPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        let layers = model.layers
        let active = layers.first(where: \.active)
        VStack(alignment: .leading, spacing: 8) {
            PanelHeading("Layers")
            HStack(spacing: 4) {
                Menu("New") {
                    Button("Layer") { model.addLayer() }
                    Button("Group") { model.addLayer(type: "group") }
                    Button("Stroke layer") { model.addLayer(type: "strokes") }.help("A layer whose strokes stay editable")
                }
                .fixedSize()
                Button("Duplicate") { model.duplicateLayer() }.disabled(active == nil)
                Button { model.moveLayer(1) } label: { Image(systemName: "arrow.up") }.disabled(active == nil).accessibilityLabel("Move layer up")
                Button { model.moveLayer(-1) } label: { Image(systemName: "arrow.down") }.disabled(active == nil).accessibilityLabel("Move layer down")
                Button("Merge down") { model.mergeDown() }.disabled(active == nil)
                Button { model.removeLayer() } label: { Image(systemName: "trash") }.disabled(active == nil || layers.count < 2).accessibilityLabel("Delete layer")
            }
            .controlSize(.small)
            VStack(spacing: 2) {
                ForEach(layers, id: \.id) { l in
                    HStack(spacing: 6) {
                        Button { model.toggleVisible(l) } label: { Image(systemName: l.visible ? "eye" : "eye.slash") }
                            .buttonStyle(.plain)
                            .accessibilityLabel(l.visible ? "Hide \(l.name)" : "Show \(l.name)")
                        if l.type == "group" { Image(systemName: "folder") }
                        if l.liveStrokes != nil { Image(systemName: "scribble").help("Stroke layer: \(l.liveStrokes!) editable strokes") }
                        Text(l.name).lineLimit(1)
                        if l.temporary == true {
                            Text("Temporary").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if l.locks["pixels"] == .bool(true) || l.locks["all"] == .bool(true) { Image(systemName: "lock.fill").help("Locked") }
                    }
                    .padding(.vertical, 3)
                    .padding(.horizontal, 6)
                    .padding(.leading, CGFloat(l.depth) * 12)
                    .background(RoundedRectangle(cornerRadius: 4).fill(l.active ? Color.accentColor.opacity(0.25) : .clear))
                    .contentShape(Rectangle())
                    .onTapGesture { model.setActiveLayer(l.id) }
                    .accessibilityAddTraits(l.active ? .isSelected : [])
                }
            }
            if let a = active {
                PaintSliderRow(label: "Opacity", value: a.opacity, range: 0...1, step: 0.01, displayScale: 100, unit: "%", onCommit: { v in model.updateLayer(a.id, ["opacity": .number(v)]) })
                BlendMenuPicker(label: "Blend", groups: model.tables.blendMenu, value: a.blend, passThrough: a.type == "group") { model.updateLayer(a.id, ["blend": .string($0)]) }
                HStack(spacing: 4) {
                    ForEach(["pixels", "transparency"], id: \.self) { k in
                        Toggle(k == "pixels" ? "Lock pixels" : "Lock transparency", isOn: Binding(get: { a.locks[k] == .bool(true) }, set: { on in model.updateLayer(a.id, ["locks": [k: .bool(on)]]) })).toggleStyle(.button)
                    }
                    Toggle("Clip", isOn: Binding(get: { a.clipped }, set: { model.updateLayer(a.id, ["clipped": .bool($0)]) })).toggleStyle(.button)
                }
                .controlSize(.small)
            }
        }
    }
}

/**
 * The active stroke layer's strokes: pick one (here or with the Select stroke tool) to change its
 * brush, the sliders of `PaintUITables.sliders.stroke`, its colour or seed, move it up or down, or
 * delete it; or rasterize the layer. Shows nothing for other layers (`StrokePanel`).
 */
public struct PaintStrokePanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        if let strokes = model.liveStrokes {
            let index = strokes.firstIndex { $0.id == model.selectedStroke }
            let sel = index.map { strokes[$0] }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    PanelHeading("Strokes (\(strokes.count))")
                    Spacer()
                    Button("Rasterize") { model.rasterizeStrokes() }.controlSize(.small)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(18), spacing: 4), count: 10), alignment: .leading, spacing: 4) {
                    ForEach(Array(strokes.enumerated()), id: \.element.id) { i, s in
                        Button { model.selectedStroke = s.id } label: {
                            RoundedRectangle(cornerRadius: 3).fill(Color(hex: s.color)).frame(width: 18, height: 18)
                                .overlay(RoundedRectangle(cornerRadius: 3).stroke(s.id == model.selectedStroke ? Color.accentColor : .secondary, lineWidth: s.id == model.selectedStroke ? 2 : 1))
                        }
                        .buttonStyle(.plain)
                        .help("\(i + 1). \(s.brush.name) (\(s.id))")
                    }
                }
                if let sel, let index {
                    Picker("Brush", selection: Binding(get: { sel.brush.id }, set: { model.updateSelectedStroke(brushId: $0) })) {
                        let brushes = model.brushes
                        if !brushes.contains(where: { $0.id == sel.brush.id }) { Text(sel.brush.name).tag(sel.brush.id) }
                        ForEach(brushes, id: \.id) { b in Text(b.name).tag(b.id) }
                    }
                    ForEach(model.tables.sliders.stroke, id: \.path) { c in
                        PaintSliderRow(label: c.label, value: strokeSliderValue(sel.brush, c.path), range: c.min...c.max, step: c.step, onCommit: { v in model.updateSelectedStroke(brushChanges: patchPath([:], c.path, .number(v))) })
                    }
                    HexColorPicker(label: "Stroke colour", hex: sel.color) { model.updateSelectedStroke(color: $0) }
                    HStack(spacing: 4) {
                        Button("New seed") { model.updateSelectedStroke(seed: Double((sel.seed + 1) % 2_147_483_647)) }
                        Button { model.reorderSelectedStroke(index + 1) } label: { Image(systemName: "arrow.up") }.disabled(index == strokes.count - 1).accessibilityLabel("Move stroke up")
                        Button { model.reorderSelectedStroke(index - 1) } label: { Image(systemName: "arrow.down") }.disabled(index == 0).accessibilityLabel("Move stroke down")
                        Button("Delete") { model.removeSelectedStroke() }
                    }
                    .controlSize(.small)
                }
            }
        }
    }
}

// MARK: - Layer styles

/**
 * The active layer's layer styles: the master switch, each style (on / off, remove), a menu of
 * the kinds in `PaintUITables.layerEffects` to add, and the picked style's controls
 * (`layerEffectControls`, the generator of the table's rows; each change one undo step).
 */
public struct PaintEffectsPanel: View {
    let model: PaintEditorModel
    public init(model: PaintEditorModel) { self.model = model }

    public var body: some View {
        if let layer = model.activeLayer {
            let fx = model.layerEffects ?? LayerEffects(enabled: true, items: [])
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    PanelHeading("Layer style")
                    Spacer()
                    Toggle("On", isOn: Binding(get: { fx.enabled }, set: { model.setEffectsEnabled($0) })).toggleStyle(.switch).controlSize(.mini)
                }
                Menu("Add style") {
                    ForEach(model.tables.layerEffects, id: \.kind) { e in Button(e.label) { model.addEffect(e.kind) } }
                }
                .disabled(layer.type != "pixel" && layer.type != "group")
                ForEach(fx.items, id: \.id) { e in
                    HStack {
                        Toggle(layerEffectLabel(e.kind), isOn: Binding(get: { e.enabled }, set: { model.setEffectControl(e, "enabled", .bool($0)) }))
                        Spacer()
                        Button { model.selectedEffect = model.selectedEffect == e.id ? nil : e.id } label: { Image(systemName: "slider.horizontal.3") }.buttonStyle(.plain).accessibilityLabel("Edit \(layerEffectLabel(e.kind))")
                        Button { model.removeEffect(e.id) } label: { Image(systemName: "minus.circle") }.buttonStyle(.plain).accessibilityLabel("Remove \(layerEffectLabel(e.kind))")
                    }
                    if model.selectedEffect == e.id { EffectControlsView(model: model, effect: e) }
                }
            }
        }
    }
}

/// The controls of one layer style.
struct EffectControlsView: View {
    let model: PaintEditorModel
    let effect: LayerEffect

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(layerEffectControls(effect).enumerated()), id: \.offset) { _, c in
                switch c {
                case let .range(key, label, min, max, step, value, percent, unit):
                    PaintSliderRow(label: label, value: value, range: min...max, step: step, displayScale: percent ? 100 : 1, unit: unit ?? "", onCommit: { model.setEffectControl(effect, key, .number($0)) })
                case let .color(key, label, value):
                    HexColorPicker(label: label, hex: value) { model.setEffectControl(effect, key, .string($0)) }
                case let .checkbox(key, label, value):
                    Toggle(label, isOn: Binding(get: { value }, set: { model.setEffectControl(effect, key, .bool($0)) }))
                case let .select(key, label, value, options):
                    Picker(label, selection: Binding(get: { value }, set: { model.setEffectControl(effect, key, .string($0)) })) {
                        ForEach(options, id: \.value) { o in Text(o.label).tag(o.value) }
                    }
                }
            }
        }
        .padding(.leading, 8)
        .font(.caption)
    }
}
