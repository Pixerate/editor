/**
 * Stickers in the vector editor: `insert_sticker` (see `@pixerate/editor/stickers`) puts a
 * sticker's SVG in as a group of editable paths, scaled to its width and centred where asked.
 */

import { StickerError } from '../stickers/errors.js';
import type { StickerInsertHost, StickerPlacement } from '../stickers/tools.js';
import type { VectorEditorController } from './controller.js';
import { transformVectorNode, vectorNodeBounds } from './geometry.js';
import { parseVectorSvg } from './svg.js';
import type { VectorGroupNode } from './types.js';

/** A group of the sticker's paths, `placement.width` wide and centred on (`x`, `y`). */
export function stickerVectorGroup(placement: StickerPlacement, id = 'sticker'): VectorGroupNode {
  const { asset, description } = placement;
  if (asset.kind !== 'svg') throw new StickerError('unsupported_format', `"${placement.ref}" has only raster art; the vector editor takes stickers with SVG art (find_stickers lists formats).`);
  let n = 0;
  const parsed = parseVectorSvg(asset.svg, { createId: () => `${id}-${++n}` });
  if (!parsed.nodes.length) throw new StickerError('load_failed', `"${placement.ref}" has no shapes the vector editor can read.`);
  const group: VectorGroupNode = { type: 'group', id, name: description.name, children: parsed.nodes };
  const b = vectorNodeBounds(group);
  if (!b || !(b.width > 0) || !(b.height > 0)) throw new StickerError('load_failed', `"${placement.ref}" has no visible shapes.`);
  // Scale the art's own box (its SVG size) to the placement, so its margins are kept.
  const box = { width: parsed.width || b.width, height: parsed.height || b.height };
  const s = placement.width / box.width;
  return transformVectorNode(group, [s, 0, 0, s, placement.x - (box.width * s) / 2, placement.y - (box.height * s) / 2]);
}

/** `insert_sticker` for a vector editor: a group of editable paths, one undo step, selected. */
export function createVectorStickerHost(controller: VectorEditorController): StickerInsertHost {
  return {
    noun: 'group of editable paths',
    format: 'svg',
    defaultCentre: () => {
      const d = controller.getDocument();
      return { x: d.width / 2, y: d.height / 2 };
    },
    insert(placement) {
      const id = controller.addNode(stickerVectorGroup(placement), { label: `Insert ${placement.description.name}` });
      return { id };
    },
  };
}
