---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add Figma-style auto layout and constraints for canvas sub-flows. Frames are nodes with `data.layout` (horizontal, vertical or grid; gap, padding, wrap, main / cross / content alignment including space-between and baseline, hug / fill / fixed sizing, min / max, `fr` grid tracks with spans and anchors); children take `data.childLayout` (sizing, limits, absolute positioning and constraints). Core adds the pure `layoutFrame`, `layoutAll`, `layoutUp`, `applyConstraints`, `makeSizingCoherent`, `getAutoLayoutGrid`, `getAutoLayoutInsertTarget` and `moveLayoutChild`, plus `createCanvasAutoLayoutController`, which relayouts frames after nodes are added, removed, resized or reordered (one undo step with the triggering action) and reorders children dragged within their frame. React gets `useCanvasAutoLayout`, Svelte `createCanvasAutoLayout`, and the arrange controller an `autoLayout` option. Portions ported from FigCraft (MIT OR Apache-2.0).
