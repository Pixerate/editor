---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor layer effects: the image editor's live layer styles (outer and inner glow, shadows, stroke, bevel, satin, overlays) on paint layers.

- `PaintEditorController` gains `getLayerEffects`, `addLayerEffect`, `updateLayerEffect` (with `commitToHistory` for drags), `removeLayerEffect`, `setLayerEffectsEnabled` and `setLayerEffects`; `list_layers` reports how many effects a layer has. Effects are drawn from the layer's pixels, saved, duplicated with the layer and written to PSD as layer styles.
- The paint tool provider gains `list_layer_effects`, `add_layer_effect`, `update_layer_effect`, `remove_layer_effect` and `set_layer_effects_enabled`, shared with the image editor through the new `createLayerEffectTools(host, options)` (`LayerEffectsHost`).
- React and Svelte `PaintLayersPanel` show a Layer Style section: the image editor's `LayerEffectsPanel`, whose `controller` is now any `LayerEffectsController`.
