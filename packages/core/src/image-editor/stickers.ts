/**
 * Stickers in the image editor: `insert_sticker` (see `@pixerate/editor/stickers`) puts a
 * sticker's art in as a new pixel layer, centred where asked. The layer can then take any effect
 * that takes a picture (`apply_effect`): the sticker is the effect's input.
 */

import type { StickerInsertHost } from '../stickers/tools.js';
import type { ImageEditorController } from './controller.js';

/** `insert_sticker` for an image editor: a new pixel layer named after the sticker, one undo step. */
export function createImageStickerHost(controller: ImageEditorController): StickerInsertHost {
  return {
    noun: 'pixel layer',
    format: 'png',
    defaultCentre: () => {
      const { width, height } = controller.getCanvasSize();
      return { x: width / 2, y: height / 2 };
    },
    async insert({ asset, description, x, y }) {
      // PNG art is decoded anywhere; SVG goes through the browser like any image URL.
      const image = asset.kind === 'image' ? asset.url : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.svg)}`;
      const pixels = await controller.decodeImage(image);
      // The art comes at the placement's size (PNG) or its own (SVG); either way it is centred.
      const id = controller.addPixelLayer({ name: description.name, pixels, x: Math.round(x - pixels.width / 2), y: Math.round(y - pixels.height / 2) });
      return { id, layerWidth: pixels.width, layerHeight: pixels.height };
    },
  };
}
