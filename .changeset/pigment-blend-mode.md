---
"@pixerate/editor": minor
---

Add a `pigment` blend mode to the shared raster blend set: the layer's colour mixes into what is below like paint (Kubelka-Munk, so blue over yellow at 50 % gives green), with opacity as the share of new paint. Unlike the other modes it is not a `B(Cb, Cs)` function; it replaces the alpha interpolation, `Co = lerpPigment(Cb, Cs, αs / αo)`, and alpha composites as normal. It works on pixel, group, adjustment and annotation layers, in `paint_stroke` (brush `blend`) and `fill_pixels`, and in the canvas fallback (`blendImageData`); the compositor caches each 8-bit colour's spectrum. New helpers `mixPigmentRgb` and `mixPigment8`. PSD export writes pigment layers as Normal and adds a warning naming them. `BLEND_MODES` now has 27 entries, so the React and Svelte layer blend menus list Pigment.
