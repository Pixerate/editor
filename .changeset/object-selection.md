---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Object Selection for the image editor: drag a box loosely around an object, or click on it, and the object is selected. GrabCut fits colour models (mixtures of five Gaussians) to the object and its background, then relabels pixels with a graph cut along edges, and repeats until the labels settle. It runs on the same reduced copy as Quick Selection and is scaled back up with an anti-aliased edge. Sample all layers and Auto-enhance are in the selection options bar in React and Svelte. Agents use `select_object` with `rect` or `point`. New exports: `selectObjectIn`, `ColorGmm`, `smoothnessWeights`, `controller.selectObject` and `SelectObjectCommandOptions`. The shared reduced-copy code moved to `selection/segment/work.ts`; its exports are unchanged.
