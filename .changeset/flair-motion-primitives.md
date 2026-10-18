---
"@pixerate/editor": minor
---

The animation editor speaks Flair's motion primitives (`@pixerate/flair/motion`). Shared commands and primitives have the same names and defaults:

- **New entrances:** `enter` gains the `zoom` and `rise` styles, and a starting `scale` for `pop` and `zoom`.
- **New emphasis commands:** `teeter`, `wave`, `wiggle` (seeded smooth noise; the same seed always wanders the same way, and by default each target gets its own seed from its id) and `color-pulse`.
- **Shake:** `shake` takes an `axis`.
- **Primitive names:** `motionFlairPrimitive` and `get_animation`'s `flairPrimitive` name the Flair primitive each command plays.

Pulses, shakes and the new emphasis commands are now Flair behaviours. `MotionSegment.wave` is replaced by `behavior` (and `index`), and `@pixerate/editor/animation` exports `behaviorProgress`, `fractalWiggle` and `motionSeedFromId`, ported from Flair so the numbers match.

The Flair export writes these behaviours as one exact change with `behavior` instead of sampling them. This needs Flair 0.38 or later; pass `behaviors: false` (also on `export_flair_motion` and `export_flair_effect`) to sample them for older Flair.
