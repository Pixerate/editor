---
name: pixerate-paint-sketch-to-finish
description: The sketch-to-finish workflow in the Pixerate paint editor - a loose pencil sketch on its own layer, construction with guides, clean line art inked over it, flat colours on a layer under the lines, shading and light on clipped layers in multiply, shadow or highlight modes, final detail, and a tidy, named layer stack for export. Use when asked to draw and colour, ink a sketch, make line art, add flat colours, shade or light a drawing, take a drawing from sketch to finished illustration, or colour comic or cartoon art, or when add_layer, update_layer, paint_stroke or set_tracing_image are available. Load with pixerate-paint-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-paint-editor
---

# From sketch to finished drawing

A drawing is finished in passes, each on its own layer, so each can be changed without
redoing the others: sketch, line art, flat colours, shading and light, details. Layers above
others can be clipped to them so shading stays inside the flats, and painterly blend modes do
the glazing. `list_layers` lists the stack top first.

This skill is the method. `pixerate-paint-editor` has the full tool reference.

## Goal and quality bar

- A named layer per pass ("Sketch", "Ink", "Flats", "Shading", "Light"), in the right order:
  flats under the line art, shading and light clipped to the flats.
- The sketch is hidden (or deleted) in the finished piece.
- Lines are clean and confident: few long strokes, pressure tapering at the ends.
- Flats fill the shapes without gaps at the lines; shading and light stay inside them.

## Inputs to confirm

- **Style:** line and flat colour (comic, cartoon), or soft rendering.
- **Line weight and colour** (black ink, or a coloured line).
- **Palette** for the flats; light direction for the shading.

## Working method

1. **Ground.** `set_paper` `smooth` (bristol) for ink and digital-looking work, `cartridge` for
   pencil; `get_canvas_info` to confirm.
2. **Sketch.** Rename or add a layer "Sketch" (`update_layer` `name`, or `add_layer`); a light
   pencil (`pencil-hb`) in a mid grey or blue, loose construction lines. `set_symmetry` for
   symmetric subjects, `set_perspective_guide` for buildings, `set_tracing_image` to trace a
   reference.
   **Check:** `list_strokes` shows pencil strokes on the Sketch layer.
3. **Ink.** `add_layer` "Ink" above it; `ink-pen` or `brush-pen`, dark colour, long strokes with
   points that carry `pressure` (lighter at the ends) and `t` for speed dynamics.
   **Check:** `pick_color` on a line is dark.
4. **Hide the sketch.** `update_layer` the Sketch layer `visible: false` (or lower its `opacity`
   while inking, then hide it).
   **Check:** `list_layers` shows it hidden.
5. **Flats.** `add_layer` "Flats", then `move_layer` it below the Ink layer; fill each shape with
   its base colour (`marker` or a flat brush, or `fill_layer` for a background).
   **Check:** `pick_color` inside a shape is the flat colour; on a line still the ink.
6. **Shading and light.** `add_layer` "Shading" directly above the flats, `update_layer`
   `blend: "multiply"` (or `shadow`) and `clipped: true`; paint shadows on the side away from the
   light. A "Light" layer the same way with `highlight` or `screen`.
   **Check:** `list_layers`: the clipped layers sit directly above the flats.
7. **Details and finish.** Accents, textures and line fixes on their own layers; `render_preview`;
   `export_image`, or `export_psd` to keep the layers (painterly modes export as the nearest
   standard mode, with a warning).

## Decision table

| Pass | Brush and layer |
| --- | --- |
| Sketch | `pencil-hb`, light colour, own layer, hidden at the end |
| Line art | `ink-pen` (even), `brush-pen` (swelling); own layer on top |
| Flats | `marker` or a flat brush on a layer under the ink |
| Patterned or textured flats (sky, gradient, galaxy) | `set_effect_paint` with a provider generator, then a flat dry brush on the Flats layer; `set_color` after |
| Shadows | Clipped layer, `multiply` or `shadow`, a cool colour |
| Light, glow | Clipped layer, `highlight` or `screen` |
| Warm or cool a whole area | Clipped layer in `tint` |
| Repeated marks (hatching, grass) | One stroke, then `replay_strokes` with offsets |

## Recipes

**Flats under ink.** `add_layer` "Flats" → `move_layer` with the new layer's id and `index` below
the Ink layer → `set_brush` `marker` → `set_color` → strokes inside the shape.

**Effect flats.** With an effects provider: `search_effects` (`use` generator) → `describe_effect`
→ `set_effect_paint` → `marker` strokes inside the shape on the Flats layer (the effect shows
where the brush goes, fixed to the canvas) → `set_color` to go back to plain colour. Wet,
impasto and sticker brushes refuse effect paint.

**Clipped shading.** `add_layer` "Shading" above Flats → `update_layer` `{ blend: "multiply",
clipped: true }` → `set_brush` `airbrush` → paint the shadow side.

## Pitfalls

- **Inking on the sketch layer** mixes the two; you cannot hide the sketch afterwards.
- **Flats above the ink** cover the lines; they belong under them.
- **Unclipped shading** spills outside the shapes; clip it to the flats.
- **Shadows in black** look dirty; use a cool, darker version of the colour in multiply or
  `shadow`.
- **Many short, hairy strokes** make weak line art; fewer, longer strokes with pressure.
- **`list_layers` is top first**: index 0 is the top layer; `move_layer` `index` counts from the
  bottom.

## Tools used

- `get_canvas_info`, `list_layers`, `list_strokes`, `pick_color`, `render_preview`: read and check
- `set_paper`, `fill_layer`: the ground and backgrounds
- `add_layer`, `update_layer`, `move_layer`, `remove_layer`: one layer per pass; hide, clip, blend
- `set_brush`, `set_color`, `paint_stroke`, `replay_strokes`: sketch, ink, flats and shading
- `search_effects`, `describe_effect`, `set_effect_paint`: flats painted with a provider effect
- `set_symmetry`, `set_perspective_guide`, `set_tracing_image`: construction guides
- `undo_paint`: take back a step
- `export_image`, `export_psd`: deliver
