# Oils and thick paint

- **Wet oil** (`oil-round`, `oil-flat`; any wet brush with `wet.medium: "oil"`) runs on the wet
  simulation as a thick, slow-drying medium: it barely flows, stays wet for minutes of simulated
  time, and the brush picks up and mixes the wet oil it meets (`behavior.pickup` / `mix`), so
  colours blend on the canvas. A layer takes the medium's wet settings the first time it holds
  wet paint; keep oil and watercolour on separate layers. `set_instant_dry` on makes every wet
  stroke dry as it ends (strokes stay exactly as laid).
- **Thick paint** (`engine: "impasto"`, category `impasto`) gives a layer relief (height) and
  material (gloss, metallic) next to its colour, lit at render time by `set_lighting`
  (azimuth, elevation, relief). Tools: `impasto-brush` (bristle ridges), `paint-tube` (blobs),
  `palette-knife` (scrapes the relief flat and smears the paint), `paint-roller` (flat stippled
  band), `gloop-pen` (glossy bead), `metallic-paint` (highlights in the paint's colour).
- **Loading and thinner**: `behaviour.wet.load` / `behaviour.thick.load` below 1 make the brush run out along a
  long stroke (dry-brush ends); `thinner` makes paint flatter and more transparent.
- **Light** is a view of the relief, not paint: move it (`set_lighting`) to read the texture
  (a low elevation, 15..30°, shows brushwork best) and pick the final light before exporting.
  `get_relief` reads a layer's relief; `flatten_relief` removes it (and any thin film) but keeps the colour.
- **Structural colour (thin-film iridescence)**: `iridescence: { thickness: 100..1000, pressureToThickness: 0..1, ior: 1.2..2.0 }`
  lays a dielectric thin film (`ThickChannels.film`) over thick or flat paint. Its interference
  colour comes from the optical path difference $2 \cdot n \cdot d \cdot \cos(\theta_t)$ between the surface normal,
  light direction (`set_lighting`) and view vector (`set_view_tilt` / `get_view_tilt`, or device
  gyroscope tilt on iPhone and iPad). Presets: `scarab-lacquer` (thick metallic beetle shell),
  `soap-film` (sheer rainbow wash whose hue follows pen pressure via `pressureToThickness`) and
  `pearl-glaze` (soft nacreous lustre on flat or raised paint).
- **Metallic paper**: `set_paper` `metallic` 0..1 makes the grain sparkle under the light.
