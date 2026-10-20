---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Gradient meshes and freeform gradients for vector paths.

- Meshes are smooth Coons patches over a lattice of coloured points. Freeform gradients are colour points with spreads and lines.
- Both render as SVG pattern tiles, move with their paths and round-trip through SVG.
- In the Gradient tool, drag points to move them, click to add a freeform point and Alt-click to remove one.
- New controller methods: `setMeshGradient`, `setMeshPoint`, `setFreeformGradient`, `addFreeformPoint`, `setFreeformPoint`, `removeFreeformPoint`, `setFreeformLines` and `getShading`.
- New agent commands, one per controller method.
- New `VectorShadingPanel` components for React and Svelte.
