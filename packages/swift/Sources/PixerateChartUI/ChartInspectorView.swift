import PixerateChart
import PixerateCore
import SwiftUI

/// The chart inspector panel built from `ChartContracts.ui()` (`ui.json`): chart type picker,
/// quick layouts, colour schemes and palette shades, title / subtitle, stacking / orientation /
/// curve, legend, gridlines, data labels, error bars, and bar-race playback controls.
public struct ChartInspectorView: View {
    private let model: ChartEditorModel

    public init(model: ChartEditorModel) {
        self.model = model
    }

    public var body: some View {
        let spec = model.spec
        let state = model.state
        let tables = model.ui

        VStack(alignment: .leading, spacing: 14) {
            // Selection heading
            HStack {
                Text(model.selectionDescription)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if state.selection != nil {
                    Button("Clear") { model.controller.select(nil) }
                        .buttonStyle(.borderless)
                        .font(.caption2)
                }
            }

            Divider()

            // Chart Type
            VStack(alignment: .leading, spacing: 6) {
                Text("Chart Type").font(.subheadline.weight(.semibold))
                Picker("Type", selection: Binding(
                    get: { spec.type.rawValue },
                    set: { raw in
                        if let t = ChartType(rawValue: raw) {
                            _ = model.setType(t)
                        }
                    }
                )) {
                    ForEach(tables.types, id: \.self) { raw in
                        Text(tables.typeLabels[raw] ?? raw.capitalized).tag(raw)
                    }
                }
                .labelsHidden()
            }

            // Titles
            VStack(alignment: .leading, spacing: 6) {
                Text("Titles").font(.subheadline.weight(.semibold))
                TextField("Title", text: Binding(
                    get: { spec.title },
                    set: { _ = model.setTitle($0) }
                ))
                .textFieldStyle(.roundedBorder)
                TextField("Subtitle", text: Binding(
                    get: { spec.subtitle },
                    set: { _ = model.setSubtitle($0) }
                ))
                .textFieldStyle(.roundedBorder)
            }

            // Quick Layouts (from ui.json layoutPresets)
            VStack(alignment: .leading, spacing: 6) {
                Text("Quick Layouts").font(.subheadline.weight(.semibold))
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                    ForEach(tables.layoutPresets, id: \.id) { preset in
                        Button(preset.label) {
                            _ = model.applyLayoutPreset(preset.id)
                        }
                        .help(preset.description)
                        .frame(maxWidth: .infinity)
                    }
                }
            }

            // Colour Schemes & Palette Shades (from ui.json colorSchemes & paletteShades)
            VStack(alignment: .leading, spacing: 6) {
                Text("Colour Schemes").font(.subheadline.weight(.semibold))
                ForEach(tables.colorSchemes, id: \.id) { scheme in
                    Button {
                        _ = model.applyColorScheme(scheme.id)
                    } label: {
                        HStack(spacing: 6) {
                            HStack(spacing: 2) {
                                ForEach(Array(scheme.palette.prefix(5).enumerated()), id: \.offset) { _, hex in
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(chartSwiftUIColor(hex) ?? .gray)
                                        .frame(width: 10, height: 10)
                                }
                            }
                            Text(scheme.label).font(.caption)
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                    .help(scheme.description)
                }

                if !tables.paletteShades.isEmpty {
                    Text("Palette Shades").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        ForEach(Array(tables.paletteShades.enumerated()), id: \.offset) { _, shade in
                            let label = shade == 0 ? "0" : (shade > 0 ? "+\(Int(shade * 100))%" : "\(Int(shade * 100))%")
                            Button(label) {
                                _ = model.applyPaletteShade(shade)
                            }
                            .font(.caption2)
                        }
                    }
                }
            }

            Divider()

            // Layout & Marks
            ChartMarksSection(model: model, spec: spec, tables: tables)

            Divider()

            // Legend & Grid
            ChartLegendAndGridSection(model: model, spec: spec, tables: tables)

            Divider()

            // Error Bars (from ui.json errorBars)
            ChartErrorBarsSection(model: model, spec: spec, state: state, tables: tables)

            // Bar Race Playback Controls
            if spec.type == .barrace || state.racePlaying || state.raceFrame != nil {
                Divider()
                ChartRaceSection(model: model, spec: spec, state: state)
            }
        }
    }
}

