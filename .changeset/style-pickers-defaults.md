---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

House style in the editors (#776).

- `styleSwatches(style)` lists the colours (profile palette, brand palette, brand roles) and fonts a house style offers, in picker order; `get_style` returns them as `swatches`, so agents pick from the same set as people.
- `StyleDomain.defaults` and `styleDefaults(domain, style)` give new work its starting patch; charts use `chartStylePatch`. New agent tool `apply_chart_style` applies it as one undo step (refused on a read-only chart, `readOnly` option).
- `STYLE_AGENT_INSTRUCTIONS`: domain-neutral prompt text for hosts while a house style is active.
- React and Svelte: `useStyleSwatches(styles, domain, scope?)`, and `ChartEditor` / `ChartInspector` take `swatches` shown beside each series colour.
- Swift: `apply_chart_style` in `createChartStyleToolProvider` (hidden on a read-only chart, `ChartStyleToolProviderOptions.readOnly`), with the `style-apply` scenario.
