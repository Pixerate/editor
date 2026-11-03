# Light paint

Light paint is paint that gives off light: neon, light painting, glow-in-the-dark, glowing glassy
tubes. Any dab, particle, bristle, Mixer Brush or impasto brush lays it with `light.amount` above 0
(`set_brush`); the Light category presets are ready-made (`glow-gel`, `neon-marker`,
`light-airbrush`, `spark-trail`).

- **What it does.** Each layer keeps a light channel next to its colour. The light's colour is the
  paint's colour at that pixel, so recolouring paint recolours its light. It glows (the paint
  itself is brighter, whatever `set_lighting` says) and spills onto everything around and below it
  in each stroke's own colour.
- **It behaves like paint.** Plain paint over glowing paint dims it; erasers remove it; smudges,
  blenders, the knife, the Mixer Brush and pick-up brushes carry it with the colour they move. A
  smeared neon line glows along the smear. `clear_light` takes it away and keeps the colour.
- **Spill** (`set_light_spill`, per layer): `radius` px (default 24; 0 turns it off) and
  `strength` 0..2 (default 1). It is not an undo step and repaints nothing; it shows the
  painting as committed, so a stroke's spill appears when the stroke ends. It spills onto
  everything below, paper included, so it reads best on dark paper (`set_paper` colour).
- **Glassy beads** (impasto): `impasto.rim` makes a bead's light stronger at its edges, where its
  surface turns away (backlit glass); `impasto.clarity` lets the middle of a bead show the layers
  below while its edges stay solid. `glow-gel` uses both: paint loops with a distance-mapped
  gradient (`set_paint`) for glowing glass tubes.
- **Crossings.** Beads on one layer fuse where they cross (their heights combine by maximum), so
  clarity only shows other layers: paint one loop per layer for glassy crossings.
- **Spill vs a glow layer style.** Spill takes each stroke's colour and strength. For a one-colour
  halo around everything on a layer, use a blend or an effect layer instead.
- **Not yet:** wet brushes (glowing watercolour is planned, #494), sticker sprays and stroke layers
  refuse light above 0, with the alternatives.
- **PSD.** `export_psd` writes each layer's pixels with their glow, and its spill as a
  "‹layer› light" Linear Dodge (Add) layer directly above it. Re-importing gives plain pixel
  layers, not editable light.