private struct ChartMarksSection: View {
    let model: ChartEditorModel
    let spec: ChartSpec
    let tables: ChartUITables

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Marks & Stacking").font(.subheadline.weight(.semibold))
            Picker("Stacking", selection: Binding(
                get: { spec.stacking.rawValue },
                set: { if let v = ChartStacking(rawValue: $0) { _ = model.setStacking(v) } }
            )) {
                ForEach(tables.stackings, id: \.self) { Text($0.capitalized).tag($0) }
            }
            Picker("Orientation", selection: Binding(
                get: { spec.orientation.rawValue },
                set: { if let v = ChartOrientation(rawValue: $0) { _ = model.setOrientation(v) } }
            )) {
                ForEach(tables.orientations, id: \.self) { Text($0.capitalized).tag($0) }
            }
            Picker("Curve", selection: Binding(
                get: { spec.curve.rawValue },
                set: { if let v = ChartCurve(rawValue: $0) { _ = model.setCurve(v) } }
            )) {
                ForEach(tables.curves, id: \.self) { Text($0.capitalized).tag($0) }
            }
            Toggle("Point markers", isOn: Binding(
                get: { spec.points },
                set: { _ = model.setPoints($0) }
            ))
            Toggle("Data labels", isOn: Binding(
                get: { spec.dataLabels },
                set: { _ = model.setDataLabels($0) }
            ))
            if spec.dataLabels {
                Picker("Label position", selection: Binding(
                    get: { spec.labelPosition.rawValue },
                    set: { if let v = ChartLabelPosition(rawValue: $0) { _ = model.setLabelPosition(v) } }
                )) {
                    ForEach(tables.labelPositions, id: \.self) { Text($0.capitalized).tag($0) }
                }
            }
        }
    }
}

private struct ChartLegendAndGridSection: View {
    let model: ChartEditorModel
    let spec: ChartSpec
    let tables: ChartUITables

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Legend & Grid").font(.subheadline.weight(.semibold))
            Toggle("Show legend", isOn: Binding(
                get: { spec.legend.show },
                set: { _ = model.setLegend(show: $0) }
            ))
            if spec.legend.show {
                Picker("Position", selection: Binding(
                    get: { spec.legend.position.rawValue },
                    set: { if let p = ChartLegendPosition(rawValue: $0) { _ = model.setLegend(position: p) } }
                )) {
                    ForEach(tables.legendPositions, id: \.self) { Text($0.capitalized).tag($0) }
                }
            }
            Toggle("Value gridlines (Y)", isOn: Binding(
                get: { spec.yAxis.gridlines },
                set: { _ = model.setGridlines(axis: .y, enabled: $0) }
            ))
            Toggle("Category gridlines (X)", isOn: Binding(
                get: { spec.xAxis.gridlines },
                set: { _ = model.setGridlines(axis: .x, enabled: $0) }
            ))
            Picker("Value scale", selection: Binding(
                get: { (spec.yAxis.scale ?? .linear).rawValue },
                set: { if let sc = ChartAxisScale(rawValue: $0) { _ = model.setAxisScale(axis: .y, scale: sc) } }
            )) {
                ForEach(tables.axisScales, id: \.self) { Text($0.capitalized).tag($0) }
            }
        }
    }
}

private struct ChartErrorBarsSection: View {
    let model: ChartEditorModel
    let spec: ChartSpec
    let state: ChartState
    let tables: ChartUITables

    var body: some View {
        if let targetSeries = state.selectedSeries ?? spec.series.first {
            let currentType = targetSeries.errorBars?.type.rawValue ?? "none"
            let currentDir = targetSeries.errorBars?.direction?.rawValue ?? "both"
            let currentVal = targetSeries.errorBars?.value ?? 10.0
            VStack(alignment: .leading, spacing: 6) {
                Text("Error Bars (\(targetSeries.name))").font(.subheadline.weight(.semibold))
                Picker("Error bars", selection: Binding(
                    get: { currentType },
                    set: { raw in
                        let ebType = ChartErrorBarType(rawValue: raw)
                        let dir = ChartErrorBarDirection(rawValue: currentDir) ?? .both
                        _ = model.setSeriesErrorBars(
                            seriesId: targetSeries.id,
                            type: ebType,
                            value: currentVal,
                            direction: dir
                        )
                    }
                )) {
                    Text("None").tag("none")
                    ForEach(tables.errorBars.types, id: \.self) { raw in
                        Text(tables.errorBars.labels[raw] ?? raw.capitalized).tag(raw)
                    }
                }
                if let eb = targetSeries.errorBars {
                    Picker("Direction", selection: Binding(
                        get: { currentDir },
                        set: { raw in
                            if let dir = ChartErrorBarDirection(rawValue: raw) {
                                _ = model.setSeriesErrorBars(
                                    seriesId: targetSeries.id,
                                    type: eb.type,
                                    value: currentVal,
                                    direction: dir
                                )
                            }
                        }
                    )) {
                        ForEach(tables.errorBars.directions, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }
            }
        }
    }
}

private struct ChartRaceSection: View {
    let model: ChartEditorModel
    let spec: ChartSpec
    let state: ChartState

    var body: some View {
        let maxIndex = Double(Swift.max(0, spec.categories.count - 1))
        let currentFrame = state.raceFrame ?? maxIndex
        VStack(alignment: .leading, spacing: 6) {
            Text("Bar Race").font(.subheadline.weight(.semibold))
            HStack {
                Button(state.racePlaying ? "Pause" : "Play") {
                    _ = model.toggleRacePlayback()
                }
                Button("Reset") {
                    model.controller.pauseRace()
                    _ = model.setRaceFrame(nil)
                }
            }
            if maxIndex > 0 {
                Slider(
                    value: Binding(
                        get: { currentFrame },
                        set: { _ = model.setRaceFrame($0) }
                    ),
                    in: 0...maxIndex
                )
            }
        }
    }
}
