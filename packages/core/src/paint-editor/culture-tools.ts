/**
 * Agent tools for biopaint (`culture`): mycelial ink strokes are painted with `paint_stroke` and
 * a brush with `culture` set (`mycelial-ink`, `rot`, `foxfire`); these tools read living colonies
 * (`get_cultures`), step growth deterministically (`grow_cultures`), stop growth on a layer while
 * keeping its drawn threads (`remove_cultures`), and configure offline growth (`set_culture_options`).
 */

import type { PaintAgentTool } from './hosted';
import type { PaintEditorController } from './controller';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;
const LAYER_ID = { type: 'string', description: 'Pixel layer id from list_layers (default the active layer).' } as const;

export function createCultureTools(c: PaintEditorController): PaintAgentTool[] {
  return [
    {
      name: 'get_cultures',
      title: 'Read living biopaint cultures',
      description:
        'Reads every pixel layer’s biopaint colony (seeded by brushes with a culture facet, such as mycelial-ink, rot and foxfire): tick count, living tips count, total segments drawn, bounds in document pixels, and status ("growing", "extinct", or "capped"), plus whether growWhileClosed is enabled and pendingCatchUpTicks. Changes nothing.',
      inputSchema: EMPTY,
      annotations: { title: 'Read living biopaint cultures', ...READ },
      coordinates: { out: ['layers[].bounds'] },
      handler: () => c.getCultures(),
    },
    {
      name: 'grow_cultures',
      title: 'Grow biopaint cultures',
      description:
        'Advances living mycelial colonies by steps ticks (1..2000, default 40) on layerId (or all visible unlocked pixel layers with living tips when layerId is omitted) as one undo step. Tips sense ahead for existing paint (appetite) and paper grain, eat and fade paint (digest) while picking up its colour, fork into thinner threads (branching), and fuse into loops (fuse) when meeting existing mycelium. Refuses stroke layers, effect layers, and wet layers holding wet paint (dry_paint first). Returns segmentsAdded, tipsAlive, bounds, status, and per-layer results.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: {
            type: 'string',
            description: 'Pixel layer id from list_layers to grow (default: all layers with living tips).',
          },
          steps: {
            type: 'integer',
            minimum: 1,
            maximum: 2000,
            description: 'Simulation ticks to advance (1..2000, default 40). Growing 100 once equals growing 50 twice.',
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Grow biopaint cultures', ...WRITE },
      coordinates: { out: ['bounds', 'layers[].bounds'] },
      handler: ({ layerId, steps }) =>
        c.growCultures({
          ...(layerId !== undefined ? { layerId: layerId as string } : {}),
          ...(steps !== undefined ? { steps: steps as number } : {}),
        }),
    },
    {
      name: 'remove_cultures',
      title: 'Kill a layer’s biopaint colony',
      description:
        'Stops all living biopaint tips on a pixel layer (default the active layer) so the colony stops growing (`status: "extinct"`), while keeping every thread already drawn on the layer as ordinary paint. One undo step. Returns the layerId, removedTips count, and status.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
        },
        additionalProperties: false,
      },
      annotations: { title: 'Kill a layer’s biopaint colony', ...WRITE, destructiveHint: true },
      handler: ({ layerId }) => c.removeCultures(layerId as string | undefined),
    },
    {
      name: 'set_culture_options',
      title: 'Configure biopaint culture options',
      description:
        'Enables or disables growWhileClosed (default false): when true, saving records lastGrownAt and reopening catches up elapsed growth (up to 5,000 ticks) as a single undo step ("Growth while closed"). Saved with the document, not an undo step. Returns the options now in force.',
      inputSchema: {
        type: 'object',
        properties: {
          growWhileClosed: {
            type: 'boolean',
            description: 'Whether living colonies catch up elapsed growth when the painting is reopened (default false).',
          },
        },
        required: ['growWhileClosed'],
        additionalProperties: false,
      },
      annotations: { title: 'Configure biopaint culture options', ...SET },
      handler: ({ growWhileClosed }) => c.setCultureOptions({ growWhileClosed: growWhileClosed as boolean }),
    },
  ];
}
