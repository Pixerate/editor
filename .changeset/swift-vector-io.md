---
"@pixerate/swift": minor
---

**Swift vector editor: PDF, Lottie, Image Trace and stylise (#624).**

- Vector PDF export (`Pdf.swift`, from `vector/pdf.ts`): `vectorDocumentToPdf` draws the scene render data as PDF paths, with linear and radial gradients as shadings, pattern paints as their tiles, opacity and blend modes as graphics states, clip masks, a page per artboard, `scale`, `title` and Flate compression; the bytes match the TS file. Notes name what is left out (filters, opacity masks, stop opacity, text without outlines).
- Lottie export and import (`Lottie.swift`, from `vector/lottie.ts`): `vectorDocumentToLottie` with path effects as live shape modifiers and gradients as gradient fills, and `parseVectorLottie` / `lottieValueAt` reading one frame (eased and held keyframes, transforms and parenting, precomps, solids, additive masks, modifiers as live effects).
- Image Trace (`Trace.swift`, from `vector/trace.ts`): `traceVectorImage` in threshold and colour modes, `vectorTraceContours`, `quantizeVectorTraceColors`; and the bitmap-to-vector styles (`Stylize.swift`, from `vector/stylize.ts`): `stylizeVectorImage` with mosaic, halftone, low poly and engraving.
- The controller has `toPdf`, `toLottie`, `importLottie`, `traceImage` and `stylizeImage`; `vector.exportPdf`, `vector.exportLottie`, `vector.importLottie`, `vector.traceImage`, `vector.mosaicImage`, `vector.halftoneImage`, `vector.lowPolyImage` and `vector.hatchImage` run, so every vector command now has a Swift run, and the `import-export` scenario passes (14 of 15 vector scenarios).
- `JS.acos` ports V8's `Math.acos` bit for bit on arm64; curve fitting, live corners and variable-width strokes use it instead of Foundation's.
