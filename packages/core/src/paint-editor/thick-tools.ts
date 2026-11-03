/**
 * Agent tools for thick paint and light: impasto strokes are painted with `paint_stroke` and an
 * impasto brush; these tools move the light, read and flatten a layer's relief, read, spill and
 * clear light paint, and switch instant drying of wet strokes.
 */

import type { PaintAgentTool } from './hosted';
import type { PaintEditorController } from './controller';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const LAYER_ID = { type: 'string', description: 'Pixel layer id from list_layers (default the active layer).' } as const;

export function createPaintThickTools(c: PaintEditorController): PaintAgentTool[] {
  return [
    {
      name: 'get_light',
      title: 'Read a layer’s light paint',
      description: 'Reads a layer’s light paint (laid by brushes with light.amount above 0): whether it has any, where it is (bounds, document pixels), its brightest value (peak 0..255) and its spill (radius px, strength). Changes nothing.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'Read a layer’s light paint', ...READ },
      coordinates: { out: ['bounds'] },
      handler: ({ layerId }) => c.lightOf(layerId),
    },
    {
      name: 'set_light_spill',
      title: 'Set how far a layer’s light spills',
      description: 'Sets how far a layer’s light paint spills onto the paint and paper around it, in each stroke’s own colour: radius (px, 0 turns spill off, default 24) and strength (0..2, default 1). Nothing is repainted; saved with the document, not an undo step. Returns the layer’s spill.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          radius: { type: 'number', minimum: 0, maximum: 512, description: 'How far the light reaches, px (0 turns spill off; default 24).' },
          strength: { type: 'number', minimum: 0, maximum: 2, description: 'How strong the spill is, 0..2 (default 1).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Set how far a layer’s light spills', ...SET },
      handler: ({ layerId, radius, strength }) => c.setLightSpill(layerId, { radius, strength }),
    },
    {
      name: 'clear_light',
      title: 'Clear a layer’s light',
      description: 'Takes a layer’s light paint away; its paint keeps its colour (and relief). One undo step. Returns whether anything was cleared.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'Clear a layer’s light', ...WRITE },
      handler: ({ layerId }) => c.clearLight(layerId),
    },
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
      coordinates: { out: ['relief.bounds'] },
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
