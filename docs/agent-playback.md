# Agent playback

Agent playback makes an agent's tool calls visible. The agent's cursor glides to what it is working on, presses, drags or types, and each call lands as one undo step. It works the same for every caller: a model connected over MCP (`createMcpServer`, `connectToolBridge`), a scripted run or your own `registry.callTool(...)`.

You enable it once per registry and attach a surface for each editor on screen. You don't write code per tool, and you don't pick DOM targets.

> **Status.** Every editor plays: canvas, vector, image, spreadsheet, video, animation, parameters, chart and paint through `playback`. Diagram and rich text keep their own director and inline caret. Chart and paint directors share the playback cursor. See the [plan](agent-playback-plan.md).

## Contents

- [Enable playback](#enable-playback)
- [Show the cursor: React](#show-the-cursor-react)
- [Show the cursor: Svelte](#show-the-cursor-svelte)
- [Speed, skip and stop](#speed-skip-and-stop)
- [Headless, servers and tests](#headless-servers-and-tests)
- [Several agents](#several-agents)
- [Editors in tabs or panels](#editors-in-tabs-or-panels)
- [Agent notes: `playback__say` (optional)](#agent-notes-playback__say-optional)
- [Scripted agent turns](#scripted-agent-turns)
- [For tool authors: how a call is played](#for-tool-authors-how-a-call-is-played)
- [Supported editors](#supported-editors)

## Enable playback

```ts
import { createToolRegistry, createAgentPlayback } from '@pixerate/editor/tools';

const registry = createToolRegistry();
const playback = createAgentPlayback({
  speed: 1,                 // 1 = natural pace, 2 = twice as fast, Infinity = no animation
  reads: 'skip',            // read-only tools: 'skip' (default: only changes play), 'glance' (move only) or 'play'
  linger: 1500,             // ms the cursor stays after the agent's last call (0 keeps it)
  actor: { id: 'agent', name: 'Agent', color: '#7c3aed' },
});
playback.install(registry);  // same as registry.use(playback.middleware), but only once per registry
```

Register tool providers as usual. Playback changes how a call looks on screen, never what it returns. A call returns the same result, or the same error, with or without playback.

Playback is always explicit: an editor plays only when you give it a `playback` object (as a prop, or through the playback context). Giving an editor a registry alone never turns it on.

By default only changes play. Read-only tools (`readOnlyHint: true`) return at once without moving the cursor, so a model that reads a lot doesn't keep the user waiting. Demos and tours that want reads to show can pass `reads: 'glance'` (a quick move to the target, no press, no undo step) or `reads: 'play'`.

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

**App chrome over the canvas.** The canvas finds nodes and edges from the flow's geometry. A tool whose plan names something else, such as `{ kind: 'panel' | 'control', id }` for your own HUD, toolbar or side panels, is located through options you add:

```tsx
const presence = useCanvasPlaybackSurface(playback, 'canvas', {
  getNodes: flow.getNodes, getEdges: flow.getEdges, viewport, container,
  // An element anywhere on the page; its client box is mapped into flow coordinates.
  locateElement: (ref) => document.querySelector(`[data-hud="${CSS.escape(ref.id)}"]`),
  // Or a rectangle already in flow coordinates (tried first).
  locate: (ref) => null,
  // Show a panel for an `open` step. Without it, open steps are skipped.
  open: (ref) => setPanel(ref.id),
});
```

The canvas locator runs first; `locate`, then `locateElement`, answer what it does not find. The same three options (`PlaybackChromeOptions` in `@pixerate/editor/tools`) work on `useElementPlaybackSurface` / `createElementPlaybackSurface`, whose `selectors` are now optional, and on the Svelte `createCanvasPlaybackSurface`. `playbackRectFromClient(rect, fromViewport)` and `locatePlaybackChrome(ref, chrome, fromViewport)` do the mapping for a surface of your own.

Arrange commands registered with `createArrangeCommands` (`canvas.alignLeft`, …) play on the same surface. A command plays on the surface named by its `scope`, or by its id prefix (`canvas.`).

Another provider that acts on the same canvas plays there if it names the surface. Spread the provider and add `playbackSurface: 'canvas'`, as with `createCanvasComponentToolProvider`. Providers whose namespace is the surface id (`canvas`) find it on their own.

**The vector editor** draws the cursor itself. Pass `playback` to `<VectorCanvas>` (or through `<VectorEditor canvasProps={{ playback }}>`), or put it in an `AgentPlaybackProvider`. Register the vector commands with `createVectorCommands` and `createCommandToolProvider` as usual; they play on the `vector` surface, whatever their prefix:

```tsx
<VectorEditor controller={controller} canvasProps={{ playback, onPlaybackReveal: () => setTab('vector') }} />
```

The cursor drags new shapes out corner to corner, traces paths, clicks text in and types it, and visits the nodes that commands with `ids` name. Pass `playback={null}` to turn it off under a provider; `playbackId` changes the surface id (default `vector`).

**The image editor** works the same way. Pass `playback` to `<ImageEditor>`, or put it in an `AgentPlaybackProvider`; the image tool providers play on the `image` surface:

```tsx
<ImageEditor editor={editor} playback={playback} onPlaybackReveal={() => setTab('image')} />
```

Before each write the cursor opens the panel the tool belongs to, by clicking its tab as a user would: Adjustments, Layers, Paint, Select & Mask, Annotations, or Transform & Crop. Then it acts:

- strokes (`points`) are traced;
- boxes (`x, y, width, height`, or a `shape`) are dragged out;
- positions are clicked;
- `set_adjustments` visits the sliders it moves;
- other calls visit the layers they name.

Surface coordinates are document pixels. The editor's own tabs, sliders and layer rows are located too, through `{ kind: 'panel' | 'control' | 'layer', id }` refs.

**Spreadsheet, video, animation and parameters** work the same way. Each component takes `playback`, `playbackId` and a reveal callback:
- `<SpreadsheetEditor>` attaches as `spreadsheet` and finds cells by `td[data-row][data-col]`.
- `<VideoTimeline>` / `<VideoEditor>` attach as `video` and map times through their zoom.
- `<AnimationEditor>` attaches as `animation` and finds shots in the timeline and elements on the stage.
- `<ParametersPanel>` attaches as `parameters` and finds controls by `data-parameter-id`.

Their plans name only cells, clips, tracks, times, shots, elements and controls, so the component decides where those are on screen.

**A plain DOM component** of your own can use `useElementPlaybackSurface(playback, id, elementRef, { defaultKind, selectors: { kind: (id) => cssSelector } })` (Svelte: `createElementPlaybackSurface`). Coordinates are the element's pixels, and refs are found by CSS selector.

**Editors with a director (chart, paint)** share one cursor between the director and playback. Pass the director's presence and `playback` to the editor, and the director to the tool provider:

```tsx
const { presence, director, sceneRef } = useChartDirector(controller);
useChartToolProvider(registry, controller, { id: 'chart', director });
<ChartEditor controller={controller} canvasProps={{ presence, sceneRef }} playback={playback} />
```

The provider marks the director's tools `playback: 'self'`, so value drags (chart) and strokes, fills and replays (paint) play through the director. Every other call plays on the editor's own controls:
- **Chart:** the inspector options a change sets, the data grid for data edits, the toolbar for rendering and undo.
- **Paint:** the side panel a write belongs to, opened by clicking its tab.

`usePlaybackSurface` / `createPlaybackSurface` take an optional shared presence store for the same purpose in your own components.

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
| `open(ref)` | Show a panel or tab for an `open` step (e.g. click its tab). The attached surface has `open` only when you give one, so without it `open` steps are skipped instead of waiting |

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
- `<VectorCanvas playback={playback} onplaybackreveal={…} />` plays the vector commands, and `<ImageEditor playback={playback} />` the image tools, as in React.
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

## Agent notes: `playback__say` (optional)

An agent can put a short note in its cursor's bubble with the `say` tool. It is strictly optional: nothing registers it for you, and nothing breaks without it. It is UI-agnostic: it only writes the note to the playback's presence store, which whatever presence layer you draw (the packaged one or your own) shows.

```ts
import { createPlaybackToolProvider } from '@pixerate/editor/tools';

registry.register(createPlaybackToolProvider(playback));   // adds playback__say
```

`say { text }` shows `text` (at most 200 characters) beside the calling actor's cursor on the editor it last worked on, until its next call. It returns `{ shown, surface }`. When the actor has no cursor on screen (a headless server, or before its first write) it shows nothing and returns `{ shown: false, surface: null }`, which is not an error. It changes no document and is never played itself. Register it only where a UI shows the cursors, so models without one don't see a tool they can't use. From your own code, `playback.say(text, { actor })` does the same.

## Scripted agent turns

`runToolScript` (in `@pixerate/editor/tools`) plays a list of notes and tool calls at reading speed. Use it for tours, demos and end-to-end tests of a skill.
- Later steps can build their arguments from earlier results.
- With `playback`, each note shows in the cursor's bubble.
- Steps have no cursor targets: each tool's own playback decides where the cursor goes.

```ts
import { runToolScript } from '@pixerate/editor/tools';

const control = { speed: 1, stopped: false };   // set speed = Infinity to skip, stopped = true to stop
await runToolScript(registry, {
  id: 'align',
  prompt: 'Line up the main workflow steps',
  steps: [
    { say: 'Reading the board.', tool: 'canvas__get_editor_state', args: { includeDocument: false }, as: 'state' },
    { say: 'Centring the main path.', tool: 'commands__run_command', args: (ctx) => ({ id: 'canvas.alignMiddle', params: { ids: ctx.results.state.canvas.nodes.map((n) => n.id) } }) },
  ],
}, { playback, actor: { id: 'tour', name: 'Tour' }, control, onEvent: (e) => console.log(e) });
```

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
| `open { ref, ms? }` | Open a part of the editor (a panel or tab): glide to what `ref` locates, click it, and let the surface's `open(ref)` show it; skipped when the surface has no `open` |
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
| Chart: `createChartToolProvider` (`<ChartEditor playback>`; with a director, value drags and selections play through it, sharing the cursor; other changes are clicked on the inspector, data grid or toolbar) | Now |
| Paint: both paint tool providers (`<PaintEditor playback>`; with a director, strokes, fills and replays paint live; other writes open their panel and point at the control) | Now |
| Rich text and diagram | Their own inline caret (`presence`) and `DiagramDirector`, as before; `insert_chart` now shows the caret where the chart goes in |
| Vector: every `vector.*` command (`<VectorCanvas playback>`; shapes, paths, text, symbols, images, text ranges and mesh points planned; the rest derived from `ids`) | Now |
| Image: `createImageEditorToolProvider` and `createImageEffectsToolProvider` (`<ImageEditor playback>`; opens each tool's panel, traces strokes, drags boxes, visits layers and sliders) | Now |
| Spreadsheet, video, animation, parameters (`<SpreadsheetEditor>`, `<VideoTimeline>`, `<AnimationEditor>`, `<ParametersPanel>` take `playback`) | Now |
