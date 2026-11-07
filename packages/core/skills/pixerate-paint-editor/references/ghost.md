# Ghost paint and invisible ink

Ghost paint is wet paint (`behaviour.surface: "wet"`) with a `ghost` facet (`linger` 0.5..60 s,
default 4; `smear` 0..1, default 0.3). While wet it looks and behaves like any watercolour,
gouache or wet oil: it flows with the water and its colour mixes visibly with the paint it meets.
Then its own colour fades away completely, leaving only what it did to the paint already on the
layer — a smear where it lifted and dragged that paint along. On bare paper it leaves nothing at
all.

## Presets and settings

- **`ghost-wash`**: transparent watercolour ghost (`linger: 4`, `smear: 0.35`).
- **`ghost-gouache`**: opaque gouache ghost that mixes strongly while wet, then vanishes (`linger: 4`, `smear: 0.45`).
- **`ghost-oil`**: slow wet oil ghost (`linger: 8`, `smear: 0.55`).
- **`invisible-ink`**: a ghost brush with `behaviour.wet.pigment: 0` and `smear: 0.6`. Nothing
  shows on bare paper; it reveals itself only as a smear in the wet or dried paint it crosses.
  Because it lays no pigment, it lays no tracer, needs no fade, and does not interrupt another
  ghost already fading on the layer.
- Any wet paint brush becomes a ghost brush with `set_brush` `{ ghost: { linger, smear } }`;
  `unset: ["ghost"]` makes it ordinary wet paint again.

## Working method

1. **Paint on the layer that holds the paint you want to disturb.** Wet paint is per layer:
   a ghost stroke on a new empty layer has nothing to smear and vanishes into bare paper.
2. **Watch it mix while wet.** Call `advance_wet_paint` in short steps (`seconds: 0.5..1`) and
   `render_preview` to see the ghost colour mixing and flowing with the layer's paint, and check
   `get_wet_paint` (`layers[].ghost.remaining`, from 1 down to 0) to see how much of the fade is
   left.
3. **Finish the fade.** Advance past `linger` seconds, or call `dry_paint` (which finishes the
   ghost fade at once before baking). With `smear: 0`, ghost paint passes over dried paint and
   leaves it untouched; with `smear > 0`, it lifts dried paint along its path (`rewet` scaled by
   `smear`) and drags both wet and lifted paint along the stroke.

## Pitfalls

- **Wet paint is per layer.** Ghost paint only meets paint on its own layer. Painting a ghost
  stroke on a new empty layer leaves nothing behind once it fades.
- **One ghost colour per layer at a time.** Painting a ghost stroke in a new colour on a layer
  whose earlier ghost is still fading finishes the earlier ghost's colour fade at once (keeping
  its smear) before starting the new colour.
- **Ghost and light paint cannot share a layer.** The ghost tracer uses the wet layer's light
  channel, so a ghost stroke is refused on a layer that has light paint (`clear_light` or paint on
  another layer), and a light brush is refused on a layer where ghost paint is still fading
  (`dry_paint` first or use another layer). Once the ghost has faded, the layer is free again.
- **One solid colour per stroke.** Gradient paint, effect paint and multi-colour are refused on
  ghost brushes.
