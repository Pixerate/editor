---
'@pixerate/editor': minor
'@pixerate/editor-react': patch
'@pixerate/editor-svelte': patch
---

Effects providers can offer camera moves: a new `camera` effect kind (and `camera` use) that moves a scene's camera instead of drawing pixels. A camera effect's summary has `camera: { role: 'transition' | 'hold', durationMs, cut? }`. Providers set `capabilities.supportsCamera` and implement `cameraView(id, { from, to, u, ms, stage }, values?)`, a synchronous, pure function returning a `CameraView` (`{ zoom, scrollX, scrollY, tilt?, turn?, roll?, perspective?, blur?, blurAngle? }`), and may implement `sampleCameraMove` to return keyframes. `checkEffectProvider` checks camera moves and lets their `createRenderer` refuse; `sampleEffectCameraMove`, `sampleCameraViews`, `isCameraView` and `effectOffered` are new helpers, and `createFakeEffectProvider({ camera: true })` adds three camera moves. `search_effects` filters by `kind: 'camera'` and reports each move's role, length and cut. The React and Svelte effect browsers leave camera moves out unless asked for the `camera` use, and their thumbnails label them "Camera".
