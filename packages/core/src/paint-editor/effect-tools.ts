/**
 * Agent tools for provider effects in the paint editor: the shared effect tools, where
 * `apply_effect` runs a filter (light, glow, grade) on a layer's dried paint and bakes it in, and
 * the target `paper` is the effect paper; plus `set_paper_effect`, `add_effect_layer` and
 * `fill_layer_with_effect`.
 */

import { withPaintPlayback } from './playback';
import { createEffectToolProvider, type AppliedEffectInfo, type EffectChangeResult, type EffectTargetEffects } from '../effects/tools.js';
import type { EffectValue } from '../effects/types.js';
import { BLEND_MODES } from '../raster/blend';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PaintEditorController } from './controller';
import { PAPER_EFFECT_BLENDS, type PaintEffectSource, type PaperEffectBlend } from './effects';

export interface PaintEffectsToolProviderOptions {
  /** Provider id (unique per registry). Default `paint-effects`. */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
  /** The painting cannot be edited: write tools are hidden. A string is the reason. */
  readOnly?: boolean | string | (() => boolean | string);
  /**
   * The agent playback surface its calls are acted out on (default `paint`, where `PaintEditor` attaches).
   * Set it when one registry holds several editors of this kind, each attached under its own surface id.
   */
  playbackSurface?: string;
}

/** The target id of the effect paper. */
export const PAPER_TARGET = 'paper';

const ref = (s: PaintEffectSource) => ({ effect: s.effect, ...(s.name ? { name: s.name } : {}), ...(s.provider ? { provider: s.provider } : {}) });

