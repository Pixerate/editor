/**
 * Agent tools for provider effects in the image editor: the shared effect tools
 * (`search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`,
 * `remove_effect`) on layers, where filter effects become smart filters, plus `add_effect_layer`
 * for generator, overlay and title effects and `set_effect_layer` to change one (its effect, still
 * frame or animation). (Drop shadows, strokes and the other layer styles are
 * `set_layer_effect`, a different thing.)
 */

import { createEffectToolProvider, type AppliedEffectInfo, type EffectChangeResult, type EffectTargetEffects } from '../effects/tools.js';
import type { EffectValue } from '../effects/types.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { BLEND_MODES } from './blend';
import { withImagePlayback } from './playback';
import type { ImageEditorController } from './controller';
import { findLayer, flattenLayers, MAX_EFFECT_ANIMATION_MS, type ImageLayer } from './layers/model';

export interface ImageEffectsToolProviderOptions {
  /** Provider id (unique per registry). Default `image-effects`. */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
  /** The document cannot be edited: write tools are hidden. A string is the reason. */
  readOnly?: boolean | string | (() => boolean | string);
  /**
   * The agent playback surface its calls are acted out on (default `image`, where `ImageEditor` attaches).
   * Set it when one registry holds several editors of this kind, each attached under its own surface id.
   */
  playbackSurface?: string;
}

const ANIMATE_SCHEMA = {
  type: 'object',
  properties: { duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_EFFECT_ANIMATION_MS, description: `How long it plays in ms (at most ${MAX_EFFECT_ANIMATION_MS}).` } },
  required: ['duration'],
  additionalProperties: false,
  description: 'Play when the document is output as an animation, for duration ms from time (the longest animating layer sets the animation\'s length).'
} as const;

/** A layer's provider effects as the tools report them: an effect layer's own effect, then its effect smart filters. */
export function imageLayerAppliedEffects(layer: ImageLayer): AppliedEffectInfo[] {
  const out: AppliedEffectInfo[] = [];
  const ref = (r: { effect: string; name?: string; provider?: string }) => ({ effect: r.effect, ...(r.name ? { name: r.name } : {}), ...(r.provider ? { provider: r.provider } : {}) });
  if (layer.type === 'pixel' && layer.generator) out.push({ id: 'generator', ...ref(layer.generator), role: 'effect layer', enabled: true, values: layer.generator.values, ...(layer.generator.time ? { time: layer.generator.time } : {}), ...(layer.generator.animate ? { animate: layer.generator.animate } : {}) } as AppliedEffectInfo);
  if (layer.type === 'smart')
    (layer.smartFilters?.filters ?? []).forEach((f, index) => {
      if (f.kind === 'effect') out.push({ id: f.id, ...ref(f), role: 'smart filter', enabled: f.enabled && layer.smartFilters!.enabled, opacity: f.opacity, blend: f.blend, values: f.values, index } as AppliedEffectInfo);
    });
  return out;
}

