---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add distort tools and live envelopes to the vector editor.

- Free Distort mode of the selection box (`setFreeDistort`, `state.freeDistort`): dragging a corner distorts the selection in perspective by an exact homography (Shift+Alt+Mod: symmetric perspective), a side moves its two corners and Mod-dragging a side skews along it. `distort(corners)` and `skew(ax, ay)` do the same from code, on rotated nodes too (mapped in document space, written back into each node's own space). One undo step per gesture.
- Adaptive path mapping (`mapVectorSubpaths`, `mapVectorPoints`, `mapBezierPath`): curves stay Bézier paths through any map within a tolerance, refitted to fewer anchors where possible; straight lines stay straight under a projective map. User-space gradient handles are mapped with the shape. Homography helpers: `vectorHomography`, `applyVectorHomography`, `orderVectorQuad`.
- A non-destructive `envelope` effect: Photoshop's fifteen warp presets (arc, arc lower / upper, arch, bulge, shell lower / upper, flag, wave, fish, rise, fisheye, inflate, squeeze, twist) with bend, horizontal / vertical distortion and orientation, or an editable bicubic mesh of rows × columns (split exactly with de Casteljau). Expand Appearance bakes it; Release gives its shape back as a path; Make with Top Object uses a closed path's outline as the envelope. Controller `envelope`, `makeEnvelopeWithTopObject`, `releaseEnvelope`; mesh helpers in `warp.ts`.
- An Envelope tool (U) that drags the mesh's anchors and handles, or pulls the surface from inside a patch, drawn in the overlay of both canvases.
- Agent commands `vector.distort`, `vector.skew` and `vector.envelope`.
- React and Svelte: a Distort toggle in `VectorToolbar` (`showDistort`), `VectorEnvelopePanel` (in `VectorStylePanel`: Make with Warp / Mesh / Top Object, warp preset, bend and distortion sliders, orientation, mesh rows and columns, Release, Expand), and the Free Distort quad and envelope mesh on `VectorCanvas`. The Effects panel lists an envelope without its parameters, which the Envelope panel edits.
