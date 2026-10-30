/**
 * Agent tools for stickers: stamps sprayed with a sticker brush (`paint_stroke`, list_brushes
 * category sticker) stay objects on their layer, which these tools list, move, turn, resize,
 * recolour, reorder and delete. Each change is one undo step and redraws the layer.
 */

import type { PaintAgentTool } from './hosted';
import type { PaintEditorController } from './controller';
import { STAMP_KINDS } from './stickers';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const LAYER_ID = { type: 'string', description: 'Sticker layer id from list_layers (default the active layer).' } as const;

export function createPaintStickerTools(c: PaintEditorController): PaintAgentTool[] {
  return [
    {
      name: 'list_stickers',
      title: 'List stickers',
      description: 'Lists a layer’s stickers bottom first: id, stamp, x, y (centre, document pixels), size (diameter px), rotation (degrees clockwise), color, opacity. Empty for a layer without stickers. Changes nothing.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'List stickers', ...READ },
      coordinates: { out: ['stickers[]'] },
      handler: ({ layerId }) => ({ layerId: layerId ?? c.document.activeLayerId, stickers: c.listStickers(layerId) }),
    },
    {
      name: 'update_sticker',
      title: 'Change a sticker',
      description: 'Moves, turns, resizes, recolours, fades or restamps one sticker by id from list_stickers. One undo step. Returns the sticker.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          id: { type: 'string', description: 'Sticker id from list_stickers.' },
          stamp: { type: 'string', enum: [...STAMP_KINDS], description: 'Another stamp.' },
          x: { type: 'number', description: 'Centre x in document pixels.' },
          y: { type: 'number', description: 'Centre y in document pixels.' },
          size: { type: 'number', minimum: 2, maximum: 2048, description: 'Diameter in pixels.' },
          rotation: { type: 'number', minimum: -3600, maximum: 3600, description: 'Degrees clockwise.' },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Colour #rrggbb.' },
          opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Change a sticker', ...WRITE },
      coordinates: { in: [''], out: [''] },
      handler: ({ layerId, id, ...update }) => c.updateSticker(layerId, id, update),
    },
    {
      name: 'arrange_stickers',
      title: 'Bring stickers forward or back',
      description: 'Moves stickers to the top (front) or bottom (back) of their layer, keeping their order among themselves. One undo step. Returns the new order of ids.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          ids: { type: 'array', minItems: 1, items: { type: 'string', description: 'Sticker id.' }, description: 'Sticker ids from list_stickers.' },
          to: { type: 'string', enum: ['front', 'back'], description: 'front: on top of the others; back: under them.' },
        },
        required: ['ids', 'to'],
        additionalProperties: false,
      },
      annotations: { title: 'Bring stickers forward or back', ...WRITE },
      handler: ({ layerId, ids, to }) => ({ order: c.arrangeStickers(layerId, ids, to) }),
    },
    {
      name: 'remove_stickers',
      title: 'Delete stickers',
      description: 'Deletes stickers by id, or every sticker on the layer when ids is missing. One undo step. Returns the ids removed.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID, ids: { type: 'array', items: { type: 'string', description: 'Sticker id.' }, description: 'Sticker ids (default all).' } }, additionalProperties: false },
      annotations: { title: 'Delete stickers', ...DESTRUCTIVE },
      handler: ({ layerId, ids }) => ({ removed: c.removeStickers(layerId, ids) }),
    },
  ];
}
