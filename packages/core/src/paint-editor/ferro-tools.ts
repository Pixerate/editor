/**
 * Agent tools for ferrofluid paint and magnets: ferrofluid strokes are painted with `paint_stroke`
 * and a brush whose `ferro.amount` is above 0 (`ferrofluid`, `ferro-ink`); these tools place,
 * move and remove magnets (`add_magnet`, `update_magnet`, `remove_magnets`, `list_magnets`), read
 * a layer's liquid ferrofluid and live Rosensweig spike stats (`get_ferrofluid`), and cure the
 * liquid spikes into solid impasto relief (`cure_ferrofluid`).
 */

import type { PaintAgentTool } from './hosted';
import type { PaintEditorController } from './controller';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;
const LAYER_ID = { type: 'string', description: 'Pixel layer id from list_layers (default the active layer).' } as const;

export function createFerroTools(c: PaintEditorController): PaintAgentTool[] {
  return [
    {
      name: 'add_magnet',
      title: 'Place a magnet',
      description:
        'Places a dipole magnet on the canvas at (x, y) in document pixels. Liquid ferrofluid on every layer gathers toward the magnet (deterministic advection steps) and rises into hexagonal Rosensweig relief spikes along the magnetic field lines wherever |B| exceeds the layer’s threshold, shaded live by set_lighting. One undo step. Returns the magnet (id, x, y, strength, radius).',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Magnet centre x in document pixels.' },
          y: { type: 'number', description: 'Magnet centre y in document pixels.' },
          strength: { type: 'number', minimum: -1, maximum: 1, description: 'Dipole strength -1..1 (default 0.8; negative flips the pole).' },
          radius: { type: 'number', minimum: 4, maximum: 2048, description: 'Dipole falloff radius in pixels (default 80).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      annotations: { title: 'Place a magnet', ...WRITE },
      coordinates: { in: [''], out: [''] },
      handler: (a) => c.addMagnet(a as { x: number; y: number; strength?: number; radius?: number }),
    },
    {
      name: 'update_magnet',
      title: 'Move or tune a magnet',
      description:
        'Moves a magnet or changes its dipole strength (-1..1) or falloff radius (4..2048 px) by id from list_magnets. Liquid ferrofluid gathers toward the updated field and the lit relief spikes update at once. One undo step. Returns the updated magnet.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Magnet id from list_magnets.' },
          x: { type: 'number', description: 'Magnet centre x in document pixels.' },
          y: { type: 'number', description: 'Magnet centre y in document pixels.' },
          strength: { type: 'number', minimum: -1, maximum: 1, description: 'Dipole strength -1..1.' },
          radius: { type: 'number', minimum: 4, maximum: 2048, description: 'Dipole falloff radius in pixels (4..2048).' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Move or tune a magnet', ...SET },
      coordinates: { in: [''], out: [''] },
      handler: ({ id, ...u }) => c.updateMagnet(id as string, u),
    },
    {
      name: 'remove_magnets',
      title: 'Remove magnets',
      description:
        'Removes magnets by id from list_magnets, or every magnet on the canvas when ids is omitted or empty. Uncured ferrofluid relaxes as the field changes; cured relief stays. One undo step. Returns the removed magnet ids.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string', description: 'Magnet id from list_magnets.' },
            description: 'Magnet ids to remove (default: remove all magnets).',
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Remove magnets', ...WRITE },
      handler: ({ ids }) => ({ removed: c.removeMagnets(ids as string[] | undefined) }),
    },
    {
      name: 'list_magnets',
      title: 'List magnets',
      description:
        'Lists the magnets placed on the canvas in order: id, x, y (document pixels), strength (-1..1) and radius (px). Changes nothing.',
      inputSchema: EMPTY,
      annotations: { title: 'List magnets', ...READ },
      coordinates: { out: ['magnets[]'] },
      handler: () => ({ magnets: c.listMagnets() }),
    },
    {
      name: 'get_ferrofluid',
      title: 'Read a layer’s ferrofluid and spikes',
      description:
        'Reads a layer’s liquid ferrofluid (laid by brushes with ferro.amount above 0, such as ferrofluid and ferro-ink) and its live Rosensweig spikes under the current magnets: whether it has any (ferro), its bounds in document pixels, peak liquid level (0..255), liquid coverage in pixels, activeSpikeArea (pixels currently raised into spikes), maxSpikeHeight (0..255), magnetCount, and the layer’s capillary wavelength and threshold. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: { layerId: LAYER_ID },
        additionalProperties: false,
      },
      annotations: { title: 'Read a layer’s ferrofluid and spikes', ...READ },
      coordinates: { out: ['bounds'] },
      handler: ({ layerId }) => c.getFerrofluid(layerId as string | undefined),
    },
    {
      name: 'cure_ferrofluid',
      title: 'Cure ferrofluid into solid relief',
      description:
        'Cures a layer’s liquid ferrofluid: bakes its current magnetic Rosensweig spikes into the layer’s solid impasto height and dark glossy metallic material, and clears the liquid ferrofluid channel so moving or removing magnets no longer changes this layer. One undo step. Returns the layer id, whether anything was cured, the cured bounds, maxSpikeHeight and activeSpikeArea.',
      inputSchema: {
        type: 'object',
        properties: { layerId: LAYER_ID },
        additionalProperties: false,
      },
      annotations: { title: 'Cure ferrofluid into solid relief', ...WRITE },
      coordinates: { out: ['bounds'] },
      handler: ({ layerId }) => c.cureFerrofluid(layerId as string | undefined),
    },
  ];
}
