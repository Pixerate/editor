---
"@pixerate/editor-svelte": minor
---

Add `GradientEditor` and `FillPicker` components to `@pixerate/editor-svelte/gradient`. `FillPicker` reports every gradient edit through `onchange`, follows a new `value` without adding an undo step, forwards drag gestures, and passes `showPresets` / `showCss` to the gradient editor.
