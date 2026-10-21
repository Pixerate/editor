# Agent playback in the library: design plan

Status: **phases 0 to 6 (foundation, canvas, vector, image, spreadsheet, video, animation, parameters) are implemented**. Phases 7 (fold in the directors) and 8 (demo clean-up) remain. Consumer guide: [agent-playback.md](agent-playback.md).

As built, phases 0 to 6 differ from the proposal below in a few places:

- **Spreadsheet, video, animation, parameters.**
  - Plans name only layout-free refs: cells, rows and columns (`B7`, `5:6`, `C:D`); clips, tracks and times (`t=1200;track=v1`); shots and stage elements; controls. Each component locates them in its own pixels.
  - Plain DOM panels use `useElementPlaybackSurface` / `createElementPlaybackSurface`, driven by CSS selectors per ref kind.

- **Image.**
  - A generic `open` step and `PlaybackSurface.open` let a tool's plan open the panel it belongs to. This replaces the demo's `open:` steps, since the library owns those tabs.
  - `withImagePlayback` plans every image tool by its argument shape rather than tool by tool.
  - `<ImageEditor playback>` locates its own tabs, sliders (`data-control-id`) and layer rows (`data-layer-id`) in document pixels.

- **Vector.**
  - `<VectorCanvas>` (React and Svelte) takes a `playback` prop and draws the cursor itself, in a `foreignObject` over the canvas.
  - `withVectorPlayback` adds the plans inside `createVectorCommands`, so they need no consumer code.
  - The demo's vector scripts have no `target` fields, and `artboardBox` is gone.

- **Canvas arrange.** There is no new `createCanvasArrangeToolProvider`. The arrange commands (`createArrangeCommands`) already take `ids`, so they play through the command tools on the `canvas` surface, picked from the id prefix. The demo's hand-written `list_nodes` / `align_nodes` tools were replaced by `createEditorMcpToolProvider` and those commands.
- **No `playback` prop yet.** Editor components don't take one. Surfaces attach through hooks: `usePlaybackSurface` / `useCanvasPlaybackSurface` in React, `createPlaybackSurface` / `createCanvasPlaybackSurface` in Svelte. The canvas is rendered by the consumer's own React Flow / Svelte Flow anyway.
- **Not done yet.** The motion helpers in `canvas/agent-presence.ts` are not used yet: playback glides along the demo's arc. `AgentCursorPresence.svelte` is not ported. `AgentPresence` and the two `AgentPresenceLayer`s are only marked deprecated.
- **Phase 8 work still pending.** `runToolScript` hasn't moved to core. The demo panel calls `demoPlayback.say` for notes and maps Skip and Stop onto `playback.speed` / `stop()`.
- **Other canvas providers.** The component, effects and capture providers play on the canvas only when they name it with `playbackSurface` or use the `canvas` namespace. Capture does; the demo's effects tools (`canvasfx`) don't yet.

## Goal

Every agent tool call that changes an editor plays out on screen: the agent's cursor glides to what it works on, presses, drags or types, and the change lands as one undo step. This holds for any caller: the demo's scripted agents, a real MCP client through `createMcpServer` or `connectToolBridge`, and `ToolRegistry.callTool` from app code. A consumer opts in once per registry and mounts the editors' surfaces as usual. They write no per-tool code and no DOM targets. With no surface on screen (headless, MCP in Node, tests), the same calls run instantly and return the same results.

## Where we are

| Domain | How calls play today | Cursor drawn by |
| --- | --- | --- |
| Rich text (doc, prompt) | `createRichTextToolProvider({ presence })`: inline caret, typed replacements | the editor itself |
| Chart | `ChartDirector` + `planChartCommand` (pure), passed as `director` to the tool provider | `ChartCanvas` / `ChartPresenceLayer.svelte` |
| Paint | `PaintDirector` (live strokes, fills rubbed in) | `PaintCanvas` / `PaintPresenceLayer.svelte` |
| Diagram | `DiagramDirector` + `planDiagramEdit` (pure), draft playback of whole sources | `DiagramPresenceLayer` (React + Svelte) |
| Vector, image, video, animation, spreadsheet, parameters, canvas | Not at all. The demo's `AgentScriptPanel` glides a DOM cursor to each step's hand-written `target` | demo only |

The shared parts are in `packages/core/src/animation/presence.ts`: `PresenceStore`, `PresenceClock`, `createInstantPresenceClock`, `tweenPresenceCursor` and `PerformanceQueue`, which runs one call per actor at a time as one gesture.

