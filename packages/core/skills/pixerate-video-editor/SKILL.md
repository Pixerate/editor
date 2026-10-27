---
name: pixerate-video-editor
description: How to edit video projects in the Pixerate non-linear video editor through its agent tools - adding video, audio and image assets, building a rough cut on video and audio tracks, inserting, overwriting, moving, trimming, splitting and ripple-deleting clips, slip, slide and roll edits, lift and extract of a time range, razor cuts across tracks, sync-locked tracks, keyframed opacity, volume and transform, closing gaps, titles and colour clips, fades, volume and speed, crossfade, dip and wipe transitions with handles, J and L cuts, markers, checking the project, provider effects (clip effects, effect clips, effect transitions), rendering frames and contact sheets, and exporting an ffmpeg command or a CMX 3600 EDL. Use when video tools such as get_video_project, add_video_clip or edit_video are available, or when asked to cut, trim, assemble, sequence or export footage on a timeline.
---

# Pixerate video editor

A project is plain JSON: frame size, `fps`, a background, **assets** (video, audio or image
files with a `src` and, for video and audio, a `duration`), **tracks** listed top to bottom
(video tracks hold media, titles and colour clips; audio tracks hold sound; an earlier video
track draws over a later one), and **markers**. A clip has a `start` and `duration` on the
timeline; a media clip also has an `in` point into its asset, `speed`, `volume`, `muted`;
every clip can have `fadeIn`, `fadeOut`, `opacity`, `fit` and `transform`, and a
`transition` from the clip that ends where it starts on the same track.

A project may also hold nested **sequences** (`{ id, name, tracks }`, their own timeline from 0).
A **compound clip** (`type: "sequence"`, `sequence`, `in`) plays a stretch of one as a single
picture and a single sound: its opacity, transform, blend, grade, LUT, fades, transitions and
animations apply to the sequence's composite, and its `volume`, `muted` and fades to the
sequence's mix. Compound clips play at normal speed (no `speed` or ramp), and the clips inside a
sequence can be read (`list_video_sequences`) but not edited yet.

All times are milliseconds on the timeline (or into the source for `in`). Ids: tracks look
like `v1` / `a1`, clips like `c1`, markers `m1`; you may set your own ids when adding. Read
them from `get_video_project`; never invent them.

For errors, namespaced tool names and undo conventions, see `pixerate-agent-tools`.

## Working method

1. **Read.** `get_video_project` for settings, assets, tracks, clips (with end and source
   range), a summary of each nested sequence, markers and issues. When there are compound
   clips, `list_video_sequences` shows what they contain. Set frame size and `fps` first with `set_video_settings` if
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
6. **Cut by text** when the media has speech: `set_video_transcript` for each spoken asset (or
   check `transcriptWords` in `get_video_project`), `get_video_transcript` to read the edit, then
   `find_video_fillers`, `find_video_pauses` or `find_video_transcript_text` and pass the ranges
   you want gone to `remove_video_ranges` in one call. Re-read the transcript afterwards: every
   time after a cut has moved.
7. **Check.** `check_video_project` and fix every error and warning; `find_video_gaps` for
   unintended black or silence.
8. **Look and listen.** `get_video_frame` at cuts and transitions for layers and audio gains as
   numbers; `render_video_frame` with `times` for a contact sheet of the sequence. Render
   after a batch, not after every edit.
9. **Export** when asked: `export_video_ffmpeg` (a command to run, not a render) or
   `export_video_edl` (one track) for finishing elsewhere. Read the returned notes. For a
   delivery loudness, have the host run `export_video_loudness_measure` first and pass what it
   prints as `loudness.measured`; one pass (`loudness` without `measured`) is fine for a draft.
10. **Effects** (only when the host registered an effects provider; `search_effects` says
    `available: false` otherwise): `search_effects` with a `use`, then `describe_effect` for its
    controls, then `apply_effect` (filters and overlays on a clip), `set_video_effect_transition`
    or `add_video_effect_clip` (generators and titles). Tune with `update_effect` and
    `set_video_effect_keyframes`; check with `get_video_frame` (layers list `effects`) and
    `list_applied_effects`.

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
  Keep them short (300-1000 ms). `push` and `slide` suit graphics, montages and social edits
  more than drama; `iris` is a stylised period or comic effect. Every type but `dip` needs
  handles: half the duration of unused media past the cut on both clips; `dip` needs none.
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
- **Tighten dialogue by text first.** With a transcript, remove fillers and pauses with the find
  tools and one `remove_video_ranges`; review the fillers list first (a "you know" can be
  meant). Keep 150-300 ms around words (`keep`) so speech breathes. Without a transcript, use the
  sound itself, below.
