# Agent playback

Agent playback makes an agent's tool calls visible. The agent's cursor glides to what it is working on, presses, drags or types, and each call lands as one undo step. It works the same for every caller: a model connected over MCP (`createMcpServer`, `connectToolBridge`), a scripted run or your own `registry.callTool(...)`.

You enable it once per registry and attach a surface for each editor on screen. You don't write code per tool, and you don't pick DOM targets.

> **Status.** The core, React and Svelte layers ship now, and so does the **canvas**. Other editors keep their calls instant until their phase lands. Chart, paint, diagram and rich text still play through their own `director` / `presence` options. See the [plan](agent-playback-plan.md) for the order.

## Contents

- [Enable playback](#enable-playback)
- [Show the cursor: React](#show-the-cursor-react)
- [Show the cursor: Svelte](#show-the-cursor-svelte)
- [Speed, skip and stop](#speed-skip-and-stop)
- [Headless, servers and tests](#headless-servers-and-tests)
- [Several agents](#several-agents)
- [Editors in tabs or panels](#editors-in-tabs-or-panels)
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
playback.install(registry);  // same as registry.use(playback.middleware), but only once per registry
```

Register tool providers as usual. Playback changes how a call looks on screen, never what it returns. A call returns the same result, or the same error, with or without playback.

## Show the cursor: React

Each editor surface attaches itself under its tool provider's id and draws the cursors with `<PresenceLayer>`. For the node canvas (React Flow):

```tsx
import { useMemo, useRef } from 'react';
import { ReactFlow, useReactFlow, useViewport } from '@xyflow/react';
import { createEditorMcpToolProvider } from '@pixerate/editor/agent';
import { useAgentToolProvider } from '@pixerate/editor-react';
import { useCanvasPlaybackSurface, PresenceLayer } from '@pixerate/editor-react/canvas';

function Board() {
  const flow = useReactFlow();
  const viewport = useViewport();
  const container = useRef<HTMLDivElement>(null);

  const provider = useMemo(() => createEditorMcpToolProvider({ id: 'canvas', getSnapshot, applySteps }), []);
  useAgentToolProvider(registry, provider, { playback });   // also installs the playback on the registry

  // Attach the canvas under the provider's id ('canvas').
  const presence = useCanvasPlaybackSurface(playback, 'canvas', {
    getNodes: flow.getNodes,
    getEdges: flow.getEdges,
    viewport,
    container,
  });

  return (
    <div ref={container} style={{ position: 'relative', height: 520 }}>
      <ReactFlow … />
      <PresenceLayer presence={presence} viewport={viewport} />
    </div>
  );
}
```

`<AgentPlaybackProvider playback={playback}>` makes a playback the default for every surface below it. Surfaces then take `undefined` for the playback argument and use the context.

Arrange commands registered with `createArrangeCommands` (`canvas.alignLeft`, …) play on the same surface. A command plays on the surface named by its `scope`, or by its id prefix (`canvas.`).

Another provider that acts on the same canvas plays there if it names the surface. Spread the provider and add `playbackSurface: 'canvas'`, as with `createCanvasComponentToolProvider`. Providers whose namespace is the surface id (`canvas`) find it on their own.

**A custom surface** (your own component) uses `usePlaybackSurface(playback, id, options)` and renders `<PresenceLayer presence={…} />` inside it. All options are optional:

| Option | Does |
| --- | --- |
| `locate(ref)` | Returns a rectangle in your surface's coordinates for `{ kind, id }` |
| `bounds()` | Where a cursor enters the surface |
| `visible()` | Whether the surface is on screen. Hidden surfaces run calls instantly |
| `toViewport` / `fromViewport` | Map to and from client pixels, so the cursor can move between surfaces |
| `defaultKind` | The kind of a bare `id` / `ids` argument |
| `reveal()` | Bring the surface on screen before playing |
| `beginGesture` / `endGesture` | Group a call's changes into one undo step |

## Show the cursor: Svelte

```svelte
<script lang="ts">
  import { useSvelteFlow } from '@xyflow/svelte';
  import { useAgentToolProvider } from '@pixerate/editor-svelte';
  import { createCanvasPlaybackSurface, PresenceLayer } from '@pixerate/editor-svelte/canvas';

  const flow = useSvelteFlow();
  let container: HTMLDivElement | undefined = $state();

  useAgentToolProvider(() => registry, () => provider, { playback: () => playback });
  const presence = createCanvasPlaybackSurface(playback, 'canvas', {
    getNodes: () => nodes,
    getEdges: () => edges,
    getViewport: flow.getViewport,
    container: () => container,
  });
</script>

<div bind:this={container} style="position: relative; height: 520px;">
  <SvelteFlow bind:nodes bind:edges … />
  <PresenceLayer {presence} viewport={flow.getViewport()} />
</div>
```

- `setAgentPlayback(playback)` (and `getAgentPlayback()`) is the context equivalent.
- `createPlaybackSurface(playback, id, options)` builds a custom surface and takes the same options as React.
- React and Svelte draw the same cursor.
- The layer has the `.pixerate-presence` class, so snapshots, `view_editor` and `capture_view` leave it out.

## Speed, skip and stop

```ts
playback.speed = 2;          // takes effect on the next step
playback.speed = Infinity;   // "Skip": no animation from now on; calls run instantly
playback.stop();             // finish the running performances at once (the calls still run)
playback.say('Checking the layout…');   // a note in the cursor's bubble on its current surface
playback.active;             // a performance is playing; playback.subscribe(fn) tells you when it changes
```

Each tool call is one undo step, so the user can undo an agent call by call. If the user drags something while the agent is acting, both edits apply, but the agent's call may split into two undo steps. To prevent that, set the editor read-only while `playback.active` is true.

## Headless, servers and tests

Playback only animates when a surface for the called provider is attached and visible. Calls run instantly, with identical results, in these cases:

- no surface is attached (Node, an MCP server with no UI, workers);
- the surface is hidden and has no `reveal` (see below);
- `speed` is `Infinity`;
- the browser tab is in the background. The canvas surfaces report themselves hidden then, and waits are timed by the clock, never by animation frames, so a call never stalls.

In tests, use the instant clock to run full performances in virtual time and check what was played:

```ts
import { createAgentPlayback, createInstantPresenceClock, PresenceStore } from '@pixerate/editor/tools';
import { createCanvasPlaybackLocator } from '@pixerate/editor/canvas';

const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
playback.install(registry);
playback.attach('canvas', { presence: new PresenceStore(), defaultKind: 'node', locate: createCanvasPlaybackLocator({ getNodes: () => nodes }) });

const played = playback.record();              // every step played from now on
await registry.callTool('canvas__canvas_select', { nodeIds: ['a'] });
expect(played.map((r) => r.step.type)).toEqual(['move', 'focus', 'press', 'release', 'commit']);
```

## Several agents

Each caller can have its own cursor and queue. `createMcpServer` names the actor after the client's `clientInfo`. In your own calls, pass it yourself:

```ts
await registry.callTool('commands__run_command', args, { actor: { id: 'reviewer', name: 'Reviewer' } });
```

One actor's calls play one after another. Different actors play side by side, in their own colours.

## Editors in tabs or panels

If the agent calls a tool for an editor that is attached but not visible, playback calls the surface's `reveal()` before playing. Pass one that switches to the editor:

```tsx
useCanvasPlaybackSurface(playback, 'canvas', { …, reveal: () => setTab('canvas') });
```

Without `reveal`, a hidden editor's calls run instantly.

## For tool authors: how a call is played

Every call plays at the richest tier the tool supports:

| Tier | You provide | What plays |
| --- | --- | --- |
| Director | `playback: 'self'` on the tool, and the handler drives a director | Live drags, strokes, typing (chart, paint, diagram, rich text) |
| Plan | `plan(args, state)` on the tool, or `plan(context, params)` on a `CommandSpec` | Exactly the steps you return |
| Derived | nothing | Glide to the ids in the args, press, run; then a ring on new ids in the result |
| Instant | (no surface attached, or `playback: false`) | The handler runs unchanged |

### Get the derived tier for free

Use the conventional argument and result names. Playback finds targets by reading them:

- **Arguments**, also inside a command's `params`:
  - `id` / `ids`, which take the surface's `defaultKind`;
  - `nodeId(s)`, `edgeId(s)`, `layerId(s)`, `clipId(s)`, `trackId(s)`, `seriesId`, `parameterId`, `keyframeId`, `shapeId`;
  - `range` / `cell` (A1), which become kind `cell`.
- **Results:** `id`, `ids`, `node.id`, `created` (a list, or `{ nodes, edges }`), and the same inside a command's `result`.

Then make sure the surface's `locate` can find those refs.

Playback picks the surface in this order:

1. the plan's `surface`;
2. the provider's `playbackSurface`;
3. the provider's id;
4. the provider's namespace.

For commands it uses `CommandSpec.playbackSurface`, else the command's `scope`, else its id prefix.

### Add a planner

A planner is a pure function. It gets the validated arguments and the state before the call, and returns steps in surface coordinates (the editor's own document or canvas units, never screen pixels):

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

A tool's `plan(args, state)` gets `state.locate(ref)` (the provider's surface) and `state.surfaceId`. A plan can also return `{ steps, surface, readOnly }` to play on another surface, or to be treated as a read.

The steps are:

| Step | Does |
| --- | --- |
| `move { to, ms? }` | Glide the cursor to a point |
| `target { ref, ms? }` | Glide to whatever `ref` locates and ring it (`{ kind: 'node', id }`, `{ kind: 'cell', id: 'B2:C4' }`, `{ kind: 'control', id: 'title' }`); skipped when nothing is found |
| `focus { rect }` | Draw a highlight ring around a rectangle (`null` clears it) |
| `press` / `release` | Press or release the cursor's button |
| `drag { to, ms? }` | Move with the button down (cursor only; the change applies at `commit`) |
| `type { text, ms? }` | Type text out in the cursor's bubble |
| `say { text, ms? }` | Show a note in the cursor's bubble |
| `wait { ms }` | Pause |
| `commit` | Run the handler. It runs exactly once and is appended if you leave it out. Steps after it play once the change is applied |

Rules for planners:

- **Pure.** Read state, never change it. The same arguments and state give the same steps.
- **Pre-call state.** Ids the call will create don't exist yet. Plan toward the position where the change will land; the derived post-roll rings new ids from the result. `planCanvasToolPlayback` shows the pattern: the canvas planner already knows where a new node goes.
- **Live state for the post-roll.** The post-roll locates new ids right after the handler returns. Make `locate` read a copy you update synchronously, not state that renders later.
- **Never block a call.** If a planner throws or returns nothing, the call falls back to the derived tier.
- **Durations are optional.** Leave `ms` out and the cursor moves at the shared natural pace, scaled by `speed`.
- **Live previews need a director.** If the change should update step by step as the cursor moves (a value following a drag, paint landing along a stroke), write a director and mark the tool `playback: 'self'`. Use `PresenceStore`, `PerformanceQueue` and `tweenPresenceCursor` from `@pixerate/editor/tools`.

### Test it

Call the tool through `ToolRegistry.callTool` with `createInstantPresenceClock()` and a surface (a `PresenceStore` and a `locate`), as in [Headless, servers and tests](#headless-servers-and-tests). Assert two things:

- `playback.record()` holds the steps you planned.
- The result matches a call made at `speed: Infinity`.

`packages/core/tests/agent-playback.test.ts` and `canvas-playback.test.ts` are worked examples.

## Supported editors

| Editor | Playback |
| --- | --- |
| Canvas: `createEditorMcpToolProvider` (planned moves) and the arrange commands (derived) | Now |
| Rich text, chart, paint, diagram | Today through their own `presence` / `director`; they move onto playback later |
| Vector | Next |
| Image | After vector |
| Spreadsheet, video, animation, parameters | Later phases |
