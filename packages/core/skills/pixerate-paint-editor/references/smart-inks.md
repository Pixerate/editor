# UV-fluorescent and thermochromic smart inks

Two smart inks extend any dab, bristle, particle or wet brush with per-layer channels that react to
the virtual UV blacklight (`uvLight`) or the document's thermal heat field (`heat`).

## UV-fluorescent ink (`fluorescence`)

- **Facet**: `fluorescence: { amount: 0..1, invisible?: boolean }` (or a bare number `0..1` as a
  shorthand for `{ amount }` in brush specs). Preset: `uv-marker` (`amount: 0.9, invisible: true`,
  cyan `#00ffd5`).
- **How it paints**: each stroke writes its fluorescent emission (`[r, g, b, alpha * amount]`) into
  the target layer's `doc.fluor[layerId]` surface in layer space.
  - With `invisible: false` (default), the stroke lays normal daylight pigment onto the layer's
    surface **and** stores UV emission, like a fluorescent highlighter that is visible in daylight
    and glows under blacklight.
  - With `invisible: true`, no daylight pigment is written to the layer's surface — the stroke is
    completely invisible under normal light (`uvLight.on: false`) and only appears when the UV
    blacklight is switched on.
- **Virtual UV blacklight** (`set_uv_light`, `get_uv_light`):
  - `on`: switches the blacklight on or off (default `false`).
  - `strength` (`0..2`, default `1`): scales both the direct UV emission on the layer and the
    Linear Dodge (`id::uv`) halo spill around fluorescent strokes.
  - `ambient` (`0..1`, default `0.15`): dims the paper and all normal daylight paint to `ambient`
    when `on` is `true` so fluorescent strokes pop against the darkened room.

## Thermochromic ink (`thermochromic`)

- **Facet**: `thermochromic: { hotColor: '#rrggbb' | null, threshold?: 0.05..0.95 }` (default
  `threshold: 0.5`). Preset: `thermo-ink` (`hotColor: '#ff7a18', threshold: 0.45`, cold `#1e2a78`).
- **How it paints**: each stroke lays its cold colour onto the layer as usual and writes its target
  `hotColor` RGB and `threshold` into `doc.thermo[layerId]` where the stroke's alpha lands.
- **Document heat field** (`paint_heat`, `advance_heat`, `clear_heat`, `get_heat`):
  - Stored on a 1/4-resolution grid across the canvas (`0..1` temperature).
  - `paint_heat` warms (or with `temperature: 0` cools) along `points` with a smooth falloff of
    `radius` document pixels (default `24`). One undo step.
  - `advance_heat` runs `steps` (default `10`) of 5-point Laplacian diffusion + Newtonian cooling
    so warm spots spread outward and gradually cool back to `0`. Not an undo step.
  - `clear_heat` cools the entire canvas to `0` at once (one undo step when warm).
  - At render time, thermochromic pixels smoothly interpolate from their cold colour to `hotColor`
    in a `±0.15` band around `threshold`.
  - **Wet-paint interaction**: any wet paint under hot cells (`temperature >= 0.5`) dries in place
    automatically when `paint_heat` or `advance_heat` warms it.

## Lifecycle

- Both per-layer channels (`fluor` and `thermo`) follow the layer through `duplicate_layer`,
  `merge_layer_down`, `clear_layer`, `remove_layer`, `extend_canvas` (which also shifts the heat
  field) and symmetry guides, and are saved in paint documents (`fluor`, `thermo`, `heat`,
  `uvLight`).
- Stroke layers (`type: "strokes"`) refuse fluorescent and thermochromic brushes; paint them on a
  regular pixel layer.
