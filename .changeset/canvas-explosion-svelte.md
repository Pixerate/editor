---
"@pixerate/editor-svelte": minor
---

Canvas node explosion: new `createCanvasExplosionState` rune (declarative `activeId` / `collapsingId`, `shouldRenderChildren`, timed collapse, cleaned up with its component) for canvases derived with `$derived`. `createCanvasExplosion` now runs on core's `computeCanvasExplosionLayout`: the displacement math and its option types come from `@pixerate/editor/canvas` (the local copy is gone; `calculateDirectionalDisplacement` gains `minY` / `maxY` enforcement and row lanes), the caller's child objects are no longer mutated, parent edges get stable ids (`explode:<parent>:<child>`) instead of random UUIDs, the dagre strategy ranks children by their parent edges, a second `explodeNode` while one is animating is refused, and `explodeNode` throws when a child id is already on the canvas. The explosion layout, state controller and agent tools are re-exported.
