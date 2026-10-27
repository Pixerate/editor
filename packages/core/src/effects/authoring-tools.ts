/**
 * Agent tools for authoring shaders and procedural effects: inspecting controls, setting values,
 * applying presets, managing keyframes on animation tracks, playback timing, and previewing.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { ANIMATION_EASING_PRESETS, type AnimationEasing } from '../animation/easing.js';
import type { EffectAuthoringSession } from './authoring.js';
import type { EffectValue, EffectValues } from './types.js';
import { effectParameterFields } from './ui.js';

export interface EffectAuthoringToolHost {
	/**
	 * The open authoring session, or null when nothing is open (tools then refuse with a message
	 * explaining how to open one).
	 */
	session(): EffectAuthoringSession | null;
	/** Optional: a PNG data URL of the preview, for the `effect_authoring_view` tool. */
	capture?(): Promise<string>;
	/** Lets the tool list follow session opens, closes, or changes. */
	subscribe?: (notify: () => void) => () => void;
}

export interface EffectAuthoringToolOptions {
	/** Provider id (unique per registry). Default: 'effect-authoring'. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id. */
	namespace?: string;
	/** Toolset title. */
	title?: string;
	/** Toolset description. */
	description?: string;
	/** Name of the agent skill documenting these tools. */
	skill?: string;
}

