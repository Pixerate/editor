/**
 * Effect layer rules shared by the controller and the panels: which layers sit below one (so its
 * background starts transparent), the checks on a still frame's time and an animation, and the
 * timing the panels show.
 */

import type { EffectDescription, EffectSummary, EffectValue } from '../effects/types';
import { LayerOperationError } from './layers/ops';
import { flattenLayers, MAX_EFFECT_ANIMATION_MS, type ImageEffectAnimation, type ImageEffectGenerator, type ImageLayer } from './layers/model';

/**
 * Whether anything is drawn below layer `id` in the stack: a pixel, shape, type or smart object
 * layer under it (groups and adjustment layers draw nothing of their own). False for the bottom
 * layer, or an id not in the stack.
 */
export function hasLayersBelow(layers: readonly ImageLayer[], id: string): boolean {
  const all = flattenLayers(layers);
  const at = all.findIndex((l) => l.id === id);
  return at > 0 && all.slice(0, at).some((l) => l.type !== 'group' && l.type !== 'adjustment' && l.type !== 'annotation');
}

/**
 * `values` with the effect's background opacity control (`backgroundOpacity`) set to 0 when the
 * layer has others below it and `values` leave it unset; otherwise `values` unchanged.
 */
export function withBackgroundOpacity(d: Pick<EffectDescription, 'backgroundOpacity'>, values: Record<string, EffectValue> | undefined, below: boolean): Record<string, EffectValue> {
  const out = { ...values };
  if (below && d.backgroundOpacity && out[d.backgroundOpacity] === undefined) out[d.backgroundOpacity] = 0;
  return out;
}

/** A still frame's time: a number of ms from 0 (undefined is 0). */
export function checkEffectTime(time: number | undefined): number {
  if (time === undefined) return 0;
  if (!(typeof time === 'number' && Number.isFinite(time) && time >= 0)) throw new LayerOperationError('time must be a number of ms from 0.');
  return time;
}

/** An effect layer's animation: a duration in ms, more than 0 and at most `MAX_EFFECT_ANIMATION_MS`. */
export function checkEffectAnimation(animate: ImageEffectAnimation): ImageEffectAnimation {
  const duration = animate?.duration;
  if (!(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= MAX_EFFECT_ANIMATION_MS)) {
    throw new LayerOperationError(`animate.duration must be more than 0 and at most ${MAX_EFFECT_ANIMATION_MS} ms.`);
  }
  return { duration: Math.round(duration) };
}

/** What the panels show of an effect layer's timing (see `effectLayerTiming`). */
export interface EffectLayerTiming {
  /** A still frame at `time`, or playing from `time` in an animation. */
  mode: 'still' | 'animate';
  /** The frame drawn (ms): the still frame, and where the animation starts. */
  time: number;
  /** How far the frame can be moved (ms): one loop of a looping effect, else one play. */
  range: number;
  /** How long it plays in an animation (ms): its own, else the effect's play. */
  duration: number;
  /** The effect repeats every `range` ms. */
  loops: boolean;
}

/**
 * An effect layer's timing for the panels, or null when its effect does not change over time
 * (the provider gives it no `duration`).
 */
export function effectLayerTiming(g: ImageEffectGenerator, d: Pick<EffectSummary, 'duration' | 'loop'> | null | undefined): EffectLayerTiming | null {
  if (!d?.duration) return null;
  const time = g.time ?? 0;
  return { mode: g.animate ? 'animate' : 'still', time, range: Math.max(d.duration, time), duration: g.animate?.duration ?? d.duration, loops: d.loop };
}
