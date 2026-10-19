---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

feat(core,react,svelte): keyframes for video clips. A clip's `opacity`, `volume` and `transform` `x` / `y` / `scale` / `rotation` may now be `{ keys: [{ t, v, ease }] }` in clip time (ms from the clip's start), with `linear`, `hold`, `ease-in`, `ease-out`, `ease-in-out` or CSS cubic-bezier `[x1, y1, x2, y2]` easing. `videoValueAt` evaluates them for `videoFrameAt`, the canvas / SVG renderers and agents; the ffmpeg export bakes them to piecewise-linear expressions (alpha via `geq`, overlay x/y, `rotate` angle, `scale` with `eval=frame`, `volume` with `eval=frame`). Split partitions keys and inserts boundary keys (subdividing eased segments exactly), trimming the head and rate stretches keep keys on their frames, and `checkVideoProject` warns about `keyframes-outside-clip`. New `set_keyframes` edit op, `set_video_keyframes` / `remove_video_keyframes` agent tools, and keyframe toggles (add / remove at the playhead, type to set the key there) in the React and Svelte `<ClipInspector>`.
