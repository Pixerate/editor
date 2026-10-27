# Canvas Node Explosion, Displacement & Declarative State Architecture: Implementation Plan

Status: **implemented** (see [Implementation status](#implementation-status) for what was built and where it differs from this plan). This plan covers the architectural overhaul of canvas node explosion, spatial displacement calculations, and headless state management across `@pixerate/editor-svelte` and `@pixerate/editor-react`.

---

## 1. Executive Summary & Why

Canvas node explosion—expanding a parent node into a cluster of connected child affordance nodes (e.g. subtasks, checklists, status steppers, metric badges) while displacing surrounding nodes to make room—was introduced in `@pixerate/editor-svelte/canvas` (`createCanvasExplosion`, `calculateDirectionalDisplacement`).

However, real-world downstream integration in applications like **Uchiage** revealed critical architectural friction points:

1. **Dead & Bypassed Calculations**:
   In structured timeline/Gantt views, `calculateDirectionalDisplacement` was invoked, but its output was discarded because the function ignored boundary options like `minY` during vertical displacement and lacked row-indexing constraints. Downstream components were forced to discard the library output and maintain ~40 lines of local math for row bounds and header clearance.

2. **Imperative Graph Mutation vs. Declarative Derivations**:
   The existing `createCanvasExplosion` rune requires a mutable `CanvasGraphTarget` with imperative methods (`setNodes`, `addNodeOrNodes`, `removeNodes`, `createEdge`, `onSave`). In modern reactive applications (such as SvelteKit with Svelte 5 runes `$derived.by` or React reactive flows), the canvas graph is often derived dynamically from domain scheduling models (e.g., CPM critical path schedules, timeline scales, DAG topologies). An imperative manager that mutates node arrays conflicts directly with reactive derivations, forcing downstream developers to hand-roll local state machines (`collapsingTaskId`, timeouts, lifecycle synchronization) and ignore `createCanvasExplosion` entirely.

3. **No Backward Compatibility Burden**:
   Per project directive, we will **not** carry backwards-compatibility shims or deprecated dual-path baggage. We will design the clean, optimal declarative-first architecture directly across the core layout algorithms, headless state management runes/hooks, and canvas exports.

---

## 2. Target Architecture

The modernized canvas explosion architecture separates concerns into three distinct layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Layer 1: Pure Mathematical & Geometric Core           │
│  - calculateDirectionalDisplacement (enforces minY, locked axes, rows) │
│  - computeCanvasExplosionLayout (pure coordinate & child node builder) │
│  - computeNodesBoundingBox                                             │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Layer 2: Headless Declarative State Machine               │
│  - createCanvasExplosionState (Svelte 5 runes: $state, $derived)       │
│  - useCanvasExplosionState (React hook: useState, useCallback)         │
│  - Manages activeId, collapsingId, transition timers, toggle lifecycle │
│  - Zero graph mutation / zero DOM dependency                           │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Layer 3: Integrated Animated Graph Coordinators          │
│  - createCanvasExplosion (Svelte 5 runner for imperative graphs)       │
│  - useCanvasExplosion (React runner for imperative graphs)             │
│  - Composes Layer 1 + Layer 2 for freeform whiteboard/diagram canvases │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Technical Specifications

### Layer 1: Pure Geometric Core (`createCanvasDisplacement.ts`)

#### 1.1 Enhancing `calculateDirectionalDisplacement`
In `packages/svelte/src/canvas/createCanvasDisplacement.ts`:
- **Enforce `minY` Bounds in Vertical Mode**:
  When `direction === 'vertical'`, nodes positioned above the origin node shift upward by `equalDelta`. Currently, `minY` is parsed in `options` but unused. We will enforce that shifted coordinates satisfy:
  $$\text{newY} = \max(\text{minY} + \text{idx} \times \text{rowSpacing}, \text{node.position.y} - \text{equalDelta})$$
  This guarantees that rows near the top of the canvas (such as row 0 and 1 below a pinned timeline header) do not clip into negative coordinates or slide behind pinned UI chrome.
- **Strict Axis Locking**:
  When `direction === 'vertical'`, horizontal coordinates ($X$) are strictly preserved without drift.
  When `direction === 'horizontal'` or `'right'`, vertical coordinates ($Y$) are strictly preserved (unless `spreadSiblingLanes === true`).
- **Row-Aware Mode**:
  Add option `layoutMode: 'freeform' | 'row-lane'`. When in `'row-lane'` mode, displacement computes discrete uniform row spacing deltas, ensuring discrete sibling lanes glide cleanly apart by an exact lane height delta.

```ts
export interface DirectionalDisplacementOptions {
  direction?: 'right' | 'left' | 'up' | 'down' | 'vertical';
  gap?: number;
  spreadSiblingLanes?: boolean;
  siblingTolerance?: number;
  minY?: number;
  maxY?: number;
  layoutMode?: 'freeform' | 'row-lane';
  rowSpacing?: number;
}
```

#### 1.2 Pure Layout Function `computeCanvasExplosionLayout`
Introduce a standalone function that accepts the graph and child node templates, returning calculated positions without mutating any input structures:

```ts
export interface ComputeCanvasExplosionLayoutParams<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  existingNodes: TNode[];
  originNode: TNode;
  childNodes: TNode[];
  childEdges?: TEdge[];
  options?: DirectionalDisplacementOptions;
  getNodesBounds?: (nodes: TNode[]) => Rect;
}

export interface CanvasExplosionLayoutResult<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  displacedPositions: Map<string, XYPosition>;
  childNodes: TNode[];
  childEdges: TEdge[];
  totalDisplacementDelta: number;
}
```

---

### Layer 2: Headless Declarative State Machine

#### 2.1 Svelte 5 Rune: `createCanvasExplosionState`
Implemented in `packages/svelte/src/canvas/createCanvasExplosionState.svelte.ts`:

```ts
export interface CanvasExplosionStateOptions {
  collapseDurationMs?: number; // default: 380ms
  onExplode?: (nodeId: string) => void;
  onCollapse?: (nodeId: string) => void;
}

export interface CanvasExplosionState {
  readonly activeId: string | null;
  readonly collapsingId: string | null;
  readonly isExplodingOrCollapsing: boolean;
  isExploded: (nodeId: string) => boolean;
  isCollapsing: (nodeId: string) => boolean;
  shouldRenderChildren: (nodeId: string) => boolean;
  explode: (nodeId: string) => void;
  collapse: (nodeId?: string) => void;
  toggle: (nodeId: string) => void;
  destroy: () => void;
}
```

**Lifecycle Rules**:
1. When `explode(nodeId)` is called:
   - If another node was active, it transitions immediately or cancels pending collapse timeouts.
   - `activeId` becomes `nodeId`, `collapsingId` becomes `null`.
2. When `collapse(nodeId)` is called:
   - If `nodeId` matches `activeId` (or no `nodeId` is specified), `collapsingId` is set to `activeId`.
   - `activeId` is set to `null`.
   - A timer for `collapseDurationMs` is scheduled. When it fires, `collapsingId` is reset to `null`.
3. `shouldRenderChildren(nodeId)` returns `true` if `activeId === nodeId || collapsingId === nodeId`, enabling graceful CSS/SVG collapse transitions before unmounting.
4. Calling `destroy()` or unmounting clears any active `setTimeout` to prevent dangling references and memory leaks.

#### 2.2 React Parity Hook: `useCanvasExplosionState`
Implemented in `packages/react/src/canvas/useCanvasExplosionState.ts`:
Mirrors the exact same API and lifecycle semantics using standard React hooks (`useState`, `useCallback`, `useRef`, `useEffect`).

---

### Layer 3: Modernized Integrated Coordinators

Refactor `createCanvasExplosion.svelte.ts` and `useCanvasExplosion.ts` to internally compose `createCanvasExplosionState` and `computeCanvasExplosionLayout`. For imperative graph consumers (e.g. diagrams and whiteboards), the coordinator continues to animate node coordinates and push/remove child nodes from the graph target, but delegates its state and layout math to Layers 1 and 2.

---

## 4. Implementation Steps & Verification

### Step 1: Upstream Geometric Core (`packages/core`)
- [x] Update `calculateDirectionalDisplacement` to strictly enforce `minY`, `maxY`, and handle `layoutMode: 'row-lane'`. *(Done in core, `packages/core/src/canvas/displacement.ts`; the Svelte copy was deleted and Svelte re-exports core.)*
- [x] Export `computeCanvasExplosionLayout`. *(Lives in `packages/core/src/canvas/explosionLayout.ts`; re-exported by `@pixerate/editor-svelte/canvas` and `@pixerate/editor-react/canvas`.)*
- [x] Add unit tests verifying *(in `packages/core/tests/canvas-explosion.test.ts`, plus Svelte coverage in `packages/svelte/tests/canvas/canvas-explosion*.test.ts`)*:
  - Vertical displacement keeps all rows above the origin $\ge \text{minY}$.
  - Distributed row spacing prevents overlapping among multiple nodes above the origin.
  - Horizontal $X$ coordinates remain unchanged during vertical displacement.

### Step 2: Headless State Machine (`packages/svelte`)
- [x] Implement `createCanvasExplosionState.svelte.ts` using Svelte 5 runes. *(A `$state` mirror of core's framework-free `createCanvasExplosionStateController`.)*
- [x] Add unit tests verifying *(core: `packages/core/tests/canvas-explosion.test.ts`; rune: `packages/svelte/tests/canvas/canvas-explosion-state.svelte.test.ts`)*:
  - `explode()`, `collapse()`, `toggle()` state transitions.
  - Correct timer-based cleanup of `collapsingId`.
  - Rapid toggle debounce/cancellation behavior.
  - `destroy()` cleanup.

### Step 3: React Parity (`packages/react`)
- [x] Implement `useCanvasExplosionState.ts` in `packages/react/src/canvas/`.
- [x] Add React test suite verifying identical state transition behavior (`packages/react/tests/canvas-explosion.test.tsx`).

### Step 4: Package Exports & Documentation
- [x] Re-export all new runes, hooks, functions, and types in `packages/svelte/src/canvas/index.ts` and `packages/react/src/canvas/index.ts`.
- [x] Update `docs/canvas.md` with usage examples for both declarative (timeline/Gantt) and imperative (whiteboard/diagram) architectures.
- [x] Run `pnpm build`, `pnpm typecheck`, `pnpm check:packages`, `pnpm test` and `pnpm --filter demo build` across the monorepo (the repo has no `check` / `lint` scripts).

---

## 5. Downstream Integration in Uchiage

Once published, Uchiage refactors `src/lib/components/gantt/GanttCanvas.svelte`:

```svelte
<script lang="ts">
  import {
    calculateDirectionalDisplacement,
    createCanvasExplosionState
  } from '@pixerate/editor-svelte/canvas';

  // Replace local internalExplodedTaskId, collapsingTaskId, and setTimeout
  const explosionState = createCanvasExplosionState({
    collapseDurationMs: 380,
    onExplode: (taskId) => { /* optional telemetry/callbacks */ }
  });

  // Clean declarative layout derivation
  const displacedPositions = $derived.by(() => {
    if (!explosionState.activeId) return new Map();
    const originNode = baseNodes.find((n) => n.id === explosionState.activeId);
    if (!originNode) return new Map();

    const { childNodes } = buildGanttTaskExplodedChildNodes(
      originNode.data.task,
      originNode.position,
      { parentWidth: originNode.measured?.width }
    );

    return calculateDirectionalDisplacement({
      existingNodes: baseNodes,
      originNode,
      childNodes,
      options: {
        direction: 'vertical',
        layoutMode: 'row-lane',
        minY: HEADER_HEIGHT + 8,
        gap: 24
      }
    });
  });
</script>
```

**Benefits to Uchiage**:
- Eliminates ~50 lines of bespoke row-clamping and timeout code in `GanttCanvas.svelte`.
- Eliminates the dead call to `calculateDirectionalDisplacement`.
- Ensures smooth, bug-free collapse transitions synchronized with CSS animation keyframes.

---

## Implementation status

All four steps are done. What was built, by layer:

- **Layer 1, core (`@pixerate/editor/canvas`)**: `calculateDirectionalDisplacement` (enforced `minY` / `maxY` with rows stacked `rowSpacing` apart, axis locking, `layoutMode: 'row-lane'`, `RangeError` on bad options), `calculateReflowDisplacement` (dagre, moved from Svelte), `computeCanvasExplosionLayout` (returns `displacedPositions`, `originalPositions`, `childNodes` copies, `childEdges` including parent edges, `childBounds`, `totalDisplacementDelta`), `nodeSizeOf`.
- **Layer 2**: core `createCanvasExplosionStateController` (framework-free, `getSnapshot` / `subscribe`), wrapped by the Svelte rune `createCanvasExplosionState` and the React hook `useCanvasExplosionState`.
- **Layer 3**: `createCanvasExplosion` (Svelte) and `useCanvasExplosion` (React) both compute their layout with `computeCanvasExplosionLayout`; the React hook was brought to parity with the Svelte one.
- **Agent path** (AGENTS.md section 4): `createCanvasExplosionToolProvider` with `list_explodable_nodes`, `explode_node`, `collapse_node`, and `canvasExplosionToolTarget` to drive the declarative state. Documented in the `pixerate-canvas` skill, mapped in `tests/agent-skills.test.ts`, covered by the conformance test in `tests/command-tools.test.ts`, registered in the demo Canvas tab.

### Deviations from the plan

1. **Geometry and state live in core, not in `packages/svelte`.** AGENTS.md requires shared logic in `@pixerate/editor`, and core already had a second, diverging copy of the displacement math that React used. The two were merged into core; Svelte's `createCanvasDisplacement.ts` was deleted and Svelte / React re-export core.
2. **The state machine is a core controller plus thin bindings**, so the rune and the hook share one implementation (and the agent tools can drive it). The rune keeps a `$state` snapshot rather than `$derived` fields.
3. **API additions beyond the sketch**: `explode` / `collapse` / `toggle` return booleans (whether anything changed); `finishCollapse()` ends a collapse early (e.g. from `animationend`); `initialActiveId`; the bindings expose `controller`. Exploding a second node collapses the first and calls `onCollapse` for it.
4. **`computeCanvasExplosionLayout` takes more inputs** than sketched: `existingEdges`, `strategy` (`directional` / `dagre` / `none`), `reflowOptions`, `connectParentToChildren` (default `false` here; the coordinators default to `'all'`) and `createEdge`. It throws on an origin missing from `existingNodes` and on child ids that clash.
5. **Coordinators do not compose the single-active state machine.** `createCanvasExplosion` / `useCanvasExplosion` support several exploded nodes at once, which the one-active-node state cannot represent, so they keep their per-node snapshots and use Layer 1 only.
6. **`minY` semantics**: rows are grouped (by lane in `row-lane` mode, else by original y) and stacked from `minY` (`maxY` from the bottom), and a node never moves past its starting y in the other direction. Rows clamped back to their start are left out of the result.
7. **Removed** the unused `ExplodeNodeOptions.connectChildrenToDownstream`. Parent edge ids are now deterministic (`explode:<parent>:<child>`) instead of random UUIDs.
