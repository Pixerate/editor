---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Bring the save / load / undo contract to the canvas.

- `createCanvasEditorDocument({ getNodes, setNodes, getEdges, setEdges, history, scenes? })` (kind `canvas`): the nodes and edges held by the host (without selection or measurement) plus saved scenes, loads checked for duplicate ids, dangling edges and missing parents, one undo step in the shared history. Agents get `get_canvas_document`, `load_canvas_document`, `undo_canvas`, `redo_canvas` and the save / open tools.
- `createCanvasGestureRecorder(...)`: `begin()` / `end("Move")` around a gesture the flow library applies itself (a node drag), recorded as one undo step.
- React: `useCanvasEditorDocument({ nodes, edges, setNodes, setEdges, history, scenes })`. Svelte: `createCanvasDocument({ getNodes, setNodes, getEdges, setEdges, history, scenes })`. Both also count changes the history does not see, but not selection or drag frames.
