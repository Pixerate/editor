---
"@pixerate/editor": patch
"@pixerate/swift": patch
---

Brushes made `basedOn` a preset no longer keep the base's `family` when their own facets give another: `create_brush` drops the copied family and derives it again (`impasto-brush` made metallic files under `metallic`, `ink-pen` with light under `glow`, `watercolor-round` with live patterns under `living`), and `update_brush` does the same for a family that only restated the brush's old facets. A `family` the caller passes, or one a brush was given on purpose, is kept. The Swift brush library tools do the same.
