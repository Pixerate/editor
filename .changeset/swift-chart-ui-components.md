---
"@pixerate/editor": minor
"@pixerate/swift": minor
"@pixerate/conformance": patch
---

Chart UI components in Swift (#819). The sparkline, bar chart, line chart and donut chart are now drawn by the Swift package too:

- **Swift:** `chartUiComponents()` in PixerateChart lists them with their `UiDescriptor`, colour role uses, default colours and example size. `render(data, options)` returns the same SVG as the TypeScript `render`, byte for byte, and `drawing(data, options)` gives the laid-out scene with its accessible name and description. Data and sizes are refused with the same messages. `chartPaletteWithAccent` is ported. `ChartUiComponentView` in PixerateChartUI draws a component on a SwiftUI `Canvas` at the view's size, following the colour scheme unless a theme is given.
- **TypeScript:** these four types' descriptors now list `swiftui` in `platforms` and set `swiftReady: true`, so their `contentHash`es change (the data visuals `lineage`, `braid` and `weave` stay web only). `CHART_UI_SWIFT_READY` and `chartUiExampleSize` are exported.
- **Conformance:** the chart contracts gain `ui-components.json` (the Swift-ready components and their descriptors), which Swift reads. `chart-ui-components-vectors.json` records renders and refusals for Swift to match.
