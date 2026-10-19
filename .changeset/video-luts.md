---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: 3D LUTs on grades. `VideoGrade.lut` (`{ src, strength, name }`) applies a `.cube` file after the grade's other steps, mixed in at its strength. New `parseVideoCubeLut` (title, domain, input range; errors give the line), tetrahedral `applyVideoLut` and `applyVideoLutToPixels`, `videoLutFromFunction`, `videoLutToCube`, `videoLutSvgApproximation`, `videoGradeLook` (a preset that keeps the LUT), `videoLutEdits`, and `VideoLutCache` (`controller.luts`, with a `luts` loader option). The canvas preview draws LUT layers on a scratch canvas and runs them through the table (frames count as incomplete until the LUT loads). SVG frames approximate a LUT with curves and a colour matrix. The ffmpeg export uses `lut3d` (with `split` + `blend` at part strength, and `resolveLut` for file paths), checked against a real ffmpeg. New agent tools `set_video_lut` (reads the file first) and `remove_video_lut`; `apply_video_grade_preset` keeps a clip's LUT, and `render_video_frame` draws LUTs and says when one is approximate or missing. The React and Svelte `ClipInspector` add a LUT row (path or file, strength, remove).
