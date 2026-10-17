# Mermaid diagrams

`@pixerate/editor/diagram` reads and writes Mermaid without losing anything, and `@pixerate/editor/canvas` puts flowchart, state, class and ER diagrams on a React Flow / Svelte Flow canvas. Ported from Ursula.

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
- Families other than flowchart, state, class and ER (sequence, Gantt, pie, …) parse as `render-only` documents: their text is kept, and only `load` / `replaceSource` changes them. Charts (`xychart`, `pie`, `radar`) have their own editor in `@pixerate/editor/chart`.

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

## React and Svelte

| | React (`@pixerate/editor-react/canvas`) | Svelte (`@pixerate/editor-svelte/canvas`) |
| :--- | :--- | :--- |
| Editable diagram | `useMermaidDiagram(controllerOrOptions)` | `createMermaidDiagram(controllerOrOptions)` |
| Streaming view | `useMermaidStream(source, { complete })` | `createMermaidStream()` then `update(source, complete)` |
| Nodes | `<MermaidDiagramNode>`, `<MermaidDiagramGroup>` (pass handles as children) | same |

Both return `nodes`, `edges`, `layout`, `source` and `moveNodes`, `connect`, `remove`, `rename`, `apply`, `load`, `undo`, `redo`. The demo's Canvas tab wires them to React Flow (`apps/demo/src/components/MermaidDiagramDemo.tsx`).

## Agent tools

`createDiagramToolProvider(controller, { getPositions })` registers 19 tools: `get_diagram`, `export_diagram_mermaid`, `find_mermaid_diagrams` (always), and `load_diagram_mermaid`, `add_diagram_node`, `remove_diagram_nodes`, `rename_diagram_node`, `set_diagram_node_shape`, `set_diagram_node_style`, `connect_diagram_nodes`, `remove_diagram_edges`, `set_diagram_edge_label`, `reconnect_diagram_edge`, `set_diagram_direction`, `group_diagram_nodes`, `ungroup_diagram_group`, `move_diagram_nodes`, `undo_diagram`, `redo_diagram` (hidden while read-only). Write tools return the ids they created. Pass `getPositions` (the canvas layout's positions) so `move_diagram_nodes` pins the rest of an auto-laid diagram.

## Agent cursors

`DiagramDirector` acts agent edits out on the canvas (Ursula's remote control): the cursor moves to the node, clicks, drags nodes live, draws connections from source to target and types labels, then the edit lands. Each call is one undo step. The whole batch is checked before the cursor moves; if the diagram changes underneath (the user deletes the target), the call's earlier edits are rolled back and the call fails with a sentence. A new node is placed one rank along the diagram's direction from the node it is connected from, clear of other nodes, and the rest of an auto-laid diagram is pinned first so nothing shifts. `playSource` draws a whole-diagram write statement by statement when it extends what is there (`draftFrames`).

```ts
import { DiagramDirector, PresenceStore, createDiagramToolProvider } from "@pixerate/editor/diagram";

const presence = new PresenceStore();
const director = new DiagramDirector(controller, presence, { placement: () => mermaidToCanvas(controller.getDocument()).layout });
registry.register(createDiagramToolProvider(controller, { director, actor: { id: "agent", name: "Agent" } }));
```

`planDiagramEdit` is pure (same document, placement and edit give the same steps) and the clock is injectable (`createInstantPresenceClock`), so performances are repeatable in tests. React: `useDiagramDirector(controller, { placement })` and `<DiagramPresenceLayer presence viewport>`; Svelte: `createDiagramDirector` and the same component. The presence store, clock, cursor tween and per-actor queue live in `@pixerate/editor/animation` and are shared with `ChartDirector`.
