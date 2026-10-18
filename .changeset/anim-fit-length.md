---
"@pixerate/editor": minor
---

Animation scenes can be fitted to a length.

- **Shot speed:** a shot's `speed` scales all of its time: camera move, delays, durations, staggers and hold.
- **Fitting:** `fitMotionScene(scene, ms, { keep })` and the `fit_animation` agent tool (one undo step, with a dry run) set the shots' speeds so the scene lasts `ms`. Kept shots play as they are, and the rest stretch or squeeze together. This follows After Effects' protected regions.
- **Refusals:** it refuses, with the reason, when the kept shots alone outlast the target or a speed would leave 0.05–20×.
- **Checks:** the length warnings now point to `fit_animation`.
