---
"@pixerate/editor-svelte": minor
---

Add canvas node explosion and collapse capabilities to `@pixerate/editor-svelte/canvas`:
- `createCanvasExplosion` rune managing node expansion lifecycle, snapshots, and reversibility.
- Spatial layout displacement solvers: `calculateDirectionalDisplacement` and `calculateReflowDisplacement` (Dagre-based).
- Parametric trajectory path generators: `createFanOutTrajectory`, `linearTrajectory`, and `createBezierTrajectory`.
- Multi-node coordinated transition runner `runMultiNodeTransition` with zero per-frame array allocations.
