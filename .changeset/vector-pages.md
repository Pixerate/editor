---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Multipage vector documents with master pages: the top-level frames are pages, and master pages draw their art (laid out by resizing constraints, with `{page}` / `{pages}` in text) on every page that uses them, in the canvas and every export. New `addPage`, `addMasterPage`, `setPageMaster`, `movePage`, `goToPage`, the `vector.*Page*` commands, `parentId` on `vector.addText`, and `<VectorPagesPanel>` in React and Svelte. The skill's pitfalls moved to `references/pitfalls.md`.
