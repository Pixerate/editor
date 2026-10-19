---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: proxies. Video assets take `proxies` (`[{ scale, src, width?, height? }]`), smaller copies the preview plays instead of the original. The export, EDL and source times always use the original. The controller has a preview scale (`previewScale` option, `setPreviewScale`, `state.previewScale`): `auto` (by the canvas's shown size, the default), `full`, or a fraction that picks the smallest proxy at least that large. `VideoPreviewEngine` follows it and switches elements as it changes. `videoProxyFfmpeg` and `videoProxyPlan` build ffmpeg commands that make proxies: scaled to even sizes, H.264 with a short keyframe interval and no B-frames so seeks are cheap, sound kept, `faststart`. New agent tools `plan_video_proxies`, `set_video_proxies` and `set_video_preview_scale`; `get_video_project` reports the preview scale. The React and Svelte `VideoTransport` add a preview-size control when any asset has proxies, and `MediaBin` marks assets that have them. `videoShellQuote` is now exported.
