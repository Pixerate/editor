# Brush facets in the paint editor

`set_brush`, `paint_stroke` `brush` and `update_stroke` `brush` take the brush library's facets
(see `pixerate-brushes`). `get_brush` returns a brush as facets plus the `engine` it paints with.
The engine's flat settings (`particle`, `impasto`, `behavior`, `paint`…) are not arguments any
more; this is where each one went.

| Engine setting | Facet |
| --- | --- |
| Tip size, hardness, spacing, angle, roundness, opacity, flow, blend | `tip` |
| Smoothing, pressure, tilt, velocity, jitter, scatter, rotation, dabs per step (`count`), random `flip` | `dynamics` |
| Image tip | `tip` `{ shape: 'stamp', stamps: ['source:<id>'] }` (an image source from `add_brush_source`) |
| Texture inside the tip | `tip.grain` `{ source: 'sanded' or 'source:<id>', mode: 'texturised' or 'moving', scale, depth, contrast, invert }` |
| Grain, pick-up and mix (behavior), blender and smudge strength | `behaviour` (`grain`, `exchange`, `strength`, `distance`, `length`, `mixing`) |
| Mixer Brush reservoir | `behaviour.exchange.reservoir` (`load`, `refill`, `loadsColour`) |
| Wet engine (medium, water, pigment, body…) | `behaviour.surface` `wet` and `behaviour.wet` |
| Impasto (thickness, gloss, metallic, rim, clarity…) | `behaviour.surface` `thick` and `behaviour.thick` |
| Particle settings | `marks` `{ kind: 'particles', physics, render, count… }`; textured dots are `tip.stamps` on a `stamp` tip |
| Sticker spray | `marks` `{ kind: 'objects', density… }` and `tip.stamps` (sticker refs) |
| Bristles | `tip.shape` `bristle` and `tip.bristle` |
| A brush's own gradient (paint) | `colour.default` (a gradient); `unset: ['colour']` drops it |
| Light | `light` (`amount`, `pressure`) |
| UV-fluorescent ink (glows under `set_uv_light`, optional invisible ink) | `fluorescence` (`amount` 0..1, `invisible`); `unset: ['fluorescence']` drops it |
| Thermochromic ink (shifts toward `hotColor` where `paint_heat` warms the canvas) | `thermochromic` (`hotColor` `#rrggbb`, `threshold` 0.05..0.95); `unset: ['thermochromic']` drops it |
| Thin-film iridescence | `iridescence` (`thickness` 100..1000 nm, `pressureToThickness` 0..1, `ior` 1.2..2.0); `unset: ['iridescence']` drops it |
| Ghost paint (linger, smear) | `ghost` (`linger`, `smear`); `unset: ['ghost']` drops it |

## Examples

- A softer, bigger airbrush for one stroke: `paint_stroke` `{ brushId: "airbrush", brush: { tip:
  { size: 80, hardness: 0 } }, points }`.
- A dirty round that picks up more: `set_brush` `{ id: "dirty-round", behaviour: { exchange: {
  pickup: 0.5, mix: 0.6 } } }`.
- Elastic ribbons with star dots: `set_brush` `{ id: "spring-ink", tip: { shape: "stamp", stamps:
  ["editor:star"] }, marks: { kind: "particles", physics: "elastic", render: "ribbon" } }`.
- A brush's own gradient off again: `set_brush` `{ unset: ["colour"] }`.
