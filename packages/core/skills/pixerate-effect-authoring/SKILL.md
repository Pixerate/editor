---
name: pixerate-effect-authoring
description: How to author and edit procedural effects, shaders, and filters through the effect authoring agent tools - writing new effects in pixel expressions and keeping them in a painting as paint, paper, effect layers and fills, inspecting effect schemas and current control values, reading and compiling shader source code, adjusting parameters with all-or-nothing validation, applying and saving presets, keyframing animation tracks with easing, configuring timeline playback duration and looping, scrubbing the playhead, and capturing visual previews. Use when asked to author, modify, or debug shaders or procedural effects, animate effect parameters over time, or when effect_authoring tools are available.
---

# Pixerate effect authoring

An effect authoring session hosts an active effect definition (shader or procedural filter) and
exposes its controls, animated tracks, compile status, playback timing, and visual preview.
Control values can be static or animated via keyframes along a timeline. Each edit creates a
single undoable history step.

When an effect session is opened, tools allow inspecting the control schema, updating control
values, modifying shader code (for code-backed effects), saving and loading presets, managing
keyframe animation tracks with interpolation easing, seeking the playhead, and capturing rendered
preview frames.

For general error reporting and undo conventions, see `pixerate-agent-tools`.

## Workflow skills

For these jobs, load the workflow skill too: it has the method, the checks between steps and
the pitfalls, and uses the tools below.

- `pixerate-effect-look-development`: tune a look, save presets, eased keyframes, seamless loops.

## Writing a new effect (pixel expressions)

New effects are written in **pixel expressions** (`sourceLanguage: "pixel"`), a small language
with no loops: each line is `control`, `let` or `out`, and the program runs once per pixel.

```
// Rings that spread from a point.
control ink: color = #1d2b53            // Colour of the rings.
control count: number = 12 range 1 64   // Rings across the picture.
control center: vec2 = vec2(0.5, 0.5) range 0 1
let d = distance(uv, center)
let wave = 0.5 + 0.5 * sin((d * count - time / 2) * TAU)
out = vec4(ink, smoothstep(0.4, 0.6, wave))
```

- **Controls** come first: `control <name>: number|color|bool|vec2 = <default> [range <lo> <hi>]`,
  and the comment at the end of the line is the control's description. They become the effect's
  controls (colours are `#rrggbb` values, used as a vec3 0..1; bools are 0 or 1).
- **Values:** numbers, `vec2`/`vec3`/`vec4`, parts with `.x .y .z .w` or `.r .g .b .a` (`.xy`,
  `.rgb`), `#rrggbb` colour literals. `+ - * / %` work part by part (a number spreads over a
  vector). `< <= > >= == !=` compare two numbers and give 0 or 1.
- **Built in:** `uv` (0..1 from the top left, pixel centres), `pos` (pixels), `size`, `time`
  (seconds), `PI`, `TAU`.
- **Functions:** `sin cos tan asin acos atan(x)` / `atan(y, x)`, `sqrt exp log abs sign floor ceil
  fract pow mod min max clamp mix step smoothstep`, `select(c, a, b)` (a where c > 0.5),
  `length distance dot normalize`, `hash(p)` and `noise(p)` (value noise 0..1 over a vec2),
  `sample(p)` (the input picture, see below), `vec2() vec3() vec4()`.
- **`out`** is the last line: a number (grey), a vec3 (opaque colour) or a vec4 (straight alpha).
- **Budgets:** at most 64 KB of source and 1024 steps per pixel (`noise` and `sample` count 4); a
  save needs a 64×64 trial render within 100 ms. Share work with `let` rather than repeating
  expressions (read each neighbour once with `let n = sample(...)`, then use its parts).

### Filters: `sample(p)`

An effect whose program calls `sample` is a **filter**: its description has `uses: ["filter"]`
and an image input `source`, and in the paint editor it runs on a layer's dried paint with
`apply_effect` (it is not offered for paint, paper, effect layers or fills). Without `sample` an
effect is a generator.

