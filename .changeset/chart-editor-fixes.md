---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Fix chart editor correctness bugs. Tick labels now use as many decimals as the step needs (a 2.5 step labels `0.0 | 2.5 | 5.0`, a 0.025 percent step labels `2.5%`). `niceScale` computes ticks as `first + i·step`, so ranges near 1e16 no longer emit duplicate ticks, and non-finite or ±`Number.MAX_VALUE` ranges stay finite. Stacked data labels pick dark or light text by the fill's luminance and are skipped when the segment is too short. No-op edits, and drags that end where they started, no longer record an undo step. `layoutChart` takes a `valueDomain` option and `ChartPointDrag` exposes `valueDomain`; the React and Svelte canvases pass it during a drag so the value axis no longer rescales under the pointer.
