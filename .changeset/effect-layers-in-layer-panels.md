---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
"@pixerate/editor-react": patch
---

Effect layers and provider effects for hosts that build their own layer UI. `newLayerOptions` offers an "Effect Layer…" option (`pick: 'effect'`) when the editor has an effects provider, and `addLayerOfKind(controller, 'effect', { effect })` adds it. `layerPanels(layer, { effects: true })` includes a `provider-effects` panel, also with no layer active, which Svelte's `LayerPanel` renders as `ImageProviderEffectsPanel`. `EFFECT_LAYER_USES` names the effect uses an effect layer draws.
