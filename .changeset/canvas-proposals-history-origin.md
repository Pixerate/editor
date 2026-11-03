---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agents can now work alongside the user on the canvas: suggest additions instead of making them, follow what the user changes, and tell their edits apart from the user's.

- **History origin.** Undo steps record who made them: `Command.origin` (`user` by default, `agent:<id>` for an agent), `HistoryManager.withOrigin(origin, fn)` for everything `fn` records, and `HistoryEntry.origin`. A gesture or a coalesced `executeMerged` never folds in another origin's change. `agentOrigin` / `originAgentId` build and read origins.
- **Commit feed.** `HistoryManager.onCommit(listener)` hears each change as it lands (`execute`, `merge`, `undo`, `redo`, `revert`, `clear`) with the step and who made it, including every step of a `goTo`.
- **Origin middleware.** `createOriginMiddleware({ histories })` (`@pixerate/editor/tools`) records the changes a write tool makes as the calling agent's (`agent:<actor.id>`).
- **Canvas proposals.** `createCanvasProposals` stages agent-suggested nodes and edges as ghosts (`withGhosts`) that are accepted as one undo step, made by the proposer, or rejected without a trace. Placement is beside an anchor or in free space in view. The agent tools `propose_nodes`, `list_proposals`, `accept_proposal` and `reject_proposal` come from `createCanvasProposalToolProvider`. React: `useCanvasProposals`. Svelte: `createCanvasProposalState`.
- **Canvas change feed.** `createCanvasChangeFeed` reports nodes, edges and the selection added, removed or edited, with the origin of the history step behind each change (else `user`) and whether a drag is in progress. React: `useCanvasChangeFeed`. Svelte: `createCanvasChangeWatcher`.

`HistoryEntry` gains a required `origin` field: code that builds `HistoryEntry` objects itself must set it.
