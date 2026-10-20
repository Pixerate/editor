---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint provider effects: with an optional `EffectProvider`, the paint editor takes effect paper (a generator drawn over the sheet and under the paint, multiplied by default so the paper's grain shows), effect layers (`addEffectLayer`, redrawn with `updateEffectLayer`, `rasterizeEffectLayer`), effect fills (`fillLayerWithEffect`) and light baked onto dried paint (`applyLightEffect`, any filter effect; thick paint keeps its relief). Each change is one undo step (a slider drag is one) and effect paper and effect layers are saved with the document. Adds `createPaintEffectsToolProvider` (`set_paper_effect`, `add_effect_layer`, `fill_layer_with_effect` and the shared effect tools) in core, and `<PaintEffectsPanel>`, `usePaintEffectsTools` and an Effects tab in `<PaintEditor>` (shown when a provider is registered) in React and Svelte.
