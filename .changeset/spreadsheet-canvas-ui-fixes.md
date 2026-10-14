---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Fix UI bugs found in the browser:

- Spreadsheet (React): text typed into a cell is committed again on Enter, Tab and blur (`setDraftValue` now updates the controller's draft).
- Spreadsheet (React, Svelte): typing on a selected cell no longer doubles the first character, the cell editor is focused (Svelte), focus returns to the grid after Enter / Tab / Escape, sticky header and row-number cells are opaque, the context menu stays inside the viewport (new `clampMenuPosition` helper), and a denied clipboard write in the copy fallback no longer causes an unhandled rejection.
- Canvas: the snapped position is kept when a drag ends (React Flow's drag-stop change and SvelteFlow's drop no longer restore the raw pointer position), and `snapPositionChanges` accepts React Flow's `NodeChange[]` (id-less `add` changes).
