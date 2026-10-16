---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add freehand drawing tools (pen, highlighter, eraser) for xyflow canvas:
- `@pixerate/editor/canvas`: Streamline point smoothing, Bézier curve fitting to ShapeNode, eraser hit-testing, and headless CanvasDrawController with undo/redo history and batch deletion
- `@pixerate/editor-react/canvas`: `useCanvasDraw` hook and `<CanvasDrawLayer>` interactive SVG overlay with live stroke preview, spacebar pan override, and viewport transforms
- `@pixerate/editor-svelte/canvas`: `createCanvasDraw` rune and `<CanvasDrawLayer>` Svelte 5 component with reactive SVG overlay and cross-framework parity
