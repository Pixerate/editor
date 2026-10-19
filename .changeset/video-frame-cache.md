---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Video editor: an optional frame cache with prefetch for the preview, after Blender's sequencer cache. `VideoFrameCache` holds decoded source frames keyed by the file the preview plays (asset or proxy) and the source frame, so clips of one asset share them and edits never invalidate them. It prefetches the window ahead of the playhead (behind when scrubbing back), nearest first, a few at a time, within a memory budget. Eviction drops the frames furthest from the playhead, counting frames behind it as further, and never touches the prefetch window. Pass it as the controller's `frameCache` (or the engine's). `VideoPreviewEngine` then draws cached frames while paused, scrubbing or mid-seek, and keeps the frames it shows. Also new: `createVideoElementDecoder` (a browser decoder on hidden `<video>` elements), and `planVideoPrefetch`, `videoCacheEvictions` and `videoFrameRequestsAt` as pure helpers. New agent tool `get_video_preview_cache` reports the cache and which stretches play without waiting. The React and Svelte `VideoTimeline` draw the cached stretches under the ruler.
