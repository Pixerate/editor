---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add the image editor's retouching tools on the shared brush engine: Clone Stamp (aligned or non-aligned source point, sampling the layer, the layers up to it or all layers), Healing Brush and Spot Healing Brush (Poisson seamless cloning, proximity match or a smooth fill), Smudge, Dodge and Burn (shadows / midtones / highlights, exposure, Protect Tones) and Sponge (saturate / desaturate, vibrance). They respect pressure, the selection, locks and mask targeting, and each stroke is one undo step. `@pixerate/editor/paint` exports the kernels (`applyRetouchToTile`, `RetouchDabStroke`, `healPixels`, `spotHealPixels`, `seamlessClone`, `dodgeBurn`, `sponge`). The image editor gains `setCloneSource`, `setPaintOptions({ retouch })`, Alt-click to set the source, shortcuts S / J / Shift+J / O / Shift+O, and ten agent tools (`clone_stamp`, `heal_brush`, `spot_heal`, `smudge`, `dodge`, `burn`, `sponge`, `get_retouch_options`, `set_retouch_options`, `set_clone_source`). `<BrushOptionsBar>` shows each tool's options in React and Svelte.
