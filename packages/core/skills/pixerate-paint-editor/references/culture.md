# Biopaint (mycelial ink)

Biopaint (`culture` facet on any dry dab, particle, bristle, Mixer Brush or impasto brush; presets
`mycelial-ink`, `rot`, `foxfire`) seeds living mycelial spores along a stroke when it commits. Fine
hyphal threads creep outward from the stroke, branch into tapering filaments, fuse into an
anastomosing network (`fuse`), steer toward existing paint on the layer (`appetite`), digest and
fade what they eat (`digest`), and carry the digested colour out into new territory.

- **How it works.** Each layer with a colony keeps its living hyphal `tips` and a 1-channel
  `occupancy` map in `doc.cultures[layerId]`. The simulation runs in deterministic fixed-point
  integer arithmetic (`CULTURE_FP = 256`, 1024-step integer trig table, 32-bit integer hash):
  growing 100 steps once produces the exact same pixels and tip state as growing 50 steps twice.
- **Chemotaxis, feeding and colour transport.** On each tick, every living tip senses ahead along
  three rays (`-30°`, `0°`, `+30°`), reading foreign paint alpha (`occupancy === 0 && alpha > 0`),
  paper grain, stencil barriers, and existing mycelium occupancy (ignoring occupancy where the
  layer's alpha was erased so erased threads never leave ghost walls). When a tip crosses foreign
  paint, it gains energy (letting it travel far beyond its bare-canvas `reach`), fades the paint by
  `digest`, and shifts its carried RGB toward the paint it ate.
- **Anastomosis (`fuse`).** When a growing tip meets an existing thread outside a food source, it
  rolls against `fuse`: on success it draws a connecting bridge segment and stops cleanly, forming
  closed loops instead of tangling.
- **Bioluminescence (`glow`).** When `glow > 0` (`foxfire`), each thread segment also writes into
  `doc.light[layerId]`, so the growing network glows and spills light onto dark paper.
- **Barriers and limits.** Mask stencils act as walls that tips turn away from; a layer with
  `locks.transparency: true` restricts growth to existing non-transparent paint; tips die at the
  canvas edge. A layer caps at `2,000` living tips and `200,000` segments (`status: "capped"`).
- **Stepping and undo.** In headless/agent use, nothing grows until you call `grow_cultures`
  (`steps` 1..2000, default 40), which commits as a single undo step and records a `'culture-grow'`
  event for exact scaled replay in `export_high_res`. `remove_cultures` kills living tips while
  leaving threads already drawn as paint. `set_culture_options({ growWhileClosed: true })` records a
  timestamp on save so reopening catches up elapsed growth as one `"Growth while closed"` undo step.
- **Presets.**
  - `mycelial-ink`: fine dark ink (`reach` 12, `branching` 0.4, `appetite` 0.5, `digest` 0.25, `fuse` 0.7).
  - `rot`: high-appetite, high-digest decomposer (`appetite` 0.8, `digest` 0.75, `reach` 16).
  - `foxfire`: bioluminescent green mycelium (`glow` 0.85, `reach` 15) for dark grounds.
- **Refusals.** Wet brushes, sticker sprays, tool brushes (`eraser`, `blender`, `smudge`) and stroke
  layers refuse brushes with `culture`. `grow_cultures` refuses stroke layers, effect layers, and
  wet layers holding wet paint (`dry_paint` first).
