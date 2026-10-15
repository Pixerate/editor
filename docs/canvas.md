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
| [`ShapeNode` / shape operations](#shape-nodes-and-boolean-operations) | Shape nodes (rect, ellipse, polygon, star, SVG path), curve-preserving Unite / Intersect / Subtract / Exclude / Divide, Offset Path and Outline Stroke. |
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
- `guides.gridSize?: number` / `guides.gridOrigin?`: Snap to a grid when no shape is in reach (drag and resize).
- `resizeSnapping?: boolean`, `resize?: { keepAspectRatio?, minWidth?, minHeight? }`: Resize snapping options.

#### Methods
- `align(edge, ids?)`: `'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'`. Aligns to the selection bounds.
- `distribute(axis, mode?, ids?)`: `'horizontal' | 'vertical' | 'both'`, with `'gaps'` (equal spacing, default) or `'centres'`. The outermost nodes stay put. Needs three or more nodes.
- `matchSize(dimension, ids?, { reference?, keepCentre? })`: Make Same Size from the `largest` (default), `smallest`, `first` or `{ id }` node.
- `lock(ids?)`, `unlock(ids?)`, `toggleLock(ids?)`, `isLocked(id)`.
- `bringForward(ids?)`, `sendBackward(ids?)`, `bringToFront(ids?)`, `sendToBack(ids?)`.
- `beginDrag(ids?)`, `drag(ids?)`, `endDrag()`, and the reactive `guides` array.
- `resizerHandlers(id)`, `beginResize(id)`, `resize(id, handle?)`, `endResize()`, `snapResizeChanges(changes)`: resize snapping (see below).
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

#### Resize and grid snapping

`snapResize(rect, handle, targets, { zoom, threshold, edges, centres, gridSize, gridOrigin, keepAspectRatio, minWidth, minHeight })` snaps a box being resized with `handle` (`'top-left' | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left'`, xyflow's names):

- The opposite edge (side handles) or corner (corner handles) stays fixed. A side snaps its one moving edge; a corner snaps x and y independently. With `keepAspectRatio` a corner snaps whichever axis is closer and the other follows; a side scales the other axis about its centre.
- Moving edges land on other shapes' edges and centres within `threshold` screen px. A snap that would collapse or flip the box (or go below `minWidth` / `minHeight`) is rejected and the next target is tried.
- `gridSize` (also honoured by drag snapping): an axis without a shape snap snaps its moving edge (drag: the top-left) to the grid. Grid snaps draw no guides. `snapToGrid(value, spacing, origin)` is the scalar helper.
- Returns `{ rect, guides, snappedX, snappedY, changed }`. `snapNodeResize(nodes, id, rect, handle)` wraps it for nodes (the node and its descendants are not targets; locked nodes are not snapped).

The arrange controller wires it to the flow libraries. Options: `resizeSnapping` (default follows `snapping`) and `resize: { keepAspectRatio, minWidth, minHeight }`; the guide options (`threshold`, `gridSize`, ...) are shared with dragging.

```svelte
<!-- Svelte: inside a custom node -->
<NodeResizer {...arrange.resizerHandlers(id)} />
```

SvelteFlow's resizer calls `onResize` before it writes the raw size to `nodes`, so `resizerHandlers` snaps a microtask later (`arrange.resize(id)`) and writes the snapped box back. `beginResize(id)`, `resize(id, handle?)` and `endResize()` are available for custom wiring; the handle is inferred from the edges that moved since `beginResize`. Resizing a locked node puts it back to its starting box.

React: pass changes through `arrange.snapResizeChanges` as well as `snapPositionChanges` (`applyNodeChanges(arrange.snapResizeChanges(arrange.snapPositionChanges(changes)), nodes)`). It snaps `dimensions` changes with `resizing: true` (and the matching `position` change for top / left handles), keeps the snapped size on the `resizing: false` end change (React Flow reports the raw pointer size there), and drops resize changes of locked nodes.

#### Distance measuring (Alt-hover)

Hold Alt / Option and hover a node to see red distance lines with labels from the selection (the union of the selected nodes) to it. Hovering the selection itself or empty space measures to the selection's parent.

```svelte
<script lang="ts">
  import { createCanvasMeasure, CanvasGuidesLayer } from '@pixerate/editor-svelte/canvas';
  const measure = createCanvasMeasure({ getNodes: () => nodes });
  $effect(() => measure.listen());
</script>

<SvelteFlow bind:nodes onnodepointerenter={measure.onnodepointerenter} onnodepointerleave={measure.onnodepointerleave}>
  <CanvasGuidesLayer guides={[...arrange.guides, ...measure.guides]} viewport={flow.getViewport()} />
</SvelteFlow>
```

React: `const measure = useCanvasMeasure({ nodes })`, `onNodeMouseEnter={measure.onNodeMouseEnter}`, `onNodeMouseLeave={measure.onNodeMouseLeave}`. Both expose `guides`, `target` (the measured box, to outline), `active`, `hoveredId`, `setHovered` (Svelte) / `setHoveredId` (React) and `setModifier`. Options: `getSelectedIds`, `enabled`, `requireModifier` (`false` measures without Alt), `rectOptions`.

Pure helpers: `measureBetween(a, b)` covers three cases. One box inside the other measures to each edge of the outer one along the inner box's centre lines. Overlapping boxes measure between matching edges. Boxes apart measure the gaps across the shared rows / columns, or from the middle of `a` with a dashed `extension` line to `b`. `measureToLine(rect, 'vertical' | 'horizontal', at)`, `measureSelection(nodes, selectedIds, hoveredId)` and `measureLabel(d)` (two decimals, no trailing zeros) are also exported. Measure guides are `GuideLine`s with `kind: 'measure'` (with `label`) or `'extension'`; `<CanvasGuidesLayer>` draws them in `measureColor` (default red) with label pills.

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

---

### Shape nodes and boolean operations

Freeform's Unite, Intersect, Subtract, Exclude and Divide for **shape nodes**. Generic nodes with HTML content are not shapes; a node is a shape when `data.shape` holds a shape description. Geometry is relative to the node box, so moving or resizing the node moves or resizes the shape.

```ts
type ShapeDescription =
  | { kind: 'rect'; cornerRadius?: number | [tl, tr, br, bl] }
  | { kind: 'ellipse' }
  | { kind: 'polygon'; sides?: number }                    // regular polygon, default 6
  | { kind: 'star'; points?: number; innerRadius?: number } // default 5 points, 0.5
  | { kind: 'path'; d: string; viewBox?: [minX, minY, width, height]; fillRule?: 'nonzero' | 'evenodd' };
// every kind also takes: fill, stroke, strokeWidth, opacity, rotation (degrees, clockwise, about the box centre)
```

Polygons and stars are stretched so their bounding box fills the node. A `path` without a `viewBox` uses node-local pixels.

#### Rendering

`ShapeNode` (React and Svelte) is a headless node component: one SVG path filling the node box, with `fill` (default `currentColor`), `stroke`, `strokeWidth` and `opacity` from `data.shape`. Strokes use `vector-effect: non-scaling-stroke`. Register it as a node type and use `SHAPE_NODE_TYPE` (`'shape'`) as the node `type`:

```svelte
<script lang="ts">
  import { SvelteFlow } from '@xyflow/svelte';
  import { ShapeNode, createCanvasArrange } from '@pixerate/editor-svelte/canvas';

  let nodes = $state.raw([
    { id: 'a', type: 'shape', position: { x: 0, y: 0 }, width: 120, height: 120, data: { shape: { kind: 'ellipse', fill: '#60a5fa' } } },
    { id: 'b', type: 'shape', position: { x: 60, y: 0 }, width: 120, height: 120, data: { shape: { kind: 'rect', cornerRadius: 16, fill: '#f472b6' } } }
  ]);
  const arrange = createCanvasArrange({ getNodes: () => nodes, setNodes: (next) => (nodes = next) });
</script>

<button disabled={!arrange.canCombineShapes()} onclick={() => arrange.unite()}>Unite</button>
<SvelteFlow bind:nodes nodeTypes={{ shape: ShapeNode }} />
```

React: `nodeTypes={{ shape: ShapeNode }}` with `arrange = useCanvasArrange({ nodes, setNodes, history })`. Pass children (React) or a `children` snippet (Svelte) to a wrapping component to add handles.

#### Operations

`arrange.combineShapes(operation, ids?, options?)` with `'unite' | 'intersect' | 'subtract' | 'exclude' | 'divide'`, plus the shorthands `unite`, `intersect`, `subtract`, `exclude`, `divide` and `canCombineShapes(ids?)`. Each call is one undo step. The pure version is `combineShapeNodes(nodes, ids, operation, options)`, which returns `{ ok: true, removeIds, nodes }` (apply it with `applyShapeCombination`, undo with `revertShapeCombination`) or `{ ok: false, reason }`.

- **Selection**: only shape nodes among the ids take part; other selected nodes are ignored. At least two shapes are needed.
- **Locked shapes refuse the operation** (`reason: 'locked'`). The operations delete their inputs, and locked nodes are never deleted, so nothing changes. A locked non-shape node in the selection does not block it.
- **Empty results refuse** (`reason: 'empty'`), e.g. intersecting shapes that do not overlap. The inputs are kept.
- **Subtract** removes every other shape from the back-most shape (stacking order: `zIndex`, then array order). Unite, Intersect and Exclude are symmetric.
- **Result**: one `path` shape node (Divide: one per distinct region; a region cut in two becomes two nodes). Its `position` / `width` / `height` are the result's bounding box, and `d` is node-local with `viewBox = [0, 0, width, height]`. Rotation is baked in. The new node is selected and inserted at the array index of the first consumed node.
- **Style**: node fields, `data` and paint come from the back-most shape (`styleFrom: 'bottom'`, like Freeform), or `'top'`, `'first'` or `{ id }`. Divide pieces take the paint of the top-most shape covering them, so the canvas looks the same after dividing.
- **Sub-flows**: geometry uses absolute positions. The result keeps the parent when all shapes share one, and is top-level otherwise.
- **Edges** connected to consumed nodes are not touched (the controller only sees nodes). Remove or reconnect them from `removeIds`.
- **Curves are kept** (`engine: 'curve'`, the default): the operation runs on the exact Bézier outlines (arcs become cubics), and every piece of the result is an exact sub-curve of an input segment, so the union of two circles is eight cubic arcs meeting at the true intersection points and a rectangle side stays one line. The result reports `engine` (`'curve'`, or `'polygon'` after a fallback) and `fallbackReason`; `onFallback(reason)` is called too. When the curve engine cannot resolve the input (nearly coincident curves that never converge) it falls back to the polygon engine below.
- **Polygon engine** (`engine: 'polygon'`, implied by `curves: 'lines'`): shapes are flattened (`tolerance`, default 0.25 flow units) and combined with `polygonBoolean`; the result is fitted with cubic Béziers (`curves: 'fit'`, corners sharper than `cornerAngleDeg` kept) or written as lines (`curves: 'lines'`).
- Options: `engine`, `onFallback`, `precision` (path decimals, default 3), `epsilon`, `createId`, `nodeType`, `select`, `styleFrom`; polygon engine only: `tolerance`, `curves`, `curveTolerance`, `cornerAngleDeg`, `simplify`.

#### Offset Path and Outline Stroke

`arrange.offsetShapes(distance, ids?, { join, miterLimit, keepOriginal })` grows (`distance > 0`) or shrinks (`distance < 0`) every selected shape by `distance` flow units, keeping curves (a circle grows into a circle of four cubics). Joins are `'miter'` (default, with `miterLimit` 4), `'round'` or `'bevel'`. The offset shape replaces the original in place (same stacking position and paint), or sits below it with `keepOriginal`. Shapes whose inset vanishes are left alone; the call refuses (`'empty'`) when every result is empty, and with `'locked'` / `'no-shapes'` / `'invalid'`.

`arrange.outlineStroke(ids?, { width, join, cap, miterLimit, dash, dashOffset, keepFill })` converts each selected shape's stroke into a filled `path` shape (fill = the stroke colour, no stroke). The stroke is outlined in flow units at `strokeWidth` (strokes do not scale with the node), with SVG's defaults: miter joins, miter limit 4, butt caps. The shape's fill stays as the original node with its stroke removed, below the outline (`keepFill: false` drops it). Refuses with `'no-stroke'` when no selected shape has a visible stroke.

Both are one undo step (`'Offset Path'`, `'Outline Stroke'`), with `canOffsetShapes(ids?)` / `canOutlineStroke(ids?)` for menus. Pure versions: `offsetShapeNodes(nodes, ids, distance, options)` and `outlineShapeNodeStrokes(nodes, ids, options)` return `{ ok: true, removeIds, nodes, replacements }`; apply with `applyShapeReplacement` (each node is swapped in place) and undo with `revertShapeCombination(nodes, result, previous)`.

#### Commands (palette, context menu, agents)

`createShapeCommands(arrange, { prefix, scope, defaultOffset })` (from `@pixerate/editor/commands`) returns `canvas.unite`, `canvas.intersect`, `canvas.subtract`, `canvas.exclude`, `canvas.divide`, `canvas.offsetPath` (`{ distance, join?, miterLimit?, ids? }`) and `canvas.outlineStroke` (`{ join?, cap?, miterLimit?, ids? }`). Register them with `useRegisterCommands` (React or Svelte) to list them in the command palette or a context menu; disabled commands explain why ("Select at least two unlocked shapes."). No default keyboard shortcuts are bound for these operations.

#### Path operations (curve engine)

Paths are `BezierPath`s: absolute `M` / `L` / `Q` / `C` / `Z` commands. Every function also accepts SVG path data or `parseSvgPath` output (arcs become cubics of at most 90°); `toBezierPath` and `bezierPathToSvg(path, { precision, offset })` convert explicitly.

- `pathBoolean(op, operands, options)`: `'union' | 'intersection' | 'difference' | 'xor'` on any number of operands (a path, or `{ path, fillRule }`; open subpaths are closed for filling). Returns `{ path, engine, fallbackReason?, error? }`. Shorthands `unitePaths`, `intersectPaths`, `subtractPaths`, `excludePaths`; `dividePaths(operands)` returns `{ pieces: [{ path, operands }] }`, one per connected region; `normalizeBezierPath(path, fillRule)` resolves self-intersections. Results are simple closed subpaths that never cross, outer subpaths counter-clockwise in a y-up frame and holes the other way, so they fill the same with `nonzero` and `evenodd`. Non-finite input gives an empty path with `error`.
- Options: `epsilon` (points closer than this merge; default `1e-9` × the largest coordinate), `fallback` (default `true`; `false` throws a `PathOpsError`), `fallbackTolerance` (flattening for the fallback, default 0.05), `onFallback`, `subdivisionBudget`.
- `offsetPath(path, distance, { join, miterLimit, fillRule, tolerance })`: closed subpaths are a filled region; open subpaths are outlined with width `2·|distance|` when growing. Round joins give the exact Minkowski offset (within `tolerance`, default 0.01).
- `outlineStroke(path, { width, join, cap, miterLimit, dash, dashOffset, tolerance })`: the area painted by an SVG stroke, as one clean path. Dashes follow arc length (odd patterns repeat twice, invalid or all-zero patterns draw solid, more than 200,000 dashes draw solid), restart on every subpath and join across the start of a closed subpath; zero-length dashes paint round / square dots. `strokeOutlineRings` returns the raw overlapping outline and `dashContours` the dashes.
- Measures: `bezierPathArea(path, fillRule)` (exact filled area), `bezierPathSignedArea`, `bezierPathBounds` (exact, using curve extrema), `bezierPathLength`, `bezierPathPointAtLength` (point, tangent, angle), `trimSegments`, `segmentLength` / `segmentParamAtLength` (Gauss–Legendre arc length and its inverse), `pointInBezierPath(path, point, fillRule)`, `distanceToBezierPath`, `countPathSegments`, `transformBezierPath(path, [a, b, c, d, e, f])`.
- Shapes: `shapeToBezierPath(shape, size)` and `shapeNodeToBezierPath(node, lookup)` give the exact outline (rotation and view boxes applied).

How it works: every input segment is cut into pieces monotone in x and y; pieces are intersected pairwise (lines analytically, curves by recursive subdivision to flat sub-curves, chord intersection and Newton polishing), with end points lying on other pieces (T-junctions, tangencies), coincident overlaps and clusters of hits along a tangency resolved first. Coincident pieces merge, both sides of every piece are classified by a horizontal or vertical ray (a monotone piece is crossed at most once), and the kept pieces are traced into rings (sharpest left turn; tangent curves are ordered by a short chord along each). Consecutive pieces of one input segment are merged back into its exact sub-curve. Cost is roughly quadratic in the number of segments (two 600-vertex polygons or 80 circles in tens of milliseconds). The stroker offsets lines exactly and curves by cubic approximations refined until they are within `tolerance`, joins the outer side of each corner and pivots the inner side through the vertex, fills the outline with `nonzero` and normalises it; faces left by inner offsets that turn inside out (a deep point closer to the path than the offset distance) are dropped.

#### Geometry helpers

- `polygonBoolean(op, operands, { epsilon })`: `'union' | 'intersection' | 'difference' | 'xor'` on any number of operands. An operand is a multi-polygon (`[[outer, ...holes], ...]`, any ring orientation) or `{ rings, fillRule }` (e.g. flattened path data; may self-intersect). Also `unionPolygons`, `intersectPolygons`, `subtractPolygons`, `xorPolygons` and `dividePolygons(operands)` (pieces with the operand indices covering them).
- Results are simple rings: outer rings have a positive shoelace area and holes a negative one. Rings may touch at a vertex but never cross. Collinear vertices are removed.
- `fitCubics(points, tolerance, { cornerAngleDeg, closed })` fits cubic segments (Schneider-style least squares with Newton reparameterisation, split at the worst point) so every point is within `tolerance`, keeping corners sharper than `cornerAngleDeg` (default 30°; the turn is measured over 4 × `tolerance`, so sample noise does not read as corners). `fitPathData(ring, { tolerance, closed, precision, offset })` returns SVG path data (`C` curves, `L` for straight stretches); `fitFreehandPath(points, { tolerance })` smooths a freehand stroke into an open path.
- `parseSvgPath(d)` (absolute `M`/`L`/`C`/`Q`/`A`/`Z`), `flattenSvgPath(d, { tolerance })`, `shapeToPolygon(shape, size)`, `shapeNodeToPolygon(node, lookup)`, `polygonToSvgPath(multi, { precision, simplify, offset, curves })`, `simplifyRing`, `getShapeSvg` / `getShapeRenderData` (exact arcs for rendering), `polygonArea`, `multiPolygonArea`, `pointInRings`.

The engine builds a planar overlay of all edges (splitting at crossings, T-junctions and collinear overlaps, merging points closer than `epsilon`), classifies both sides of every edge by winding number and traces the boundary of the selected region. It handles shared edges, touching vertices, collinear overlaps, holes, nested and disjoint inputs. Limits: the overlay is O(n²) in edges (pruned by a sweep), comfortable for canvas shapes (two 1,024-vertex circles in about 20 ms) but not GIS-scale data; features narrower than `epsilon` (default `1e-9` × the largest coordinate) collapse; curves are flattened to polylines for the overlay. It is the fallback of the curve engine and `combineShapeNodes`' `engine: 'polygon'`.

---

### Auto layout and constraints (sub-flows)

Figma-style auto layout for xyflow sub-flows. A **frame** is any node with `data.layout`; its children are the nodes whose `parentId` is the frame, in node-array order. The functions are pure and return `CanvasNodeUpdate`s (positions relative to the parent, sizes) for `applyNodeUpdates`.

```ts
// Frame: node.data.layout
type AutoLayout = {
  mode: 'horizontal' | 'vertical' | 'grid';
  gap?: number;                 // main-axis gap (grid: column gap); negative overlaps. Default 0
  rowGap?: number;              // between wrapped lines (grid: row gap). Default: gap
  padding?: number | [v, h] | [top, right, bottom, left] | { top, right, bottom, left }; // default 0
  wrap?: boolean;               // ignored while the frame hugs its main axis
  alignMain?: 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
  alignCross?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';   // baseline: horizontal only
  alignContent?: 'auto' | 'space-between';                          // wrapped lines
  sizing?: { width?: 'fixed' | 'hug' | 'fill'; height?: ... };       // the frame's own sizing
  min?: { width?, height? }; max?: { width?, height? };
  grid?: { columns?: number | Track[]; rows?: number | Track[] };    // Track: px | 'hug' | '2fr' | { fr: 2 }
};
// Child: node.data.childLayout
type AutoLayoutChild = {
  sizing?: { width?: 'fixed' | 'hug' | 'fill'; height?: ... };       // wins over layout.sizing on nested frames
  min?: { width?, height? }; max?: { width?, height? };
  absolute?: boolean;           // ignore auto layout, follow constraints instead
  constraints?: { horizontal?: 'left' | 'right' | 'leftRight' | 'center' | 'scale';
                  vertical?: 'top' | 'bottom' | 'topBottom' | 'center' | 'scale' };
  gridArea?: { column?, row?, columnSpan?, rowSpan?, alignX?, alignY? };   // 0-based anchors
};
```

- `layoutFrame(nodes, frameId, { measure })` lays out one frame (nested frames resized by fill are laid out again), `layoutAll(nodes)` lays out every frame children-before-parents so nested hugging settles in one pass, and `layoutUp(nodes, changedId)` / `layoutUpMany(nodes, ids)` lay out a changed frame and its auto layout ancestors only.
- **Sizing**: `fixed` keeps the size, `hug` fits the content plus padding (frames and text-like nodes), `fill` shares the free main-axis space like flexbox (min / max freeze and the rest is shared again) or stretches across. Fill on an axis the frame hugs reads as fixed. Min / max always apply; a frame is never smaller than its padding.
- **Alignment**: auto gaps (`space-*`) never go below 0; a single `space-between` child sits at the start. `stretch` makes fixed-size children fill across. `baseline` lines up the first text baseline (`measure.textBaseline`); nested horizontal frames use their first child's baseline, other nodes sit at the top.
- **Wrap**: lines break when the main axis runs out; each line distributes on its own. `alignContent: 'space-between'` spreads lines; lines of nothing but fill-across children stretch.
- **Grid**: `columns` / `rows` are counts (`1fr` each) or tracks. Fixed tracks keep their size, `hug` tracks fit their content, `fr` tracks share the rest like CSS (never below their content). Rows are added to fit the children. Anchored children (`gridArea.column` + `row`) are placed first, the rest flow in reading order; spans grow content-sized tracks. `alignMain` / `alignCross` align children in their cells, `gridArea.alignX/Y` override per child. `getAutoLayoutGrid(nodes, frameId)` returns the resolved tracks and cells.
- **Absolute children and constraints**: absolute children keep their place and follow `constraints` when the frame resizes (hug included). `applyConstraints(nodes, parentId, previousSize)` applies constraints to the children of any parent after it was resized (all children of a plain parent, absolute ones of a frame).
- **Measuring**: `measure.size(node)` defaults to `getNodeSize` (xyflow `measured`, then `width` / `height`, then style). Nodes for which `measure.textSize(node)` returns a natural size are text-like: hug width uses it (wrapping at `max.width` via `measure.textHeight(node, width)`), and a fill-width text with hug height re-wraps at the width it gets.
- `makeSizingCoherent(nodes, id, { measure })` downgrades `fill` without an auto layout parent (or with a parent hugging that axis) and `hug` on nodes that cannot hug to `fixed`, for the node and its children.
- Not modelled: rotation, strokes taking up space, and `reverse_z` canvas stacking (use `zIndex`).

#### Controller, React hook and Svelte rune

`createCanvasAutoLayoutController({ getNodes, setNodes, history?, measure?, enabled?, dragReorder?, onGuidesChange? })` (React: `useCanvasAutoLayout({ nodes, setNodes, history })`, Svelte: `createCanvasAutoLayout({ getNodes, setNodes, history })`):

- Actions, each one undoable step together with the relayout it causes: `addNode(node, { index? })`, `removeNodes(ids)` (descendants too), `resizeNode(id, { width?, height? })` (children follow constraints), `moveChild(id, index)`, `applyAutoLayout(frameId?)` (default: every frame).
- Flow-originated changes are derived and not recorded: React passes each `onNodesChange` batch through `autoLayout.noteChanges(changes)` before applying it, and the hook flushes once React commits. Measured sizes, resize ends (children follow constraints from the size the resize started at), added and removed nodes relayout their frames. Svelte: `handleChanges(changes)`, `nodesDeleted(nodes)` (`ondelete`), `measured(id)` and `<NodeResizer {...autoLayout.resizerHandlers(id)} />`.
- **Reorder by dragging**: a flow child dragged inside its frame shows a drop marker (`guides`, for `<CanvasGuidesLayer>`) and on drop moves to the slot under its centre (reading order for grid and wrapped frames) in one undoable step whose undo restores the position the drag began at. Svelte: `onnodedrag={({ targetNode }) => autoLayout.dragReorder(targetNode.id)}` and `onnodedragstop={({ targetNode }) => autoLayout.endReorderDrag(targetNode.id)}`. Order is the node-array order (`moveLayoutChild` keeps parents before children).
- The arrange controller takes `autoLayout: true | { measure }` to relayout frames around aligned, distributed or resized nodes in the same undo step.

### Design tokens (variables) and modes

`@pixerate/editor/tokens` (dependency-free) holds Figma-style variables: **collections** with **modes** (the first is the default, e.g. Light / Dark) and typed **variables** (`color`, `number`, `string`, `boolean`) with one value per mode. A value is a literal (colours are stored as lowercase `#rrggbb` / `#rrggbbaa`) or `{ alias: variableId }` to a variable of the same type, in any collection.

```ts
import { TokenStore, exportTokensCss, exportW3CTokensJson, importW3CTokens } from '@pixerate/editor/tokens';

const store = new TokenStore();
const theme = store.createCollection('Theme', ['Light', 'Dark']);
const bg = store.createVariable({ collectionId: theme.id, name: 'color/bg', type: 'color', values: { Light: '#fff', Dark: '#0f172a' } });
store.createVariable({ collectionId: theme.id, name: 'color/surface', type: 'color', value: { alias: bg.id } });
store.resolveValue(bg.id, { [theme.id]: theme.modes[1].id }); // '#0f172a'
exportTokensCss(store.getState()); // :root { --color-bg: #ffffff; … } :root[data-mode="dark"] { … }
```

- **Resolution**: `resolveToken(state, id, modes)` follows aliases, reading each variable in its own collection's mode from `modes` (collection id → mode id; the default mode otherwise). It returns `{ ok: true, value, chain }` or `{ ok: false, code: 'missing' | 'cycle' | 'no-value' | 'type-mismatch', message, chain }`; it never throws.
- **Aliases** must keep the type and must not lead back to the variable through any alias in any mode (`alias-cycle`, with the path in the message).
- **Store**: every edit is one undo step (`transact(label, fn)` groups several and rolls back if `fn` throws) and one change event `{ source, reason, state, previous, deletedVariableIds }`. Refused edits throw a `TokenError` with a `code` and change nothing. `getState()` is an immutable snapshot whose reference only changes on edits. `load(json)` reads untrusted data through `parseTokenState` (junk dropped, cycles broken, issues returned).
- **Rename / delete**: renaming keeps ids, so bindings keep working. Deleting a variable (or collection) makes variables aliasing it take its values per mode; bound canvas nodes are detached with `detachTokenBindings(nodes, event.previous, event.deletedVariableIds)` and keep their values.
- **Scopes** (`CORNER_RADIUS`, `GAP`, `SHAPE_FILL`, …) only filter pickers (`getTokensForProperty`); binding out of scope still works.
- **W3C Design Tokens**: `exportW3CTokens(state)` writes one top-level group per collection, `/` groups as nested groups, `$type` / `$value` (the default mode) and `{Collection.path}` references; modes, ids, scopes and units ride in `$extensions["com.pixerate.tokens"]`. `importW3CTokens(state, json, { collection?, mode? })` merges by name (ids kept), takes plain DTCG files (`color`, `number`, `dimension`, `duration`, `fontWeight`, `fontFamily`, `string`, `boolean`; group `$type` inherited; one mode per file via `mode`) and reports skipped entries as warnings.
- **CSS**: `exportTokensCss(state, { prefix, attribute, nested })` emits the default modes on `:root` and other modes on `:root[data-mode="dark"]` (aliases as `var(--target)`); `getTokenCssVariables(state, modes)` returns resolved properties for inline styles.

#### Binding node properties

Bindings live in node data and survive copy / paste, duplication and serialisation:

- `node.data.tokenBindings`: property key → variable id. Built-in keys (`CANVAS_TOKEN_PROPERTIES`): `fill` (`data.shape.fill`, else `style.backgroundColor` / `background`), `stroke`, `strokeWidth`, `opacity` (percent, like Figma: 40 → `style.opacity: 0.4`), `cornerRadius`, `gap`, `rowGap`, `padding`, `paddingHorizontal` / `Vertical` / `Top` / `Right` / `Bottom` / `Left` (auto layout frames), `textColor` (`style.color`), `fontSize`, `visible` (`hidden`). Pass `properties` to add your own `CanvasTokenProperty`.
- `node.data.tokenModes`: collection id → mode id, an explicit mode inherited by descendants (via `parentId`); the nearest ancestor wins, then the root `modes` option, then the default mode. Unknown modes count as Auto.

`resolveCanvasTokens(nodes, state, { modes })` writes every bound value into the ordinary node fields and returns the same array when nothing changed, so renderers and auto layout need no token awareness. `bindCanvasToken(nodes, ids, key, variableId | null, state)` binds (or unbinds, keeping the value) and `setCanvasTokenMode(nodes, ids, collectionId, modeId | null, state)` switches a frame's mode.

React: `useCanvasTokens({ store, nodes, setNodes, modes })` re-resolves on token and node changes and detaches on delete; `<TokenBindingPicker state nodes selectedIds onChange>` and `<TokenModeSwitcher state nodes nodeIds onChange>` are inspector controls, and `@pixerate/editor-react/tokens` has `useTokens(store, { modes })` (state, `cssVariables`, `css`) and `<TokensPanel store>`. Svelte: `createCanvasTokens({ store, getNodes, setNodes, modes })` (call `resolve()` after changing nodes yourself), the same components (`onchange`), and `createTokens` / `<TokensPanel>` in `@pixerate/editor-svelte/tokens`.

### Keyframe animation and timeline

A node's animation lives in `node.data.animation` (`ANIMATION_DATA_KEY`), so it copies, pastes, duplicates and serialises with the node. Each animatable property has a track of keyframes `{ time (ms), value, easing? }`. The easing applies to the segment *leaving* the keyframe.

```ts
import { animateNode, applyAnimation, exportCssAnimation, AnimationPlayer, ManualClock } from '@pixerate/editor/canvas';

let { nodes } = animateNode(nodes, 'card', { from: { opacity: 0 }, to: { x: 0, opacity: 1 }, duration: 600, easing: 'ease-out' });
const frame = applyAnimation(nodes, 300); // copies with the values at 300 ms; `nodes` is untouched
exportCssAnimation(nodes, 'card', { loop: 'ping-pong' }).css; // @keyframes … + an `animation` rule
```

- **Properties** (`ANIMATABLE_PROPERTIES`): `x`, `y`, `width`, `height`, `rotation` (degrees) and `scale`, `opacity` (0–1), `fill`, `stroke`, `strokeWidth`, `cornerRadius`, and `motionPath` (0–1 along `animation.motionPath.d`, with optional `autoRotate`; set it with `setMotionPath`). Rotation and scale are written to the CSS individual transform properties `style.rotate` / `style.scale`, so they compose with xyflow's `transform`. Fill, stroke, stroke width and corner radius use the same fields as token bindings (`data.shape.*` or `style`). Pass `properties` to add your own `AnimatableProperty`.
- **Easing**: `hold`, `linear`, the CSS presets `ease`, `ease-in`, `ease-out` and `ease-in-out` (CSS Easing Level 1 values), `ease-in-back` and `ease-out-back`, `{ type: 'cubic-bezier', x1, y1, x2, y2 }` (or a CSS `cubic-bezier()` string), and `spring` / `{ type: 'spring', stiffness, damping, mass, velocity }` (a closed-form damped spring that may overshoot). `easingFromInfluence(out, in)` builds the After Effects-style "influence" ease.
- **Evaluation**: `evaluateTrack` holds the first value before the first key and the last value after the last key. Unsorted keys are sorted. When several keys share a time, the later one in the array wins (`normalizeKeyframes`, cached per array, so treat keyframes as immutable). Numbers extrapolate, so overshooting easings also overshoot the value. Colours interpolate in OKLab with premultiplied alpha (`mixColorsOklab`), so a fade from `transparent` keeps the hue. `evaluateAnimation(doc, time)` returns `{ nodeId: { property: value } }`. `applyAnimationOverrides` writes those values into copies; nodes without values keep their identity. `wrapAnimationTime(t, duration, 'none' | 'loop' | 'ping-pong')` maps a running time onto the timeline.
- **Design tokens**: run `applyAnimation` *after* `resolveCanvasTokens`. Token values are then the stored base, and an animated property shows its keyframes while it is animated.
- **Editing** (pure, throws `AnimationEditError` without partial edits):
  - `setKeyframe`, `updateKeyframe`, `deleteKeyframes`. Deleting a track's last key keeps its value on the node.
  - `setKeyframeEasing`, `setTrackEnabled` (disabled tracks keep their keys), `removeTrack`.
  - `addKeyframesAtTime`: keys the values shown at a time.
  - `moveKeyframes`: one common delta across nodes and properties, clamped so the group keeps its spacing. Originals are removed before destinations are inserted, so keys can move into each other's old slots.
  - `scaleKeyframes`: around a pivot.
  - `snapKeyframeDelta`: group snapping to the nearest target within a threshold.
  - `copyKeyframes` / `pasteKeyframes`: relative times, onto other nodes.
  - `animateNode`.
- **Record mode**: `recordAnimationChanges(base, shown, edited, time, { recording })` turns edits made on the *displayed* nodes into stored edits:
  - A changed property that is already animated is keyed at `time`.
  - In record mode, any changed property is keyed. Its first key also adds a key at 0 with the previous value.
  - Everything else passes through as a static edit.
- **Player**: `new AnimationPlayer({ clock, duration, loop, playbackRate, onTime, onEnd })` has `play`, `pause`, `toggle`, `stop`, `seek`, and `scrub` / `endScrub` (scrubbing pauses, then resumes). It asks the clock for frames only while playing. Pass a `ManualClock` in tests or when rendering video. `getState()` is a cached snapshot.
- **Export**:
  - `sampleAnimationFrames(doc, { fps })`: the values at each frame.
  - `exportCssAnimation(nodes, id, { loop, playbackRate, selector })`: one `@keyframes` per CSS property, with per-segment `animation-timing-function` (`steps(1, end)` for hold, sampled `linear()` for springs). `x` / `y` become `translate` relative to the node's position.
  - `toWebAnimations` + `playWebAnimations(element, specs)`.
  - Tracks CSS cannot reproduce exactly are sampled and reported as `exact: false`: OKLab colours, `x` / `y` with different timing, and motion paths.
- **Controller**: `createCanvasAnimationController({ getNodes, setNodes, history, clock })` combines these.
  - Render `display()` (the nodes at the playhead) and send edits made on them back through `applyDisplayChanges(next)`. A drag that keys a property becomes one undo step, merged by tag.
  - Keyframe edits are undoable steps, and a selection follows moves.
  - `beginKeyframeDrag` / `updateKeyframeDrag(deltaMs, { snap, thresholdMs })` / `endKeyframeDrag` / `cancelKeyframeDrag` drag keyframes. They snap to other keys, the playhead, 0 and the end, and otherwise to whole frames. The preview is not an edit, and the drop is one undo step.
  - The timeline has a fixed `duration`, or follows the last key (at least `minDuration`).
- **Commands and agent tools**: `createCanvasAnimationCommands(controller)` (in `@pixerate/editor/commands`) registers:
  - `canvas.animation.togglePlay`, `play`, `pause`, `stop`, and `seek { time }`.
  - `addKeyframe { ids?, properties?, time? }`, `deleteKeyframes`, `setEasing { easing }`, `toggleRecord`, and `next` / `previousKeyframe`.
  - `animateNode { nodeId, to, from?, duration?, delay?, easing? }` and `exportCss { nodeId }`.

  Expose them to agents with `createCommandToolProvider`.

React: `useCanvasAnimation({ nodes, setNodes, history, clock })` returns the controller plus reactive `state`, `time`, `playing`, `recording`, `selection`, `drag` and `displayNodes`. Wire React Flow with `nodes={animation.displayNodes}` and `onNodesChange={(c) => animation.applyDisplayChanges(applyNodeChanges(c, animation.displayNodes))}`. `<AnimationTimeline animation width>` has:

- play / pause, a record toggle and add keyframe;
- a ruler you drag to scrub;
- one lane per animated property of the selected nodes. Keyframe diamonds drag with snapping. Alt turns snapping off, Escape cancels, Shift-click adds to the selection, and Delete removes.
- an easing picker for the selected keyframes, and the loop mode.

Svelte: `createCanvasAnimation({ getNodes, setNodes, history, clock })` with the same API (`displayNodes` is a reactive getter) and `<AnimationTimeline animation width>`.

### Components, instances and variants

Figma-style reusable components on any React Flow / SvelteFlow canvas whose frames are parent nodes (`parentId`). Everything lives in node `data`, so components and instances survive JSON, copy / paste and duplication.

- **Main component**: a node with `data.component` (`{ properties?, variant?, description? }`); its descendants are its layers. `createCanvasComponent(nodes, ids)` converts a single frame-like node (one with children, a `group` / `frame` type or auto layout) or wraps the selection in a new component frame (siblings only; never inside an instance).
- **Component set**: a node with `data.componentSet` whose child components are **variants** (`data.component.variant`, e.g. `{ Style: 'Primary', Size: 'Small' }`, named `Style=Primary, Size=Small`). `combineCanvasComponentsAsVariants(nodes, ids)` wraps sibling components in a set (names already in `Prop=Value` form are parsed, others become `Property 1=Default`, `Variant2`, …). The default variant is the one nearest the set's top-left corner; `getVariantConflicts` lists duplicate combinations.
- **Instance**: a node with `data.instance = { componentId, properties }`. `createCanvasInstance(nodes, componentOrSetId, { parentId?, position?, properties? })` copies the main's layers as real nodes; each copy records the main layer it mirrors in `data.componentSource` (ids default to `<instanceId>:<sourceId>`, see `idGenerator`).
- **Overrides**: edits to instance layers are recorded per layer in `data.componentOverrides` as property groups: `data.<key>` (e.g. `data.label`), `style.<prop>`, `shape.<key>`, `layout.<key>` (auto layout gap, padding, …), `token.<key>` (a different token binding), `tokenMode.<collection>`, `hidden`, `component` / `props` (a nested instance swapped or given other property values), `node.<key>` and, on the instance itself, `size`. Setting a value back to the main's clears its override; values written by a token binding or a component property are never overrides. The geometry of layers inside an instance follows the main, its constraints and auto layout (only the instance resizes, its layers following their constraints).
- **Propagation**: `syncCanvasComponents(before, after)` runs after any edit (the hooks call it on every node change): it records overrides on edited instance layers and rebuilds the instances of components whose layers changed (nested components first), keeping layer ids, overrides, property values, and each instance's own position, visibility, lock, `childLayout` and token modes. It returns `after` unchanged when there is nothing to do. Instances never gain or lose layers: deleting a layer inside an instance hides it (a `hidden` override); nodes added inside an instance move out next to it; a pasted copy of an instance layer stops mirroring the main, and a pasted nested instance becomes an instance of its own main. `syncAllCanvasInstances(nodes)` rebuilds everything (e.g. instances saved without their layers).
- **Variants and swaps**: `setCanvasInstanceProperties(nodes, ids, { Style: 'Secondary', Label: 'Buy' })` switches variants (matched by values; overrides stay where the layer's name path matches and both variants agreed on that property, text layers keep all of theirs) and sets component property values. `swapCanvasInstance(nodes, ids, componentId, { keepTextOverridesOnly? })` shows another main, keeping same-named property values and overrides matched by layer name. Name text layers with `data.name` when `data.label` is their content, so matching survives text that differs between variants.
- **Editing variants**: `addCanvasVariant(nodes, setId, { from?, variant?, position?, id?, defaultValue? })` duplicates a variant (default: the set's default variant) as a new component of the set with new ids (`<id>-<sourceLayerId>`) and the given values (unnamed properties keep the source's; without `variant`, the first property gets the next unused `Variant<n>`, see `getNextVariantValues`). A new property name is added to every other variant with `defaultValue` (`Default`), so the set stays consistent. The copy goes to the first free spot right of its source (the set grows to fit) or where the set's auto layout puts it. `removeCanvasVariant(nodes, variantId)` refuses the last variant; instances of the removed one switch to the closest remaining variant (most matching values, earlier properties first), keeping overrides like a variant switch, and instance swap values / defaults pointing at it follow. `setCanvasVariantProperties(nodes, variantId, values)` edits one variant's values; `renameCanvasVariantProperty(nodes, setId, name, newName)` and `renameCanvasVariantValue(nodes, setId, property, value, newValue)` rename across the set (instances keep their variant; their pickers show the new names). Every edit refuses a combination another variant already has, empty names, names with `,` or `=`, and names of component properties, with a reason.
- **Component properties**: `setCanvasComponentProperty(nodes, componentOrSetId, name, def | null, { newName? })` adds / edits / deletes `boolean`, `text` and `instanceSwap` properties (variants share their set's); `bindCanvasComponentProperty(nodes, layerId, field, name | null)` binds a main layer's `visible`, a `data.<key>` text field or a nested instance's `component`. Property values reach nested instances through their own properties (one level per source hop, like Figma).
- **Reset / push / detach**: `resetCanvasInstanceOverrides(nodes, id, group?)` resets one group, one layer, or a whole instance (its own size stays; property values go back to their defaults). `pushCanvasInstanceOverrides(nodes, id)` copies the instance's overrides to its main and so to every other instance. `detachCanvasInstance(nodes, ids)` turns an instance into a plain frame with the same look; nested instances become instances of their own mains (a nested instance alone can't be detached).
- **Deleted mains**: instances keep their layers in a `missing-main` state (`getInstanceStatus`); `restoreCanvasMainComponent(nodes, instanceId)` turns one back into the main with its old id (its layers take the ids their copies mirror, so every other instance re-links). Pasting an instance into a document without its main keeps the reference the same way.
- **Cycles**: an instance can't be placed in (or swapped / property-set into) a component it contains, directly or through nested instances (`wouldCreateComponentCycle`).
- **Tokens**: bindings (`data.tokenBindings`) are copied from the main and follow it unless the instance binds another variable; an instance's own `data.tokenModes` (e.g. Dark) resolves its layers in that mode. Pass `tokens: { state }` to resolve after a sync, or let `useCanvasTokens` / `createCanvasTokens` do it.
- **Queries**: `listCanvasComponents(nodes)` (components, sets, variant options, instance counts) and `inspectCanvasInstance(nodes, id)` (main, status, variant, properties, overrides per layer) feed panels and inspectors.

`createCanvasComponentsController({ getNodes, setNodes, history })` wraps all of this: `sync()`, `createComponent`, `combineAsVariants`, `createInstance`, `detachInstance`, `resetOverrides`, `pushOverrides`, `swapInstance`, `setInstanceProperties`, `restoreMainComponent`, `setComponentProperty`, `bindComponentProperty`, `addVariant`, `removeVariant`, `setVariantProperties`, `renameVariantProperty`, `renameVariantValue` (set / variant ids default to the selection's) and `goToMainComponent` (selects the main and calls `onReveal`), each one undoable step, each with a `can…` check returning `true` or the reason it can't run. `createComponentCommands(controller)` (`@pixerate/editor/commands`) registers them as `canvas.createComponent` (Mod+Alt+K), `canvas.detachInstance` (Mod+Alt+B), `canvas.resetOverrides`, `canvas.addVariant`, `canvas.removeVariant`, `canvas.setVariantProperties`, `canvas.renameVariantProperty`, `canvas.renameVariantValue`, … plus read-only `canvas.listComponents` / `canvas.inspectInstance`; `createCanvasComponentToolProvider(controller)` (`@pixerate/editor/agent`) exposes them as agent tools (`add_variant`, `remove_variant`, `set_variant_properties`, `rename_variant_property`, `rename_variant_value`, …).

React: `useCanvasComponents({ nodes, setNodes, history })` returns the controller and syncs after every node change; `<CanvasComponentsPanel nodes onInsert>` lists sets, variants and components (click to insert, or drag: read the id with `getCanvasComponentDragId(event.dataTransfer)`); pass `components` (and `onError`) to edit variants: "+ Variant" on each set, ⚙ to rename properties and values inline, and a ⋯ / right-click menu per variant to edit its values, duplicate or remove it; `<CanvasInstanceInspector nodes nodeId components onError>` shows variant pickers, property controls, overrides (each resettable) and Reset all / Go to main / Push changes / Detach (Restore for a missing main). Svelte: `createCanvasComponents({ getNodes, setNodes, history })` syncs when the nodes it reads change (`autoSync: false` to call `sync()` yourself; `destroy()` stops it) and the same components (`oninsert`, `onerror`).
