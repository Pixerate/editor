// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { CanvasNode } from '../types.js';
import { evaluateTrack } from '../../animation/evaluate.js';
import {
	ANIMATABLE_PROPERTIES,
	clampAnimationValue,
	getNodeAnimation,
	normalizeKeyframes,
	type AnimatableProperty,
	type AnimationPropertyOptions,
	type AnimationValue
} from './model.js';

export { evaluateTrack, interpolateAnimationValue, wrapAnimationTime, type AnimationLoopMode } from '../../animation/evaluate.js';

/** Nodes, or a document holding them. */
export type AnimationDocument = readonly CanvasNode[] | { readonly nodes: readonly CanvasNode[] };

/** Evaluated values: node id → property key → value. */
export type AnimationOverrides = Record<string, Record<string, AnimationValue>>;

const nodesOf = (doc: AnimationDocument): readonly CanvasNode[] => (Array.isArray(doc) ? doc : (doc as { nodes: readonly CanvasNode[] }).nodes);

/** The last keyframe time over the enabled tracks of the nodes (0 when nothing is animated). */
export function getAnimationDuration(doc: AnimationDocument): number {
	let end = 0;
	for (const node of nodesOf(doc)) {
		const animation = getNodeAnimation(node);
		if (!animation) continue;
		for (const track of Object.values(animation.tracks)) {
			if (!track || track.enabled === false) continue;
			const keys = normalizeKeyframes(track.keyframes);
			if (keys.length > 0) end = Math.max(end, keys[keys.length - 1].time);
		}
	}
	return end;
}

export interface EvaluateAnimationOptions extends AnimationPropertyOptions {
	/** Only evaluate these nodes. */
	ids?: Iterable<string>;
}

/**
 * Evaluates every enabled track at `time`: node id → property → value. The nodes are not
 * touched; apply the result with `applyAnimationOverrides` (or use `applyAnimation`).
 */
export function evaluateAnimation(doc: AnimationDocument, time: number, options: EvaluateAnimationOptions = {}): AnimationOverrides {
	const only = options.ids ? new Set(options.ids) : null;
	const out: AnimationOverrides = {};
	for (const node of nodesOf(doc)) {
		if (only && !only.has(node.id)) continue;
		const animation = getNodeAnimation(node);
		if (!animation) continue;
		let values: Record<string, AnimationValue> | undefined;
		for (const [key, track] of Object.entries(animation.tracks)) {
			if (!track || track.enabled === false) continue;
			const property = (options.properties ?? ANIMATABLE_PROPERTIES).find((p) => p.key === key);
			const value = evaluateTrack(track, time, property?.type ?? 'number');
			if (value === undefined) continue;
			(values ??= {})[key] = clampAnimationValue(property, value);
		}
		if (values) out[node.id] = values;
	}
	return out;
}

/**
 * Writes evaluated values into copies of the nodes (in the registry's order). Nodes without
 * overrides keep their identity, and the input array is returned when nothing changes.
 */
export function applyAnimationOverrides<TNode extends CanvasNode>(nodes: readonly TNode[], overrides: AnimationOverrides, options: AnimationPropertyOptions = {}): TNode[] {
	const properties: readonly AnimatableProperty[] = options.properties ?? ANIMATABLE_PROPERTIES;
	let changed = false;
	const out = nodes.map((node) => {
		const values = overrides[node.id];
		if (!values) return node;
		let next: CanvasNode = node;
		for (const property of properties) {
			if (!(property.key in values)) continue;
			next = property.write(next, values[property.key]);
		}
		if (next !== node) changed = true;
		return next as TNode;
	});
	return changed ? out : (nodes as TNode[]);
}

/**
 * The nodes as they look at `time`: `applyAnimationOverrides(nodes, evaluateAnimation(nodes, time))`.
 * Run it after `resolveCanvasTokens` so animated values win over token values while playing.
 */
export function applyAnimation<TNode extends CanvasNode>(nodes: readonly TNode[], time: number, options: EvaluateAnimationOptions = {}): TNode[] {
	return applyAnimationOverrides(nodes, evaluateAnimation(nodes, time, options), options);
}
