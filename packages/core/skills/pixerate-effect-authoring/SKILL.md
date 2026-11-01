---
name: pixerate-effect-authoring
description: How to author and edit procedural effects, shaders, and filters through the effect authoring agent tools - inspecting effect schemas and current control values, reading and compiling shader source code, adjusting parameters with all-or-nothing validation, applying and saving presets, keyframing animation tracks with easing, configuring timeline playback duration and looping, scrubbing the playhead, and capturing visual previews. Use when asked to author, modify, or debug shaders or procedural effects, animate effect parameters over time, or when effect_authoring tools are available.
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

## Working method

1. **Inspect first.** Run `effect_authoring_describe` to inspect the effect name, kind, source
   language (`glsl`, `svg`, or null when the effect has no source to edit), control parameter schemas, current
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
| `effect_authoring_seek` | Moves the preview playhead to a specific timeline position in milliseconds (clamped to 0..duration) and returns values at that time. |
| `effect_authoring_undo` | Undoes the most recent edit in the authoring session. |
| `effect_authoring_redo` | Redoes the most recently undone edit in the authoring session. |
| `effect_authoring_view` | Captures a preview image of the effect at the current playhead or a specified timestamp. Available when preview capture is supported. Refused, with the reason, when `effect_authoring_describe` shows a `previewError`. |

## Pitfalls

- Calling authoring tools when no authoring session is open returns an error explaining that a session must be opened first.
- Animated controls calculate their values dynamically from keyframes; clearing a track reverts the parameter to static behavior.
- Compiling invalid shader code produces issues in `effect_authoring_set_source`; inspect the line numbers and messages to correct syntax.
- A `vector` effect may have no pixel preview (the provider refuses a pixel renderer); check `previewError` rather than reading a blank capture as a broken effect.
- The playhead does not start at 0. Pass explicit `time`s to `effect_authoring_set_keyframe`, or `effect_authoring_seek` before setting values on an animated control.
- Control values must match their schema types and bounds; colours must be `#rrggbb` (or `#rrggbbaa`), and numbers must fall within `[min, max]`.
