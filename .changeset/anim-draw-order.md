---
"@pixerate/editor": minor
---

Drawing on (`draw`, `enter` with style `draw`, `exit` with style `undraw`) can order a group's strokes.

- **Sequence:** `order: "sequence"` draws one stroke after another, each for a time in proportion to its length. Add `sortBy: "distance"` and an `origin` for a radial reveal.
- **Speed:** `pace: "speed"` draws all strokes at one speed, starting or finishing together (`align`).
- **Comet:** `draw` takes `comet`, a short stroke that runs along the path and off the end.
- **Export:** Lottie writes the comet's tail as the trim start.
- **Checks:** they treat a group as drawn when any of its strokes is.
