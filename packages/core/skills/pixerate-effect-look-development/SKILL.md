---
name: pixerate-effect-look-development
description: The look development workflow for Pixerate effects - reading an effect's controls, finding the look with a few deliberate value changes, saving looks as named presets, animating controls with keyframes and easing, setting duration and looping for seamless cycles, previewing at key moments, and editing shader source only when controls cannot get there. Use when asked to design, tune, tweak or animate an effect, shader, filter or procedural look, make a preset or variant of a look, make an effect fade in or out, pulse or loop, or when effect_authoring_describe, effect_authoring_set_values, effect_authoring_set_keyframe or effect_authoring_save_preset are available. Load with pixerate-effect-authoring, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-effect-authoring
---

# Developing a look

An effect is a set of controls over a shader or procedure. A look is a set of values for those
controls, kept as a named preset; an animated look adds keyframed tracks over a duration. Find
the look with a few deliberate moves (start from a preset, change one control at a time, look),
save it, and animate only what should change over time.

This skill is the method. `pixerate-effect-authoring` has the full tool reference.

## Goal and quality bar

- Every value is within its control's range (`effect_authoring_describe` lists `min`, `max`,
  `default`).
- The look is saved as a preset with a clear name, so it can be applied again.
- Animation uses as few keyframes as the motion needs, with easing (`ease-out` to arrive,
  `ease-in-out` for a pulse); duration fits the use.
- A loop is seamless: `loop` on, and the animated values match at the start and the end.
- `issues` is empty and `previewError` is null.

## Inputs to confirm

- **The look** in words (subtle, strong, warm, glitchy) or a reference.
- **Static or animated**, and the duration and looping for animation.
- **Whether to keep** the result as a preset, and its name.

## Working method

1. **Read.** `effect_authoring_describe`: controls with ranges and defaults, current values,
   presets, tracks, duration, loop, issues.
   **Check:** you know which control does what.
2. **Start close.** `effect_authoring_apply_preset` when a preset is near the look;
   `effect_authoring_reset_values` to start clean.
3. **Tune.** `effect_authoring_set_values` with only the controls you change, a few at a time;
   `effect_authoring_view` to look.
   **Check:** `values` in `effect_authoring_describe` are what you set; no `issues`.
4. **Save.** `effect_authoring_save_preset` with a descriptive `name` ("Subtle", "Warm glow").
   **Check:** the name is in `presets`.
5. **Animate.** `effect_authoring_set_timing` for `duration` and `loop`; then
   `effect_authoring_set_keyframe` per control at the times that matter, with `easing` into the
   next keyframe. For a loop, the last keyframe's value equals the first's.
   **Check:** `tracks` list the control with the keyframe count you meant.
6. **Preview** with `effect_authoring_seek` to key times and `effect_authoring_view`.
7. **Source last.** `effect_authoring_get_source` / `effect_authoring_set_source` only when no
   control can produce the look; read the returned issues and fix them.

## Decision table

| Want | Approach |
| --- | --- |
| A softer or stronger version of a look | Scale the main control (strength, amount); save as a preset |
| A starting point | `effect_authoring_apply_preset` |
| Back to defaults | `effect_authoring_reset_values` |
| Fade in | Keyframes from the neutral value to the look, `ease-out` |
| Pulse or breathe | Three keyframes (rest, peak, rest), `ease-in-out`, loop on |
| A one-off change at a moment | Two keyframes around the moment |
| Remove animation from a control | `effect_authoring_clear_track` |
| Something no control does | Edit the source |

## Recipes

**Quarter-strength preset.** `effect_authoring_set_values` `{ values: { amount: 0.25 } }` →
`effect_authoring_save_preset` `{ name: "Subtle" }`.

**Fade in over 1.5 s in a 2 s effect.** `effect_authoring_set_timing` `{ duration: 2000 }` →
`effect_authoring_set_keyframe` `{ control: "amount", time: 0, value: 0 }` → `{ control:
"amount", time: 1500, value: 1, easing: "ease-out" }`.

**Seamless 3 s pulse.** `effect_authoring_set_timing` `{ duration: 3000, loop: true }` → keyframes
at 0 (0), 1500 (1, `ease-in-out`) and 3000 (0, `ease-in-out`).

## Pitfalls

- **Values out of range** are clamped or refused; read the control's `min` and `max`.
- **Many keyframes** where three would do make motion lumpy and hard to edit.
- **Linear easing** on organic motion looks mechanical.
- **Loops that jump**: the end value must equal the start value.
- **Overwriting a preset** by saving under an existing name; choose a new name unless replacing
  is intended.
- **Editing source first**: controls are safer and keep presets working.

## Tools used

- `effect_authoring_describe`, `effect_authoring_view`, `effect_authoring_seek`: read, look and preview
- `effect_authoring_set_values`, `effect_authoring_reset_values`, `effect_authoring_apply_preset`: find the look
- `effect_authoring_save_preset`: keep the look
- `effect_authoring_set_timing`, `effect_authoring_set_keyframe`, `effect_authoring_remove_keyframe`, `effect_authoring_clear_track`: animate
- `effect_authoring_get_source`, `effect_authoring_set_source`: edit the shader when needed
- `effect_authoring_undo`, `effect_authoring_redo`: take back a step