/** The effect tools for a paint editor (see the module comment). */
export function createPaintEffectsToolProvider(controller: PaintEditorController, options: PaintEffectsToolProviderOptions = {}): AgentToolProvider {
  const readOnlyReason = (): string | null => {
    const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
    return ro ? (typeof ro === 'string' ? ro : 'The painting is read-only.') : null;
  };
  const paperInfo = (): AppliedEffectInfo[] => {
    const p = controller.getPaperEffect();
    return p ? [{ id: PAPER_TARGET, ...ref(p), role: 'effect paper', enabled: true, opacity: p.opacity, blend: p.blend, values: p.values, ...(p.time ? { time: p.time } : {}) } as AppliedEffectInfo] : [];
  };
  const layerInfo = (layerId: string): AppliedEffectInfo[] => {
    const s = controller.getEffectLayer(layerId);
    return s ? [{ id: 'effect', ...ref(s), role: 'effect layer', enabled: true, values: s.values, ...(s.time ? { time: s.time } : {}) } as AppliedEffectInfo] : [];
  };
  const requireLayer = (id: string) => {
    const l = controller.getLayer(id);
    if (!l) {
      const ids = controller.listLayers().map((x) => `"${x.id}"`);
      throw new Error(`There is no layer "${id}"; the targets are "${PAPER_TARGET}" and the layers ${ids.join(', ') || '(none)'} (list_layers lists them).`);
    }
    return l;
  };
  const effectsOf = (target: string) => (target === PAPER_TARGET ? paperInfo() : layerInfo(target));
  const instanceCheck = (target: string, instance: string) => {
    const want = target === PAPER_TARGET ? PAPER_TARGET : 'effect';
    if (target !== PAPER_TARGET) requireLayer(target);
    if (instance !== want || !effectsOf(target).length) {
      const have = effectsOf(target).map((e) => `"${e.id}"`);
      throw new Error(
        `${target === PAPER_TARGET ? 'The paper' : `Layer "${target}"`} has no provider effect "${instance}"; its effects are ${have.join(', ') || 'none'} (list_applied_effects). Light baked into paint is part of the pixels: undo takes it back.`
      );
    }
  };
  const noStackArgs = (changes: { index?: number; enabled?: boolean }) => {
    if (changes.index !== undefined) throw new Error('index does not apply: the paper and each effect layer have one effect.');
    if (changes.enabled !== undefined) throw new Error('enabled does not apply here: hide an effect layer with update_layer visible false, or remove the effect paper.');
  };
  const values = (v: Record<string, unknown> | undefined) => v as Record<string, EffectValue> | undefined;

  return withPaintPlayback(createEffectToolProvider({
    id: options.id ?? 'paint-effects',
    namespace: options.namespace,
    title: 'Paint effects',
    description: 'Provider effects on paint layers and on the effect paper.',
    skill: 'pixerate-paint-editor',
    target: { noun: 'layer', id: `A pixel layer id from list_layers ("${PAPER_TARGET}" is the effect paper, for list, update and remove).` },
    applyUses: ['filter'],
    applyDetails:
      "Light on dried paint: the filter (search_effects with use filter, e.g. a light, glow or grade) runs on the layer's paint at the canvas size and is baked into its pixels; transparent areas stay transparent, and thick paint keeps its relief (an effect with a height input gets it). opacity is the strength (default 1). Wet paint is refused: dry it first (dry_paint). It is one undo step and is not listed afterwards (it is part of the pixels). Generators go on the paper (set_paper_effect), on their own layer (add_effect_layer) or into a layer (fill_layer_with_effect).",
    provider: () => controller.effectsProvider,
    readOnlyReason,
    list: (target): EffectTargetEffects[] => {
      if (target === PAPER_TARGET) return [{ target: PAPER_TARGET, name: 'Paper', effects: paperInfo() }];
      if (target) {
        const l = requireLayer(target);
        return [{ target, name: l.name, effects: layerInfo(target) }];
      }
      const out: EffectTargetEffects[] = [];
      if (paperInfo().length) out.push({ target: PAPER_TARGET, name: 'Paper', effects: paperInfo() });
      for (const e of controller.listEffectLayers()) out.push({ target: e.layerId, name: e.name, effects: layerInfo(e.layerId) });
      return out;
    },
    apply: async (target, effect, args): Promise<EffectChangeResult> => {
      if (target === PAPER_TARGET) throw new Error('The paper takes generator effects through set_paper_effect; apply_effect runs a filter on a layer\'s paint.');
      noStackArgs(args);
      requireLayer(target);
      const r = await controller.applyLightEffect(target, effect, { values: values(args.values), amount: args.opacity });
      const applied: AppliedEffectInfo = { id: 'light', ...ref(r.source), role: 'baked light', enabled: true, opacity: r.amount, values: r.source.values };
      return { target, effect: applied, effects: layerInfo(target), baked: true };
    },
    update: async (target, instance, changes): Promise<EffectChangeResult> => {
      instanceCheck(target, instance);
      noStackArgs(changes);
      if (target === PAPER_TARGET) {
        await controller.updatePaperEffect({ values: changes.values as Record<string, EffectValue | null> | undefined, opacity: changes.opacity });
        const effects = paperInfo();
        return { target, effect: effects[0], effects };
      }
      if (changes.opacity !== undefined) throw new Error("An effect layer's opacity is the layer's: change it with update_layer.");
      await controller.updateEffectLayer(target, { values: changes.values as Record<string, EffectValue | null> | undefined });
      const effects = layerInfo(target);
      return { target, effect: effects[0], effects };
    },
    remove: async (target, instance): Promise<EffectChangeResult> => {
      instanceCheck(target, instance);
      const was = effectsOf(target)[0];
      if (target === PAPER_TARGET) await controller.setPaperEffect(null);
      else controller.rasterizeEffectLayer(target);
      return { target, effect: was, effects: [], ...(target === PAPER_TARGET ? {} : { keptPixels: true }) };
    },
    subscribe: (notify) => {
      const a = controller.subscribe(() => notify());
      const b = controller.effects.subscribe(() => notify());
      return () => {
        a();
        b();
      };
    },
    extraTools: (ctx): AgentTool[] => [
      {
        name: 'set_paper_effect',
        title: 'Set the effect paper',
        description:
          "Draws a provider generator (search_effects with use generator) over the paper and under the paint, at the canvas size: multiplied by default, so the paper's colour and grain still show. Replaces any effect paper; it is saved and exported with the painting. effect null removes it. One undo step. Returns the effect paper (update_effect / remove_effect with target and effect \"paper\" change it later).",
        inputSchema: {
          type: 'object',
          properties: {
            effect: { anyOf: [ctx.effectIdSchema(['generator']), { type: 'null' }], description: 'A generator effect id from search_effects, or null to remove the effect paper.' },
            values: ctx.valuesSchema("Control values over the effect's defaults"),
            opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Strength 0–1 (default 1, or the current effect paper\'s).' },
            blend: { type: 'string', enum: [...PAPER_EFFECT_BLENDS], description: "How it draws over the paper (default multiply, which keeps the paper's grain; normal covers it)." },
            time: { type: 'number', minimum: 0, description: 'Which moment of an animated effect to draw, in ms (default 0).' },
          },
          required: ['effect'],
          additionalProperties: false,
        },
        annotations: { title: 'Set the effect paper', ...ctx.annotations.writeIdempotent },
        handler: async (args) => {
          if (args.effect !== null) ctx.requireProvider();
          return { paperEffect: await controller.setPaperEffect(args.effect, { values: values(args.values), opacity: args.opacity, blend: args.blend as PaperEffectBlend | undefined, time: args.time }) };
        },
      },
      {
        name: 'add_effect_layer',
        title: 'Add an effect layer',
        description:
          'Adds a pixel layer drawn by a provider generator, overlay or title effect (search_effects with use generator, overlay or title) at the canvas size, above the active layer unless aboveId is given, and makes it active. Paint on it like any layer; update_effect (effect "effect") draws it again with new values, replacing its pixels; remove_effect keeps its pixels as a plain layer. One undo step. Returns the new layer and its effect.',
        inputSchema: {
          type: 'object',
          properties: {
            effect: ctx.effectIdSchema(['generator', 'overlay', 'title']),
            values: ctx.valuesSchema("Control values over the effect's defaults"),
            name: { type: 'string', minLength: 1, description: "The layer name (default: the effect's name)." },
            aboveId: { type: 'string', minLength: 1, description: 'Put it directly above this layer (default: above the active layer, else on top).' },
            opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0–1 (default 1).' },
            blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Layer blend mode (default normal); screen or linear-dodge for light, multiply for textures.' },
            time: { type: 'number', minimum: 0, description: 'Which moment of an animated effect to draw, in ms (default 0).' },
          },
          required: ['effect'],
          additionalProperties: false,
        },
        annotations: { title: 'Add an effect layer', ...ctx.annotations.write },
        handler: async (args) => {
          ctx.requireProvider();
          const r = await controller.addEffectLayer(args.effect, { values: values(args.values), name: args.name, aboveId: args.aboveId, opacity: args.opacity, blend: args.blend, time: args.time });
          return { layer: r.layer, effects: layerInfo(r.layer.id) };
        },
      },
      {
        name: 'fill_layer_with_effect',
        title: 'Fill a layer with an effect',
        description:
          "Composites a provider generator, overlay or title effect (rendered at the canvas size) onto a layer's pixels at opacity, as a fill: the layer keeps no link to the effect. lockTransparency (or a transparency-locked layer) only colours what is already painted. Wet paint is refused: dry it first (dry_paint). One undo step. Returns the layer id and the effect used.",
        inputSchema: {
          type: 'object',
          properties: {
            effect: ctx.effectIdSchema(['generator', 'overlay', 'title']),
            layerId: { type: 'string', minLength: 1, description: 'The pixel layer to fill (default: the active layer).' },
            values: ctx.valuesSchema("Control values over the effect's defaults"),
            opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Fill strength 0–1 (default 1).' },
            lockTransparency: { type: 'boolean', description: 'Only colour pixels that are already painted (default false).' },
            time: { type: 'number', minimum: 0, description: 'Which moment of an animated effect to draw, in ms (default 0).' },
          },
          required: ['effect'],
          additionalProperties: false,
        },
        annotations: { title: 'Fill a layer with an effect', ...ctx.annotations.write },
        handler: async (args) => {
          ctx.requireProvider();
          return controller.fillLayerWithEffect(args.effect, { layerId: args.layerId, values: values(args.values), opacity: args.opacity, lockTransparency: args.lockTransparency, time: args.time });
        },
      },
    ],
  }), { director: false, surface: options.playbackSurface });
}
