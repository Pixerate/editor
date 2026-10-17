---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Chart PNG previews. Core adds `rasterizeChartSvg` (resolves CSS-variable paints with `resolveChartSvgPaints`, so charts no longer draw black, then draws through a canvas at 2× with the longest side ≤ 1024 px), `createChartRasterizer`, `downloadChartPng` and `chartFileName`. `render_chart` now says when an image is worth its tokens, returns the layout warnings with SVG and PNG results, and the React and Svelte `useChartToolProvider` pass a browser rasterizer by default so `render_chart { format: "png" }` works out of the box (`rasterize: false` turns it off). `<ChartEditor>` gains a Download PNG toolbar button (`pngOptions`).
