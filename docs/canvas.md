# Svelte 5 Headless Canvas Architecture (`@pixerate/editor-svelte/canvas`)

The `@pixerate/editor-svelte/canvas` subpath export provides a headless, unstyled Svelte 5 runes architecture for building interactive graph, flow, and diagramming canvas experiences on top of SvelteFlow (`@xyflow/svelte`).

---

## 🌟 Philosophy & Core Principles

1. **Headless & UI-Agnostic**: Contains zero assumptions about styles, colors, DOM presentation, or application-specific AI/node models. Pure business logic, coordinate mathematics, and interaction controllers.
2. **Svelte 5 Runes First**: Implemented using `$state.raw`, `$derived`, and modern functional runes instead of `.svelte` component-as-controller wrappers.
3. **High Performance**: Eliminates expensive per-frame array clones during animations and node dragging, avoiding requestAnimationFrame memory churn.
4. **Decoupled Architecture**: Independent modules for graph state, clipboard serialization, Dagre auto-layout, docking/intersections, and hotkeys that can be used together or individually.
5. **Zero Bloat for Non-Canvas Consumers**: Exposed as a clean subpath export (`@pixerate/editor-svelte/canvas`) with `@xyflow/svelte` as an optional peer dependency, ensuring standard text editor consumers do not pay any bundle or dependency penalty.

---

## 📦 Installation & Setup

Install `@pixerate/editor-svelte` alongside SvelteFlow:

```bash
pnpm add @pixerate/editor-svelte @xyflow/svelte
```

---

## 🧩 Module Overview

