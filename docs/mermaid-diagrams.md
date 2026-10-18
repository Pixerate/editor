# Mermaid diagrams

`@pixerate/editor/diagram` reads and writes Mermaid without losing anything. `@pixerate/editor/canvas` puts flowchart, state, class and ER diagrams on a React Flow / Svelte Flow canvas, and draws the other editable families (sequence, Gantt, pie, quadrant, XY, radar, timeline, journey, mindmap, gitGraph, C4, architecture) the way Mermaid draws them. Ported from Ursula.

## What round-trips

- An untouched document serialises byte for byte: frontmatter, `%%{init}%%` directives, comments, blank lines, indentation, `\r\n` endings and anything the parser does not understand.
- An edit rewrites only the statements it touches. Renaming `A` in `A --> B & C` isolates `A` without reformatting the rest.
- Canvas positions, sizes and the viewport live in one comment after the header that Mermaid ignores:

  ```
  flowchart LR
    %% @pixerate {"v":1,"layout":{"A":[0,76],"B":[232,65]}}
    A[Start] --> B{Ok?}
  ```

  `requirementDiagram` rejects `%%` comments in its body, so it keeps them under a `pixerate:` frontmatter key. Ursula's `%% @ursula` comment and `ursula:` key are read too and rewritten as `@pixerate` on the next edit.
- Sixteen families are `editable`: flowchart, state, class and ER (graph grammars), and pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY (`xychart-beta`) and radar (`radar-beta`) through statement adapters. Each statement is edited on its own; lines the adapter does not model are kept verbatim.
- Sankey, block, packet, kanban, treemap and unknown input parse as `render-only` documents: their text is kept, and only `load` / `replaceSource` changes them. `parseSankey` and `parseTreemap` read sankey links and treemap hierarchies as data (never throwing; a `DiagramDataError` names the line).
- Charts (`xychart`, `pie`, `radar`) also have their own editor in `@pixerate/editor/chart`.

## Family vocabulary

