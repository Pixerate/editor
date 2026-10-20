---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector Image Trace turns raster pixels into paths.

- **Black and white:** traces by darkness or by alpha.
- **Colour:** stacked paths, one per colour, after median-cut quantising.
- **Options:** tolerance, minimum area and corner roundness.
- **New API and agent command:** `traceImage`, `traceVectorImage` and `vector.traceImage`, which takes a PNG data URL.
- **New components:** `VectorTracePanel` for React and Svelte.
