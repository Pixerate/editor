---
"@pixerate/editor": minor
---

Picking, hover and keyboard focus for 3-D charts (closes #808).

- `createChart3dScene` and `renderChart3d` (`/three`): `pick(x, y)` raycasts from CSS px to the bar, or the line or area point nearest the hit, and returns `{ kind: 'point', seriesId, index }` or null; `focus(selection, { dim })` keeps the marks of a point, series or category in their colours and fades the rest towards the theme background (default 0.7), drawn on the next `render` (no clock), and `null` restores them; `anchor(selection)` gives a point's tooltip position in CSS px; category labels carry `index` and `focused`. The renderer exposes its `layout`.
- `nextChart3dFocus(layout, selection, key)` (`/chart`, also from `/three`): the flat chart's walk for 3-D — ← → between categories, ↑ ↓ between series front to back, Home / End, Escape — with `chart3dMarkSeries` and `chart3dMarkInFocus`.
- `describeChartSelectionIn(spec, selection)`: `describeChartSelection` without a controller, so 2-D and 3-D say the same words; `chartTooltipFor` gives the same tooltip from `anchor`.
- Demo: the 3-D view on the Charts tab answers hover and the arrow keys with the tooltip, dimming, a bold category label and a live description.
