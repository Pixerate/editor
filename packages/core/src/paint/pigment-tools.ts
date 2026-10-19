import type { AgentTool } from '../tools/registry.js';
import { createPigment, mixPigments, type Pigment } from './pigment';

const HEX = /^#?([0-9a-f]{6})$/i;

function parseHex(value: unknown, index: number): [number, number, number] {
  const m = typeof value === 'string' ? HEX.exec(value.trim()) : null;
  if (!m) throw new Error(`colors[${index}].color is ${JSON.stringify(value)}; use #rrggbb, e.g. "#1e40af".`);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toHex(rgb: readonly number[]): string {
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * Agent tools for pigment mixing (`@pixerate/editor/paint`). `mix_colors` is read-only: it
 * predicts what paints mixed in given amounts look like, for choosing a brush or fill colour.
 */
export function createPigmentTools(): AgentTool[] {
  const mixColors: AgentTool = {
    name: 'mix_colors',
    title: 'Mix colours like paint',
    description:
      'Mixes colours as paint would (Kubelka-Munk pigment mixing over reflectance spectra), so blue and yellow make green and white lightens a colour into a tint instead of greying it. Changes nothing. Returns the mixed colour as #rrggbb, the plain RGB average (rgbLerp) for comparison, and the normalised weights.',
    inputSchema: {
      type: 'object',
      properties: {
        colors: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          description: 'The paints to mix (1 to 16).',
          items: {
            type: 'object',
            properties: {
              color: { type: 'string', description: 'Paint colour #rrggbb.' },
              weight: { type: 'number', minimum: 0, description: 'Parts of this paint, any scale (e.g. 1 and 3 for a 1:3 mix). At least one weight must be above 0.' },
              strength: {
                type: 'number',
                exclusiveMinimum: 0,
                maximum: 100,
                description: 'Tinting strength (default 1): each part counts as this many, so a strong dark paint (e.g. 4) tints a lot of white.',
              },
            },
            required: ['color', 'weight'],
            additionalProperties: false,
          },
        },
      },
      required: ['colors'],
      additionalProperties: false,
    },
    annotations: { title: 'Mix colours like paint', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      const items = args.colors as { color: string; weight: number; strength?: number }[];
      const rgbs = items.map((item, i) => parseHex(item.color, i));
      const total = items.reduce((sum, item) => sum + item.weight, 0);
      if (!(total > 0)) throw new Error('Every weight is 0; give at least one colour a weight above 0.');
      const pigments: Pigment[] = rgbs.map((rgb, i) => createPigment(rgb, { strength: items[i].strength }));
      const mixed = mixPigments(pigments, items.map((item) => item.weight));
      const lerp = [0, 1, 2].map((c) => rgbs.reduce((sum, rgb, i) => sum + rgb[c] * items[i].weight, 0) / total);
      return {
        mixed: toHex(mixed),
        rgbLerp: toHex(lerp),
        weights: items.map((item) => item.weight / total),
        model: 'kubelka-munk',
      };
    },
  };
  return [mixColors];
}
