---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image brush tips and tip grain, like Procreate's shape and grain sources (#569).

- Brush image sources: `BrushLibrary.addSource`, `listSources` and `getSource` keep images (a PNG read from its transparency, dark or light parts, stored as a grey mask of at most 512 px with its licence and origin). Library files carry the sources their brushes name. `makeBrushSource`, `readBrushSource`, `decodeBrushSource`, `brushSourceRef`, `addBrushSourceFromFile`, `imageFileToPngDataUrl` and `withBrushSource`.
- A stamp tip lays an image source with `tip.stamps: ['source:<id>']` (continuous dabs, sprays and particle dots); its hardness fades it towards its edges. Objects marks still take stickers only.
- `tip.grain`: texture inside each dab, a built-in pattern or an image source, `texturised` (fixed to the canvas) or `moving` (rolls with the tip), with `scale`, `depth`, `contrast` and `invert`.
- `dynamics.count` (dabs per spacing step) and `dynamics.flip` (random mirroring).
- The paint engine's `PaintBrush` gains optional `tipGrain`, `dynamics.count` and `dynamics.flip`; brushes without them resolve as before. Recorded strokes keep the source refs and saved paintings carry the sources (`brushSources`), so replays, time-lapses and high-resolution exports match. `PaintEditorController.brushSources` and `stampArt`; `paintBrushPreviewRenderer(paper, { library })` draws image tips in previews.
- Host profiles gain `tipGrain` and `dabCount`: the paint editor paints both; the image editor, canvas and vector strokes paint without them (a warning). `brushEditorSections` adds a Grain section and, for stamp tips, count, scatter, rotation and size jitter and flip, and offers the library's sources.
- Agent tools `add_brush_source` and `list_brush_sources`; `create_brush`, `update_brush` and `set_brush` take the new facets, and image sources the library doesn't have are refused with the closest ids.
- React and Svelte `BrushEditor`: `sources` and `onAddSource` / `onaddsource`, with "Add image tip…" and "Add grain image…"; `BrushLibraryEditor` and the paint `BrushPanel` store picked images in the library.
