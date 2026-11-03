---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Painting alongside an agent:

- `PaintEditorController` records who made each undo step (`withOrigin`, `getOrigin`), reports steps (`onCommit`), groups changes into one undo step (`group`) and previews paint without changing anything (`previewPaint`). It works as a `createOriginMiddleware` history target.
- `createPaintChangeFeed`: strokes, fills and layers added, removed or changed, and the start and end of each stroke, with who made them. React `usePaintChangeFeed`, Svelte `createPaintChangeWatcher`.
- `createPaintProposals`: paint an agent suggests (strokes, a wash, an echo of the user's strokes), shown as a ghost and accepted as one undo step on a layer of its own. Agent tools `propose_paint`, `list_paint_proposals`, `accept_paint_proposal` and `reject_paint_proposal` (`createPaintProposalToolProvider`). React `usePaintProposals`, Svelte `createPaintProposalState`. `PaintCanvas` and `PaintEditor` draw ghosts (`proposals`).
