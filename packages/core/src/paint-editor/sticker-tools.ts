/**
 * Agent tools for stickers: stamps sprayed with a sticker brush (`paint_stroke`, list_brushes
 * category sticker) stay objects on their layer, which these tools list, move, turn, resize,
 * recolour, reorder and delete, find by point (`sticker_at`), and places new ones exactly (`add_stickers`). Each change is one undo step and redraws the layer.
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
      description: 'Lists a layer’s stickers bottom first: id, ref (provider:id; stamp too for the editor’s own), x, y (centre, document pixels), size (diameter px), rotation (degrees clockwise), color, opacity. Empty for a layer without stickers. Changes nothing.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'List stickers', ...READ },
      coordinates: { out: ['stickers[]'] },
      handler: ({ layerId }) => ({ layerId: layerId ?? c.document.activeLayerId, stickers: c.listStickers(layerId) }),
    },
    {
      name: 'sticker_at',
      title: 'Find the sticker at a point',
      description: 'Returns the top-most sticker under a point (document pixels) by its stamp’s shape, or sticker null when none is there, so you can pick one sticker among many similar ones before update_sticker, arrange_stickers or remove_stickers. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          x: { type: 'number', description: 'Point x in document pixels.' },
          y: { type: 'number', description: 'Point y in document pixels.' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      annotations: { title: 'Find the sticker at a point', ...READ },
      coordinates: { in: [''], out: ['sticker'] },
      handler: ({ layerId, x, y }) => ({ layerId: layerId ?? c.document.activeLayerId, sticker: c.stickerAt(layerId, x, y) }),
    },
    {
      name: 'add_stickers',
      title: 'Place stickers',
      description: 'Places stickers exactly where you say, on top of a sticker layer or onto an empty layer (which becomes a sticker layer): any sticker from the sticker library by ref (find_stickers), its art loaded first; tintable ones take color. Use it for deliberate placement; spray with paint_stroke and a sticker brush for a random scatter. An unknown ref is refused with the closest ones. One undo step. Returns the new stickers with their ids, for update_sticker, arrange_stickers and remove_stickers.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          stickers: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            description: 'The stickers to place, drawn in this order (later ones on top).',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', minLength: 1, description: 'The sticker: a ref provider:id from find_stickers (e.g. editor:star). Give ref or stamp.' },
                stamp: { type: 'string', enum: [...STAMP_KINDS], description: 'Older form: an editor stamp (same as ref editor:<stamp>).' },
                x: { type: 'number', description: 'Centre x in document pixels.' },
                y: { type: 'number', description: 'Centre y in document pixels.' },
                size: { type: 'number', minimum: 2, maximum: 2048, description: 'Diameter in pixels (default 48).' },
                rotation: { type: 'number', minimum: -3600, maximum: 3600, description: 'Degrees clockwise (default 0).' },
                color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Colour #rrggbb (default the paint colour).' },
                opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1 (default 1).' },
                seed: { type: 'integer', minimum: 0, description: 'Texture seed (default from the new id); splat and confetti shapes vary with it.' },
              },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
        },
        required: ['stickers'],
        additionalProperties: false,
      },
      annotations: { title: 'Place stickers', ...WRITE },
      coordinates: { in: ['stickers[]'], out: ['stickers[]'] },
      handler: async ({ layerId, stickers }) => {
        const list = stickers as Array<{ ref?: string; stamp?: string }>;
        list.forEach((x, i) => {
          if (x.ref === undefined && x.stamp === undefined) throw new Error(`Sticker ${i} needs ref (a sticker ref from find_stickers, e.g. "editor:star").`);
        });
        await c.prepareStickers(list.map((x) => x.ref ?? `editor:${x.stamp}`));
        return { layerId: layerId ?? c.document.activeLayerId, stickers: c.addStickers(layerId, list as never) };
      },
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
          ref: { type: 'string', minLength: 1, description: 'Another sticker: a ref provider:id from find_stickers.' },
          stamp: { type: 'string', enum: [...STAMP_KINDS], description: 'Older form: another editor stamp (same as ref editor:<stamp>).' },
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
      handler: async ({ layerId, id, ...update }) => {
        // The layer's stickers are redrawn, so every one needs its art (and a new ref too).
        const refs = c.listStickers(layerId as string | undefined).map((s) => s.ref);
        await c.prepareStickers(update.ref ? [...refs, update.ref as string] : refs);
        return c.updateSticker(layerId as string | undefined, id as string, update);
      },
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
      handler: async ({ layerId, ids, to }) => {
        await c.prepareStickers(c.listStickers(layerId as string | undefined).map((s) => s.ref));
        return { order: c.arrangeStickers(layerId as string | undefined, ids as string[], to as 'front' | 'back') };
      },
    },
    {
      name: 'remove_stickers',
      title: 'Delete stickers',
      description: 'Deletes stickers by id, or every sticker on the layer when ids is missing. One undo step. Returns the ids removed.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID, ids: { type: 'array', items: { type: 'string', description: 'Sticker id.' }, description: 'Sticker ids (default all).' } }, additionalProperties: false },
      annotations: { title: 'Delete stickers', ...DESTRUCTIVE },
      handler: async ({ layerId, ids }) => {
        await c.prepareStickers(c.listStickers(layerId as string | undefined).map((s) => s.ref));
        return { removed: c.removeStickers(layerId as string | undefined, ids as string[] | undefined) };
      },
    },
  ];
}
