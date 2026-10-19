---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Add four painterly blend modes to the shared blend set: `watercolor` (transparent washes that multiply per wavelength through the pigment model's spectra, so blue over yellow glazes green), `tint` (the source's colour on the backdrop's Oklab lightness, gently near white and black), `highlight` (coloured light added with a soft shoulder that never clips) and `shadow` (light taken away with ambient fill, so shading never crushes to black). They are ordinary `B(Cb, Cs)` modes, so the compositor, adjustment layers, effects and brushes all support them. `BlendModeInfo` gains `painterly`, `standard` and `description`; new `PAINTERLY_BLEND_MODES`, `isPainterlyBlendMode` and `standardBlendMode`. The paint editor's PSD export writes pigment and painterly layers as their nearest standard mode (watercolor and shadow as Multiply, tint as Color, highlight as Screen) with a warning, and a new `list_blend_modes` agent tool describes every mode. The React and Svelte layer panels group the blend menu into Standard and Paint modes (`BLEND_MENU_GROUPS`).
