---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor layer integrations. In documents with more than one pixel layer or group (`isMultiLayer`), `applyInpaintedImage` adds the result as a new layer above the active layer (limited to the selection) and `applyBackgroundRemovedImage` masks the active pixel layer with the result's alpha; single-layer documents keep replacing the Background, and both take `{ target: 'new-layer' | 'replace' }`. `toAIInputDataURL` gives hooks the matching input (the composite in new-layer mode). New `rasterizeLayer` (annotation layers to pixels, layer filters baked) with the `rasterize_layer` agent tool and a Rasterize Layer menu item; selection tools take `sample: 'composite' | 'active-layer'` (also on `select_by_color`); `toJSON({ assets: 'external', store })` and `loadJSONAsync(data, { store })` keep v3 layer pixels in an `ImageEditorAssetStore`. React and Svelte: an AI result target selector and a sample selector in `<SelectionOptionsBar>`.
