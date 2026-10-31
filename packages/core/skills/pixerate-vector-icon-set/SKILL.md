---
name: pixerate-vector-icon-set
description: The icon set workflow in the Pixerate vector editor - drawing line or solid icons on a consistent grid (24, 32 or 48 units) with padding and keylines, one stroke width, cap and join style and corner radius across the set, anchors on whole or half units so they render crisp, clean minimal paths, repeats as symbols, and checking and exporting each icon as SVG. Use when asked to draw, design, redraw, clean up or make consistent an icon or a set of icons, glyphs or pictograms, or to export icons as SVG, or when vector.addPath, vector.setStyle, vector.makeSymbol or vector.exportSvg are available. Load with pixerate-vector, which lists every command.
metadata:
  kind: workflow
  reference: pixerate-vector
---

# Drawing an icon set

An icon set reads as one family when every icon shares the same few decisions: the grid, the
padding, the stroke width, the cap and join, the corner radius and the visual weight. Make
those decisions once, write them down, and apply them to every icon; then check each icon
against them in numbers (`vector.list` bounds, stroke widths and `d`) before looking.

This skill is the method. `pixerate-vector` has the full command reference; run the commands
with `run_command`, or several as one undo step with `run_commands` and `atomic: true`.

## Goal and quality bar

- One grid: a square artboard of 24 (UI), 32 or 48 units, the same for the whole set.
- Padding kept: nothing, stroke included, closer than 2 units to the edge on a 24 grid (1/12 of
  the side on others). Strokes count half their width outside the path.
- One stroke width (2 on 24 is the common default; 1.5 for a lighter set), one cap and join
  style (round for friendly sets, butt and miter for geometric ones), one corner radius.
- Crisp: with an even stroke width (2) put the path's anchors on whole units, with an odd one
  (1, 3) on half units, so the stroke's edges fall on pixel boundaries at 1×.
- Clean paths: the fewest anchors that make the shape, no stray or zero-length segments, no
  hidden overlapping shapes.
- Visually balanced: icons look the same size (circles a little larger than squares), and are
  optically centred.

## Inputs to confirm

- **Grid and stroke:** the size (24 by default) and stroke width (2 by default), or an existing
  icon to match (read it first).
- **Style:** outline (stroked) or solid (filled), and rounded or sharp.
- **Output:** one SVG per icon, a sprite, or symbols in one document.

## Working method

1. **Read what exists.** `vector.list`: the artboard size and any icons already drawn, with their
   `strokeWidth`, `bounds` and `d`; `vector.getAppearance` for caps, joins and alignment.
   **Check:** you can state the set's grid, padding, stroke, caps, joins and radius.
2. **Draw on the grid.** Prefer `vector.addShape` primitives (`rect` with `cornerRadius`,
   `ellipse`, `line`, `polygon`) and `vector.addPath` with whole or half-unit coordinates; give
   `fill: null`, `stroke`, `strokeWidth`, `strokeLinecap` and `strokeLinejoin` in the same call.
   Batch one icon's parts in one `run_commands` with `atomic: true` and a `label`.
   **Check:** `vector.list` bounds plus half the stroke stay inside the padding.
3. **Combine.** Join parts that should be one shape with `vector.boolean` (`union`; `subtract`
   for cut-outs); use `vector.outlineStroke` only for a solid set or when the export target needs
   fills. Then `vector.removeRedundantPoints`.
   **Check:** `d` has no more anchors than the shape needs; coordinates are still on the grid.
4. **Match the set.** `vector.setStyle` on all the set's paths at once (`ids` from `vector.list`)
   for stroke width, caps and joins; `vector.setCorners` for one radius.
   **Check:** every path's `strokeWidth` is the set's; caps and joins in `vector.getAppearance`.
5. **Balance.** Compare the icons' bounds: a circle about 10 % larger than a square of the same
   weight looks the same size; centre shapes optically (a play triangle shifts right).
   **Check:** each icon's bounds centre is within half a unit of the artboard centre (or its
   intended optical centre).
6. **Repeats become symbols.** The same element used several times (a star in a rating, a
   chevron) is `vector.makeSymbol` once and `vector.placeSymbol` elsewhere.
7. **Export.** `vector.exportSvg` (or `vector.exportFrameSvg` per artboard) with `precision` 2;
   read the markup: no transforms where plain coordinates would do, no hidden nodes.

## Decision table

| Need | Approach |
| --- | --- |
| Outline icon | Stroked paths, `fill: null`, round caps and joins |
| Solid icon | Filled shapes; `vector.outlineStroke` turns a stroked sketch into fills |
| A rounded rectangle or badge | `vector.addShape` `rect` with `cornerRadius`, not drawn arcs |
| A cut-out (a hole, a notch) | `vector.boolean` `subtract`, or `fillRule: "evenodd"` |
| Several icons on one page | One frame per icon (`vector.addFrame`), exported with `vector.exportFrameSvg` |
| One element repeated | `vector.makeSymbol` and `vector.placeSymbol` |
| Odd stroke width (1, 3) | Put anchors on half units so the edges land on pixels |

## Recipes

**A line icon.** One `vector.addPath` with `d` on the grid (`M12 5L12 19M5 12L19 12` is a plus
on 24), `fill: null`, `stroke`, `strokeWidth: 2`, `strokeLinecap: "round"`,
`strokeLinejoin: "round"`; then `vector.list` to check bounds against the padding.

**Make a set consistent.** `vector.list` → `vector.setStyle` with every path's id, the set's
`strokeWidth`, `strokeLinecap` and `strokeLinejoin` in one call (one undo step) → `vector.list`
to confirm nothing moved.

**Copies into a symbol.** `vector.makeSymbol` on the first copy (it is replaced by an
instance), `vector.delete` the other copies, `vector.placeSymbol` at their centres.

## Pitfalls

- **Bounds without the stroke.** `vector.list` bounds are the path's geometry; add half the
  stroke width on each side when checking padding.
- **Off-grid anchors** after a scale or rotate blur at 1×; check `d` and round coordinates.
- **Default styles.** `vector.addShape` adds a grey fill and a dark 2-unit stroke unless you pass
  `fill` and `stroke`; set them in the same call.
- **Scaling strokes.** Scaling an icon scales its geometry, not its stroke width; reset
  `strokeWidth` afterwards so the set stays consistent.
- **Too many anchors** from booleans or traced input; `vector.removeRedundantPoints`.
- **Mixed caps and joins** across a set are easy to miss by eye; read `vector.getAppearance`.

## Tools used

- `vector.list`, `vector.getAppearance`: bounds, stroke widths, `d`, caps and joins
- `vector.addShape`, `vector.addPath`: draw on the grid
- `vector.setStyle`, `vector.setCorners`: one stroke, cap, join and radius across the set
- `vector.boolean`, `vector.outlineStroke`, `vector.removeRedundantPoints`: combine and clean paths
- `vector.transform`, `vector.align`: position and centre
- `vector.makeSymbol`, `vector.placeSymbol`, `vector.delete`: repeats as symbols
- `vector.addFrame`, `vector.exportFrameSvg`, `vector.exportSvg`: one artboard per icon, export
