---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Animation scenes can have motion blur.

- **Setting:** `scene.motionBlur` takes `shutter` (degrees, default 180) and `samples` (default 8, at most 32).
- **Sampling:** each frame on the stage, in `render_animation_frame` and in contact sheets averages moments across the shutter (`motionBlurTimes`). There are more moments for faster motion and none when nothing moves, added exactly with `plus-lighter`.
- **Unchanged:** `motionFrameToSvg` and the Flair and Lottie exports stay sharp, and the exports say so.
- **Agents:** `set_animation_settings` sets or clears `motionBlur`.
- **React and Svelte:** `SceneSettings` has a Motion blur select.
