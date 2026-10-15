// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { getNodeSize, readStyleSize, withStyleSize } from '../arrange.js';
import { bezierPathLength, bezierPathPointAtLength } from '../pathops/bezier.js';
import { getCanvasTokenProperty, readNodeStyleProperty, writeNodeStyleProperty } from '../tokenBindings.js';
import { withStyleOpacity } from '../trajectory.js';
import type { CanvasNode } from '../types.js';
import { ANIMATION_TIME_EPSILON, isAnimationKeyframe, normalizeKeyframes, type AnimationKeyframe, type AnimationTrack, type AnimationValue, type AnimationValueType } from '../../animation/keyframes.js';

export { ANIMATION_TIME_EPSILON, isAnimationKeyframe, normalizeKeyframes, type AnimationKeyframe, type AnimationTrack, type AnimationValue, type AnimationValueType };

/**
 * Keyframe animation for canvas nodes.
 *
 * A node's animation lives in `node.data.animation`, so it is copied, pasted, duplicated and
 * serialised with the node (component instances copy it too). Each animatable property has a
 * track of keyframes `{ time (ms), value, easing }`; the easing governs the segment *leaving*
 * the keyframe (filmcraft / After Effects convention).
 */

/** Data key holding a node's animation. */
export const ANIMATION_DATA_KEY = 'animation';

/** A path a node's centre follows, driven by the `motionPath` track (progress 0–1). */
export interface AnimationMotionPath {
	/** SVG path data in flow coordinates (the parent's when the node has a `parentId`). */
	d: string;
	/** Rotate the node along the path's tangent (default `false`). */
	autoRotate?: boolean;
}

export interface NodeAnimation {
	/** Property key → track. */
	tracks: Record<string, AnimationTrack>;
	motionPath?: AnimationMotionPath;
}

/** A node property keyframes can drive. */
export interface AnimatableProperty {
	key: string;
	label: string;
	type: AnimationValueType;
	/** Values are clamped into `[min, max]` when written. */
	min?: number;
	max?: number;
	/** Unit for display (`px`, `°`, …). */
	unit?: string;
	/** The node's current (static) value, or `undefined` when it has none. */
	read(node: CanvasNode): AnimationValue | undefined;
	/** Returns the node with `value` written (a new object; the input is never mutated). */
	write(node: CanvasNode, value: AnimationValue): CanvasNode;
}

const num = (value: unknown): number | undefined => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value === 'string') {
		const n = parseFloat(value);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
};

const tidy = (v: number) => Math.round(v * 10000) / 10000;

function tokenBacked(key: string, label: string, type: AnimationValueType, extra: Partial<AnimatableProperty> = {}): AnimatableProperty {
	return {
		key,
		label,
		type,
		...extra,
		read: (node) => {
			const p = getCanvasTokenProperty(key);
			const v = p?.appliesTo(node) ? p.read(node) : undefined;
			return typeof v === 'number' || typeof v === 'string' ? v : undefined;
		},
		write: (node, value) => {
			const p = getCanvasTokenProperty(key);
			return p?.appliesTo(node) ? p.write(node, value) : node;
		}
	};
}

function sizeProperty(key: 'width' | 'height', label: string): AnimatableProperty {
	return {
		key,
		label,
		type: 'number',
		min: 0,
		unit: 'px',
		read: (node) => num(node[key]) ?? readStyleSize(node.style)[key] ?? num(node.measured?.[key]),
		write: (node, value) => {
			const v = tidy(Math.max(0, value as number));
			return { ...node, [key]: v, style: withStyleSize(node.style, { [key]: v }) };
		}
	};
}

function motionPathPoint(node: CanvasNode, progress: number) {
	const path = getNodeAnimation(node)?.motionPath;
	if (!path || typeof path.d !== 'string') return null;
	try {
		const length = bezierPathLength(path.d);
		return bezierPathPointAtLength(path.d, Math.min(1, Math.max(0, progress)) * length);
	} catch {
		return null;
	}
}

/**
 * The built-in animatable properties, in the order they are applied (`motionPath` comes after
 * `x` / `y` / `rotation` so it wins over them).
 *
 * Rotation and scale use the CSS individual transform properties (`style.rotate`,
 * `style.scale`), which compose with the `transform` xyflow positions nodes with.
 */
