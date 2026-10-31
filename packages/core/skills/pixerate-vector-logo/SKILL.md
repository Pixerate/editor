---
name: pixerate-vector-logo
description: The logo workflow in the Pixerate vector editor - building a mark from primitives with live booleans, Pathfinder and Shape Builder, optical corrections, a lockup of mark and wordmark aligned and spaced on the artboard, text converted to outlines for the final file, colour variants (full colour, one colour, reversed) through symbols, and clean single-path SVG export. Use when asked to design, draw, redraw, vectorise, clean up or export a logo, logomark, wordmark, monogram, emblem or brand mark, make a one-colour or reversed version, or prepare a logo file for print or the web, or when vector.boolean, vector.pathfinder, vector.createOutlines or vector.exportSvg are available. Load with pixerate-vector, which lists every command.
metadata:
  kind: workflow
  reference: pixerate-vector
---

# Making a logo

A logo has to survive every size and every background, so it is built from few, clean shapes,
kept editable while it is being designed and flattened only for delivery. Design with live
booleans and real text; deliver plain paths with text outlined, one file per variant.

This skill is the method. `pixerate-vector` has the full command reference; run the commands
with `run_command`, or several as one undo step with `run_commands` and `atomic: true`.

## Goal and quality bar

- The mark is built from simple geometry: primitives combined with booleans, with as few anchors
  as the shape needs.
- It reads at 16 px and at poster size: no hairlines thinner than about 1/30 of the mark's
  height, no details that close up when small.
- The lockup is aligned on the artboard: mark and wordmark centred (or aligned to a shared edge),
  with a deliberate gap kept in every variant.
- Delivery files are self-contained: text outlined (`vector.createOutlines`), live booleans and
  effects expanded, one path per colour where possible, no hidden or stray nodes.
- Variants match: full colour, one colour (black) and reversed (white on dark) are the same
  geometry.

## Inputs to confirm

- **Name and wording** for the wordmark, and the typeface (`vector.listFonts`).
- **Colours:** the brand palette as hex, and which variants are needed.
- **Stage:** still designing (keep live) or delivering (flatten and outline).

## Working method

1. **Read.** `vector.list`: the artboard, existing shapes and text, their fills and bounds.
   **Check:** you know which nodes are the mark and which the wordmark.
2. **Build the mark from primitives.** `vector.addShape` (rect, ellipse, polygon, star) on round
   numbers; combine with `vector.boolean` and `live: true` while designing (`union` for one
   silhouette, `subtract` for cut-outs, `intersect`); `vector.pathfinder` when you need every
   region (`divide`) or `vector.shapeBuilder` to merge chosen regions.
   **Check:** `vector.list` shows the live group with its `liveBoolean` and the expected bounds.
3. **Correct optically.** Round shapes overshoot flat ones by 2-3 % so they look the same height;
   a horizontal bar looks thicker than a vertical one of equal width, so thin it slightly;
   centre by eye mass (a triangle's centroid, not its box).
4. **Set the wordmark** with `vector.addText` (point text) and `vector.setTextStyle` for tracking;
   keep it as text while designing.
   **Check:** the text result's `overflow` is empty and `missingFonts` lists nothing.
5. **Lock it up.** Position mark and wordmark with `vector.transform` (`dx`, `dy`) or
   `vector.align`, then group them (`vector.group` with a `name`).
   **Check:** `vector.list` bounds: centres equal (or edges aligned), the gap what you intended.
6. **Variants.** Make the lockup a symbol (`vector.makeSymbol`) and place it once per variant
   (`vector.placeSymbol`), recolouring with `vector.setInstanceOptions` `fill`, so a geometry
   change updates every variant. Check each against its background colour (contrast).
7. **Deliver.** For each variant: `vector.createOutlines` on the text, `vector.expandAppearance`
   on live booleans and effects (or `vector.boolean` without `live` for one path),
   `vector.removeRedundantPoints`, then `vector.exportSvg` with `precision` 2.
   **Check:** `vector.list` has only plain paths; the SVG has no `text` and no filters.

## Decision table

| Want | Command |
| --- | --- |
| One silhouette from overlapping shapes, still editable | `vector.boolean` `union`, `live: true` |
| A hole or notch | `vector.boolean` `subtract` (top shape cuts the one below) |
| Every overlap as its own piece | `vector.pathfinder` `divide` |
| Merge or remove particular regions | `vector.shapeBuilder` |
| A ring or donut for export | `vector.boolean` `subtract` without `live`: one path with two subpaths |
| Same logo in several colours | A symbol, with `vector.setInstanceOptions` per variant |
| Text that must not depend on fonts | `vector.createOutlines` (keep a text copy while designing) |

## Recipes

**Live union.** `vector.boolean` `{ operation: "union", live: true, ids }` with the parts'
ids from `vector.list`; adjust a part later by its own id inside the group.

**Knockout for export.** `vector.boolean` `{ operation: "subtract", ids: [outer, inner] }`: one
path, the hole see-through (not painted white).

**Centre a lockup.** For each part, `dx = artboard.width / 2 - (bounds.x + bounds.width / 2)`
with `vector.transform`; leave `dy` at 0 to keep the vertical gap.

## Pitfalls

- **White shapes as holes.** A white circle over a red one is not a hole; it shows on a coloured
  background. Subtract it.
- **Flattening too early.** A destructive boolean or outlined text cannot be re-edited; keep live
  versions until delivery.
- **Live effects in delivered files.** Filters and live booleans export as SVG filters or
  Pixerate attributes that other tools may not read; expand first.
- **Missing fonts.** A family the shaper lacks draws in a fallback; check `missingFonts` before
  outlining, since outlines bake whatever was drawn.
- **Hairlines and tiny counters** disappear at favicon size; test the mark small.

## Tools used

- `vector.list`, `vector.getText`, `vector.listFonts`: read shapes, text and fonts
- `vector.addShape`, `vector.addPath`, `vector.addText`, `vector.setTextStyle`: build the mark and wordmark
- `vector.boolean`, `vector.pathfinder`, `vector.shapeBuilder`: combine shapes
- `vector.transform`, `vector.align`, `vector.group`: lock up and space
- `vector.makeSymbol`, `vector.placeSymbol`, `vector.setInstanceOptions`: colour variants
- `vector.setStyle`: brand colours
- `vector.createOutlines`, `vector.expandAppearance`, `vector.removeRedundantPoints`: prepare for delivery
- `vector.exportSvg`: the delivered file
