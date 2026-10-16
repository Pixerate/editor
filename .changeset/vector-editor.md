---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add a UI-agnostic vector editor. `@pixerate/editor/vector` has a document model of Bézier paths (corner / smooth / symmetric anchors, compound paths, groups, gradients), a headless `VectorEditorController` with select, direct-select, pen, pencil, rectangle, ellipse, polygon, star and line tools driven by pointer and key events, transforms with selection handles, boolean operations, align / distribute, grouping, stacking, grid snapping, copy / paste, a viewport and one undo step per gesture, plus scene / overlay render data, DOM-free SVG import / export and `createVectorCommands` for agents. `@pixerate/editor-react/vector` and `@pixerate/editor-svelte/vector` add `VectorEditor`, `VectorCanvas`, `VectorToolbar` and `VectorStylePanel` with `useVectorEditor` / `createVectorEditor` and `useVectorCommands`.
