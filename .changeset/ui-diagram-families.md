---
"@pixerate/editor": minor
---

Diagram families as UI components (#819). `diagramUiComponents()` in `@pixerate/editor/canvas` lists three `data-visual` components for a component registry, each with a `UiDescriptor` (data JSON Schema, colour roles, accessibility, sizing, example data, `contentHash`) like the chart types in `uiComponents()`:

- `flow`: steps joined by arrows, left to right or top down; links by step id, with labels, when the process is not a straight line.
- `timeline`: periods along an axis with their events under them.
- `mindmap`: a root with branches and up to two levels of children.

`render(data, { width, height, theme, colors })` writes the data as Mermaid, lays it out with the diagram editor's own layout and returns accessible SVG of exactly that size, the drawing fitted and centred, in light or dark with role colours. `toMermaid(data)` returns the source. Invalid data, unknown step ids and bad sizes are refused with a message. `DIAGRAM_UI_RENDER_VERSIONS` holds each type's render version.
