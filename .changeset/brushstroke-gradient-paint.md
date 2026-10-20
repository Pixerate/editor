---
"@pixerate/editor": minor
---

Gradient paint for brushstrokes along paths. `renderBrushstroke(…, { paint })` and `paintPathStroke(…, { paint: { paint, seed } })` take a `PaintSource`: one colour, or a gradient sampled dab by dab by distance along the path, pressure, tilt, speed, direction, time, across the tip or at random, through the same `gradientDabColor` the paint editor uses. Distance gradients scale with `renderBrushstroke`'s `scale`, so a stroke looks the same at every zoom. `pathStrokeDabs` now records each dab's `params` (travel, index, pressure, lean, speed, direction, time), and `PathSample` takes an optional time `t`.
