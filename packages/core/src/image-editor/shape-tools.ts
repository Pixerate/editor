import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController, ShapeGeometryInput, ShapeLayerInit, VectorMaskPathInput } from './controller';
import type { SelectionToPathOptions } from './selection/path';
import { selectionArea } from './selection/mask';
import { BLEND_MODES, type BlendMode } from './blend';
import { findLayer } from './layers/model';
import { LayerOperationError } from './layers/ops';
import { requireShapeLayer } from './layers/shape';
import { describeLayer } from './layer-tools';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const LAYER_ID = { type: 'string', description: 'Shape layer id from list_layers (type shape) or add_shape_layer.' } as const;
const COMPONENT_INDEX = { type: 'integer', minimum: 0, description: 'Component index from get_shape_layer (0 = bottom component).' } as const;
const OP = {
  type: 'string',
  enum: ['combine', 'subtract', 'intersect', 'exclude'],
  description: 'How the component combines with the components below it (Photoshop path operations; default combine). The bottom component always combines.',
} as const;

const NUM = (description: string) => ({ type: 'number', description }) as const;
const MATRIX = {
  type: 'array',
  items: { type: 'number', description: 'Matrix entry.' },
  minItems: 6,
  maxItems: 6,
  description: "Optional affine map from the shape's own frame to the document [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f), e.g. a rotation. Default identity.",
} as const;
const BOX = {
  x: NUM('Left of the bounding box, document pixels.'),
  y: NUM('Top of the bounding box, document pixels.'),
  width: NUM('Width in pixels.'),
  height: NUM('Height in pixels.'),
  transform: { $ref: '#/$defs/matrix' },
} as const;

