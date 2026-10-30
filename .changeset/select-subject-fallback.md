---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Select Subject works without a segmentation model. `selectSubject()` then finds the subject that stands out most, classically: SLIC superpixels, saliency (how unlike the image's border each patch is, times its local contrast, with a mild centre preference), Otsu's threshold, then GrabCut along the edges. A description can't choose the subject this way, so the result says `method: 'saliency'` with a note. With a model, nothing changes except that the result now includes `method: 'model'`. The Select Subject button is always in the selection options bar in React and Svelte; the description field shows only when a model is set.

The `select_subject` agent tool is now one of the selection tools in `createImageEditorToolProvider` and is always listed. `target` is required only when a model is set, and there's a new `enhanceEdge` option. `createImageSegmentationToolProvider` is deprecated and lists no tools, so a host that registers both providers doesn't get the tool twice. New exports: `findSubject`, `slicSuperpixels`, `superpixelSaliency`, `otsuThreshold`, `grabCutLabels` and `keepMainPieces`.
