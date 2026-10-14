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
| [`ShapeNode` / shape operations](#shape-nodes-and-boolean-operations) | Shape nodes (rect, ellipse, polygon, star, SVG path) and Unite / Intersect / Subtract / Exclude / Divide. |
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
- **Curves**: the result is fitted with cubic Béziers by default (`curves: 'fit'`), so the union of two ellipses comes back as a handful of smooth curves instead of a long polyline. Corners turning more than `cornerAngleDeg` (default 30°) and straight edges stay sharp; rings that would not get lighter (plain polygons) keep their straight segments. `curves: 'lines'` writes the polygon as before.
- Options: `tolerance` (curve flattening, default 0.25 flow units), `curves`, `curveTolerance` (default `tolerance`), `cornerAngleDeg`, `precision` (path decimals, default 3), `simplify` (Ramer–Douglas–Peucker tolerance, default off), `epsilon`, `createId`, `nodeType`, `select`.

No default keyboard shortcuts are bound for these operations.

#### Geometry helpers

- `polygonBoolean(op, operands, { epsilon })`: `'union' | 'intersection' | 'difference' | 'xor'` on any number of operands. An operand is a multi-polygon (`[[outer, ...holes], ...]`, any ring orientation) or `{ rings, fillRule }` (e.g. flattened path data; may self-intersect). Also `unionPolygons`, `intersectPolygons`, `subtractPolygons`, `xorPolygons` and `dividePolygons(operands)` (pieces with the operand indices covering them).
- Results are simple rings: outer rings have a positive shoelace area and holes a negative one. Rings may touch at a vertex but never cross. Collinear vertices are removed.
- `fitCubics(points, tolerance, { cornerAngleDeg, closed })` fits cubic segments (Schneider-style least squares with Newton reparameterisation, split at the worst point) so every point is within `tolerance`, keeping corners sharper than `cornerAngleDeg` (default 30°; the turn is measured over 4 × `tolerance`, so sample noise does not read as corners). `fitPathData(ring, { tolerance, closed, precision, offset })` returns SVG path data (`C` curves, `L` for straight stretches); `fitFreehandPath(points, { tolerance })` smooths a freehand stroke into an open path.
- `parseSvgPath(d)` (absolute `M`/`L`/`C`/`Q`/`A`/`Z`), `flattenSvgPath(d, { tolerance })`, `shapeToPolygon(shape, size)`, `shapeNodeToPolygon(node, lookup)`, `polygonToSvgPath(multi, { precision, simplify, offset, curves })`, `simplifyRing`, `getShapeSvg` / `getShapeRenderData` (exact arcs for rendering), `polygonArea`, `multiPolygonArea`, `pointInRings`.

The engine builds a planar overlay of all edges (splitting at crossings, T-junctions and collinear overlaps, merging points closer than `epsilon`), classifies both sides of every edge by winding number and traces the boundary of the selected region. It handles shared edges, touching vertices, collinear overlaps, holes, nested and disjoint inputs. Limits: the overlay is O(n²) in edges (pruned by a sweep), comfortable for canvas shapes (two 1,024-vertex circles in about 20 ms) but not GIS-scale data; features narrower than `epsilon` (default `1e-9` × the largest coordinate) collapse; curves are flattened to polylines for the overlay; `combineShapeNodes` fits curves back onto the result (see `curves`).

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
