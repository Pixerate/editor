# Antimatter paint

Antimatter paint (`marks: { kind: "antimatter", ... }`, engine `antimatter`; presets `antimatter`,
`antimatter-flare`, `antimatter-charge`) is a reactive mark brush that does nothing over bare
canvas, and detonates wherever it touches existing paint across every visible layer.

- **Fuel and firing.** Each dab measures fuel (`0..1`) from the **pre-stroke** pixels of every
  visible pixel layer (layers in hidden groups are ignored): tip coverage times the combined
  visibility-weighted alpha $1 - \prod (1 - \alpha_i \cdot \text{opacity}_i)$, where each layer's
  opacity is multiplied by its groups' opacities (paint in a half-opaque group is half the fuel). The first dab whose
  fuel reaches `threshold` (default `0.1`) fires immediately so a single tap works; further blasts
  fire every `blastSpacing` tip diameters (default `2`) of travel over paint. Over bare canvas,
  `blasts` is `0`, `bounds` is `null`, and no undo step is recorded.
- **Heat field and single inversion.** Each blast writes a noise-edged radial profile (`0..1`) into
  one stroke-wide `heat` field shared across all layers and combined by **maximum**, so overlapping
  blasts in the same stroke invert the core once instead of cancelling back.
- **What changes on each visible editable layer.** Each target layer is recomposited from its own
  pre-stroke pixels:
  - **Core (`heat` > 0.55)**: inverts the layer's colours (`invert` `0..1`, `invertMode` `'rgb'` or
    `'oklab'` — `oklab` flips lightness and hue so mid-grey `#808080` visibly changes too) and
    destroys `annihilate` (`0..1`, default `0.25`) of its alpha (unless `locks.transparency` is on,
    which preserves alpha while inverting colour).
  - **Ring (`heat` 0.12..0.68)**: darkens and desaturates paint towards soot (`scorch` `0..1`,
    default `0.6`).
  - **Thick paint (`doc.thick`)**: on layers with impasto relief, the core lowers `height` and raises
    a rim around the blast (`crater` `0..1`, default `0.5`).
  - **Light paint (`doc.light`)**: blasts clear existing light in the core across target layers.
  - Light and relief the blasts don't reach stay exactly as they were, including on a layer whose
    pixels change elsewhere.
- **Active layer extras.** Bare-canvas soot fade and ballistic sparks (`sparks` `0..1`, `sparkReach`
  `0.5..8` tip diameters) land on the **active layer only**, starting white-hot and cooling into the
  stroke's paint colour (or gradient / effect paint). When `light.amount > 0` (`antimatter-flare`),
  sparks also write glowing trails to the active layer's `doc.light`. Mask stencils contain the
  blast and sparks.
- **Locked, stroke and sticker layers.** Uneditable visible layers (`locks.pixels`, stroke layers,
  sticker layers, effect layers) still count as fuel so blasts fire over them, stay unchanged, and
  are reported in `antimatter.skippedLayers`.
- **Single undo step and replay.** Any visible wet paint dries first in the same undo step, and all
  changed layers commit together. `RecordedStroke.targets` records the stroke's **fuel layers** (every
  visible pixel layer when it was painted, locked and stroke layers included). `replay_strokes` and
  replays read fuel from exactly those layers, even if they are hidden now, and change the editable
  ones. Layers added later are neither fuel nor changed. Passing `layerId` to `replay_strokes`
  drops the recorded targets and uses the layers visible now.
- **Presets.**
  - `antimatter`: balanced blast (`blastRadius` 2.5, `scorch` 0.6, `annihilate` 0.25, `sparks` 0.5).
  - `antimatter-flare`: bright spark burst with glowing light trails (`sparks` 0.9, `sparkReach` 4.5,
    `annihilate` 0.1, `light.amount` 0.7).
  - `antimatter-charge`: wide, deep craters spaced farther apart (`blastRadius` 4, `blastSpacing` 3.5,
    `annihilate` 0.45, `crater` 0.8, `invertMode: "oklab"`).
