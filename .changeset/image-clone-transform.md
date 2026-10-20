---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor: Clone Source transforms. The Clone Stamp and Healing Brush can lay the source scaled (width and height, negative to mirror) and rotated about the stroke start, sampled bilinearly. New in core: `controller.setCloneTransform`, `paint.cloneTransform`, `TransformedPixelSource` and `cloneSamplePoint`. Agents get the `set_clone_transform` tool, and `get_retouch_options` now returns the transform. The React and Svelte options bars have Source W, Source H and Source angle sliders, Flip H / Flip V and Reset transform. The clone source marker follows the transform.
