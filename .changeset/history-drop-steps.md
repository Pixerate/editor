---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

**History: remove stale steps with `dropSteps`.**

- `HistoryManager.dropSteps(match)` removes the undo and redo steps `match` picks without running them, for steps whose changes no longer apply (remote content replaced what they change, a layer was reloaded). The other steps keep their order, a gesture merging into a removed step ends, and a mark on a removed step is no longer valid. It reports a `drop` commit event and returns how many steps were removed. Until now, integrators had to skip such steps by hand or reach into private fields.
- History entries (`getEntries`, commit events) now carry the step's `tag`.
- React `useHistory().dropSteps`, Svelte `createHistory().dropSteps` and Swift `HistoryManager.dropSteps` match.

**Canvas: gesture undo keeps work done since.**

- `createCanvasGestureRecorder` undo and redo now put back only the nodes and edges the gesture changed. Before, they restored the whole canvas from before the drag, which removed nodes and edges a collaborator or an agent had added since and undid their moves. A node the gesture changed is replaced only if it is still there (undoing a move does not bring back a node deleted since), and one the gesture added or removed is removed or put back at its index.