`apps/demo/src/agentScripts.ts` has 97 `target:` fields. About half are vector, with `[data-vector-id]` selectors and `artboardBox(x, y, w, h)`, which converts document coordinates to viewport coordinates. Most of the rest are video, paint (setup steps outside the director), chart (inspector controls) and spreadsheet (text like "Fay"). Almost every target falls into one of three kinds:

1. **An id in the args or the result**, found through a data attribute that already exists (`data-vector-id`, `data-layer-id`, `data-clip-id`, `data-cell`, `data-parameter-id`, `data-keyframe`, `data-series-id`).
2. **A rectangle in document coordinates** taken from the args (`vector.addShape { x, y, width, height }`). `artboardBox` is a hand-written planner for exactly this.
3. **A control in the editor's own chrome** (a chart inspector option, the PNG download button). The library renders these controls, so it can locate them too.

Only a few targets point at the consumer's own UI (the demo's tabs, via `open`). Those stay with the consumer (see "Surfaces the library can't see").

Two details change the design:

- Vector, chart and parameters commands reach agents through `createCommandToolProvider`, so the tool name is `run_command` or `run_commands` and the operation is `args.id`. Planning has to work per command, not only per tool.
- Canvas already has two older cursor models (see the next section). The plan merges both into `PresenceStore`.

### Canvas today (the first domain)

Canvas has more cursor code than any domain without a director, but none of it is connected to tool calls:

| Piece | Where | State |
| --- | --- | --- |
| `AgentPresence` type (`cursorPosition`, `selectedNodeIds`, `statusMessage`, `note`) | `core/src/agent/types.ts` | Only consumed by the React layer below |
| `AgentPresenceLayer` (takes a `presences[]` prop) | `react/src/canvas/AgentPresenceLayer.tsx`, `svelte/src/canvas/AgentPresenceLayer.svelte` | Exported, but nothing in the packages or the demo renders it. Only the parity matrix mentions it. Positions are raw pixels, with no flow-to-screen mapping. |
| `CanvasAgentCursor` plus motion math: `calculateCurvedPath`, `getNaturalMovementTiming`, `getCursorTransitionDuration`, `getAgentCardAnchor` (header, action, body and footer anchors on a card) | `core/src/canvas/agent-presence.ts` | Pure and reusable |
| `AgentCursorPresence` (takes `flowToScreenPosition`) | `svelte/src/canvas/AgentCursorPresence.svelte` | Svelte only: **no React twin**, so parity is already broken. Not fed by any tool. |
| `planAgentCommand` / `planToolCall` | `core/src/agent/planner.ts` | Plans *model* steps (`step:canvas_add_node` with a computed position, edges, layout), but no cursor steps |

The canvas tools reach agents through four providers, none of which plays:

- `createEditorMcpToolProvider` (`canvas_add_node`, `canvas_connect`, `canvas_update_node`, `canvas_remove_nodes`, `canvas_layout`, `canvas_select`, `canvas_highlight`). Edits go through the planner and the consumer's `applySteps`.
- `createCanvasComponentToolProvider`.
- `createCanvasEffectsToolProvider`.
- `createCanvasCaptureToolProvider`.

The arrange commands (`canvas.alignLeft` and the rest, in `commands/builtins.ts`) exist, but the demo's canvas tab defines its own `list_nodes` and `align_nodes` tools in `CanvasTab.tsx`. Its only script, `canvas-align`, targets `.react-flow__node[data-id="research"]` by hand. So the canvas problem is less about deleting targets and more that **no canvas call plays at all**, with three half-finished cursors to choose from.

Two things make canvas a good first domain:

- The planner already knows the outcome before the call runs: where a new node will go, and which nodes a layout moves. Tier 2 plans can point the cursor at the new node's position before it exists, with no post-roll guesswork.
- xyflow gives a reliable geometry source. Node position and measured size come from the flow store, so `locate` can work without querying the DOM. A `ViewportPortal` (React Flow and Svelte Flow) draws the layer in flow coordinates, so zoom and pan come for free.

## Design

### Layers at a glance

