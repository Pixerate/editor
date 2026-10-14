---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add review features for the rich-text editor: comments and tracked changes.

- Core: `Comments` extension (`comment` mark + `addComment` / `resolveComment` / `deleteComment` / `setActiveComment` / `focusComment`) backed by a headless, server-free `CommentStore` (threads, replies, resolve, orphan detection, `toJSON` / `load`). `TrackChanges` extension (suggestion mode) with `insertion` / `deletion` marks, `setTrackChanges` / `toggleTrackChanges`, `acceptChange` / `rejectChange` / `acceptAllChanges` / `rejectAllChanges` (single undo steps), `selectNextChange` / `selectPreviousChange`, and `getTrackedChanges`. Both are opt-in via `createRichTextPreset({ comments, trackChanges })`.
- Serializers: `htmlToPlainText`, `getEditorText` and `getEditorMarkdown` accept `{ trackedChanges: "accepted" | "original" | "all" }` and default to `"accepted"`, so suggested deletions never leak into exported text. New `resolveTrackedChanges(doc, view)`.
- React: `CommentsPanel`, `ReviewToolbar`, `CommentButton`, `useComments`, `useTrackChanges`.
- Svelte: `CommentsPanel`, `ReviewToolbar`, `CommentButton`, `createComments`, `createTrackChanges`.
