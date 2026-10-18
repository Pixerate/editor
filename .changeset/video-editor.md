---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add a UI-agnostic video editor (`@pixerate/editor/video-editor`). Projects are plain JSON: video, audio and image assets on video and audio tracks, with media clips (in point, speed, volume, fades, opacity, fit, transform), titles, colour clips and markers. `applyVideoEdits` adds, moves, trims (with ripple), splits, deletes (with ripple) and closes gaps all or nothing, and never adds an error; crossfade, dip and wipe transitions play over the cut, with handle checks that say the longest transition that fits. `videoFrameAt` gives the layers and sounds at any moment, `VideoPreviewEngine` plays a project on a canvas in the browser, `VideoEditorController` adds undo, playback, selection and snapping, and projects export to an ffmpeg command or a CMX 3600 EDL. `createVideoEditorToolProvider` exposes 29 agent tools. React (`@pixerate/editor-react/video-editor`) and Svelte (`@pixerate/editor-svelte/video-editor`) add `<VideoEditor>`, `<VideoPreview>`, `<VideoTimeline>`, `<VideoTransport>`, `<ClipInspector>`, `<MediaBin>` and `useVideoEditor` / `createVideoEditor` with `useVideoEditorTools`.
