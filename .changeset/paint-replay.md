---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Time-lapse and high-resolution replay in the paint editor. `timeLapse()` repaints the painting from its recorded strokes and events (fills, clears, flattened relief and wet-media events at their simulation clock; wet strokes point by point, so wet paint flows as it did) and returns PNG frames, a video project of the frames and the ffmpeg command from the video editor's export path (`timeLapseZip` packs them); `renderHighRes({ scale })` repaints at 2–8× instead of upscaling. Fills, clears and relief flattening are now recorded for replays (`paintEvents`), and wet events record where they fall between strokes. New agent tools `export_time_lapse` and `export_high_res`; React and Svelte toolbars add Time-lapse and PNG 2×.
