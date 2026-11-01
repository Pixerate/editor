---
'@pixerate/editor': patch
---

Fix incremental compositing of chiselled bevels and embosses: painting on a layer with a chisel-hard or chisel-soft bevel (such as a pillow emboss) no longer leaves pixels a few levels off a full redraw, because the effect's margin now covers everything its edge distances, softening and lighting read.
