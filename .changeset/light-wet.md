---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor: glowing watercolour and backlit paper.

- **Glowing watercolour:** wet paint brushes (watercolour, gouache, wet oil) take `light.amount` and `light.pressure`. The light is a fifth mass channel in the wet simulation, so it flows, bleeds, pools, granulates and blooms with the pigment. Blot lifts it, wet blend and wet smudge move it, and re-wetting lifts dried light. When the paint dries, the light settles into the layer's light paint. Glowing paint shows its own hue, so a glowing glaze reads on dark paper. Plain wet paint over glowing paint dims it. Without light, the simulation gives exactly the bits it gave before. New Glow wash preset.
- **Backlit paper:** `backlight` (0..1) and `backlightColor` on the paper (`set_paper`, `get_paper`), and a Stained glass paper preset. Transparent glazes let the light through in their own colour; opaque paint and thick paint block it, and impasto clarity lets some through. The light through paint spills around it. Nothing is repainted. PSD export writes a "Backlight" Linear Dodge (Add) layer at the top.
- **Wet bakes:** gouache and oil now bake with their opacity in alpha (the same look over the paper), so backlight can tell them from glazes.
- **Wet engine:** two more planes per tile, about 7% more memory and 8% more time per step. The wet memory limit is now 328 tiles of 256 px (it was 352).
- **React and Svelte:** the Light slider for wet paint brushes, and Backlight with its colour in the paper panel.
