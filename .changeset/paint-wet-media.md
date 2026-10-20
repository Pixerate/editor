---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Wet media in the paint editor (watercolour first). A lattice Boltzmann water and pigment simulation (`WetWorld` in `@pixerate/editor/paint`) runs on sparse 256 px tiles in WebAssembly SIMD, in Web Workers on shared memory when the page is cross-origin isolated and on one thread otherwise, with a TypeScript kernel that gives the same bits; the ~8 KB kernels load lazily as a separate chunk. Results are deterministic across browsers, kernels and thread counts. The paint editor gets wet brushes (Watercolour round, Wash brush, Watercolour rigger, Gouache) and wet tools (Add water, Dry, Blow, Wet blend, Wet smudge, Blot) with wet-in-wet, edge darkening, granulation, blooms, colour bleed, glazing, re-wetting, canvas tilt with drips and flow maps; dry now, pause, speed and a water overlay; wet paint dries deterministically on save and export, and undo restores the wet state. New agent tools: `get_wet_paint`, `advance_wet_paint`, `dry_paint`, `wet_paper`, `set_wet_settings`, `set_flow_map`, `set_canvas_tilt`, `pause_wet_paint`, `set_water_overlay`. React and Svelte add `<WetPanel>`, a wet tool menu in `<BrushPanel>`, and the wet clock and water overlay in `<PaintCanvas>`.
