---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Optional provider effects in the image editor. With an `EffectProvider` (`effects` option, `setEffectsProvider` / `useEffects`), filter effects become `effect` smart filters (`applyEffectFilter`; a pixel, shape or type layer converts to a smart object in the same undo step) with blend, opacity, order and the filter mask. Generator, overlay and title effects become effect layers (`addEffectLayer` / `updateEffectLayer` / `rasterizeEffectLayer`): pixel layers with a `generator`, rendered at the document's size and bit depth. Effect filters render in the background (`ImageEffectsEngine`). Without a provider they pass pixels through, and effect layers keep their pixels; both round-trip through JSON. New agent tools via `createImageEffectsToolProvider`: the shared effect tools plus `add_effect_layer`. React and Svelte add `<ImageProviderEffectsPanel>`, `<ImageEditor effects>` and `useImageEffectsTools`.
