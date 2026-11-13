import PixerateCore
import PixeratePaint
import SwiftUI

/**
 * The paint editor (`PaintEditor`): the toolbar, the brush panel on the left, the canvas, and
 * colour, paper (with the light for thick paint), specialty paint (UV blacklight, heat, magnets,
 * view tilt), layers (with light spill and the stroke layer's
 * strokes), layer styles and wet paint on the right. Wet paint keeps flowing: the view ticks the
 * simulation every frame (`runWetClock`), living biopaint grows live (`runCultureClock`), and
 * live effect paint plays (`runEffectClock`). Light / dark paint follows the system appearance
 * (`followsColorScheme`), pixel layers repainted for it in the background (`runSchemeReplayClock`).
 * With an effects provider registered, an Effects tab
 * puts provider effects on the paper, layers and brush (`PaintProviderEffectsPanel`); with the
 * `author` policy it also writes effects in the effect authoring editor, shown as a sheet.
 * Agents drive the same editor through `model.registry`.
 */
public struct PaintEditorView: View {
    private let model: PaintEditorModel
    /// Width of each side column in points.
    private let sideWidth: CGFloat
    /// Follow device tilt (gyroscope on iPhone / iPad) to shift `viewTilt` for thin-film iridescence.
    private let deviceTilt: Bool
    /// Show light / dark paint in the system appearance (`model.setColorScheme`); false leaves the scheme to the host.
    private let followsColorScheme: Bool
    @Environment(\.colorScheme) private var appearance

    public init(model: PaintEditorModel, sideWidth: CGFloat = 250, deviceTilt: Bool = false, followsColorScheme: Bool = true) {
        self.model = model
        self.sideWidth = sideWidth
        self.deviceTilt = deviceTilt
        self.followsColorScheme = followsColorScheme
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
                        // The Specialty tab is marked while specialty paint is in play.
                        ForEach(model.tabs) { t in Text(t == .specialty && model.specialtyInPlay ? "\(t.label) •" : t.label).tag(t) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(8)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            switch model.tab {
                            case .color: PaintColorPanel(model: model)
                            case .paper: PaintPaperPanel(model: model)
                            case .specialty: PaintSpecialtyPanel(model: model)
                            case .layers:
                                PaintLayersPanel(model: model)
                                PaintLightSpillPanel(model: model)
                                PaintStrokePanel(model: model)
                            case .effects: PaintEffectsPanel(model: model)
                            case .providerEffects: PaintProviderEffectsPanel(model: model)
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
        .paintEffectAuthoringSheet(model)
        .task {
            model.catchUpCultures()
            await model.runWetClock()
        }
        .task { await model.runCultureClock() }
        .task { await model.runEffectClock() }
        // Light / dark paint on pixel layers is replayed for the scheme in the background.
        .task { await model.runSchemeReplayClock() }
        .onChange(of: appearance, initial: true) { (_: ColorScheme, next: ColorScheme) in
            if followsColorScheme { model.setColorScheme(next == .dark ? "dark" : "light") }
        }
    }
}
