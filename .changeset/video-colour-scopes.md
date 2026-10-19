---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: colour scopes. Pure functions on RGBA pixels give a histogram (`videoHistogram`), a Rec. 709 luma waveform (`videoLumaWaveform`) and a vectorscope (`videoVectorscope`), sampled to a fixed cost, plus exposure figures (`videoExposureStats`: luma mean, median and percentiles, the share crushed or blown and per channel, saturation, average colour) with notes on what to fix (`videoExposureNotes`, `summarizeVideoScopes`), and drawn scope images (`videoScopeImage`). `VideoPreviewEngine` publishes the pixels it draws to `controller.previewPixels` (`VideoPreviewPixels`), marking frames whose media is still loading or seeking as incomplete. New agent tool `get_video_scopes` measures the rendered frame at any time, waiting for every picture to load; hosts without a preview pass `framePixels` (e.g. a frame decoded by ffmpeg). React and Svelte add `<VideoScopes>` and `<VideoEditor showScopes>`.