```
ToolRegistry ──middleware──▶ AgentPlayback (controller, dependency-free)
                               │  per call: resolve surface → plan steps → perform → run handler → point at result
                               ├─ surfaces: Map<providerId | surfaceId, PlaybackSurface>   (registered by React/Svelte)
                               ├─ PerformanceQueue per actor (one gesture = one undo step)
                               └─ PresenceStore per surface  ──▶  <PresenceLayer> (React) / <PresenceLayer> (Svelte)
Tool / CommandSpec
  ├─ playback?: 'self'            (directors: chart, paint, diagram, rich text keep acting themselves)
  ├─ plan?(args, state) → steps   (pure, surface coordinates; tier 2)
  └─ (nothing)                    → generic locator over args + result ids (tier 1)
```

### 1. The tool-level hook: `plan`, plus a generic fallback

Each call plays at the richest tier available:

| Tier | Who provides it | What plays |
| --- | --- | --- |
| 3. Director (`playback: 'self'`) | chart, paint, diagram, rich text (exists today) | The handler acts itself: live drags, strokes, typing |
| 2. `plan(args, state)` | the tool or `CommandSpec` | Steps such as "rubber-band a rectangle from (x, y) to (x+w, y+h), then commit" |
| 1. Generic locator | nobody: derived from args and result | Glide to the targets in the args, press, run, then a short highlight ring on what the result created or changed |
| 0. Instant | no surface attached | The handler runs unchanged |

**Step vocabulary.** The step types of `ChartPerformanceStep`, `DiagramPerformanceStep` and the paint steps merge into one data-only union in the tool layer:

```ts
type PlaybackStep =
  | { type: 'move'; to: Point; ms?: number }          // surface coordinates
  | { type: 'focus'; rect: Rect | null }               // highlight ring around the target
  | { type: 'say'; text: string; ms?: number }
  | { type: 'press' } | { type: 'release' }
  | { type: 'drag'; to: Point; ms?: number }           // cursor only; live value changes stay in directors
  | { type: 'type'; text: string; ms?: number }        // a typing bubble over the target
  | { type: 'target'; ref: PlaybackRef }               // "go to whatever this ref is" (resolved by the surface)
  | { type: 'commit' };                                // the handler runs here (exactly once; appended if missing)

type PlaybackRef = { kind: string; id: string } | { kind: 'control'; name: string } | { kind: 'cell'; ref: string };
```

Durations are optional. The controller fills them from distance and speed, using the arc and timing of `AgentScriptPanel.glideTo` so every surface moves the same way.

**`plan` contract.**

```ts
interface AgentTool { /* … */ playback?: 'self' | false; plan?: (args, state: PlaybackPlanState) => PlaybackStep[] }
interface CommandSpec { /* … */ plan?: (context, params) => PlaybackStep[] }
```

- It is pure. It reads state through its `context` or `state` argument and never mutates. This is what makes `planChartCommand` and `planDiagramEdit` easy to test.
- It runs after argument validation and before the handler, so it sees the state before the call. New ids are unknown at that point. The post-roll (below) points at those.
- If it throws or returns nothing, the call falls back to tier 1. A broken plan never blocks a tool call.
- `createCommandToolProvider` sets the `plan` of `run_command` to dispatch on `args.id`. For `run_commands` it plans each step in turn and runs them as one gesture, which keeps one undo step per tool call. `$N.path` refs to earlier results are resolved before each step plans.

**Generic fallback (tier 1).** The tool layer reads these from args by convention: `id`, `ids[]`, `layerId`, `clipId`, `trackId`, `nodeId`, `seriesId`, `range` / `cell` (A1 refs) and `parameterId`. From the result it reads `id`, `ids`, `created[].id` and `structuredContent.result.id` (command results). The surface's `locate(ref)` resolves each ref. By default `locate` finds `[data-<kind>-id="<id>"]` inside the surface root, with `kind` taken from the argument name (`layerId` → `layer`, `ids` → the surface's `defaultKind`). Surfaces can override it, for example the spreadsheet maps `B7:G7` to the union of cell rectangles.

The tier 1 sequence: glide to the first arg target, focus its rectangle, press, release, commit. Then, if the result names ids that weren't in the args, a short ring on them (the **post-roll**). That alone covers most of today's `[data-vector-id]` and layer, clip and cell targets with no per-tool code.

**Reads.** Read-only tools (`readOnlyHint: true`) default to `reads: 'glance'`: a quick move to their target, with no press and no undo gesture. Tools with no target don't move the cursor. `reads: 'skip'` turns this off, which suits chatty MCP agents. `reads: 'play'` plays reads like writes, as the demo does today.

### 2. Registry-level option: `AgentPlayback` middleware

