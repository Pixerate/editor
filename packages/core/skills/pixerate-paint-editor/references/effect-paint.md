# Effect paint along the stroke, and live effect paint

- **Along the stroke (native path)** (`set_effect_paint` `map: { by: "path" }`): when an effect has
  a path control (`format: "svg-path"`, reported by `describe_effect` as `pathControls` and
  `accepts: ["path"]`), each stroke passes its centreline `[x0, y0, x1, y1, …]` in canvas pixels
  directly to that control and renders at the canvas size. The effect draws and lights itself along
  the stroke's exact curve (e.g. a neon beam, laser trail or signature whose glow and lighting
  belong to the path), while the brush's dabs and coverage still decide where paint lands. Strokes
  with more than 256 points are evenly resampled to 256 points rather than refused. **Prefer
  `by: "path"` over `by: "stroke"` whenever the effect has a path control** (`accepts: ["path"]`);
  `set_effect_paint` refuses `by: "path"` on effects without a path control and tells you to use
  `by: "stroke"` or `by: "canvas"`. Each stroke is a render of its own at the canvas size, so:
  - A stroke painted by hand shows the effect along the path drawn so far while it is drawn,
    re-rendered one render at a time, so it trails the pen by about one render. It is painted
    again along its whole path when the pen lifts, as one undo step; if the preview already
    rendered the whole path, at once. On a slow provider the editor is busy until that lands
    (`effectPaintRendering`). `paint_stroke` and `stroke_path` know the path up front and paint
    it at once.
  - Wet brushes can't be painted by hand this way, as the simulation can't run twice; give them
    the points through `paint_stroke`, or use `by: "stroke"`.
  - With `live: true`, every stroke is a live source of its own, so at most 8 can play.
  - Symmetry copies sample the same render, which only follows the original stroke: paint each
    copy as its own stroke if it should draw too.
- **Along the stroke (strip)** (`set_effect_paint` `map: { by: "stroke", length, repeat }`): for
  effects without a path control, the effect is rendered as a strip `length` px long (16..4096,
  default 300) and 256 px across. Each pixel takes
  the colour at its distance along the stroke and its place across the tip, so the pattern follows
  the stroke's turns instead of staying fixed to the canvas. `repeat` starts the strip again
  (default), `mirror` runs it back, `clamp` holds the last colour. Use it for ribbons, ropes,
  flames and textures that have no path control of their own; use the default canvas mapping to
  reveal one hidden picture across many strokes. Every colour-laying brush takes it (watercolour,
  gouache, oil and impasto too; sprayed stickers at their centre); particle and bristle marks take
  the place of their pen dab.
  Scaled replays (`export_high_res`) scale `length` with the canvas.
- **Live** (`live: true`): on a stroke layer (`add_layer {type: "strokes"}`) each stroke keeps
  playing the effect, so the paint moves. Paint the strokes, then `set_effect_playback`
  (`playing`, `fps` 1..60, default 30) plays or pauses them in the view. The document keeps the
  frame at the effect's own `time`; `export_image` and `export_psd` take `time` (ms) to export
  another moment. Live strokes stay editable like any stroke on a stroke layer
  (`update_stroke` with `paint` changes the effect).
- **Where it applies**: live only plays on stroke layers; on a pixel layer the stroke bakes the
  frame at `time`. A painting plays at most 8 distinct live effects (each needs a renderer per
  frame); paint more strokes with one of them, or bake new ones (`live: false`).
- **Cost**: each frame redraws the live strokes (and any stroke overlapping them), and renders
  each live effect once. On a large canvas with many live strokes, lower `fps`.
- **Without the provider** (a document opened elsewhere): the saved pixels show the frame as
  painted, and nothing plays until the provider is registered.
