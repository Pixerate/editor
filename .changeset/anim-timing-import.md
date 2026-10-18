---
"@pixerate/editor": minor
---

The animation editor gains timing features and imports from Flair.

- **Springs:** Figma's named springs are new easing presets (`spring-gentle`, `spring-quick`, `spring-bouncy`, `spring-slow`; `SPRING_PRESETS`). A command with a spring and no `duration` lasts until the spring settles (`springSettleMs`). A new `spring-cut-short` warning flags a spring given less time than it needs. The tools accept spring and elastic objects.
- **Repeat:** any command except `enter` and `exit` can `repeat`, with `repeatMode` `loop`, `mirror` (every other cycle plays backwards) or `offset` (carry on from where the last ended). `duration` is one cycle; see `motionCycleDuration` and `motionCommandRepeat`.
- **Stepped time:** `steps` on a command, or on the scene with `set_animation_settings`, holds poses on a frame grid ("on twos").
- **Geometric zoom:** `geometric` on `scale` and on cameras zooms at a steady rate.
- **Flair export:** a `flair` version option (default `0.39`) decides what is written exactly. Flair 0.39 takes springs, stepped time as `strobe`, and mirrored repeats as reversed curves (`reverseCubicBezier`). Older versions get these sampled.
- **Flair import:** `fromFlairSvgMotion` and `fromFlairVectorEffect`, plus the `import_flair_effect` agent tool (with a dry run), turn a Flair motion or catalog effect into a scene. Colour placeholders become controls, each step becomes a shot, and behaviours become emphasis commands, with notes on anything that does not carry over.
