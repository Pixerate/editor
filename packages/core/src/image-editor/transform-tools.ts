import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { LayerOperationError } from './layers/ops';
import { FREE_TRANSFORM_CONTENTS, type FreeTransformContent, type FreeTransformInit, type FreeTransformResult } from './free-transform';
import {
  TRANSFORM_ANCHORS,
  WARP_STYLES,
  identityTransform,
  isTransformAnchor,
  type AffineMatrix,
  type Quad,
  type TransformParams,
  type WarpMesh,
  type WarpStyle,
} from './transform';
import { INTERPOLATIONS, type Interpolation } from '../raster/transform';
import { identityWarpMesh, warpMeshColumns, warpMeshRows } from '../geom/warp';
import type { LayerTarget } from './layers/model';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const roundPoint = (p: { x: number; y: number }) => ({ x: round(p.x), y: round(p.y) });

const POINT = {
  type: 'object',
  properties: { x: { type: 'number', description: 'Document pixels from the left.' }, y: { type: 'number', description: 'Document pixels from the top.' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;

const TARGET = {
  layerId: { type: 'string', description: 'Layer to transform (from list_layers; default the active layer).' },
  content: {
    type: 'string',
    enum: FREE_TRANSFORM_CONTENTS.filter((c) => c !== 'selection-outline'),
    description:
      'What moves: layer (all its pixels with a linked mask), selection (only the selected pixels, committed back into the layer; the outline moves too), selection-copy (Layer via Copy: the selected pixels on a new layer above, then transformed; the original stays) or auto (default: selection when something is selected, else layer).',
  },
  channel: {
    type: 'string',
    enum: ['pixels', 'mask'],
    description: 'pixels (default) moves the pixels and a linked mask; mask moves an unlinked mask alone (a linked mask always moves with its pixels).',
  },
  interpolation: { type: 'string', enum: INTERPOLATIONS, description: 'Resampling: nearest (hard pixels), bilinear or bicubic (default, Photoshop’s Bicubic).' },
} as const;

const GEOMETRY = {
  scaleX: { type: 'number', description: 'Width in percent of the frame (default 100; negative flips horizontally).' },
  scaleY: { type: 'number', description: 'Height in percent of the frame (default 100; negative flips vertically).' },
  rotate: { type: 'number', description: 'Rotation in degrees, clockwise (default 0).' },
  skewX: { type: 'number', minimum: -89, maximum: 89, description: 'Horizontal skew in degrees: vertical edges lean right for positive angles (default 0).' },
  skewY: { type: 'number', minimum: -89, maximum: 89, description: 'Vertical skew in degrees: horizontal edges lean down for positive angles (default 0).' },
  dx: { type: 'number', description: 'Move right after scaling and rotating, in document pixels (default 0).' },
  dy: { type: 'number', description: 'Move down after scaling and rotating, in document pixels (default 0).' },
  reference: {
    description: 'Fixed point of scale, skew and rotate: an anchor of the frame (top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right; default center) or a document point {x, y}.',
    anyOf: [{ type: 'string', enum: TRANSFORM_ANCHORS }, POINT],
  },
  matrix: {
    type: 'array',
    items: { type: 'number' },
    minItems: 6,
    maxItems: 6,
    description: "Instead of the numeric fields: an affine matrix [a, b, c, d, e, f] in document pixels (x' = a·x + c·y + e, y' = b·x + d·y + f).",
  },
  corners: {
    type: 'array',
    items: POINT,
    minItems: 4,
    maxItems: 4,
    description:
      'Instead of the numeric fields: where the frame’s corners go, [top-left, top-right, bottom-right, bottom-left] in document pixels (Distort; for Perspective move a pair of corners symmetrically). The quad must stay convex. Get the frame and its corners from get_transform_frame.',
  },
} as const;

const NUMERIC = ['scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'dx', 'dy', 'reference'] as const;

function geometryFrom(args: Record<string, unknown>): { matrix?: AffineMatrix; corners?: Quad; params?: TransformParams } {
  const numeric = NUMERIC.filter((k) => args[k] !== undefined);
  const ways = [numeric.length > 0, args.matrix !== undefined, args.corners !== undefined].filter(Boolean).length;
  if (ways === 0) throw new LayerOperationError('Give the transform one way: numeric fields (scaleX, scaleY, rotate, skewX, skewY, dx, dy, reference), matrix, or corners.');
  if (ways > 1) throw new LayerOperationError('Give the transform only one way: numeric fields, matrix or corners, not a mix.');
  if (args.matrix !== undefined) return { matrix: args.matrix as unknown as AffineMatrix };
  if (args.corners !== undefined) return { corners: args.corners as unknown as Quad };
  const params: TransformParams = {};
  for (const k of NUMERIC) if (args[k] !== undefined) (params as Record<string, unknown>)[k] = args[k];
  if (params.scaleX === 0 || params.scaleY === 0) throw new LayerOperationError('scaleX and scaleY must not be 0 (that collapses the layer to a line).');
  if (typeof params.reference === 'string' && !isTransformAnchor(params.reference)) throw new LayerOperationError(`Unknown reference "${params.reference}". Use ${TRANSFORM_ANCHORS.join(', ')} or {x, y}.`);
  return { params };
}

function targetFrom(args: Record<string, unknown>): FreeTransformInit {
  const init: FreeTransformInit = {};
  if (typeof args.layerId === 'string') init.layerId = args.layerId;
  if (args.content !== undefined) init.content = args.content as FreeTransformContent;
  init.channel = (args.channel as LayerTarget | undefined) ?? 'pixels';
  if (args.interpolation !== undefined) init.interpolation = args.interpolation as Interpolation;
  return init;
}

function summary(res: FreeTransformResult) {
  return {
    layerId: res.layerId,
    content: res.content,
    moved: res.moved,
    changed: res.changed,
    frame: { ...res.box },
    corners: res.corners.map(roundPoint),
    bounds: res.bounds,
  };
}

/**
 * Agent tools for Free Transform in the image editor: `get_transform_frame`, `transform_layer`
 * (scale, rotate, skew and move as numbers, a matrix, or distort / perspective corners),
 * `warp_layer` (a preset or a Bézier mesh), `transform_selection` (the outline only),
 * `flip_layer` and `rotate_layer_90`. Every write is one undo step, resamples tile by tile and
 * returns the new bounds.
 */
export function createImageTransformTools(controller: ImageEditorController): AgentTool[] {
  const getFrame: AgentTool = {
    name: 'get_transform_frame',
    title: 'Get the Free Transform frame',
    description:
      'Returns what a transform would move and its frame: content (layer, selection, selection-copy or selection-outline), moved (pixels, mask, selection), the frame (document bounds of the content), its corners [top-left, top-right, bottom-right, bottom-left] and centre. Pass meshColumns / meshRows to also get the identity warp mesh over the frame to edit for warp_layer. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: TARGET.layerId,
        content: { type: 'string', enum: FREE_TRANSFORM_CONTENTS, description: `${TARGET.content.description} selection-outline frames the selection outline alone.` },
        channel: TARGET.channel,
        meshColumns: { type: 'integer', minimum: 1, maximum: 16, description: 'Patch columns of an identity warp mesh to return (omit for none).' },
        meshRows: { type: 'integer', minimum: 1, maximum: 16, description: 'Patch rows of an identity warp mesh to return (default meshColumns).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Get the Free Transform frame', ...READ },
    handler: (args) => {
      const init = targetFrom(args);
      // A copy's frame is the selection's; framing it must not add the layer.
      if (init.content === 'selection-copy') init.content = 'selection';
      const s = controller.beginFreeTransform(init);
      const out: Record<string, unknown> = {
        layerId: s.layerId,
        content: args.content === 'selection-copy' ? 'selection-copy' : s.content,
        moved: [...s.moves],
        frame: { ...s.box },
        corners: identityTransform(s.box).corners.map(roundPoint),
        center: roundPoint({ x: s.box.x + s.box.width / 2, y: s.box.y + s.box.height / 2 }),
      };
      s.cancel();
      if (args.meshColumns !== undefined) {
        const cols = args.meshColumns as number;
        const rows = (args.meshRows as number | undefined) ?? cols;
        const mesh = identityWarpMesh(s.box, cols, rows);
        out.mesh = { columns: cols, rows, pointsPerRow: warpMeshColumns(mesh), pointRows: warpMeshRows(mesh), points: mesh.points.map(roundPoint) };
      }
      return out;
    },
  };

  const transformLayer: AgentTool = {
    name: 'transform_layer',
    title: 'Free Transform a layer',
    description:
      'Edit › Free Transform: scales, rotates, skews, moves, distorts or puts in perspective a pixel layer (with its linked mask), the selected pixels, a copy of them on a new layer, or an unlinked mask. Give the transform one way: the numeric fields (as Photoshop’s options bar, about a reference point), a matrix, or the frame’s new corners (distort / perspective; read the frame with get_transform_frame). Resamples once, tile by tile; one undo step. Returns layerId (the new layer for selection-copy), what moved, the frame, the corners and the new document bounds.',
    inputSchema: {
      type: 'object',
      properties: { ...TARGET, ...GEOMETRY },
      additionalProperties: false,
    },
    annotations: { title: 'Free Transform a layer', ...WRITE },
    handler: (args) => summary(controller.transformLayer({ ...targetFrom(args), ...geometryFrom(args) })),
  };

  const warpLayer: AgentTool = {
    name: 'warp_layer',
    title: 'Warp a layer',
    description:
      'Edit › Transform › Warp: bends a pixel layer (with its linked mask), the selected pixels, a copy of them, or an unlinked mask through a preset (style with bend and distortions in percent) or a Bézier mesh over the frame (get the frame and an identity mesh to edit from get_transform_frame with meshColumns). Give style or mesh, not both. One undo step. Returns what moved and the new document bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        style: { type: 'string', enum: WARP_STYLES, description: 'Preset warp (Photoshop’s menu): arc, arcLower, arcUpper, arch, bulge, shellLower, shellUpper, flag, wave, fish, rise, fisheye, inflate, squeeze, twist.' },
        bend: { type: 'number', minimum: -100, maximum: 100, description: 'Preset bend in percent, −100..100 (default 50).' },
        horizontal: { type: 'number', minimum: -100, maximum: 100, description: 'Preset horizontal distortion in percent, −100..100 (default 0).' },
        vertical: { type: 'number', minimum: -100, maximum: 100, description: 'Preset vertical distortion in percent, −100..100 (default 0).' },
        orientation: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Bend along the horizontal (default) or vertical axis.' },
        mesh: {
          type: 'object',
          description: 'A custom warp: patch columns and rows, and the (3·columns + 1) × (3·rows + 1) control points row by row in document pixels (anchors where both indices are multiples of 3, Bézier handles between). Start from get_transform_frame’s identity mesh.',
          properties: {
            columns: { type: 'integer', minimum: 1, maximum: 16, description: 'Patch columns.' },
            rows: { type: 'integer', minimum: 1, maximum: 16, description: 'Patch rows.' },
            points: { type: 'array', items: POINT, minItems: 16, description: 'Control points, row by row, document pixels.' },
          },
          required: ['columns', 'rows', 'points'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Warp a layer', ...WRITE },
    handler: (args) => {
      const hasPreset = ['style', 'bend', 'horizontal', 'vertical', 'orientation'].some((k) => args[k] !== undefined);
      if (hasPreset && args.mesh !== undefined) throw new LayerOperationError('Give a preset (style, bend, horizontal, vertical, orientation) or a mesh, not both.');
      if (!hasPreset && args.mesh === undefined) throw new LayerOperationError('Give a preset style or a mesh.');
      let warp: WarpMesh | { style: WarpStyle; bend: number; horizontal?: number; vertical?: number; orientation?: 'horizontal' | 'vertical' };
      if (hasPreset) {
        if (args.style === undefined) throw new LayerOperationError(`style is required with a preset. Styles: ${WARP_STYLES.join(', ')}.`);
        warp = {
          style: args.style as WarpStyle,
          bend: (args.bend as number | undefined) ?? 50,
          horizontal: args.horizontal as number | undefined,
          vertical: args.vertical as number | undefined,
          orientation: args.orientation as 'horizontal' | 'vertical' | undefined,
        };
      } else {
        const m = args.mesh as { columns: number; rows: number; points: { x: number; y: number }[] };
        const want = (3 * m.columns + 1) * (3 * m.rows + 1);
        if (m.points.length !== want) throw new LayerOperationError(`A ${m.columns} × ${m.rows} mesh needs (3·${m.columns} + 1) × (3·${m.rows} + 1) = ${want} points, got ${m.points.length}.`);
        const knots = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
        warp = { us: knots(m.columns), vs: knots(m.rows), points: m.points.map((p) => ({ x: p.x, y: p.y })) };
      }
      return summary(controller.transformLayer({ ...targetFrom(args), warp }));
    },
  };

  const transformSelection: AgentTool = {
    name: 'transform_selection',
    title: 'Transform the selection outline',
    description:
      'Select › Transform Selection: scales, rotates, skews, moves or distorts only the selection outline; no pixels change. Give the transform one way: the numeric fields (about a reference point of the selection’s bounds), a matrix, or the new corners of its bounds. Needs a selection. One undo step. Returns the new selection bounds.',
    inputSchema: {
      type: 'object',
      properties: { interpolation: { ...TARGET.interpolation, description: 'Resampling of soft edges: nearest, bilinear or bicubic (default).' }, ...GEOMETRY },
      additionalProperties: false,
    },
    annotations: { title: 'Transform the selection outline', ...WRITE },
    handler: (args) => {
      const res = controller.transformLayer({ content: 'selection-outline', interpolation: args.interpolation as Interpolation | undefined, ...geometryFrom(args) });
      return { changed: res.changed, frame: { ...res.box }, corners: res.corners.map(roundPoint), bounds: res.bounds };
    },
  };

  const flipLayer: AgentTool = {
    name: 'flip_layer',
    title: 'Flip a layer',
    description:
      'Edit › Transform › Flip Horizontal or Vertical: mirrors a pixel layer (with its linked mask), the selected pixels or a copy of them about the centre of their frame, exactly (no resampling). To flip the whole image use flip_image. One undo step. Returns the new bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['horizontal', 'vertical'], description: 'horizontal mirrors left ↔ right, vertical top ↔ bottom.' },
        layerId: TARGET.layerId,
        content: TARGET.content,
        channel: TARGET.channel,
      },
      required: ['axis'],
      additionalProperties: false,
    },
    annotations: { title: 'Flip a layer', ...WRITE },
    handler: (args) => summary(controller.flipLayer(args.axis as 'horizontal' | 'vertical', targetFrom(args))),
  };

  const rotate90: AgentTool = {
    name: 'rotate_layer_90',
    title: 'Rotate a layer by quarter turns',
    description:
      'Edit › Transform › Rotate 90° / 180°: turns a pixel layer (with its linked mask), the selected pixels or a copy of them about the centre of their frame, exactly (pixels land on whole pixels; no resampling). To rotate the whole image use set_rotation. One undo step. Returns the new bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        turn: { type: 'integer', enum: [90, -90, 180], description: 'Degrees: 90 clockwise, -90 counter-clockwise, or 180.' },
        layerId: TARGET.layerId,
        content: TARGET.content,
        channel: TARGET.channel,
      },
      required: ['turn'],
      additionalProperties: false,
    },
    annotations: { title: 'Rotate a layer by quarter turns', ...WRITE },
    handler: (args) => summary(controller.rotateLayer90(args.turn as 90 | -90 | 180, targetFrom(args))),
  };

  return [getFrame, transformLayer, warpLayer, transformSelection, flipLayer, rotate90];
}

