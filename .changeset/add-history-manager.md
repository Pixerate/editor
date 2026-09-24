---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

feat(history): add generalizable undo/redo HistoryManager with React and Svelte adapters

- Introduced framework-agnostic `HistoryManager` with bounded undo/redo stacks, atomic `batch()` transactions, continuous-event coalescing (`executeMerged`), and `createSnapshotCommand()` helper.
- Added `@pixerate/editor-react` hooks: `useHistory()` (powered by `useSyncExternalStore`) and `useHistoryShortcuts()` with active input focus guards.
- Added `@pixerate/editor-svelte` adapters: `createHistory()` (dual Svelte 5 rune and store contract support) and `createHistoryShortcuts()`.
- 100% backward compatible and completely optional for consumers to adopt.
