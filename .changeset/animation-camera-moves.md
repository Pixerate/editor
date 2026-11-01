---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Animation editor: camera moves from the effects provider. A shot's camera can name a move it gets in with (`camera.in`, a `transition` move such as a glide or whip pan) and a move it makes while it holds (`camera.during`, a `hold` move such as a Ken Burns drift), as Flair's scenes do, each with a preset, values and (for a move in) a length. With a provider that has camera moves (`capabilities.supportsCamera`), the stage plays them per frame through `cameraView`, with tilt and turn on the stage element and roll and motion blur in the frame's SVG; a hold move's last view carries into the next move. Without one they are kept and the camera eases between framings. New: `motionCameraViewAt`, `motionCameraWindows`, `checkMotionCameraMoves`, `AnimationEditorController.setShotCameraMove` / `clearShotCameraMove` / `cameraMoves`, the agent tools `list_camera_moves`, `set_shot_camera_move` and `clear_shot_camera_move`, and `<ShotCameraMoves>` (in `<ShotInspector>`) for React and Svelte. The Flair export tags each camera change a move makes with `<move>@<shot>`, and with `options.effects` samples the move exactly, keeping a cut a jump. Effects helpers: `resolveCameraMoveSpec`, `cameraMovesFor`, `cameraViewOfBox`, `cameraBoxOfView` and the `CameraMoveSpec` type.
