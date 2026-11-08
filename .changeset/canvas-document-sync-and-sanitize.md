---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
"@pixerate/editor-react": minor
---

Add `sanitizeCanvasDocument`, `applyGraphDifferences`, and companion `extras` support to `createCanvasEditorDocument`, `baseVersion` staleness retirement to `createEditorAutosave`, and reactive remote persistence controllers (`createEditorRemoteSync`, Svelte `createEditorSync` and React `useEditorSync`). `save` receives the diff from the last saved snapshot, so edits coalesced into one save are all in it.
