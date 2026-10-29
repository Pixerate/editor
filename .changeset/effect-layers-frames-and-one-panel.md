---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
"@pixerate/editor-react": minor
---

Effect layers: transparent backgrounds, still frames or animation, changing the effect, and one Effects panel.

- Effects contract: `EffectSummary.backgroundOpacity` names a 0–1 control that fades the effect's own background (checked by `checkEffectProvider`). `addEffectLayer` sets it to 0 when the layer has others below it, unless `values` set it; the fake gradient has one (`opacity`).
- `updateEffectLayer(id, { effect })` changes an effect layer's effect in one undo step (its defaults plus `values`; a name the user gave is kept).
- Effect layers are a still frame (`time`) or play in an animation (`animate: { duration }`, saved with the document). `getAnimation()` reports the animating layers and the animation's length; `renderAnimationFrame(time)` renders the document at a time into it without changing it. `effectLayerTiming` gives the panels' view.
- Agent tools: `add_effect_layer` takes `animate`; new `set_effect_layer` changes an effect layer's effect, frame or animation.
- One Effects panel (`ImageProviderEffectsPanel`): an effect layer's effect (Change…, Rasterize), Still frame / Animate with a frame scrubber and length, and its controls; then the layer's filters and layer styles, added from one Add menu. `layerPanels(layer, { effects: true })` no longer lists Layer Effects or Smart Filters separately, and no longer shows Effects with no layer selected: new effect layers come from the layers panel. `LayerEffectsPanel` takes `heading={false}` to drop its own title and Add menu.
- Fix: effect controls whose schema is an `anyOf` (Flair's colours: sRGB channels or a CSS string) were left out of `effectParameterFields`, so effect panels showed no colour controls; they are now edited as the shape of their default.
