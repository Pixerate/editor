---
"@pixerate/editor-react": minor
---

Canvas node explosion: new `useCanvasExplosionState` hook (the same declarative state and lifecycle as the Svelte rune, StrictMode-safe). `useCanvasExplosion` reaches parity with the Svelte coordinator on core's `computeCanvasExplosionLayout`: `directional` displacement is now the default (it was off unless asked for), `dagre` and `none` strategies, parent-to-child edges (`connectParentToChildren`, default `all`), staggered fan-out and reverse collapse, `toggleExplode`, reactive `explodedNodeIds`, `explodeNode` / `collapseNode` return booleans, displaced nodes are restored exactly on collapse, and options `getNodesBounds` / `onSave`. The explosion layout, state controller and agent tools are re-exported.
