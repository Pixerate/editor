---
name: pixerate-animation-motion-graphics
description: The motion graphics workflow in the Pixerate animation editor - planning one idea per shot, staggered entrances, easing and springs that feel natural, timing and holds that let the viewer read, fitting a target length, syncing to music, checking for issues and exporting to Lottie or Flair. Use when asked to animate, add motion to, make an explainer, a title sequence, an animated infographic, a UI or icon animation, staggered or sequenced entrances, smoother or snappier motion, or to fit an animation to a length, or when insert_shots, add_commands, fit_animation or check_animation are available. Load with pixerate-animation-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-animation-editor
---

# Making motion graphics

Motion graphics direct attention: each shot shows one idea, things enter in the order they
should be read, motion eases the way real objects move, and the viewer gets time to read
before the next change. Write whole shots at once, let the default durations set the pace, and
change timing by shot (holds, speed, `fit_animation`) rather than nudging every command.

This skill is the method. `pixerate-animation-editor` has the full tool reference and
`references/commands.md` every command.

## Goal and quality bar

- One idea per shot, with a `label` saying what it shows.
- Related elements enter in reading order with a short stagger (60-200 ms between them), not
  all at once and not one long queue.
- Every move and entrance eases (`ease-out` for things arriving, `ease-in` for leaving,
  `ease-in-out` for moves, springs for playful motion); `linear` only for continuous motion
  such as a rotation or a ticker.
- Holds give the viewer time to read: about 0.5 s plus 0.3 s per short line of text.
- The length fits the brief (`fit_animation`), and `check_animation` shows no errors or
  warnings.

## Inputs to confirm

- **The message and order** the viewer should see things in.
- **Length** and **where it plays** (a loop on a site, an ad slot, a video).
- **Style:** calm and smooth, or snappy and playful; music and its tempo, if any.

## Working method

1. **Read.** `get_animation` for elements (ids, bounds), shots and issues. If there is no
   artwork, `set_animation_artwork_svg` with an id on every element you will animate.
2. **Plan the shots** in words: what enters, moves or changes in each, and in what order.
3. **Write whole shots** with `insert_shots`: a `run` of commands with `targets`, `style`,
   `stagger`, `ease`; leave `duration` out unless the pace must change; set `hold`.
   **Check:** `get_animation`: each command's `start` and `end` are in the order you planned.
4. **Stagger and ease.** One `enter` with several `targets` and a `stagger` for a group; `ease`
   presets or springs on moves (`update_command` `set: { ease }` to fix one).
   **Check:** per-target starts differ by the stagger; no move left `linear` unless meant.
5. **Fit and cue.** `fit_animation` with `seconds` (and `keep` for shots whose pace matters,
   such as a final hold); with music, `set_animation_settings` `beat` and shots `at: { beat }`
   (see `pixerate-animation-logo-reveal`).
   **Check:** `get_animation` `duration`.
6. **Check.** `check_animation`: fix `too-fast`, `overlap`, `out-of-frame`, `enter-visible` and
   the rest. `get_motion_path` for spacing and arcs.
7. **Look and export.** `render_animation_frame` with `times` for a contact sheet; export with
   `export_lottie` or `export_flair_motion` when asked.

## Decision table

| Want | Command and settings |
| --- | --- |
| A group appears in reading order | `enter` with several `targets`, `stagger` 60-200 |
| Something arrives | `enter` (`fade`, `rise`, `slide`, `pop`), `ease-out` |
| Something leaves | `exit`, `ease-in`, shorter than its entrance |
| A position change | `move` with `by` or `to`, `ease-in-out` |
| Playful, bouncy | `ease` `spring-bouncy` or `ease-out-back` |
| Draw a line or outline | `draw`, or `enter` `style: "draw"` |
| Attention on one element | `pulse`, `shake`, `wiggle` (sparingly) |
| A set length | `fit_animation` with `seconds`, `keep` for fixed shots |
| The camera travels to the next part | `update_shot` camera `frame`, then `set_shot_camera_move` role `transition` (a glide; a whip pan for energy) |
| A slow push while a shot holds | `set_shot_camera_move` role `hold` (a Ken Burns drift), with a longer `hold` |

## Recipes

**Staggered entrance.** `insert_shots` `[{ id: "bars", label: "Bars enter", run: [{ type:
"enter", targets: ["bar1", "bar2", "bar3"], style: "rise", stagger: 120 }], hold: 800 }]`.

**Natural move.** `update_command` `{ shot, command, set: { ease: "ease-in-out" } }`.

**Exactly four seconds.** `fit_animation` `{ seconds: 4 }`; then `check_animation` for
`too-fast` if shots were compressed a lot.

## Pitfalls

- **Everything at once.** Simultaneous entrances give the eye nowhere to start.
- **Linear moves** look mechanical; ease them.
- **Hand-set durations everywhere** make pacing inconsistent; keep the defaults and change pace
  per shot.
- **No hold** at the end of a shot: the viewer cannot read it before it changes.
- **Overlapping commands** on one element fight each other (`overlap` in `check_animation`).
- **Elements without ids** in the artwork cannot be animated; add ids before importing.

## Tools used

- `get_animation`, `get_shot`, `find_animation_elements`, `describe_animation_command`: read scenes, elements and command fields
- `set_animation_artwork_svg`: the artwork with ids
- `insert_shots`, `update_shot`, `delete_shots`, `move_shot`: whole shots
- `add_commands`, `update_command`, `delete_commands`, `move_command`: refine commands
- `edit_animation`: several edits as one undo step
- `fit_animation`, `set_animation_settings`, `get_timing_grid`: length, settings and cues
- `list_camera_moves`, `set_shot_camera_move`: provider camera moves into and during a shot
- `check_animation`, `get_motion_path`, `render_animation_frame`: check and look
- `export_lottie`, `export_flair_motion`: deliver
- `undo_animation`: take back a step
