---
"@pixerate/editor": minor
---

House style for the canvas and typography (#779).

- `canvasStyleDomain` (`canvas.json`): the corner radii, stroke widths and font sizes allowed, a position grid, and the brand's palette-only / min-contrast / fonts-allowed on fills, strokes, text colours and fonts. Node styles are read as strings, objects or shape paints through `CANVAS_TOKEN_PROPERTIES`. Agent tools `check_canvas_style` and `fix_canvas_style` (snaps to the house values as one undoable command; hidden when read-only), `createCanvasStyleToolProvider({ getNodes, setNodes, history })`.
- `typographyStyleDomain` (`typography.json`): the weights and type-scale sizes allowed, line-height and tracking ranges, and fonts-allowed, checked on a font picker's selection. Agent tools `check_typography_style` and `fix_typography_style` (snaps the selection in one change), `createTypographyStyleToolProvider`.
