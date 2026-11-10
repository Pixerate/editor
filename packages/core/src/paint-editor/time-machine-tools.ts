/**
 * Agent tools for the painting time machine (`createTimeMachineTools`):
 * - Non-destructive ageing preview (`set_age`, `get_age`) and committing it (`bake_age`).
 * - X-ray radiograph view (`render_xray`, `set_xray_view`) revealing buried and hidden layers
 *   (pentimento) and earlier stroke states (`strokes: k`).
 * - The `scraper` brush engine (`paint-scraper`) is used through `set_brush` / `paint_stroke`.
 */

import { bytesToBase64, encodePng } from '../raster/png';
import { isAgeActive, type PaintAgeInput } from './age';
import type { PaintEditorController } from './controller';
import type { PaintAgentTool } from './hosted';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;

export function createTimeMachineTools(c: PaintEditorController): PaintAgentTool[] {
  return [
    {
      name: 'set_age',
      title: 'Age the painting (preview)',
      description:
        'Sets the non-destructive ageing preview on the painting: years (0..500, default 0), varnish (0..1 yellowing absorption over the composite, default 0.5), cracks (0..1 Voronoi / stress craquelure network that gets denser with layer count and thick height, darkens and carves height into lightTile so cracks catch the light, default 0.5), fading (0..1 deterministic hue-dependent lightfastness fading where reds and violets fade fastest, default 0.5), dust (0..1 low-frequency surface grain, default 0.25) and seed (integer >= 0, default 1). Ageing is one pass over the finished composite (paper and every visible layer, after blend modes and light spill), like a varnish film over the finished picture. Saved with the document, not an undo step (use bake_age to commit the aged look into a layer). Returns the age settings and active (whether years > 0 and any effect is above 0).',
      inputSchema: {
        type: 'object',
        properties: {
          years: { type: 'number', minimum: 0, maximum: 500, description: 'Simulated age in years, 0..500 (0 turns ageing off; 300 is three centuries; default 0).' },
          varnish: { type: 'number', minimum: 0, maximum: 1, description: 'Yellowed varnish absorption over the composite, 0..1 (default 0.5).' },
          cracks: { type: 'number', minimum: 0, maximum: 1, description: 'Craquelure crack network density and depth, 0..1 (default 0.5).' },
          fading: { type: 'number', minimum: 0, maximum: 1, description: 'Fugitive pigment fading by hue (reds and violets fastest), 0..1 (default 0.5).' },
          dust: { type: 'number', minimum: 0, maximum: 1, description: 'Low-frequency surface dust grain, 0..1 (default 0.25).' },
          seed: { type: 'integer', minimum: 0, description: 'Deterministic craquelure and dust seed, >= 0 (default 1).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Age the painting (preview)', ...SET },
      handler: (a) => {
        const age = c.setAge(a as PaintAgeInput);
        return { age, active: isAgeActive(age) };
      },
    },
    {
      name: 'get_age',
      title: 'Read the ageing settings',
      description:
        'Reads the document’s non-destructive ageing preview settings (years, varnish, cracks, fading, dust, seed), whether ageing is active, and whether X-ray view is on (xrayView). Changes nothing.',
      inputSchema: EMPTY,
      annotations: { title: 'Read the ageing settings', ...READ },
      handler: () => {
        const age = c.getAge();
        return { age, active: isAgeActive(age), xrayView: c.getXrayView() };
      },
    },
    {
      name: 'bake_age',
      title: 'Bake ageing into a layer',
      description:
        'Commits the current aged look (fading, yellowed varnish, craquelure cracks with their carved relief lighting, and dust) into a new pixel layer at the top of the stack and resets the preview years to 0 so the painting is not aged twice. One undo step. Refused when years is 0 or all ageing effects are 0 (call set_age with years > 0 first). Returns the new layer, the baked age settings, and bounds.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the new baked layer (default "Aged (<years> yr)").' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Bake ageing into a layer', ...WRITE },
      coordinates: { out: ['bounds', 'layer.bounds'] },
      handler: ({ name }) => c.bakeAge({ name: name as string | undefined }),
    },
    {
      name: 'render_xray',
      title: 'Render an X-ray of the painting',
      description:
        'Renders a read-only X-ray radiograph of the painting that reveals buried and hidden layers (pentimento). Every pixel layer—visible or hidden—contributes density = opacity × (thick height + lightness weight), so dense impasto and lead-white highlights read bright. With strokes: k, replays the painting from its recorded strokes up to stroke k first, showing the painting as it was after k strokes. Changes nothing. Returns the X-ray PNG image and its density summary (width, height, strokes, totalStrokes, layerCount, hiddenLayerCount, maxDensity, meanDensity).',
      inputSchema: {
        type: 'object',
        properties: {
          strokes: { type: 'integer', minimum: 0, description: 'Show the painting as it was after this many recorded strokes (default: current state with all strokes).' },
          maxSide: { type: 'integer', minimum: 16, maximum: 2048, description: 'Longest side of the returned X-ray PNG in pixels, 16..2048 (default 512).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Render an X-ray of the painting', ...READ },
      handler: async ({ strokes, maxSide }) => {
        await c.wetIdle();
        const x = await c.renderXray({ strokes: strokes as number | undefined, maxSide: maxSide as number | undefined });
        const bytes = encodePng(x.width, x.height, x.data);
        const info = {
          width: x.width,
          height: x.height,
          strokes: x.strokes,
          totalStrokes: x.totalStrokes,
          layerCount: x.layerCount,
          hiddenLayerCount: x.hiddenLayerCount,
          maxDensity: x.maxDensity,
          meanDensity: x.meanDensity,
        };
        return {
          content: [
            { type: 'image', data: bytesToBase64(bytes), mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify(info) },
          ],
        };
      },
    },
    {
      name: 'set_xray_view',
      title: 'Switch X-ray view',
      description:
        'Turns the X-ray radiograph view on or off in the viewport, revealing hidden and buried layers (pentimento) without changing the document or exports. Editor state, not an undo step. Returns { xrayView }.',
      inputSchema: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true shows the X-ray radiograph in the viewport; false returns to the normal painting view.' },
        },
        required: ['on'],
        additionalProperties: false,
      },
      annotations: { title: 'Switch X-ray view', ...SET },
      handler: ({ on }) => ({ xrayView: c.setXrayView(on as boolean) }),
    },
  ];
}
