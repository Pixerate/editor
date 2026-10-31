---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Separate Subject (#392, item 3). The new `separate_subject` tool and `controller.separateSubject({ layerId, dilate, fill, seed, signal, onProgress })` split the selected subject from its background in one undo step:
- **Subject layer:** a copy of the layer masked by the selection, placed on top and made active.
- **Background plate:** a second copy with the subject's area, grown by `dilate` (default 8 px), Content-Aware Filled. With `fill: 'none'` the area is left transparent instead.
- **Fill area channel:** an alpha channel marking the filled area, so a bad patch can be loaded and filled again.
- **Source layer:** hidden.

The fill is computed before anything changes, so cancelling leaves the document as it was. The same `seed` gives the same plate.

React and Svelte add `SeparateSubjectPanel` (Separate Subject in the Refine Edge panel), with a grow amount, a fill on/off option, progress and Cancel.

Content-Aware Fill now reports real progress while it fills, weighted by each level's size, instead of jumping from 0% to done. `contentAwareFill` takes an `onProgress` option.
