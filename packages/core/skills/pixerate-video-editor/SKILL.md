---
name: pixerate-video-editor
description: How to edit video projects in the Pixerate non-linear video editor through its agent tools - adding video, audio and image assets, building a rough cut on video and audio tracks, inserting, overwriting, moving, trimming, splitting and ripple-deleting clips, slip, slide and roll edits, lift and extract of a time range, razor cuts across tracks, sync-locked tracks, keyframed opacity, volume and transform, closing gaps, titles and colour clips, fades, volume and speed, crossfade, dip and wipe transitions with handles, J and L cuts, markers, checking the project, rendering frames and contact sheets, and exporting an ffmpeg command or a CMX 3600 EDL. Use when video tools such as get_video_project, add_video_clip or edit_video are available, or when asked to cut, trim, assemble, sequence or export footage on a timeline.
---

# Pixerate video editor

A project is plain JSON: frame size, `fps`, a background, **assets** (video, audio or image
files with a `src` and, for video and audio, a `duration`), **tracks** listed top to bottom
(video tracks hold media, titles and colour clips; audio tracks hold sound; an earlier video
track draws over a later one), and **markers**. A clip has a `start` and `duration` on the
timeline; a media clip also has an `in` point into its asset, `speed`, `volume`, `muted`;
every clip can have `fadeIn`, `fadeOut`, `opacity`, `fit` and `transform`, and a
`transition` from the clip that ends where it starts on the same track.

All times are milliseconds on the timeline (or into the source for `in`). Ids: tracks look
like `v1` / `a1`, clips like `c1`, markers `m1`; you may set your own ids when adding. Read
them from `get_video_project`; never invent them.

For errors, namespaced tool names and undo conventions, see `pixerate-agent-tools`.

## Working method

1. **Read.** `get_video_project` for settings, assets, tracks, clips (with end and source
   range), markers and issues. Set frame size and `fps` first with `set_video_settings` if
   the project is new; changing them later shifts frame-based limits.
2. **Bring in media.** `add_video_asset` for each file with `kind`, `src` and the source
   `duration` (without it trims cannot be checked and `check_video_project` warns
   `unknown-duration`). Give `poster` for video so rendered frames show a picture.
3. **Mark structure.** `add_video_marker` at beats, sections or review notes; clip edges snap to
   markers in the UI and markers make `seek_video` targets.
4. **Assemble in one batch.** Use `edit_video` for a rough cut: `add_asset`, `add_track`, then
   `add_clip` ops in order, with explicit clip ids so later ops (trim, transition) can name
   them. Run it with `dry_run: true` first; the error names the failing op.
5. **Refine** with the single tools: `trim_video_clip`, `split_video_clip`, `move_video_clip`,
   `update_video_clip`, `set_video_transition`, `delete_video_clips` / `close_video_gaps`; for
   timing between shots use the trim modes an editor would: `roll_video_edit` (move a cut),
   `slip_video_clip` (change what a shot shows), `slide_video_clip` (move a shot between its
   neighbours); for a whole stretch, `split_video_at`, `lift_video_range` or
   `extract_video_range`. Animate opacity, volume or position with `set_video_keyframes`.
6. **Check.** `check_video_project` and fix every error and warning; `find_video_gaps` for
   unintended black or silence.
7. **Look and listen.** `get_video_frame` at cuts and transitions for layers and audio gains as
   numbers; `render_video_frame` with `times` for a contact sheet of the sequence. Render
   after a batch, not after every edit.
8. **Export** when asked: `export_video_ffmpeg` (a command to run, not a render) or
   `export_video_edl` (one track) for finishing elsewhere. Read the returned notes.

## Best practices

- **Cut on action.** Place a cut during a movement (a turn, a door opening) so continuity of
  motion hides it; `split_video_clip` at the action, then trim the outgoing and incoming
  sides.
- **Avoid jump cuts.** Two consecutive shots of the same subject from nearly the same framing
  read as a glitch. Change angle or size, cover the cut with B-roll on a higher video track,
  or make it deliberate.
- **J and L cuts.** Let sound lead or trail the picture: put the media's sound on an audio
  track (a clip of the same video asset), mute the video clip (`muted: true`), and then
  `roll_video_edit` the audio cut earlier (J) or later (L) than the picture cut. This smooths
  dialogue and scene changes.
