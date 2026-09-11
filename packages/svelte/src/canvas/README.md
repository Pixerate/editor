# @pixerate/editor-svelte/canvas

A headless, unstyled Svelte 5 runes architecture for building interactive graph, flow, and diagramming canvas experiences on top of SvelteFlow (`@xyflow/svelte`).

---

## Philosophy & Core Principles

1. **Headless & UI-Agnostic**: Contains zero assumptions about styles, colors, DOM presentation, or application-specific AI pipelines. Pure business logic, coordinate mathematics, and interaction controllers.
2. **Svelte 5 Runes First**: Implemented using `$state.raw`, `$derived`, and modern functional runes instead of `.svelte` component-as-controller wrappers.
3. **High Performance**: Eliminates expensive per-frame array clones during animations and node dragging, avoiding requestAnimationFrame memory churn.
4. **Decoupled Architecture**: Independent modules for graph state, clipboard serialization, Dagre auto-layout, docking/intersections, and hotkeys that can be used together or individually.

---

## Module Overview

| Module | Purpose |
| :--- | :--- |
| [`createCanvasGraph.svelte.ts`](./createCanvasGraph.svelte.ts) | Reactive graph state management, node deduplication, edge-preserving replacement, and diff calculation. |
| [`createCanvasClipboard.svelte.ts`](./createCanvasClipboard.svelte.ts) | Serialized JSON clipboard management, UUID remapping, position offset, URL and text pasting. |
| [`createCanvasDocking.svelte.ts`](./createCanvasDocking.svelte.ts) | Drag-to-dock intersection tracking, dock target hover/leave/drop lifecycle, and connection state. |
| [`createCanvasLayout.ts`](./createCanvasLayout.ts) | Dagre hierarchical auto-layout, viewport centering, and bounding box math. |
| [`createCanvasShortcuts.ts`](./createCanvasShortcuts.ts) | Global keyboard shortcut binding with automatic suppression during active text editing. |
| [`createCanvasInteractions.svelte.ts`](./createCanvasInteractions.svelte.ts) | Spacebar panning toggle, trackpad pinch detection, and SvelteFlow interaction presets. |
| [`types.ts`](./types.ts) | Shared generic types (`CanvasNode`, `CanvasEdge`, `GraphDifferences`, `CanvasLayoutOptions`, etc.). |

---

## Quickstart & Usage

### 1. Basic Setup

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

## API Reference

### `createCanvasGraph<TNode, TEdge>(options?)`

Creates a reactive graph controller managing nodes and edges.

#### Parameters (`options`):
- `initialNodes?: TNode[]`: Initial node list.
- `initialEdges?: TEdge[]`: Initial edge list.
- `onNodesChange?: (nodes: TNode[]) => void`: Callback fired when nodes change.
- `onEdgesChange?: (edges: TEdge[]) => void`: Callback fired when edges change.
- `onSave?: () => void`: Optional persistence trigger.
- `createEdge?: (sourceId, targetId, options?) => TEdge`: Edge factory function.

#### Returns:
- `nodes`: Getter/setter for active nodes array.
- `edges`: Getter/setter for active edges array.
- `addNodeOrNodes(nodeOrNodes, animateFromPosition?, options?)`: Adds nodes with deduplication and optional positioning animation.
- `addEdge(edge, options?)` / `addEdges(edges, options?)`: Adds edges.
- `removeNodes(nodesToRemove, options?)` / `removeEdges(edgesToRemove, options?)`: Removes entities by ID.
- `replaceNode(oldNode, newNode, save?, keepEdges?)`: Replaces a node, optionally updating connected edge endpoints.
- `addConnectedNodes(params)`: Connects incoming and outgoing nodes to a batch of added nodes.
- `getDifferences(baseline)`: Returns `{ changedNodes, changedEdges, removedNodes, removedEdges }`.

---

### `createCanvasLayout`

Pure geometry and Dagre layout calculations:

- `getLayoutedNodes(nodes, edges, getNodesBounds, options?)`: Automatically lays out graph nodes hierarchically (`'LR'`, `'TB'`, `'RL'`, or `'BT'`).
- `getCenteredNodePosition(width, height, screenToFlowPosition, screenDimensions?)`: Computes top-left coordinate to center an element in view.
- `centerNodes(nodes, screenToFlowPosition, getNodesBounds, screenDimensions?)`: Translates a collection of nodes so their bounding box is centered in the current viewport.

---

### `createCanvasClipboard(options?)`

Headless clipboard interaction:

- `copySelectedNodes(nodes, edges?, event?)`: Serializes nodes to clipboard as JSON.
- `cutSelectedNodes(nodes, edges?, onRemove?, event?)`: Copies and calls deletion callback.
- `handlePasteEvent(event)`: Intelligently handles paste events, disambiguating images, serialized nodes, URLs, and plain text.

---

### `createCanvasDocking(options?)`

Drag-and-dock interaction tracking:

- `handleNodeDragStart({ targetNode, event })`: Starts drag tracking.
- `handleNodeDrag({ targetNode, event }, getIntersectingNodes)`: Computes intersections, firing `onDockHover` and `onDockLeave`.
- `handleNodeDragStop({ targetNode, event }, getIntersectingNodes, updatePosition?)`: Fires `onDockDrop` and cleans up state.
- `handleConnectStart` / `handleConnectEnd`: Tracks connection handle dragging.

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
