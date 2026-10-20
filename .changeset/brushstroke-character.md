---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Brushed strokes now look like their brush. Before, charcoal, pastel and pencil on the canvas all drew a plain round line.

- `renderBrushstroke(…, { character })` renders a brush's character: its size, angle, opacity and scatter jitter, seeded so a stroke always gives the same bytes, and a procedural paper grain. The grain is sampled where the stroke lies on the paper (`origin`, `unit`), so neighbouring strokes share one sheet. It is applied once to the finished stroke and keeps texture at full pressure, which is what a mouse reports. Without `character`, output is unchanged. `paintPathStroke` and `pathStrokeDabs` gain the matching `jitter` and `grain` options.
- The paper grain (`PaperGrain`, `grainHeights`, `grainCatch`) and the seeded noise (`TileableNoise`, `randSigned`, `seedFromString`) now live in `@pixerate/editor/paint`. The paint editor re-exports them unchanged.
- Canvas: new brushed strokes store a `brush.seed` and render with character. They use the preset's own size unless a size is chosen (`FreehandStrokeStyle.brushSize`, stored as `brush.size`). Strokes saved before have no seed, so they render exactly as before, at the stroke width. `renderShapeBrushstroke` takes the node's `origin` and `unit` for the grain. The React and Svelte `ShapeNode` pass the node's position. `renderCanvasBrushSwatch` draws a brush-menu preview, and `useCanvasBrushes` / `createCanvasBrushes` accept `{ swatches }`.
- Agents: `canvas.drawFreehand` with a `brush` uses the preset's size unless `width` is given.