`familyUI(family)` (from `@pixerate/editor/diagram`) describes what each family offers: its shapes, edge kinds, whether it has groups and a direction, a `nextId` for new nodes and `newNode` defaults, and its data fields. `nodeFields` are written with `setNodeData` (a pie slice's `value`, a Gantt task's `start` / `end` / `tags`, a quadrant point's `x` / `y`), `edgeFields` with `setEdgeData` (sequence activation, C4 technology, architecture sides) and `diagramFields` with `setGraphData` (pie `showData`, Gantt `dateFormat`, XY axes). `checkFieldData(fields, data, what, shape)` validates a patch against them. `FAMILY_TEMPLATES`, `FAMILY_BLANKS`, `FAMILY_TITLES` and `FAMILY_DESCRIPTIONS` are starter sources and labels for type pickers.

## Core

```ts
import { parseMermaid, applyEdits, DiagramController, findMermaidSources } from "@pixerate/editor/diagram";
import { mermaidToCanvas } from "@pixerate/editor/canvas";

const doc = parseMermaid("flowchart LR\n  A --> B");
const next = applyEdits(doc, [
  { type: "renameNode", id: "A", label: "Start" },
  { type: "setNodeShape", id: "B", shape: "diam" },
]);
next.source; // "flowchart LR\n  A[Start] --> B{B}"

const controller = new DiagramController({ source: next.source });
controller.apply({ type: "addEdge", edge: { source: "B", target: "A", label: "retry" } }, "Connect"); // one undo step
controller.undo();

const { nodes, edges, layout } = mermaidToCanvas(controller.getDocument(), { editable: true });
findMermaidSources(markdown); // [{ source, family, title? }] for each ```mermaid block
```

- `DiagramController` validates every edit against the document first (unknown ids, ids already taken, shapes the family does not have, groups in ER diagrams) and applies a batch all-or-nothing as one undo step. `beginGesture` / `endGesture` fold a drag into one step.
- `mermaidToCanvas` lays out with dagre (nested groups, per-group direction), keeps stored positions and blends new nodes in beside them. Node types are `mermaid-node` and `mermaid-group`; child positions are relative to their group.
- `mermaidMovesFromCanvas(layout, moved, all, { stored: doc.meta.layout })` turns a drop into a `moveNodes` edit. Pass `stored` so the rest of an auto-laid diagram is pinned where it is; without it, moving one node shifts the others (the blend aligns on the stored positions).
- `DiagramStream` follows Mermaid that is still arriving (a model's reply, prose before the fence included): nodes appear once an edge places them, and the layout is only recomputed when nodes, edges or groups change. `blendDiagramLayout` tweens between layouts.
- `mermaidShapePaths(shape, w, h)` draws the flowchart and state shapes as SVG paths; `mermaidNodePaint` maps Mermaid `style` / `classDef` to CSS custom properties.
- Families positioned by their data register a layout (`registerFamilyLayout`) that `ensureDiagramLayout(graph, meta, { family })` uses instead of dagre: pie slices share the pie's box, sequence participants sit in columns, Gantt bars on a date axis, and so on.

### Family pictures

`mermaidToScene(doc, { theme, selection })` draws a family as its own picture: a list of marks (`rect`, `path`, `circle`, `line`, `text`) in canvas coordinates. A mark's `target` is the node, edge or group it selects (`DIAGRAM_TITLE_TARGET` for the title); marks without one are decoration. It returns `null` for flowchart, state, class and ER (drawn as nodes and edges) and for text-only families. XY and radar charts are drawn with the chart module's layout.

`diagramRenameOp(doc, target, label)` turns a double-click on a mark into the right edit (`setTitle`, `renameGroup`, `setEdgeLabel` or `renameNode`). `registerFamilyScene` adds or replaces a family's drawing. `DIAGRAM_SCENE_LIGHT_THEME`, `DIAGRAM_SCENE_DARK_THEME` and `CSS_VARIABLE_DIAGRAM_SCENE_THEME` hold the colours.

## React and Svelte

| | React (`@pixerate/editor-react/canvas`) | Svelte (`@pixerate/editor-svelte/canvas`) |
| :--- | :--- | :--- |
| Editable diagram | `useMermaidDiagram(controllerOrOptions)` | `createMermaidDiagram(controllerOrOptions)` |
| Streaming view | `useMermaidStream(source, { complete })` | `createMermaidStream()` then `update(source, complete)` |
| Nodes | `<MermaidDiagramNode>`, `<MermaidDiagramGroup>` (pass handles as children) | same |
| Family pictures | `<MermaidFamilyScene scene onSelect onOpen>` | `<MermaidFamilyScene scene onselect onopen>` |

Both return `nodes`, `edges`, `layout`, `scene`, `source` and `moveNodes`, `connect`, `remove`, `rename`, `renameTarget`, `apply`, `load`, `undo`, `redo`. `scene` is the family's picture (null for node-and-edge families); render it with `MermaidFamilyScene`, select with `select([target])` and rename with `renameTarget(target, label)`. Pass `{ sceneTheme }` as the second argument (or in the options) for colours other than the page's CSS variables. The demo's Canvas tab wires them to React Flow (`apps/demo/src/components/MermaidDiagramDemo.tsx`).

## Agent tools

`createDiagramToolProvider(controller, { getPositions })` registers 23 tools: `get_diagram`, `export_diagram_mermaid`, `find_mermaid_diagrams` (always), and `load_diagram_mermaid`, `add_diagram_node`, `remove_diagram_nodes`, `rename_diagram_node`, `set_diagram_node_shape`, `set_diagram_node_style`, `set_diagram_node_data`, `connect_diagram_nodes`, `remove_diagram_edges`, `set_diagram_edge_label`, `set_diagram_edge_data`, `reconnect_diagram_edge`, `set_diagram_direction`, `set_diagram_title`, `set_diagram_settings`, `group_diagram_nodes`, `ungroup_diagram_group`, `move_diagram_nodes`, `undo_diagram`, `redo_diagram` (hidden while read-only). Write tools return the ids they created.

`get_diagram` lists each family's data fields (`fields.node`, `fields.edge`, `fields.diagram`, with types and ranges) and the current values (`data` on nodes and edges, `settings`). The three data tools check keys and value types against those fields before anything changes, and `null` clears a field. `add_diagram_node` uses the family's id scheme and defaults (a new pie slice gets `slice4` and a value of 10) and takes `data` for the rest. Pass `getPositions` (the canvas layout's positions) so `move_diagram_nodes` pins the rest of an auto-laid diagram.

## Export and thumbnails

`mermaidToSvg(doc, options)` draws a diagram as standalone SVG from its layout, using stored positions and auto-layout for the rest, so it matches the canvas. You can also pass the canvas' own `layout`. It needs no canvas, DOM or Mermaid runtime.

What it draws:
- groups
- nodes in their Mermaid shapes, with `style` / `classDef` colours
- class members and ER attributes
- edges with labels, dash patterns and arrow heads
- the other editable families as their picture (`mermaidToScene`)

Options:
- `theme`: concrete colours, because CSS variables do not apply inside an image. `DIAGRAM_SVG_LIGHT_THEME` and `DIAGRAM_SVG_DARK_THEME` are provided; family pictures also read the scene fields (`palette`, `grid`, `mutedText`), see `DIAGRAM_SCENE_DARK_THEME`.
- `padding`, `transparent`, `title`.
- `maxWidth` / `maxHeight`: fit the drawing inside a box without enlarging it.

Related helpers:
- `mermaidThumbnailSvg` fits within 240 × 160 by default.
- `rasterizeSvg(svg, { width, height, scale, maxSize, background })` makes a PNG in the browser through a canvas.
- `downloadDiagramPng(doc, options)` saves one.
- `diagramFileName` names files after the diagram's title.

`<MermaidThumbnail source maxWidth maxHeight theme fallback>` (React and Svelte) shows a static preview, or `fallback` for families that are kept as text.

For agents, pass `renderSvg` (and `rasterize` for PNG) to `createDiagramToolProvider`. That adds `render_diagram { format: "svg" | "png", maxWidth, maxHeight }`, so a model can look at the diagram it is editing.

## Agent cursors

`DiagramDirector` acts agent edits out on the canvas (Ursula's remote control): the cursor moves to the node, clicks, drags nodes live, draws connections from source to target and types labels, then the edit lands. Each call is one undo step. The whole batch is checked before the cursor moves; if the diagram changes underneath (the user deletes the target), the call's earlier edits are rolled back and the call fails with a sentence. A new node is placed one rank along the diagram's direction from the node it is connected from, clear of other nodes, and the rest of an auto-laid diagram is pinned first so nothing shifts. `playSource` draws a whole-diagram write statement by statement when it extends what is there (`draftFrames`).

```ts
import { DiagramDirector, PresenceStore, createDiagramToolProvider } from "@pixerate/editor/diagram";

const presence = new PresenceStore();
const director = new DiagramDirector(controller, presence, { placement: () => mermaidToCanvas(controller.getDocument()).layout });
registry.register(createDiagramToolProvider(controller, { director, actor: { id: "agent", name: "Agent" } }));
```

`planDiagramEdit` is pure (same document, placement and edit give the same steps) and the clock is injectable (`createInstantPresenceClock`), so performances are repeatable in tests. React: `useDiagramDirector(controller, { placement })` and `<DiagramPresenceLayer presence viewport>`; Svelte: `createDiagramDirector` and the same component. The presence store, clock, cursor tween and per-actor queue live in `@pixerate/editor/animation` and are shared with `ChartDirector`.
