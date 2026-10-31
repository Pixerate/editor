---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

On-canvas path editing: the Pen (`path-pen`), Path Selection (`path-select`) and Direct Selection (`direct-select`) tools edit the active path, the active shape layer or the active layer's vector mask. Drag anchors, handles and segments (each drag one undo step), select with a marquee or Shift, Alt-click to convert an anchor, Delete removes selected anchors; the Pen draws new subpaths (a new Work Path when nothing is targeted), drags out handles, closes on the first anchor and adds or deletes anchors on an existing path. Core adds `PathEditGesture`, `RenderOptions.pathEdit`, and `pathEditTarget`, `getPathEditComponents`, `setPathEditComponents` and `startWorkPath` on the controller. Both canvases route the tools and draw the overlay, the editors' Annotations tab offers them, and clicking empty space in the Paths panel deselects the path.