```
// Lights the edges of the paint from one side.
control light: color = #fff2c4 // Colour of the light.
control angle: number = 135 range 0 360 // Where it comes from, in degrees.
let dir = vec2(cos(angle / 180 * PI), sin(angle / 180 * PI)) * 1.5 / size
let c = sample(uv)
let edge = clamp(sample(uv - dir).a - sample(uv + dir).a + 0.5, 0, 1)
out = vec4(mix(c.rgb * 0.6, mix(c.rgb, light, 0.5), edge), c.a)
```

- `p` is a vec2 in **uv** (the same space as `uv`: 0..1, y down, pixel centres), so `sample(uv)`
  is the pixel itself and a neighbour is `sample(uv + vec2(dx, dy) / size)` with offsets in pixels.
- It returns a vec4 with **straight alpha**, filtered bilinearly (colour weighted by alpha, so
  transparent pixels don't darken edges) and clamped to the edge outside 0..1.
- **Keep `c.a` in `out`** (`out = vec4(…, c.a)`) unless the filter is meant to change where there
  is paint: `out` replaces the layer's pixels, and a vec3 `out` makes the whole layer opaque.
- With no input (a preview in the authoring session) `sample` reads transparent, so judge a filter
  by applying it, and undo to try other values.

Errors come back from `effect_authoring_set_source` as `issues` with a line and a message that
says what to change; warnings (an unused control or let) don't stop it compiling. While the source
doesn't compile, the session keeps the last controls that did, and `compiled` is false.

## In the paint editor

1. `open_effect_authoring` with `pixel.blank` (or `pixel.rings`, `pixel.clouds` to start from an
   example). It returns the source, controls and issues.
2. `effect_authoring_set_source` until `issues` has no errors; tune with
   `effect_authoring_set_values`, animate with `effect_authoring_set_keyframe`. Look at it with
   `effect_authoring_view` (a frame at the playhead, or at `time`, in the painting's aspect with its
   longest side at most 256 px) before saving.
3. `save_authored_effect` with a name: it trial-renders the effect and returns its id,
   `authored.<name>`.
   Before saving, give an effect meant for strokes a paint hint with
   `effect_authoring_set_paint_hint` (the templates come with one): which colour controls take the
   brush's colours, whether it follows the stroke (`map`), and whether it plays live.
4. Use the id like any effect id: `set_effect_paint` (strokes), `set_paper_effect`,
   `add_effect_layer`, `fill_layer_with_effect`. A filter (it calls `sample`) runs with
   `apply_effect` on a painted layer instead (`search_effects` with `place: "light"` lists it).
   `search_effects` and `describe_effect` find it too.
5. `list_authored_effects` shows where each is used and anything stopping it drawing;
   `remove_authored_effect` removes one nothing uses; `close_effect_authoring` closes the session.

The painting keeps each effect's source, values, keyframes and presets, so it replays on any
machine with no session or provider. Authoring needs the editor's `authoredEffects` policy to be
`author` (the default `replay` draws authored effects but refuses writing them; `off` draws none).

## Working method

1. **Inspect first.** Run `effect_authoring_describe` to inspect the effect name, kind, source
   language (`pixel`, `glsl`, `svg`, or null when the effect has no source to edit), control parameter schemas, current
   values, existing tracks, playhead `time`, compile issues and `previewError`.
   A session opens with its playhead at half the effect's length (where entrance-style effects and
   transitions show), so values set on an animated control key that time unless you seek first.
2. **Read or update source code.** If `sourceLanguage` is non-null, use `effect_authoring_get_source`
   to read the shader or script code. Use `effect_authoring_set_source` to recompile with new code
   and immediately inspect any reported syntax or compilation issues with line numbers.
3. **Adjust parameters.** Use `effect_authoring_set_values` to set one or more controls at once.
   This runs all-or-nothing validation: any invalid control name or out-of-range value cancels the
   change and returns a helpful error.