- **Tighten dialogue by ear, in numbers.** `find_video_silences` on an interview or voiceover clip
  lists the pauses in timeline time; extract the long ones (keep 150-300 ms either side so speech
  does not sound clipped: shrink each range before `extract_video_range`, and extract from the
  last pause back to the first, or re-read, because each extract moves what follows). Use
  `get_video_audio_levels` to find where a line starts before trimming or splitting at it.
- **Speed ramps for emphasis.** Ramp into slow motion just before the moment that matters (a
  jump, a reveal) and back out after it: `set_video_speed_ramp` with a 300-600 ms glide (`toSpeed`)
  rather than a hard change, and slow motion around 0.25-0.5. A freeze frame (1-2 s) suits a
  title or a "that's me" moment; add it with `add_video_freeze_frame`. Ramped sound is stepped
  and silent in freezes, so lay music or effects under ramped shots instead of their own sound.
- **Close gaps.** Unintended gaps play as background colour and silence. `find_video_gaps`, then
  `close_video_gaps` or ripple deletes. Leave gaps only where you want black.
- **Cut on frames.** Put starts, trims and splits on frame boundaries (multiples of 1000 / fps
  ms; 41.667 at 24 fps, 33.333 at 30). Edits do not round for you.
- **Audio levels.** Dialogue is the reference; keep music under it (volume around 0.2-0.4 under
  speech, more between lines) and avoid gains above 1 that clip. Per-clip `volume` and track
  `volume` multiply. Give every audio clip that starts or ends mid-sound a short `fadeIn` /
  `fadeOut` (10-50 ms) to avoid clicks; fade music beds over 1-3 s. Shape sound fades with
  `fadeInCurve` / `fadeOutCurve`: `equal-power` where two sounds overlap (it keeps loudness
  steady, where linear dips in the middle; transitions' `audioCurve` already defaults to it for
  crossfades and wipes), `exponential` to fade music out to silence
  naturally, `s-curve` for a gentle start and finish. Linear is the default.
- **Delivery loudness.** Normalise the final mix rather than pushing clip volumes: -14 LUFS for
  web and streaming, -16 for podcasts, -23 (EBU R128) or -24 (ATSC) for broadcast, with true
  peaks at or under -1 dBTP. Two passes keep the dynamics; one pass rides the level.
- **Grade in two passes: correct, then look.** First balance each shot so a scene matches
  (`update_video_clip` `grade`: fix exposure and white balance against the best shot, then
  `copy_video_grade` from it to the rest of the scene), then add a look with
  `apply_video_grade_preset` at a modest `amount` (0.3-0.6), or a `.cube` look the user has with
  `set_video_lut` (often at `strength` 0.5-0.8: film emulation and creative LUTs are strong at
  full strength). A LUT runs after the grade's settings, so correct exposure and white balance
  first; LUTs built for log footage expect a flat picture and look crushed on normal video. Check with `render_video_frame` at a
  few times side by side. Skin tones are the reference: avoid strong `hue` or `tint` on people.
- **Measure, don't eyeball.** Where the host shows a preview, `get_video_scopes` reads the real
  picture: keep `clipped.highlights` under about 1% and `clipped.shadows` under about 2% unless
  the look calls for it, and aim for a mean luma of roughly 0.35-0.55 for ordinary scenes. A
  balanced shot's `average` colour is close to grey, so a strong tint there is a cast to fix
  with `temperature` and `tint`. Measure before and after each grade, and compare shots in a
  scene by their `stats` rather than by eye. The figures are of the rendered frame, after
  grades, blends and titles.
- **Blend overlays, don't key them.** Light leaks, flares, film burns and glows shot on black go on
  a higher video track with `blend: "screen"` (or `add` for a hotter look), so the black drops
  out; textures, paper and dust on white use `multiply`. Lower the clip's `opacity` to taste.
  A blend affects everything beneath the clip on lower tracks.
- **Titles.** Bring titles in and out with `animateIn` / `animateOut` rather than hand-made
  keyframes: `rise` or `fade` for lower thirds, `pop` for a playful callout, `zoom` for a slow
  reveal; 300-600 ms in, a little quicker out. Keep text inside the title-safe area (about 90% of the frame), hold it at least as
  long as it takes to read twice, and use `background` for contrast over busy footage.