export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
	{
		key: 'x',
		label: 'X',
		type: 'number',
		unit: 'px',
		read: (node) => num(node.position?.x),
		write: (node, value) => ({ ...node, position: { ...node.position, x: tidy(value as number) } })
	},
	{
		key: 'y',
		label: 'Y',
		type: 'number',
		unit: 'px',
		read: (node) => num(node.position?.y),
		write: (node, value) => ({ ...node, position: { ...node.position, y: tidy(value as number) } })
	},
	sizeProperty('width', 'Width'),
	sizeProperty('height', 'Height'),
	{
		key: 'rotation',
		label: 'Rotation',
		type: 'number',
		unit: '°',
		read: (node) => num(readNodeStyleProperty(node.style, 'rotate')) ?? 0,
		write: (node, value) => ({
			...node,
			style: writeNodeStyleProperty(node.style, 'rotate', `${tidy(value as number)}deg`)
		})
	},
	{
		key: 'scale',
		label: 'Scale',
		type: 'number',
		min: 0,
		read: (node) => num(readNodeStyleProperty(node.style, 'scale')) ?? 1,
		write: (node, value) => ({
			...node,
			style: writeNodeStyleProperty(node.style ?? {}, 'scale', tidy(Math.max(0, value as number)), true)
		})
	},
	{
		key: 'opacity',
		label: 'Opacity',
		type: 'number',
		min: 0,
		max: 1,
		read: (node) => num(readNodeStyleProperty(node.style, 'opacity')) ?? 1,
		write: (node, value) => ({
			...node,
			style: withStyleOpacity(node.style, tidy(Math.min(1, Math.max(0, value as number))), typeof node.style === 'string' ? 'string' : 'object')
		})
	},
	tokenBacked('fill', 'Fill', 'color'),
	tokenBacked('stroke', 'Stroke', 'color'),
	tokenBacked('strokeWidth', 'Stroke width', 'number', { min: 0, unit: 'px' }),
	tokenBacked('cornerRadius', 'Corner radius', 'number', { min: 0, unit: 'px' }),
	{
		key: 'motionPath',
		label: 'Motion path',
		type: 'number',
		min: 0,
		max: 1,
		read: () => undefined,
		write: (node, value) => {
			const at = motionPathPoint(node, value as number);
			if (!at) return node;
			const { width, height } = getNodeSize(node);
			let next: CanvasNode = {
				...node,
				position: { x: tidy(at.point[0] - width / 2), y: tidy(at.point[1] - height / 2) }
			};
			if (getNodeAnimation(node)?.motionPath?.autoRotate) {
				const base = num(readNodeStyleProperty(node.style, 'rotate')) ?? 0;
				next = { ...next, style: writeNodeStyleProperty(next.style, 'rotate', `${tidy(base + (at.angle * 180) / Math.PI)}deg`) };
			}
			return next;
		}
	}
];

export interface AnimationPropertyOptions {
	/** Animatable properties (default {@link ANIMATABLE_PROPERTIES}); add your own to extend. */
	properties?: readonly AnimatableProperty[];
}

export function getAnimatableProperty(key: string, options: AnimationPropertyOptions = {}): AnimatableProperty | undefined {
	return (options.properties ?? ANIMATABLE_PROPERTIES).find((p) => p.key === key);
}

/** Clamps a value into a property's range (numbers) or returns it unchanged. */
export function clampAnimationValue(property: AnimatableProperty | undefined, value: AnimationValue): AnimationValue {
	if (!property || typeof value !== 'number') return value;
	let v = value;
	if (property.min !== undefined) v = Math.max(property.min, v);
	if (property.max !== undefined) v = Math.min(property.max, v);
	return v;
}

/** The node's animation (tracks with at least one valid keyframe), or `null`. */
export function getNodeAnimation(node: CanvasNode | undefined | null): NodeAnimation | null {
	const raw = node?.data?.[ANIMATION_DATA_KEY];
	if (typeof raw !== 'object' || raw === null || typeof raw.tracks !== 'object' || raw.tracks === null) return null;
	return raw as NodeAnimation;
}

/** The track for `property` on a node, if it has keyframes. */
export function getAnimationTrack(node: CanvasNode | undefined | null, property: string): AnimationTrack | undefined {
	const track = getNodeAnimation(node)?.tracks[property];
	return track && Array.isArray(track.keyframes) && normalizeKeyframes(track.keyframes).length > 0 ? track : undefined;
}

/** Whether the node has any (enabled or disabled) keyframes. */
export function isNodeAnimated(node: CanvasNode | undefined | null): boolean {
	const animation = getNodeAnimation(node);
	if (!animation) return false;
	return Object.keys(animation.tracks).some((key) => getAnimationTrack(node, key) !== undefined);
}

/** Property keys of the node's tracks (in registry order, unknown keys last). */
export function getAnimatedProperties(node: CanvasNode | undefined | null, options: AnimationPropertyOptions = {}): string[] {
	const animation = getNodeAnimation(node);
	if (!animation) return [];
	const keys = Object.keys(animation.tracks).filter((k) => getAnimationTrack(node, k));
	const order = (options.properties ?? ANIMATABLE_PROPERTIES).map((p) => p.key);
	const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
	return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Returns the node with its animation replaced (`null` or no tracks removes the key). Empty
 * tracks are dropped.
 */
export function withNodeAnimation<TNode extends CanvasNode>(node: TNode, animation: NodeAnimation | null): TNode {
	const tracks: Record<string, AnimationTrack> = {};
	if (animation) {
		for (const [key, track] of Object.entries(animation.tracks)) {
			if (track && Array.isArray(track.keyframes) && track.keyframes.length > 0) tracks[key] = track;
		}
	}
	const data: Record<string, any> = { ...(node.data ?? {}) };
	if (Object.keys(tracks).length === 0 && !animation?.motionPath) delete data[ANIMATION_DATA_KEY];
	else data[ANIMATION_DATA_KEY] = { ...animation, tracks };
	return { ...node, data };
}
