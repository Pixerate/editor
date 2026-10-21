---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agent playback: every tool call can be acted out by the agent's cursor, from any caller (scripted agents, `callTool`, MCP clients), with no per-tool code.

- `@pixerate/editor/tools`:
  - `createAgentPlayback({ speed, reads, linger, clock, actor })`. Install it with `playback.install(registry)` or `registry.use(playback.middleware)`.
  - `ToolRegistry.use(middleware)` and `ToolCallContext.actor` (`callTool(name, args, { actor })`). `createMcpServer` names the actor after the client's `clientInfo`.
  - Tools may declare a pure `plan(args, state)` returning cursor steps, or `playback: 'self' | false`. Without a plan, playback visits the ids named in the arguments and rings what the result created.
  - With no surface attached, calls run instantly with identical results. `createInstantPresenceClock` and `playback.record()` support tests.
  - The presence primitives (`PresenceStore`, `PerformanceQueue`, …) now live in `tools`. `animation` re-exports them.
- Commands: `CommandSpec.plan` and `playbackSurface`. `run_command` and `run_commands` play on the command's surface (its scope, or its id prefix).
- Canvas:
  - `createEditorMcpToolProvider` plans its edits from the planner's model steps (`planCanvasToolPlayback`): the cursor clicks where a new node lands, drags edges and rings moved nodes.
  - `createCanvasPlaybackLocator` finds nodes and edges.
  - The provider takes new `playbackSurface` and `rectOptions` options.
- React:
  - `PresenceLayer`, `AgentPlaybackProvider` / `useAgentPlayback`, `usePlaybackSurface` and `useCanvasPlaybackSurface`.
  - `useAgentToolProvider(registry, provider, { playback })` installs the playback.
- Svelte: `PresenceLayer`, `setAgentPlayback` / `getAgentPlayback`, `createPlaybackSurface`, `createCanvasPlaybackSurface`, and the `useAgentToolProvider` `playback` option.
- Deprecated: `AgentPresence` and `AgentPresenceLayer`. Use `PresenceLayer` with a playback surface.
