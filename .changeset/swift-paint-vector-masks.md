---
"@pixerate/swift": minor
"@pixerate/conformance": patch
---

Swift paint documents read the image editor's vector parts as the TS core does (#742). Vector masks on pixel layers and groups are read through a port of `readShapeComponents` (live rectangles, ellipses, polygons, stars and lines, anchor lists with handles and live corners, SVG path data, hybrid edges), kept on `RasterLayer.vectorMask` and saved back; a damaged one is left out with the TS core's message. Shape and type layers are checked with the image editor's validation (components, live shapes, paints, gradients, patterns, strokes, text and paragraph styles, PSD blocks, stored pixels) and report its problem before the paint editor leaves them out, and annotation layers are reported as the shape, type or annotation layers the image editor migrates them to. `PixerateRaster` adds `JS.tan` (V8's `Math.tan`, bit-exact), and `PixeratePaint` now depends on `PixerateGeometry`.

The new `document-load-vector-layers` paint scenario checks all of it.
