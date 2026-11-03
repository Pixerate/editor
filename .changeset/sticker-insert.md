---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Insert stickers into the vector, image and canvas editors, and treat them with effects in the image editor.

- `insert_sticker` (`createStickerToolProvider({ provider, insert })`, `insertSticker()`) puts one sticker from any sticker library into an editor through a `StickerInsertHost`, at a place and size, tinted when tintable, one undo step:
  - `createVectorStickerHost`: a group of editable paths;
  - `createImageStickerHost`: a pixel layer;
  - `createCanvasStickerHost`: a shape node from the sticker's outline.
- Image editor: `apply_effect` also takes any effect with a picture input, of any use; the layer is its picture (a sticker into a holo-foil treatment). New `layerImageInput` helper, and an `applyImageInputs` option on the shared effect tools.
- React and Svelte: a new `stickers` subpath with `StickerLibraryPicker` (any library, searchable, paged, by category) and `StickerInsertPanel`. The paint editor's `StickerPicker` is now built on it.
