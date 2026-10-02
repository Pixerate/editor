---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add canvas math primitives, smart collision-avoiding layout, agent planning & MCP tools, streaming canvas gliding, and slot component inversion:

- **Core Canvas Extraction**: Extracted graph layout, trajectory animations, directional displacement, and clipboard serialization into `@pixerate/editor/canvas`.
- **Smart Layout & Collision Avoidance**: Implemented `ensureLayout` (centroid-based incremental layout blending) and `placeBeside` (spiral raycast collision avoidance).
- **React Canvas Parity**: Implemented `useCanvasGraph`, `useCanvasLayout`, `useCanvasClipboard`, `useCanvasShortcuts`, `useCanvasDocking`, and `useCanvasExplosion` in `@pixerate/editor-react/canvas`.
- **Agent Director & MCP Layer**: Added `planAgentCommand`, MCP tool definitions (`get_editor_state`, `edit_canvas`, `edit_prompt`), and `<AgentPresenceLayer />` for visual multi-agent cursor choreography in both React and Svelte.
- **Streaming Viewers**: Added `StreamingLayoutManager`, `useStreamingCanvas` (React), and `createStreamingCanvas` (Svelte) for throttled auto-layout with tweened node gliding during rapid streams.
- **Slot-Based Inversion**: Added `EditorSlotsProvider` and `useEditorSlots` to allow zero-fork injection of custom design system components.
