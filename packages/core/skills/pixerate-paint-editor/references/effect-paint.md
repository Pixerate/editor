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
  `by: "stroke"` or `by: "canvas"`.
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
