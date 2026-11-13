import PixerateCore
import PixerateVector
import SwiftUI

/**
 * The vector editor (`VectorEditor`): the toolbar, the canvas, and the layers and appearance
 * panels on the right. Agents drive the same editor through `model.registry`, and what they do
 * shows as it happens.
 */
public struct VectorEditorView: View {
    private let model: VectorEditorModel
    /// Width of the side column in points.
    private let sideWidth: CGFloat

    public init(model: VectorEditorModel, sideWidth: CGFloat = 260) {
        self.model = model
        self.sideWidth = sideWidth
    }

    public var body: some View {
        VStack(spacing: 0) {
            VectorToolbarView(model: model)
            Divider()
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    VectorCanvasView(model: model)
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
                VectorSidePanel(model: model)
                    .frame(width: sideWidth)
            }
        }
        .controlSize(.small)
    }
}

struct VectorSidePanel: View {
    let model: VectorEditorModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("Panels", selection: Binding(get: { model.tab }, set: { (t: VectorPanelTab) in model.tab = t })) {
                ForEach(VectorPanelTab.allCases) { (t: VectorPanelTab) in Text(t.label).tag(t) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(8)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch model.tab {
                    case .layers: VectorLayersPanel(model: model)
                    case .appearance: VectorAppearancePanel(model: model)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
