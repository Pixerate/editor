---
name: pixerate-diagram-process-flow
description: The process flow workflow in the Pixerate diagram editor - mapping a process as a Mermaid flowchart with one direction, terminals for start and end, verb-phrase steps, decisions as short questions with labelled exits, loops back to the right step, swimlanes for who does what, consistent shapes, and checking the result reads at its final size. Use when asked to draw, map, document or tidy a process, workflow, procedure, approval flow, decision tree, user flow or swimlane diagram, or when load_diagram_mermaid, add_diagram_node, connect_diagram_nodes or group_diagram_nodes are available. Load with pixerate-diagram, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-diagram
---

# Mapping a process

A process flow answers "what happens next, and who does it?". It reads in one direction from a
single start to its end(s); every step is an action, every decision a question with labelled
answers, and loops go back to the step that repeats. Lanes show who does each step. Write a
new flow as one Mermaid text; change an existing one with the per-operation tools so the
user's formatting stays.

This skill is the method. `pixerate-diagram` has the full tool reference and the shapes.

## Goal and quality bar

- A `flowchart` in one direction: `LR` for a process that reads like a sentence, `TB` for a
  decision tree or a long procedure.
- One start and clear ends as terminals (`stadium` or `rounded`); steps as `rect` with a verb
  phrase ("Validate order"); decisions as `diam` with a short question ("Paid?").
- Every exit of a decision is labelled ("yes" / "no", or the outcome); conditions live on
  edges, not inside nodes.
- Loops return to the step that repeats; no dead ends except the ends.
- Lanes (subgraphs) for who does what, when more than one actor is involved.
- Labels of at most five or six words; stable, readable ids (`validate`, `paid`).

## Inputs to confirm

- **Start and end:** what triggers the process and what counts as done (there may be several
  ends: shipped, cancelled).
- **Actors** for lanes, if more than one.
- **Level of detail:** the happy path only, or every exception.

## Working method

1. **Read.** `get_diagram` (and `find_mermaid_diagrams` for Mermaid in the user's text).
   **Check:** the family and the existing ids.
2. **List the steps and decisions** in order, with who does each, before writing.
3. **Write it.** New flow: one `load_diagram_mermaid` with the whole text (header, nodes with
   shapes, edges with labels, `subgraph` lanes). Existing flow: `add_diagram_node` with `from`,
   `connect_diagram_nodes`, `rename_diagram_node`, `set_diagram_node_shape`.
   **Check:** the result's counts and `diagnostics`; `get_diagram` nodes, edges and groups.
4. **Decisions.** Each `diam` node has a question label and exactly the exits it needs, each
   labelled (`set_diagram_edge_label`).
   **Check:** every edge leaving a decision has a `label`.
5. **Lanes.** `group_diagram_nodes` per actor with a clear `label` ("Customer", "Shop").
   **Check:** each node's `parentId` is its actor's lane.
6. **Look.** `render_diagram` once: crossings, long labels, crowding. Shorten labels, reorder,
   or switch direction (`set_diagram_direction`) if it reads badly.

## Decision table

| Element | Shape and label |
| --- | --- |
| Start, end | `stadium` or `rounded`: "Order received", "Done" |
| Step | `rect`: a verb phrase |
| Decision | `diam`: a short question; labelled exits |
| Data store | `cyl` |
| Document produced | `doc` |
| Call into another process | `subproc` |
| Input or output | `lean-r` / `lean-l` |
| Several actors | `subgraph` lanes via `group_diagram_nodes` |

## Recipes

**A new flow.** `load_diagram_mermaid` with `source`: `flowchart LR` then
`start([Order received]) --> validate[Validate order]`, `validate --> paid{Paid?}`,
`paid -->|yes| ship[Ship order]`, `paid -->|no| remind[Send reminder]`, `remind --> paid`,
`ship --> done([Done])`.

**Swimlanes.** `group_diagram_nodes` `{ nodeIds: ["place", "pay"], label: "Customer" }` and
the same for each actor.

**Tidy a decision.** `rename_diagram_node` to a short question; `set_diagram_edge_label` on each
exit ("yes", "no").

## Pitfalls

- **Conditions inside the node** ("Paid? if yes ship") make the exits unreadable; label edges.
- **Unlabelled decision exits** leave the reader guessing which way is which.
- **Mixed directions** and long back-edges tangle the flow; keep one direction and short loops.
- **A shape for two meanings** (rect for steps and data) breaks the reader's legend.
- **Rewriting a user's diagram** with `load_diagram_mermaid` loses their formatting and comments;
  use the per-operation tools for changes.
- **Too much detail**: exceptions for every step bury the main path; ask what level is wanted.

## Tools used

- `get_diagram`, `find_mermaid_diagrams`, `render_diagram`: read, find and look
- `load_diagram_mermaid`: write a new flow in one call
- `add_diagram_node`, `connect_diagram_nodes`, `remove_diagram_nodes`, `remove_diagram_edges`: change the flow
- `rename_diagram_node`, `set_diagram_node_shape`, `set_diagram_edge_label`: labels and shapes
- `group_diagram_nodes`, `ungroup_diagram_group`: lanes
- `set_diagram_direction`, `set_diagram_title`: layout and title
- `undo_diagram`: take back a step
