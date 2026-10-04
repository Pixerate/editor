---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add deterministic animation clock, streaming view stabilization, and agent vision/narration features:
- Core: `Clock`, `realClock`, and `ManualClock` for step-by-step frame animation testing and deterministic trajectories.
- Core: Streaming stabilization math including `layoutBounds`, `canvasHeight`, `estimateCanvasHeight`, `blendLayout`, and `connectedOnly`.
- Core: `MCP_TOOL_VIEW_EDITOR` and `EXPORT_EXCLUDED_SELECTORS` for multimodal evaluation without cursor artifact loops.
- Core: Choreography `say` and `wait` command planning with `note` support on `AgentPresence`.
- React & Svelte: `AgentPresenceLayer` speech bubbles and presence exclusion classes.
- React & Svelte: `useStreamingCanvas` and `createStreamingCanvas` with `connectedOnly` and `clock` options.
