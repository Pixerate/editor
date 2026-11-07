import PixerateChart
import PixerateCore
import SwiftUI
#if canImport(AppKit)
import AppKit
#endif

/// The top toolbar of `ChartEditorView`: chart type badge, selection summary, bar-race Play/Pause,
/// Undo / Redo buttons, and an Export menu (Copy SVG, Copy Mermaid).
public struct ChartToolbarView: View {
    private let model: ChartEditorModel

    public init(model: ChartEditorModel) {
        self.model = model
    }

    public var body: some View {
        let state = model.state
        let spec = model.spec
        let typeLabel = model.ui.typeLabels[spec.type.rawValue] ?? spec.type.rawValue.capitalized

        HStack(spacing: 10) {
            Text(typeLabel)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.14), in: Capsule())

            Text(model.selectionDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer()

            if spec.type == .barrace || state.racePlaying {
                Button {
                    _ = model.toggleRacePlayback()
                } label: {
                    Label(state.racePlaying ? "Pause Race" : "Play Race", systemImage: state.racePlaying ? "pause.fill" : "play.fill")
                }
            }

            Button {
                _ = model.undo()
            } label: {
                Label("Undo", systemImage: "arrow.uturn.backward")
            }
            .disabled(!state.canUndo)
            .help(state.undoLabel.isEmpty ? "Undo" : "Undo \(state.undoLabel)")

            Button {
                _ = model.redo()
            } label: {
                Label("Redo", systemImage: "arrow.uturn.forward")
            }
            .disabled(!state.canRedo)
            .help(state.redoLabel.isEmpty ? "Redo" : "Redo \(state.redoLabel)")

            Menu("Export") {
                Button("Copy SVG") {
                    copyToPasteboard(model.exportSvg())
                }
                Button("Copy Mermaid") {
                    copyToPasteboard(model.exportMermaid())
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func copyToPasteboard(_ text: String) {
        #if canImport(AppKit) && !targetEnvironment(macCatalyst)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

/// The complete chart editor (`ChartEditor`): toolbar, interactive `ChartView` canvas, error banner,
/// and `ChartInspectorView` on the right. Agents drive the same editor through `model.registry`.
public struct ChartEditorView: View {
    private let model: ChartEditorModel
    private let inspectorWidth: CGFloat

    public init(model: ChartEditorModel, inspectorWidth: CGFloat = 270) {
        self.model = model
        self.inspectorWidth = inspectorWidth
    }

    public var body: some View {
        VStack(spacing: 0) {
            ChartToolbarView(model: model)
            Divider()
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    ChartView(model: model)
                    if let error = model.error {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .accessibilityAddTraits(.isStaticText)
                    }
                }
                Divider()
                ScrollView {
                    ChartInspectorView(model: model)
                        .padding(10)
                }
                .frame(width: inspectorWidth)
            }
        }
        .controlSize(.small)
    }
}
