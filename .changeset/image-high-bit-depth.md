---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add 16-bit and 32-bit float layers, additively. `@pixerate/editor/raster` tiles may carry deep samples (`Uint16Array` sRGB or `Float32Array` linear light) next to their 8-bit rendering, so every 8-bit consumer, the paint editor included, works unchanged; new `deepTile`, `readDeepRegion`, `writeDeepRegion`, `convertSurfaceDepth`, `surfaceFromDeepPixels` and sample conversions. The image editor gets a document bit depth (`setBitDepth`, `bitDepth`, Image › Mode as one undo step), opens and saves 16- and 32-bit PSDs at their depth (layers in Lr16 / Lr32), keeps deep samples in v3 JSON, and exposes `set_bit_depth` plus `bitDepth` in `get_image_info` to agents. React and Svelte `<LayersPanel>` show a Bits per channel menu.
