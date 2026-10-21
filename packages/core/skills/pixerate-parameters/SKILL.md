---
name: pixerate-parameters
description: How to read and change a Pixerate parameters panel (the schema-driven sliders, toggles, choices, colour pickers, vectors, image pickers and text fields behind an effect, shader, generator or component props) through its commands - listing parameters with their types, ranges, steps and defaults, setting several values as one undo step, resetting, seeded randomize, applying and saving presets, and toggling keyframes for animation. Use when asked to tweak an effect or shader, change a slider or control value, try variations, save or apply a preset, or animate a parameter, or when parameters.list and parameters.set appear in list_commands.
---

# Parameters panel

A parameters panel is a schema of fields, each with an `id`, a `type` and a `default`, plus the
current values. Types: `number` and `int` (optional `min`, `max`, `step`, `unit`), `boolean`,
`choice` (fixed options), `color` (`"#rrggbb"`, or `"#rrggbbaa"` when the field has alpha),
`vector` (an array of 2..4 numbers), `image` (a URL) and `text`. Fields can sit in groups and
can be hidden by `showIf` conditions on other values. The panel has built-in presets (from the
schema, read-only) and user presets, an undo history, and optionally a playhead `time` (ms)
with keyframes.

There are no dedicated tools: the panel registers commands, which you run with `run_command`
or `run_commands` (see `pixerate-agent-tools`). The ids below use the default `parameters.`
prefix; a host with several panels registers each with its own prefix, so find the right one
with `list_commands` (query "Parameters").

## Working method

1. **Read.** Run `parameters.list`. Note each field's `type`, `schema` (min, max, step,
   `options` for choices, `size` for vectors), `value`, `default`, `visible`, and `keyframe`
   state; and the `presets` and playhead `time`.
2. **Plan** the values from the user's intent in the field's own units and ranges. Check
   whether a preset already gives the look (`parameters.applyPreset`).
3. **Write once.** Put every value of one change into one `parameters.set` call: it validates
   all values first and applies them as one undo step, or changes nothing and says why.
4. **Check** the returned `changed` ids and `values`. If a field you set is `visible: false`,
   its value is stored but has no effect until its `showIf` condition holds; set the
   controlling field too.
5. **Verify visually** with the host's render or view tool when one exists (for example
   `view_editor` or the editor's `render_*` tool); parameters themselves have no preview.

## Best practices

- **Respect the schema.** Stay within `min`/`max`; land on the `step` grid; give `int` fields
  integers; give choices one of their listed option values (not labels); give vectors exactly
  `size` numbers. Units (`unit`: x, px, %, degrees, ms) mean what they say; do not convert.
- **Change little at a time.** Move the parameters that drive the user's request and leave the
  rest. Large simultaneous changes make it hard to tell which one caused the result.
- **Presets for reuse.** When the user likes a result, offer to save it with
  `parameters.savePreset` and a descriptive name (and `description`). Apply presets with
  `merge: true` to layer a look over the current values; without it, fields the preset leaves
  out return to defaults.
- **Randomize with care.** Randomize only for exploration and say so. Pass `ids` to limit it to
  the fields that should vary, and a `seed` so the result can be reproduced and reported.
  Save a preset first if the current values matter; undo restores them otherwise.
- **Keyframes for animation:** set the value at a time, then toggle a key there. Use as few
  keys as the motion needs; let the timeline's easing do the in-betweens.
- **Defaults are the baseline.** `parameters.reset` with specific `ids` is the clean way back
  for one control; resetting everything discards the user's work, so confirm first.

## Commands

| Command | Use it to |
| --- | --- |
| `parameters.list` | Read every field (id, label, type, description, value, default, visible, keyframe state, and a JSON Schema with ranges, options or vector size), the preset names and the playhead `time` in ms. Read-only; run it first and after schema changes. |
| `parameters.set` | Set one or more values: `{ "values": { "<id>": value } }`. All-or-nothing and one undo step; its params schema is generated from the current fields, so types and ranges are enforced. Returns `changed` ids and all `values`. Ints are rounded and colours normalised to lower-case hex; any other invalid value refuses the whole call with a sentence naming the field. |
| `parameters.reset` | Return fields to their defaults: `ids` (default all). Disabled when nothing is modified and no ids are given. Returns `values`. |
| `parameters.randomize` | Pick random values within each field's range, snapped to steps: `ids` (default all visible fields, skipping read-only, `randomize: false`, image, text and unbounded number fields) and `seed` (integer) for a repeatable result. Explicit `ids` are randomized even when hidden. Returns `changed` and `values`. |
| `parameters.applyPreset` | Apply a preset by `name` (from `parameters.list` presets). Fields it leaves out return to defaults unless `merge: true`. Disabled when there are no presets. Returns `values`. |
| `parameters.savePreset` | Save the current values as a user preset: `name` (required), optional `description`. Replaces a user preset with the same name; a built-in preset's name is refused. Returns `presets`. |
| `parameters.deletePreset` | Delete a user preset by `name`. Built-in presets cannot be deleted; disabled when there are no user presets. Returns `presets`. |
| `parameters.toggleKeyframe` | Add a keyframe with the field's current value at `time` (ms, default the playhead), or remove the key already there: `id` (required), `time`. Returns `keyed` (true when added) and the time. Disabled when the panel has no keyframe support. |
| `parameters.undo` | Undo the last parameter change (a `parameters.set` call, preset, reset, randomize or keyframe toggle is one step). Disabled when there is nothing to undo. |
| `parameters.redo` | Re-apply the change just undone. Disabled when there is nothing to redo. |

## Pitfalls

- With agent playback on, `parameters.set` visits each control it changes and types the value. Set related values in one call; results are unchanged.
- `parameters.set` takes a `values` object, not top-level ids: `{ "values": { "speed": 2 } }`.
- One out-of-range value fails the whole call (nothing changes). Read the message, fix that
  value, and resend the full set.
- Choice values are option `value`s, which can differ from labels (`"bars"`, not `"Bars"`).
- Colours are hex strings; `"#rrggbbaa"` only on alpha fields. Vectors are arrays, not objects.
- `toggleKeyframe` is a toggle: running it twice at the same time removes the key. Check
  `keyed` in the result and `keyframe` in `parameters.list` (`none`, `animated`, `keyed`).
  To key a new value, `parameters.set` it at the playhead first, then toggle; on an existing
  key, setting the value updates that key.
- The schema can change while you work (a shader recompiles); run `parameters.list` again
  when a set fails with an unknown id.
- Do not edit fields marked read-only in their schema unless the user asks for it explicitly.
