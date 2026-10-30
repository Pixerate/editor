---
'@pixerate/editor': minor
---

When the host has set a segmentation provider, Select Sky and Object Selection now ask it first.

- **Select Sky** asks for "the sky".
- **Object Selection** asks for the object with the box or point. `SegmentationRequest` gains optional `box` and `point` fields for providers that take prompts (SAM). Of the results, it keeps the pieces mostly inside the box (clipped to the box grown by a tenth) or the ones under the point. If none fit, it falls back to GrabCut.
- **Results:** both report `method` (`'model'`, `'grabcut'` or `'classical'`). `useModel: false` forces the classical method. The `select_object` and `select_sky` tools take `useModel` and return `method`.
- **Breaking:** `controller.selectObject` now resolves to `{ selection, method }` instead of the selection.
