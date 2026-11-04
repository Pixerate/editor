import PixerateCore
import PixeratePaint
import SwiftUI

/**
 * The paint editor (`PaintEditor`): the toolbar, the brush panel on the left, the canvas, and
 * colour, paper, layers (with the stroke layer's strokes) and layer styles on the right. Wet,
 * thick and sticker media and provider effects are not ported yet, so their panels are not
 * shown. Agents drive the same editor through `model.registry`.
 */
public struct PaintEditorView: View {
    private let model: PaintEditorModel
    /// Width of each side column in points.
    private let sideWidth: CGFloat

    public init(model: PaintEditorModel, sideWidth: CGFloat = 250) {
        self.model = model
        self.sideWidth = sideWidth
    }

    public var body: some View {
        VStack(spacing: 0) {
            PaintToolbarView(model: model)
            Divider()
            HStack(spacing: 0) {
                ScrollView {
                    PaintBrushPanel(model: model).padding(10)
                }
                .frame(width: sideWidth)
                Divider()
                VStack(spacing: 0) {
                    PaintCanvasView(model: model)
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
                VStack(spacing: 0) {
                    Picker("Panels", selection: Binding(get: { model.tab }, set: { model.tab = $0 })) {
                        ForEach(PaintPanelTab.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(8)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            switch model.tab {
                            case .color: PaintColorPanel(model: model)
                            case .paper: PaintPaperPanel(model: model)
                            case .layers:
                                PaintLayersPanel(model: model)
                                PaintStrokePanel(model: model)
                            case .effects: PaintEffectsPanel(model: model)
                            }
                        }
                        .padding(10)
                    }
                }
                .frame(width: sideWidth)
            }
        }
        .controlSize(.small)
    }
}
