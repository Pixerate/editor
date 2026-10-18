---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Animation scenes can play on a trigger: `trigger` is `click`, `hover`, `press` or `scroll`.

- **Click export:** the Flair export turns each shot into a Flair step timed from the shot's start. The first shot plays on load, and each click plays the next.
- **Hover, press and scroll:** these play, rewind or scrub the whole scene.
- **Effects:** `toFlairVectorEffect` and the export tools carry the trigger, `FlairMotionExport.trigger` says what to pass to `SvgPlayer`, and `export*` options take `trigger` (null for none).
- **Import:** Flair imports keep an effect's trigger.
- **Lottie:** the Lottie export notes that it plays through.
- **Checks:** `trigger-loop`, `click-one-shot` and `click-cue`.
- **Agents:** `set_animation_settings` and `get_animation` handle `trigger`.
- **React and Svelte:** the scene settings panel has a "Plays on" select.