/** The effect tools for an image editor (see the module comment). */
export function createImageEffectsToolProvider(controller: ImageEditorController, options: ImageEffectsToolProviderOptions = {}): AgentToolProvider {
  const readOnlyReason = (): string | null => {
    const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
    return ro ? (typeof ro === 'string' ? ro : 'The image is read-only.') : null;
  };
  const layerOf = (id: string): ImageLayer => {
    const found = findLayer(controller.getState().layers, id);
    if (!found) {
      const ids = flattenLayers(controller.getState().layers).map((l) => `"${l.id}"`);
      throw new Error(`There is no layer "${id}"; the layers are ${ids.join(', ') || 'none'} (list_layers lists them).`);
    }
    return found.layer;
  };
  const result = (target: string, instance: string, extra: Record<string, unknown> = {}): EffectChangeResult => {
    const effects = imageLayerAppliedEffects(layerOf(target));
    return { target, effect: effects.find((e) => e.id === instance) ?? effects[effects.length - 1], effects, ...extra };
  };
  const plainValues = (v: Record<string, unknown> | undefined) => v as Record<string, EffectValue> | undefined;

  return withImagePlayback(createEffectToolProvider({
    id: options.id ?? 'image-effects',
    namespace: options.namespace,
    title: 'Image effects',
    description: 'Provider effects (GPU filters and generators) on image layers as smart filters: search, describe, apply, update and remove them.',
    skill: 'pixerate-image-editor',
    target: { noun: 'layer', id: 'A layer id from list_layers.' },
    applyUses: ['filter'],
    applyDetails:
      'The effect becomes a smart filter: it runs on the layer\'s pixels after the smart filters below it, with its own blend and opacity, under the smart filter mask, and can be changed or removed later. A pixel, shape or type layer (or a group) is converted to a smart object first, in the same undo step (one layer keeps its id; the result says converted). Generators and overlays go on their own layer through add_effect_layer.',
    provider: () => controller.effectsProvider,
    readOnlyReason,
    list: (target) => {
      const layers = target ? [layerOf(target)] : flattenLayers(controller.getState().layers);
      return layers
        .map((l): EffectTargetEffects => ({ target: l.id, ...(l.name ? { name: l.name } : {}), effects: imageLayerAppliedEffects(l) }))
        .filter((t) => target || t.effects.length);
    },
    apply: async (target, effect, args) => {
      const r = await controller.applyEffectFilter(target, effect, { values: plainValues(args.values), index: args.index, enabled: args.enabled, opacity: args.opacity });
      return result(r.layerId, r.filter.id, { converted: r.converted });
    },
    update: async (target, instance, changes) => {
      const layer = layerOf(target);
      if (instance === 'generator') {
        const extra = (['enabled', 'opacity', 'index'] as const).filter((k) => changes[k] !== undefined);
        if (extra.length) throw new Error(`An effect layer's own effect only takes values; change the layer's ${extra.join(', ')} with update_layer.`);
        if (layer.type !== 'pixel' || !layer.generator) throw new Error(`"${target}" is not an effect layer.`);
        await controller.updateEffectLayer(target, { values: changes.values as Record<string, EffectValue | null> | undefined });
        return result(target, 'generator');
      }
      await controller.updateEffectFilter(target, instance, { values: changes.values as Record<string, EffectValue | null> | undefined, enabled: changes.enabled, opacity: changes.opacity, index: changes.index });
      return result(target, instance);
    },
    remove: async (target, instance) => {
      const layer = layerOf(target);
      const was = imageLayerAppliedEffects(layer).find((e) => e.id === instance);
      if (!was) throw new Error(`Layer "${layer.name || target}" has no provider effect "${instance}"; its effects are ${imageLayerAppliedEffects(layer).map((e) => `"${e.id}"`).join(', ') || 'none'} (list_applied_effects).`);
      if (instance === 'generator') controller.rasterizeEffectLayer(target);
      else controller.removeSmartFilter(target, instance);
      return { target, effect: was, effects: imageLayerAppliedEffects(layerOf(target)) };
    },
    subscribe: (notify) => controller.subscribe(() => notify()),
    extraTools: (ctx): AgentTool[] => [
      {
        name: 'add_effect_layer',
        title: 'Add an effect layer',
        description:
          'Adds a layer drawn by a provider generator, overlay or title effect (search_effects with use generator, overlay or title) at the document\'s size and bit depth, above the active layer unless placed. Masks, blend mode, opacity and layer styles apply as to any layer; transparent effects show the layers beneath, and an effect with its own background (describe_effect backgroundOpacity) starts with it transparent when there are layers below, unless values set it. animate makes it play when the document is output as an animation. set_effect_layer changes its effect, frame or animation; update_effect with effect "generator" draws it again with new values; remove_effect "generator" keeps its pixels as a plain layer. One undo step. Returns the new layer id and its effect.',
        inputSchema: {
          type: 'object',
          properties: {
            effect: ctx.effectIdSchema(['generator', 'overlay', 'title']),
            values: ctx.valuesSchema('Control values over the effect\'s defaults'),
            time: { type: 'number', minimum: 0, description: 'Which moment of an animated effect to draw, in ms (default 0); where its animation starts.' },
            animate: ANIMATE_SCHEMA,
            name: { type: 'string', minLength: 1, description: 'The layer name (default: the effect\'s name).' },
            aboveId: { type: 'string', minLength: 1, description: 'Put it directly above this layer (default: above the active layer, else on top).' },
            belowId: { type: 'string', minLength: 1, description: 'Put it directly below this layer.' },
            opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0–1 (default 1).' },
            blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id).filter((b) => b !== 'pigment'), description: 'Layer blend mode (default normal); screen or add for light effects, multiply for textures.' }
          },
          required: ['effect'],
          additionalProperties: false
        },
        annotations: { title: 'Add an effect layer', ...ctx.annotations.write },
        handler: async (args) => {
          ctx.requireProvider();
          const id = await controller.addEffectLayer(args.effect, { values: plainValues(args.values), time: args.time, animate: args.animate, name: args.name, aboveId: args.aboveId, belowId: args.belowId, opacity: args.opacity, blend: args.blend });
          return { layerId: id, effects: imageLayerAppliedEffects(layerOf(id)) };
        }
      },
      {
        name: 'set_effect_layer',
        title: 'Change an effect layer',
        description:
          'Changes an effect layer (list_applied_effects shows its effect as "generator"): effect swaps in another generator, overlay or title effect (its defaults plus values, the background transparent when there are layers below); time picks the still frame of an animated effect; animate { duration } makes it play when the document is output as an animation, null makes it a still frame again. Redraws its pixels (painting on it is lost). One undo step. Returns its effects.',
        inputSchema: {
          type: 'object',
          properties: {
            layerId: { type: 'string', minLength: 1, description: 'The effect layer\'s id (list_layers).' },
            effect: ctx.effectIdSchema(['generator', 'overlay', 'title']),
            values: ctx.valuesSchema('Control values: over the new effect\'s defaults when effect is given, else over the layer\'s own (null resets one)'),
            time: { type: 'number', minimum: 0, description: 'The moment drawn as the still frame, in ms; where the animation starts.' },
            animate: { anyOf: [ANIMATE_SCHEMA, { type: 'null' }], description: 'Play for this long in an animation, or null for a still frame.' }
          },
          required: ['layerId'],
          additionalProperties: false
        },
        annotations: { title: 'Change an effect layer', ...ctx.annotations.write },
        handler: async (args) => {
          if (args.effect !== undefined) ctx.requireProvider();
          const layer = layerOf(args.layerId);
          if (layer.type !== 'pixel' || !layer.generator) throw new Error(`"${args.layerId}" is not an effect layer; its effects are in list_applied_effects, and add_effect_layer adds one.`);
          await controller.updateEffectLayer(args.layerId, { effect: args.effect, values: args.values as Record<string, EffectValue | null> | undefined, time: args.time, animate: args.animate });
          return { layerId: args.layerId, effects: imageLayerAppliedEffects(layerOf(args.layerId)) };
        }
      }
    ]
  }), options.playbackSurface);
}
