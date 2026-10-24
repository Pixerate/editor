---
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Parameter colour fields (`ParameterColor`) now open the shared `ColorPicker` in a popover instead of the native `<input type="color">`. The hex box stays inline. A field's swatches and its alpha slider (`alpha: true`) moved from below the field into the popover, so they are no longer visible until the swatch button is clicked. Gesture callbacks fire once per drag as before.