`ToolRegistry` gains one generic extension point that knows nothing about playback:

```ts
type ToolMiddleware = (call: { name; tool: AgentTool; args; context: ToolCallContext }, next: () => Promise<unknown>) => Promise<unknown>;
registry.use(middleware): () => void;      // or ToolRegistryOptions.middleware
```

It runs after validation and prototype-key stripping, and inside the existing try/catch, so errors still become `isError` results. `ToolRegistryView`, `createMcpServer` and `connectToolBridge` all call `registry.callTool`, so MCP clients get playback for free.

The controller:

```ts
const playback = createAgentPlayback({ clock?, speed?: 1, linger?: 1500, reads?: 'glance', actor?: { id, name, color } });
registry.use(playback.middleware);
playback.attach(providerIdOrSurfaceId, surface): () => void;    // called by the UI packages
playback.say(text, { actor? })                                    // a bubble on the actor's current surface
playback.speed = Infinity; playback.stop();                       // skip / stop, as the demo panel does
playback.textPresence(): RichTextAgentPresence                    // speed and colour for the text tools
playback.active: boolean; playback.record(): PlaybackStep[]        // a performance is running; collect played steps (tests)
```

Per call, the middleware does this:

1. Find the surface: the one attached under the call's `providerId`, or one the provider names with a `surface` field (several providers can share a surface, for example the vector command provider and the vector tools). If there is none, if the surface reports `visible() === false`, or if `speed === Infinity`, it calls `next()` straight away: **tier 0**.
2. If the tool is `playback: 'self'`, it calls `next()` inside the actor's queue slot only, so directors keep their own gesture.
3. Otherwise it runs `PerformanceQueue.run(actor, …)`: plan (tier 2) or derive (tier 1), perform the steps up to `commit`, call `next()` at `commit`, run the post-roll, then release.
4. If the handler throws, the cursor shows a short "✗ message" bubble and the error propagates unchanged. The tool result is identical with or without playback.

**Actors.** `ToolCallContext` gains an optional `actor` (`callTool(name, args, { actor })`). `createMcpServer` fills it from the MCP `clientInfo.name`, so two connected agents get two cursors and two queues, as `PerformanceQueue` already supports. `signal` aborts the performance between steps.

**Timing.** Waits always go through `PresenceClock`, which uses `setTimeout` and never only `requestAnimationFrame`. A hidden tab must never stall a tool call (GOTCHAS: "An Agent Cursor Animated With requestAnimationFrame Hangs in a Hidden Tab"). In tests, `createInstantPresenceClock()` runs a full performance synchronously in virtual time, and the test asserts the recorded steps.

**Dependency-free.** `animation/presence.ts` imports nothing. It moves to `packages/core/src/tools/presence.ts`, and `animation/presence.ts` re-exports it so the chart, paint and diagram imports keep working. The step types, the generic locator conventions, `createAgentPlayback` and `ToolMiddleware` also live in `src/tools`. None of them touch TipTap, ProseMirror, dagre or the DOM. DOM `locate` defaults live in the UI packages or behind an injected `root.querySelector`. `tests/entry-isolation.test.ts` keeps passing as written and gets one extra assertion that `tools/index.js` exports `createAgentPlayback`.

### 3. Surfaces: React and Svelte parity

```ts
interface PlaybackSurface {
  presence: PresenceStore;                        // the layer draws this
  locate(ref: PlaybackRef): Rect | null;          // surface coordinates
  bounds(): Rect;                                 // for clamping and entry points
  visible?(): boolean;
  toViewport?(p: Point): Point; fromViewport?(p: Point): Point;   // cursor hand-off between surfaces
  beginGesture?(key: string): void; endGesture?(): void;
  reveal?(): Promise<void>;                       // consumer hook: switch to my tab or panel first
}
```