- **Transitions sparingly.** A straight cut is the default. Use `crossfade` for passage of time
  or a soft scene change, `dip` (to black, or a `color`) for a section break, `wipe` rarely.
  Keep them short (300-1000 ms). Crossfades and wipes need handles: half the duration of
  unused media past the cut on both clips; `dip` needs none.
- **Insert vs overwrite.** `add_video_clip` and `move_video_clip` take `mode`: `refuse`
  (default; the error names the next free place), `overwrite` (replace what is underneath, like
  an overwrite edit) or `insert` (push later material along). Use `ripple: true` on trim and
  delete, and `extract_video_range` rather than `lift_video_range`, to keep everything after
  the edit in sync with no gap. Ripple and insert move every unlocked sync-locked track, so
  dialogue and its picture stay together; turn `syncLocked` off with `update_video_track` for a
  music bed that should stay put.
- **Trim with the right tool.** To change *when* a cut happens without moving anything else,
  `roll_video_edit`; to change *which* moment a shot shows, `slip_video_clip`; to move a shot
  earlier or later between two others, `slide_video_clip`. All three keep the timeline
  gapless and report the delta they actually applied (clamped to available media).
- **Keyframes sparingly.** Use `set_video_keyframes` for a push-in (`scale` 1 to 1.1 over the
  shot), a duck under dialogue (`volume`), or a fade that is not at an edge; ease (`ease-in-out`)
  rather than linear for motion. Simple fades at the clip edges are `fadeIn` / `fadeOut`.
- **Close gaps.** Unintended gaps play as background colour and silence. `find_video_gaps`, then
  `close_video_gaps` or ripple deletes. Leave gaps only where you want black.
- **Cut on frames.** Put starts, trims and splits on frame boundaries (multiples of 1000 / fps
  ms; 41.667 at 24 fps, 33.333 at 30). Edits do not round for you.
- **Audio levels.** Dialogue is the reference; keep music under it (volume around 0.2-0.4 under
  speech, more between lines) and avoid gains above 1 that clip. Per-clip `volume` and track
  `volume` multiply. Give every audio clip that starts or ends mid-sound a short `fadeIn` /
  `fadeOut` (10-50 ms) to avoid clicks; fade music beds over 1-3 s.
- **Titles.** Keep text inside the title-safe area (about 90% of the frame), hold it at least as
  long as it takes to read twice, and use `background` for contrast over busy footage.
- **Pacing.** Vary shot length with content; trim heads and tails of every clip to the
  essential action rather than using whole source files.
