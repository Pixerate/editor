# Video editor: follow-up work

What is left after the October 2026 round of video editor work, which drew on the ArtCraft
"craft apps" repositories (FilmCraft, EffectCraft, SoundCraft, LightCraft, DeckCraft, PhotoCraft,
FigCraft; MIT / Apache-2.0) and on Blender's sequencer (GPL: concepts only, no code).

Each item says where to start and what "done" means. The repo rules still apply: every
feature works in core, React and Svelte; it has an agent path with strict schemas, annotations
and tests through `ToolRegistry.callTool`; the video skill (`packages/core/skills/pixerate-video-editor/SKILL.md`)
is updated; and anything exported to ffmpeg is checked against a real render in
`packages/core/tests/video-editor-ffmpeg.test.ts`.

## Shipped in this round

For context, so the follow-ups below make sense:

| PR | What |
| --- | --- |
| #187 | Keyframes on opacity, volume and transform |
| #188 | Slip, roll, slide, lift / extract, razor, overwrite / insert, sync lock |
| #192 | Drop-frame timecode and EDLs, shaped sound fades, waveforms, sound levels and silences, loudness normalisation |
| #194 | Equal-power crossfades, blend modes, colour grades and looks, push / slide / iris transitions, entrance and exit animations |
| #196 | Text-based editing from transcripts |
| #198 | Speed ramps and freeze frames |
| #201, #202, #204 | Colour scopes, 3D LUTs, proxies and a preview frame cache (proxies landed with #204) |
| #205 | Nested sequences (compound clips), phase 1: model, checks, evaluation, renderers, sound, read-only tools |

## 1. Nested sequences, later phases