- **Pacing.** Vary shot length with content; trim heads and tails of every clip to the
  essential action rather than using whole source files.
- **Proxies for heavy footage.** When the preview stutters on 4K or long-GOP camera files, run
  `plan_video_proxies` (half size; quarter for 6K and up), ask the host to run the commands,
  attach each result with `set_video_proxies`, and leave `set_video_preview_scale` on `auto` (or
  pick a fraction). Proxies change only what the preview plays: the export, the EDL and every
  time you read stay on the originals.
- **Let the cache fill before a review.** With a frame cache, `get_video_preview_cache` shows
  which stretches play without waiting. Before asking the person to watch a passage, seek to its
  start and let the prefetch window fill. Frames are keyed by the source, so trims and moves keep
  them; switching the preview scale or relinking an asset starts afresh.
- **Check before export.** Always run `check_video_project` and fix errors first: the ffmpeg
  command renders exactly what is on the timeline.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_video_project` | Start here. Returns frame size, fps, length (ms), assets (id, kind, src, duration), tracks top to bottom with each clip in time order (id, type, start, duration, end, source in/out, fades, transition), a summary of each nested sequence (`sequences`: id, length, clip count, `nests`, `usedBy`), markers, playhead, selection, issues and whether it can be edited. |
| `list_video_sequences` | Read the nested sequences compound clips play (or one `sequence`): length, the sequences each nests, `usedBy` (the compound clips that play it, with timeline start / end and the stretch of the sequence as `source`), any `cycle`, and its tracks and clips in the `get_video_project` shape. Call it before trimming, slipping or grading a compound clip, to know what it holds. |
| `get_video_frame` | Inspect a `time` (ms) as data: pictures back to front (clip, track, asset, source time, opacity, placement rect, rotation, wipe) and sounds (clip, source time, gain after volumes, fades and transitions). A compound clip is one picture whose `layers` are its sequence's, with `sourceTime` in sequence time; its sounds carry clip paths like `comp/inner`. Use to verify a cut, layer order or J/L cut without images. |
| `get_video_transcript` | Read what the timeline says on one `track` (default: the first audio track with transcribed media): the text, and each word with its timeline `start` / `end` ms and `clip`. `from` / `to` narrow it; `limit` (default 1000) with `more`. Words cut out of the edit are not listed. |
| `find_video_transcript_text` | Find every place a word or phrase (`query`, case and punctuation ignored) is said, as `{ from, to, text }` timeline ranges for `remove_video_ranges`, `split_video_at` or `seek_video`. |
| `find_video_fillers` | Find filler words (um, uh, erm, you know, I mean…; or your own `fillers`) as timeline ranges, longest phrase first, with their `total` ms. Review before cutting. |
| `find_video_pauses` | Find gaps between words longer than `min` (default 700 ms), less `keep` (default 150 ms) next to each word, snapped inward to frames, as timeline ranges with their `total`. |
| `find_video_gaps` | List empty stretches between clips (and before the first) as `{ track, start, end }` ms, on every track or one `track`. Then `close_video_gaps` or ripple. |
| `check_video_project` | After every batch and before export. Lists issues errors first with a code (`missing-asset`, `wrong-track`, `overlap`, `source-overrun`, `transition-without-cut`, `transition-too-long`, `transition-handles`, `fades-too-long`, `unknown-duration`, `unused-asset`, `marker-past-end`, `empty`), what it is about and how to fix it. |
| `render_video_frame` | Look at the picture at `time`, or at 2-16 `times` as one labelled contact sheet (`columns` 1-8). SVG by default; `format: "png"` only when the host can rasterize. Video without a `poster` shows as a labelled box with its source timecode. |
| `get_video_scopes` | Measure the rendered picture at `time` (default the playhead; another time is shown briefly and the playhead put back) as colour scopes do: luma `stats` (0-1 mean, median, min, max, p1, p99), the share `clipped` to black or white (and per channel), saturation, the `average` colour, a `histogram` of `bins` steps (default 16), the luma spread of `columns` strips left to right (`waveform`, default 8), the main `vectorscope` hue (red ≈ 103°, skin ≈ 123°) and `notes` on what to fix. Call it before and after grading. Fails with a reason when the host shows no preview (then use `render_video_frame`). |
| `get_video_preview_cache` | Read the preview's frame cache when the host has one: frames and bytes against `maxBytes`, hits and misses, frames still decoding (`pending`), the prefetch window (ms), and `cachedRanges` between `from` and `to` (stretches that play and scrub without waiting). Says `enabled: false` without a cache. Changes nothing. |
| `plan_video_proxies` | Get the ffmpeg commands that make proxies (default `scale` 0.5) of video assets lacking one at that scale (or of `assets`): scaled H.264 with a keyframe every `gop` frames (default 12) so scrubbing is quick, sound kept. Each has `{ asset, args, command, proxy }`; attach `proxy` with `set_video_proxies` once the host has run it. Changes nothing. |
| `export_video_ffmpeg` | Get the ffmpeg command that renders the project: `args` (for spawn), `command` (one shell line), `filterComplex`, duration and notes on approximations. `output` default output.mp4, `crf` x264 quality 0-51 (default 18, lower is better). `loudness` normalises the mix (`integrated` LUFS default -14, `truePeak` dBTP default -1, `range`); with `loudness.measured` from `export_video_loudness_measure` it applies one fixed gain. Fails when there are no clips. |
| `export_video_loudness_measure` | First pass of loudness normalisation: the ffmpeg command that mixes only the sound and prints its loudness as JSON at the end of stderr. Takes the same target (`integrated` LUFS, `truePeak`, `range`) as the export. Map `input_i`, `input_tp`, `input_lra`, `input_thresh`, `target_offset` to `loudness.measured` for `export_video_ffmpeg`. |
| `export_video_edl` | Get one `track` (default the bottom video track) as a CMX 3600 EDL with source and record timecode, dissolves, speed changes and clip names, for conforming in another editor. `title` defaults to the project name. At 29.97 and 59.94 fps it writes drop-frame timecode (`HH:MM:SS;FF`, `FCM: DROP FRAME`), as other editors expect; `dropFrame: false` forces non-drop. |

### Write

| Tool | Use it to |
| --- | --- |
| `get_video_audio_levels` | Measure a media `clip`'s source sound (timeline times) or an `asset`'s (source times) between `from` and `to`: peak dBFS in each of `buckets` (default 50, up to 500) equal stretches, and the loudest peak. Levels are the recording before clip volume and fades. Use it to find where speech or a beat starts or to judge loudness. The first call for an asset decodes its file. |
| `find_video_silences` | List stretches of a `clip` or `asset` that stay below `thresholdDb` (default -40) for at least `minDuration` ms (default 300). For a clip the `{ start, end }` are timeline times that go straight into `extract_video_range` (cut a pause, closing up) or `split_video_at`. |
| `set_video_preview_scale` | Set what the preview plays (no undo step, allowed while read-only): `"full"` originals, a fraction (0.5, 0.25) for the smallest proxy at least that large, or `"auto"` (default, by the preview's shown size). Returns what each video asset plays at a fixed scale. |
| `set_video_proxies` | Set a video `asset`'s `proxies` (`[{ scale, src, width?, height? }]`, one per scale; empty removes them) in one undo step. A proxy must match the original's length and timing; exports always use the original. |
| `seek_video` | Show the person a moment: `time`, a `clip`'s start or a `marker`, with `play` true or false. Does not change the project. Returns the playhead and clips under it. |
| `set_video_transcript` | Attach what is said in a video or audio `asset`: `text` (a Whisper JSON, .srt or .vtt file's contents) or `words` (`[{ word, start, end }]` ms of the source). Captions give approximate word timings. Returns the word count and first and last words. Clear it with `update_video_asset` `remove: ["transcript"]`. |
| `remove_video_ranges` | Cut `ranges` (`[{ from, to }]` timeline ms, as the find tools return them) out and close them up on every sync-locked track, as one undo step: merged where they touch, extracted last first. Returns how many stretches and how much time went, and the new length. |
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
| `update_video_clip` | Change properties via `set`: opacity, transform (`x`, `y` px from centre, `scale`, `rotation`), `fit` (contain default for media, cover, fill, none), `animateIn` / `animateOut` (`{ effect: fade, rise, drop, slide-left, slide-right, zoom or pop, duration ms default 500 }`), `grade` (`exposure` stops -3-3, `contrast`, `saturation`, `temperature`, `tint` -1-1, `hue` degrees; replaces the whole grade), `blend` (normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, add), `fadeIn` / `fadeOut`, name; media `volume` (0-4), `muted`, `fadeInCurve` / `fadeOutCurve` (the sound's fade shape: linear, equal-power, s-curve, exponential, logarithmic), `speed` (0.05-20, keeps the source range so the length changes), `asset`; title text and style; colour. `remove` resets to defaults. Not for timing. |
| `set_video_lut` | Give `clips` (on video tracks) a 3D LUT: `src` a `.cube` file the host can load and ffmpeg can read, `strength` 0-1 (default 1). Reads the file first and fails without changing anything if it cannot be loaded or is not a 3D `.cube`. Keeps the clips' other grade settings; the LUT runs after them. One undo step; returns the LUT's `title` and `size` and each clip's grade. Copies with `copy_video_grade`. |
| `remove_video_lut` | Take the LUT off `clips`' grades, keeping their other settings (one undo step). Fails if none has one. |
| `apply_video_grade_preset` | Give `clips` (on video tracks) a named look at an `amount` 0-1 (default 1), replacing their grade settings (a LUT stays): warm, cool, punchy, faded, black-and-white, bleach-bypass, day-for-night. One undo step; returns each clip's grade to fine-tune with `update_video_clip`. |
| `copy_video_grade` | Match shots: give the `to` clips the grade of the `from` clip (one undo step; a source with no grade clears theirs). Returns the grade copied. |
| `set_video_speed_ramp` | Play a video or audio `clip` through `segments` of speed from its first frame: `[{ duration ms, speed, toSpeed? }]`; `toSpeed` glides evenly to a new speed over the stretch, speed 0 is a freeze. The clip's length becomes the segments' total; `ripple` (default true) moves later material. Returns the clip with its `timeRemap` and source range. |
| `add_video_freeze_frame` | Hold the frame a clip shows at timeline time `at` for `duration` ms, then play on; the clip gets longer and (with `ripple`, default) later material moves along. Works with or without a ramp. |
| `remove_video_speed_ramp` | Put a ramped clip back to normal speed from where its ramp started, keeping its length (or a new `duration`). |
| `set_video_keyframes` | Animate one `property` of a `clip` (`opacity` 0-1, `volume` 0-4 for media, `x` / `y` px from centre, `scale`, `rotation` degrees) with `keys` `[{ t, v, ease? }]`, replacing its keys. `t` is clip time (ms from the clip's start), so keys travel with the clip. `ease`: linear (default), hold, ease-in, ease-out, ease-in-out or cubic-bezier points. Returns the sorted keys. |
| `remove_video_keyframes` | Remove all keys of a clip `property`, leaving the value it had at the clip's start. |
| `set_video_transition` | Set the transition into a `clip` from the clip ending where it starts on the same track: `{ type: crossfade, dip, wipe, push, slide or iris, duration ms centred on the cut, color (dip, default black), direction (wipe, push, slide; default right), audioCurve (the sound's fades: equal-power by default for crossfade and wipe, linear for dip) }`, or `null` to remove. When handles are short the error gives the longest that fits. |
| `close_video_gaps` | Slide clips on a `track` earlier so no gaps remain, from time `from` (default the start). Returns the clips that moved. |
| `add_video_marker` | Add a marker at `time` with `label`, `color` and optional `id`, for beats, sections or review notes. Returns its id. |
| `remove_video_marker` | Remove a `marker` by id. |
| `edit_video` | Apply up to 200 ops in order as one all-or-nothing undo step: `set_settings`, `add_asset { asset }`, `update_asset`, `remove_asset`, `add_track { track: { kind, id }, at }`, `update_track`, `remove_track`, `move_track`, `add_clip { track, clip, mode }`, `move_clip { clip, start, track, mode }`, `trim_clip`, `split_clip`, `delete_clips`, `update_clip`, `set_transition`, `slip_clip`, `roll_edit`, `slide_clip`, `lift_range`, `extract_range`, `split_at`, `set_keyframes { clip, property, keys }` (null keys remove), `set_time_remap { clip, keys (clip ms to source ms after the in point; null removes), duration, ripple }`, `close_gaps`, `add_marker { marker: { time, label } }`, `update_marker`, `remove_marker`; other fields match the single tools. `dry_run: true` validates only. The default for a rough cut. |
| `undo_video` | Undo your last edit (one tool call or one `edit_video` batch). |
| `redo_video` | Redo the edit you just undid. |

### Effects

These tools come from `createVideoEffectsToolProvider` and work when the host registered an
effects provider (for example Flair). Without one, `search_effects` and `describe_effect` return
`available: false` with the reason, `list_applied_effects` still lists what the project holds,
and every write tool is refused with the reason.

| Tool | Use it to |
| --- | --- |
| `search_effects` | Find effects: words in `query`, filtered by `kind`, `category` or `use` (filter, overlay for clips; transition; generator, title). Returns ids, names, uses, whether they are transparent or loop, and their length. Call `describe_effect` next. |
| `describe_effect` | Read one effect's `controls` (a strict JSON Schema: names, types, ranges, units), `defaults`, `presets` and `inputs`, and whether it `appliesHere` (as a clip effect). Use the names and ranges for values. |
| `list_applied_effects` | See the effects in the project per clip, in order: clip effects (`fx1`...), an effect clip's own effect (`generator`) and an effect transition (`transition`), with their saved values and `available` (false when the provider lacks it: drawn as a placeholder). |
| `apply_effect` | Add a filter or overlay effect to a clip's stack (`target` clip id, `effect`, `values`, `index`, `enabled`, `opacity`). Effects run in order on the clip's picture before its grade and placement. Returns the effect's new id and the clip's effects. |
| `update_effect` | Change an applied effect: `values` merged over its own (null resets a control), `enabled`, `opacity`, `index` (reorder). For `generator` and `transition` only `values`. Returns the effect now. |
| `remove_effect` | Take an effect off a clip (`transition` removes an effect transition; an effect clip is deleted with `delete_video_clips`). Returns what was removed and what is left. |
| `add_video_effect_clip` | Put a generator, title or overlay effect on a video `track` as a clip filling the frame (`start`, `duration` default the effect's own length, `values`, `mode`). Transparent effects show the tracks beneath. Returns the clip id. |
| `set_video_effect_transition` | Use a transition effect from the effects provider into a `clip` from the one ending where it starts (`duration` centred on the cut, `values`). Needs handles like a crossfade. For a cross dissolve, dip, wipe, push, slide or iris use the built-in `set_video_transition` instead. |
| `set_video_effect_keyframes` | Animate one number `control` of a clip effect (or an effect clip's `generator`) with `keys` in clip ms, or `null` to stop animating it. |

### Save and open

The host may add the shared document tools (see `pixerate-agent-tools`). A video document is the `VideoProject` (assets point at their media; the media itself is not copied); the playhead is not part of it.

| Tool | Use |
| --- | --- |
| `get_video_document` | Take a copy of the whole video project as `{ kind, formatVersion, revision, document }` before a risky rewrite, or to hand it on. To read the video project, use `get_video_project`: it is smaller and says more. Refuses very large documents. |
| `load_video_document` | Put back a copy from `get_video_document` (its `document`, or the whole result). Checked first: when anything is wrong nothing changes and the error says what. One undo step (`undo_video` brings the previous project back). Refused while the editor is read-only. To change part of a project use `edit_video` or the per-operation tools. |
| `save_video_document` | Save the video project under a `name` in the host's storage (the same name replaces that copy). Returns the `key`. Only listed when the host has storage. Save when the user asks, not after every edit. |
| `list_saved_video_documents` | List saved video projects (`key`, `name`, `savedAt`), newest first. |
| `open_saved_video_document` | Replace the video project with a saved one by `key`. One undo step. Ask before opening over changes the user has not saved. |

## Pitfalls

- With agent playback on, the cursor drags a moved or trimmed clip to its new time, clicks a track where a clip goes in, and clicks the ruler where a split, seek or marker lands. Give real `start` / `at` times in ms; results are unchanged.
- **Effects need rendered frames to export.** ffmpeg cannot draw provider effects, so
  `export_video_ffmpeg` refuses a project with enabled effects unless the host renders the
  picture frame by frame (`renderVideoFrameExact`) and passes `frames`. Tell the user, or turn
  the effects off (`update_effect` with `enabled: false`) for a quick draft export.
- **Effects render a frame later.** The preview draws a clip without its effect until the
  provider's picture for that frame arrives; `get_video_frame` and the project are always
  exact. Effects are cached per frame of the project's frame grid.
- **Values are checked, keys too.** Out-of-range or unknown controls are refused with the
  control's description; only number controls can be keyframed, and transition values cannot.
- **Effects survive without a provider.** A project opened where no provider (or a different
  one) is registered keeps every effect id and value, shows effect clips as labelled boxes and
  effect transitions as crossfades, and saves them back unchanged.

- **Edits never add errors.** Any edit that would create an overlap, a source overrun or an
  impossible transition is refused whole (unless you asked for `mode: "overwrite"` or
  `"insert"`); read the message (it names the next free place or the longest trim /
  transition that fits) and retry with those numbers.
- **Animations write keyframes for you.** `animateIn` / `animateOut` move opacity, x, y and scale;
  if the clip keys one of those itself, the animation leaves it alone (`animation-keyed`), and
  entrance plus exit longer than the clip are shortened (`animations-too-long`).
- **Numbers replace keyframes.** Setting `opacity` or `volume` as a plain
  number (in `add_video_clip` or `update_video_clip`) drops that property's keys; animate with
  `set_video_keyframes` after the static settings, not before.
- **Slip, slide and roll clamp.** They move as far as the media allows and say how far in
  `delta`; check it instead of assuming the full amount was applied.
- **Times move after a cut.** Ranges from the find tools are valid for the timeline as it was;
  pass them all to one `remove_video_ranges` (it cuts last first), or find again after each cut.
- **`edit_video` has no result references.** Unlike `edit_animation`, ops cannot say `$0.id`;
  set clip, track and marker ids yourself when later ops in the batch need them.
- **`edit_video` op shapes differ slightly** from the single tools: `add_asset` wraps the asset
  as `{ asset: { id, kind, src, ... } }`, `add_track` as `{ track: { kind, ... } }` and
  `add_marker` as `{ marker: { time, label } }`.
- **Same kind of track.** A clip moves only between tracks of its kind; images, titles and colours
  never go on audio tracks, audio files never on video tracks (`wrong-track`).
- **A ramp replaces `speed`.** Setting `speed` on a ramped clip is refused; change the ramp or
  `remove_video_speed_ramp` first. Trims and splits keep a ramp on the same frames of source;
  lengthening a ramped clip past its ramp holds the end frame.
- **Speed changes length.** Setting `speed` keeps the source stretch, so the clip gets shorter or
  longer and can collide with the next one; ripple or move clips after.
- **Transitions need a butt cut.** The incoming clip must start exactly where the previous one ends
  on the same track (`transition-without-cut`); close the gap first. Splitting keeps the
  transition on the left part.
- **Fades are per clip.** `fadeIn + fadeOut` longer than the clip warns `fades-too-long`; fades
  affect picture and sound together. Fade curves shape only the sound (media clips); the picture
  always fades linearly. Splitting keeps the fade-in curve on the left part and the fade-out
  curve on the right.
- **Compound clips are one picture.** A grade, blend or opacity on a compound changes the
  sequence's composite, not each clip in it, so a multiply on a compound multiplies the whole
  nested frame over what is beneath (and leaves its transparent parts untouched). Trimming,
  splitting and slipping a compound move its `in` through the sequence; it can never play past
  the sequence's end (`source-overrun`), a transition into it needs sequence time either side of
  the cut like media handles, and `speed` or a ramp on it is refused. A compound whose sequence
  is missing (`missing-sequence`) or contains itself (`sequence-cycle`) plays nothing.
- **Clips inside sequences are read-only for now.** Write tools refuse a clip id inside a
  sequence with a message naming it; change the compound clip instead. The EDL lists a compound
  as a black event with a `* COMPOUND CLIP` comment (CMX 3600 has no nesting).
- **Locked tracks** refuse edits to their clips; unlock with `update_video_track` only if the user
  wants that track changed.
- **Read-only**: when `get_video_project` says the project cannot be edited, write tools are
  hidden; read, render and export still work. Tell the user rather than working around it.
- **LUTs are files.** `set_video_lut` needs a `src` both the preview (a URL it can fetch) and
  ffmpeg (a local path; the host maps it with `resolveLut`) can read; the export notes a URL it
  cannot. SVG frames from `render_video_frame` draw a LUT approximately (curves and a colour
  matrix), so judge a LUT's exact colours with `get_video_scopes` or the preview.
- **Scopes need real pixels.** `get_video_scopes` reads what the host's preview draws, so it
  fails when nothing is showing the project or the media cannot load in time, and a canvas
  with media from another origin served without CORS cannot be read. Video drawn as a
  placeholder box is never measured: the tool waits for every picture to load.
- **Exports are commands, not files.** `export_video_ffmpeg` returns a command for the host to
  run; the EDL covers one track only. Report the notes on anything approximated.
