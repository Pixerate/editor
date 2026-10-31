---
name: pixerate-video-montage
description: The montage workflow in the Pixerate video editor - choosing selects and their best moments, assembling them on beats or a rhythm, varying shot length for pacing, cutting on action, short transitions where they help, music under the whole sequence, and a clean start and end. Use when asked to make a montage, a highlight reel, a sizzle reel, a recap, a music video edit, a slideshow of clips or photos, or to cut a set of clips to music or a rhythm, or when edit_video, add_video_marker, set_video_transition or find_video_gaps are available. Load with pixerate-video-editor, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-video-editor
---

# Cutting a montage

A montage tells its story through rhythm: the best moment of each shot, in an order that
builds, cut to a beat. The work is choosing (selects and their best seconds), then placing
(on the beat, with shot lengths that breathe and quicken), then finishing (transitions only
where they help, music under everything, a clear ending).

This skill is the method. `pixerate-video-editor` has the full tool reference; for beats in a
music track and cutting to them, see `pixerate-bgm-alignment`.

## Goal and quality bar

- Each shot is its best moment: taken from the middle of the action, not its first frames
  (`in` past the camera's settle).
- Cuts land on beats or on action, on frame boundaries, with no gaps (`find_video_gaps` empty).
- Pacing varies: longer shots to establish, shorter to build, a held shot to land.
- Straight cuts by default; short crossfades (300-600 ms) or dips only for a reason (time
  passing, a change of section), each with enough media on both sides (no handle errors).
- Music runs under the whole sequence and ends with it (a fade out or a musical ending), and
  the picture ends cleanly (a fade to black or a held final frame).

## Inputs to confirm

- **Selects and order:** which clips, in what order (story, chronology, energy).
- **Rhythm:** music with beats, markers, or a shot length (e.g. 1 s per shot).
- **Length** of the finished piece.

## Working method

1. **Read.** `get_video_project`: assets (with durations), markers (beats), music.
   With music, `find_video_beats` (`pixerate-bgm-alignment`) marks the beats.
   **Check:** you have a beat grid or a shot length, and each select's usable range.
2. **Pick the moments.** For each select, the `in` point of its best stretch (skip the first
   second or two, where the camera settles).
3. **Assemble in one batch.** `edit_video` with one add-clip op per shot (`asset`, `id`, `in`,
   `start` on a beat, `duration` to the next beat), `dry_run: true` first.
   **Check:** the clips are in order, each `start` on a beat; `find_video_gaps` is empty.
4. **Refine the rhythm.** `roll_video_edit` to move a cut to a beat or onto action without
   shifting anything else; `slip_video_clip` to change what a shot shows without moving it.
   Vary lengths: build up with shorter shots before the peak.
5. **Transitions, sparingly.** `set_video_transition` `crossfade` 300-600 ms (or `dip` for a
   section change); every type but dip needs half its length in media past the cut on both sides.
   **Check:** `check_video_project` has no errors.
6. **Music and ending.** The music clip on an audio track from 0 for the whole duration, with a
   `fadeOut` of 1-3 s (or cut on its last beat); the last picture clip `fadeOut` 300-1000 ms to
   black.
   **Check:** `get_video_project` shows both, ending together.
7. **Review.** `render_video_frame` with `times` at each cut for a contact sheet; watch the
   rhythm in the preview where available.

## Decision table

| Want | Approach |
| --- | --- |
| Energy, a build | Shorter shots toward the peak, cuts on every beat |
| Calm, reflective | Longer shots, cuts every 2-4 beats, crossfades |
| Time passing | Crossfade or dip between shots |
| A section change | Dip to black or a held shot, then a new rhythm |
| Continuity of motion | Cut on action (`roll_video_edit` onto the movement) |
| Photos in a slideshow | Image assets, a slow push-in (`set_video_keyframes` scale 1 to 1.08) |

## Recipes

**On the beat.** Beats every `b` ms from 0: `edit_video` with `{ op: "add_clip", track: "v1", clip:
{ type: "media", asset, id, in, start: k * b, duration: b } }` for each shot `k`; then `find_video_gaps`.

**Crossfades.** `edit_video` with `{ op: "set_transition", clip, transition: { type: "crossfade",
duration: 400 } }` for every clip after the first; then `check_video_project`.

**Music and fade-out.** `add_video_clip` on the audio track `{ type: "media", asset: music,
start: 0, duration: <sequence>, fadeOut: 2000 }`; `update_video_clip` on the last shot
`{ set: { fadeOut: 500 } }`.

## Pitfalls

- **First frames of a clip** are often the camera settling; take `in` later.
- **Transitions everywhere** soften the rhythm and look dated; cut straight by default.
- **Missing handles.** A transition needs media past the cut on both sides; trimmed-to-the-edge
  clips fail `check_video_project`.
- **Music that stops dead** at the end of the picture; fade it or end on a musical phrase.
- **Uniform shot lengths** for a long montage feel mechanical; vary them.

## Tools used

- `get_video_project`, `find_video_gaps`, `check_video_project`, `render_video_frame`: read and check
- `add_video_marker`: beats and sections
- `edit_video`, `add_video_clip`: assemble in one batch
- `roll_video_edit`, `slip_video_clip`, `trim_video_clip`, `close_video_gaps`: refine the rhythm
- `set_video_transition`: crossfades and dips
- `update_video_clip`, `set_video_keyframes`: fades, volume and push-ins
- `undo_video`: take back a step
