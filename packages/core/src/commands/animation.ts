import type { CommandSpec } from './registry.js';

/**
 * Animation controller surface used by `createCanvasAnimationCommands`
 * (`createCanvasAnimationController`, `useCanvasAnimation` and `createCanvasAnimation` satisfy it).
 */
export interface AnimationCommandTarget {
	getState(): { playing: boolean; recording: boolean; time: number; duration: number; selection: readonly unknown[] };
	play(): void;
	pause(): void;
	toggle(): void;
	stop(): void;
	seek(time: number): void;
	toggleRecording(): void;
	addKeyframe(ids?: Iterable<string>, keys?: readonly string[], time?: number): unknown;
	deleteKeyframes(): unknown;
	setEasing(easing: any, refs?: readonly any[]): unknown;
	nextKeyframe(): unknown;
	previousKeyframe(): unknown;
	animateNode(nodeId: string, options: any): unknown;
	exportCss(nodeId: string, options?: any): { css: string; exact: boolean };
}

export interface AnimationCommandOptions {
	/** Id prefix (default `canvas.animation.`). */
	prefix?: string;
	group?: string;
	/** Scope (default `canvas`). Pass `null` for global. */
	scope?: string | null;
}

const EASING_DESCRIPTION =
	'Easing preset (linear, ease, ease-in, ease-out, ease-in-out, ease-in-back, ease-out-back, spring, hold) or a CSS cubic-bezier(x1, y1, x2, y2).';

const VALUES = {
	type: 'object',
	description: 'Property → value, e.g. {"x": 200, "opacity": 0.5, "fill": "#ff0000"}. Properties: x, y, width, height, rotation (degrees), scale, opacity (0–1), fill, stroke, strokeWidth, cornerRadius, motionPath (0–1).',
	additionalProperties: { type: ['number', 'string'] }
} as const;

/**
 * Palette / shortcut / agent commands for canvas animation: play / pause, seek, add keyframe at
 * the playhead, delete keyframes, set easing, record toggle, keyframe navigation, "animate
 * node from A to B over T" and CSS export. Edits are undoable when the controller has a history.
 */
