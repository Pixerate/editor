---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add autosave, crash recovery and document migration (`@pixerate/editor/persistence`).

- Core: `createAutosaveController` (debounced crash-recovery snapshots with a hydration gate, exponential retry, `flushNow` for `pagehide`, `checkRecovery` / `discardRecovery`, and `markClean` that only retires a snapshot this session wrote), the pure `createRecoveryPolicy` state machine, `createRevisionTracker` (revisions from a `HistoryManager` and `bindDirtyToHistory`), storage adapters (`createMemoryStorage`, `createLocalStorageAdapter`, `createIndexedDbAdapter`, `createOpfsAdapter` with temp-file rename or pointer-swap writes, all feature-detected and with injectable failures), and `migrateDocument` / `loadSections` / `loadDocument` with a `LoadReport` (step-wise migration, per-section fallback, read-only newer versions, unknown keys preserved).
- Core: `loadImageEditorDocument` in `@pixerate/editor/image-editor` loads `SerializedImageEditorState` with a `LoadReport`; valid state is returned unchanged.
- React: `useAutosave` and `<RecoveryPrompt>` (`@pixerate/editor-react/persistence`).
- Svelte: `createAutosave` and `<RecoveryPrompt>` (`@pixerate/editor-svelte/persistence`).
