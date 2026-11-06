---
"@pixerate/swift": patch
---

Speed up live wet and dry painting in the Swift paint engine and UI without changing simulation or rendering results:

- Track wet-tile shading validity per slot (`slotStamp`) and per changed base/light tile (`!==`) instead of invalidating all active tiles in the lane on every brush dab, and emit the exact changed tile rectangles from `updateSurfaces` so pointer moves only shade and recomposite the touched tiles (~22× faster pointer moves on multi-tile wet canvases).
- Route `PaintLiveStroke.push`, `PaintWetLayers.tick`, `advance`, and `dry` through `syncDisplaysGpu` when the Metal shader is active, parallelize CPU tile shading across `wetParallel`, and flush tile halo border copies lazily in parallel before `step` and `snapshot`.
- Add a bit-identical fast path in `pixerate_wet_step` for dry 4-cell blocks inside active tiles and skip neighbour pigment face loads on dry cells, plus raw-pointer fast paths in `WetFilm.shadeTile`, `RasterCompositor.blendTile`, `TiledSurface.contentBounds` (memoized), and `PaintCanvasPresenter.render`.
- Separate canvas frame ticks (`revision`) from non-canvas UI state (`stateRevision`) in `PaintEditorModel`, read wet panel sliders via `wetLayerSettings` instead of scanning every active tile via `world.stats`, and make the wet simulation loop adaptive during live strokes.
