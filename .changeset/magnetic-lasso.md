---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Magnetic Lasso for the image editor. The outline follows the edges of the image (live-wire: gradient, Laplacian zero-crossings and edge direction, whichever side is darker) from the last anchor to the pointer, and places anchors as it goes. Width, Contrast and Frequency are in the selection options bar in React and Svelte. Agents get the same with `select_polygon` `snapToEdges: { width, contrast }`, which snaps a rough outline to the edges. New exports: `EdgeMap`, `snapToEdge`, `liveWire`, `snapPolygonToEdges`, `simplifyPixelPath`, `magneticAnchorSpacing` and `controller.snapToEdges`.
