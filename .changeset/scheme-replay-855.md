---
'@pixerate/editor': patch
---

Paint replay steps wet paint all at once when no `wetChunk` is given (much faster `renderHighRes`), and colour-scheme replay checkpoints over the wet undo memory now release their snapshots (#855).