const ANNOTATIONS = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	writeIdempotent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
} as const;

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema & { type: 'object' } => ({
	type: 'object',
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

/** Every `AnimationEasing`: a preset name, or a cubic-bezier, spring or elastic curve. */
const EASING_SCHEMA: JsonSchema = {
	description:
		'Easing into the next keyframe: a preset name, or a curve { "type": "cubic-bezier", x1, y1, x2, y2 }, { "type": "spring", stiffness, damping, mass, velocity } or { "type": "elastic", amplitude, period, mode }. Default: linear.',
	anyOf: [
		{ type: 'string', enum: [...ANIMATION_EASING_PRESETS] },
		object(
			{
				type: { type: 'string', enum: ['cubic-bezier', 'spring', 'elastic'], description: 'Curve kind.' },
				x1: { type: 'number', description: 'cubic-bezier: out handle x (0–1).' },
				y1: { type: 'number', description: 'cubic-bezier: out handle y.' },
				x2: { type: 'number', description: 'cubic-bezier: in handle x (0–1).' },
				y2: { type: 'number', description: 'cubic-bezier: in handle y.' },
				stiffness: { type: 'number', exclusiveMinimum: 0, description: 'spring: default 170.' },
				damping: { type: 'number', minimum: 0, description: 'spring: default 26, lower bounces more.' },
				mass: { type: 'number', exclusiveMinimum: 0, description: 'spring: default 1.' },
				velocity: { type: 'number', description: 'spring: starting speed (default 0).' },
				amplitude: { type: 'number', minimum: 0, description: 'elastic: overshoot (default 1).' },
				period: { type: 'number', exclusiveMinimum: 0, description: 'elastic: fraction of the length (default 0.3).' },
				mode: { type: 'string', enum: ['out', 'in', 'in-out'], description: 'elastic: default out.' }
			},
			['type']
		)
	]
};

const NO_SESSION =
	'No effect authoring session is currently open. Open an effect using EffectProvider.openAuthoring() or in an authoring editor before calling effect authoring tools.';

/** Creates the agent tool provider for effect authoring. */
export function createEffectAuthoringToolProvider(
	host: EffectAuthoringToolHost,
	options?: EffectAuthoringToolOptions
): AgentToolProvider {
	const id = options?.id ?? 'effect-authoring';
	const namespace = options?.namespace;
	const title = options?.title ?? 'Effect authoring';
	const description =
		options?.description ??
		'Author shaders and procedural effects, inspect parameters, adjust values, and manage keyframe animations.';
	const skill = options?.skill ?? 'pixerate-effect-authoring';

	const requireSession = (): EffectAuthoringSession => {
		const s = host.session();
		if (!s) throw new Error(NO_SESSION);
		return s;
	};

	const describeTool: AgentTool = {
		name: 'effect_authoring_describe',
		title: 'Describe open effect',
		description:
			'Describes the effect currently open for authoring: name, kind, source language, controls schema and current values, presets, animated tracks with keyframe counts, playhead time, duration, loop, compile issues, and previewError: why there is no pixel preview (e.g. a vector effect the provider only draws as SVG), or null.',
		inputSchema: object({}),
		annotations: { title: 'Describe open effect', ...ANNOTATIONS.read },
		handler: () => {
			const session = requireSession();
			const state = session.getState();
			return {
				name: state.description.name,
				kind: state.description.kind,
				sourceLanguage: state.sourceLanguage,
				controls: effectParameterFields(state.description),
				values: state.values,
				presets: state.description.presets?.map((p) => p.name) ?? [],
				tracks: Object.entries(state.tracks).map(([control, track]) => ({
					control,
					keyframes: track.length
				})),
				time: state.time,
				duration: state.duration,
				loop: state.loop,
				issues: state.issues,
				previewError: state.previewError ?? null
			};
		}
	};

	const getSourceTool: AgentTool = {
		name: 'effect_authoring_get_source',
		title: 'Get effect source code',
		description:
			'Gets the shader or script source code and language of the currently open effect. Refused if the effect does not use source code.',
		inputSchema: object({}),
		annotations: { title: 'Get effect source code', ...ANNOTATIONS.read },
		handler: () => {
			const session = requireSession();
			const state = session.getState();
			if (state.sourceLanguage === null || state.source === null) {
				throw new Error(
					`The currently open effect (${state.description.name}) does not use shader or script source code.`
				);
			}
			return { language: state.sourceLanguage, source: state.source };
		}
	};

	const setSourceTool: AgentTool = {
		name: 'effect_authoring_set_source',
		title: 'Set effect source code',
		description:
			'Replaces the shader or script source code of the currently open effect and recompiles it. Returns any compile issues.',
		inputSchema: object(
			{
				source: { type: 'string', description: 'The new shader or script source code to compile and apply.' }
			},
			['source']
		),
		annotations: { title: 'Set effect source code', ...ANNOTATIONS.write },
		handler: async (args) => {
			const session = requireSession();
			if (!session.setSource) {
				throw new Error('The currently open session does not support setting source code.');
			}
			const res = await session.setSource(args.source as string);
			if (!res.ok) throw new Error(res.message);
			return { issues: res.issues };
		}
	};

	const setValuesTool: AgentTool = {
		name: 'effect_authoring_set_values',
		title: 'Set effect control values',
		description:
			'Sets one or more control values on the currently open effect at the current playhead time. All-or-nothing: if any control name or value is invalid, no values are changed. One undo step.',
		inputSchema: object(
			{
				values: {
					type: 'object',
					description: 'Map of control names to their new values (numbers, booleans, "#rrggbb" colors, vectors).'
				}
			},
			['values']
		),
		annotations: { title: 'Set effect control values', ...ANNOTATIONS.writeIdempotent },
		handler: (args) => {
			const session = requireSession();
			const res = session.setValues(args.values as EffectValues);
			if (!res.ok) throw new Error(res.message);
			return { values: session.getState().values };
		}
	};

	const resetValuesTool: AgentTool = {
		name: 'effect_authoring_reset_values',
		title: 'Reset effect control values',
		description:
			'Resets specified controls (or all controls if names is omitted) to their default values. One undo step.',
		inputSchema: object({
			names: {
				type: 'array',
				items: { type: 'string' },
				description: 'Names of the controls to reset. If omitted, resets all controls to their defaults.'
			}
		}),
		annotations: { title: 'Reset effect control values', ...ANNOTATIONS.writeIdempotent },
		handler: (args) => {
			const session = requireSession();
			const res = session.resetValues(args.names as string[] | undefined);
			if (!res.ok) throw new Error(res.message);
			return { values: session.getState().values };
		}
	};

	const applyPresetTool: AgentTool = {
		name: 'effect_authoring_apply_preset',
		title: 'Apply effect preset',
		description: 'Applies a saved or built-in preset by name, setting its values as one undo step.',
		inputSchema: object(
			{
				name: { type: 'string', description: 'Name of the preset to apply.' }
			},
			['name']
		),
		annotations: { title: 'Apply effect preset', ...ANNOTATIONS.write },
		handler: (args) => {
			const session = requireSession();
			const res = session.applyPreset(args.name as string);
			if (!res.ok) throw new Error(res.message);
			return { values: session.getState().values };
		}
	};

	const savePresetTool: AgentTool = {
		name: 'effect_authoring_save_preset',
		title: 'Save effect preset',
		description:
			'Saves the current values as a preset under the given name (or updates an existing preset with that name). One undo step.',
		inputSchema: object(
			{
				name: { type: 'string', description: 'Name for the preset.' }
			},
			['name']
		),
		annotations: { title: 'Save effect preset', ...ANNOTATIONS.write },
		handler: (args) => {
			const session = requireSession();
			const res = session.savePreset(args.name as string);
			if (!res.ok) throw new Error(res.message);
			return { name: args.name as string, values: session.getState().values };
		}
	};

	const setKeyframeTool: AgentTool = {
		name: 'effect_authoring_set_keyframe',
		title: 'Set effect keyframe',
		description:
			'Adds or updates a keyframe on a control track at a specific time in milliseconds. If value is omitted, uses the current resolved value of the control at that time. One undo step.',
		inputSchema: object(
			{
				control: { type: 'string', description: 'Name of the control to animate.' },
				time: { type: 'number', minimum: 0, description: 'Time in milliseconds from the start of the effect.' },
				value: { description: 'Value at this keyframe. If omitted, captures the control value at that time.' },
				easing: EASING_SCHEMA
			},
			['control', 'time']
		),
		annotations: { title: 'Set effect keyframe', ...ANNOTATIONS.writeIdempotent },
		handler: (args) => {
			const session = requireSession();
			const res = session.setKeyframe(
				args.control as string,
				args.time as number,
				args.value as EffectValue | undefined,
				args.easing as AnimationEasing | undefined
			);
			if (!res.ok) throw new Error(res.message);
			const track = session.getState().tracks[args.control as string];
			return { control: args.control, keyframes: track ?? [] };
		}
	};

	const removeKeyframeTool: AgentTool = {
		name: 'effect_authoring_remove_keyframe',
		title: 'Remove effect keyframe',
		description:
			'Removes a keyframe at the exact time in milliseconds for the specified control. One undo step.',
		inputSchema: object(
			{
				control: { type: 'string', description: 'Name of the control.' },
				time: { type: 'number', minimum: 0, description: 'Time in milliseconds of the keyframe to remove.' }
			},
			['control', 'time']
		),
		annotations: { title: 'Remove effect keyframe', ...ANNOTATIONS.write },
		handler: (args) => {
			const session = requireSession();
			const res = session.removeKeyframe(args.control as string, args.time as number);
			if (!res.ok) throw new Error(res.message);
			const track = session.getState().tracks[args.control as string];
			return { control: args.control, keyframes: track ?? [] };
		}
	};

	const clearTrackTool: AgentTool = {
		name: 'effect_authoring_clear_track',
		title: 'Clear effect animation track',
		description:
			'Removes all keyframes from an animated control. The value it has at the playhead becomes its static value. One undo step.',
		inputSchema: object(
			{
				control: { type: 'string', description: 'Name of the control whose animation track to remove.' }
			},
			['control']
		),
		annotations: { title: 'Clear effect animation track', ...ANNOTATIONS.destructive },
		handler: (args) => {
			const session = requireSession();
			const res = session.clearTrack(args.control as string);
			if (!res.ok) throw new Error(res.message);
			return { control: args.control, value: session.getState().values[args.control as string] };
		}
	};

	const setTimingTool: AgentTool = {
		name: 'effect_authoring_set_timing',
		title: 'Set effect timing',
		description:
			'Sets the total duration in milliseconds and/or whether the effect loops. One undo step.',
		inputSchema: object({
			duration: { type: 'number', minimum: 1, description: 'Total duration of the effect in milliseconds (must be positive).' },
			loop: { type: 'boolean', description: 'Whether playback loops back to the start when it reaches duration.' }
		}),
		annotations: { title: 'Set effect timing', ...ANNOTATIONS.writeIdempotent },
		handler: (args) => {
			const session = requireSession();
			if (args.duration === undefined && args.loop === undefined) {
				throw new Error('Provide at least one of duration or loop to change.');
			}
			const res = session.setTiming({
				duration: args.duration as number | undefined,
				loop: args.loop as boolean | undefined
			});
			if (!res.ok) throw new Error(res.message);
			const state = session.getState();
			return { duration: state.duration, loop: state.loop };
		}
	};

	const seekTool: AgentTool = {
		name: 'effect_authoring_seek',
		title: 'Seek effect playhead',
		description:
			'Moves the preview playhead to a specific time in milliseconds (clamped between 0 and duration). Returns the resolved control values at that time.',
		inputSchema: object(
			{
				time: { type: 'number', minimum: 0, description: 'Time in milliseconds to move the playhead to.' }
			},
			['time']
		),
		annotations: { title: 'Seek effect playhead', ...ANNOTATIONS.writeIdempotent },
		handler: (args) => {
			const session = requireSession();
			if (typeof args.time !== 'number' || !Number.isFinite(args.time) || args.time < 0) {
				throw new Error('time must be a finite non-negative number.');
			}
			session.seek(args.time);
			const state = session.getState();
			return { time: state.time, values: state.values };
		}
	};

	const undoTool: AgentTool = {
		name: 'effect_authoring_undo',
		title: 'Undo effect authoring edit',
		description: 'Undoes the most recent edit in the authoring session.',
		inputSchema: object({}),
		annotations: { title: 'Undo effect authoring edit', ...ANNOTATIONS.write },
		handler: () => {
			const session = requireSession();
			const changed = session.undo();
			const state = session.getState();
			return { changed, canUndo: state.canUndo, canRedo: state.canRedo };
		}
	};

	const redoTool: AgentTool = {
		name: 'effect_authoring_redo',
		title: 'Redo effect authoring edit',
		description: 'Redoes the most recently undone edit in the authoring session.',
		inputSchema: object({}),
		annotations: { title: 'Redo effect authoring edit', ...ANNOTATIONS.write },
		handler: () => {
			const session = requireSession();
			const changed = session.redo();
			const state = session.getState();
			return { changed, canUndo: state.canUndo, canRedo: state.canRedo };
		}
	};

	const viewTool: AgentTool = {
		name: 'effect_authoring_view',
		title: 'View effect preview image',
		description:
			'Captures an image of the effect preview at the current playhead time or at a specified time in milliseconds. Refused, with the reason, when the effect has no pixel preview (see previewError in effect_authoring_describe).',
		inputSchema: object({
			time: { type: 'number', minimum: 0, description: 'Optional time in milliseconds to view the preview at. Moves playhead to this time before capturing.' }
		}),
		annotations: { title: 'View effect preview image', ...ANNOTATIONS.read },
		handler: async (args) => {
			const session = requireSession();
			if (!host.capture) throw new Error('Capturing a preview image is not supported by this host.');
			const previewError = session.getState().previewError;
			if (previewError) {
				throw new Error(`${previewError} The other effect authoring tools still work; check values with effect_authoring_describe.`);
			}
			if (args.time !== undefined) {
				if (typeof args.time !== 'number' || !Number.isFinite(args.time) || args.time < 0) {
					throw new Error('time must be a finite non-negative number.');
				}
				session.seek(args.time as number);
			}
			const dataUrl = await host.capture();
			const comma = dataUrl.indexOf(',');
			const mimeMatch = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl);
			const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
			const data = comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
			return {
				content: [
					{ type: 'image', data, mimeType },
					{ type: 'text', text: `Captured effect preview at ${session.getState().time}ms.` }
				]
			};
		}
	};

	return {
		id,
		...(namespace !== undefined ? { namespace } : {}),
		title,
		description,
		skill,
		tools: () => {
			const session = host.session();
			const tools: AgentTool[] = [
				describeTool,
				getSourceTool,
				...(session?.setSource ? [setSourceTool] : []),
				setValuesTool,
				resetValuesTool,
				applyPresetTool,
				savePresetTool,
				setKeyframeTool,
				removeKeyframeTool,
				clearTrackTool,
				setTimingTool,
				seekTool,
				undoTool,
				redoTool,
				...(host.capture ? [viewTool] : [])
			];
			return tools;
		},
		...(host.subscribe ? { subscribe: host.subscribe } : {})
	};
}