| Module | Purpose |
| :--- | :--- |
| [`createCanvasGraph`](#createcanvasgraphoptions) | Reactive graph state management (`$state.raw`), deduplication, edge-preserving node replacement, and diff calculation. |
| [`createCanvasClipboard`](#createcanvasclipboardoptions) | Serialized JSON clipboard management, UUID remapping, +40px offset, URL, text, and image pasting. |
| [`createCanvasDocking`](#createcanvasdockingoptions) | Drag-to-dock intersection tracking, dock target hover/leave/drop lifecycle, and connection handle state. |
| [`getLayoutedNodes` / `centerNodes`](#layout-and-viewport-math) | Dagre hierarchical auto-layout, viewport centering, and bounding box math. |
| [`createCanvasShortcuts`](#createcanvasshortcutsoptions) | Global keyboard shortcut binding with automatic suppression during active text editing. |
| [`createCanvasInteractions`](#createcanvasinteractionsoptions) | Spacebar panning toggle, trackpad pinch detection, and SvelteFlow interaction presets. |
| [`createCanvasExplosion`](#createcanvasexplosiongraph-options) | Multi-node explosion, fan-out/bezier trajectory animation, spatial displacement ("make space"), and reversible collapse. |
| [`createCanvasArrange`](#createcanvasarrangeoptions) | Align, distribute, make same size, lock / unlock, layer order and smart guides with snap-to-shape. |
| [`createCanvasScenes`](#createcanvasscenesoptions) | Named saved viewports (Freeform "Scenes") with next / previous, reorder, rename and JSON persistence. |
| `types` | Generic TypeScript interfaces (`CanvasNode`, `CanvasEdge`, `GraphDifferences`, `CanvasLayoutOptions`, etc.). |

---

## 🚀 Quickstart & Usage

```svelte
<script lang="ts">
  import { SvelteFlow, useSvelteFlow } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import {
    createCanvasGraph,
    createCanvasClipboard,
    createCanvasShortcuts,
    createCanvasInteractions,
    defaultSvelteFlowPreset
  } from '@pixerate/editor-svelte/canvas';

  // 1. Initialize reactive graph controller
  const graph = createCanvasGraph({
    initialNodes: [
      { id: '1', position: { x: 100, y: 100 }, data: { label: 'Start' } }
    ],
    initialEdges: [],
    onSave: () => console.log('Graph changed, autosaving...')
  });

  // 2. Setup clipboard handler
  const clipboard = createCanvasClipboard({
    onPasteNodes: (nodes, edges) => {
      graph.addNodeOrNodes(nodes);
      if (edges) graph.addEdges(edges);
    },
    onPasteUrl: (url) => {
      console.log('Pasted URL:', url);
    }
  });

  // 3. Attach keyboard shortcuts
  $effect(() => {
    return createCanvasShortcuts({
      getSelectedNodes: () => graph.nodes.filter((n) => n.selected),
      onDelete: (selected) => graph.removeNodes(selected),
      onDuplicate: (selected) => {
        const clones = selected.map((n) => ({
          ...n,
          id: crypto.randomUUID(),
          position: { x: n.position.x + 40, y: n.position.y + 40 }
        }));
        graph.addNodeOrNodes(clones);
      }
    });
  });
</script>

<div class="w-full h-screen" onpaste={(e) => clipboard.handlePasteEvent(e)}>
  <SvelteFlow
    bind:nodes={graph.nodes}
    bind:edges={graph.edges}
    {...defaultSvelteFlowPreset}
  />
</div>
```

---

## 🛠️ Complete API Reference

### `createCanvasGraph<TNode, TEdge>(options?)`

Creates a reactive graph controller managing nodes and edges using Svelte 5 `$state.raw`.

#### Options
- `initialNodes?: TNode[]`: Initial node list.
- `initialEdges?: TEdge[]`: Initial edge list.
- `onNodesChange?: (nodes: TNode[]) => void`: Callback fired when nodes change.
- `onEdgesChange?: (edges: TEdge[]) => void`: Callback fired when edges change.
- `onSave?: () => void`: Optional persistence trigger.
- `createEdge?: (sourceId, targetId, options?) => TEdge`: Custom edge factory function.

#### Returns
- `nodes`: Getter/setter for active nodes array.
- `edges`: Getter/setter for active edges array.
- `setNodes(nodes, triggerCallback?)`: Direct replacement of nodes.
- `setEdges(edges, triggerCallback?)`: Direct replacement of edges.
- `addNodeOrNodes(nodeOrNodes, animateFromPosition?, save?)`: Adds nodes with deduplication and optional positioning animation.
- `addEdge(edge, save?)` / `addEdges(edges, save?)`: Adds edges.
- `removeNodes(nodesToRemove, save?)` / `removeEdges(edgesToRemove, save?)`: Removes entities by ID.
- `replaceNode(oldNode, newNode, save?, keepEdges?)`: Replaces a node, optionally updating connected edge endpoints.
- `addConnectedNodes(params)`: Connects incoming and outgoing nodes to a batch of added nodes.
- `getDifferences(baseline)`: Returns `{ changedNodes, changedEdges, removedNodes, removedEdges }`.

---

### Layout and Viewport Math

Pure geometry and Dagre layout calculations:

- `getLayoutedNodes(nodes, edges, getNodesBounds, options?)`: Automatically lays out graph nodes hierarchically (`'LR'`, `'TB'`, `'RL'`, or `'BT'`).
- `getCenteredNodePosition(width, height, screenToFlowPosition, screenDimensions?)`: Computes top-left coordinate to center an element in view.
- `centerNodes(nodes, screenToFlowPosition, getNodesBounds, screenDimensions?)`: Translates a collection of nodes so their bounding box is centered in the current viewport.

---

### `createCanvasClipboard(options?)`

Headless clipboard interaction:

#### Options
- `onPasteNodes?: (nodes: TNode[], edges?: TEdge[]) => void | Promise<void>`
- `onPasteUrl?: (url: string, position?: XYPosition) => void`
- `onPasteText?: (text: string, position?: XYPosition) => void`
- `onPasteImage?: (blob: File) => void | Promise<void>`
- `screenToFlowPosition?: (position: XYPosition) => XYPosition`

#### Methods
- `copySelectedNodes(nodes, edges?, event?)`: Serializes nodes to clipboard as JSON.
- `cutSelectedNodes(nodes, edges?, onRemove?, event?)`: Copies and calls deletion callback.
- `handlePasteEvent(event)`: Intelligently handles paste events, disambiguating images, serialized nodes, URLs, and plain text.

---

### `createCanvasDocking(options?)`

Drag-and-dock interaction tracking:

#### Options
- `isDockTarget?: (target: TNode) => boolean`: Predicate determining if an intersecting node is a valid dock.
- `restorePositionOnDock?: boolean`: Reverts dragged node position if dropped on a dock target (default `true`).
- `onDockHover?: (dockTarget: TNode, draggedNode: TNode) => void`
- `onDockLeave?: (dockTarget: TNode, draggedNode: TNode) => void`
- `onDockDrop?: (dockTarget: TNode, draggedNode: TNode) => void`
- `onSave?: () => void`

#### Returns
- `draggedNode`: Currently dragged node or `null`.
- `draggedInitialPosition`: Initial coordinate when drag began.
- `connectingHandle`: Connection handle identifier or `''`.
- `connectingNode`: Node where connection began.
- `isDragging`: Boolean flag.
- `handleNodeDragStart`, `handleNodeDrag`, `handleNodeDragStop`, `handleConnectStart`, `handleConnectEnd`, `reset`.

---

### `createCanvasShortcuts(options)`

Attaches standard canvas hotkeys (`Meta/Ctrl+C`, `Meta/Ctrl+X`, `Meta/Ctrl+V`, `Delete`, `Meta/Ctrl+D`, `Meta/Ctrl+A`, `Meta/Ctrl+G`, zoom controls):

- Automatically respects active text inputs (`input`, `textarea`, `select`, `contenteditable`, and `.ProseMirror`).
- Returns a cleanup function `() => void`.

---

### `createCanvasInteractions(options?)`

Manages viewport interaction modes:

- `isSpacebarPanning`: Reactive flag active while Spacebar is held down.
- `trackpadDetected`: Reactive flag set when trackpad pinch-to-zoom is detected.
- Presets: `defaultSvelteFlowPreset`, `miroCompatiblePreset`.
- Helper: `restorePanelPointerEvents()` restores panel clickability after drag-selection.

---

### `createCanvasExplosion(graph, options?)`

Headless Svelte 5 rune orchestrating node expansion/explosion into sub-nodes, parametric trajectory paths, spatial layout displacement ("make space"), and reversible collapsing.

#### Features
- **Spatial Displacement**: Automatically shifts downstream and sibling nodes using directional (`'right'`, `'down'`, `'left'`, `'up'`) or Dagre hierarchical reflow strategies.
- **Parametric Trajectories**: Built-in `createFanOutTrajectory` (smooth bezier fan arc), `linearTrajectory`, and custom `(origin, target, progress, index, total) => { position, scale, opacity }`.
- **Reversible Collapse**: Automatically records an `ExplosionSnapshot` caching pre-explosion node positions and edges. Collapsing smoothly retracts child nodes to origin and returns displaced nodes to their baseline positions without graph drift.
- **High Performance**: Mutates coordinates in-place during `requestAnimationFrame` to avoid per-frame garbage collection.

#### Usage Example

```svelte
<script lang="ts">
  import {
    createCanvasGraph,
    createCanvasExplosion,
    createFanOutTrajectory
  } from '@pixerate/editor-svelte/canvas';

  const graph = createCanvasGraph({ initialNodes: [...], initialEdges: [...] });
  const explosion = createCanvasExplosion(graph);

  function handleNodeClick(nodeId: string) {
    if (explosion.isExploded(nodeId)) {
      explosion.collapseNode(nodeId, { duration: 400 });
    } else {
      explosion.explodeNode(nodeId, {
        childNodes: [
          { id: 'sub-1', position: { x: 300, y: 50 }, data: { label: 'Task 1' } },
          { id: 'sub-2', position: { x: 300, y: 150 }, data: { label: 'Task 2' } }
        ],
        displacementStrategy: 'directional', // or 'dagre'
        directionalOptions: { direction: 'right', gap: 50 },
        trajectory: createFanOutTrajectory({ curvature: 0.4 }),
        duration: 500
      });
    }
  }
</script>
```

---

### `createCanvasArrange(options)`

Freeform-style arrangement. The maths lives in `@pixerate/editor/canvas` and is shared with React's `useCanvasArrange`.

#### Options
- `getNodes: () => TNode[]` / `setNodes: (nodes: TNode[]) => void`: Read and write the node array.
- `getSelectedIds?: () => string[]`: Ids used when a method is called without ids (default: nodes with `selected: true`).
- `history?: HistoryManager`: Records every action as one undoable step. Drag snapping is not recorded.
- `getZoom?: () => number`: Converts the guide threshold from screen pixels to flow units.
- `guides?: { threshold?: number; edges?: boolean; centres?: boolean; spacing?: boolean }`: Smart-guide options (threshold defaults to 6 screen px).
- `snapping?: boolean`: Turns drag snapping off while keeping the actions.

#### Methods
- `align(edge, ids?)`: `'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'`. Aligns to the selection bounds.
- `distribute(axis, mode?, ids?)`: `'horizontal' | 'vertical' | 'both'`, with `'gaps'` (equal spacing, default) or `'centres'`. The outermost nodes stay put. Needs three or more nodes.
- `matchSize(dimension, ids?, { reference?, keepCentre? })`: Make Same Size from the `largest` (default), `smallest`, `first` or `{ id }` node.
- `lock(ids?)`, `unlock(ids?)`, `toggleLock(ids?)`, `isLocked(id)`.
- `bringForward(ids?)`, `sendBackward(ids?)`, `bringToFront(ids?)`, `sendToBack(ids?)`.
- `beginDrag(ids?)`, `drag(ids?)`, `endDrag()`, and the reactive `guides` array.
- `runAction(action)`: Runs a shortcut action by name.

#### Rules
- **Locked nodes** (`data.locked === true`, set by `lockNodes`) are never moved, resized or restacked. They still count towards the selection bounds, so they act as alignment anchors. Locking sets `draggable: false` and `deletable: false` and keeps the node selectable. Unlocking restores the previous flags.
- **Sub-flows**: Geometry uses absolute positions along the `parentId` chain. Updates are written back relative to the parent.
- **Sizes**: `measured`, then `width` / `height`, then a pixel `width` / `height` in `style` (string or object), then `estimateNodeSize`.
- **Layer order**: `zIndex` values are assigned per sibling group. The array order is not changed (see GOTCHAS).

#### Smart guides and snapping

```svelte
<script lang="ts">
  import { SvelteFlow, useSvelteFlow } from '@xyflow/svelte';
  import { createCanvasArrange, createCanvasArrangeShortcuts, CanvasGuidesLayer } from '@pixerate/editor-svelte/canvas';

  let nodes = $state.raw([...]);
  const flow = useSvelteFlow();
  const arrange = createCanvasArrange({
    getNodes: () => nodes,
    setNodes: (next) => (nodes = next),
    getZoom: () => flow.getViewport().zoom
  });
  $effect(() => createCanvasArrangeShortcuts({ arrange }));
</script>

<SvelteFlow
  bind:nodes
  onnodedragstart={() => arrange.beginDrag()}
  onnodedrag={({ nodes: dragged }) => arrange.drag(dragged.map((n) => n.id))}
  onnodedragstop={() => arrange.endDrag()}
>
  <CanvasGuidesLayer guides={arrange.guides} viewport={flow.getViewport()} />
</SvelteFlow>
```

Edges snap to edges and centres to centres. Equal-spacing guides appear when the dragged node would sit centred between its row/column neighbours, or would repeat a neighbour's gap. Snap targets are indexed once per drag (`createNodeGuideIndex`), and each frame is a binary search.

Pure helpers for custom integrations: `alignNodes`, `distributeNodes`, `matchSize`, `reorderNodes`, `applyNodeUpdates`, `invertNodeUpdates`, `computeSnapGuides`, `createGuideIndex`, `snapNodeDrag`.

#### Keyboard shortcuts (`DEFAULT_ARRANGE_SHORTCUTS`)

| Action | Shortcut |
| :--- | :--- |
| Align left / center / right | `Alt+A` / `Alt+H` / `Alt+D` |
| Align top / middle / bottom | `Alt+W` / `Alt+V` / `Alt+S` |
| Distribute horizontally / vertically | `Alt+Shift+H` / `Alt+Shift+V` |
| Lock / Unlock | `Mod+L` / `Mod+Alt+L` |
| Bring forward / Send backward | `Mod+]` / `Mod+[` |
| Bring to front / Send to back | `Mod+Alt+]` / `Mod+Alt+[` |
| Next / previous scene | `PageDown` / `PageUp` |

Keys are matched by `KeyboardEvent.code`. Shortcuts are ignored while typing in inputs, textareas, contenteditable and ProseMirror. Pass `bindings` to override them.

---

### `createCanvasScenes(options?)`

Named saved viewports backed by the headless `CanvasScenesStore` (shared with React's `useCanvasScenes`).

#### Options
- `getViewport?` / `setViewport?`: Usually `useSvelteFlow().getViewport` / `setViewport`.
- `duration?`: Transition duration when showing a scene (default 300ms).
- `wrap?`: Whether `next` / `previous` wrap around (default `false`).
- `initialScenes?`, `createId?`, `onChange?`.

#### Returns
- `scenes`, `current`, `currentId`, `currentIndex` (reactive).
- `capture(name?, { viewport?, nodeIds?, index? })`, `captureNodes(nodes, ids, size, name?, fit?)`, `recapture(id)`.
- `update`, `rename`, `move(id, toIndex)`, `reorder(ids)`, `remove`, `clear`.
- `goTo(id)`, `next()`, `previous()`: Move the viewport through `setViewport`.
- `toJSON()`, `serialize()`, `load(json)`: Versioned JSON (`{ version: 1, scenes }`). Invalid entries are dropped on load.

`fitViewportToRect(rect, size, { padding, minZoom, maxZoom })` and `fitViewportToNodes(nodes, size, ids?)` compute an xyflow viewport that frames content.

---

### Connector snapping

`findConnectorSnap(pointer, targets, { zoom, radius, excludeIds, mode })` returns the node and side (`Position` plus the matching `Side`) a connection line should attach to. The pointer is in flow coordinates. A shape under the pointer wins over a shape that is only nearby. `mode: 'handle'` snaps to the side's midpoint, and `'edge'` snaps to the nearest point on the side (floating edges). `nearestHandlePositions(source, target)` picks facing sides for a new connection. `CONNECTION_LINE_TYPES` lists the line types both flow libraries accept for `connectionLineType`.

Shape boolean operations (unite / intersect / subtract) are not provided.
