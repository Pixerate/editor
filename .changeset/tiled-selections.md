---
'@pixerate/editor': minor
---

Selections and alpha channels are stored as 256 × 256 tiles. Empty and fully selected areas cost nothing, and masks share the tiles an operation did not change, so undo steps keep only what changed. `historyBytes` (and the `maxHistoryBytes` limit) now count selection and channel tiles too. At 12 MP, combining or inverting a selection drops from about 11 ms to under 1.5 ms, and a marquee from about 115 ms to under 10 ms, because shapes are rasterised in their bounding box only. Quick Mask paint, Free Transform of a selection and masks made from a selection share tiles instead of copying the whole image. `SelectionMask` gains `surface`; `data` is unchanged for readers (built on first read and cached). New: `selectionFromTiles`, `selectionFromRegion` and `polygonCoverageBox`.
