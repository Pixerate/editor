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
5. **Place it**: `offset_layer`, `transform_layer`, `flip_layer`, `rotate_layer_90` and `warp_layer`
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
   draws with a fallback and comes back in `missingFonts`. For Japanese, Chinese or Korean set in
   columns pass `orientation: "vertical"` (or switch later with `set_text_orientation`): columns
   run down from (`x`, `y`), the top of the first column's centre line, and stack right to left;
   a vertical `box` fills from its right edge and wraps at its height.
2. **Edit by range**: ranges are `start` / `end` in UTF-16 code units, `end` exclusive, as
   `get_text_layer` reports runs and lines. `set_text` replaces a range (start = end inserts; new
   text takes the style at `start`), `set_text_style` styles a range (only the fields given),
   `set_paragraph_style` styles the paragraphs a range touches. Re-read the runs after an edit
   that changes the length before using old ranges.
3. **Shape the block**: `set_text_frame` switches between point text and a wrapping box (or
   resizes the box) with the first line kept in place (vertically, the first column's top-right).
4. **Vertical text**: ideographs, kana and Hangul stand upright; Latin, digits and spaces turn
   90° clockwise, which suits words inside Japanese text. For short Latin or acronyms that should
   read down letter by letter, set `upright: true` on that range with `set_text_style`. Brackets,
   dashes and 、。 use the font's vertical forms when the shaper reads them (an outline shaper over
   an OpenType font with `vert`); the browser canvas turns brackets and moves 、。 to the upper
   right instead. In `get_text_layer`, `lines` are columns: `baseline` is a column's centre in
   line space, not a y. Use a font with CJK glyphs (`list_fonts`): a Latin-only family draws CJK
   with a fallback.
4. **Place it**: `offset_layer`, `transform_layer`, `flip_layer` and `rotate_layer_90` change the
   text's matrix and draw it again (scale, rotate, skew, flips). Distort, perspective and warp are
   refused: rasterize first. Masks, clipping, blend modes and effects work as on any layer.
6. **Outlines and pixels**: `convert_text_to_shape` makes glyph outlines a shape layer (needs an
   outline font shaper; the browser canvas cannot); `rasterize_layer` makes it pixels.
   For a selection in the shape of text (photo-filled letters, text cut out of the image) use
   `select_text_shape`, the Type Mask: it lays the text out the same way but adds no layer.

## Photoshop files

`import_psd` brings Photoshop shape layers in as live shapes (paths with their path operations, fill,
stroke, and live rectangles, rounded rectangles, ellipses and lines) and type layers as live text
that shows Photoshop's pixels until it is edited; vertical type comes in vertical (with its
upright-Latin runs) and goes back out as vertical type. `get_text_layer` reports `rendering: "stored"`
and `missingFonts` for those: if a font is missing, edits draw with a fallback, so tell the user
before editing such text, or pick an available font with `set_text_style`. `export_psd` writes both
kinds back as Photoshop layers; unchanged ones are written byte for byte as they were read.
