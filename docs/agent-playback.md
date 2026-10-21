# Agent playback

> **Draft: this API is planned, not released.** It describes the design in [agent-playback-plan.md](agent-playback-plan.md). Names may change before phase 0 ships, and this page will be updated as each phase lands. Today, only the chart, paint, diagram and rich-text tools play, through their `director` / `presence` options.

Agent playback makes an agent's tool calls visible. The agent's cursor glides to what it is working on, presses, drags or types, and each call lands as one undo step. It works the same for every caller: a model connected over MCP (`createMcpServer`, `connectToolBridge`), a scripted run (`runToolScript`) or your own `registry.callTool(...)`.

You enable it once per registry. You don't write code per tool, and you don't pick DOM targets.

## Contents

- [Enable playback](#enable-playback)
- [Show the cursor: React](#show-the-cursor-react)
- [Show the cursor: Svelte](#show-the-cursor-svelte)
- [Speed, skip and stop](#speed-skip-and-stop)
- [Headless, servers and tests](#headless-servers-and-tests)
- [Several agents](#several-agents)
- [Editors in tabs or panels](#editors-in-tabs-or-panels)
- [Scripted agent turns](#scripted-agent-turns)
- [For tool authors: how a call is played](#for-tool-authors-how-a-call-is-played)
- [Supported editors](#supported-editors)

## Enable playback

```ts
import { createToolRegistry, createAgentPlayback } from '@pixerate/editor/tools';

const registry = createToolRegistry();
const playback = createAgentPlayback({
  speed: 1,                 // 1 = natural pace, 2 = twice as fast, Infinity = no animation
  reads: 'glance',          // read-only tools: 'glance' (move only), 'skip' or 'play'
  linger: 1500,             // ms the cursor stays after the agent's last call (0 keeps it)
  actor: { id: 'agent', name: 'Agent', color: '#7c3aed' },
});
registry.use(playback.middleware);
```

Register tool providers as usual. Playback changes how a call looks on screen, never what it returns. A call returns the same result, or the same error, with or without playback.

## Show the cursor: React

Pass the playback object once through context. Every editor inside it then registers its surface and draws the agent's cursor.

```tsx
import { AgentPlaybackProvider, useAgentToolProvider } from '@pixerate/editor-react';

<AgentPlaybackProvider playback={playback}>
  <CanvasEditor … />
  <VectorEditor … />
</AgentPlaybackProvider>

// Inside a component: the provider's surface is attached for you.
useAgentToolProvider(registry, provider, { playback });
```

Editors also accept a `playback` prop directly. Editors that already had a `director` (chart, paint, diagram) build it from `playback`, so you no longer create directors yourself. Passing `director` explicitly still works.

For a custom surface (your own component), use `usePlaybackSurface(playback, providerId, { root, locate?, toViewport?, reveal? })` and render `<PresenceLayer store={surface.presence} />` inside it.

## Show the cursor: Svelte

```svelte
<script lang="ts">
  import { setAgentPlayback, useAgentToolProvider } from '@pixerate/editor-svelte';
  setAgentPlayback(playback);              // context for every editor below
  useAgentToolProvider(registry, provider, { playback });
</script>

<CanvasEditor … />
<VectorEditor … />
```

The custom surface equivalents are `createPlaybackSurface(playback, providerId, options)` and `<PresenceLayer store={surface.presence} />`. React and Svelte take the same options and draw the same cursor.

The cursor uses the `.pixerate-presence` class. Snapshots, `view_editor` and `capture_view` leave it out of their images.

## Speed, skip and stop

```ts
playback.speed = 2;          // takes effect on the next step
playback.speed = Infinity;   // "Skip": finish what's queued with no animation
playback.stop();             // stop playing; the calls still run and their results are kept
playback.say('Checking the layout…');   // a note in the cursor's bubble on the current surface
```

Each tool call is one undo step, so the user can undo an agent call by call. If the user drags something while the agent is acting, both edits apply, but the agent's call may split into two undo steps. To prevent that, set the editor read-only while `playback.active` is true.

## Headless, servers and tests

Playback only animates when a surface for the called provider is mounted and visible. Calls run instantly, with identical results, in these cases:

- no editor is mounted (Node, an MCP server with no UI, workers);
- the editor is hidden and has no `reveal` (see below);
- `speed` is `Infinity`;
- the browser tab is in the background. Waits use timers, never animation frames, so a hidden tab never stalls a call.

In tests, use the instant clock to run full performances in virtual time and check what was played:

```ts
import { createAgentPlayback, createInstantPresenceClock } from '@pixerate/editor/tools';

const clock = createInstantPresenceClock();
const playback = createAgentPlayback({ clock });
const steps = playback.record();               // collects every step played
await registry.callTool('canvas__canvas_add_node', { node: { data: { label: 'Ship' } } });
expect(steps.map((s) => s.type)).toEqual(['move', 'press', 'release', 'type', 'commit', 'focus']);
```

## Several agents

Each caller can have its own cursor and queue. `createMcpServer` names the actor after the client's `clientInfo.name`. In your own calls, pass it yourself:

```ts
await registry.callTool('vector__run_command', args, { actor: { id: 'reviewer', name: 'Reviewer' } });
```

One actor's calls play one after another. Different actors play side by side.

## Editors in tabs or panels

If the agent calls a tool for an editor that is mounted but not visible, playback asks the surface to `reveal()` itself before playing. Give the surface a `reveal` that switches to it:

```tsx
<VectorEditor playbackReveal={() => setTab('vector')} … />
```

Without `reveal`, a hidden editor's calls run instantly.

## Scripted agent turns

`runToolScript` plays a list of notes and tool calls at reading speed. Use it for tours, demos and end-to-end tests of a skill. Later steps can use earlier results.

```ts
import { runToolScript } from '@pixerate/editor/tools';

await runToolScript(registry, {
  id: 'align',
  prompt: 'Line up the main workflow steps',
  steps: [
    { say: 'Listing the nodes.', tool: 'canvas__list_nodes', as: 'nodes' },
    { say: 'Centring the main path.', tool: 'canvas__align_nodes', args: (ctx) => ({ edge: 'middle', ids: ctx.results.nodes.nodes.map((n) => n.id) }) },
  ],
}, { playback, onEvent: (e) => console.log(e) });
```

Steps have no cursor targets: each tool's own playback decides where the cursor goes.

## For tool authors: how a call is played

Every call plays at the richest tier the tool supports:

| Tier | You provide | What plays |
| --- | --- | --- |
| Director | `playback: 'self'` on the tool, and the handler drives a director | Live drags, strokes, typing (chart, paint, diagram, rich text) |
| Plan | `plan(args, state)` on the tool, or `plan(context, params)` on a `CommandSpec` | Exactly the steps you return |
| Derived | nothing | Glide to the ids in the args, press, run; then a ring on new ids in the result |
| Instant | (no surface mounted) | The handler runs unchanged |

### Get the derived tier for free

Use the conventional argument and result names. Playback finds targets by reading them:

- **Arguments:** `id`, `ids`, `layerId`, `clipId`, `trackId`, `nodeId`, `seriesId`, `parameterId`, `range` / `cell` (A1).
- **Results:** `id`, `ids`, `created[].id`.

Then make sure the surface can locate those ids. Either render `data-<kind>-id="…"` on the element (`data-vector-id`, `data-layer-id`, …), or give the surface a `locate(ref)` that returns a rectangle in surface coordinates.

### Add a planner

A planner is a pure function. It gets the validated arguments and the current state (before the call) and returns steps in surface coordinates (the editor's own document or canvas units, never screen pixels):

```ts
import type { PlaybackStep } from '@pixerate/editor/tools';

const addShape: CommandSpec<VectorContext, AddShapeParams> = {
  id: 'vector.addShape',
  // …params, run, undoable…
  plan: (ctx, p): PlaybackStep[] => [
    { type: 'move', to: { x: p.x, y: p.y } },
    { type: 'press' },
    { type: 'drag', to: { x: p.x + p.width, y: p.y + p.height } },
    { type: 'release' },
    { type: 'commit' },                       // the command runs here
  ],
};
```

The steps are:

| Step | Does |
| --- | --- |
| `move { to, ms? }` | Glide the cursor to a point |
| `target { ref }` | Glide to whatever `ref` locates (`{ kind: 'node', id }`, `{ kind: 'control', name }`, `{ kind: 'cell', ref }`) |
| `focus { rect }` | Draw a highlight ring around a rectangle |
| `press` / `release` | Press or release the cursor's button |
| `drag { to, ms? }` | Move with the button down (cursor only; the change applies at `commit`) |
| `type { text, ms? }` | Show text being typed at the cursor |
| `say { text, ms? }` | Show a note in the cursor's bubble |
| `commit` | Run the handler. It runs exactly once, and is appended to the plan if you leave it out |

Rules for planners:

- **Pure.** Read state, never change it. The same arguments and state give the same steps.
- **Pre-call state.** Ids that the call will create don't exist yet. Plan toward the position where the change will land; the derived post-roll points at new ids from the result.
- **Never block a call.** If a planner throws or returns nothing, the call falls back to the derived tier.
- **Durations are optional.** Leave `ms` out and the cursor moves at the shared natural pace, scaled by `speed`.
- **Live previews need a director.** If the change should update step by step as the cursor moves (a value following a drag, paint landing along a stroke), write a director and mark the tool `playback: 'self'`. Use `PresenceStore`, `PerformanceQueue` and `tweenPresenceCursor` from `@pixerate/editor/tools`.

### Test it

Call the tool through `ToolRegistry.callTool` with `createInstantPresenceClock()` and a fake surface. Assert two things:

- The recorded steps are what you planned.
- The result matches a call made without playback.

The conformance test in `tests/command-tools.test.ts` fails when a write tool on a playback-ready provider has no `plan`, no `playback: 'self'` and nothing the derived tier can locate.

## Supported editors

Planned in this order (see the [plan](agent-playback-plan.md)):

| Editor | Playback |
| --- | --- |
| Rich text, chart, paint, diagram | Today, through `presence` / `director`; moves to `playback` in phase 7 |
| Canvas | Phase 1 |
| Vector | Phase 2 |
| Image | Phase 3 |
| Spreadsheet, video, animation, parameters | Phases 4–6 |
