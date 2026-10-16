---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add live blends and path morphing to the vector editor.

- `createVectorMorph` / `interpolateVectorPaths`: anchors inserted by arc length, the start and winding chosen by best fit and shape context, Procrustes in-betweens that turn rather than collapse, contours growing from points, open/closed pairs, live corners, rigid transforms, and paint (OKLab colours, resampled gradients, stroke width, opacity, dashes, width profiles). `evaluateVectorPathKeyframes` morphs path keyframes with the animation easings.
- Blend groups (`blend`, `setBlendOptions`, `replaceBlendSpine`, `expandBlend`, `releaseBlend`, `addBlendKey`): keys plus in-betweens regenerated whenever a key changes, spaced by steps, distance or smooth colour, optionally following a replaced spine and oriented to it. A Blend tool (J), a spine overlay, `vector.blend` / `vector.blendOptions` / `vector.expandBlend` / `vector.releaseBlend` / `vector.replaceSpine` commands, and SVG round-trip.
- React and Svelte: a Blend group in `VectorToolbar` (`showBlend`) and spine / Blend tool rendering in `VectorCanvas`.
