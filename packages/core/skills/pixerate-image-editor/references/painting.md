# Painting: strokes, mixing paint, the Mixer Brush and gradient paint

## Strokes

1. **Paint on its own layer** (`add_pixel_layer`), not on the Background (active on a new image, so
   strokes without `layerId` land there) unless asked: a layer can be faded, masked or deleted.
2. **Retouch through masks**, not the eraser (see `pixerate-image-selection-masking`).
3. **One stroke is one call and one undo step.** Send the path's points in order (a few points
   per brush diameter is enough; dabs are spaced by `brush.spacing`). Use `opacity` for the
   overall strength and `flow` for gradual build-up within the stroke.
4. **Limit paint with a selection**, or lock transparency (`set_layer_properties`
   `locks.transparency`) to paint only where the layer already has pixels.
5. **Mixing paint, the Mixer Brush and gradient paint**: `mix_colors` mixes named paints like
   pigment; `paint_stroke` `tool: "mixer"` picks up and smears the layer's colours; gradient paint
   changes colour along a stroke. See below.

## Mixing paint, the Mixer Brush and gradient paint

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

## Pitfalls

- `paint_stroke`, `fill_pixels` and `clear_pixels` need a visible pixel layer (or a layer with a
  raster mask and `channel: "mask"`); adjustment, group, shape, type, annotation and smart object layers can
  only be painted through their masks (and a smart object through `channel: "filter-mask"`).
  To paint a smart object's pixels, `edit_smart_object_contents` or rasterize it. A layer with
  `locks.pixels` refuses paint.
- `mix_colors` predicts a mix; it does not paint. To paint the mix, pass `blend: "pigment"` to
  `paint_stroke` (in `brush`) or `fill_pixels`, or set it on a layer.
- `pigment` and the painterly blend modes (`watercolor`, `tint`, `highlight`, `shadow`) have no Photoshop mode in the image editor's PSD exporter: `export_psd` writes those layers as Normal (the merged image keeps the look; `pigment` warns naming the layers). `import_psd` never produces them. Over transparent pixels there is nothing for `pigment` to mix with, so it lays the colour down as Normal.
- The Mixer Brush ignores `brush.blend` (including `pigment`; use its own `mixer.mixing` instead) and the opacity ceiling: each dab lays paint at
  `flow × opacity` over the pixels as they are now, so overlapping dabs build up. At `flow` 1
  each dab covers what is under it, the pickup then sees mostly the brush's own paint, and the
  stroke drifts towards the loaded colour; lower the flow for more blending.
- An empty, dry mixer (no reservoir, `wet` 0) paints nothing; the call succeeds with
  `bounds: null`. A mixer stroke over transparent pixels has nothing to pick up.
