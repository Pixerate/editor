---
"@pixerate/editor": minor
---

Add `createReviewToolProvider`, agent tools for comments and tracked changes in a rich text editor: `list_comments`, `add_comment`, `reply_to_comment`, `resolve_comment`, `delete_comment`, `list_changes`, `accept_change`, `reject_change`, `accept_all_changes`, `reject_all_changes` and `set_track_changes`. Each group appears when its extension (`Comments`, `TrackChanges`) is installed, write tools only while the editor is editable, and every document change is one undo step. Register it with `useAgentToolProvider` in React or Svelte. The `pixerate-rich-text` and `pixerate-rich-text-revise` skills describe them.