4. **Animate with keyframes.** For controls that change over time, set keyframes using
   `effect_authoring_set_keyframe` specifying `control`, `time` (ms), optional `value`, and `easing` (a preset name such as `ease-in-out`, or a `cubic-bezier`, `spring` or `elastic` curve object).
   Use `effect_authoring_seek` to move the playhead across the timeline and check resolved values.
   Use `effect_authoring_remove_keyframe` to delete specific points, or `effect_authoring_clear_track`
   to revert a parameter to static behavior (both refuse a control that has no keyframes, and say which controls are animated).
5. **Tune timing.** Use `effect_authoring_set_timing` to configure total `duration` in ms and
   whether playback loops.
6. **Save presets.** When an interesting look is achieved, save it with `effect_authoring_save_preset`
   or restore known presets with `effect_authoring_apply_preset`.
7. **Verify visually.** When `effect_authoring_view` is available, capture rendered preview frames
   at specific times to visually confirm effect appearance. When `effect_authoring_describe` reports a
   `previewError` (typically a `vector` effect whose provider only draws it as SVG), there is no pixel
   preview: `effect_authoring_view` is refused with that reason, but values, presets, keyframes and
   timing still work. Judge the result from the values instead of retrying the view.
8. **House style.** When the host has one (`get_style` with `domain: "effect-authoring"`), run
   `check_effect_authoring_style` before saving. `fix_effect_authoring_style` sets the house
   timing in one step; save any missing house preset with `effect_authoring_save_preset`, move
   colour controls onto house colours with `effect_authoring_set_values`, and rewrite a source in
   a language the house does not allow from a template in one it does.

## Best practices

- **Batch parameter changes.** Set all related control values in a single `effect_authoring_set_values`
  call so they apply cleanly in a single undo step.
