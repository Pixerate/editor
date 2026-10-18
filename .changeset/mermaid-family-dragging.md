---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Mermaid family pictures can be edited by dragging, as in Ursula: Gantt bars to new dates or rows (a selected bar's grip resizes it, its knob onto another task adds a dependency), journey faces to a new score, quadrant points, participants, journey tasks, timeline periods and sequence messages to reorder, mindmap topics onto a new parent, a gitGraph branch tip onto another to merge, and C4 / architecture nodes anywhere, into or out of groups. `withDiagramDragHandles`, `planDiagramDrag` and `previewDiagramDrag` (core) do the work; `<MermaidFamilyScene onDragEnd>` with `useMermaidDiagram().drop` / `createMermaidDiagram().drop` wire it up. Agents get `reorder_diagram_node` (and `planDiagramReorder`) and `set_diagram_node_parent`.
