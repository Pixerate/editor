---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

The animation stage shows motion on a still.

- **Onion skin:** faded ghost frames either side of the playhead. Ghosts are a set time apart, or fall on the moments commands start and end, and fade with distance.
- **Motion paths:** a dashed line where each node's centre travels, with a dot where each change starts or ends.
- **Core:** `motionGhosts`, `motionPath`, `motionMovingIds`, `motionPathsSvg` and `motionStageSvg`. `controller.toSvg` takes `onionSkin`, `motionPaths` and `motionPathColor`.
- **React and Svelte:** `<AnimationStage>` and `<AnimationEditor>` take `onionSkin` and `motionPaths`.
- **Agents:** `render_animation_frame` takes `onion_skin` and `motion_paths`, and a new read tool, `get_motion_path`, returns the path as numbers.
- **Demo:** the animation tab has toggles for both.
