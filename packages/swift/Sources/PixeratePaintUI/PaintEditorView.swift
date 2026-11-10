import PixerateCore
import PixeratePaint
import SwiftUI

/**
 * The paint editor (`PaintEditor`): the toolbar, the brush panel on the left, the canvas, and
 * colour, paper (with the light for thick paint), layers (with light spill and the stroke layer's
 * strokes), layer styles and wet paint on the right. Wet paint keeps flowing: the view ticks the
 * simulation every frame (`runWetClock`). Agents drive the same editor through `model.registry`.
 */
public struct PaintEditorView: View {
    private let model: PaintEditorModel
    /// Width of each side column in points.
    private let sideWidth: CGFloat
    /// Follow device tilt (gyroscope on iPhone / iPad) to shift `viewTilt` for thin-film iridescence.
    private let deviceTilt: Bool

    public init(model: PaintEditorModel, sideWidth: CGFloat = 250, deviceTilt: Bool = false) {
        self.model = model
        self.sideWidth = sideWidth
        self.deviceTilt = deviceTilt
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
                    PaintCanvasView(model: model, deviceTilt: deviceTilt)
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
                                PaintLightSpillPanel(model: model)
                                PaintStrokePanel(model: model)
                            case .effects: PaintEffectsPanel(model: model)
                            case .wet: PaintWetPanel(model: model)
                            }
                        }
                        .padding(10)
                    }
                }
                .frame(width: sideWidth)
            }
        }
        .controlSize(.small)
        .task {
            model.catchUpCultures()
            await model.runWetClock()
        }
    }
}
