---
"@pixerate/editor": patch
"@pixerate/swift": minor
---

The Swift vector editor reads the house style (part of #791): `createVectorStyleToolProvider` in `PixerateVector` gives `check_vector_style` and `fix_vector_style` on a style skill's `vector.json` and `brand.json`, with the stroke-widths and corner-radii checks, the shared palette-only, min-contrast, distinguishable and fonts-allowed checks on the vector style surface, the profile derived from the brand, and a fix that snaps stroke widths and corner radii as one undo step and keeps the selection. The vector conformance host registers the house-style tools and takes `style`, `brand` and `background` in its setup, with six new scenarios.
