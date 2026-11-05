---
"@pixerate/swift": minor
---

**Swift vector editor: blends, envelopes and live symmetry (#624).**

- Morphs (`Blend.swift`): `createVectorMorph` and `interpolateVectorPaths` bring two paths or groups to matching anchors (arc-length refinement, the start and winding that cost least by Procrustes fit and shape contexts) and interpolate them, turning rather than collapsing; paints mix in OKLab (`interpolateVectorColor`, `interpolateVectorPaint`, resampled gradient stops), and stroke widths, dashes, arrowhead scales and width profiles interpolate (`interpolateVectorStyle`).
- Live blend groups (`BlendGroup.swift`): steps, distance and smooth-colour spacing, replaced spines with orientation to the spine, expand and release. The controller regenerates a blend's steps after every change and has `blend`, `setBlendOptions`, `replaceBlendSpine`, `expandBlend` and `releaseBlend`; `vector.list` lists blend options.
- Envelopes (`Warp.swift`): the fifteen warp presets, Bézier meshes (fit, evaluate, split, resize, from an outline, outline) and the Envelope effect, drawn in bounds, render data and SVG export. The controller has `envelope`, `makeEnvelopeWithTopObject` and `releaseEnvelope`; `updateEffect` turns a preset into the mesh it stood for, transforms that skew or mirror do too, and Free Distort maps envelope meshes and blend spines.
- Live symmetry (`Symmetry.swift`): mirror, four-quarter, diagonal and radial (kaleidoscope) symmetry groups drawn with their copies in bounds, render data and SVG export; `makeSymmetry`, `setSymmetry`, `releaseSymmetry` (with expand), `enterSymmetry` and `exitSymmetry`.
- SVG export writes blends (`data-vector-blend`), and SVG import reads back blends, symmetry groups and path effects.
- The 11 blend, envelope and symmetry commands run, and the `blends-and-envelopes` scenario passes (9 of 15 vector scenarios).