- **Check before export.** Always run `check_video_project` and fix errors first: the ffmpeg
  command renders exactly what is on the timeline.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_video_project` | Start here. Returns frame size, fps, length (ms), assets (id, kind, src, duration), tracks top to bottom with each clip in time order (id, type, start, duration, end, source in/out, fades, transition), markers, playhead, selection, issues and whether it can be edited. |
| `get_video_frame` | Inspect a `time` (ms) as data: pictures back to front (clip, track, asset, source time, opacity, placement rect, rotation, wipe) and sounds (clip, source time, gain after volumes, fades and transitions). Use to verify a cut, layer order or J/L cut without images. |
| `find_video_gaps` | List empty stretches between clips (and before the first) as `{ track, start, end }` ms, on every track or one `track`. Then `close_video_gaps` or ripple. |
| `check_video_project` | After every batch and before export. Lists issues errors first with a code (`missing-asset`, `wrong-track`, `overlap`, `source-overrun`, `transition-without-cut`, `transition-too-long`, `transition-handles`, `fades-too-long`, `unknown-duration`, `unused-asset`, `marker-past-end`, `empty`), what it is about and how to fix it. |
| `render_video_frame` | Look at the picture at `time`, or at 2-16 `times` as one labelled contact sheet (`columns` 1-8). SVG by default; `format: "png"` only when the host can rasterize. Video without a `poster` shows as a labelled box with its source timecode. |
| `export_video_ffmpeg` | Get the ffmpeg command that renders the project: `args` (for spawn), `command` (one shell line), `filterComplex`, duration and notes on approximations. `output` default output.mp4, `crf` x264 quality 0-51 (default 18, lower is better). Fails when there are no clips. |
| `export_video_edl` | Get one `track` (default the bottom video track) as a CMX 3600 EDL with source and record timecode, dissolves, speed changes and clip names, for conforming in another editor. `title` defaults to the project name. |

### Write

| Tool | Use it to |
| --- | --- |
| `seek_video` | Show the person a moment: `time`, a `clip`'s start or a `marker`, with `play` true or false. Does not change the project. Returns the playhead and clips under it. |
| `set_video_settings` | Set `name`, `width` / `height` (pixels, 16-8192), `fps` (e.g. 24, 25, 30, 60) or `background` colour. One undo step. |
| `add_video_asset` | Register a file: `kind` (video, audio, image), `src` (URL, path or data URL), `duration` ms (required in practice for video and audio), optional `id`, `name`, `width`, `height`, `hasAudio` (default true for video), `poster`. Returns the asset id. |
| `update_video_asset` | Relink or correct an asset via `set` (src, name, duration, size, hasAudio, poster) and `remove`. Refused if clips would then run past its end. |
| `remove_video_asset` | Remove an asset no clip uses; refused while clips use it, naming them. Use to clear `unused-asset` notes. |
| `add_video_track` | Add an empty `video` or `audio` track (optional `id`, `at` position 0 = top, `name`, `muted`, `hidden`, `locked`, `volume`). Video tracks go on top and audio at the bottom by default. |
| `update_video_track` | Rename, mute, hide, lock, sync-lock or set the gain (`volume` 0-4) of a track via `set` / `remove`. Lock tracks you must not disturb; set `syncLocked: false` on a track that ripple and insert edits should leave in place (a music bed). |
| `remove_video_track` | Delete a track and every clip on it (refused when locked). Returns the clips removed. |
| `move_video_track` | Reorder a track to `to` (0 = top); an earlier video track draws over later ones. |
| `add_video_clip` | Put a clip on a `track`: `media` (`asset`, `in` default 0, `duration` default rest of source; stills 5000), `text` title (`text`, `color`, `fontSize` 64, `fontFamily`, `fontWeight` 700, `background`; default 3000 ms) or `color`. No `start` appends at the end. `mode`: `refuse` (default, names the next free place), `overwrite` (replaces what is underneath) or `insert` (pushes later material along on every sync-locked track). Returns the clip plus any clips it cut, trimmed or removed. |
| `move_video_clip` | Move a `clip` to a new `start` and/or another track of the same kind, leaving a gap where it was. `mode` as for `add_video_clip` (default `refuse`). To move a shot between its neighbours without a gap, use `slide_video_clip` instead. |
| `trim_video_clip` | Move one `edge` (`start` also moves the in point, `end` the out point) `to` a timeline time. Refused past the source ends (the error says how far it can go) or below one frame. `ripple: true` keeps the clip's start and shifts later clips by the change. |
| `split_video_clip` | Cut a `clip` in two `at` a timeline time (at least a frame from each end). The left keeps the id, fade in and transition; the right gets `id` (default `<clip>-1`) and the fade out. |
| `slip_video_clip` | Show a different stretch of a media clip's source without moving it: `delta` ms (positive shows later media). Clamped to the media and what transitions need; returns the new source range and the delta applied. |
| `roll_video_edit` | Move the cut between two touching clips (`left`, `right`) by `delta` ms: one gets longer as the other gets shorter, nothing else moves. Use for J / L cuts and tightening a cut. Returns both clips, the new cut time and the delta applied. |
| `slide_video_clip` | Move a `clip` by `delta` ms keeping its content, trimming its neighbours so no gap opens (or moving through a gap where it has no neighbour). Returns the clip, its neighbours and the delta applied. |
| `split_video_at` | Razor: cut every clip running across time `at` on all unlocked tracks or the given `tracks`, as one undo step. Refused when nothing crosses that time. Returns the `{ left, right }` pairs (right parts get new ids). |
| `lift_video_range` | Empty `from`..`to` ms on all unlocked tracks or the given `tracks`, leaving a gap: clips inside are deleted, clips across an edge trimmed, a clip across both cut in two. Returns what was removed, trimmed and created. |
| `extract_video_range` | Remove `from`..`to` ms and close it up: as lift, then later material moves earlier on those and every sync-locked track. Refused (naming the clip) when a sync-locked track outside `tracks` has material there. Use to cut a section out of a finished sequence. |
| `delete_video_clips` | Remove `clips`; `ripple: true` pulls later clips up to close the gaps (a ripple delete). |
| `update_video_clip` | Change properties via `set`: opacity, transform (`x`, `y` px from centre, `scale`, `rotation`), `fit` (contain default for media, cover, fill, none), `fadeIn` / `fadeOut`, name; media `volume` (0-4), `muted`, `speed` (0.05-20, keeps the source range so the length changes), `asset`; title text and style; colour. `remove` resets to defaults. Not for timing. |
| `set_video_keyframes` | Animate one `property` of a `clip` (`opacity` 0-1, `volume` 0-4 for media, `x` / `y` px from centre, `scale`, `rotation` degrees) with `keys` `[{ t, v, ease? }]`, replacing its keys. `t` is clip time (ms from the clip's start), so keys travel with the clip. `ease`: linear (default), hold, ease-in, ease-out, ease-in-out or cubic-bezier points. Returns the sorted keys. |
| `remove_video_keyframes` | Remove all keys of a clip `property`, leaving the value it had at the clip's start. |
| `set_video_transition` | Set the transition into a `clip` from the clip ending where it starts on the same track: `{ type: crossfade, dip or wipe, duration ms centred on the cut, color (dip, default black), direction (wipe, default right) }`, or `null` to remove. When handles are short the error gives the longest that fits. |
| `close_video_gaps` | Slide clips on a `track` earlier so no gaps remain, from time `from` (default the start). Returns the clips that moved. |
| `add_video_marker` | Add a marker at `time` with `label`, `color` and optional `id`, for beats, sections or review notes. Returns its id. |
| `remove_video_marker` | Remove a `marker` by id. |
| `edit_video` | Apply up to 200 ops in order as one all-or-nothing undo step: `set_settings`, `add_asset { asset }`, `update_asset`, `remove_asset`, `add_track { track: { kind, id }, at }`, `update_track`, `remove_track`, `move_track`, `add_clip { track, clip, mode }`, `move_clip { clip, start, track, mode }`, `trim_clip`, `split_clip`, `delete_clips`, `update_clip`, `set_transition`, `slip_clip`, `roll_edit`, `slide_clip`, `lift_range`, `extract_range`, `split_at`, `set_keyframes { clip, property, keys }` (null keys remove), `close_gaps`, `add_marker { marker: { time, label } }`, `update_marker`, `remove_marker`; other fields match the single tools. `dry_run: true` validates only. The default for a rough cut. |
| `undo_video` | Undo your last edit (one tool call or one `edit_video` batch). |
| `redo_video` | Redo the edit you just undid. |

## Pitfalls

- **Edits never add errors.** Any edit that would create an overlap, a source overrun or an
  impossible transition is refused whole (unless you asked for `mode: "overwrite"` or
  `"insert"`); read the message (it names the next free place or the longest trim /
  transition that fits) and retry with those numbers.
- **Numbers replace keyframes.** Setting `opacity` or `volume` as a plain
  number (in `add_video_clip` or `update_video_clip`) drops that property's keys; animate with
  `set_video_keyframes` after the static settings, not before.
- **Slip, slide and roll clamp.** They move as far as the media allows and say how far in
  `delta`; check it instead of assuming the full amount was applied.
- **`edit_video` has no result references.** Unlike `edit_animation`, ops cannot say `$0.id`;
  set clip, track and marker ids yourself when later ops in the batch need them.
- **`edit_video` op shapes differ slightly** from the single tools: `add_asset` wraps the asset
  as `{ asset: { id, kind, src, ... } }`, `add_track` as `{ track: { kind, ... } }` and
  `add_marker` as `{ marker: { time, label } }`.
- **Same kind of track.** A clip moves only between tracks of its kind; images, titles and colours
  never go on audio tracks, audio files never on video tracks (`wrong-track`).
- **Speed changes length.** Setting `speed` keeps the source stretch, so the clip gets shorter or
  longer and can collide with the next one; ripple or move clips after.
- **Transitions need a butt cut.** The incoming clip must start exactly where the previous one ends
  on the same track (`transition-without-cut`); close the gap first. Splitting keeps the
  transition on the left part.
- **Fades are per clip.** `fadeIn + fadeOut` longer than the clip warns `fades-too-long`; fades
  affect picture and sound together.
- **Locked tracks** refuse edits to their clips; unlock with `update_video_track` only if the user
  wants that track changed.
- **Read-only**: when `get_video_project` says the project cannot be edited, write tools are
  hidden; read, render and export still work. Tell the user rather than working around it.
- **Exports are commands, not files.** `export_video_ffmpeg` returns a command for the host to
  run; the EDL covers one track only. Report the notes on anything approximated.
