---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Import the brush packs people already own (#569).

- `import_brush_pack` agent tool, `importBrushPack(library, bytes, options)`, `readBrushPack` and `importBrushFile` (a `.json` library file or a pack, by name).
- Photoshop `.abr` (versions 1, 2, 6, 7 and 10, `readAbr`): sampled tips become image sources and stamp-tip brushes, computed tips round or flat brushes, with preset names and spacing where the file has them.
- Procreate `.brush` and `.brushset`: each brush's shape becomes its image tip and its grain its tip grain, with its name and spacing.
- Licence and terms files in a pack, and the licence passed in, are kept on every source and returned as `licence`; what isn't mapped (dynamics, pencil curves, patterns, dual brushes, wet settings) is returned as `unsupported`. Packs are read defensively, with size limits.
- React and Svelte `BrushPanel` Import… also takes `.abr`, `.brush` and `.brushset` files.
