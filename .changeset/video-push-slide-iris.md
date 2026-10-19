---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: push, slide and iris transitions. `push` slides the incoming clip in and the outgoing one out, `slide` brings the incoming clip in over the outgoing one, both eased and in any `direction`; `iris` opens a circle from the frame's centre. `videoFrameAt` moves the layers' rects (or gives them an `iris`), SVG frames and the canvas clip to the circle, and the ffmpeg export moves overlays with eased expressions and masks the iris with `geq` (checked against a real ffmpeg render); EDLs mark them as wipes. `VIDEO_TRANSITION_LABELS`, `videoTransitionHasDirection`, `videoTransitionEase` and `videoIrisRadius` are exported. The React and Svelte `ClipInspector` list the new types and show a direction menu for wipe, push and slide.
