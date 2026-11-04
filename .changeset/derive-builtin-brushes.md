---
"@pixerate/editor": patch
---

The paint editor's `BUILTIN_BRUSHES` is now derived from the facet presets (`BRUSH_PRESETS`) instead of a hand-written copy, so a built-in brush is defined once. The brushes, their order, ids and categories are unchanged.
