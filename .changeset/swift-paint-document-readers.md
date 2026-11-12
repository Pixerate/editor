---
"@pixerate/swift": minor
---

Swift `PaintEditorController.loadJSON` reads more of a paint document the way the TypeScript core does (#742): dual-colour stroke sides in any CSS colour (named, `rgb()`, `hsl()`, `oklab()`, `oklch()`, `color()`, normalised to hex by the new `parseCssColor` / `normalizeCssColor` / `normalizeCssDualColor` in `PixerateRaster`); saved wet and paint events kept verbatim; culture tips whose fields are not numbers kept as NaN; saved channel rects (light, fluorescence, thermochromic, thick paint, ferrofluid) read unchecked; deep 16- and 32-bit pixels and masks decoded and saved again; pixel-layer effect generators kept (`RasterLayer.generator`); and image editor smart objects, unknown adjustment kinds and annotation layers without an annotation reported with the image editor's messages. Conformance values are compared as JSON (`JSONValue.asJSON`).
