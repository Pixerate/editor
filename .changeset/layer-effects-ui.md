---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Layer effects in the layers panel, in React and Svelte alike. `<LayersPanel>` shows an fx badge on every layer with effects (click it to switch them on or off) and an effects section for the active layer. A new `<LayerEffectsPanel>` holds that section and can also be used on its own. It has the master switch, Scale Effects, an "Add effect" menu, and each effect with its own toggle, remove button and every setting (sliders, colours, toggles, choices; a slider drag is one undo step). Core gains the shared view model: `layerEffectsPanel`, `layerEffectsBadge`, `LAYER_EFFECT_MENU`, `layerEffectControls` and `effectControlChange`.
