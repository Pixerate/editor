---
name: pixerate-video-colour-grade
description: The colour grading workflow in the Pixerate video editor - correcting each shot first (exposure, contrast, white balance) so a scene matches, then one look over the whole piece on an adjustment clip, LUTs at a sensible strength with skin tones protected, masks for spot changes, and checking with scopes and frames. Use when asked to colour correct, colour grade, match shots, fix exposure or white balance in a video, add a look, a LUT, a film or cinematic look, warm or cool a video, or protect skin tones, or when update_video_clip grade, add_video_adjustment_clip, set_video_lut or get_video_scopes are available. Load with pixerate-video-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-video-editor
---

# Grading a video

A grade has two passes. **Correction** makes each shot right and makes shots in a scene match:
exposure, contrast and white balance on the clip's own `grade`. **The look** is one creative
decision over everything: an adjustment clip above the timeline with its own grade or a LUT,
so it is changed in one place. Faces are the reference: people notice skin that is wrong before
anything else.

This skill is the method. `pixerate-video-editor` has the full tool reference.

## Goal and quality bar

- Shots in a scene match in brightness and colour; cuts between them do not jump.
- Corrections are moderate: exposure within about ±1 stop, contrast and saturation within
  ±0.3, white balance within ±0.3, unless a shot is badly off.
- One look, in one place: an adjustment clip over the whole timeline (or one per scene), not
  the same settings pasted on every clip.
- Skin stays natural under strong looks (skin protection 0.5-0.8 on LUTs).
- The original corrections are not overwritten by the look.

## Inputs to confirm

- **The look:** natural, warm, cool, desaturated, high contrast, a named LUT; or a reference.
- **Which shot is the reference** for matching (the best-exposed, or the one the user likes).
- **Where the LUT file is** (a `.cube` path or URL the host can load).

## Working method

1. **Read.** `get_video_project` for clips and their `grade`; where the host has a preview,
   `get_video_scopes` at a frame of each shot reads levels and colour in numbers.
   **Check:** you know which shots are off and by how much.
2. **Correct the reference shot** (`update_video_clip` `set.grade`): exposure first, then
   contrast, then white balance (`temperature`, `tint`). The grade object replaces the clip's
   whole grade, so pass every setting you want to keep.
3. **Match the others to it.** A shot one stop under gets `exposure: 1`; a cooler shot more
   `temperature`. `copy_video_grade` when shots from one camera setup need the same correction;
   `apply_video_grade_preset` for a common starting point.
   **Check:** the clip `grade` values; scopes or `get_video_frame` at both sides of each cut.
4. **The look over everything.** `add_video_track` at the top (`at: 0`) and
   `add_video_adjustment_clip` on it from 0 for the whole duration with the look's `grade`
   (`scope: "underneath"`).
   **Check:** one adjustment clip covering the timeline; media clips keep their corrections.
5. **LUTs.** `set_video_lut` with `strength` 0.3-0.7 for a look (1 only for a technical
   conversion LUT) and skin protection (`preserve_skin_tones: 0.7`, 0.5-0.8) when people are on screen;
   `set_video_skin_protection` to change the protection later.
   **Check:** each clip's `grade.lut` has the strength and protection you meant.
6. **Spot changes.** `set_video_clip_mask` on a duplicate clip or an adjustment clip for a sky,
   a face or a vignette.
7. **Review.** `render_video_frame` with `times` across the piece for a contact sheet; fix any
   shot that stands out.

## Decision table

| Problem | Fix |
| --- | --- |
| Shot too dark or bright | `grade.exposure` in stops (+1 doubles the light) |
| Flat, low contrast | `grade.contrast` +0.1-0.3 |
| Blue or orange cast | `grade.temperature` against it |
| Green or magenta cast | `grade.tint` against it |
| Same correction on many shots from one setup | `copy_video_grade` |
| One look for the whole piece | Adjustment clip on a top track |
| A LUT look | `set_video_lut`, strength 0.3-0.7 |
| Faces off under the look | Skin protection 0.5-0.8 (`set_video_lut` or `set_video_skin_protection`), or lower the strength |
| Change only part of the frame | `set_video_clip_mask` |

## Recipes

**Match an underexposed shot.** `update_video_clip` `{ clip, set: { grade: { exposure: 1 } } }`
for one stop under; check with scopes or frames on both sides of the cut.

**Warm, slightly desaturated look.** `add_video_track` `{ kind: "video", at: 0 }` →
`add_video_adjustment_clip` `{ track, start: 0, duration: <project duration>, grade:
{ temperature: 0.2, saturation: -0.15 } }`.

**Tame a LUT.** `set_video_lut` `{ clips, src, strength: 0.6, preserve_skin_tones: 0.7 }`.

## Pitfalls

- **Grading before correcting.** A look over unmatched shots makes the mismatch stronger.
- **Partial grade objects.** `set.grade` replaces the whole grade; read it first and include
  the settings you keep.
- **The look on every clip.** Pasting it per clip means every change is many edits; use an
  adjustment clip.
- **Full-strength creative LUTs** turn faces orange or green and crush detail.
- **ffmpeg and skin protection.** The export's `lut3d` cannot protect skin; the export notes
  it, and the preview differs from the file. Lower the strength when that matters.
- **Judging on one frame.** Check several frames per shot; light changes within shots.

## Tools used

- `get_video_project`, `get_video_scopes`, `get_video_frame`, `render_video_frame`: read grades, measure and look
- `update_video_clip`: each shot's correction (`set.grade`)
- `copy_video_grade`, `apply_video_grade_preset`: match and start from a preset
- `add_video_track`, `add_video_adjustment_clip`: one look over the timeline
- `set_video_lut`, `remove_video_lut`, `set_video_skin_protection`: LUT looks and skin
- `set_video_clip_mask`, `remove_video_clip_mask`: spot changes
- `undo_video`: take back a step
