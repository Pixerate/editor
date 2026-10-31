# Free Transform

How to move, scale, rotate, skew, distort and warp layers, selected pixels and masks in the Pixerate image editor. Read it before `transform_layer`, `warp_layer`, `transform_selection`, `flip_layer` or `rotate_layer_90`.

1. **Read the frame first**: `get_transform_frame` says what a transform would move (`content`,
   `moved`) and its `frame` (document bounds of the content) with its corners. Every transform
   works on that frame: the numeric fields are percent of it and turn about one of its anchors.
2. **Pick what moves** with `content`: `layer` (all its pixels and a linked mask), `selection`
   (only the selected pixels, committed back into the same layer; the hole they leave is
   transparent and the outline moves with them), `selection-copy` (Layer via Copy, then the copy
   is transformed on a new layer; the original stays) or `auto` (selection when something is
   selected). `channel: "mask"` moves an unlinked mask alone; `transform_selection` moves only
   the outline.
3. **Choose the tool by the change**: `transform_layer` with `scaleX` / `scaleY` (percent),
   `rotate`, `skewX` / `skewY` (degrees), `dx` / `dy` and a `reference` anchor for scale, rotate
   and skew; `corners` for Distort (each corner free) and Perspective (move two corners
   symmetrically: the top pair in by the same amount narrows the top); `matrix` when you have one;
   `warp_layer` for a preset bend (`style`, `bend`, `horizontal`, `vertical`) or a custom `mesh`;
   `flip_layer` and `rotate_layer_90` for exact flips and quarter turns.
4. **Transform once.** Every call resamples the pixels, so chained calls soften them: put scale,
   rotation and move into one `transform_layer` call (or one matrix) instead of several.
5. **Look**: `render_preview`, or `capture_view` at the edges; each call is one undo step.

## Best practices

- **Transforms: one resample, bicubic, whole pixels when you can.** Combine a scale, rotation and
  move into one `transform_layer` call; use `rotate_layer_90` / `flip_layer` (exact) instead of
  `rotate: 90` or `scaleX: -100`. `interpolation: "nearest"` keeps hard pixel art crisp; bicubic
  (default) is right for photos, bilinear is a little softer. Enlarging past about 200 % shows
  softness: prefer a larger source.
- **Scale proportionally** unless asked to stretch: give `scaleX` and `scaleY` the same value.
  Keep the subject in frame: after a scale about `center` the layer can run past the canvas,
  which `bounds` in the result shows.
