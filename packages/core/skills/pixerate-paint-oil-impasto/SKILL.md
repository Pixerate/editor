---
name: pixerate-paint-oil-impasto
description: The oil and impasto workflow in the Pixerate paint editor - a toned ground on canvas, blocking in thin and building to thick (fat over lean), mixing colours as real pigment, blending wet oil on the canvas, thick impasto paint with relief from brushes, tubes and palette knives, lighting the relief, and keeping thick passages on their own layers. Use when asked to paint in oils or acrylics, paint thickly, add impasto or texture, use a palette knife, mix paint, block in a painting, or paint with visible brushwork, or when set_lighting, get_relief, mix_colors or the oil, impasto and bristle brushes are available. Load with pixerate-paint-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-paint-editor
---

# Painting in oils and impasto

An oil painting is built in passes: a toned ground, a thin block-in of the big shapes and
values, then thicker, more opaque paint for the forms, and the thickest paint last for the
lights. Wet oil (`oil-round`, `oil-flat`) barely flows and stays wet, so the brush picks up and
mixes what it meets. Thick paint (the `impasto` brushes) also gives the layer relief, which a
movable light shows at render time.

This skill is the method. `pixerate-paint-editor` has the full tool reference and
`references/oils.md` the media's detail.

## Goal and quality bar

- Lean to fat: thin paint first, thick paint on top; the thickest paint in the lights.
- Colours mixed as pigment (`mix_colors` predicts Kubelka-Munk mixes: blue and yellow make
  green, white tints), from a small palette.
- Relief where it reads: highlights and focal areas thick, shadows and background thin
  (`get_relief` `maxHeight` on the thick layer).
- One light on the relief, chosen deliberately (`set_lighting`), and the thick passages on
  their own layers so they can be changed.

## Inputs to confirm

- **Subject and palette.**
- **Texture:** smooth and blended, or heavy impasto with visible brushwork and knife marks.
- **Light direction** for the relief, if the user has one in mind (default top-left).

## Working method

1. **Ground.** `set_paper` `cotton-canvas` or `fine-linen` (or `gesso` for a smooth panel);
   `fill_layer` a mid-tone ground (a warm earth or grey) on the bottom layer.
   **Check:** `get_canvas_info` paper; `pick_color` shows the ground.
2. **Mix the palette.** `mix_colors` for each mixture (read `mixed`), `add_swatch` to keep them;
   `color_harmony` around a key colour if needed.
3. **Block in thin.** `add_layer` "Block-in"; `oil-flat` or `bristle-flat` with large strokes,
   the big shapes and values only, darks first.
   **Check:** `list_strokes` shows the thin brushes; `render_preview` reads as a simple value
   study.
4. **Build the forms.** `oil-round` on a new layer, more opaque and more colour; let the brush
   pick up and blend wet paint (`behavior.pickup` 0.3-0.6) for soft turns of form; `blender`
   for transitions.
5. **Thick paint last.** `add_layer` "Impasto"; `impasto-brush` for ridged strokes,
   `palette-knife` to scrape and smear, `paint-tube` for blobs, in the lights and focal areas.
   **Check:** `get_relief` on that layer has `maxHeight` well above 0.
6. **Light the relief.** `set_lighting` `azimuth` (degrees clockwise from the top: 315 top-left,
   45 top-right), `elevation` 15-30 to show brushwork, 40-60 for a calmer surface.
   **Check:** `get_relief` `lighting` is what you set; `render_preview` to look.
7. **Finish.** Details and accents; export. `flatten_relief` only if the user wants the colour
   without texture.

## Decision table

| Want | Brush or tool |
| --- | --- |
| Large, thin block-in | `oil-flat`, `bristle-flat` |
| Soft blended form | `oil-round` with pick-up; `blender` |
| Visible bristle ridges | `impasto-brush`, `bristle-round` |
| Scraped, smeared texture | `palette-knife` |
| Blobs of paint straight from the tube | `paint-tube` |
| A glossy bead or line | `gloop-pen` |
| Dry, broken strokes over texture | `dry-brush`, or a lower `impasto.load` |
| A metallic highlight | `metallic-paint` |
| Paint that stays exactly as laid | `set_instant_dry` on |

## Recipes

**Mixed green.** `mix_colors` `{ colors: [{ color: "#1f3a93", weight: 1 }, { color: "#f2c500",
weight: 1 }] }` → `set_color` with the result's `mixed` → `set_brush` `oil-round` →
`paint_stroke`.

**Impasto highlights.** `add_layer` "Impasto" → `set_brush` `impasto-brush` → `set_color` a
light → short strokes following the form → `set_lighting` → `get_relief`.

## Pitfalls

- **Thick before thin.** Heavy paint in the block-in fights every later pass; keep it lean.
- **Mud from over-mixing.** A brush with high pick-up dragged through many colours greys them;
  `clean_mixer_brush` and fewer passes.
- **RGB mixing in your head.** Blue and yellow light make grey; paint makes green; use
  `mix_colors`.
- **Relief everywhere.** Uniform texture flattens the picture; keep shadows thin.
- **Oil and watercolour on one layer.** A layer keeps the first medium's wet settings.
- **A lighting change is global**: it lights every thick layer; pick it once, near the end.

## Tools used

- `get_canvas_info`, `list_layers`, `list_strokes`, `render_preview`, `pick_color`: read and check
- `set_paper`, `fill_layer`: canvas and a toned ground
- `add_layer`, `update_layer`: a layer per pass
- `mix_colors`, `color_harmony`, `add_swatch`, `set_color`: palette
- `set_brush`, `paint_stroke`, `clean_mixer_brush`: block in, build, blend and impasto strokes
- `set_lighting`, `get_relief`, `flatten_relief`: the relief and its light
- `set_instant_dry`: strokes that dry as they end
- `undo_paint`: take back a step
- `export_image`: deliver
