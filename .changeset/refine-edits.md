---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

The Select and Mask workspace's strokes as data, plus object-aware refinement. `refine_selection` and `refineSelectionTo` take `edits`, which are applied in order before refining:

- `quick-select`: grows to the region's edges.
- `brush`: paints the selection in or out with a round brush, with a `hardness` setting.
- `refine-brush`: marks hair or fur so the edge is re-estimated there, even beyond the radius. This uses a new `band` input to `refineCoverage` and `refineSelection`.

With edits, refining can start from an empty selection. `refineMode: 'object'` asks the host segmentation model for the object in the selection's bounds and refines from its outline, kept to near the selection. The result reports `refineMode`. React and Svelte add an Object aware option to the Refine Edge panel when a model is set; the brushes get their UI in the workspace. New exports: `applyRefineEdits`, `brushStrokeMask`, `REFINE_EDIT_KINDS` and the `RefineEdit` type.
