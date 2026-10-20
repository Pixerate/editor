---
"@pixerate/editor": patch
---

Vector editor: an R-tree spatial index (`VectorRTree`, `vectorSpatialIndex`, `vectorNodesNear`) makes hit-testing, marquee selection and snapping to segments fast in documents with hundreds of objects, with results identical to a scan.
