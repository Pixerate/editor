import PixerateChart
import PixerateCore
import SwiftUI

/// A chart type drawn as a UI component (#819): `component.drawing` laid out at the view's size,
/// in the colour scheme's theme and the given role colours, drawn on a `Canvas`. It is the same
/// picture the TypeScript `render` gives as SVG, with the chart's description as its accessibility
/// label. Data the type refuses draws nothing and reads the refusal as its label.
///
/// ```swift
/// let bar = try chartUiComponents().first { $0.id == "bar-chart" }!
/// ChartUiComponentView(bar, data: ["categories": ["Q1", "Q2"], "series": [["name": "2026", "values": [140, 152]]]],
///                      colors: ["accent": "#0f766e"])
///     .frame(height: 240)
/// ```
public struct ChartUiComponentView: View {
    private let component: ChartUiComponent
    private let data: JSONValue
    private let colors: [String: String]
    private let theme: ChartUiThemeMode?
    @Environment(\.colorScheme) private var colorScheme

    /// - Parameters:
    ///   - theme: light or dark; `nil` follows the environment's colour scheme.
    ///   - colors: role → CSS colour (`surface`, `ink`, `ink-muted`, `border`, `accent`; see `colorRoleUse`).
    public init(_ component: ChartUiComponent, data: JSONValue, colors: [String: String] = [:], theme: ChartUiThemeMode? = nil) {
        self.component = component
        self.data = data
        self.colors = colors
        self.theme = theme
    }

    public var body: some View {
        GeometryReader { geo in
            let mode = theme ?? (colorScheme == .dark ? .dark : .light)
            let options = ChartUiRenderOptions(
                width: min(4096, max(1, Double(geo.size.width))),
                height: min(4096, max(1, Double(geo.size.height))),
                theme: mode,
                colors: colors
            )
            switch Result(catching: { try component.drawing(data, options) }) {
            case .success(let drawing):
                Canvas { ctx, _ in drawChartSceneInCanvas(drawing.scene, context: &ctx) }
                    .accessibilityElement()
                    .accessibilityAddTraits(.isImage)
                    .accessibilityLabel(drawing.ariaLabel)
                    .accessibilityValue(drawing.ariaLabel == drawing.description ? "" : drawing.description)
            case .failure(let error):
                Color.clear
                    .accessibilityElement()
                    .accessibilityLabel(String(describing: error))
            }
        }
    }
}
