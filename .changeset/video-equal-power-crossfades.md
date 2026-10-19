---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: transitions take an `audioCurve` for the sound's fades through them, and crossfades and wipes now default to `equal-power`, so loudness holds steady across the cut instead of dipping by 3 dB halfway (dips stay linear). The preview, `videoFrameAt` and the ffmpeg export (`afade` curves) agree. `videoTransitionAudioCurve` is exported, `set_video_transition` takes `audioCurve`, and the React and Svelte `ClipInspector` show a "Transition sound" menu.
