---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agent playback for the vector editor: every `vector.*` command can be acted out by the agent's cursor.

- Core:
  - `createVectorCommands` plans the commands that make something at a place. `addShape` is dragged out corner to corner, `addPath` is traced, `addText` is clicked in (or dragged as a box) and typed, `placeSymbol` and the image stylizers are placed, `setTextStyle` drags across its range and `setMeshPoint` drags the point.
  - Every vector command plays on the `vector` surface; commands that take `ids` visit those nodes.
  - New `createVectorPlaybackLocator` and `withVectorPlayback`.
- React and Svelte: `VectorCanvas` takes `playback` (default: the playback context), `playbackId` (default `vector`) and a reveal callback (`onPlaybackReveal` / `onplaybackreveal`), and draws the cursor over the canvas.
