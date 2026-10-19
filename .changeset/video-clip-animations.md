---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: entrance and exit animations. Clips take `animateIn` / `animateOut: { effect, duration }` with effects `fade`, `rise`, `drop`, `slide-left`, `slide-right`, `zoom` and `pop` (which overshoots and settles). They are written out as keyframes on opacity, x, y and scale (`videoClipAnimated`), so previews, SVG frames and the ffmpeg export, drawtext titles included, play them the same way (checked against a real ffmpeg render). A property the clip keys itself is left alone and noted (`animation-keyed`); entrance plus exit longer than the clip are shortened and warned about (`animations-too-long`). Splits keep the entrance on the left part and the exit on the right. `update_video_clip` sets them, and the React and Svelte `ClipInspector` have Animate in / Animate out menus.
