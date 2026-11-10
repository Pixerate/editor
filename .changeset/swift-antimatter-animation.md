---
"@pixerate/swift": minor
"@pixerate/editor": patch
---

feat(swift): play the antimatter blast expansion animation (`marks.duration`) in the Swift paint editor, matching TypeScript: `AntimatterStrokeDriver.renderAtTime` / `rebaseTime` / `hasBlasts` (frames from the stroke's heat field, with the mid-blast flash and shock ring), `PaintEditorController.tickBlastAnimation` / `hasActiveBlastAnimation` (view-only frames over the committed layers, keeping pre-stroke light and relief where a frame leaves them alone; cleared by undo, redo, a new canvas or stroke), driven by `PaintEditorModel.tick` on the `PaintEditorView` clock (#732)

docs(core): the paint editor skill's antimatter reference explains that `duration` only animates the view.
