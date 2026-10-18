---
"@pixerate/editor": minor
---

The animation editor's agent tools get easier to use in fewer calls.

- **References in batches:** in an `edit_animation` batch, later ops can use what earlier ones made: `"$0.indexes[0]"` is the first command op 1 added, `"$last.shot"` is the shot the op before changed, and `"$$"` is a literal `$`. The tool returns each op's outcome. `resolveMotionEditRefs` does the same outside the tools.
- **Contact sheet:** `render_animation_frame` takes `times` (and `columns`) to draw several moments as one labelled contact sheet (`motionContactSheetSvg`), as SVG or PNG.
- **Tests:** new tests do realistic agent tasks only through the tools. Golden fingerprints of frames catch any change to how scenes draw (regenerate with `vitest -u`).
