---
'@pixerate/editor': minor
'@pixerate/editor-svelte': minor
'@pixerate/editor-react': minor
---

Image editor selections:

- Marching ants stay one screen pixel wide when a host shows the canvas zoomed by a CSS transform (`hostScale`); they were drawn one CSS pixel wide, so a scaled studio drew them several pixels thick. The draft lasso path gets the same fix.
- The ants march: `startMarchingAnts(tick)` steps `RenderOptions.antsOffset` every `MARCHING_ANTS_STEP_MS` (standing still under `prefers-reduced-motion`), and the Svelte and React `ImageEditorCanvas` run it while a selection shows.
- `select_region` takes `shape: 'polygon'` with `points` (the lasso), so agents can select a subject's contour instead of its bounding box; `layer_via_copy` says the new layer takes the selection's shape.
- `layerPanels` offers the Selection panel with any layer active, not only with none.
