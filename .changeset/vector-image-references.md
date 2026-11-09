---
"@pixerate/editor": minor
---

Vector: `vector.traceImage` and the stylise commands (`vector.mosaicImage`, `halftoneImage`, `lowPolyImage`, `hatchImage`) take an image by reference when the host passes `resolveImage` to `createVectorCommands`. A model can name an image (a canvas node id, a URL) but cannot write out its bytes; the host loads the reference and returns RGBA pixels or a PNG, scaled to at most `maxPixels`. `imageReferences` describes what it accepts in the `image` argument. Data URLs still decode synchronously, and without a resolver nothing changes.
