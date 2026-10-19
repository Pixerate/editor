---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: blend modes. Clips take `blend` (`normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `add`), the modes CSS `mix-blend-mode`, the canvas and ffmpeg's `blend` filter share. `videoFrameAt` layers carry it, SVG frames and `drawVideoFrame` apply it, and the ffmpeg export blends each layer with the composite in RGB and lays the result back through the layer's alpha, so opacity, fades and partial coverage still apply (checked pixel by pixel against the CSS formulas; soft-light differs slightly in ffmpeg and says so in the notes). `update_video_clip` sets it, and the React and Svelte `ClipInspector` have a Blend menu. `VIDEO_BLEND_MODES` and `VIDEO_BLEND_MODE_LABELS` are exported.
