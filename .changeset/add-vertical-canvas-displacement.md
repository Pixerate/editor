---
"@pixerate/editor-svelte": patch
---

Add vertical row displacement to canvas explosion solvers:
- Add `'vertical'` to `DisplacementDirection` in `@pixerate/editor-svelte/canvas` to expand exploded rows vertically without horizontal coordinate shifts.
- Symmetrically shift nodes above upward and nodes below downward based on child cluster bounding box.
- Support `minY` constraint to prevent upward displacement from clipping past top boundaries or headers, transferring unmet upward displacement to downward clearance.
