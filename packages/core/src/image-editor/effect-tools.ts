import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { BLEND_MODES } from './blend';
import { LayerOperationError, requireLayer } from './layers/ops';
import {
  effectsMargin,
  isLayerEffectKind,
  layerEffectLabel,
  LAYER_EFFECT_KINDS,
  type LayerEffectKind,
  type LayerEffects,
} from '../raster/effects/model';
import { builtinPattern, builtinPatternIds } from '../raster/effects/patterns';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const LAYER_ID = { type: 'string', description: 'Layer id from list_layers (a pixel, shape, smart object, annotation or group layer).' } as const;
const EFFECT_ID = { type: 'string', description: 'Effect id from list_layer_effects or add_layer_effect.' } as const;
const BLEND_IDS = BLEND_MODES.map((m) => m.id).filter((id) => id !== 'pigment');

/** Shared shapes, referenced as `#/$defs/...`. */
const DEFS = {
  color: { type: 'string', pattern: '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$', description: 'Colour as #rrggbb.' },
  contour: {
    type: 'object',
    description: 'A transfer curve over the effect coverage: points { input, output } from 0 to 1 (at least 2), sorted by input. Linear is [{0,0},{1,1}].',
    properties: {
      name: { type: 'string', description: 'Display name (e.g. "Cone", "Gaussian").' },
      points: {
        type: 'array',
        minItems: 2,
        description: 'Curve points.',
        items: {
          type: 'object',
          properties: {
            input: { type: 'number', minimum: 0, maximum: 1, description: 'Coverage in (0..1).' },
            output: { type: 'number', minimum: 0, maximum: 1, description: 'Coverage out (0..1).' },
            corner: { type: 'boolean', description: 'Sharp corner instead of a smooth point (default false).' },
          },
          required: ['input', 'output'],
          additionalProperties: false,
        },
      },
    },
    required: ['name', 'points'],
    additionalProperties: false,
  },
  gradient: {
    type: 'object',
    description: 'A gradient: colour stops, optional opacity stops and its layout.',
    properties: {
      stops: {
        type: 'array',
        minItems: 1,
        description: 'Colour stops { position 0..1, color #rrggbb }.',
        items: {
          type: 'object',
          properties: { position: { type: 'number', minimum: 0, maximum: 1, description: '0..1 along the gradient.' }, color: { $ref: '#/$defs/color' } },
          required: ['position', 'color'],
          additionalProperties: false,
        },
      },
      opacityStops: {
        type: 'array',
        description: 'Opacity stops { position 0..1, opacity 0..1 } (default opaque).',
        items: {
          type: 'object',
          properties: {
            position: { type: 'number', minimum: 0, maximum: 1, description: '0..1 along the gradient.' },
            opacity: { type: 'number', minimum: 0, maximum: 1, description: '0..1.' },
          },
          required: ['position', 'opacity'],
          additionalProperties: false,
        },
      },
      style: { type: 'string', enum: ['linear', 'radial', 'angle', 'reflected', 'diamond'], description: 'Geometry.' },
      angle: { type: 'number', minimum: -360, maximum: 360, description: 'Degrees, 90 = bottom to top.' },
      scale: { type: 'number', minimum: 0.1, maximum: 1.5, description: '1 = 100 %.' },
      reverse: { type: 'boolean', description: 'Swap the ends.' },
      align: { type: 'boolean', description: 'Lay out over the layer bounds (true) or the canvas.' },
      offset: {
        type: 'object',
        description: 'Centre offset as fractions of the bounds.',
        properties: { x: { type: 'number', minimum: -1, maximum: 1, description: 'Fraction of the width.' }, y: { type: 'number', minimum: -1, maximum: 1, description: 'Fraction of the height.' } },
        required: ['x', 'y'],
        additionalProperties: false,
      },
    },
    required: ['stops', 'style', 'angle', 'scale', 'reverse', 'align', 'offset'],
    additionalProperties: false,
  },
  phase: {
    type: 'object',
    description: 'Pattern origin offset in px.',
    properties: { x: { type: 'number', description: 'px.' }, y: { type: 'number', description: 'px.' } },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  fill: {
    description: 'What a stroke or glow paints with. Glows take color or gradient only.',
    anyOf: [
      {
        type: 'object',
        properties: { type: { const: 'color', description: 'Solid colour.' }, color: { $ref: '#/$defs/color' } },
        required: ['type', 'color'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { type: { const: 'gradient', description: 'Gradient.' }, gradient: { $ref: '#/$defs/gradient' } },
        required: ['type', 'gradient'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          type: { const: 'pattern', description: 'Pattern (strokes only).' },
          patternId: { type: 'string', description: 'Pattern id from list_layer_effects.patterns.' },
          name: { type: 'string', description: 'Display name.' },
          scale: { type: 'number', minimum: 0.01, maximum: 10, description: '1 = 100 %.' },
          angle: { type: 'number', minimum: -360, maximum: 360, description: 'Rotation in degrees (default 0).' },
          link: { type: 'boolean', description: 'Tile from the layer (default true) or the canvas origin.' },
          phase: { $ref: '#/$defs/phase' },
        },
        required: ['type', 'patternId', 'scale'],
        additionalProperties: false,
      },
    ],
  },
} as const;

const nullable = (schema: Record<string, unknown>, description: string) => ({ anyOf: [schema, { type: 'null' }], description });

/** Every effect setting (each kind takes a subset; the description says which). */
function settingsSchema(forUpdate: boolean): Record<string, unknown> {
  const opt = (schema: Record<string, unknown>, description: string) => (forUpdate ? nullable(schema, `${description} null removes it.`) : { ...schema, description });
  return {
    type: 'object',
    description: forUpdate
      ? 'Settings to change (only these; nested objects are replaced whole). Which settings a kind takes: see add_layer_effect.'
      : "Settings to change from Photoshop's defaults (all optional). Unknown settings for the kind are refused with the list of its settings.",
    properties: {
      enabled: { type: 'boolean', description: 'All kinds: false keeps the effect but hides it (default true).' },
      blend: { type: 'string', enum: BLEND_IDS, description: 'All but bevel-emboss: blend mode (shadows multiply, glows screen, others normal).' },
      opacity: { type: 'number', minimum: 0, maximum: 1, description: 'All but bevel-emboss: 0..1 (shadows / glows 0.75, satin 0.5, others 1).' },
      color: { $ref: '#/$defs/color', description: 'drop-shadow, inner-shadow, satin, color-overlay: #rrggbb.' },
      angle: { type: 'number', minimum: -360, maximum: 360, description: 'Shadows, satin, bevel-emboss: light direction in degrees, counter-clockwise from 3 o\'clock (default 120; satin 19).' },
      useGlobalLight: { type: 'boolean', description: 'Shadows, bevel-emboss: follow the document global light instead of angle (default true).' },
      distance: { type: 'number', minimum: 0, maximum: 30000, description: 'Shadows, satin: offset in px (default 5; satin 11).' },
      spread: { type: 'number', minimum: 0, maximum: 1, description: 'drop-shadow, outer-glow: 0..1 of the size made solid (default 0).' },
      choke: { type: 'number', minimum: 0, maximum: 1, description: 'inner-shadow, inner-glow: 0..1 of the size made solid (default 0).' },
      size: { type: 'number', minimum: 0, maximum: 250, description: 'Shadows, glows, satin, bevel-emboss: blur / size in px (default 5; satin 14); stroke: width in px (default 3).' },
      contour: opt({ $ref: '#/$defs/contour' }, 'Shadows, glows, satin: coverage contour (default linear).'),
      antiAlias: { type: 'boolean', description: 'Shadows, glows, satin: smooth the contour (default false; satin true).' },
      noise: { type: 'number', minimum: 0, maximum: 1, description: 'Shadows, glows: speckle 0..1 (default 0).' },
      knocksOut: { type: 'boolean', description: 'drop-shadow: the layer hides the shadow beneath its see-through fill (default true).' },
      fill: { $ref: '#/$defs/fill', description: 'outer-glow, inner-glow (color or gradient), stroke (color, gradient or pattern).' },
      technique: { type: 'string', enum: ['softer', 'precise', 'smooth', 'chisel-hard', 'chisel-soft'], description: 'Glows: softer | precise (default softer); bevel-emboss: smooth | chisel-hard | chisel-soft (default smooth).' },
      range: { type: 'number', minimum: 0.01, maximum: 1, description: 'Glows: the part of the glow the contour spans (default 0.5).' },
      jitter: { type: 'number', minimum: 0, maximum: 1, description: 'Glows: gradient jitter 0..1 (stored, not rendered; default 0).' },
      source: { type: 'string', enum: ['edge', 'center'], description: 'inner-glow: glow from the edge (default) or the centre.' },
      style: { type: 'string', enum: ['inner-bevel', 'outer-bevel', 'emboss', 'pillow-emboss', 'stroke-emboss'], description: 'bevel-emboss: style (default inner-bevel).' },
      depth: { type: 'number', minimum: 0, maximum: 10, description: 'bevel-emboss: depth, 1 = 100 % (default 1).' },
      direction: { type: 'string', enum: ['up', 'down'], description: 'bevel-emboss: raised (up, default) or sunk (down).' },
      soften: { type: 'number', minimum: 0, maximum: 16, description: 'bevel-emboss: blur of the height in px (default 0).' },
      altitude: { type: 'number', minimum: 0, maximum: 90, description: 'bevel-emboss: light altitude in degrees (default 30).' },
      glossContour: opt({ $ref: '#/$defs/contour' }, 'bevel-emboss: gloss contour over the shading (default linear).'),
      highlightColor: { $ref: '#/$defs/color', description: 'bevel-emboss: highlight colour (default #ffffff).' },
      highlightBlend: { type: 'string', enum: BLEND_IDS, description: 'bevel-emboss: highlight mode (default screen).' },
      highlightOpacity: { type: 'number', minimum: 0, maximum: 1, description: 'bevel-emboss: highlight opacity (default 0.75).' },
      shadowColor: { $ref: '#/$defs/color', description: 'bevel-emboss: shadow colour (default #000000).' },
      shadowBlend: { type: 'string', enum: BLEND_IDS, description: 'bevel-emboss: shadow mode (default multiply).' },
      shadowOpacity: { type: 'number', minimum: 0, maximum: 1, description: 'bevel-emboss: shadow opacity (default 0.75).' },
      contourElement: opt(
        {
          type: 'object',
          properties: {
            contour: { $ref: '#/$defs/contour' },
            range: { type: 'number', minimum: 0, maximum: 1, description: 'Stored range (default 0.5).' },
            antiAlias: { type: 'boolean', description: 'Smooth the contour.' },
          },
          required: ['contour', 'range', 'antiAlias'],
          additionalProperties: false,
        },
        "bevel-emboss: the Contour element, shaping the bevel's height profile (default off)."
      ),
      texture: opt(
        {
          type: 'object',
          properties: {
            patternId: { type: 'string', description: 'Pattern id from list_layer_effects.patterns.' },
            name: { type: 'string', description: 'Display name.' },
            scale: { type: 'number', minimum: 0.01, maximum: 10, description: '1 = 100 %.' },
            depth: { type: 'number', minimum: -10, maximum: 10, description: '1 = +100 %; negative carves the pattern in.' },
            invert: { type: 'boolean', description: 'Invert the pattern.' },
            link: { type: 'boolean', description: 'Tile from the layer (default true).' },
            phase: { $ref: '#/$defs/phase' },
          },
          required: ['patternId', 'scale', 'depth', 'invert'],
          additionalProperties: false,
        },
        "bevel-emboss: the Texture element, a pattern's luminance as extra height (default off)."
      ),
      invert: { type: 'boolean', description: 'satin: invert (default true).' },
      gradient: { $ref: '#/$defs/gradient', description: 'gradient-overlay: the gradient (default black to white, 90°).' },
      dither: { type: 'boolean', description: 'gradient-overlay: dither (stored; default false).' },
      patternId: { type: 'string', description: 'pattern-overlay: pattern id from list_layer_effects.patterns (default checker).' },
      name: { type: 'string', description: 'pattern-overlay: pattern display name.' },
      scale: { type: 'number', minimum: 0.01, maximum: 10, description: 'pattern-overlay: 1 = 100 % (default 1).' },
      link: { type: 'boolean', description: 'pattern-overlay: tile from the layer (default true) or the canvas origin.' },
      phase: { $ref: '#/$defs/phase', description: 'pattern-overlay: origin offset in px (default 0, 0).' },
      position: { type: 'string', enum: ['outside', 'inside', 'center'], description: 'stroke: where the stroke sits on the edge (default outside).' },
    },
    additionalProperties: false,
  };
}

/** The patterns pattern effects can use: the document's (from a PSD), then the built-in ones. */
function patternList(controller: ImageEditorController): Array<{ id: string; name: string; width: number; height: number; builtin: boolean }> {
  const doc = controller.getDocumentPatterns().map((p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, builtin: false }));
  const builtins = builtinPatternIds().map((id) => {
    const p = builtinPattern(id)!;
    return { id, name: p.name, width: p.width, height: p.height, builtin: true };
  });
  return [...doc, ...builtins];
}

/** A layer's effects for agents: the master switch, scale, reach and every effect with its settings. */
export function describeLayerEffects(effects: LayerEffects): Record<string, unknown> {
  return {
    enabled: effects.enabled,
    scale: effects.scale ?? 1,
    margin: effectsMargin(effects),
    fromPsd: Boolean(effects.psd),
    effects: effects.items.map((e) => ({ ...JSON.parse(JSON.stringify(e)), label: layerEffectLabel(e.kind) })),
  };
}

/**
 * Agent tools for layer effects: `list_layer_effects`, `add_layer_effect`, `update_layer_effect`,
 * `remove_layer_effect`, `set_layer_effects_enabled` and `set_global_light`. Each write validates
 * every setting first, is one undo step and returns the layer's effects after the change.
 */
export function createImageEffectTools(controller: ImageEditorController): AgentTool[] {
  const layerArg = (id: unknown) => {
    if (typeof id !== 'string' || !id) throw new LayerOperationError('layerId is required (a layer id from list_layers).');
    requireLayer(controller.getLayers(), id);
    return id;
  };
  const result = (layerId: string, extra: Record<string, unknown> = {}) => ({ layerId, ...extra, ...describeLayerEffects(controller.getLayerEffects(layerId)) });

  const list: AgentTool = {
    name: 'list_layer_effects',
    title: 'List layer effects',
    description:
      "Returns a layer's effects: the master switch (enabled), Scale Effects (scale, 1 = 100 %), margin (px the effects reach beyond the shape), whether they came from a PSD, and every effect with its id, kind, label and all settings. Also returns the document global light and the pattern ids pattern effects can use.",
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'List layer effects', ...READ },
    handler: ({ layerId }) => result(layerArg(layerId), { globalLight: controller.getGlobalLight(), patterns: patternList(controller), kinds: [...LAYER_EFFECT_KINDS] }),
  };

  const add: AgentTool = {
    name: 'add_layer_effect',
    title: 'Add a layer effect',
    description:
      "Adds a live effect to a pixel, shape, type, smart object, annotation or group layer with Photoshop's defaults, changed by settings: drop-shadow, inner-shadow, outer-glow, inner-glow, bevel-emboss, satin, color-overlay, gradient-overlay, pattern-overlay or stroke. Several of one kind are allowed (the first listed is on top). One undo step. Returns the new effect's id and the layer's effects.",
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: {
        layerId: LAYER_ID,
        kind: { type: 'string', enum: [...LAYER_EFFECT_KINDS], description: 'Effect kind.' },
        settings: settingsSchema(false),
        index: { type: 'integer', minimum: 0, description: "Position in the layer's effect list (default the end)." },
      },
      required: ['layerId', 'kind'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a layer effect', ...WRITE },
    handler: ({ layerId, kind, settings, index }) => {
      const id = layerArg(layerId);
      if (!isLayerEffectKind(kind)) throw new LayerOperationError(`kind must be one of ${LAYER_EFFECT_KINDS.join(', ')}.`);
      const { effect } = controller.addLayerEffect(id, kind as LayerEffectKind, (settings as Record<string, unknown>) ?? {}, index as number | undefined);
      return result(id, { effectId: effect.id });
    },
  };

  const update: AgentTool = {
    name: 'update_layer_effect',
    title: 'Change a layer effect',
    description:
      "Changes settings of one effect (only the given ones; fill, gradient, contour and texture objects are replaced whole, null removes an optional contour or texture). The kind cannot change. Validates everything before changing anything. One undo step. Returns the layer's effects.",
    inputSchema: {
      type: 'object',
      $defs: DEFS,
      properties: { layerId: LAYER_ID, effectId: EFFECT_ID, settings: settingsSchema(true) },
      required: ['layerId', 'effectId', 'settings'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a layer effect', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, effectId, settings }) => {
      const id = layerArg(layerId);
      const changes = (settings as Record<string, unknown>) ?? {};
      if (!Object.keys(changes).length) throw new LayerOperationError('Give at least one setting to change.');
      controller.updateLayerEffect(id, effectId as string, changes);
      return result(id);
    },
  };

  const remove: AgentTool = {
    name: 'remove_layer_effect',
    title: 'Remove a layer effect',
    description: "Removes one effect from a layer (to hide it but keep its settings, set enabled false with update_layer_effect instead). One undo step. Returns the layer's remaining effects.",
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, effectId: EFFECT_ID }, required: ['layerId', 'effectId'], additionalProperties: false },
    annotations: { title: 'Remove a layer effect', ...DESTRUCTIVE },
    handler: ({ layerId, effectId }) => {
      const id = layerArg(layerId);
      controller.removeLayerEffect(id, effectId as string);
      return result(id);
    },
  };

  const setEnabled: AgentTool = {
    name: 'set_layer_effects_enabled',
    title: 'Switch layer effects on or off',
    description:
      "Turns all of a layer's effects on or off at once (the master switch; each effect keeps its own enabled flag) and optionally sets Scale Effects, which multiplies every size, distance and pattern scale. One undo step. Returns the layer's effects.",
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        enabled: { type: 'boolean', description: 'true renders the enabled effects; false hides them all.' },
        scale: { type: 'number', minimum: 0.01, maximum: 10, description: 'Scale Effects, 1 = 100 % (unchanged when left out).' },
      },
      required: ['layerId', 'enabled'],
      additionalProperties: false,
    },
    annotations: { title: 'Switch layer effects on or off', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, enabled, scale }) => {
      const id = layerArg(layerId);
      controller.setLayerEffectsEnabled(id, enabled as boolean, scale as number | undefined);
      return result(id);
    },
  };

  const light: AgentTool = {
    name: 'set_global_light',
    title: 'Set the global light',
    description:
      'Sets the document global light that shadows and bevels with useGlobalLight follow (Photoshop default: angle 120°, altitude 30°). One undo step. Returns the light.',
    inputSchema: {
      type: 'object',
      properties: {
        angle: { type: 'number', minimum: -360, maximum: 360, description: "Degrees, counter-clockwise from 3 o'clock: where the light comes from (unchanged when left out)." },
        altitude: { type: 'number', minimum: 0, maximum: 90, description: 'Degrees above the canvas, for bevels (unchanged when left out).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set the global light', ...WRITE_IDEMPOTENT },
    handler: ({ angle, altitude }) => {
      if (angle === undefined && altitude === undefined) throw new LayerOperationError('Give angle, altitude or both.');
      const next: { angle?: number; altitude?: number } = {};
      if (angle !== undefined) next.angle = angle as number;
      if (altitude !== undefined) next.altitude = altitude as number;
      return { globalLight: controller.setGlobalLight(next) };
    },
  };

  return [list, add, update, remove, setEnabled, light];
}
