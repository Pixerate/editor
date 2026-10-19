# Shape and type layers

Detail for the `pixerate-image-editor` skill: how to draw and edit vector shapes and live text.

## Shape layers

1. **Draw it as a live shape**: `add_shape_layer` with `shape` `{ kind: 'rect', x, y, width,
   height, radius | radii }`, `ellipse`, `polygon` (`sides`), `star` (`points`, `innerRatio`) or
   `line` (`x1`…`y2`, `weight`, `startArrow` / `endArrow` `{ width, length, concavity }`), all in
   document pixels. A free path takes `subpaths` (SVG path data, or anchors with absolute `in` /
   `out` handles). `fill` is a colour string or `{ type: 'gradient' | 'pattern', … }` (default the
   foreground colour; `null` for none); `stroke` is `{ width, paint, align, cap, join, dashes }`
   (dashes in multiples of the width). It returns the layer id and `shape` (components with
   index, op and live parameters, bounds).
2. **Combine paths**: `add_shape_component` with `op` `combine`, `subtract`, `intersect` or
   `exclude` (Photoshop's path operations; the bottom component always combines). The stroke
   follows the outline of the combined area. `merge_shape_components` turns the result into one
   plain path (same look).
3. **Edit, don't redraw**: `set_shape_component` changes a live shape's fields (only `radii`, only
   `x2` / `y2`, …; the rest stay), replaces a component's `subpaths` (ending its live shape) or
   changes its `op`. `update_shape` restyles the fill, the stroke (only the settings given) or the
   fill rule. Read `get_shape_layer` first for the component indices.
4. **Place it**: `offset_layer`, `transform_layer`, `flip_layer`, `rotate_layer_90` and `warp_layer`
   map the paths, never resample pixels; live shapes stay live under moves, scales, rotations and
   skews (perspective and warps turn them into plain paths). Stroke widths do not scale.
5. **Style it like any layer**: masks, clipping, blend modes, opacity, fill opacity and layer
   effects (`add_layer_effect`) all work on shape layers.
6. **Pixels only when needed**: painting a shape's pixels is refused; `rasterize_layer` turns it
   into a pixel layer (paths gone) when the user wants to paint on it.

## Type layers

1. **Add it**: `add_text_layer` with `text` (`\n` starts a paragraph), `x`, `y` (point text: the
   first line's baseline at its alignment edge) or a `box` `{ width, height }` for paragraph text
   that wraps (then `x`, `y` is the box's top-left), a `style` (`fontFamily`, `fontWeight`,
   `italic`, `fontSize` in px, `color`, `tracking` in 1/1000 em, `leading` in px, `baselineShift`,
   `underline`, `strikethrough`) and a `paragraph` style (`align`, `autoLeading`, indents,
   `spaceBefore` / `spaceAfter`). Call `list_fonts` first when the font matters: a missing family
   draws with a fallback and comes back in `missingFonts`.
2. **Edit by range**: ranges are `start` / `end` in UTF-16 code units, `end` exclusive, as
   `get_text_layer` reports runs and lines. `set_text` replaces a range (start = end inserts; new
   text takes the style at `start`), `set_text_style` styles a range (only the fields given),
   `set_paragraph_style` styles the paragraphs a range touches. Re-read the runs after an edit
   that changes the length before using old ranges.
3. **Shape the block**: `set_text_frame` switches between point text and a wrapping box (or
   resizes the box) with the first line kept in place.
4. **Place it**: `offset_layer`, `transform_layer`, `flip_layer` and `rotate_layer_90` change the
   text's matrix and draw it again (scale, rotate, skew, flips). Distort, perspective and warp are
   refused: rasterize first. Masks, clipping, blend modes and effects work as on any layer.
5. **Outlines and pixels**: `convert_text_to_shape` makes glyph outlines a shape layer (needs an
   outline font shaper; the browser canvas cannot); `rasterize_layer` makes it pixels.

## Photoshop files

`import_psd` brings Photoshop shape layers in as live shapes (paths with their path operations, fill,
stroke, and live rectangles, rounded rectangles, ellipses and lines) and type layers as live text
that shows Photoshop's pixels until it is edited. `get_text_layer` reports `rendering: "stored"`
and `missingFonts` for those: if a font is missing, edits draw with a fallback, so tell the user
before editing such text, or pick an available font with `set_text_style`. `export_psd` writes both
kinds back as Photoshop layers; unchanged ones are written byte for byte as they were read.
