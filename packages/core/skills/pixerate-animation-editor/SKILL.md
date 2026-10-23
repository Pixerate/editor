---
name: pixerate-animation-editor
description: How to author and edit vector animations (motion graphics, logo reveals, animated icons, explainer scenes, UI micro-interactions) in the Pixerate animation editor through its agent tools - artwork SVG with ids, shots of commands (enter, exit, draw, move, rotate, scale, fade, morph, Smart Animate match, follow a path, pulse, shake, wiggle), easing and springs, stagger, camera, beat and voiceover cues, drivers, reusable clips, checking, rendering frames and contact sheets, and exporting to Flair or Lottie. Use when animation tools such as get_animation, insert_shots or edit_animation are available, or when asked to animate, time, ease, stagger or export vector motion, and provider motion and vector effects (for example Flair) applied to nodes.
---

# Pixerate animation editor

A scene is **artwork** (an SVG parsed into vector paths and groups, each with an id) plus an
ordered list of **shots**. A shot optionally moves the camera, plays its `run` of commands,
then holds (default 600 ms). Commands play one after another unless `"with": "previous"`;
each has a default length taken from the content (enter 600 ms, exit 450, move 700, draw
follows the path length), so leave `duration` out unless you mean to change the pace. Every
frame is a pure function of time.

Ids: element ids come from `get_animation` (`elements`) or `find_animation_elements`; shot ids
are ones you choose (`"intro"`); commands are addressed by shot id plus their index in the run.
Times are milliseconds, positions are document units of the artwork. Anything that enters
later is hidden until its `enter`; anything that never enters is visible from the start.

For errors, namespaced tool names and the generic command tools, see `pixerate-agent-tools`.
The full command vocabulary (every type, option and default) is in
[references/commands.md](references/commands.md).

## Working method

1. **Read.** `get_animation` for elements, shots with timing, clips, drivers and issues. If
   there is no artwork, `set_animation_artwork_svg` first (give every element you will animate
   an id), or start from `import_flair_effect` / `import_pptx_animation`. For outlined text,
   `get_text_layout` shows the letter, word and line units.
2. **Plan shots, one idea each.** Write down what the viewer should notice in each shot and in
   what order, then map each beat to a command. Hidden end states (morph / match targets,
   follow paths) must exist in the artwork before you reference them.
3. **Write in batches.** `insert_shots` for whole shots; `edit_animation` for several related
   edits as one undo step (`dry_run: true` first when unsure; `"$0.indexes[0]"` and
   `"$last.shot"` refer to earlier ops). Refine with `add_commands`, `update_command`,
   `move_command`, `delete_commands`. Use `write_animation` only to replace every shot.
   For a command type you have not written before, `describe_animation_command` returns its
   exact fields first.
   For motion that should feel performed rather than keyed (a hand-drawn swoop, a jittery
   drag, a colour picked mid-move), `record_animation_take` with timed samples records it as
   one shot, the way a person records live on the stage.
4. **Fit and cue.** `fit_animation` to hit a length (keep shots whose pace matters). For music
   or voiceover, `set_animation_settings` with `beat` or `narration`, read cues with
   `get_timing_grid`, and give shots `"at": { "beat": n }` or `{ "word": i }`.
5. **Check.** `check_animation`; fix every error and warning (codes such as `too-fast`,
   `overlap`, `out-of-frame`, `enter-visible`, `cue-missed`). Use `get_motion_path` for
   spacing and arcs as numbers.
6. **Look.** `render_animation_frame` with `shot` + `at: "end"`, or `times` for a contact sheet,
   plus `onion_skin` / `motion_paths` to see motion in one picture. Render after a batch, not
   after every edit. `seek_animation` shows the person a moment.
7. **Export** when asked: `export_flair_motion`, `export_flair_effect` (after
   `set_animation_controls`) or `export_lottie`; read the returned notes on what was sampled
   or dropped.

## Best practices

- **One idea per shot, one focal motion at a time.** Stage the action so the eye knows where
  to look; secondary elements move less, later, or not at all. Use the camera (`frame` a
  node) to direct attention rather than moving everything.
- **Ease every change.** Arrivals ease out (decelerate into place; the default for `enter`),
  exits ease in (`exit` with `ease: "ease-in"`), moves ease in-out (the default). Use `linear`
  only for mechanical motion (a constant spin, a progress bar) or loops.
- **Timing by size and distance.** Small UI changes 150-300 ms, element entrances 300-600 ms,
  large moves and camera moves 600-1200 ms. Nothing under 120 ms (`too-fast`). Big things
  move slower than small things.
