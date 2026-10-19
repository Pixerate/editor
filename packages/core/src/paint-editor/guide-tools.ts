/**
 * Agent tools for the paint editor's painting guides (symmetry, perspective, tracing and reference
 * images) and colour (harmonies, swatches, the mixing pad). Guides, swatches and the pad are
 * editor state saved with the document (the pad is not saved), not undo steps.
 */

import type { AgentTool } from '../tools/registry.js';
import { bytesToBase64, encodePng } from '../raster/png';
import { HARMONY_KINDS } from './color';
import type { PaintEditorController } from './controller';
import { SYMMETRY_MODES, symmetryCopies, type ReferenceImage, type TracingImage } from './guides';
import type { PenPoint } from './engine';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;
const COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Colour #rrggbb.' } as const;
const POINT = {
  type: 'object',
  properties: { x: { type: 'number', description: 'x in document pixels.' }, y: { type: 'number', description: 'y in document pixels.' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;
const RECT = {
  type: 'object',
  description: 'Placement in document pixels.',
  properties: {
    x: { type: 'number', description: 'Left edge.' },
    y: { type: 'number', description: 'Top edge.' },
    width: { type: 'number', exclusiveMinimum: 0, description: 'Width.' },
    height: { type: 'number', exclusiveMinimum: 0, description: 'Height.' },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
} as const;
const PNG = { type: 'string', minLength: 1, description: 'The image as a PNG, base64 or a data:image/png URL.' } as const;

const tracingInfo = (t: TracingImage | null) => (t ? { width: t.width, height: t.height, rect: t.rect, opacity: t.opacity, visible: t.visible, sampleColors: t.sampleColors } : null);
const refInfo = ({ src: _s, ...r }: ReferenceImage) => r;

export function createPaintGuideTools(c: PaintEditorController): AgentTool[] {
  const guides = () => c.getState().guides;
  return [
    {
      name: 'get_guides',
      title: 'Get the painting guides',
      description: 'Reads the painting guides: symmetry (mode, centre, rotation, segments, mirror, and how many copies each stroke paints), the perspective guide (vanishing points, snap), the tracing image (size, placement, opacity, visibility, colour sampling) and the reference images.',
      inputSchema: EMPTY,
      annotations: { title: 'Get the painting guides', ...READ },
      handler: () => {
        const g = guides();
        return { symmetry: { ...g.symmetry, copies: symmetryCopies(g.symmetry).length }, perspective: g.perspective, tracing: tracingInfo(g.tracing), references: g.references.map(refInfo) };
      },
    },
    {
      name: 'set_symmetry',
      title: 'Set mirror or kaleidoscope painting',
      description:
        'Turns symmetry on or off. Every stroke after it also paints its copies, as one stroke and one undo step: vertical, horizontal or diagonal mirror (one copy), dual (four-way), or kaleidoscope with n segments (rotated copies, and with mirror the reflections between them). Editor state, saved with the document. Returns the guide and the number of copies.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SYMMETRY_MODES], description: 'off, vertical (mirror left / right), horizontal (top / bottom), dual, diagonal or kaleidoscope.' },
          center: { ...POINT, description: 'Centre of the axes in document pixels (default the canvas centre).' },
          rotation: { type: 'number', minimum: -360, maximum: 360, description: 'Turn the axes, degrees clockwise.' },
          segments: { type: 'integer', minimum: 2, maximum: 32, description: 'Kaleidoscope segments (default 6).' },
          mirror: { type: 'boolean', description: 'Kaleidoscope: also reflect alternate segments (default true).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Set mirror or kaleidoscope painting', ...SET },
      handler: (a) => {
        const s = c.setSymmetry(a);
        return { ...s, copies: symmetryCopies(s).length };
      },
    },
    {
      name: 'set_perspective_guide',
      title: 'Set the perspective guide',
      description:
        'Sets one to three vanishing points (document pixels, may be off the canvas). With snap on, pen strokes snap to the line through their start towards a vanishing point (one-point also keeps horizontals and verticals, two-point verticals); for paint_stroke pass snapToPerspective. Editor state, saved with the document. Returns the guide.',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'Show and use the guide.' },
          points: { type: 'array', minItems: 1, maxItems: 3, items: { ...POINT, description: 'A vanishing point.' }, description: 'The vanishing points.' },
          snap: { type: 'boolean', description: 'Snap strokes to the guide lines (default true).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Set the perspective guide', ...SET },
      handler: (a) => c.setPerspective(a),
    },
    {
      name: 'set_tracing_image',
      title: 'Set a tracing image',
      description:
        'Puts an image under the paint to trace over (view only: never exported), fitted to the canvas unless rect is given, at opacity (default 0.35). With sampleColors, strokes without a colour take the image colour where they start, so painting over it copies its colours. Replaces any tracing image. Returns its size and placement.',
      inputSchema: {
        type: 'object',
        properties: {
          png: PNG,
          rect: RECT,
          opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1 (default 0.35).' },
          sampleColors: { type: 'boolean', description: 'Strokes take their colour from the image (default false).' },
        },
        required: ['png'],
        additionalProperties: false,
      },
      annotations: { title: 'Set a tracing image', ...WRITE },
      handler: (a) => tracingInfo(c.setTracingImage(a)),
    },
    {
      name: 'update_tracing_image',
      title: 'Change the tracing image',
      description: 'Changes the tracing image opacity, visibility, placement or colour sampling. Returns it.',
      inputSchema: {
        type: 'object',
        properties: {
          opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1.' },
          visible: { type: 'boolean', description: 'Show or hide it.' },
          sampleColors: { type: 'boolean', description: 'Strokes take their colour from it.' },
          rect: RECT,
        },
        additionalProperties: false,
      },
      annotations: { title: 'Change the tracing image', ...SET },
      handler: (a) => tracingInfo(c.updateTracing(a)),
    },
    {
      name: 'clear_tracing_image',
      title: 'Remove the tracing image',
      description: 'Removes the tracing image. Returns null.',
      inputSchema: EMPTY,
      annotations: { title: 'Remove the tracing image', ...DESTRUCTIVE },
      handler: () => {
        c.clearTracingImage();
        return { tracing: null };
      },
    },
    {
      name: 'add_reference_image',
      title: 'Add a reference image',
      description: 'Adds a floating reference image (shown beside the canvas, never painted) to look at and pick colours from with pick_reference_color. Returns its id, size and placement.',
      inputSchema: {
        type: 'object',
        properties: {
          png: PNG,
          name: { type: 'string', minLength: 1, description: 'Display name.' },
          x: { type: 'number', description: 'Panel left in viewport pixels.' },
          y: { type: 'number', description: 'Panel top in viewport pixels.' },
          displayWidth: { type: 'number', minimum: 16, maximum: 4096, description: 'Panel width in screen pixels (default up to 240).' },
        },
        required: ['png'],
        additionalProperties: false,
      },
      annotations: { title: 'Add a reference image', ...WRITE },
      handler: (a) => refInfo(c.addReferenceImage(a)),
    },
    {
      name: 'list_reference_images',
      title: 'List reference images',
      description: 'Lists the reference images: id, name, size in pixels, panel placement and visibility.',
      inputSchema: EMPTY,
      annotations: { title: 'List reference images', ...READ },
      handler: () => ({ references: guides().references.map(refInfo) }),
    },
    {
      name: 'update_reference_image',
      title: 'Change a reference image',
      description: 'Moves, resizes, renames, shows or hides a reference image panel. Returns it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Reference id from list_reference_images.' },
          name: { type: 'string', minLength: 1, description: 'Display name.' },
          x: { type: 'number', description: 'Panel left in viewport pixels.' },
          y: { type: 'number', description: 'Panel top in viewport pixels.' },
          displayWidth: { type: 'number', minimum: 16, maximum: 4096, description: 'Panel width in screen pixels.' },
          visible: { type: 'boolean', description: 'Show or hide it.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Change a reference image', ...SET },
      handler: ({ id, ...u }) => refInfo(c.updateReferenceImage(id, u)),
    },
    {
      name: 'remove_reference_image',
      title: 'Remove a reference image',
      description: 'Removes a reference image. Returns the removed id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Reference id from list_reference_images.' } }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Remove a reference image', ...DESTRUCTIVE },
      handler: ({ id }) => {
        c.removeReferenceImage(id);
        return { removed: id };
      },
    },
    {
      name: 'pick_reference_color',
      title: 'Pick a colour from a reference',
      description: 'Reads the colour of a reference image at its own pixel (x, y). With setColor it becomes the paint colour. Returns #rrggbb.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Reference id from list_reference_images.' },
          x: { type: 'number', minimum: 0, description: 'x in the image’s pixels.' },
          y: { type: 'number', minimum: 0, description: 'y in the image’s pixels.' },
          setColor: { type: 'boolean', description: 'Also make it the paint colour (default false).' },
        },
        required: ['id', 'x', 'y'],
        additionalProperties: false,
      },
      annotations: { title: 'Pick a colour from a reference', ...SET },
      handler: ({ id, x, y, setColor }) => {
        const color = c.pickReferenceColor(id, x, y);
        if (setColor) c.setColor(color);
        return { color };
      },
    },
    {
      name: 'color_harmony',
      title: 'Colour harmonies',
      description:
        'Returns the colours of a harmony around a colour (default the paint colour): complementary, split-complementary, analogous, triadic, tetradic, square or monochromatic, on the painter’s red-yellow-blue wheel (default: red’s complement is green) or the RGB wheel. Changes nothing. Returns the colours with their wheel angles, the base first.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...HARMONY_KINDS], description: 'The harmony.' },
          color: { ...COLOR, description: 'Base colour #rrggbb (default the paint colour).' },
          wheel: { type: 'string', enum: ['ryb', 'rgb'], description: 'ryb (painter’s wheel, default) or rgb.' },
          spread: { type: 'number', minimum: 5, maximum: 90, description: 'Analogous and split-complementary spread in degrees (default 30).' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      annotations: { title: 'Colour harmonies', ...READ },
      handler: ({ kind, color, wheel, spread }) => ({ kind, wheel: wheel ?? 'ryb', colors: c.harmony(kind, { color, wheel, spread }) }),
    },
    {
      name: 'list_swatches',
      title: 'List swatches',
      description: 'Lists the colour swatches (index, colour, name).',
      inputSchema: EMPTY,
      annotations: { title: 'List swatches', ...READ },
      handler: () => ({ swatches: c.getState().swatches.map((s, index) => ({ index, ...s })) }),
    },
    {
      name: 'add_swatch',
      title: 'Add a swatch',
      description: 'Adds a colour to the swatches (saved with the document). Returns the swatches.',
      inputSchema: {
        type: 'object',
        properties: { color: COLOR, name: { type: 'string', minLength: 1, description: 'Optional name.' } },
        required: ['color'],
        additionalProperties: false,
      },
      annotations: { title: 'Add a swatch', ...WRITE },
      handler: ({ color, name }) => ({ swatches: c.addSwatch(color, name).map((s, index) => ({ index, ...s })) }),
    },
    {
      name: 'remove_swatch',
      title: 'Remove a swatch',
      description: 'Removes a swatch by index (from list_swatches). Returns the swatches.',
      inputSchema: { type: 'object', properties: { index: { type: 'integer', minimum: 0, description: '0-based index.' } }, required: ['index'], additionalProperties: false },
      annotations: { title: 'Remove a swatch', ...DESTRUCTIVE },
      handler: ({ index }) => ({ swatches: c.removeSwatch(index).map((s, i) => ({ index: i, ...s })) }),
    },
    {
      name: 'mixing_pad_stroke',
      title: 'Paint on the mixing pad',
      description:
        'Paints on the mixing pad (a 360 × 220 scratch canvas, not the painting): tool paint lays down a colour with a pigment Mixer Brush; tool knife smears what is there like a palette knife, mixing it as paint. Points are pad pixels. Not an undo step. Returns the changed bounds; then pick_mixing_pad_color.',
      inputSchema: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            minItems: 1,
            maxItems: 2000,
            description: 'The path in pad pixels (0..360, 0..220).',
            items: {
              type: 'object',
              properties: { x: { type: 'number', description: 'Pad x.' }, y: { type: 'number', description: 'Pad y.' }, pressure: { type: 'number', minimum: 0, maximum: 1, description: 'Pressure (default 1).' } },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
          tool: { type: 'string', enum: ['paint', 'knife'], description: 'paint (default) or knife.' },
          color: { ...COLOR, description: 'Paint colour (default the paint colour; ignored by the knife).' },
          size: { type: 'number', minimum: 1, maximum: 200, description: 'Tool size in pad pixels (default 28 paint, 34 knife).' },
        },
        required: ['points'],
        additionalProperties: false,
      },
      annotations: { title: 'Paint on the mixing pad', ...WRITE },
      handler: ({ points, tool, color, size }) => c.mixingPadStroke(points as PenPoint[], { tool, color, size }),
    },
    {
      name: 'pick_mixing_pad_color',
      title: 'Pick from the mixing pad',
      description: 'Reads the mixed colour on the pad at (x, y), averaged over radius pixels (default 3); with setColor it becomes the paint colour. Returns #rrggbb, or null where the pad is bare.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', minimum: 0, maximum: 360, description: 'Pad x.' },
          y: { type: 'number', minimum: 0, maximum: 220, description: 'Pad y.' },
          radius: { type: 'integer', minimum: 0, maximum: 20, description: 'Averaging radius in pixels (default 3).' },
          setColor: { type: 'boolean', description: 'Also make it the paint colour (default false).' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      annotations: { title: 'Pick from the mixing pad', ...SET },
      handler: ({ x, y, radius, setColor }) => ({ color: c.mixingPadPick(x, y, { radius, setColor }) }),
    },
    {
      name: 'clear_mixing_pad',
      title: 'Clear the mixing pad',
      description: 'Wipes the mixing pad clean.',
      inputSchema: EMPTY,
      annotations: { title: 'Clear the mixing pad', ...DESTRUCTIVE },
      handler: () => {
        c.clearMixingPad();
        return { cleared: true };
      },
    },
    {
      name: 'render_mixing_pad',
      title: 'Render the mixing pad',
      description: 'Renders the mixing pad as a PNG (360 × 220, over white). Changes nothing.',
      inputSchema: EMPTY,
      annotations: { title: 'Render the mixing pad', ...READ },
      handler: () => {
        const pad = c.mixingPad;
        return {
          content: [
            { type: 'image', data: bytesToBase64(encodePng(pad.width, pad.height, pad.pixels())), mimeType: 'image/png' },
            { type: 'text', text: `Mixing pad ${pad.width}×${pad.height}` },
          ],
        };
      },
    },
  ];
}
