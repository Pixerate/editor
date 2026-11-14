---
"@pixerate/editor": minor
---

3-D particles for data: counts drawn as grains that settle into layers (closes #806).

- `settleParticles({ container, layers, size, gap, jitter, seed })` (`/chart`, also `/three`): packs each layer's particles into a container, level by level from the floor, each level's cells filled in a seeded order and each particle wandering only within its own cell — no overlaps, every particle inside, the same result for the same seed. Layers follow on from each other (a ragged top, like sediment) and come back with their band (`bottom`, `top`), `thickness` and how full their top level is; particles past `container.height` are counted in `overflow`.
- `settleFrame(settled, p, { drop, fall })`: every particle's position at progress `p` — dropping in order, layer by layer then level by level, each falling for `fall` of the progress (so the last still visibly falls), speeding up as it falls; frame-pure, `p = 1` exactly at rest, with `visible` for particles that have not started.
- `layoutChartParticles(spec, { unit, order, width, depth, size, seed })`: the first visible series as a pile — a layer per category in its slice colour, one grain per `unit` (default a round unit for about 600 grains), ordered by category, largest or smallest first — with labels ("Search · 4,600 (92 grains)") and notes saying what a grain stands for.
- `createChart3dScene` / `renderChart3d` take `particles` (the options above, plus `outline`): one instanced mesh with a colour per grain, an outline of the container, a label beside each layer, `pick` returning the category and the grain (`instance`), `focus` fading the other layers, `anchor` on a visible grain of the layer, and `setProgress(p)` to drop the grains in (then `render`).
- Demo: Particles and Drop in on the Charts tab's 3-D view.
