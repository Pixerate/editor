---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

Effect paint hints (#757). An effect summary can carry a `paint` hint (`map` path, stroke or canvas, up to two `colors` controls, `values`, `live`, `repeat`, `size`), and a provider can declare `capabilities.paintHints` to say only hinted effects suit paint. With it, the paint editor's paint browser (React and Svelte `PaintEffectsPanel`, Swift `PaintProviderEffectsPanel`), `search_effects` with the new `place: "paint"` and `set_effect_paint` offer only hinted effects; `set_effect_paint` refuses the rest and points to an effect layer or fill. Effect layers, fills and the paper are unchanged, and providers without the capability behave as before. Picking a hinted effect starts from its hint: its map and repeat, its values, the paint and secondary colours in its colour controls, and live; explicit arguments win. `checkEffectProvider` checks hints against the controls. Authored effects keep a hint in their document (`EffectAuthoringDocument.paint`, new tool `effect_authoring_set_paint_hint`), and the pixel expression templates carry one. `EffectsBrowser` (React and Svelte) takes a `filter`. `createFakeEffectProvider({ paintHints: true })` / `FakeEffectProvider(paintHints: true)` hint `fake.gradient` and `fake.trail`.
