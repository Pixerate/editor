---
"@pixerate/editor": minor
---

The animation editor's Flair export writes cubic-bezier easings (`ease`, `ease-in`, `ease-out`, `ease-in-out`, the back eases and custom `{ type: 'cubic-bezier' }` curves) as one change with `ease: [x1, y1, x2, y2]` instead of sampling them into linear steps; Flair's own names are still used where they match within 1%. This needs Flair 0.36 or later: pass `curves: false` (also on the `export_flair_motion` and `export_flair_effect` agent tools) to sample them for older Flair. Adds `flairCurveFor` and the `FlairEase` type. Overshooting curves on colours, opacity and draw-on stay sampled, since their values cannot pass their ends.
