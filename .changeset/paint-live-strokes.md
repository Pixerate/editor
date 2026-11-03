---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Live paint strokes, so an agent can paint along with the user:

- `PaintEditorController.onStrokeSample` streams the user's stroke as it is painted (begin, each batch of samples, then end or cancel, with the brush and colour). `getLiveStroke` and the agent tool `get_live_stroke` give a snapshot.
- `createPaintAgentStrokes` holds an agent's companion strokes in progress. `PaintCanvas` and `PaintEditor` draw them live (`agentStrokes`) until they are painted, in React and Svelte.
