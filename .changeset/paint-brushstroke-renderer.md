---
"@pixerate/editor": minor
---

`renderBrushstroke(samples, brush, { scale, color })` in `@pixerate/editor/paint` renders a dry brushstroke on its own, to RGBA bytes and its bounds in path units. Samples are a polyline with pressure, tilt and time, or points plus pressure and tilt profiles along the length. Brushes are tip settings or dry paint-editor presets; wet, mixer, blender, smudge and eraser brushes are refused with an error saying why. `brushstrokeScaleBucket` snaps a zoom to a power of √2, `BrushstrokeCache` keeps recent renders by path, brush, colour and scale, and `brushstrokeDataUrl` / `brushstrokeToCanvas` (with an injected canvas factory) turn the result into a PNG or a canvas. Built on `paintPathStroke`; deterministic and DOM-free.
