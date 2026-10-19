---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: colour grades. Clips take `grade: { exposure, contrast, saturation, hue, temperature, tint }`, applied as a fixed series of clamped colour-matrix steps that the canvas (CSS filters, with white balance as an SVG `feColorMatrix` the preview engine adds to the page), SVG frames and the ffmpeg export (`lutrgb`, `colorchannelmixer`) all share, so they agree (checked against a real ffmpeg render). `VIDEO_GRADE_CONTROLS` drives the schema, inspectors and clamping; `VIDEO_GRADE_PRESETS` (warm, cool, punchy, faded, black-and-white, bleach-bypass, day-for-night) apply at a strength with `videoGradePreset`; `applyVideoGrade`, `videoGradeCssFilter`, `videoGradeSvgFilter` and `videoGradeFfmpegFilters` are exported. New agent tools `apply_video_grade_preset` and `copy_video_grade`; `update_video_clip` sets `grade`. The React and Svelte `ClipInspector` add a look menu and a slider per setting. `drawVideoFrame` takes a `defineSvgFilter` option and `VideoPreviewEngine` a matching one.
