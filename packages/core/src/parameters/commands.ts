import type { CommandSpec } from '../commands/registry.js';
import type { ParametersController } from './controller.js';
import { getChoiceOptions, parameterFieldToJsonSchema, parameterLabel, parameterSchemaToJsonSchema, vectorSize } from './schema.js';
import type { ParameterField, ParameterValue } from './types.js';

export interface ParameterCommandOptions {
	/** Id prefix (default `parameters.`); use one per panel when several are registered. */
	prefix?: string;
	/** Palette group (default `Parameters`, or the schema's title). */
	group?: string;
	/** Command scope. Omit for global commands. */
	scope?: string;
}

/** A field as listed for agents: its JSON Schema plus current value and visibility. */
export interface ParameterListing {
	id: string;
	label: string;
	type: ParameterField['type'];
	description?: string;
	value: ParameterValue;
	default: ParameterValue;
	visible: boolean;
	keyframe?: 'none' | 'animated' | 'keyed';
	schema: Record<string, unknown>;
}

const fail = (message: string): never => {
	throw new Error(message);
};

const IDS = { type: 'array', items: { type: 'string' }, description: 'Parameter ids (default: all).' } as const;

/**
 * Palette and agent commands for a parameters panel: list, set (validated, one undo step),
 * reset, randomize, presets and keyframe toggles. Register them in a `CommandRegistry` and
 * agents get them through `createCommandToolProvider`. Failures throw sentences, which the
 * registry returns as `{ ok: false, code: 'failed', message }`.
 */