/** Shared parts, referenced as `#/$defs/...`. */
const DEFS = {
  matrix: MATRIX,
  point: {
    type: 'object',
    description: 'A point in document pixels.',
    properties: { x: NUM('Pixels from the left.'), y: NUM('Pixels from the top.') },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  arrowhead: {
    type: 'object',
    description: 'An arrowhead whose tip is the line end: a triangle, notched by concavity.',
    properties: {
      width: NUM('Width across the base, pixels.'),
      length: NUM('Length from base to tip, pixels.'),
      concavity: { type: 'number', minimum: -0.5, maximum: 0.5, description: 'Notch of the base towards the tip as a fraction of length (default 0).' },
    },
    required: ['width', 'length'],
    additionalProperties: false,
  },
  shape: {
    description:
      'A live shape (stays editable as that shape): rect (with optional corner radii), ellipse, polygon, star, or line (a filled bar with optional arrowheads). Sizes are document pixels.',
    anyOf: [
      {
        type: 'object',
        description: 'Rectangle.',
        properties: {
          kind: { const: 'rect', description: 'Rectangle.' },
          ...BOX,
          radius: { type: 'number', minimum: 0, description: 'One corner radius for all corners, pixels.' },
          radii: { type: 'array', items: { type: 'number', minimum: 0, description: 'Radius in pixels.' }, minItems: 4, maxItems: 4, description: 'Corner radii [top-left, top-right, bottom-right, bottom-left] in pixels.' },
        },
        required: ['kind', 'x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      { type: 'object', description: 'Ellipse inscribed in the box.', properties: { kind: { const: 'ellipse', description: 'Ellipse.' }, ...BOX }, required: ['kind', 'x', 'y', 'width', 'height'], additionalProperties: false },
      {
        type: 'object',
        description: 'Regular polygon inscribed in the box, first vertex at the top.',
        properties: { kind: { const: 'polygon', description: 'Polygon.' }, ...BOX, sides: { type: 'integer', minimum: 3, maximum: 100, description: 'Number of sides (default 6).' } },
        required: ['kind', 'x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      {
        type: 'object',
        description: 'Star inscribed in the box, first point at the top.',
        properties: {
          kind: { const: 'star', description: 'Star.' },
          ...BOX,
          points: { type: 'integer', minimum: 3, maximum: 100, description: 'Number of points (default 5).' },
          innerRatio: { type: 'number', minimum: 0.01, maximum: 1, description: 'Inner radius over outer radius (default 0.5).' },
        },
        required: ['kind', 'x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      {
        type: 'object',
        description: 'Line drawn as a filled bar.',
        properties: {
          kind: { const: 'line', description: 'Line.' },
          x1: NUM('Start x, document pixels.'),
          y1: NUM('Start y, document pixels.'),
          x2: NUM('End x, document pixels.'),
          y2: NUM('End y, document pixels.'),
          weight: { type: 'number', minimum: 0, description: 'Thickness in pixels (default 1).' },
          startArrow: { anyOf: [{ $ref: '#/$defs/arrowhead' }, { type: 'null', description: 'No arrowhead.' }], description: 'Arrowhead at the start, or null.' },
          endArrow: { anyOf: [{ $ref: '#/$defs/arrowhead' }, { type: 'null', description: 'No arrowhead.' }], description: 'Arrowhead at the end, or null.' },
          transform: { $ref: '#/$defs/matrix' },
        },
        required: ['kind', 'x1', 'y1', 'x2', 'y2'],
        additionalProperties: false,
      },
    ],
  },
  subpaths: {
    description: 'A free path: SVG path data (absolute or relative M, L, C, Q, A, Z) or subpaths with anchors. Handles are absolute document positions.',
    anyOf: [
      { type: 'string', description: 'SVG path data, document pixels.' },
      {
        type: 'array',
        minItems: 1,
        description: 'Subpaths.',
        items: {
          type: 'object',
          description: 'One subpath.',
          properties: {
            anchors: {
              type: 'array',
              minItems: 1,
              description: 'Anchors in order.',
              items: {
                type: 'object',
                description: 'An anchor with optional handles.',
                properties: {
                  x: NUM('Anchor x, document pixels.'),
                  y: NUM('Anchor y, document pixels.'),
                  in: { $ref: '#/$defs/point', description: 'Handle of the segment arriving here (absolute).' },
                  out: { $ref: '#/$defs/point', description: 'Handle of the segment leaving here (absolute).' },
                  corner: { type: 'number', minimum: 0, description: 'Live corner radius at this anchor, pixels.' },
                },
                required: ['x', 'y'],
                additionalProperties: false,
              },
            },
            closed: { type: 'boolean', description: 'Joins the last anchor back to the first (default true).' },
          },
          required: ['anchors'],
          additionalProperties: false,
        },
      },
    ],
  },
  gradient: {
    type: 'object',
    description: 'A gradient: colour stops, optional opacity stops and its layout (aligned with the shape bounds by default).',
    properties: {
      stops: {
        type: 'array',
        minItems: 1,
        description: 'Colour stops.',
        items: {
          type: 'object',
          description: 'A colour stop.',
          properties: { position: { type: 'number', minimum: 0, maximum: 1, description: '0..1 along the gradient.' }, color: { type: 'string', description: 'Colour (#rrggbb or a CSS colour).' } },
          required: ['position', 'color'],
          additionalProperties: false,
        },
      },
      opacityStops: {
        type: 'array',
        description: 'Opacity stops (default opaque).',
        items: {
          type: 'object',
          description: 'An opacity stop.',
          properties: { position: { type: 'number', minimum: 0, maximum: 1, description: '0..1 along the gradient.' }, opacity: { type: 'number', minimum: 0, maximum: 1, description: '0..1.' } },
          required: ['position', 'opacity'],
          additionalProperties: false,
        },
      },
      style: { type: 'string', enum: ['linear', 'radial', 'angle', 'reflected', 'diamond'], description: 'Geometry (default linear).' },
      angle: { type: 'number', minimum: -360, maximum: 360, description: 'Degrees, 90 = bottom to top (default 90).' },
      scale: { type: 'number', minimum: 0.1, maximum: 1.5, description: '1 = 100 % (default 1).' },
      reverse: { type: 'boolean', description: 'Swap the ends (default false).' },
      align: { type: 'boolean', description: 'Lay out over the shape bounds (true, default) or the canvas.' },
      offset: { $ref: '#/$defs/point', description: 'Centre offset as fractions of the bounds (default 0, 0).' },
    },
    required: ['stops'],
    additionalProperties: false,
  },
  paint: {
    description: 'What a fill or stroke paints with: a colour string (#rrggbb, #rrggbbaa, rgb(), a CSS name; alpha becomes opacity), or an object of type color, gradient or pattern.',
    anyOf: [
      { type: 'string', description: 'A colour.' },
      {
        type: 'object',
        description: 'Solid colour.',
        properties: { type: { const: 'color', description: 'Solid colour.' }, color: { type: 'string', description: 'Colour.' }, opacity: { type: 'number', minimum: 0, maximum: 1, description: '0..1 (default 1).' } },
        required: ['type', 'color'],
        additionalProperties: false,
      },
      {
        type: 'object',
        description: 'Gradient.',
        properties: { type: { const: 'gradient', description: 'Gradient.' }, gradient: { $ref: '#/$defs/gradient' }, opacity: { type: 'number', minimum: 0, maximum: 1, description: '0..1 (default 1).' } },
        required: ['type', 'gradient'],
        additionalProperties: false,
      },
      {
        type: 'object',
        description: 'Pattern (list_patterns gives ids).',
        properties: {
          type: { const: 'pattern', description: 'Pattern.' },
          patternId: { type: 'string', description: 'A document or built-in pattern id.' },
          scale: { type: 'number', minimum: 0.01, maximum: 10, description: '1 = 100 % (default 1).' },
          angle: { type: 'number', minimum: -360, maximum: 360, description: 'Degrees counter-clockwise (default 0).' },
          link: { type: 'boolean', description: 'Tile from the shape’s top-left (default true) instead of the canvas origin.' },
          phase: { $ref: '#/$defs/point', description: 'Origin offset in pixels.' },
          opacity: { type: 'number', minimum: 0, maximum: 1, description: '0..1 (default 1).' },
        },
        required: ['type', 'patternId'],
        additionalProperties: false,
      },
    ],
  },
  stroke: {
    type: 'object',
    description: 'The shape stroke (not the layer-effect stroke). Unset settings keep their current values (or the defaults).',
    properties: {
      width: { type: 'number', minimum: 0, maximum: 10000, description: 'Width in pixels (required for a new stroke).' },
      paint: { $ref: '#/$defs/paint' },
      color: { type: 'string', description: 'Shorthand for paint as a colour.' },
      align: { type: 'string', enum: ['inside', 'center', 'outside'], description: 'Where it sits on the outline (default center; open paths always centre).' },
      cap: { type: 'string', enum: ['butt', 'round', 'square'], description: 'Line ends (default butt).' },
      join: { type: 'string', enum: ['miter', 'round', 'bevel'], description: 'Corners (default miter).' },
      miterLimit: { type: 'number', minimum: 1, maximum: 500, description: 'Miter length over width above which a corner is bevelled (default 100).' },
      dashes: { type: 'array', maxItems: 32, items: { type: 'number', minimum: 0, description: 'Length in multiples of the width.' }, description: 'Dash and gap lengths in multiples of the stroke width ([] = solid).' },
      dashOffset: { type: 'number', description: 'Start offset into the dashes, multiples of the width (default 0).' },
    },
    additionalProperties: false,
  },
} as const;

const GEOMETRY = {
  shape: { $ref: '#/$defs/shape', description: 'A live shape: { kind: rect | ellipse | polygon | star | line, … } in document pixels. Give shape or subpaths.' },
  subpaths: { $ref: '#/$defs/subpaths', description: 'A free path: SVG path data or subpaths with anchors, document pixels. Give shape or subpaths.' },
} as const;

function geometry(args: Record<string, unknown>): ShapeGeometryInput {
  const out: ShapeGeometryInput = {};
  if (args.shape !== undefined) out.shape = args.shape as ShapeGeometryInput['shape'];
  if (args.subpaths !== undefined) out.subpaths = args.subpaths as ShapeGeometryInput['subpaths'];
  if (args.op !== undefined) out.op = args.op as ShapeGeometryInput['op'];
  return out;
}

/**
 * Agent tools for shape layers in the image editor: `get_shape_layer`, `add_shape_layer`,
 * `update_shape` (fill, stroke, fill rule), `set_shape_component`, `add_shape_component`,
 * `remove_shape_component` and `merge_shape_components`. Every write is one undo step, validates
 * first and returns the shape as it is afterwards.
 */
export function createImageShapeTools(controller: ImageEditorController): AgentTool[] {
  const shapeId = (id: unknown) => {
    if (typeof id !== 'string' || !id) throw new LayerOperationError('layerId is required (a shape layer id from list_layers).');
    requireShapeLayer(controller.getLayers(), id);
    return id;
  };
  const layerSummary = (id: string) => {
    const s = controller.getState();
    const loc = findLayer(s.layers, id);
    return loc ? { ...describeLayer(loc.layer, s.activeLayerId, (x) => controller.getLayerBounds(x.id)), parentId: loc.parent?.id ?? null, index: loc.index } : null;
  };

  const get: AgentTool = {
    name: 'get_shape_layer',
    title: 'Read a shape layer',
    description:
      'Returns a shape layer’s components bottom to top (index, path operation, the live shape it was drawn as or null, its subpaths with absolute anchors and handles, bounds), the fill rule, fill and stroke paints and settings, the path bounds and the rendered bounds (stroke included). Changes nothing.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Read a shape layer', ...READ },
    handler: ({ layerId }) => controller.getShapeLayer(shapeId(layerId)),
  };

  const add: AgentTool = {
    name: 'add_shape_layer',
    title: 'Add a shape layer',
    description:
      'Adds a vector shape layer and makes it active: a live shape (rect, ellipse, polygon, star, line), a free path (SVG path data or anchors), or several components combined with path operations. fill defaults to the foreground colour (none for an open path with a stroke); give stroke for an outline. It renders sharp at any size, can be moved and transformed without losing quality, and takes masks, effects, clipping and blend modes like any layer. Goes above the active layer unless placed. One undo step. Returns the layer and the shape.',
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: {
        ...GEOMETRY,
        components: {
          type: 'array',
          minItems: 1,
          description: 'Several components instead of shape / subpaths, bottom first, each with its path operation.',
          items: { type: 'object', description: 'One component.', properties: { ...GEOMETRY, op: OP }, additionalProperties: false },
        },
        fill: { anyOf: [{ $ref: '#/$defs/paint' }, { type: 'null', description: 'No fill.' }], description: 'Fill paint, or null for none (default the foreground colour).' },
        stroke: { anyOf: [{ $ref: '#/$defs/stroke' }, { type: 'null', description: 'No stroke.' }], description: 'Stroke { width, paint, … }, or null / omitted for none.' },
        fillRule: { type: 'string', enum: ['nonzero', 'evenodd'], description: 'Winding rule within a component (default nonzero).' },
        name: { type: 'string', description: 'Layer name (default by kind: Rectangle, Ellipse, …).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0..1 (default 1).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal).' },
        aboveId: { type: 'string', description: 'Put the layer directly above this layer (default above the active layer).' },
        belowId: { type: 'string', description: 'Put the layer directly below this layer.' },
        parentId: { type: 'string', description: 'Put the layer inside this group.' },
        index: { type: 'integer', minimum: 0, description: 'Position among the siblings, 0 = bottom.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Add a shape layer', ...WRITE },
    handler: (args) => {
      const init: ShapeLayerInit = { ...geometry(args) };
      if (args.components !== undefined) init.components = (args.components as Array<Record<string, unknown>>).map(geometry);
      for (const k of ['fill', 'stroke', 'fillRule', 'name', 'opacity', 'blend', 'aboveId', 'belowId', 'parentId', 'index'] as const) {
        if (args[k] !== undefined) (init as Record<string, unknown>)[k] = args[k];
      }
      if (init.blend !== undefined) init.blend = init.blend as BlendMode;
      const id = controller.addShapeLayer(init);
      return { layer: layerSummary(id), shape: controller.getShapeLayer(id) };
    },
  };

  const update: AgentTool = {
    name: 'update_shape',
    title: 'Restyle a shape',
    description:
      'Changes a shape layer’s fill, stroke or fill rule and renders it again: fill replaces the fill (null removes it); stroke changes only the settings given (null removes the stroke; a new stroke needs width and paint). Geometry is untouched (set_shape_component edits paths). One undo step. Returns the shape.',
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: {
        layerId: LAYER_ID,
        fill: { anyOf: [{ $ref: '#/$defs/paint' }, { type: 'null', description: 'No fill.' }], description: 'New fill paint, or null for none.' },
        stroke: { anyOf: [{ $ref: '#/$defs/stroke' }, { type: 'null', description: 'No stroke.' }], description: 'Stroke settings to change, or null to remove the stroke.' },
        fillRule: { type: 'string', enum: ['nonzero', 'evenodd'], description: 'Winding rule within a component.' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Restyle a shape', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, fill, stroke, fillRule }) => {
      const id = shapeId(layerId);
      if (fill === undefined && stroke === undefined && fillRule === undefined) throw new LayerOperationError('Give fill, stroke or fillRule to change.');
      return controller.setShapeStyle(id, { fill: fill as never, stroke: stroke as never, fillRule: fillRule as never });
    },
  };

  const setComponent: AgentTool = {
    name: 'set_shape_component',
    title: 'Edit a shape component',
    description:
      'Changes one component of a shape layer: shape sets its live shape (fields you leave out keep their values when the kind stays the same, e.g. only radii), subpaths replaces its path (which ends the live shape), op changes its path operation. Positions are document pixels. One undo step. Returns the shape.',
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: {
        layerId: LAYER_ID,
        componentIndex: COMPONENT_INDEX,
        shape: {
          type: 'object',
          description: 'Live shape fields to set (see add_shape_layer’s shape): kind plus its fields; without kind, the fields change the current live shape.',
          properties: {
            kind: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'star', 'line'], description: 'Shape kind (default the current one).' },
            x: NUM('Left of the box, pixels.'),
            y: NUM('Top of the box, pixels.'),
            width: NUM('Box width, pixels.'),
            height: NUM('Box height, pixels.'),
            radius: { type: 'number', minimum: 0, description: 'rect: one corner radius, pixels.' },
            radii: { type: 'array', items: { type: 'number', minimum: 0, description: 'Radius in pixels.' }, minItems: 4, maxItems: 4, description: 'rect: [top-left, top-right, bottom-right, bottom-left] radii, pixels.' },
            sides: { type: 'integer', minimum: 3, maximum: 100, description: 'polygon: number of sides.' },
            points: { type: 'integer', minimum: 3, maximum: 100, description: 'star: number of points.' },
            innerRatio: { type: 'number', minimum: 0.01, maximum: 1, description: 'star: inner over outer radius.' },
            x1: NUM('line: start x.'),
            y1: NUM('line: start y.'),
            x2: NUM('line: end x.'),
            y2: NUM('line: end y.'),
            weight: { type: 'number', minimum: 0, description: 'line: thickness in pixels.' },
            startArrow: { anyOf: [{ $ref: '#/$defs/arrowhead' }, { type: 'null', description: 'No arrowhead.' }], description: 'line: start arrowhead or null.' },
            endArrow: { anyOf: [{ $ref: '#/$defs/arrowhead' }, { type: 'null', description: 'No arrowhead.' }], description: 'line: end arrowhead or null.' },
            transform: { $ref: '#/$defs/matrix' },
          },
          additionalProperties: false,
        },
        subpaths: { $ref: '#/$defs/subpaths', description: 'A new path for the component (SVG path data or anchors); ends its live shape.' },
        op: OP,
      },
      required: ['layerId', 'componentIndex'],
      additionalProperties: false,
    },
    annotations: { title: 'Edit a shape component', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, componentIndex, ...rest }) => {
      const id = shapeId(layerId);
      const change = geometry(rest);
      if (change.shape === undefined && change.subpaths === undefined && change.op === undefined) throw new LayerOperationError('Give shape, subpaths or op to change.');
      return controller.setShapeComponent(id, componentIndex as number, change);
    },
  };

  const addComponent: AgentTool = {
    name: 'add_shape_component',
    title: 'Add a shape component',
    description:
      'Adds a component to a shape layer and combines it with the components below it by op: combine (union), subtract, intersect or exclude, as Photoshop’s path operations. Goes on top unless index is given. One undo step. Returns the shape.',
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: { layerId: LAYER_ID, ...GEOMETRY, op: OP, index: { type: 'integer', minimum: 0, description: 'Position among the components, 0 = bottom (default the top).' } },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a shape component', ...WRITE },
    handler: ({ layerId, index, ...rest }) => controller.addShapeComponent(shapeId(layerId), geometry(rest), index as number | undefined),
  };

  const removeComponent: AgentTool = {
    name: 'remove_shape_component',
    title: 'Delete a shape component',
    description: 'Deletes one component of a shape layer (the last one cannot go: delete the layer instead). One undo step. Returns the shape.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, componentIndex: COMPONENT_INDEX }, required: ['layerId', 'componentIndex'], additionalProperties: false },
    annotations: { title: 'Delete a shape component', ...DESTRUCTIVE },
    handler: ({ layerId, componentIndex }) => controller.removeShapeComponent(shapeId(layerId), componentIndex as number),
  };

  const merge: AgentTool = {
    name: 'merge_shape_components',
    title: 'Merge shape components',
    description:
      'Merge Shape Components: the area a shape’s components combine to (after their path operations) becomes one plain component; live shapes become paths. The look is unchanged. One undo step. Returns the shape.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Merge shape components', ...DESTRUCTIVE },
    handler: ({ layerId }) => controller.mergeShapeComponents(shapeId(layerId)),
  };

  // --- Vector masks ---

  const layerArg = (v: unknown) => {
    const id = String(v ?? '');
    if (!controller.getLayer(id)) throw new Error(`No layer "${id}". Call list_layers for ids.`);
    return id;
  };
  const pathSpec = (args: Record<string, unknown>): VectorMaskPathInput => {
    const spec: VectorMaskPathInput = { ...geometry(args) };
    if (args.components !== undefined) spec.components = (args.components as Array<Record<string, unknown>>).map(geometry);
    if (args.fillRule !== undefined) spec.fillRule = args.fillRule as VectorMaskPathInput['fillRule'];
    return spec;
  };
  const PATH_PROPS = {
    ...GEOMETRY,
    components: {
      type: 'array',
      minItems: 1,
      description: 'Several components instead of shape / subpaths, bottom first, each with its path operation (combine, subtract, intersect, exclude).',
      items: { type: 'object', description: 'One component.', properties: { ...GEOMETRY, op: OP }, additionalProperties: false },
    },
    fillRule: { type: 'string', enum: ['nonzero', 'evenodd'], description: 'Winding rule within a component (default nonzero).' },
  } as const;
  const LAYER = { type: 'string', minLength: 1, description: 'The layer (see list_layers). Not a shape layer: its path already is its vector mask.' } as const;
  const TRACE_PROPS = {
    tolerance: { type: 'number', minimum: 0.1, maximum: 10, description: 'How far (px) the path may stray from the selection edge (default 0.5; lower is tighter, more anchors).' },
    cornerRoundness: { type: 'number', minimum: 0, maximum: 1, description: '0: straight sides and sharp corners; 1: as smooth as the outline allows (default 0.5).' },
    minArea: { type: 'number', minimum: 0, description: 'Islands and holes smaller than this many square px are left out (default 4).' },
  } as const;
  const TRACE_KEYS = ['tolerance', 'cornerRoundness', 'minArea'] as const;
  const traceOptions = (args: Record<string, unknown>): SelectionToPathOptions => {
    const o: SelectionToPathOptions = {};
    for (const k of TRACE_KEYS) if (typeof args[k] === 'number') o[k] = args[k] as number;
    return o;
  };

  const selectionToPath: AgentTool = {
    name: 'selection_to_path',
    title: 'Make a path from the selection',
    description:
      "Make Work Path: traces the selection's outline (where it is at least half selected) into closed Bézier subpaths in document pixels, holes included, within tolerance px. Changes nothing. Returns svg (compact SVG path data) and fillRule evenodd, ready for add_vector_mask, set_vector_mask_path or add_shape_layer (pass the svg as subpaths and fillRule evenodd), plus bounds and the anchor count. Use add_vector_mask from selection to do it in one step.",
    inputSchema: { type: 'object', properties: { ...TRACE_PROPS, anchors: { type: 'boolean', description: 'Also return the subpaths as anchors with handles (default false: svg only).' } }, additionalProperties: false },
    annotations: { title: 'Make a path from the selection', ...READ },
    handler: (args) => {
      const out = controller.selectionToPath(traceOptions(args));
      const { subpaths, ...rest } = out;
      return args.anchors === true ? out : rest;
    },
  };

  const pathToSelection: AgentTool = {
    name: 'path_to_selection',
    title: 'Make a selection from a path',
    description:
      "Make Selection: fills a path (a live shape, free subpaths or SVG path data, or components, in document pixels, as add_shape_layer takes) into a selection, combined with the current one by mode, with feather px and antiAlias. Use it to select along Bézier curves, or to turn a path from selection_to_path or get_vector_mask back into a selection. One undo step. Returns the selection.",
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: {
        ...PATH_PROPS,
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Feather radius in px (default 0).' },
        antiAlias: { type: 'boolean', description: 'Soft edges (default true); false makes every pixel fully in or out.' },
        mode: { type: 'string', enum: ['replace', 'add', 'subtract', 'intersect'], description: 'How it combines with the current selection (default replace).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Make a selection from a path', ...WRITE },
    handler: (args) => {
      const mode = args.mode as 'replace' | 'add' | 'subtract' | 'intersect' | undefined;
      controller.pathToSelection(pathSpec(args), { feather: args.feather as number | undefined, antiAlias: args.antiAlias as boolean | undefined, mode });
      const sel = controller.getSelection();
      return { empty: !sel, bounds: sel?.bounds ?? null, area: Math.round(sel ? selectionArea(sel) : 0) };
    },
  };

  const getVectorMask: AgentTool = {
    name: 'get_vector_mask',
    title: 'Read a vector mask',
    description:
      "Reads a layer's vector mask: enabled, linked, inverted, fill rule, density, feather, the bounds of its path and its components (op, live shape, subpaths in document pixels). Use it before set_vector_mask_path to edit the path. Returns null when the layer has none.",
    inputSchema: { type: 'object', properties: { layerId: LAYER }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Read a vector mask', ...READ },
    handler: ({ layerId }) => ({ vectorMask: controller.getVectorMask(layerArg(layerId)) }),
  };

  const addVectorMask: AgentTool = {
    name: 'add_vector_mask',
    title: 'Add a vector mask',
    description:
      "Layer › Vector Mask: a path that reveals the layer inside it and stays sharp at any size, on top of any raster mask (both apply). from path takes a live shape, free subpaths or components like add_shape_layer; from selection traces the current selection (within tolerance px); reveal-all and hide-all start with an empty path. Use it for hard-edged geometric or traced cutouts that must stay editable; use add_layer_mask for soft or painted ones. A linked vector mask moves and transforms with the layer. Replaces an existing vector mask. One undo step. Returns the vector mask.",
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: {
        layerId: LAYER,
        from: { type: 'string', enum: ['path', 'selection', 'reveal-all', 'hide-all'], description: 'path (default when a shape, subpaths or components are given), selection (trace the current selection), reveal-all or hide-all (an empty path).' },
        ...PATH_PROPS,
        ...TRACE_PROPS,
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a vector mask', ...WRITE },
    handler: (args) => {
      const id = layerArg(args.layerId);
      const spec = pathSpec(args);
      const hasPath = spec.components?.length || spec.shape !== undefined || spec.subpaths !== undefined;
      const from = (args.from as 'path' | 'selection' | 'reveal-all' | 'hide-all' | undefined) ?? (hasPath ? 'path' : 'reveal-all');
      if (from !== 'selection' && TRACE_KEYS.some((k) => args[k] !== undefined)) throw new Error('tolerance, cornerRoundness and minArea apply only to from selection.');
      controller.addVectorMask(id, from, spec, traceOptions(args));
      return { vectorMask: controller.getVectorMask(id) };
    },
  };

  const setVectorMaskPath: AgentTool = {
    name: 'set_vector_mask_path',
    title: 'Replace a vector mask path',
    description:
      "Replaces the path of a layer's vector mask (shape, subpaths or components, document pixels); enabled, linked, inverted, density and feather are kept. Read the current path with get_vector_mask first to change part of it. One undo step. Returns the vector mask.",
    inputSchema: { type: 'object', $defs: DEFS, properties: { layerId: LAYER, ...PATH_PROPS }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Replace a vector mask path', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const id = layerArg(args.layerId);
      controller.setVectorMaskPath(id, pathSpec(args));
      return { vectorMask: controller.getVectorMask(id) };
    },
  };

  const setVectorMaskProps: AgentTool = {
    name: 'set_vector_mask_properties',
    title: 'Set vector mask properties',
    description:
      "Changes a layer's vector mask without touching its path: enabled (false ignores it), linked (false: it stays put when the layer moves or transforms), inverted (reveal outside the path), density 0..1 and feather in px (soften the edge without losing the path). One undo step. Returns the vector mask.",
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER,
        enabled: { type: 'boolean', description: 'false ignores the vector mask but keeps it.' },
        linked: { type: 'boolean', description: 'false keeps the path in place when the layer moves or transforms.' },
        inverted: { type: 'boolean', description: 'true reveals outside the path instead.' },
        density: { type: 'number', minimum: 0, maximum: 1, description: 'Density 0..1 (default 1): at 0.5 the hidden area still shows half.' },
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Feather σ in px (default 0).' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Set vector mask properties', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, ...props }) => {
      const id = layerArg(layerId);
      controller.setVectorMaskProps(id, props as Parameters<typeof controller.setVectorMaskProps>[1]);
      return { vectorMask: controller.getVectorMask(id) };
    },
  };

  const rasterizeVectorMask: AgentTool = {
    name: 'rasterize_vector_mask',
    title: 'Rasterize a vector mask',
    description:
      "Layer › Rasterize › Vector Mask: multiplies the path (with its density and feather) into the layer's raster mask, adding one if needed, and removes the vector mask, so the mask can be painted. The path can no longer be edited (undo_image brings it back). One undo step. Returns the layer's raster mask summary.",
    inputSchema: { type: 'object', properties: { layerId: LAYER }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Rasterize a vector mask', ...DESTRUCTIVE },
    handler: ({ layerId }) => {
      const id = layerArg(layerId);
      const mask = controller.rasterizeVectorMask(id);
      return { layerId: id, mask: { defaultValue: mask.defaultValue, density: mask.density ?? 1, feather: mask.feather ?? 0, enabled: mask.enabled !== false } };
    },
  };

  const removeVectorMask: AgentTool = {
    name: 'remove_vector_mask',
    title: 'Delete a vector mask',
    description: "Deletes a layer's vector mask without applying it (the raster mask, if any, stays). Disable it instead with set_vector_mask_properties enabled false to keep it. One undo step. Returns the layer id.",
    inputSchema: { type: 'object', properties: { layerId: LAYER }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Delete a vector mask', ...DESTRUCTIVE },
    handler: ({ layerId }) => {
      const id = layerArg(layerId);
      controller.removeVectorMask(id);
      return { layerId: id, vectorMask: null };
    },
  };

  return [get, add, update, setComponent, addComponent, removeComponent, merge, getVectorMask, addVectorMask, setVectorMaskPath, setVectorMaskProps, rasterizeVectorMask, removeVectorMask, selectionToPath, pathToSelection];
}
