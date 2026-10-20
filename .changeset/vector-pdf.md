---
"@pixerate/editor": minor
---

Vector PDF export, as real paths rather than a picture.

- Gradients become PDF shadings; opacity and blend modes become graphics states.
- Clip masks and stroke alignment are kept.
- Writes one page, or one page per artboard.
- New API: `toPdf` and `vectorDocumentToPdf`.
- New agent command: `vector.exportPdf`.
