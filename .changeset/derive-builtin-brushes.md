---
"@pixerate/editor": patch
---

Derive `BUILTIN_BRUSHES` directly from `BRUSH_PRESETS` via `resolveBrush` and move flat `PaintBrush` types, constants, and `normalizePaintBrush` into `paint-editor/brush-model` so `brushes` no longer cycles through `BUILTIN_BRUSHES`.
