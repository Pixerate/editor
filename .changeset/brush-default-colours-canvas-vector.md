---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Brush default colours reach the canvas and vector editors, and stamp tips and spray work on every dab brush.

- Canvas: `selectBrush(id, { keepColour })` picks a brush with its size and default colour (light / dark pairs resolve for the new `colorScheme` option and `setColorScheme`). `drawStroke` and `canvas.drawFreehand` with a brush and no colour paint in the brush's default colour. `CanvasBrushPreset.defaultColor` lists it. React `useCanvasDraw` takes `colorScheme` and returns `selectBrush`; Svelte `createCanvasDraw` returns `selectBrush` and `setColorScheme`.
- Vector: `addBrushstroke` and `setBrushstroke` (another brush) take the brush's default colour unless `keepColour` or a `color` is given, also as `vector.addBrushstroke` / `vector.setBrushstroke` params. New `colorScheme` option and `setColorScheme`, and `vectorBrushstrokeDefaultColour`.
- Paint: stamp tips and spray (`marks: scatter`) now also paint on brushes that pick paint up or use gradient paint, instead of round dabs. Scatter marks are kept on pick-up brushes; only bristle, wet, thick and Mixer brushes drop them.
