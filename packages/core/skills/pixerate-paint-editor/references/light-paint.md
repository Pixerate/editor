# Light paint

Light paint is paint that gives off light: neon, light painting, glow-in-the-dark, glowing glassy
tubes, glowing watercolour. Any dab, particle, bristle, Mixer Brush, impasto or wet paint brush
lays it with `light.amount` above 0 (`set_brush`); the Light category presets are ready-made
(`glow-gel`, `neon-marker`, `light-airbrush`, `spark-trail`, `light-ribbon`, `flame-ribbon`,
`neon-strand`, `smoke-ribbon`, `bokeh-dots`, `twinkle-sparks`, `glow-wash`, `highlighter`; the
particle ones are tuned in [particle-brushes.md](particle-brushes.md)).

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
- **Glassy beads** (impasto): `behaviour.thick.rim` (engine `impasto.rim`) makes a bead's light stronger at its edges, where its
  surface turns away (backlit glass); `behaviour.thick.clarity` lets the middle of a bead show the layers
  below while its edges stay solid. `glow-gel` uses both: paint loops with a distance-mapped
  gradient (`set_paint`) for glowing glass tubes.
- **Crossings.** Beads on one layer fuse where they cross (their heights combine by maximum), so
  clarity only shows other layers: paint one loop per layer for glassy crossings.
- **Highlighter** (`highlighter`): fluorescent ink. A transparent chisel marker that multiplies,
  so it glows a little brighter than the paper and text under it stays dark. Paint it on the
  layer that holds the text (a tip blend works within its layer), and turn that layer's spill off
  (`set_light_spill` `radius` 0): fluorescent ink does not light its surroundings, and spill would
  wash the text out.
- **Light painting** (long-exposure trails, neon signs, fire): set dark paper (`set_paper`
  `color`, e.g. `#0b1020`), then paint with the Light presets in bright, saturated colours;
  white light reads as a hot core, so lay a coloured stroke first and a thinner, lighter one over
  it. Ribbons (`light-ribbon`, `flame-ribbon`) read best in long sweeping strokes with times;
  `neon-strand` in steady strokes; `bokeh-dots` and `twinkle-sparks` as accents last. Put each
  colour family on its own layer so you can tune its spill (`set_light_spill`: larger radius for
  haze, 0 for crisp). Check with `export_image` before adding more: light adds up fast.
- **Spill vs a glow layer style.** Spill takes each stroke's colour and strength. For a one-colour
  halo around everything on a layer, use a blend or an effect layer instead.
- **Glowing watercolour** (wet paint brushes with `light.amount`, e.g. `glow-wash`): the light is
  part of the wet paint. It flows, bleeds, pools at the wash's edges, granulates and blooms with
  the pigment (`advance_wet_paint`), blot lifts it, wet blend and wet smudge move it, and
  re-wetting lifts dried light back into the water. While wet, `get_light` shows it as it is now;
  when the paint dries (`dry_paint`, or saving) it settles into the layer's light and is ordinary
  light paint. Glowing paint shows its own hue whatever is under it, so a glowing glaze on dark
  paper reads as its colour, glowing; a plain glaze there only darkens. Plain wet paint over
  glowing paint dims it by how much light the new film lets through. Add water and the other
  wet tools lay no light. Paint glowing washes on dark paper (`set_paper` `color`).
- **Not yet:** sticker sprays and stroke layers refuse light above 0, with the alternatives.
- **Backlit paper** (`set_paper` `backlight` 0..1 and `backlightColor`, or the `stained-glass`
  preset): light from behind the paper, like a lightbox. It is a paper setting, not light paint:
  nothing is repainted, and each pixel lets the light through by how transparent its paint is.
  Transparent glazes (watercolour, airbrush, a marker below full opacity) glow in their own
  colour; opaque paint (gouache, oil, solid ink) and thick paint block it, and impasto
  clarity lets some through. The light through paint spills softly around it. Bare paper
  glows towards white. Exact for watercolour straight on the paper; layers over other layers
  and blend modes are approximated (every layer is read as a film over the paper). For stained
  glass: strong transparent glazes for the panes, then opaque black lines on a layer above.
- **PSD.** `export_psd` writes each layer's pixels with their glow, and its spill as a
  "‹layer› light" Linear Dodge (Add) layer directly above it; backlit paper adds a "Backlight"
  Linear Dodge (Add) layer at the top. Re-importing gives plain pixel layers, not editable light.
