import type { CanvasNode } from '../types.js';
import type { AnimationEasing } from './easing.js';
import type { KeyframeRef } from './edit.js';
import {
	ANIMATABLE_PROPERTIES,
	ANIMATION_TIME_EPSILON,
	getAnimatedProperties,
	getAnimationTrack,
	normalizeKeyframes,
	type AnimationPropertyOptions,
	type AnimationValue
} from './model.js';

/**
 * View-model helpers for timeline UIs (React and Svelte render the same rows).
 */

export interface TimelineKeyframe {
	ref: KeyframeRef;
	/** Time shown (includes the preview offset of a keyframe drag). */
	time: number;
	value: AnimationValue;
	easing?: AnimationEasing;
	selected: boolean;
}

export interface TimelineRow {
	/** `nodeId:property`. */
	id: string;
	nodeId: string;
	nodeLabel: string;
	property: string;
	label: string;
	enabled: boolean;
	keyframes: TimelineKeyframe[];
}

export interface TimelineRowsOptions extends AnimationPropertyOptions {
	/** Selected keyframes. */
	selection?: readonly KeyframeRef[];
	/** Preview offset for the selected keyframes while they are dragged. */
	dragDelta?: number;
	/** Row label for a node (default: `data.label`, then the id). */
	labelOf?: (node: CanvasNode) => string;
}

/** Whether `ref` is in `selection` (same node, property and time). */
export function isKeyframeSelected(selection: readonly KeyframeRef[], ref: KeyframeRef): boolean {
	return selection.some((s) => s.nodeId === ref.nodeId && s.property === ref.property && Math.abs(s.time - ref.time) <= ANIMATION_TIME_EPSILON);
}

const defaultLabel = (node: CanvasNode) => (typeof node.data?.label === 'string' && node.data.label.trim() ? node.data.label : node.id);

/** One row per animated property of each node in `ids` (in `ids` order). */
export function getTimelineRows(nodes: readonly CanvasNode[], ids: Iterable<string>, options: TimelineRowsOptions = {}): TimelineRow[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const selection = options.selection ?? [];
	const labelOf = options.labelOf ?? defaultLabel;
	const rows: TimelineRow[] = [];
	for (const id of new Set(ids)) {
		const node = byId.get(id);
		if (!node) continue;
		for (const property of getAnimatedProperties(node, options)) {
			const track = getAnimationTrack(node, property)!;
			const label = (options.properties ?? ANIMATABLE_PROPERTIES).find((p) => p.key === property)?.label ?? property;
			rows.push({
				id: `${id}:${property}`,
				nodeId: id,
				nodeLabel: labelOf(node),
				property,
				label,
				enabled: track.enabled !== false,
				keyframes: normalizeKeyframes(track.keyframes).map((k) => {
					const ref = { nodeId: id, property, time: k.time };
					const selected = isKeyframeSelected(selection, ref);
					return {
						ref,
						time: selected && options.dragDelta ? k.time + options.dragDelta : k.time,
						value: k.value,
						...(k.easing !== undefined ? { easing: k.easing } : {}),
						selected
					};
				})
			});
		}
	}
	return rows;
}

/** x position (px) of `time` on a lane `width` px wide showing `[0, duration]`. */
export function timeToX(time: number, duration: number, width: number): number {
	return duration > 0 ? (time / duration) * width : 0;
}

/** Time at x (px) on a lane `width` px wide, clamped to `[0, duration]`. */
export function xToTime(x: number, duration: number, width: number): number {
	if (!(width > 0) || !(duration > 0)) return 0;
	return Math.min(duration, Math.max(0, (x / width) * duration));
}

/** `1.25s` style label. */
export function formatAnimationTime(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	return `${s.toFixed(s < 10 ? 2 : 1)}s`;
}

const STEPS = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** Ruler ticks at a round step leaving at least `minSpacing` px between labels. */
export function getTimelineTicks(duration: number, width: number, minSpacing = 60): { time: number; x: number; label: string }[] {
	if (!(duration > 0) || !(width > 0)) return [];
	const step = STEPS.find((s) => timeToX(s, duration, width) >= minSpacing) ?? STEPS[STEPS.length - 1];
	const ticks: { time: number; x: number; label: string }[] = [];
	for (let t = 0; t <= duration + 1e-6 && ticks.length < 1000; t += step) {
		ticks.push({ time: t, x: timeToX(t, duration, width), label: formatAnimationTime(t) });
	}
	return ticks;
}
