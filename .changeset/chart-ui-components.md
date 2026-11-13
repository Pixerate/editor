---
"@pixerate/editor": minor
---

Charts as UI components, a pilot for #819: `uiComponents()` in `@pixerate/editor/chart` lists the `sparkline` and `bar-chart` types for a component registry.

- Each entry carries a `UiDescriptor` (the shape of `@pixerate/schemas`' `UiDescriptorSchema`, mirrored here without depending on that package): `implements`, group `data-visual`, a contract with a JSON Schema for the data (`{ values }` for the sparkline, `{ categories, series, title?, unit? }` for the bar chart), colour roles, accessibility (`role: "img"`, label from the data's description), sizing and `motion: false`, example data and a `contentHash`.
- `render(data, { width, height, theme, colors })` validates the data and draws accessible SVG in light or dark, with any colour role passed as a CSS colour (`var(--x, #fallback)` works). `colorRoleUse` says which chart colours each role drives.
- `contentHash` is a stable hash of the type's contract, example, render version (`CHART_UI_RENDER_VERSIONS`) and its example drawn in light and dark, so it changes when the type's output does and nowhere else.
