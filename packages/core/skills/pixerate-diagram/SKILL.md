---
name: pixerate-diagram
description: How to build and edit Mermaid diagrams in the Pixerate diagram editor through its agent tools - flowchart, state, class, ER, sequence, Gantt, pie, mindmap, quadrant, C4, architecture, gitGraph, timeline, journey, XY and radar diagrams; adding, connecting, renaming, reshaping and styling nodes, edge labels, subgraphs and groups, layout direction (LR, TB), node and edge data fields, titles, canvas positions, finding Mermaid in Markdown, and rendering to check the result. Use when diagram tools (get_diagram, add_diagram_node, load_diagram_mermaid...) are available or the user asks for a flowchart, process map, state machine, sequence diagram, org or architecture diagram in Mermaid.
---

# Mermaid diagrams

The diagram editor holds one Mermaid document. Its text is the source of truth: every edit
rewrites only the statements it touches, and untouched statements, comments, directives and
formatting round-trip byte for byte. Canvas positions live in one `%% @pixerate {...}`
comment that Mermaid ignores.

`get_diagram` describes the document as a graph: the `family` (flowchart, state, class, er,
pie, mindmap, quadrant, c4, architecture, sequence, gitGraph, gantt, timeline, journey,
xychart, radar), `direction`, `title`, `nodes` (Mermaid ids such as `A` or `n3`, label,
shape, `parentId`), `edges` (ids such as `L_A_B_0`, source, target, label), `groups`
(subgraphs, composite states, namespaces, sections, boxes, boundaries), the `shapes` the
family allows, its data `fields` and current `settings`. Non-graph families map onto the
same model: a pie slice, Gantt task, quadrant point or sequence participant is a node
whose values live in `data`. Sankey, block, packet, kanban and treemap are kept as text
only (`editable: false`): change them with `load_diagram_mermaid`.

Read `pixerate-agent-tools` first for tool naming, errors and batching. Data charts (bar,
line, pie with styling, trendlines) belong in the chart editor (`pixerate-chart`); Mermaid
`xychart-beta`, `pie` and `radar-beta` text can move between the two.

## Working method

1. **Read.** `get_diagram` (with `includeSource: true` when you need the text). Note the
   family, the ids, the allowed `shapes` and `fields`. For Mermaid in a user's Markdown or
   chat, `find_mermaid_diagrams` first.
2. **Plan the structure** before writing: the family, the flow direction, the nodes and
   their kinds, the groups. Sketch it as Mermaid in your head.
3. **Write.** For a new diagram or a rewrite, send the whole text once with
   `load_diagram_mermaid`. For changes to an existing diagram, use the per-operation tools
   (`add_diagram_node` with `from` to add and connect in one call, `rename_diagram_node`,
   `connect_diagram_nodes`...): they keep the user's formatting and comments.
4. **Check.** Read the returned ids and any `diagnostics`; fix parse problems before going
   on.
5. **Look.** `render_diagram` (`format: "png"` when offered) after a batch of edits to
   check crossings, crowding and label length. Undo your own mistakes with `undo_diagram`.

## Best practices

- **Choose the family by the question.** Process or decision logic: flowchart. Lifecycle of
  one thing with events: state. Messages between parties over time: sequence. Data model:
  ER (tables and cardinality) or class (types and methods). Schedule: Gantt. System context
  and containers: C4 or architecture. Brainstorm or hierarchy: mindmap. Two-axis
  prioritisation: quadrant. History: timeline or gitGraph. Numeric series: the chart editor.
- **One direction, matched to the content.** `LR` for processes and pipelines read like a
  sentence; `TB` for hierarchies and decision trees. Set it once (`set_diagram_direction`);
  do not mix directions except per-subgraph when a group is clearly separate.
- **Concise labels.** Verb phrases for steps ("Validate order"), noun phrases for things,
  short questions for decisions ("Paid?"), at most five or six words. Put conditions on the
  edges leaving a decision ("yes" / "no"), not in the node. Stable short ids (`validate`,
  `paid`) beat `A`, `B`, `C` when the user will read the source.
- **Consistent shape semantics.** In flowcharts: `rounded` or `stadium` for start and end,
  `rect` for steps, `diam` for decisions, `cyl` for data stores, `doc` for documents,
  `subproc` for a call into another process, `lean-r` / `lean-l` for input and output. Use
  each shape for one meaning only. In state diagrams use `choice`, `fork` and `join` for
  branching and concurrency.
- **Group to reduce noise.** Put related nodes in a subgraph (`group_diagram_nodes`) by
  owner, system or phase (swimlane style); keep to one or two levels of nesting.
- **Limit crossings and fan-out.** Keep each node to a few edges; order statements so the
  main path runs straight; split very large diagrams (more than about 20-30 nodes) into an
  overview plus detail diagrams rather than one dense graph. Every node should be reachable;
  remove orphans.
- **Style sparingly.** `set_diagram_node_style` to highlight the one or two nodes the
  reader should look at (the error path, the changed step), not to decorate every node.
  Keep enough contrast between fill and text, and do not rely on colour alone.
- **Title it** (`set_diagram_title`) with what the diagram shows.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_diagram` | Start here. Returns family, editable flag, direction, title, nodes, edges, groups, allowed shapes, settings, data fields (`fields.node`, `fields.edge`, `fields.diagram` with types and ranges), stored positions, parse diagnostics, the selection and the read-only reason. `includeSource` (default false) adds the Mermaid text. |
| `export_diagram_mermaid` | Get the Mermaid text to hand back to the user or paste into Markdown. `withLayout` (default true) keeps the `%% @pixerate` positions comment; pass false for plain Mermaid. |
| `find_mermaid_diagrams` | Find every Mermaid diagram in a piece of `text` (fenced ```mermaid blocks, a chat reply or a bare diagram). Returns each source, family and title; pass one source to `load_diagram_mermaid`. Changes nothing. |
| `render_diagram` | Draw the diagram without changing it: SVG text by default, `format: "png"` when the host can rasterize; `maxWidth` / `maxHeight` fit it in px. Only listed when the host can render. Refuses text-only families. Render after a batch of edits, not after each one. |