- **Anticipation and follow-through.** `ease-in-back` for a wind-up before a fast exit;
  `pop`, `rise`, `ease-out-back` or a spring preset (`spring-gentle`, `spring-quick`) for
  overshoot and settle on arrival. Use `spring-bouncy` sparingly; it reads as playful.
- **Overlapping action.** Stagger related items 40-120 ms (`stagger`, or `split` with
  `cascade` for text) instead of moving them in lockstep; start secondary motion with
  `"with": "previous"` plus a small `delay` so it trails the lead.
- **Arcs.** Natural movement curves: use `move` with `via` waypoints (one smooth path) instead
  of chained moves that stop at each point, or `follow` a path node.
- **Recorded takes.** Sample a performance at 30-60 per second; the recorder keeps only the
  points that matter (raise `tolerance` for fewer, cleaner commands). Begin each moving
  element with a sample at its current pose (`get_motion_path`'s last point, or its bounds'
  centre at rest) or it jumps there at its first sample. A take is a new shot after the others
  (or at `at`); it cannot be layered over an existing shot. Refine it like any shot: it is
  ordinary `move` (with `via` and `times`), `scale`, `rotate`, `fade` and `style` commands.
- **Hold long enough to read.** Leave each result on screen (shot `hold`, default 600 ms);
  roughly 250 ms per word for text that must be read, longer for the final frame or logo.
- **Exaggeration with restraint.** Emphasis (`pulse`, `shake`, `teeter`, `color-pulse`) is for
  one thing that needs attention, once; it returns to rest on its own.
- **Motion blur** only for genuinely fast motion (`motionBlur: { shutter: 180 }`); it affects the
  stage and rendered frames, not Flair or Lottie exports.
- **Accessibility.** Avoid flashing: never more than three flashes a second (WCAG 2.3.1), so
  keep `color-pulse` and fades on large areas slow and few. Avoid large-scale parallax, zooms
  and spinning for essential UI motion; ship a reduced-motion alternative (the host should
  swap in a fade or the end state under `prefers-reduced-motion`; this editor does not
  generate one). Loops that run longer than 5 s need a way to pause (WCAG 2.2.2).
