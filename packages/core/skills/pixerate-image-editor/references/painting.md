# Painting: mixing paint, the Mixer Brush and gradient paint

Read this before `mix_colors`, a `paint_stroke` with `tool: "mixer"`, or gradient paint
(`set_paint` / `paint_stroke` `paint`).

1. **Mix paint colours with `mix_colors`** when the user names paints and amounts ("two parts
   ultramarine to one part yellow", "a tint of red"). It mixes like pigment, so blue and yellow
   make green and white makes a tint, where averaging RGB gives grey or a dull pastel. Pass its
   `mixed` hex as the `color` of `paint_stroke` or `fill_pixels`. Give a strong dark paint a
   `strength` above 1 when a little of it should tint a lot of white.
2. **Blend and smear with the Mixer Brush** (`paint_stroke` with `tool: "mixer"`) when the
   user wants paint to pick up and drag the colours already on the layer (wet blending, softening
   an edge, pulling one colour into another). `mixer.wet` is how much it picks up (0 paints only
   the loaded colour), `mixer.mix` how far each dab leans from the loaded colour to the picked-up
   one, and `mixer.load` below 1 makes long strokes run dry. Use `mixing: "pigment"` for
   painterly results (blue dragged through yellow goes green); keep `rgb` for retouching, where
   colours should stay between the two you started with. A brush with `blend: "pigment"` mixes
   its one colour into the layer; only the mixer carries picked-up colour along the stroke. A `brush.flow` around 0.3..0.6 keeps
   some of the canvas under each dab and blends more naturally than 1. The stroke samples the
   target layer only, so paint on the layer that holds the colours to blend.
3. **Keep the mixer stateless unless you need a carried load.** By default each mixer stroke
   loads `color` (or the foreground) and is cleaned afterwards, so every call is independent and
   replays the same. To carry dirty paint from stroke to stroke, pass `mixer.loadEachStroke:
   false` and `cleanEachStroke: false`, start with `load_mixer_brush`, read the brush with
   `get_mixer_brush` when unsure, and reset it with `clean_mixer_brush`.
4. **Gradient paint** (colour that changes as the stroke goes): `set_paint` with `{ type:
   "gradient", stops, map }`, or `paint_stroke` `paint` for one stroke (brush only). `map.by`
   `distance` (default 300 px, mirrored) for drag-it-out colour, `pressure`, `direction`,
   `across-tip`, `random`; stops may be `"paint"` / `"secondary"` (foreground / background).
