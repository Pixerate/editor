# Effect paint along the stroke, and live effect paint

- **Along the stroke** (`set_effect_paint` `map: { by: "stroke", length, repeat }`): the effect is
  rendered as a strip `length` px long (16..4096, default 300) and 256 px across. Each pixel takes
  the colour at its distance along the stroke and its place across the tip, so the pattern follows
  the stroke's turns instead of staying fixed to the canvas. `repeat` starts the strip again
  (default), `mirror` runs it back, `clamp` holds the last colour. Use it for ribbons, ropes,
  flames and textures that should flow with the mark; use the default canvas mapping to reveal one
  hidden picture across many strokes. Particle and bristle marks take the place of their pen dab.
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
