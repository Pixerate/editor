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
        'Sets where the light comes from for thick paint (impasto relief), thin-film iridescence and metallic paper: azimuth (degrees clockwise from the top of the canvas; 315 is top left), elevation (5 grazing, deep shadows .. 90 straight on, no relief) and relief (0 flat .. 1 strong). Nothing is repainted: the relief and iridescence are lit at render time. Saved with the document, not an undo step. Returns the lighting.',
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
      name: 'set_view_tilt',
      title: 'Tilt the view angle for iridescence',
      description:
        'Tilts the viewer’s look angle for thin-film iridescence and specular highlights: x (-1 left .. 1 right, default 0) and y (-1 top .. 1 bottom, default 0). Moves the view vector, not the light, so iridescent paint (brushes with iridescence, such as scarab-lacquer, soap-film, pearl-glaze) shifts hue across the spectrum as the angle changes. Editor state (not saved with the document, not an undo step). Returns the view tilt.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', minimum: -1, maximum: 1, description: 'Horizontal view tilt, -1 (left) .. 1 (right); default 0.' },
          y: { type: 'number', minimum: -1, maximum: 1, description: 'Vertical view tilt, -1 (top) .. 1 (bottom); default 0.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Tilt the view angle for iridescence', ...SET },
      handler: (a) => c.setViewTilt(a),
    },
    {
      name: 'get_view_tilt',
      title: 'Read the view tilt',
      description: 'Reads the viewer’s look angle for thin-film iridescence and specular highlights: x and y in -1..1 (0, 0 is straight on). Changes nothing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Read the view tilt', ...READ },
      handler: () => c.getViewTilt(),
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
    {
      name: 'set_uv_light',
      title: 'Set UV blacklight',
      description:
        'Switches the virtual UV blacklight (on) and sets its glow strength (0..2, default 1) and ambient daylight level (0..1, default 0.15). When on, the paper and daylight paint dim to ambient and fluorescent strokes (fluorescence.amount > 0, including invisible UV ink) glow and spill in their own colour. Saved with the document, not an undo step. Returns the UV light settings and fluorescentLayerIds.',
      inputSchema: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'Whether the UV blacklight is switched on (default false).' },
          strength: { type: 'number', minimum: 0, maximum: 2, description: 'UV emission and spill strength, 0..2 (default 1).' },
          ambient: { type: 'number', minimum: 0, maximum: 1, description: 'How much normal daylight remains under UV, 0 (pitch dark) .. 1 (full daylight, default 0.15).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Set UV blacklight', ...SET },
      handler: (a) => ({ ...c.setUvLight(a), fluorescentLayerIds: c.fluorescentLayerIds() }),
    },
    {
      name: 'get_uv_light',
      title: 'Read UV blacklight',
      description: 'Reads the virtual UV blacklight settings (on, strength, ambient) and the ids of layers that hold UV-fluorescent ink (fluorescentLayerIds). Changes nothing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Read UV blacklight', ...READ },
      handler: () => ({ ...c.getUvLight(), fluorescentLayerIds: c.fluorescentLayerIds() }),
    },
    {
      name: 'paint_heat',
      title: 'Warm or cool the canvas',
      description:
        'Applies a heat brush along points on the document’s coarse heat field (radius in document pixels, default 24; temperature 0 cools .. 1 warms, default 1). Thermochromic strokes (thermochromic.hotColor) shift smoothly toward their hot colour where local temperature crosses their threshold, and wet paint under hot tiles (temperature >= 0.5) dries in place. One undo step. Returns the heat field stats (max, mean, hotCells, bounds) and any dried wet layers.',
      inputSchema: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            minItems: 1,
            description: 'Polyline of document positions to warm or cool along.',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'Document x in pixels.' },
                y: { type: 'number', description: 'Document y in pixels.' },
              },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
          radius: { type: 'number', minimum: 1, maximum: 512, description: 'Heat falloff radius in document pixels, 1..512 (default 24).' },
          temperature: { type: 'number', minimum: 0, maximum: 1, description: 'Target temperature along the stroke, 0 (cool) .. 1 (hot, default 1).' },
        },
        required: ['points'],
        additionalProperties: false,
      },
      annotations: { title: 'Warm or cool the canvas', ...WRITE },
      coordinates: { in: ['points'], out: ['bounds', 'dried[].bounds'] },
      handler: ({ points, radius, temperature }) => c.paintHeat({ points, radius, temperature }),
    },
    {
      name: 'advance_heat',
      title: 'Spread and cool heat',
      description:
        'Advances the document’s heat field by steps (1..200, default 10) of thermal diffusion and Newtonian cooling, so warm patches spread outward and fade back toward cold paint. Any wet paint under hot cells dries. Not an undo step (time passing never is). Returns steps, the updated heat stats (max, mean, hotCells, bounds) and any dried wet layers.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'integer', minimum: 1, maximum: 200, description: 'Diffusion and cooling steps to run, 1..200 (default 10).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Spread and cool heat', ...SET },
      coordinates: { out: ['bounds', 'dried[].bounds'] },
      handler: ({ steps }) => c.advanceHeat(steps),
    },
    {
      name: 'clear_heat',
      title: 'Cool the whole canvas',
      description: 'Cools the entire document heat field back to 0 at once so all thermochromic paint returns to its cold colour. One undo step when the canvas was warm. Returns { cleared }.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Cool the whole canvas', ...WRITE },
      handler: () => c.clearHeat(),
    },
    {
      name: 'get_heat',
      title: 'Read canvas heat',
      description: 'Reads the document’s heat field stats (max, mean, hotCells, bounds), optional temperature samples (0..1) at points in document pixels, and thermochromicLayerIds. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            description: 'Optional document positions (px) at which to sample the local temperature (0..1).',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'Document x in pixels.' },
                y: { type: 'number', description: 'Document y in pixels.' },
              },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Read canvas heat', ...READ },
      coordinates: { in: ['points'], out: ['bounds', 'samples'] },
      handler: ({ points }) => ({ ...c.getHeat(points), thermochromicLayerIds: c.thermochromicLayerIds() }),
    },
  ];
}
