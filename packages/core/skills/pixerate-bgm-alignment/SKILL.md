---
name: pixerate-bgm-alignment
description: How to work with background music in the Pixerate video editor - finding a music track's tempo and beats, proposing cuts snapped to the beat as an edit plan for review, ducking music under speech with eased volume keyframes, measuring loudness in LUFS and normalising clips to streaming, podcast or broadcast targets, and shaping music outros. Use when asked to cut to the music, sync edits to a beat, lower music under dialogue, balance or normalise levels, or when find_video_beats, duck_video_music or normalize_video_loudness are available.
---

# Pixerate music and the mix

Music sits on its own audio track under the picture and dialogue. Three jobs make it work:
**cutting to it** (cuts that land on beats feel deliberate), **ducking it** (dipping it under
speech so words stay clear) and **levelling it** (every clip at a consistent loudness, the mix
at the delivery target). The tools here measure the sound itself, from the peaks the editor
already decodes for waveforms, so the numbers match what the timeline shows.

Loudness is in **LUFS** (ITU-R BS.1770, gated): what streaming services, podcasts and
broadcasters measure. -14 LUFS for streaming and social, -16 for podcasts, -23 for EBU R128
broadcast. Peaks in dBFS should stay under -1.

This skill works with the video editor's own tools (`pixerate-video-editor`): tracks, clips,
`set_video_keyframes`, `update_video_clip` fades, `apply_video_edit_plan`, `export_video_ffmpeg`
loudness. See `pixerate-agent-tools` for errors and undo.

## Working method

1. **Find the music.** `get_video_project`: the music clip is usually on its own audio track.
   Turn that track's `syncLocked` off (`update_video_track`) so ripple cuts in the dialogue do not
   cut the music.
2. **Find the beat.** `find_video_beats` with `clip` (timeline times) returns the `bpm`, a steady
   `beats` grid and the `onsets` (each hit). If `bpm` is null the music has no steady pulse:
   cut on the strongest onsets instead.
3. **Cut on the beat.** `plan_video_beat_snap` with `music` (or `beats`) and the picture
   `track` proposes rolling each cut to the nearest beat within `tolerance` (default 150 ms) as
   one plan; it lists cuts it left (no beat near, already on one, not enough media). Show the
   plan, then `apply_video_edit_plan`.
4. **Duck under speech.** Once dialogue is final, `duck_video_music` with the music clips:
   speech comes from the transcript (or from the dialogue track's sound with
   `speech: "audio"`), and each music clip gets eased volume keyframes dipping `duck_db` under it.
5. **Level.** `measure_video_loudness` on dialogue and music clips; `normalize_video_loudness`
   sets clip volumes so each plays at a target (dialogue at -16 to -14 LUFS; music beds lower,
   around -24 to -20 under speech). Normalise before ducking: ducking keys are relative to the
   clip's volume when it is applied.
6. **Finish.** A music bed ends on a fade: `update_video_clip` `fadeOut` 2000-4000 ms with
   `fadeOutCurve` `exponential` (natural to silence) or `s-curve`. For delivery, export with
   two-pass loudness (`export_video_loudness_measure`, then `export_video_ffmpeg` with
   `loudness.measured`).

## Best practices

- **Cut on the downbeat for big changes.** Section changes land on the first beat of a bar
  (every 4th beat in 4/4); shot changes inside a section can take any beat. Fast montages cut
  every 1-2 beats, slower pieces every 4-8.
- **Lead the beat slightly.** A cut a frame or two before the beat reads as on it; the eye takes
  a moment to register a new shot.
- **Duck by -12 to -18 dB.** -14 dB is a good default; quieter music needs less. An attack of
  150-300 ms and a release of 300-600 ms sound natural; short releases pump.
- **Keep gaps ducked.** `merge_gap` (default 600 ms) stops the music bobbing up between
  sentences; raise it to 1000-1500 ms for slow, measured speech.
- **Normalise clips, not the master.** Bring each clip to a sensible level so the mix is
  balanced, then let the export's loudness pass set the final target.

## Tool reference

| Tool | When and how to use it |
| --- | --- |
| `find_video_beats` | Read-only. The tempo (`bpm`, null when the hits do not repeat), a steady `beats` grid and the `onsets` of a `clip` (timeline ms) or `asset` (source ms), optionally between `from` and `to`. `sensitivity` (default 1.5; lower finds more hits), `min_bpm` / `max_bpm` (default 60-200). Decodes the asset the first time. Use the beats for `plan_video_beat_snap`, markers or title timing. |
| `plan_video_beat_snap` | Proposes rolling each cut on a `track` (default the first video track) to the nearest beat within `tolerance` ms (default 150), with beats from a `music` clip or given as `beats` (timeline ms). Roll edits keep everything else in place. Returns the plan (id, summary, `text`), how many cuts `moved` and the `skipped` ones with a reason. Nothing changes until `apply_video_edit_plan`. |
| `duck_video_music` | Dips `music` clips under speech with volume keyframes (one undo step): `duck_db` (default -14), `attack` (default 200 ms), `release` (default 400 ms), `merge_gap` (default 600 ms). Speech from the transcript (`speech: "transcript"`, the default when there is one) or from where `dialogue_track`'s sound is above -40 dBFS (`speech: "audio"`). Refuses clips with volume keyframes unless `replace: true`. Returns the speech stretches and each clip's keys. |
| `measure_video_loudness` | Read-only. Integrated loudness (`lufs`, null for silence) and sample `peakDb` of a `clip` or `asset` stretch, before clip volume, with `toStreaming` (the gain to -14 LUFS that keeps the peak under -1 dBFS). |
| `normalize_video_loudness` | Sets each of `clips`' volume so it plays at `target` LUFS (default -14) with its peak under `ceiling` (default -1 dBFS) and at most 4x gain (one undo step). Skips silent clips; refuses volume keyframes unless `replace: true`. Returns each clip's `lufs`, `gain`, `gainDb` and `limitedBy` when a cap held it short. |

## Pitfalls

- **Ducking before the dialogue is final.** Ducking keys are placed at the speech as it is now.
  Clean up and re-time dialogue first, then duck; if speech moves later, duck again with
  `replace: true`.
- **Normalising a ducked clip.** `normalize_video_loudness` sets a constant volume, which would
  replace ducking keys; it refuses unless `replace: true`. Normalise first, then duck.
- **Beat grids drift on live music.** A steady grid suits programmed music. For a live band, snap
  to `onsets` (pass them as `beats`) instead of the grid.
- **Sync-locked music gets cut.** A ripple cut or extract on dialogue cuts every sync-locked
  track, including the music. Turn the music track's `syncLocked` off first.
- **Peaks, not true peaks.** The tools measure sample peaks; the export's `loudnorm` limits true
  peaks. Leave a decibel of headroom.
