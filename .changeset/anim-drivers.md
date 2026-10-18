---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Animation scenes get drivers: properties that follow other nodes' properties.

- **What they're for:** parallax, a wheel turning as it rolls, a shadow fading as something rises.
- **How they work:** `scene.drivers` maps a source's change from rest, times `factor` plus `offset` and clamped, onto the target's x, y, rotation, scale or opacity, on top of its own commands. Chains are followed.
- **Checks:** a loop between drivers is a `driver-cycle` error, and unknown nodes are named with "did you mean".
- **Export:** Flair and Lottie sample driven properties wherever their sources change.
- **Core:** `motionPropertyValue`, `applyMotionDrivers` and `motionDriverSources`. `formatMotionDrivers` and `parseMotionDrivers` read and write drivers one a line (`dot.x <- box.x * 0.5`).
- **Agents:** a new `set_animation_drivers` tool, and `get_animation` lists drivers.
- **React and Svelte:** `SceneSettings` has a Drivers box.