Phase 1 (#205) plays compound clips everywhere but treats a sequence's insides as read-only.

- **Phase 2: editing inside sequences.** Today edits to clips inside a sequence are refused
  with a message. Let `applyVideoEdits` address clips by path (`comp/inner`, as evaluation already
  does) or by sequence, so trims, splits, ripples, keyframes and so on work inside a sequence.
  Each edit remains one undo step.
  - Tools to create a compound from selected clips (replacing them with one compound clip in
    place) and to flatten one back out.
  - React and Svelte: an "open compound" view of the timeline with a breadcrumb back out.
- **Phase 3: interchange.** EDL export flattens compounds into their source events instead of a
  comment. Transcripts read through compounds (`videoTimelineTranscript` maps words via the
  compound's `in` and the inner clips).
- **Phase 4: speed on compounds.** `speed` and `timeRemap` are refused on compounds today. Allow
  both, applied to sequence time, with the same `setpts` / `fps` / `tpad` export path as media
  clips.

## 2. Multicam

Deferred because it depends on nested sequences: a multicam clip is naturally a sequence of N
synced angles plus a list of cuts choosing which angle shows when.

- Model: a multicam sequence (angles as tracks, synced by timecode, marker or audio) and a
  multicam clip with `cuts: [{ at, angle }]`.
- Sync by audio: cross-correlate the angles' sound (FilmCraft uses GCC-PHAT in
  `crates/audio-dsp/src/sync.rs`). The peak pyramid from #192 is not enough; it needs real
  samples.
- Tools: `create_video_multicam`, `switch_video_angle { clip, at, angle }`, `flatten_video_multicam`.
- UI: an angle viewer grid with click-to-cut while playing.

## 3. Research ideas not built yet

Roughly in order of value for effort.

### Sound
- **Ducking** as computed volume keyframes. Take the dialogue track's levels (`videoAudioLevels`),
  find regions, and write ramps down and up onto the music's `volume` keys, so preview and export
  agree without a sidechain. Reference: FilmCraft `crates/audio-dsp/src/ducking.rs`.
- **Pan** on clips and tracks with a selectable pan law. Web Audio `StereoPannerNode` for preview,
  `pan=stereo|c0=…|c1=…` for ffmpeg. Reference: SoundCraft `crates/dsp/src/pan.rs`.
- **Clip gain envelopes and track automation** beyond today's volume keyframes: a track-level
  volume lane, and point thinning before export.
- **Track effects**: EQ, compressor, limiter. `BiquadFilterNode` / `DynamicsCompressorNode` for
  preview, `equalizer` / `acompressor` / `alimiter` for export. Document that preview and export
  differ slightly.
- **Smooth sound through speed ramps.** Today ramped sound is stepped every ~80 ms and silent in
  freezes. A resampling pass (WSOLA, or `rubberband` where the ffmpeg build has it) would glide.

### Editing
- **Through-edit detection and join**: two adjacent clips that continue the same media are one
  clip. Add a `check_video_project` note and a `join_video_clips` tool. Reference: FilmCraft
  `crates/edit/src/through.rs`.
- **Transition alignment**: `align: 'center' | 'start' | 'end'`, so a transition can sit wholly
  on one side of the cut when one clip has no handles. Reference: FilmCraft
  `crates/edit/src/transitions.rs`.
- **Shuffle placement mode** (Blender's overlap mode): push a moved clip to the nearest free spot
  instead of refusing, overwriting or inserting.
- **Snap categories**: label snap points by kind (clip edge, marker, playhead, keyframe) and add
  a same-track-only option.
- **Scene-cut detection** on video assets: a luma grid plus histogram difference against a local
  median, feeding an `auto_split_video_clip` tool. Reference: FilmCraft `crates/render/src/scene.rs`.

### Pictures
- **Masks and mattes**: rectangle / ellipse / path masks with feather, and alpha or luma track
  mattes. Reference: EffectCraft `crates/render/src/masks.rs`.
- **Motion blur** for animated clips, by sub-frame accumulation (`tmix` in ffmpeg).
- **Shape clips** (rect, ellipse, path with fill, stroke and trim paths) and **per-letter text
  animators**. Reference: EffectCraft `crates/render/src/shapes.rs`, `crates/text/src/selectors.rs`.

### Interchange
- **OpenTimelineIO export** (our JSON is close to OTIO already), and FCPXML. Every exporter returns
  warnings for what it cannot express. Reference: FilmCraft `crates/interchange/src/otio.rs`,
  `fcpxml.rs`.
- **Caption export** (SRT / WebVTT) from title clips or transcripts, and a caption track kind.

### Agent and test infrastructure
- **Tool availability with reasons**: report write tools as unavailable with a `disabledReason`
  ("no clip selected", "read-only") instead of only hiding them. Reference: DeckCraft
  `crates/engine/src/cmd/mod.rs`.
- **Flexible time inputs**: accept `frame` and timecode strings (`"00:00:12:05"`) alongside ms.
- **Property-based tests** over `applyVideoEdits` with fast-check: no overlaps after any edit
  sequence, and insert-then-extract restores the project. #188 started this; extend it to ramps,
  sequences and transcripts.
- **Golden-image render tests** with PSNR thresholds and a bless flag. Reference: FilmCraft
  `crates/testkit/src/golden.rs`.

## 4. Known limitations of what shipped

Worth fixing when the area is next touched:

- **Soft-light blending** in ffmpeg uses a different formula from the browser's, up to about
  10/255 off. The export notes say so. A `geq` implementation of the W3C formula would make it exact.
- **Canvas `filter` support**: grade previews use the canvas `filter` property, so browsers
  without it (older Safari in particular) preview without the grade. LUT previews work on the
  CPU through `getImageData`, which is slow at large preview sizes. A WebGL path would cover both.
- **Ramped sound** is stepped and silent in freezes (see Sound above).
- **Iris with animated scale or position** masks against the clip's static placement, so the
  circle can drift from the frame centre.
- **Titles drawn with `drawtext`** cannot take grades, blend modes or rotation; `titleImage`
  can. The export notes say so.
- **Demo**: the Video tab's sample project has no speech, so the transcript panel starts empty.
  A short narrated sample with a transcript would show text-based editing off.
