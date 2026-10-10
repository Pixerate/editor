---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Fix image editor geometry under rotate/flip/crop and make AI edits undoable.

**`@pixerate/editor` (image editor)**

- The crop box and annotations now live in one coordinate space: natural pixels of the source image. A single forward/inverse transform (90° rotations, flips, crop, fit scale, zoom, pan) drives rendering, export, hit-testing, viewport metrics and mask generation.
  - `canvasToImagePoint` now accounts for rotation, flips and the crop offset, and `imageToCanvasPoint` is its exact inverse. Results are no longer rounded to whole pixels.
  - The crop overlay and `getViewportMetrics().cropRect` are correct at 90°/270°. For example, the left half of an 800×600 image drawn at 90° is now 600×400, not 300×800.
  - `hitTestCrop` returns the crop handle in image space, so dragging a crop on a flipped or rotated image moves the correct edge. `getCropCursor(handle, transform?)` and `calculateCropDrag(..., aspectRatio, transform?)` take an optional transform so the cursor and the on-screen aspect ratio match what the user sees. `applyCropPreset` treats its ratio as the on-screen aspect.
  - The depth mask gets the same rotate/flip transform as the image.
  - Annotations stay attached to the image content when the image is rotated, flipped or cropped, and are clipped to the visible region. Annotations saved by earlier versions while a crop or rotation was active were stored in display space, so they may appear shifted.
- `renderMask` is aligned with the natural-size source image. Its output is strictly black and white: annotations are never drawn in their own colours or opacity, and edges are thresholded. Negative circle radii no longer throw.
- `applyInpaintedImage` and `applyBackgroundRemovedImage` are each a single undoable step. Undo restores the previous source image (URL and element), dimensions and annotations, and redo applies the edit again. If the new image has different dimensions, the crop and annotations are rescaled. `reset()` still returns to the image that was originally loaded.
- New `renderSource()` / `toSourceDataURL()` return the untransformed source image, which is the image the mask lines up with.
- The base-render cache key now includes `depthMask.maskSource` and the identity of the source image, so changing either re-renders the base image instead of showing a stale one.
- `rotate`, `setRotation`, `flipHorizontal` and `flipVertical` now create a new `transform` object instead of changing the existing one, so subscribers that memoize by reference see the change.
- There is now one `getAnnotationBounds` (in the geometry module). `ImageEditorRenderer#getAnnotationBounds` delegates to it and is deprecated.
- When the controller is constructed with an image element, `sourceUrl` is now set from that element's `src`.

**`@pixerate/editor-react` / `@pixerate/editor-svelte`**

- The built-in AI panel now sends the untransformed source image (`toSourceDataURL()`) to `onInpaint` / `onRemoveBackground`, so the image and the mask line up, and the returned image replaces the source without crop, rotation or adjustments being applied twice.
- The crop cursor and the aspect-locked crop drag respect rotation and flips.
- `useImageEditor()` and `createReactiveImageEditor()` expose `toSourceDataURL()`.