- **Interactive pieces.** For a button or toggle set `trigger` (`click`, `hover`, `press`,
  `scroll`); for a click toggle, make the last shot restore the starting state.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_animation` | Start here. Returns name, artwork size, length (ms), loop, elements (id, type, name, parent, bounds, solid paints, live effects with numeric params), every shot with each command's index, start, end and `flairPrimitive`, clips, drivers, controls and an issue summary, plus `readOnly` when edits are refused. `includeElements: false` (default true) skips the element list on large artwork. |
| `get_shot` | Read one shot as stored (`shot` id) with its start/end and each command's start/end in ms; cheaper than `get_animation` while refining one shot. |
| `describe_animation_command` | Before writing a command type you have not used yet, or when a write rejects a field: returns the full JSON Schema of each of `types` (e.g. `["enter", "move"]`), with every field's type, range, default and meaning and which are required. The write tools list every command field once in short, prefixed with the types that take it. |
| `find_animation_elements` | Find elements whose id or name contains `query` (case-insensitive; `limit` default 20, max 200) when the artwork is large. Returns id, type, name, parent, bounds, paints, effects. |
| `get_text_layout` | Before animating outlined text with `split`: returns the `group`'s lines, words and letter ids in reading order. Errors if the element is not a group of paths (convert text to outlines, one path a letter, and group it). |
| `get_motion_path` | Check spacing, arcs and landing points as numbers: samples a `node`'s centre (document units) from `from` to `to` ms every `step` ms (default 33, at most 400 samples), with where each moving change starts and ends. |
| `get_timing_grid` | List beats (number, ms, bar, beat in bar) and narration words (index, text, start, end) between `from` and `to` (`limit` default 200), and which shot plays at each, to choose `at` cues. Empty, with a hint, when no beat grid or narration is set. |
| `check_animation` | After every batch of writes. Lists issues with a code, severity, shot, command index, node ids, measured vs needed values and how to fix it. Fix errors and warnings; notes are advisory. |
| `render_animation_frame` | Look at the result: `time` (ms) or `shot` + `at` (`start`, `middle`, `end`; default end). `times` (2-16 moments) makes a labelled contact sheet (`columns` 1-8). `onion_skin` adds ghost frames (`before` default 2, `after` 0, `spacing` ms or `"commands"`); `motion_paths` (true or ids) draws travel paths. SVG by default; `format: "png"` only when the host can rasterize. |
| `export_flair_motion` | Get the scene as a Flair SvgMotion `{ svg, animate }` with hold, sampled-step count and notes. `fps` (default scene fps, else 30), `curves` and `behaviors` (default true), `flair` target version (default 0.39; older versions get springs, steps, behaviours and curves sampled). |
| `export_flair_effect` | Get a Flair catalog vector effect (`id` kebab-case, `name`, `description`, `category` default icon, `tags`, plus `curves` / `behaviors` / `flair` as above). Call `set_animation_controls` first so colours become `{{name: color}}` controls. |
| `export_lottie` | Get Lottie (Bodymovin v5) JSON for lottie-web and mobile players, with a marker per shot, `fps` (default scene fps, else 30), the sampled keyframe count and notes on what was not carried over (gradients, dashes, reveal clips, morphs that change point counts). |

### Write

| Tool | Use it to |
| --- | --- |
| `seek_animation` | Show the person a moment: `time` (ms) or the start of a `shot`, with `play` true or false. Does not change the scene. |
| `set_animation_artwork_svg` | Replace the artwork with a standalone `svg` (with a viewBox) as one undo step. Put an id on every element you will animate; refused if existing shots name ids the new artwork lacks. Returns the elements. |
| `import_pptx_animation` | Replace the whole scene with a PowerPoint slide's shapes and animation pane (`data` base64 .pptx, `slide` default 1): one shot per click, delays, repeats and acceleration kept; text, pictures and charts are left out with notes. Run with `dry_run: true` first. |
| `set_animation_drivers` | Replace all drivers (empty list clears): a target's `x`, `y`, `rotation`, `scaleX`, `scaleY` or `opacity` follows a source node's property as change · `factor` + `offset`, optionally `clamp`ed. For parallax, wheels that turn as they roll, shadows that fade as something rises. |
| `set_animation_clip` | Define, replace or (with `clip: null`) delete a named reusable clip whose `run` targets `"$"`; play it with a `play` command on any nodes. Prefer a clip over repeated identical commands. |
| `copy_animation` | Give the nodes in `to` every command that animates `from` (all shots or `shots`), each copy starting with its original, optionally `stagger`ed (ms). Quick for one-off duplication; use a clip for motion you will reuse. |
| `record_animation_take` | Record performed motion as a new shot (one undo step): `samples` of `{ node, t (ms into the take), x, y (centre), scaleX, scaleY, rotation, opacity, fill, stroke, strokeWidth }` become a `move` through waypoints at the recorded `times` and a few eased `scale` / `rotate` / `fade` / `style` commands, each starting when it happened. Optional `length`, `id`, `label`, `at`, `tolerance`; `dry_run: true` returns the run first. Returns the shot id, its start and each command's index, type, start and end; `check_animation` and `render_animation_frame` after. |
| `fit_animation` | Make the scene last `seconds` by setting shot `speed`, keeping proportions; shots in `keep` play as written. `dry_run: true` reports the new length and speeds first. |
| `import_flair_effect` | Replace the whole scene with a Flair vector `effect` or SvgMotion `motion` (give exactly one; optional `name`). Placeholders become colour controls; each Flair step becomes a shot. Use `dry_run: true` first. |
| `insert_shots` | Add one or more complete shots (`id`, `run`, optional `label`, `camera`, `hold`, `speed`, `at`) at position `at` (default the end). Returns every shot's timing and issues. |
| `update_shot` | Change one shot's `label`, `camera`, `run`, `hold`, `speed`, `at` or `id` via `set`, and clear `label`, `camera`, `hold`, `speed` or `at` via `remove`. |
| `delete_shots` | Remove shots by id (one undo step). |
| `move_shot` | Reorder a shot to index `to` (0 = first). |
| `add_commands` | Add commands to a shot's run at index `at` (default the end). Returns the indexes they got and their timing; use those indexes for later updates. |
| `update_command` | Change one command (by `shot` and `command` index): fields in `set` replace, names in `remove` clear (e.g. `"delay"`). Returns the command and its timing. |
| `delete_commands` | Remove commands from a shot by index; later commands move up, so re-read indexes afterwards. |
| `move_command` | Move one command to index `to` in its run; a `"with": "previous"` command then starts with its new neighbour. |
| `set_animation_settings` | Set `name`, `description`, `loop` (none, loop, ping-pong), `trigger` (click, hover, press, scroll, or null), export `fps` (default 30), scene `steps` (12 = on twos; null smooth), `motionBlur`, `beat` (`bpm`, `offset`, `meter`), `narration` word timings, or `target` length [min, max] seconds. |
| `set_animation_controls` | Set the colour controls (`name`, `type: "color"`, `default` #rrggbb used in the scene, `label`) and `presets` a Flair effect exposes. Replaces existing controls; an empty list clears. |
| `edit_animation` | Apply several ops (`set_settings`, `insert_shots`, `update_shot`, `delete_shots`, `move_shot`, `add_commands`, `update_command`, `move_command`, `delete_commands`, `set_controls`) as one all-or-nothing undo step; refer to earlier outcomes with `"$0.indexes[0]"`, `"$last.shot"`. `dry_run: true` validates without applying. The default for multi-step changes. |
| `write_animation` | Replace every shot (and optionally settings, controls, presets) while keeping the artwork. Only for a full rewrite; per-operation tools give better errors. |
| `undo_animation` | Undo your last edit (one tool call or one `edit_animation` batch). |
| `redo_animation` | Redo the edit you just undid. |

### Effects

These tools come from `createAnimationEffectsToolProvider` and work when the host has registered an
effects provider (for example Flair). Without one, `search_effects` and `describe_effect` return
`available: false`, `list_applied_effects` still lists what the scene holds, and the write tools
refuse.

| Tool | Use it to |
| --- | --- |
| `search_effects` | Find effects: `kind` motion (primitives to apply to nodes) or vector (effects with their own picture), `query`, `category`. |
| `describe_effect` | Read an effect's `controls` (names, ranges, units), `defaults` and `presets`, and whether it `appliesHere` (a motion effect). |
| `list_applied_effects` | See the provider effects in the scene: their `instance` ids, the nodes they animate, their shots and values. |
| `apply_effect` | Animate a node (`target`, a group animates as one) with a motion effect: the changes become ordinary commands, tagged with the effect, in a new shot after the last. Returns the instance id. |
| `update_effect` | Make an applied effect again with new `values`, in the same place (`effect` is its instance id). |
| `remove_effect` | Remove an applied effect: its commands, shots it alone filled and a vector effect's group. |
| `add_vector_effect` | Add a vector effect's own picture as an artwork group (fitted into `box`) with its motion as new shots. Returns the instance and group ids. |

## Pitfalls

- With agent playback on, the cursor clicks the shot a call names in the timeline and visits the stage elements its commands target. Results are unchanged.
- **Effect commands are ordinary commands.** You can retime or edit them with `edit_animation` like
  any command, but `update_effect` replaces all of an effect's commands. Change values through the
  effect, and timing through the commands.
- **Some provider motion cannot be carried over.** Counting, writing text and similar changes are
  skipped. The result's `notes` say what was left out.

- **Fields belong to types.** The write tools' command schema lists every field of every type
  once; a field the type does not take (`clip` on a `move`, `to` as a point on a `fade`) is
  refused when the edit is applied, naming the shot, command and field. Call
  `describe_animation_command` for the exact fields of a type rather than guessing.
- **Unknown ids are refused** with a "did you mean" suggestion. Take ids from `get_animation` or
  the elements `set_animation_artwork_svg` returns; never guess them.
- **`enter-visible`**: an element that enters while already showing blinks out first. Give an
  element that should appear later an `enter` before anything else moves it; do not `enter` an
  element that should be visible from the start. `exit-hidden` is the reverse: enter it first.
- **`overlap`**: two commands changing the same property at once; the later takes over. Sequence
  them, or use `"blend": "add"` on move, rotate or scale to stack. Emphasis already stacks.
- **Reveals need a box**: `wipe`, `iris`, `split` on a lone straight line fade instead
  (`reveal-no-box`); use `draw` / `undraw` for lines.
- **Morph and match targets stay hidden.** Draw the end state as a separate hidden node or group;
  for `match`, parts the end state adds need a partner (same name) in the start group, or they
  never appear (`match-unpaired`).
- **Draw a group one way.** Do not mix per-stroke drawing (`order`, `pace`, `comet`) with a plain
  `draw` on the same group in one scene.
- **Indexes shift.** After `delete_commands` or `move_command`, indexes change; use what the write
  returned or `get_shot` before the next index-based edit.
- **Springs set their own length.** Leave `duration` out with a spring; a short `duration` cuts it
  off (`spring-cut-short`).
- **Click triggers** play nothing until the first click; each click plays the next shot. A
  triggered scene ignores `loop` (`trigger-loop`), and clicks decide when shots start, so do not
  give its shots `at` cues (`click-cue`).
- **Exports approximate.** Motion blur is never exported; Lottie drops gradients, dashes and reveal
  clips; back eases on colours or opacity are sampled for Flair. Read the notes and tell the
  user what changed.
- **Read-only**: when `get_animation` returns `readOnly`, write tools are hidden; read, render and
  export still work. Tell the user rather than working around it.