export function createParameterCommands(controller: ParametersController, options: ParameterCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'parameters.';
	const group = options.group ?? controller.getSchema().title ?? 'Parameters';
	const base = { group, ...(options.scope ? { scope: options.scope } : {}) };
	const presetNames = () => controller.getState().presets.map((p) => p.name);

	const set: CommandSpec = {
		...base,
		id: `${prefix}set`,
		label: 'Set Parameters…',
		keywords: ['change', 'value', 'control', 'slider'],
		description: 'Sets one or more parameter values as one undo step. Invalid values change nothing and return why.',
		// A getter so agents always see the current schema (it can change with `setSchema`).
		get params() {
			return {
				type: 'object' as const,
				properties: { values: { ...parameterSchemaToJsonSchema(controller.getSchema()), description: 'Parameter id → new value.' } },
				required: ['values']
			};
		},
		run: (_ctx: unknown, params: { values: Record<string, unknown> }) => {
			const result = controller.setValues(params.values);
			if (!result.ok) fail(result.message);
			return { changed: result.ok ? result.changed : [], values: controller.getValues() };
		}
	};

	const commands: CommandSpec[] = [
		{
			...base,
			id: `${prefix}list`,
			label: 'List Parameters',
			readOnly: true,
			keywords: ['controls', 'values', 'schema'],
			description: 'Lists every parameter with its type, constraints, current value and default.',
			run: (): { parameters: ParameterListing[]; presets: string[]; time: number } => {
				const state = controller.getState();
				return {
					parameters: state.fields.map((field) => ({
						id: field.id,
						label: parameterLabel(field),
						type: field.type,
						...(field.description ? { description: field.description } : {}),
						value: state.values[field.id],
						default: state.defaults[field.id],
						visible: state.visible[field.id] !== false,
						...(state.keyframesEnabled ? { keyframe: state.keys[field.id] } : {}),
						schema: {
							...parameterFieldToJsonSchema(field),
							...(field.type === 'choice' ? { options: getChoiceOptions(field) } : {}),
							...(field.type === 'vector' ? { size: vectorSize(field) } : {})
						}
					})),
					presets: presetNames(),
					time: state.time
				};
			}
		},
		set,
		{
			...base,
			id: `${prefix}reset`,
			label: 'Reset Parameters',
			keywords: ['default', 'revert', 'clear'],
			description: 'Puts parameters back to their defaults.',
			params: { type: 'object', properties: { ids: IDS } },
			enabled: (_ctx: unknown, params: { ids?: string[] } | undefined) => (params?.ids || controller.getState().modified ? true : 'Every parameter is already at its default.'),
			run: (_ctx: unknown, params: { ids?: string[] }) => {
				const result = controller.reset(params?.ids);
				if (!result.ok) fail(result.message);
				return { values: controller.getValues() };
			}
		},
		{
			...base,
			id: `${prefix}randomize`,
			label: 'Randomize Parameters',
			keywords: ['random', 'shuffle', 'surprise', 'explore'],
			description: 'Picks random values within each parameter range (visible fields only unless `ids` is given).',
			params: {
				type: 'object',
				properties: { ids: IDS, seed: { type: 'integer', description: 'Seed for a repeatable result.' } }
			},
			run: (_ctx: unknown, params: { ids?: string[]; seed?: number }) => {
				const result = controller.randomize({ ids: params?.ids, seed: params?.seed });
				if (!result.ok) fail(result.message);
				return { changed: result.ok ? result.changed : [], values: controller.getValues() };
			}
		},
		{
			...base,
			id: `${prefix}applyPreset`,
			label: 'Apply Parameter Preset…',
			keywords: ['preset', 'look', 'style'],
			description: 'Applies a preset; parameters it leaves out return to their defaults unless `merge` is true.',
			params: {
				type: 'object',
				properties: { name: { type: 'string', description: 'Preset name (see parameters list).' }, merge: { type: 'boolean' } },
				required: ['name']
			},
			enabled: () => (presetNames().length ? true : 'There are no presets.'),
			run: (_ctx: unknown, params: { name: string; merge?: boolean }) => {
				const result = controller.applyPreset(params.name, { merge: params.merge });
				if (!result.ok) fail(result.message);
				return { values: controller.getValues() };
			}
		},
		{
			...base,
			id: `${prefix}savePreset`,
			label: 'Save Parameter Preset…',
			keywords: ['preset', 'store', 'remember'],
			description: 'Saves the current values as a preset (replacing a user preset with the same name).',
			params: {
				type: 'object',
				properties: { name: { type: 'string', minLength: 1 }, description: { type: 'string' } },
				required: ['name']
			},
			run: (_ctx: unknown, params: { name: string; description?: string }) => {
				const result = controller.savePreset(params.name, { description: params.description });
				if (!result.ok) fail(result.message);
				return { presets: presetNames() };
			}
		},
		{
			...base,
			id: `${prefix}deletePreset`,
			label: 'Delete Parameter Preset…',
			keywords: ['preset', 'remove'],
			params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
			enabled: () => (controller.getState().presets.some((p) => !p.builtIn) ? true : 'There are no saved presets.'),
			run: (_ctx: unknown, params: { name: string }) => {
				const result = controller.deletePreset(params.name);
				if (!result.ok) fail(result.message);
				return { presets: presetNames() };
			}
		},
		{
			...base,
			id: `${prefix}toggleKeyframe`,
			label: 'Toggle Parameter Keyframe…',
			keywords: ['key', 'animate', 'diamond'],
			description: 'Adds a keyframe with the current value at `time` (default: the playhead), or removes the one there.',
			params: {
				type: 'object',
				properties: { id: { type: 'string', description: 'Parameter id.' }, time: { type: 'number', minimum: 0, description: 'Time in ms.' } },
				required: ['id']
			},
			enabled: () => (controller.getState().keyframesEnabled ? true : 'Keyframes are not available here.'),
			run: (_ctx: unknown, params: { id: string; time?: number }) => {
				const result = controller.toggleKeyframe(params.id, params.time);
				if (!result.ok) fail(result.message);
				return { keyed: result.ok && result.keyed, time: params.time ?? controller.getState().time };
			}
		},
		{
			...base,
			id: `${prefix}undo`,
			label: 'Undo Parameter Change',
			hidden: true,
			enabled: () => (controller.getState().canUndo ? true : 'Nothing to undo.'),
			run: () => controller.undo()
		},
		{
			...base,
			id: `${prefix}redo`,
			label: 'Redo Parameter Change',
			hidden: true,
			enabled: () => (controller.getState().canRedo ? true : 'Nothing to redo.'),
			run: () => controller.redo()
		}
	];
	return commands;
}
