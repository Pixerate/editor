---
"@pixerate/editor-react": minor
---

Add `GradientEditor`, `FillPicker`, and `useGradientController` to `@pixerate/editor-react/gradient`. `FillPicker` is a controlled component: it reports every gradient edit through `onChange`, follows a new `value` without adding an undo step, forwards drag gestures, and passes `showPresets` / `showCss` to the gradient editor.
