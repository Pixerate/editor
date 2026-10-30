---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Quick Selection for the image editor. Each brush stroke grows into the region it is painted on, out to its edges: a graph cut (Boykov–Kolmogorov max-flow) on a copy reduced to 512 px, with colour models of the stroke and its surroundings, then scaled back up with the edge anti-aliased at full size. With New and a selection already there, strokes add; Alt subtracts. Size, Sample all layers and Auto-enhance are in the selection options bar in React and Svelte. Agents use `quick_select` (`strokes`, `size`, `mode`, `sampleAllLayers`, `enhanceEdge`), one undo step for all its strokes. New exports: `GridGraph`, `quickSelectStroke`, `workImage`, `controller.quickSelect` and `QuickSelectCommandOptions`.
