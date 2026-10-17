---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Upgrade gradients in the vector editor.

- Gradient paints (`VectorGradient`, a superset of the canvas package's `CanvasGradientDef`, which is unchanged) gain conic, reflected and diamond styles; stop midpoints; sRGB / linear-light / Oklab interpolation and smoothness; pad / reflect / repeat spread; a radial focal point, focal radius and aspect; explicit start / end / aspect frames in the shape's box or its own space (the angle / centre shorthand still works, and node-space gradients follow scale and skew); and `strokeMode` (within, along or across a stroke).
- Rendering and SVG export stay DOM-free and plain SVG: midpoints and colour spaces become extra stops, conic and diamond gradients and stroke modes become `<pattern>`s of linear-gradient tiles, and every field round-trips through `data-vector-gradient`. Import reads `fx`, `fy`, `fr`, `spreadMethod`, `gradientTransform`, `gradientUnits="userSpaceOnUse"` and `href` inheritance. `vectorPaintToSvg` now returns `{ value, defs }` and `scene.defs` holds `VectorPaintDef`s (gradients and patterns).
- A Gradient tool (G): drag to set the vector, handles for start, end / radius, aspect and focal point, click the bar to add a stop, drag stops along it or off it to delete them, drag midpoints; one undo step per gesture.
- Controller `setGradient`, `setGradientStop`, `addGradientStop`, `removeGradientStop`, `reverseGradient`, `setGradientTarget` and `selectGradientStop`; agent command `vector.setGradient` and a gradient paint schema for `vector.setStyle`; blends mix the new fields.
- React and Svelte: `VectorGradientEditor` (in `VectorStylePanel`: type, stops with colour, opacity, position and midpoint, colour space, smoothness, spread, stroke mode, reverse), `VectorGradientAnnotator` on the canvas, and `VectorGradientDefs` rendering patterns.
