---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

History gestures, undo marks, memory budget, History-panel entries and dirty-vs-saved tracking.

- `HistoryManager.executeMerged(cmd, { key })` folds consecutive merged executes with the same key into one undo step regardless of timing; any other recorded command, undo, redo, `revertTo`, `goTo`, `clear` or `endGesture()` ends the gesture. `beginGesture(key)` / `endGesture()` hold a gesture so every merged execute joins one step. Tag-only `executeMerged` keeps its 300 ms time window.
- `mark()` / `revertTo(mark)` take back every step since the mark without leaving anything on the redo stack (Escape-cancel); a mark that has left the history is a no-op returning 0. `isMarkValid(mark)`.
- `maxBytes` with a `sizeOf(command)` hook (or `command.byteSize`) drops the oldest steps beyond the budget but always keeps the newest; `getByteSize()`.
- `getEntries()` (`{ id, label, index, current, undone }`) and `goTo(index)` for History panels; `getRevision()`.
- `DirtyTracker` gains `normalize`, a revision-keyed `isDirty(value, revision)` cache, stateful `update` / `dirty` / `markClean` / `subscribe`, and re-entrant `suppress(fn)` (also `withoutDirty`). `bindDirtyToHistory` keeps it in step with a `HistoryManager`, so undoing back to the saved state is clean again. Also exported from `@pixerate/editor/history`.
- `SpreadsheetController` caps its snapshot undo at `maxHistoryBytes` (default 64 MiB) in addition to 50 steps, and exposes `getHistoryByteSize()` / `getHistoryDepth()`.
- React: `useHistory()` returns `entries`, `goTo`, `mark`, `revertTo`, `beginGesture`, `endGesture`; new `useHistoryDirty()`.
- Svelte: `createHistory()` gains the same members; new `createHistoryDirty()` rune.
