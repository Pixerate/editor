---
name: pixerate-animation-logo-reveal
description: The logo reveal workflow in the Pixerate animation editor - a short branded intro or sting (two to four seconds) built from the logo's own parts - drawing or building the mark, bringing in the wordmark, landing beats on the music, ending on the complete logo held long enough to read, and exporting for video, web or Lottie. Use when asked to animate a logo, make a logo reveal, intro, outro, sting, bumper, brand animation or animated signature, sync a logo to music, or make a logo animation end cleanly, or when set_animation_artwork_svg, insert_shots, set_animation_settings or export_lottie are available. Load with pixerate-animation-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-animation-editor
---

# Animating a logo reveal

A logo reveal is short and has one job: the viewer remembers the logo. It builds the logo
from its own parts (the mark, then the wordmark, or the reverse), moves in a way that suits the
brand, and ends on the complete, still logo long enough to read. Everything else is
decoration and should be cut if the reveal runs long.

This skill is the method. `pixerate-animation-editor` has the full tool reference and
`references/commands.md` every command.

## Goal and quality bar

- Two to four seconds in total (`get_animation` `duration`), unless the brief says otherwise.
- The logo is built from its parts in a clear order: the mark first (drawn on, popped or
  assembled), then the wordmark.
- It ends on the finished logo, exactly as in the brand artwork, held at least 0.5 s
  (about 1 s for video).
- The motion suits the brand: calm brands ease smoothly, playful ones can spring.
- With music, the key moments land on beats.
- `check_animation` shows no errors or warnings.

## Inputs to confirm

- **The logo artwork** (SVG with ids on the mark, the wordmark and any parts that move
  separately).
- **Length, use and music:** a video intro, a web header loop, an outro; the tempo if there
  is music.
- **Character:** calm, confident, playful, technical.

## Working method

1. **Read the artwork.** `get_animation` elements; if the logo is not loaded,
   `set_animation_artwork_svg` with ids on its parts (outline text first; `get_text_layout`
   shows letter units).
   **Check:** every part you will animate has an id.
2. **Plan the build** in two or three beats: the mark arrives, the wordmark follows, the logo
   settles.
3. **Write the reveal** as one or two shots with `insert_shots`: `enter` `style: "draw"` for an
   outlined mark (or `pop`, `grow`, `iris`), then `enter` the wordmark (`slide`, `fade`, a
   `wipe`, or `split: "letter"` for outlined text); `hold` at the end.
   **Check:** `get_animation`: the mark's command starts before the wordmark's; the last shot
   ends with a hold.
4. **Hit the music.** `set_animation_settings` `beat` with the `bpm`; `get_timing_grid` lists the
   beats (counted from 0 at the start: at 120 BPM beat 4 is at 2000 ms, the downbeat of bar 2);
   give the wordmark's shot `at: { beat }`.
   **Check:** the shot's `start` in `get_animation` is the beat's time.
5. **Length and hold.** `fit_animation` with `seconds` and `keep` for the final hold, or
   `update_shot` `hold` on the last shot.
   **Check:** `duration` in range; the hold after the last command is long enough.
6. **Check and export.** `check_animation`; `render_animation_frame` at the end (`shot`, `at:
   "end"`) to see the finished logo; `export_lottie` for the web.

## Decision table

| Mark | Entrance |
| --- | --- |
| An outline or line mark | `enter` `style: "draw"` (outline, then fill) |
| A solid, simple shape | `pop` or `grow`, `ease-out-back` |
| A mark made of parts | `enter` parts with `stagger`, or `match` into place |
| Outlined text wordmark | `enter` with `split: "letter"` |
| A wordmark beside the mark | `slide` away from the mark, or `wipe` |
| A calm brand | `fade`, `rise`, `ease-out`; no springs |
| A playful brand | `pop`, springs, a small `pulse` on landing |

## Recipes

**Draw then word.** `insert_shots` `[{ id: "reveal", run: [{ type: "enter", targets: ["mark"],
style: "draw" }, { type: "enter", targets: ["wordmark"], style: "slide", direction: "right" }],
hold: 700 }]`.

**Hold the end.** `update_shot` `{ shot: "reveal", set: { hold: 1000 } }`.

**On beat 4 at 120 BPM.** `set_animation_settings` `{ beat: { bpm: 120 } }` → `update_shot`
`{ shot: "word", set: { at: { beat: 4 } } }`.

## Pitfalls

- **Too long.** A reveal over four seconds loses the viewer; cut decoration first.
- **Ending in motion.** The logo must be still and complete at the end; hold it.
- **Distorting the logo** (stretching, recolouring) in the final frame; end on the brand
  artwork.
- **Live text** in the artwork may render with a fallback font; outline it first.
- **Off-beat landings** with music feel wrong; cue shots to beats.
- **Too many effects** compete with the logo; one entrance per part.

## Tools used

- `get_animation`, `get_text_layout`, `find_animation_elements`: read the logo's parts
- `set_animation_artwork_svg`: load the logo with ids
- `insert_shots`, `update_shot`, `add_commands`, `update_command`: build the reveal
- `set_animation_settings`, `get_timing_grid`: music tempo and beats
- `fit_animation`: hit the length
- `check_animation`, `render_animation_frame`: check and look at the end frame
- `export_lottie`, `export_flair_motion`: deliver
- `undo_animation`: take back a step