- **Write colours as hex.** A control with `type: "color"` in `effect_authoring_describe` takes
  `#rrggbb` (or `#rrggbbaa` when `alpha` is true), even when the provider's schema also accepts 0–1
  channel arrays or CSS colour strings (Flair's colours do). Hex keyframes blend smoothly. A control
  that is in `values` but has no entry in `controls` has a shape no field can edit. Set it only with a
  value that matches the provider's schema.
- **Check compile issues.** When editing source code via `effect_authoring_set_source`, always verify
  the returned `issues` array. Fix errors before attempting to preview or set controls.
- **Keyframe animation tracks.** Controls with active keyframes calculate their values dynamically
  based on the playhead time. Setting a value on an animated control at the current playhead updates
  or adds a keyframe at that time.
- **Safe exploration.** Use `effect_authoring_save_preset` before major shader or parameter
  refactoring, and use `effect_authoring_undo` / `effect_authoring_redo` to step through changes.

## Tools

| Tool | Description and usage |
| --- | --- |
| `open_effect_authoring` | Paint editor: opens a pixel expression template (`pixel.blank`, `pixel.rings`, `pixel.clouds`), an authored effect (`authored.<name>`) or a provider effect for authoring; returns source, controls, values and issues. One at a time: save or close first. Call before the `effect_authoring_*` tools. |
| `save_authored_effect` | Paint editor: trial-renders the open effect and saves it into the painting; returns its `authored.<name>` id, controls, keyframed controls and the trial ms. Then use the id with `set_effect_paint`, `set_paper_effect`, `add_effect_layer` or `fill_layer_with_effect`, or, for a filter (its source calls `sample`), with `apply_effect`. Saving again makes a new id. |
| `list_authored_effects` | Paint editor: the painting's authored effects with language, controls, animated controls, where each is used and any problem drawing it, plus the policy and the open session. |
| `remove_authored_effect` | Paint editor: removes an authored effect nothing uses (refused, saying where, while one is used). One undo step. |
| `close_effect_authoring` | Paint editor: closes the session without saving; returns the closed effect's name or null. |
| `check_effect_authoring_style` | Check the open effect against the house style: its source language, timing (duration and loop), the presets every effect ships, and the brand's colours on colour controls. Returns findings with a `target` (`{ timing }` with the house timing, `{ source }`, `{ preset }` or `{ control }`) and the checks that `ran` and were `skipped`. Refused when no effect is open. |
| `fix_effect_authoring_style` | Set the house timing on the open effect (duration within the limit, looping as the house says) as one undo step. Returns the `timing` it set, `duration` and `loop` now, and the findings `left`. Hidden when read-only. |
| `effect_authoring_describe` | Reads the currently open effect session: name, kind, source language, controls schema and current values, presets, animated tracks with keyframe counts, playhead `time`, duration, loop, compile issues, and `previewError` (why there is no pixel preview, or null). Call it first. |
| `effect_authoring_get_source` | Retrieves shader or script source code and language for code-backed effects. Refused if `sourceLanguage` is null. |
| `effect_authoring_set_source` | Recompiles the effect with new shader or script source code. Returns compiler issues with line numbers and messages. Available only when supported by the session. |
| `effect_authoring_set_values` | Sets one or more control values at the current playhead time as a single undo step. Rejects all changes if any control name or value is invalid. |
| `effect_authoring_reset_values` | Resets specified controls (or all controls if omitted) back to their schema defaults in a single undo step. |
| `effect_authoring_apply_preset` | Applies a built-in or user-saved preset by name, updating current control values in one undo step. |
| `effect_authoring_save_preset` | Saves the current control values as a user preset under the given name. Replaces an existing preset with the same name. |
| `effect_authoring_set_keyframe` | Adds or replaces a keyframe on a control track at a specific time in milliseconds, with optional value and easing curve. |
| `effect_authoring_remove_keyframe` | Deletes a keyframe at the exact millisecond timestamp from a control animation track. |
| `effect_authoring_clear_track` | Removes all keyframes from an animated control track. The control's value at the playhead becomes its static value. |
| `effect_authoring_set_timing` | Configures the effect's timeline duration in milliseconds and whether playback loops. |
| `effect_authoring_set_paint_hint` | Sets how the effect is best painted with (`paint`: `map` path, stroke or canvas, up to two `colors` controls for the brush's colours, `values`, `live`, `repeat`, `size`), or removes it with `null`. Saved in the document, so an authored effect saved after it starts `set_effect_paint` from the hint. Refused when it names controls the effect lacks; check `effect_authoring_describe` first. Returns the hint. |
| `effect_authoring_seek` | Moves the preview playhead to a specific timeline position in milliseconds (clamped to 0..duration) and returns values at that time. |
| `effect_authoring_undo` | Undoes the most recent edit in the authoring session. |
| `effect_authoring_redo` | Redoes the most recently undone edit in the authoring session. |
| `effect_authoring_view` | Captures a preview image of the effect at the current playhead or a specified timestamp. Available when preview capture is supported. Refused, with the reason, when `effect_authoring_describe` shows a `previewError`. |

## Pitfalls

- An authored effect id never changes what it draws: after changing the effect, save it again and
  use the new id (strokes painted with the old id keep their look).
- Keyframed controls of a saved effect animate with the effect's time and are not settable where
  the effect is used (`describe_effect` leaves them out); unkeyframe a control to make it settable.
- Live effect paint with an authored effect stops playing (each stroke keeps its own frame) after
  two frames over the 50 ms budget; `list_authored_effects` reports it. Make the effect cheaper.
- `save_authored_effect` refuses a source that doesn't compile now, even when an earlier version
  did; fix the errors first.

- Calling authoring tools when no authoring session is open returns an error explaining that a session must be opened first.
- Animated controls calculate their values dynamically from keyframes; clearing a track reverts the parameter to static behavior.
- Compiling invalid shader code produces issues in `effect_authoring_set_source`; inspect the line numbers and messages to correct syntax.
- A `vector` effect may have no pixel preview (the provider refuses a pixel renderer); check `previewError` rather than reading a blank capture as a broken effect.
- The playhead does not start at 0. Pass explicit `time`s to `effect_authoring_set_keyframe`, or `effect_authoring_seek` before setting values on an animated control.
- Control values must match their schema types and bounds; colours must be `#rrggbb` (or `#rrggbbaa`), and numbers must fall within `[min, max]`.
