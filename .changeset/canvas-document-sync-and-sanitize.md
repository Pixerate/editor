---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
"@pixerate/editor-react": minor
---

Add `sanitizeCanvasDocument`, `applyGraphDifferences`, and companion `extras` support to `createCanvasEditorDocument`, and reactive remote persistence controllers (`createEditorRemoteSync`, Svelte `createEditorSync` and React `useEditorSync`). `save` receives the diff from the last saved snapshot and the `baseVersion` it builds on; returning `{ conflict: true }` from a compare-and-set write calls `onConflict` to merge and save again (or reports an `EditorRemoteConflictError`).

Autosave takes a `baseVersion` (`createAutosaveController`, `createEditorAutosave`, Svelte `createAutosave` / `createEditorAutosave`, React `useAutosave` / `useEditorAutosave`): it is stored in each snapshot's meta, and the recovery check retires snapshots made on an older server version instead of offering them. `createEditorAutosave` adds `recoverIfNewer`.
