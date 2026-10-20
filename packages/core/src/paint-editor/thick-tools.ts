/**
 * Agent tools for thick paint and light: impasto strokes are painted with `paint_stroke` and an
 * impasto brush; these tools move the light, read and flatten a layer's relief, and switch instant
 * drying of wet strokes.
 */

import type { AgentTool } from '../tools/registry.js';
import type { PaintEditorController } from './controller';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const LAYER_ID = { type: 'string', description: 'Pixel layer id from list_layers (default the active layer).' } as const;

export function createPaintThickTools(c: PaintEditorController): AgentTool[] {
  return [
    {
      name: 'set_lighting',
      title: 'Move the light',
      description:
        'Sets where the light comes from for thick paint (impasto relief) and metallic paper: azimuth (degrees clockwise from the top of the canvas; 315 is top left), elevation (5 grazing, deep shadows .. 90 straight on, no relief) and relief (0 flat .. 1 strong). Nothing is repainted: the relief is lit at render time. Saved with the document, not an undo step. Returns the lighting.',
      inputSchema: {
        type: 'object',
        properties: {
          azimuth: { type: 'number', minimum: -360, maximum: 360, description: 'Light direction in degrees clockwise from the top of the canvas (default 315).' },
          elevation: { type: 'number', minimum: 5, maximum: 90, description: 'Light height above the canvas in degrees (default 40).' },
          relief: { type: 'number', minimum: 0, maximum: 1, description: 'How strongly the relief shows (default 0.7).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Move the light', ...SET },
      handler: (a) => c.setLighting(a),
    },
    {
      name: 'get_relief',
      title: 'Read a layer’s relief',
      description: 'Reads a layer’s thick paint: where the relief is (bounds, layer pixels), its highest point (0..255) and the lighting. relief is null when the layer is flat. Changes nothing.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'Read a layer’s relief', ...READ },
      handler: ({ layerId }) => ({ relief: c.reliefOf(layerId), lighting: c.getLighting() }),
    },
    {
      name: 'flatten_relief',
      title: 'Flatten thick paint',
      description: 'Removes a layer’s relief and material (gloss, metallic): the paint keeps its colour but lies flat. One undo step. Returns the layer id and whether anything was flattened.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'Flatten thick paint', ...WRITE },
      handler: ({ layerId }) => c.flattenRelief(layerId),
    },
    {
      name: 'set_instant_dry',
      title: 'Dry wet strokes at once',
      description: 'Switches instant drying: on, every wet stroke (watercolour, gouache, oil) dries as soon as it ends, in the same undo step, so strokes stay exactly where they are laid; off (default), wet paint keeps moving until it dries. Editor state. Returns instantDry.',
      inputSchema: { type: 'object', properties: { on: { type: 'boolean', description: 'true dries every wet stroke as it ends.' } }, required: ['on'], additionalProperties: false },
      annotations: { title: 'Dry wet strokes at once', ...SET },
      handler: ({ on }) => ({ instantDry: c.setInstantDry(on) }),
    },
  ];
}
