---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor: light paint.

- **Laying light:** any dab, particle, bristle, Mixer Brush or impasto brush lays light with `light.amount` (and `light.pressure`) into a per-layer light channel (`doc.light`).
- **It moves like paint:** a twin of each stroke on a lit layer moves the light, so plain paint over glowing paint dims it, erasers remove it, and smudges, blenders, the knife, the Mixer Brush and pick-up brushes carry it with the colour.
- **Rendering:** the paint glows in its own colour whatever the lighting, and spills, blurred, onto everything around and below it (per-layer `radius` and `strength`, saved with the document, not undo steps).
- **Glassy impasto:** `impasto.rim` brightens a bead's light at its edges, and `impasto.clarity` lets its middle show the layers below (stored in material B and A).
- **Presets:** a Light category: glow gel, neon marker, light airbrush and spark trail. Brush thumbnails show light on dark paper.
- **Layer operations:** light is undone, saved and loaded, replayed, duplicated, merged down, cleared and dimmed by fills.
- **PSD export:** layers are written with their glow, plus a "‹layer› light" Linear Dodge (Add) layer for spill.
- **Not yet:** wet and sticker brushes and stroke layers refuse light above 0.
- **Agent tools:** `get_light`, `set_light_spill` and `clear_light`; `set_brush` takes `light`, `impasto.rim` and `impasto.clarity`, and `list_brushes` reports each brush's light.
- **React and Svelte:** Light (and Rim, Clarity) sliders and a pressure toggle in the brush panel, and a Light section (spill, Clear light) in the layers panel.
