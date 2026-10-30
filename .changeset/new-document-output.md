---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Select and Mask can output to a new document. `refine_selection` and `refineSelectionTo` gain two outputs:

- `new-document`: the cut-out pixels on transparency.
- `new-document-with-mask`: a copy of the layer masked by the selection.

Both can be decontaminated. The editor builds a one-layer document the size of the image with the new `controller.documentFromSelection`, which also works on its own, and hands it to the host's document opener: the `openDocument` option or `setDocumentOpener`, a `DocumentOpener` taking `(document, { name, from })` that may return an id. The current document doesn't change and gets no undo step. The result carries `documentId`. Without an opener, these outputs are refused with the reason and hidden in the React and Svelte Refine Edge panel and the Select and Mask workspace; `canOpenDocuments` tells which applies. `REFINE_OUTPUTS` marks them with `needsDocuments`. The demo downloads the new document as a file.
