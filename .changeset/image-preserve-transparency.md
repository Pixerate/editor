---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Keep a layer's transparency under provider filter effects in the image editor. An effect smart filter can have `preserveTransparency`. With it set, the effect's result is drawn over the layer and takes the layer's alpha, so a shader no longer fills transparent pixels. A missing value means false, so existing documents render as before.

- `applyEffectFilter` and `updateEffectFilter` accept `preserveTransparency`. The `apply_effect` tool also takes `preserveTransparency` (default true, stored on the new filter) and `blend`. `update_effect` can change both, and `list_applied_effects` reports `preserveTransparency`.
- `addEffectLayer` / `add_effect_layer` and `addAdjustmentLayer` / `add_adjustment_layer` take `clipped`. It clips the new layer to the layer below in the same undo step and is refused when nothing is below it. The tools return `clipped`.
- The shared effect tools (`createEffectToolProvider`) let an editor add its own `apply_effect` and `update_effect` arguments (`applyOptions`, `updateOptions`).
- React and Svelte `ImageProviderEffectsPanel`: each effect filter has a "Keep transparency" checkbox, and filters added from the panel keep the layer's transparency. A new "Add effect layer…" row has a "Clip to layer below" option.
