---
"@pixerate/editor": minor
---

The animation editor stacks motion. A command with `blend: "add"` becomes a layer over the target's pose instead of a change that the next one takes over from. It stacks with whatever else moves the target, and what it adds stays once it ends.

- **Emphasis:** pulse, shake, teeter, wave and wiggle are additive by default, so a shake during a slide shakes as it slides and lands where the slide ends. Pass `blend: "replace"` for the old take-over.
- **Move, rotate and scale:** they take `blend: "add"` too. Offsets and turns add; scales multiply.
- **Overlap check:** additive layers are no longer reported as overlapping.
- **Flair export:** a layer on its own is one exact change; layers that overlap the pose are sampled.
- **New exports:** `motionAddTrackKey`, `withMotionLayers`, `MOTION_ADDITIVE_PROPERTIES` and `MOTION_BLENDS`.
