---
"@pixerate/swift": minor
---

Swift paint editor UI: draw pending paint proposals as ghosts on `PaintCanvasView` (`<PaintCanvas proposals>` on the web). `PaintEditorModel.showProposals(_:)` takes a `PaintProposals` store, keeps `proposalGhosts` (each proposal's ghost image, rect, title, rationale and origin) in step with it, and registers the proposal tools in the model's registry. The canvas draws each ghost translucent with a dashed edge, without hit testing; the host draws accept and dismiss controls from `proposalGhosts`.
