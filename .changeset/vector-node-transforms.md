---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Vector editor: nodes get an optional rigid `transform` (rotation + translation) so rotated shapes and groups keep a rotated selection box. `transformVectorNode` now composes the matrix, keeps the rotation in `transform` and bakes scale / skew / mirroring into the anchors (stroke widths and hit tolerances stay exact). Resize handles, `scale` and `flip` work along the selection's own axes, `setRotation` sets an absolute angle (also as `angle` on the `vector.transform` command, and `rotation` in `vector.list`), anchors and handles are edited in each node's own space, booleans and combine work in document space, SVG import keeps rotations and export writes `transform="matrix(…)"`. New helpers: `decomposeRigid`, `matrixRotation`, `vectorNodeRotation`, `vectorWorldMatrix`, `vectorParentMatrix`, `vectorPathWorldBezier`, `invertMatrix`, `getAnchorWorld`, `getVectorSelectionFrame` and `getVectorSelectionBoxGeometry`. The React and Svelte canvases render node transforms and the rotated selection box.
