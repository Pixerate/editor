---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor agents now work directly on the canvas. `PaintDirector` acts out `paint_stroke` live with the agent's cursor (paced by the points' times, still one undo step), rubs `fill_layer` across the sheet and starts `replay_strokes` from the strokes it copies. Pass `director` to `createPaintEditorToolProvider`, and `presence` to `<PaintEditor>` / `<PaintCanvas>` (React `usePaintDirector`, Svelte `createPaintDirector`). `PaintEditorController.checkPoints` is now public.
