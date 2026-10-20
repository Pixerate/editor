---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Gradient paint: a colour slot can hold a gradient (`PaintSource`) that brushes sample dab by dab, by distance dragged out (the default: 300 px, mirrored), pressure, tilt, speed, direction, time, across the tip or at random, mixed as pigment, Oklab or sRGB, with opacity stops, midpoints and softness. Every colour engine paints it (dab, Mixer Brush, watercolour and gouache, oil and impasto, particles, bristles, stickers), in the paint editor (`setPaint`, `paint` on strokes, `brush.paint`, gradient swatches) and the image editor's brush (`PaintOptions.paint`, also on masks and at 16 / 32 bits). Strokes record the resolved gradient, so replays and re-renders are exact.

The multi-colour brush is now a brush's own gradient (`brush.paint`): `behavior.multicolor` is still accepted on input and in old documents and presets, converted to the gradient that paints the same pixels, and reported back as a read-only view when the gradient has a multi-colour equivalent. New agent tools: `set_paint` (both editors), `get_paint` (image editor); `paint_stroke` takes `paint`, `set_brush` takes `paint`, `get_brush` returns `paint` and `strokePaint`, `add_swatch` takes `paint`. React and Svelte add `PaintGradientEditor` to the colour panel, the brush panel (replacing the multi-colour controls) and the image editor's brush options.