### Write

Write tools are hidden while the diagram is read-only. Each call is checked against the
diagram first (unknown ids, taken ids, shapes the family lacks), applies as one undo step and
returns what it created or changed. All but `load_diagram_mermaid` and undo / redo refuse
text-only families.

| Tool | Use it to |
| --- | --- |
| `load_diagram_mermaid` | Replace the whole diagram with Mermaid `source` (fenced or bare; must start with a header such as `flowchart LR`). Use for new diagrams, wholesale rewrites and text-only families. Returns family, editable flag, node and edge counts and diagnostics. Rewrites the user's formatting, so prefer the per-operation tools for small changes. |
| `add_diagram_node` | Add a node with `label` (required); optional `id` (default the family's next free id), `shape`, `data` (family node fields), `parentId` (group), `from` plus `edgeLabel` to connect from an existing node, and `x` / `y` together in canvas px. Returns the node and any edge created. |
| `remove_diagram_nodes` | Delete nodes (`ids`) and every edge touching them. A group id removes the group but keeps its contents. Returns removed node and edge ids. |
| `rename_diagram_node` | Change the label of a node or group (`id`, `label`). |
| `set_diagram_node_shape` | Change a flowchart or state node's `shape` to one of the names `get_diagram` lists (such as `rect`, `rounded`, `stadium`, `diam`, `cyl`, `circle`, `hex`, `doc`). |
| `set_diagram_node_style` | Replace a node's inline Mermaid `styles` with `property:value` strings, e.g. `["fill:#fde68a", "stroke:#b45309", "stroke-width:2px"]`; an empty list removes them. |
| `set_diagram_node_data` | Set node field values (`id`, `data`): a pie slice `value`, Gantt `start` / `end`, quadrant `x` / `y`, journey score, XY series values, C4 technology. Keys and types come from `fields.node`; `null` clears a field. |
| `connect_diagram_nodes` | Draw an edge from `source` to `target` (existing node ids) with an optional `label`. Returns the edge id. |
| `remove_diagram_edges` | Delete edges by `ids`; the nodes stay. |
| `set_diagram_edge_label` | Set an edge's `label` by edge `id`; `""` removes it. |
| `set_diagram_edge_data` | Set edge field values (`id`, `data`): sequence activation, C4 relation technology, architecture sides. Keys from `fields.edge`; `null` clears. |
| `reconnect_diagram_edge` | Move an edge to a new `source` and `target`, keeping label and style. The returned edge id may change; use it from then on. |
| `set_diagram_direction` | Set the flow `direction`: `TB` / `TD`, `BT`, `LR` or `RL`. Refused by families whose layout follows their data (pie, sequence, Gantt...). |
| `set_diagram_title` | Set the `title` shown above the diagram, or `null` to remove it. |
| `set_diagram_settings` | Set diagram-level fields (`data`): pie `showData`, Gantt `dateFormat` and `excludes`, quadrant axis labels, XY categories and axis range, sequence autonumbering. Keys from `fields.diagram`; `null` clears. |
| `group_diagram_nodes` | Put `nodeIds` into a new group with `label` (optional `id`, default the next `G<number>`): a flowchart subgraph, composite state, class namespace, or the family's own group kind. Refused by families without groups (ER, pie, mindmap, quadrant, XY, radar). |
| `ungroup_diagram_group` | Remove a group by `id`; its nodes move to the group's parent. |
| `move_diagram_nodes` | Place nodes or groups on the canvas: `moves` of `{ id, x, y }` (top-left, canvas px). Stored in the `%% @pixerate` comment only; Mermaid statements and other renderers are unaffected. |
| `undo_diagram` | Undo the last diagram edit; returns its label. |
| `redo_diagram` | Redo the last undone diagram edit. |

## Pitfalls

- Ids are Mermaid ids, not labels. Always take them from `get_diagram` or from what a write
  returned; a custom `id` must match `^[A-Za-z0-9_][\w.-]*$` and not be taken.
- `load_diagram_mermaid` takes exactly one diagram. Text with several fenced diagrams is
  refused; pick one with `find_mermaid_diagrams`. Text without a Mermaid header is refused
  and nothing changes.
- Shapes only apply to flowchart and state nodes; class and ER have none. A shape name not
  in `get_diagram`'s `shapes` is refused.
- Data tools check keys and types against the family's fields before changing anything.
  Read `fields` first rather than guessing keys.
- Moving one node of an auto-laid diagram can shift the others when the host does not pin
  current positions; check with `render_diagram` after `move_diagram_nodes`, and prefer
  letting the layout place nodes (omit `x` / `y`) unless the user asked for a position.
- Mermaid label text with quotes, brackets or `#` may need quoting in the source; the
  per-operation tools quote flowchart labels when needed, so prefer them over hand-written
  text when labels contain punctuation, and check `diagnostics` after a `load_diagram_mermaid`.
- `export_diagram_mermaid` with `withLayout: false` is for plain Mermaid readers; keep the
  comment when the text will come back into a Pixerate editor.
- When the diagram is read-only, only the read tools are listed and `get_diagram` returns
  the reason. Tell the user; do not try to edit around it.
