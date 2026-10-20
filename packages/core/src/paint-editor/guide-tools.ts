/**
 * Agent tools for the paint editor's painting guides (symmetry, perspective, tracing and reference
 * images) and colour (harmonies, swatches, the mixing pad). Guides, swatches and the pad are
 * editor state saved with the document (the pad is not saved), not undo steps.
 */

import { PAINT_SOURCE_JSON_SCHEMA } from '../paint/gradient-paint';
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
  const STENCIL_GEOMETRY = {
    mode: { type: 'string', enum: ['guide', 'mask'], description: 'guide: strokes that start within snap px of the edge follow it; mask: paint lands only inside (or on the left of a line going from → to), outside with invert. Default guide for ruler and arc, mask for line and shape.' },
    enabled: { type: 'boolean', description: 'In effect and shown (default true).' },
    from: { ...POINT, description: 'ruler / line: a point on the edge.' },
    to: { ...POINT, description: 'ruler / line: another point on the edge (the edge runs on past both).' },
    center: { ...POINT, description: 'arc: the centre.' },
    radius: { type: 'number', exclusiveMinimum: 0, description: 'arc: the radius in pixels.' },
    startAngle: { type: 'number', minimum: -720, maximum: 720, description: 'arc: where it starts, degrees clockwise from +x (default 0).' },
    endAngle: { type: 'number', minimum: -720, maximum: 720, description: 'arc: where it ends (default 360: the whole circle).' },
    shape: { type: 'string', enum: ['rect', 'ellipse', 'polygon'], description: 'shape: rect or ellipse (with rect) or polygon (with points).' },
    rect: { ...RECT, description: 'shape rect / ellipse: its bounds in document pixels.' },
    points: { type: 'array', minItems: 3, maxItems: 500, items: POINT, description: 'shape polygon: its corners in order.' },
    invert: { type: 'boolean', description: 'mask: paint outside the shape (or on the right of the line) instead (default false).' },
    snap: { type: 'number', minimum: 1, maximum: 400, description: 'guide: how near the edge a stroke must start to follow it, px (default 40).' },
    feather: { type: 'number', minimum: 0, maximum: 100, description: 'mask: soft edge width in pixels (default 1).' },
  } as const;
  return [
    {
      name: 'get_guides',
      title: 'Get the painting guides',
      description: 'Reads the painting guides: symmetry (mode, centre, rotation, segments, mirror, and how many copies each stroke paints), the perspective guide (vanishing points, snap), the tracing image (size, placement, opacity, visibility, colour sampling), the reference images and the stencils (id, kind, mode, geometry).',
      inputSchema: EMPTY,
      annotations: { title: 'Get the painting guides', ...READ },
      handler: () => {
        const g = guides();
        return { symmetry: { ...g.symmetry, copies: symmetryCopies(g.symmetry).length }, perspective: g.perspective, tracing: tracingInfo(g.tracing), references: g.references.map(refInfo), stencils: g.stencils };
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
      description: 'Lists the swatches (index, colour, name, and paint for a gradient swatch).',
      inputSchema: EMPTY,
      annotations: { title: 'List swatches', ...READ },
      handler: () => ({ swatches: c.getState().swatches.map((s, index) => ({ index, ...s })) }),
    },
    {
      name: 'add_swatch',
      title: 'Add a swatch',
      description: 'Adds a swatch (saved with the document): a colour, or with paint a gradient (set_paint picks it up again from list_swatches). Give color or paint. Returns the swatches; a gradient swatch has paint and its first colour as color.',
      inputSchema: {
        type: 'object',
        properties: {
          color: { ...COLOR, description: 'A colour #rrggbb.' },
          paint: { ...PAINT_SOURCE_JSON_SCHEMA, description: 'Gradient paint (or a colour) for the swatch, instead of color.' },
          name: { type: 'string', minLength: 1, description: 'Optional name.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Add a swatch', ...WRITE },
      handler: ({ color, paint, name }) => {
        if ((color === undefined) === (paint === undefined)) throw new Error('Give color (#rrggbb) or paint (a colour or gradient), not both and not neither.');
        return { swatches: c.addSwatch(paint ?? color, name).map((s, index) => ({ index, ...s })) };
      },
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
        'Paints on the mixing pad (a 360 × 220 scratch canvas, not the painting): tool paint lays down a colour with a pigment Mixer Brush; tool knife smears what is there like a palette knife, mixing it as paint. Points are pad pixels. Not an undo step. Returns the changed bounds; then pick_mixing_pad_color. For a measured mix in one call use mix_on_pad.',
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
      name: 'mix_on_pad',
      title: 'Mix paints on the pad',
      description:
        'Mixes paints on the mixing pad as a painter would: blobs whose areas follow their parts, worked with the palette knife, and a fully mixed core of the Kubelka-Munk (pigment) mix, so blue and yellow make green and white tints. One call per mix. Not an undo step (the pad is scratch space). Returns the mixed colour #rrggbb and the pile bounds in pad pixels; with setColor it becomes the paint colour. pick_mixing_pad_color reads the streaks around it.',
      inputSchema: {
        type: 'object',
        properties: {
          paints: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            description: 'The paints, 1 to 8.',
            items: {
              type: 'object',
              properties: {
                color: { ...COLOR, description: 'Paint colour #rrggbb.' },
                parts: { type: 'number', minimum: 0, description: 'Parts of this paint, any scale (1 and 3 for a 1:3 mix); at least one above 0.' },
              },
              required: ['color', 'parts'],
              additionalProperties: false,
            },
          },
          x: { type: 'number', minimum: 0, maximum: 360, description: 'Centre of the pile, pad x (default 180).' },
          y: { type: 'number', minimum: 0, maximum: 220, description: 'Centre of the pile, pad y (default 110).' },
          radius: { type: 'number', minimum: 12, maximum: 100, description: 'Radius of the pile in pad pixels (default 40); it must fit on the pad.' },
          passes: { type: 'integer', minimum: 1, maximum: 20, description: 'Palette-knife passes (default 3; more gives finer streaks around the core).' },
          clear: { type: 'boolean', description: "Wipe the pile's area first (default true); false mixes into the paint already there." },
          setColor: { type: 'boolean', description: 'Also make the mix the paint colour (default false).' },
        },
        required: ['paints'],
        additionalProperties: false,
      },
      annotations: { title: 'Mix paints on the pad', ...WRITE },
      handler: ({ paints, x, y, radius, passes, clear, setColor }) => c.mixOnPad(paints, { x, y, radius, passes, clear, setColor }),
    },
    {
      name: 'save_mixing_pad',
      title: 'Keep the mixing pad',
      description: 'Keeps the mixing pad as it is now under a name, saved with the document, to come back to with load_mixing_pad. Refused while the pad is empty. Returns the kept pad id and name.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80, description: 'Name (default "Pad n").' } }, additionalProperties: false },
      annotations: { title: 'Keep the mixing pad', ...WRITE },
      handler: ({ name }) => c.saveMixingPad(name),
    },
    {
      name: 'list_mixing_pads',
      title: 'List kept mixing pads',
      description: 'Lists the mixing pads kept with save_mixing_pad (id, name). Changes nothing.',
      inputSchema: EMPTY,
      annotations: { title: 'List kept mixing pads', ...READ },
      handler: () => ({ pads: c.listMixingPads() }),
    },
    {
      name: 'load_mixing_pad',
      title: 'Load a kept mixing pad',
      description: 'Puts a kept pad (id from list_mixing_pads) back on the mixing pad, replacing what is on it. Returns the pad id and name.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Kept pad id from list_mixing_pads.' } }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Load a kept mixing pad', ...DESTRUCTIVE },
      handler: ({ id }) => c.loadMixingPad(id),
    },
    {
      name: 'remove_mixing_pad',
      title: 'Remove a kept mixing pad',
      description: 'Forgets a kept pad (id from list_mixing_pads); the pad on screen is untouched. Returns the removed id and name.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Kept pad id from list_mixing_pads.' } }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Remove a kept mixing pad', ...DESTRUCTIVE },
      handler: ({ id }) => c.removeMixingPad(id),
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
    {
      name: 'add_stencil',
      title: 'Lay a stencil',
      description:
        'Lays a stencil on the canvas: a ruler (straight edge to draw along) or an arc (circle or part of one) that pointer and agent strokes starting near it follow exactly, or a line (straight masking edge) or a shape (rect, ellipse or polygon template) that paint lands only inside of (outside with invert). Editor state saved with the document, not an undo step; replays keep the mask they were painted through. Returns the stencil with its id.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['ruler', 'arc', 'line', 'shape'], description: 'ruler, arc, line or shape.' }, ...STENCIL_GEOMETRY }, required: ['kind'], additionalProperties: false },
      annotations: { title: 'Lay a stencil', ...WRITE },
      handler: (a) => c.addStencil(a as Parameters<PaintEditorController["addStencil"]>[0]),
    },
    {
      name: 'update_stencil',
      title: 'Change a stencil',
      description: 'Moves, reshapes, switches (guide or mask, invert) or hides (enabled false) a stencil by id from get_guides. Returns the stencil.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Stencil id from get_guides.' }, ...STENCIL_GEOMETRY }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Change a stencil', ...SET },
      handler: ({ id, ...update }) => c.updateStencil(id, update),
    },
    {
      name: 'remove_stencils',
      title: 'Take stencils away',
      description: 'Removes stencils by id, or every stencil when ids is missing. Returns the ids removed.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string', description: 'Stencil id.' }, description: 'Stencil ids from get_guides (default all).' } }, additionalProperties: false },
      annotations: { title: 'Take stencils away', ...DESTRUCTIVE },
      handler: ({ ids }) => ({ removed: c.removeStencils(ids) }),
    },
  ];
}
