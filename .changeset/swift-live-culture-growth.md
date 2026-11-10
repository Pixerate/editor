---
"@pixerate/swift": minor
"@pixerate/editor": patch
---

feat(swift): live biopaint growth in the Swift paint editor (`PaintEditorController.playCultures(now:)` returning a `PaintCulturePlayer`, driven by `PaintEditorModel.runCultureClock()` in `PaintEditorView`). Each uninterrupted run commits as one "Culture growth" undo step with its `culture-grow` replay events, flushed before any other command, undo, redo, `set_age` or save; replays (`render_xray` with `strokes`, `export_high_res`, time-lapse) include growth not yet committed; pause and speed apply. Fix (TS and Swift): wet paint flowing on another layer no longer splits a live growth run and drops its replay events (#731).