export function createCanvasAnimationCommands(controller: AnimationCommandTarget, options: AnimationCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'canvas.animation.';
	const group = options.group ?? 'Animation';
	const scope = options.scope === null ? undefined : options.scope ?? 'canvas';
	const base = { group, ...(scope ? { scope } : {}) };
	const hasSelection = () => (controller.getState().selection.length > 0 ? true : 'Select keyframes first.');
	return [
		{
			...base,
			id: `${prefix}togglePlay`,
			label: 'Play / Pause Animation',
			keywords: ['play', 'pause', 'preview', 'timeline'],
			description: 'Plays or pauses the canvas animation from the playhead.',
			run: () => {
				controller.toggle();
				return { playing: controller.getState().playing, time: controller.getState().time };
			}
		},
		{
			...base,
			id: `${prefix}play`,
			label: 'Play Animation',
			keywords: ['preview', 'timeline'],
			enabled: () => (controller.getState().playing ? 'Already playing.' : true),
			run: () => controller.play()
		},
		{
			...base,
			id: `${prefix}pause`,
			label: 'Pause Animation',
			enabled: () => (controller.getState().playing ? true : 'Not playing.'),
			run: () => controller.pause()
		},
		{
			...base,
			id: `${prefix}stop`,
			label: 'Stop Animation',
			keywords: ['rewind', 'reset'],
			description: 'Stops playback and returns to the start.',
			run: () => controller.stop()
		},
		{
			...base,
			id: `${prefix}seek`,
			label: 'Go to Time…',
			keywords: ['playhead', 'scrub', 'time'],
			description: 'Moves the playhead.',
			params: {
				type: 'object',
				properties: { time: { type: 'number', minimum: 0, description: 'Time in milliseconds.' } },
				required: ['time']
			},
			run: (_ctx: unknown, params: { time: number }) => {
				controller.seek(params.time);
				return { time: controller.getState().time };
			}
		},
		{
			...base,
			id: `${prefix}addKeyframe`,
			label: 'Add Keyframe at Playhead',
			keywords: ['key', 'animate', 'record'],
			description: 'Keys the selected nodes (or `ids`) at the playhead (or `time`): their animated properties, `properties`, or position.',
			params: {
				type: 'object',
				properties: {
					ids: { type: 'array', items: { type: 'string' }, description: 'Node ids (default: selected nodes).' },
					properties: { type: 'array', items: { type: 'string' }, description: 'Properties to key (default: animated ones, or x and y).' },
					time: { type: 'number', minimum: 0, description: 'Time in ms (default: the playhead).' }
				}
			},
			run: (_ctx: unknown, params: { ids?: string[]; properties?: string[]; time?: number }) =>
				controller.addKeyframe(params?.ids, params?.properties, params?.time)
		},
		{
			...base,
			id: `${prefix}deleteKeyframes`,
			label: 'Delete Keyframes',
			keywords: ['remove', 'clear'],
			enabled: hasSelection,
			run: () => controller.deleteKeyframes()
		},
		{
			...base,
			id: `${prefix}setEasing`,
			label: 'Set Keyframe Easing…',
			keywords: ['interpolation', 'ease', 'bezier', 'spring', 'hold', 'curve'],
			description: 'Sets the easing of the segments leaving the selected keyframes.',
			params: {
				type: 'object',
				properties: { easing: { type: 'string', description: EASING_DESCRIPTION } },
				required: ['easing']
			},
			enabled: hasSelection,
			run: (_ctx: unknown, params: { easing: string }) => controller.setEasing(params.easing)
		},
		{
			...base,
			id: `${prefix}toggleRecord`,
			label: 'Toggle Record Mode',
			keywords: ['auto key', 'record', 'keyframe'],
			description: 'In record mode, changing a property at the playhead keys it.',
			run: () => {
				controller.toggleRecording();
				return { recording: controller.getState().recording };
			}
		},
		{
			...base,
			id: `${prefix}nextKeyframe`,
			label: 'Next Keyframe',
			keywords: ['jump', 'navigate'],
			run: () => controller.nextKeyframe()
		},
		{
			...base,
			id: `${prefix}previousKeyframe`,
			label: 'Previous Keyframe',
			keywords: ['jump', 'navigate'],
			run: () => controller.previousKeyframe()
		},
		{
			...base,
			id: `${prefix}animateNode`,
			label: 'Animate Node…',
			keywords: ['tween', 'transition', 'move', 'fade'],
			description: 'Animates a node from `from` (default: its current values) to `to` over `duration` ms, starting at `delay` ms.',
			params: {
				type: 'object',
				properties: {
					nodeId: { type: 'string', description: 'Node to animate.' },
					to: VALUES,
					from: VALUES,
					duration: { type: 'number', exclusiveMinimum: 0, description: 'Duration in ms (default 1000).' },
					delay: { type: 'number', minimum: 0, description: 'Start time in ms (default 0).' },
					easing: { type: 'string', description: EASING_DESCRIPTION }
				},
				required: ['nodeId', 'to']
			},
			run: (_ctx: unknown, params: { nodeId: string; to: Record<string, number | string>; from?: Record<string, number | string>; duration?: number; delay?: number; easing?: string }) =>
				controller.animateNode(params.nodeId, {
					to: params.to,
					...(params.from ? { from: params.from } : {}),
					...(params.duration !== undefined ? { duration: params.duration } : {}),
					...(params.delay !== undefined ? { delay: params.delay } : {}),
					...(params.easing !== undefined ? { easing: params.easing } : {})
				})
		},
		{
			...base,
			id: `${prefix}exportCss`,
			label: 'Export Animation as CSS',
			keywords: ['keyframes', 'css', 'web animations'],
			description: 'Returns CSS @keyframes for a node\'s animation.',
			readOnly: true,
			params: {
				type: 'object',
				properties: { nodeId: { type: 'string' } },
				required: ['nodeId']
			},
			run: (_ctx: unknown, params: { nodeId: string }) => controller.exportCss(params.nodeId)
		}
	];
}
