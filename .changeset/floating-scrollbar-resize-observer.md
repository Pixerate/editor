---
"@pixerate/editor-svelte": patch
---

Fix `FloatingHorizontalScrollbar` keeping a stale `left` and `width` when its target resizes without a window or target event. It now re-measures through a `ResizeObserver` on `targetElement`, which follows the prop and disconnects on destroy.
