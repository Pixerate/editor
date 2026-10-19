---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: shaped sound fades. Media clips take `fadeInCurve` / `fadeOutCurve` (`linear`, `equal-power`, `s-curve`, `exponential`, `logarithmic`), the same curves ffmpeg's `afade` draws, so `videoFrameAt`, playback and the ffmpeg export agree (checked against a real ffmpeg render). Pictures still fade linearly. `videoFadeCurveGain`, `VIDEO_FADE_CURVES` and `VIDEO_FADE_CURVE_LABELS` are exported; `update_video_clip` sets and removes the curves; splits keep the fade-in curve on the left part and the fade-out curve on the right. The React and Svelte `ClipInspector` show a curve menu for each fade a media clip has.
