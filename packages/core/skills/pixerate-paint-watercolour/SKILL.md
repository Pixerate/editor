---
name: pixerate-paint-watercolour
description: The watercolour workflow in the Pixerate paint editor - choosing the paper, planning light to dark and keeping the paper's white for highlights, wet-in-wet and wet-on-dry washes, letting water flow and drying before glazing, steering water with the wet tools, granulation, blooms and edge darkening, and finishing detail with a small brush. Use when asked to paint in watercolour or gouache, lay a wash, paint a sky, glaze, paint wet-in-wet, make blooms or granulation, or paint a loose or botanical watercolour, or when wet_paper, advance_wet_paint, dry_paint or set_wet_settings are available. Load with pixerate-paint-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-paint-editor
---

# Painting in watercolour

Watercolour is transparent and it moves. Each wash lays water and pigment that keep flowing
until they dry: edges darken, pigment settles into the paper's valleys, wet colours bleed into
each other. Light comes from the paper, so you work light to dark and keep the white of the paper
where you want highlights. A dried wash is fixed; the next one glazes over it. For an agent,
time only passes when you call `advance_wet_paint` or `dry_paint`.

This skill is the method. `pixerate-paint-editor` has the full tool reference and
`references/wet-media.md` the engine's detail.

## Goal and quality bar

- The paper suits the piece: cold pressed for most work, rough for texture and granulation, hot
  pressed for fine detail (`get_canvas_info` `paper.preset`).
- Washes are even where they should be and soft where they should be; colours glow because
  they are layered, not mixed to mud.
- Highlights are the paper itself, not white paint (unless the user asks for gouache).
- Every wash is dry before the next glaze over it (`get_wet_paint` `wet: false`), and the
  painting is dry before export.

## Inputs to confirm

- **Subject and look:** loose and atmospheric (wet-in-wet) or crisp and detailed (wet-on-dry).
- **Palette:** a few colours; `color_harmony` or `mix_colors` to plan.
- **Highlights to keep white**, and where they are.

## Working method

1. **Ground.** `set_paper` with a watercolour preset (`cold-pressed`, `rough-watercolor`,
   `hot-pressed`). Keep each pass on its own layer when you may want to change it (`add_layer`).
   **Check:** `get_canvas_info` shows the paper.
2. **Plan values light to dark** and where the paper stays white. Mix colours first
   (`mix_colors` predicts the pigment mix; `add_swatch` keeps them).
3. **First wash, lightest colour.** For soft skies and backgrounds, `wet_paper` the area first
   (wet-in-wet); for crisp edges paint on dry paper. `set_brush` `watercolor-wash`, `set_color`,
   then a few long `paint_stroke`s across the area, overlapping, avoiding the highlights.
   **Check:** `get_wet_paint` shows the layer wet; `pick_color` inside is the colour you meant.
4. **Let it move, then dry.** `advance_wet_paint` (`seconds` 1-5) to let it spread, bloom and
   granulate; drop a second colour in while it is wet for soft blends. Then `dry_paint`.
   **Check:** `get_wet_paint` `wet: false`.
5. **Glaze.** Each further wash goes over a dry one, a little darker or another hue (blue over
   yellow makes green). Paint only where it should deepen.
   **Check:** `pick_color` where you glazed is darker; where you did not, unchanged.
6. **Shapes, then details.** `watercolor-round` for shapes, `watercolor-detail` for lines and
   details on dry paper, last.
7. **Steer and fix while wet**: `blot` lifts paint (clouds, a highlight you lost), the
   `add-water` tool softens an edge, `hair-dryer` stops a spread, `set_canvas_tilt` makes a wash
   run, `set_wet_settings` tunes `granulation`, `edgeDarkening` and `bloom` for the layer.
8. **Finish.** `dry_paint` everything; `render_preview` to look; export.

## Decision table

| Want | Approach |
| --- | --- |
| Soft sky, misty background | `wet_paper`, then `watercolor-wash`; drop colours in while wet |
| Crisp shapes, hard edges with a dark rim | Paint on dry paper |
| Deeper colour without mud | Dry, then glaze a second wash |
| A white highlight | Leave the paper; or `blot` while wet to lift |
| Light over dark | `gouache` (body 1) |
| Grainy, textured washes | `rough-watercolor` paper and `granulation` up in `set_wet_settings` |
| Fine lines and detail | `hot-pressed` paper, `watercolor-detail`, on dry paper |
| Cauliflower blooms | Add water into a drying wash; `bloom` up |

## Recipes

**Flat wash.** `set_brush` `watercolor-wash` → `set_color` → one `paint_stroke` zigzagging
across the area (rows about half the brush size apart) → `advance_wet_paint` `seconds` 2-5 →
`dry_paint`.

**Glaze.** On the dried wash, the same or a darker colour, painted only where it should deepen
→ `dry_paint`. Repeat for more depth; three glazes are usually plenty.

**Wet-in-wet sky.** `wet_paper` over the sky → blue wash along the top → while wet, a little
warm colour near the horizon → `advance_wet_paint` → `blot` a few clouds → `dry_paint`.

## Pitfalls

- **Glazing on wet paint** mixes the two washes instead of layering them; dry first.
- **Painting light over dark** does not work in transparent watercolour; plan the whites.
- **Overworking**: many strokes over a wet wash lift and muddy it; lay it and leave it.
- **Drawing-paper presets** (cartridge, smooth) do not behave like watercolour paper.
- **Oil and watercolour on one layer**: a layer keeps the first medium's wet settings; use
  separate layers.
- **Nothing moves by itself** for an agent: without `advance_wet_paint` there is no flow, and
  without `dry_paint` the next stroke paints into wet paint.

## Tools used

- `get_canvas_info`, `list_layers`, `render_preview`, `pick_color`: read the canvas and check colours
- `list_papers`, `set_paper`: the watercolour ground
- `add_layer`, `update_layer`: a layer per pass
- `set_brush`, `set_color`, `mix_colors`, `color_harmony`, `add_swatch`: brush and palette
- `paint_stroke`: washes, shapes and details, and the wet tools (water, dryer, blot)
- `wet_paper`, `advance_wet_paint`, `dry_paint`, `get_wet_paint`: wet-in-wet, flow, drying and checking
- `set_wet_settings`, `set_canvas_tilt`, `set_flow_map`: tune and steer the water
- `undo_paint`: take back a step
- `export_image`: deliver
