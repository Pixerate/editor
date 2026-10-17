---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add Mermaid diagrams (ported from Ursula): `@pixerate/editor/diagram` parses and writes flowchart, state, class and ER diagrams losslessly (untouched statements round-trip byte for byte, edits rewrite only what they touch, positions in a `%% @pixerate` comment; Ursula's `@ursula` comment is still read), with `DiagramController` (validated, undoable edits), `findMermaidSources` and 19 agent tools (`createDiagramToolProvider`). `@pixerate/editor/canvas` adds `mermaidToCanvas` (dagre layout with nested groups, stored positions blended with new nodes), `mermaidMovesFromCanvas`, `DiagramStream` for diagrams that are still being written, and Mermaid shape geometry. React adds `useMermaidDiagram`, `useMermaidStream`, `<MermaidDiagramNode>` and `<MermaidDiagramGroup>`; Svelte adds `createMermaidDiagram`, `createMermaidStream` and the same components.
