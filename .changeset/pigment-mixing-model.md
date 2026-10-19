---
"@pixerate/editor": minor
---

Add pigment-like colour mixing to `@pixerate/editor/paint`: blue and yellow mix to green and white makes tints, as with paint. sRGB colours are lifted to smooth 36-band reflectance spectra (a sigmoid-polynomial uplift, solved lazily on a 17³ lattice and interpolated so every colour round-trips), mixed with two-constant Kubelka-Munk (scattering from luminance, optional tinting strength) and integrated back to sRGB with analytic CIE 1931 colour-matching functions. New API: `mixPigments`, `lerpPigment`, `createPigment`, `setPigmentColor` and `lerpPigmentInto` (an allocation-free per-dab path), `rgbToReflectance` and `reflectanceToRgb`. A read-only `mix_colors` agent tool (also in the image editor's tool provider) returns the mixed colour and the plain RGB average for comparison.
