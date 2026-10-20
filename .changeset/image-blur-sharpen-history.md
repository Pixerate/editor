---
"@pixerate/editor": minor
---

Image editor: Blur, Sharpen and History Brush tools.
- Blur and Sharpen lay a soft blur or an unsharp mask of the layer through the brush, at `strength`.
- The History Brush paints the layer (or its mask) back from `historySteps` undo steps ago, or from the oldest state history keeps.
- They work on pixels and masks at any bit depth, and each stroke is one undo step.
- New agent tools: `blur_stroke`, `sharpen_stroke` and `history_brush`. The tools are in the palette (History on `Y`), with Strength and Steps back controls in the React and Svelte options bars.
- New in `/paint`: `retouchFilter` and `boxBlurPixels`.
