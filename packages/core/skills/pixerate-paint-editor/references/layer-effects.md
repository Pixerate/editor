# Layer effects (layer styles)

The paint editor's layers take the same live effects as the image editor's: outer glow, inner
glow, drop shadow, inner shadow, stroke, bevel & emboss, satin, and colour, gradient and pattern
overlays, with the same settings, defaults and limits. They are stored on the layer, drawn from its
pixels each time the painting is composited (so they follow every later stroke, smudge and
erase), saved with the document, undone one step per change, and written to PSD as layer styles.

- **Tools.** `add_layer_effect` (kind plus `settings`; returns the `effectId`),
  `update_layer_effect` (only the settings you give), `remove_layer_effect`,
  `set_layer_effects_enabled` (all on or off, and Scale Effects), `list_layer_effects` (read
  them). They take pixel, stroke, sticker and group layers; a fully locked layer refuses them.
- **Glow you can still change.** Paint a light shape on its own layer, then `add_layer_effect`
  `outer-glow` with `settings: { fill: { type: "color", color: "#22d3ee" }, size: 30, spread: 0.1,
  blend: "linear-dodge", opacity: 0.9 }`. Change its colour or size later with
  `update_layer_effect`, without repainting. `inner-glow` lights the inside of the shape from its
  edge (`source: "edge"`) or centre.
- **Glow style vs light spill.** Light paint (`light.amount`, the Light brushes) spills each
  stroke's own colour by its own strength. A glow style is one colour, one size, around everything
  on the layer: use it for a uniform halo (a neon sign's tube, a sticker's outline, a title), or as
  well as spill for a stronger, adjustable bloom. For the light-painting look on dark paper,
  `linear-dodge` (or the default `screen`) glows add light; `normal` paints a solid halo.
- **Shadows and bevels** follow the default global light (120°, 30° altitude) unless you give
  `angle` with `useGlobalLight: false`; the paint editor has no global light of its own (its
  `set_lighting` lights impasto relief, not effects).
- **Wet paint** shows its effects as it is now; they redraw as it flows and dries.
- **PSD.** `export_psd` writes each layer's effects as its layer style (Photoshop reads them as
  editable effects); the merged image matches the editor.