- **One presence layer per framework.** `PresenceLayer.tsx` and `PresenceLayer.svelte` generalise `DiagramPresenceLayer`, `ChartPresenceLayer.svelte` and `AgentCursorPresence.svelte`: cursor, name tag, bubble, focus ring and `[data-actor]`, in the `.pixerate-presence` class that the export pipelines already strip. `AgentPresenceLayer` and the old `AgentPresence` type become a thin adapter over `PresenceStore`, then get deprecated.
- **Hooks.** React's `usePlaybackSurface(playback, id, options)` and Svelte's `createPlaybackSurface(playback, id, options)` build the `PresenceStore`, the DOM `locate` (`root.querySelector('[data-…-id]')` relative to the root, mapped through the surface's zoom and pan), and `visible` (an `IntersectionObserver` plus `document.hidden`). They attach on mount and detach on unmount, mirroring `useAgentToolProvider`.
- **Opt-in is one prop.** Each editor component (`VectorEditor`, `ImageEditor`, `VideoEditor`, `SpreadsheetGrid`, `AnimationEditor`, `ParametersPanel`, `Canvas`, and the chart, paint and diagram canvases) takes `playback?: AgentPlayback` (React context `<AgentPlaybackProvider>` and Svelte `setContext` as the ambient default). With it, the component registers its surface under its provider's id and renders the layer. Without it, nothing changes.
- **`useAgentToolProvider(registry, provider, { playback })`.** The same hook can attach the provider's surface when the provider exposes `surfaceId`. When a `playback` is passed and the provider is a director-backed one (chart, paint, diagram), the factory option `director` is built from the surface's presence, so consumers stop wiring directors by hand. Passing `director` explicitly keeps working as it does now.
- **Cursor hand-off.** The controller remembers each actor's last viewport point. When the next call lands on another surface, the cursor enters there from that point (through `fromViewport`, clamped to `bounds()`), and the old surface's actor is removed. This replaces the demo's `takeBack` / `handedOff` logic.

**Surfaces the library can't see.** If the surface is mounted but hidden (another tab), the controller calls `surface.reveal?.()` before playing. That hook is the consumer's one line ("switch to the Vector tab"), and it replaces the demo's `open: "Effects"` steps. If there is no `reveal` and the surface isn't visible, the call runs instantly.

### 4. `runAgentScript`: move a slim version to core

Recommended: yes, as `runToolScript(registry, script, { playback?, onEvent?, control? })` in `@pixerate/editor/tools`. It is about 80 dependency-free lines and is useful beyond the demo: onboarding tours, docs, end-to-end tests of a domain's skill, and recorded demos.

- Keep `say`, `tool`, `args` (value or function of `ctx`), `as`, `readingTime`, `resultValue` and `resultError`. `say` calls `playback.say`, so the note shows on the active cursor as well as in `onEvent`.
- Drop `target` and `open`. Playback and `surface.reveal` own those.
- Speed, skip and stop are the controller's `speed` and `stop()`, so a scripted run and a live MCP agent are paced by the same object.
- The transcript UI (`AgentScriptPanel`'s list) stays in the demo for now. A packaged `AgentTranscript` component can be a later, separate proposal.

### 5. Migration order and deleting the demo's `target`s

**Phase 0: foundation (one PR, no domain behaviour change)**
- Publish [agent-playback.md](agent-playback.md) with the API as built, and keep it current in every later phase.
- `ToolMiddleware` / `registry.use`; `tools/presence.ts` (moved, re-exported); `PlaybackStep`, `PlaybackRef` and `createAgentPlayback` with tiers 0 and 1; `ToolCallContext.actor`; `createMcpServer` passing `clientInfo.name`.
- `PresenceLayer` and `usePlaybackSurface` / `createPlaybackSurface` (React and Svelte); `AgentPlaybackProvider`.
- Demo: one `demoPlayback` object, `registry.use(demoPlayback.middleware)`, `?agentSpeed` mapped to `playback.speed`. The demo's DOM cursor keeps running only for steps that still have a `target`.

The order follows the user's priority: **canvas, then vector, then image**. The other domains follow.

**Phase 1: canvas (first domain, the user's priority)**
- Surface: `useCanvasPlaybackSurface` (React) / `createCanvasPlaybackSurface` (Svelte), mounted inside the flow. It draws `PresenceLayer` in a `ViewportPortal` so steps use flow coordinates. `locate({ kind: 'node', id })` reads the node's position and measured size from the flow store, and `locate({ kind: 'edge', id })` reads the edge's midpoint. Card anchors come from `getAgentCardAnchor`. `toViewport` / `fromViewport` use `flowToScreenPosition` / `screenToFlowPosition`.
- Motion: the controller's default glide adopts `calculateCurvedPath` + `getNaturalMovementTiming` from `canvas/agent-presence.ts`, so every domain moves like the canvas cursor was designed to.
- Tier 2 plans on `createEditorMcpToolProvider`, built from `planAgentCommand`'s output, so the cursor goes where the change will land:

  | Tool | Plan |
  | --- | --- |
  | `canvas_add_node` | Click the planned position, type the label, commit |
  | `canvas_connect` | Press on the source, drag to the target, release, type the label |
  | `canvas_update_node` | Click the node's header anchor, type |
  | `canvas_remove_nodes` | Click each node, commit |
  | `canvas_layout` | Commit, then a ring on the moved nodes |
  | `canvas_select` | Shift-click each node |
  | `canvas_highlight` | Point at the nodes |

- Arrange: add a library `createCanvasArrangeToolProvider` (or expose the `builtins` canvas commands through `createCommandToolProvider` with `ids` params), with `align_nodes`, `distribute_nodes` and `list_nodes`. The demo's hand-written tools in `CanvasTab.tsx` go away. That is a new provider, so it also needs skill rows in `pixerate-canvas/SKILL.md` and `agent-skills.test.ts` mapping.
- Tier 1 covers the component, effects and capture providers by node `ids` (capture is read-only, so it glances).
- Consolidation:
  - `AgentPresence` and the two `AgentPresenceLayer`s become a deprecated adapter over `PresenceStore` for one minor release, then go.
  - `AgentCursorPresence.svelte` either becomes the Svelte `PresenceLayer`'s cursor or gets a React twin. Either way the parity gap closes.
  - `CanvasAgentCursor` stays as the motion helpers' input type.
- Delete the `canvas-align` target.

**Phase 2: vector**
- Why vector comes next: about half of all demo targets are vector. `data-vector-id` already exists on every drawn object. Its operations come through `createCommandToolProvider`, so it proves the `CommandSpec.plan` path that chart and parameters reuse. `artboardBox` shows the document-to-surface mapping is one `viewBox` transform. It needs no live-preview machinery, so tiers 1 and 2 are enough.
- Tier 1 covers `setStyle`, `addFill`, `addStroke`, `addFilter`, `makeClippingMask`, `getAppearance` and so on, by locating `ids`.
- Tier 2 `plan` for `addShape` / `addPath` / `addText` / `placeSymbol` (rubber-band or click at the args' rectangle or point, type the text), `setTextStyle` (select the range), and `setMeshPoint` / `setGradient` (drag a handle).
- Delete every `target:` in the vector scripts and the `artboardBox` helper.

**Phase 3: image editor**
- Surface: the image canvas in document pixels, plus the layers panel as a second locate root (`data-layer-id` already exists in React and Svelte `LayersPanel`). `locate({ kind: 'layer' })` gives the layer's bounds on the canvas, or its row when the bounds are empty.
- Tier 1 covers `createImageEditorToolProvider` and `createImageEffectsToolProvider` writes that take a `layerId` or `target`.
- Tier 2 plans:
  - Shape and type layers: rubber-band the args' rectangle, then type.
  - Transforms: drag a corner handle.
  - Adjustments and effects: press the layer row, then `focus` the canvas.
  - Effect controls are `{ kind: 'control' }` refs inside the library's own panels, which replaces the demo's `{ text: "Contrast" }` target.

**Phase 4: spreadsheet.** `locate({ kind: 'cell' })` for A1 refs and ranges, a `type` plan for `set_range` and `set_cell`. Remove the `{ text: "Fay" }` / `"Status"` / `"Total revenue"` targets.

**Phase 5: video editor.** Add `data-clip-id`, `data-track-id` and a playhead control. Clip moves and trims plan a timeline drag from the args' times. Phases 4 and 5 can run in parallel.

**Phase 6: animation editor and parameters.** `data-keyframe`, `data-parameter-id`; slider drags for parameter values.

**Phase 7: fold in the directors.** Chart, paint and diagram tools get `playback: 'self'`, and their factories build the director from the attached surface. Their inspector controls become locatable refs (`{ kind: 'control', name: 'title' }` → `[data-option="title"]`), which removes the chart `inspectorControl` targets. Rich text reads its `presence` defaults from `playback.textPresence()`.

**Phase 8: demo clean-up.** Remove `AgentTarget`, `findTextRect`, `findControl`, `resolveTarget`, `glideTo`, the portal cursor, `presence` / `takeBack` and `stage` from `AgentScriptPanel`, and `target` / `open` from `AgentScriptStep`. Switch the demo to `runToolScript` from core.

**Keeping deletion honest.** Each domain PR deletes that domain's targets in the same change. A demo test (`agentScripts.test.ts`) counts `target` fields per script group. It fails if a migrated group still has any, and the overall count may only go down. A second test runs every migrated script against the demo registry with an instant clock and a fake surface, and asserts that each write step produced at least a `move` or `focus` (no silent tier 0).

### 6. Tests, skills, GOTCHAS and isolation

**Tests (core, through `ToolRegistry.callTool` as AGENTS.md §4.5 asks)**
- Middleware: with no surface, the call is instant and returns the same result byte-for-byte as with playback off. Middleware order and unsubscribe. Errors still return `isError` with the same message, and the cursor shows the error bubble.
- Controller with a fake surface (`locate` stub, instant clock): tier selection (self, plan, derived, instant); `plan` throwing → falls back to tier 1; `commit` runs the handler exactly once; post-roll on new result ids; per-actor ordering and parallel actors; `signal` abort between steps; `speed: Infinity`; `reads` modes; `visible() === false` → instant.
- Per domain: purity tests for every `plan` (same input gives the same steps; state not mutated), as `planChartCommand` and `planDiagramEdit` are tested today, plus one `run_commands` test per domain showing one undo step for the batch.
- Conformance (`tests/command-tools.test.ts`): for providers declared playback-ready, every write tool either has `plan` or `playback: 'self'`, or has args or a result the generic locator can resolve. A tool that would silently play at tier 0 fails the test, with the tool name in the message.
- React and Svelte: `PresenceLayer` renders actors, notes and focus. `usePlaybackSurface` / `createPlaybackSurface` attach and detach on mount and unmount. `locate` maps through zoom and pan.

**Skills (`packages/core/skills`)**
- `pixerate-agent-tools/SKILL.md`: a "Playback" section covering:
  - Calls may be acted out on screen. Results are unchanged.
  - Don't add waits.
  - Prefer ids returned by earlier calls, which also give the best cursor targets.
  - Batch with `run_commands` for one undo step.
- If we ship a `say` tool for real MCP clients to narrate on the cursor (`createPlaybackToolProvider`, a one-tool `playback__say`), it is a new provider. It needs its row in the skill's tool table, `expectedBySkill()` and `FACTORIES` in `tests/agent-skills.test.ts`, and the conformance test. Recommended, but in phase 1, not phase 0, so the foundation PR has no new tools.
- Domain skills don't change their tool tables, since no tool is renamed. Each domain PR rereads its skill's "working method" for advice that assumed instant application (for example "call `list` after each change to see it").

**GOTCHAS.md entries to write as the work lands**
- Plans see the state from before the call. Created ids come from the result's post-roll, never from guessing in `plan`.
- Coordinates: `plan` returns surface (document) coordinates and only the surface maps them to pixels. Re-resolve targets at each step start, because the user may scroll or zoom during a glide.
- A user gesture during an agent performance splits the agent's undo step (the existing chart entry, now general). Same accepted workaround.
- Hidden or background tabs: clock-based waits only (the existing entry, now enforced by `PresenceClock`).
- Presence DOM must keep the `.pixerate-presence` class so snapshots and exports exclude it (the existing entry).
- `run_commands` with `$N` refs plans step by step, after the previous step ran.

**Dependency isolation.** Everything in phase 0 that lives in `src/tools` imports only `src/tools` itself. DOM lookup lives in the UI packages, or receives `root` by injection. Domain `plan`s live next to their commands (`vector/commands.ts` and so on), not in `src/tools`. `entry-isolation.test.ts` needs no change beyond the new export assertion.

## Open questions for review

1. Default `reads`: is `'glance'` right for real MCP agents, or should playback default to writes only and leave `'glance'` to demos?
2. Should playback be on by default when an editor is given a registry, or always need an explicit `playback` object? This plan says explicit.
3. Should the demo transcript become a packaged `AgentTranscript` (React and Svelte) after phase 8, or stay demo-only?
4. Ship `playback__say` for real MCP clients in phase 1 (recommended) or later?

## Recommendation

Start with phase 0, then canvas (phase 1), as two consecutive PRs, then vector and image. Canvas is the domain the user finds most jarring. Its planner already knows where each change lands, and it settles the three competing cursor models before other domains copy one of them. Vector then proves `CommandSpec.plan` and removes about half of the demo's targets. Image reuses the document-pixel surface that vector establishes.

Consumers will read [agent-playback.md](agent-playback.md), which describes this API and is drafted alongside the plan. It is linked from the README's Documentation section. Each phase updates it as the API lands.
