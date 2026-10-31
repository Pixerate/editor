---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Content-Aware Fill can output to a duplicate layer. `output: 'duplicate-layer'` paints the fill into a copy of the layer, above it, as one undo step; this is in `content_aware_fill`, the controller (`ContentAwareFillOutput`) and the workspace's Output To.

The workspace's sampling area can now be painted anywhere in the image. Images up to 4 MP show whole; on larger ones the view starts with room around the selection of twice its larger side, at least 256 px each way, and Expand View (`ContentAwareFillSession.expandView`) doubles it up to the whole image, keeping what was painted.
