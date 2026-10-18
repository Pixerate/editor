---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Mermaid diagrams reach parity with Ursula: pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY and radar diagrams are now editable statement by statement (lossless, like flowcharts), with family layouts and their own pictures (`mermaidToScene`, also used by `mermaidToSvg`, thumbnails and PNG export). `parseSankey` and `parseTreemap` read sankey and treemap data. `familyUI` describes each family's shapes, defaults and data fields, and `checkFieldData` validates them. Agents get `set_diagram_node_data`, `set_diagram_edge_data`, `set_diagram_settings` and `set_diagram_title`, and `get_diagram` lists the fields and values. React and Svelte add `<MermaidFamilyScene>`, plus `scene` and `renameTarget` on `useMermaidDiagram` / `createMermaidDiagram` (which also take `{ sceneTheme, layoutOptions }` as a second argument).
