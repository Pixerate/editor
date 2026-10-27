---
"@pixerate/editor": minor
---

Remove the paint editor's deprecated `save_document` and `open_document` agent tools from `createPaintEditorToolProvider`. They were kept as aliases for one minor version after the shared document tools arrived. Use `get_paint_document` (the painting with images as asset references) or `save_paint_document` instead of `save_document`, and `load_paint_document` or `open_saved_paint_document` instead of `open_document` (register them with `createDocumentToolProvider(createPaintEditorDocument(controller))`).
