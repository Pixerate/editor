---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Video editor: camera moves from the effects provider. A clip is the shot: a `transition` move (a glide, whip pan, punch zoom) moves from `from` to `framing` from the clip's start, and a `hold` move (a Ken Burns drift) plays across the rest of it. `VideoEditorController.setClipCameraMove` / `clearClipCameraMove` bake the clip's moves with `sampleEffectCameraMove` at the project's frame rate into its x, y, scale and rotation keys over its transform (kept in `camera.base`, put back when the moves are cleared), so previews and exports play them without the provider. Keyframes may now hold two keys at one time, a jump, so a move's cut never tweens; speed ramps still take one key per time. New: `VideoClipCamera`, `bakeVideoClipCamera`, `videoTransformOfView`, the `camera-stale` check, the agent tools `list_video_camera_moves`, `set_clip_camera_move` and `clear_clip_camera_move`, and `<ClipCameraMoves>` (in `<ClipInspector>`) for React and Svelte.
