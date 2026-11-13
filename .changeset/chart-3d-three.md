---
"@pixerate/editor": minor
---

Charts in 3-D with three.js (part of #795).

- New optional entry `@pixerate/editor/three`, with three.js as an optional peer dependency (`>=0.184.0`); no other entry reaches it.
- `layoutChart3d(spec)` (`/chart`, no three.js) lays out a bar, line or area chart in world units: bars side by side or stacked as boxes (percent stacks to 100), lines and areas as ribbons in rows behind them, value ticks and category positions, and warnings for what is drawn differently (other types flat, horizontal bars as columns, a log axis linear, secondary series on the main axis).
- `createChart3dScene(spec, { width, height })` builds the scene (a floor, a back wall with the value gridlines, a soft key light and a sky / ground fill) and a camera fitted to the chart from its `view3d`, without WebGL. `renderChart3d(canvas, spec, options)` draws it on demand (no animation loop), and `labels()` gives category, tick and title positions in CSS px for an HTML or SVG overlay. `renderChart3dImage` makes a PNG with the labels.
- Chart tools take a `render3d` hook: `render_chart` with format png draws a chart that has a 3-D view in 3-D (the React and Svelte `useChartToolProvider` pass it through).
- `ChartSpecPatch.view3d` accepts `null` in TypeScript, as `update` already did at runtime.
