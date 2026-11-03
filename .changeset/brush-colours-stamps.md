---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Brush colours, stamp tips, spray and new presets.

- **Colour defaults.**
  - Choosing a brush with a solid or light / dark `colour.default` makes it the paint colour, unless the colour is locked: `setColorLocked`, `set_color` `locked`, and "Keep my colour" in the brush panel.
  - Light / dark colours resolve for the controller's `colorScheme` (option and `setColorScheme`). A colour taken from a brush follows scheme changes.
  - `colour.own` brushes paint their own colour, resolved when the stroke starts and recorded with it, so replays stay exact.
  - The image editor's `setBrushPreset` sets the foreground from the default (`keepColour`, `colorScheme` options and tool arguments).
  - `brushColourHex` is exported from `@pixerate/editor/brushes`.
- **Brush Editor.** The default colour can be a light / dark pair, and palette entries are edited in place, light / dark pairs included (React and Svelte).
- **Stamp tips.**
  - `tip.shape: 'stamp'` with continuous marks lays every dab in the shape of its first stamp. The stamp is an editor stamp or any sticker ref from the sticker library, in the paint colour (engine `PaintBrush.stamp`).
  - Textured particle dots take library stickers too.
  - The paint editor's library tools refuse a sticker its sticker library can't load, with the closest refs (the `stickers` option of `createBrushLibraryToolProvider`).
- **Spray.** `marks: { kind: 'scatter', density, size }` lays seeded droplets across the tip (engine `PaintBrush.spray`). Paint editor only.
- **Presets.**
  - New: Ballpoint, Gel pen, Fineliner (ink), Crayon, Chalk (dry, with a light / dark default) and Spray can.
  - The neon marker gets a palette.
  - Canvas, vector and the image editor list the new dry and ink presets.
