/**
 * Agent tools for shot layers and transitions in the animation editor (`MotionShot.layers` /
 * `transition`): list them, add, change, restack and remove layers, and set or clear the
 * transition into a shot. They ride on the animation effects tool provider
 * (`createAnimationEffectsToolProvider`), next to the other provider effects.
 */

import type { EffectToolContext } from '../effects/tools.js';
import { EFFECT_LAYER_ROLES, EFFECT_TRANSITION_MS, type EffectValue } from '../effects/types.js';
import type { JsonSchema } from '../tools/schema.js';
import type { AgentTool } from '../tools/registry.js';
import type { AnimationEditorController, MotionShotLayerChanges, MotionShotLayerInput, MotionShotLayerResult } from './controller.js';

const LAYER_USES = ['generator', 'filter', 'overlay', 'title'] as const;

const SHOT: JsonSchema = { type: 'string', minLength: 1, description: 'A shot id from get_animation.' };
const LAYER: JsonSchema = { type: 'string', minLength: 1, description: 'A layer id from list_shot_layers (e.g. "layer1").' };

const SUBJECT: JsonSchema = {
	anyOf: [
		{ type: 'object', properties: { image: { type: 'string', minLength: 1, description: 'A picture URL or data: URL.' } }, required: ['image'], additionalProperties: false, description: '{ "image": url }' },
		{ type: 'object', properties: { svg: { type: 'string', minLength: 1, description: 'SVG markup or an SVG URL.' } }, required: ['svg'], additionalProperties: false, description: '{ "svg": markup }' },
		{
			type: 'object',
			properties: { text: { type: 'string', minLength: 1, description: 'The words.' }, font: { type: 'string', description: 'A CSS font family (default system-ui).' }, weight: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'A CSS font weight (default 700).' } },
			required: ['text'],
			additionalProperties: false,
			description: '{ "text": words }'
		},
		{ type: 'object', properties: { slot: { type: 'string', minLength: 1, description: 'A slot name the host fills later.' } }, required: ['slot'], additionalProperties: false, description: '{ "slot": name }: draws nothing until filled.' }
	],
	description: 'What the layer shows, or feeds its effect (a filter changes it): a picture, SVG, words, or a slot to fill later. Leave out for a generator, overlay or title that draws its own picture.'
};

const RECT: JsonSchema = {
	type: 'object',
	properties: {
		x: { type: 'number', description: 'Left edge, artwork units.' },
		y: { type: 'number', description: 'Top edge, artwork units.' },
		width: { type: 'number', exclusiveMinimum: 0, description: 'Width, artwork units.' },
		height: { type: 'number', exclusiveMinimum: 0, description: 'Height, artwork units.' }
	},
	required: ['x', 'y', 'width', 'height'],
	additionalProperties: false,
	description: 'Where the layer sits on the artwork (it moves with the camera). Leave out to fill the screen.'
};

const TIME = (what: string, fallback: string): JsonSchema => ({
	anyOf: [
		{ type: 'number', minimum: 0, description: 'Ms after the shot starts.' },
		{ type: 'object', properties: { shots: { type: 'integer', minimum: 1, description: '1: when the next shot starts; 2: the one after…' } }, required: ['shots'], additionalProperties: false, description: '{ "shots": n }' }
	],
	description: `When the layer ${what}: ms after its shot starts, or { "shots": n } for when the n-th shot after its own starts (default ${fallback}).`
});

const fields = (ctx: EffectToolContext): Record<string, JsonSchema> => ({
	effect: { ...ctx.effectIdSchema(LAYER_USES), description: 'A generator, filter, overlay or title effect id from search_effects. Leave out for a bare subject.' },
	preset: { type: 'string', minLength: 1, description: "A preset of the effect by name, from describe_effect; its values are written out on the layer." },
	values: ctx.valuesSchema("Control values over the effect's defaults (and the preset's), from describe_effect"),
	subject: SUBJECT,
	role: { type: 'string', enum: [...EFFECT_LAYER_ROLES], description: 'background: under the artwork; subject: over the artwork; overlay: over everything. Default subject with a rect, else background.' },
	rect: RECT,
	from: TIME('starts', '0: as its shot starts'),
	until: TIME('stops', '{ "shots": 1 }: as the next shot starts'),
	opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0–1 (default 1).' },
	fade: { type: 'number', minimum: 0, maximum: 60000, description: 'Ms it fades in and out over (default 0: it cuts).' }
});

const result = (r: MotionShotLayerResult) => {
	if (!r.ok) throw new Error(r.error);
	const { ok: _ok, notes, ...rest } = r;
	return { ...rest, ...(notes.length ? { notes } : {}) };
};

/** The shot layer and transition tools (see the module comment). */
export function animationShotLayerTools(controller: AnimationEditorController, ctx: EffectToolContext): AgentTool[] {
	const f = fields(ctx);
	return [
		{
			name: 'list_shot_layers',
			title: 'List shot layers',
			description:
				'Lists the layers and transition of every shot, or of one: [{ shot, layers: [{ id, effect, name, subject, role, rect, from, until, opacity, fade, values, index (0 = bottom), start, end (ms when it shows) }], transition: { effect, ms, values, start, end } or null }]. Use the layer ids with update_shot_layer, move_shot_layer and remove_shot_layer. Works without a provider.',
			inputSchema: { type: 'object', properties: { shot: { ...SHOT, description: 'Only this shot (default every shot).' } }, additionalProperties: false },
			annotations: { title: 'List shot layers', ...ctx.annotations.read },
			handler: async (args) => ({ shots: controller.shotLayers(args.shot as string | undefined) })
		},
		{
			name: 'add_shot_layer',
			title: 'Add a shot layer',
			description:
				'Adds a layer to a shot: a provider effect (a generator such as a gradient background, a filter applied to a subject, an overlay or title) or a bare subject (a picture, SVG or words). It shows from its shot\'s start until the next shot starts unless from / until say otherwise, fills the screen unless given a rect, and goes on top unless given an index. Checked first: an effect that cannot be a layer (a transition, a camera move, a motion effect) is refused with the tool to use instead, as are a subject the effect cannot take, a filter without a subject, an unknown preset and values outside its controls. One undo step. Returns { shot, layer (with its id, start and end), layers (the shot\'s, bottom to top), transition, notes }. Check it with render_animation_frame.',
			inputSchema: {
				type: 'object',
				properties: { shot: SHOT, ...f, id: { type: 'string', pattern: '^[A-Za-z_][\\w.-]*$', description: 'The layer\'s id (default layer1, layer2…); unique in the scene.' }, index: { type: 'integer', minimum: 0, description: 'Its place in the shot, 0 = bottom (default the top).' } },
				required: ['shot'],
				additionalProperties: false
			},
			annotations: { title: 'Add a shot layer', ...ctx.annotations.write },
			handler: async ({ shot, index, ...layer }) => {
				if (layer.effect !== undefined) ctx.requireProvider();
				if (layer.effect === undefined && layer.subject === undefined) throw new Error('Give an "effect" (search_effects with use generator, filter, overlay or title), a "subject" (a picture, SVG or words), or both.');
				return result(await controller.addShotLayer(shot as string, layer as MotionShotLayerInput, { index: index as number | undefined }));
			}
		},
		{
			name: 'update_shot_layer',
			title: 'Change a shot layer',
			description:
				'Changes a layer\'s fields: give the ones to change, and list in "clear" the optional ones to remove (back to their defaults). A new effect starts from its own defaults unless values are given. Checked against the provider like add_shot_layer. One undo step. Returns { shot, layer, layers, transition }.',
			inputSchema: {
				type: 'object',
				properties: {
					layer: LAYER,
					...f,
					clear: { type: 'array', items: { type: 'string', enum: ['effect', 'preset', 'values', 'subject', 'role', 'rect', 'from', 'until', 'opacity', 'fade'] }, uniqueItems: true, description: 'Fields to remove.' }
				},
				required: ['layer'],
				additionalProperties: false
			},
			annotations: { title: 'Change a shot layer', ...ctx.annotations.writeIdempotent },
			handler: async ({ layer, clear, ...set }) => {
				const changes: Record<string, unknown> = { ...set };
				for (const k of (clear as string[] | undefined) ?? []) {
					if (k in set) throw new Error(`"${k}" is both given and cleared; do one or the other.`);
					changes[k] = null;
				}
				if (!Object.keys(changes).length) throw new Error('Give at least one field to change, or a field in "clear".');
				return result(await controller.updateShotLayer(layer as string, changes as MotionShotLayerChanges));
			}
		},
		{
			name: 'move_shot_layer',
			title: 'Restack a shot layer',
			description: "Moves a layer to another place in its shot's stack (0 = bottom; within a role, later layers draw over earlier ones). One undo step. Returns { shot, layer, layers }.",
			inputSchema: { type: 'object', properties: { layer: LAYER, index: { type: 'integer', minimum: 0, description: 'Its new place in the shot, 0 = bottom.' } }, required: ['layer', 'index'], additionalProperties: false },
			annotations: { title: 'Restack a shot layer', ...ctx.annotations.writeIdempotent },
			handler: async ({ layer, index }) => result(await controller.moveShotLayer(layer as string, index as number))
		},
		{
			name: 'remove_shot_layer',
			title: 'Remove a shot layer',
			description: "Removes a layer from its shot. Works without a provider. One undo step. Returns the shot's remaining layers.",
			inputSchema: { type: 'object', properties: { layer: LAYER }, required: ['layer'], additionalProperties: false },
			annotations: { title: 'Remove a shot layer', ...ctx.annotations.destructive },
			handler: async ({ layer }) => result(await controller.removeShotLayer(layer as string))
		},
		{
			name: 'set_shot_transition',
			title: "Set a shot's transition",
			description: `Sets the transition into a shot: a provider effect with the use transition (search_effects with use "transition") blends the last frame of the shot before into this shot over ms. Not on the first shot (there is no shot before it). With no camera move in (set_shot_camera_move, role transition), the camera cuts and the transition does the move; with one, both play together. Checked first: an effect that is not a transition, an unknown preset or values outside its controls are refused. One undo step. Returns { shot, layers, transition: { effect, ms, values, start, end }, notes }.`,
			inputSchema: {
				type: 'object',
				properties: {
					shot: { ...SHOT, description: 'A shot id from get_animation (not the first shot).' },
					effect: { ...ctx.effectIdSchema(['transition']), description: 'A transition effect id from search_effects (use transition).' },
					ms: { type: 'number', exclusiveMinimum: 0, maximum: 60000, description: `How long it takes, ms (default ${EFFECT_TRANSITION_MS}).` },
					preset: { type: 'string', minLength: 1, description: 'A preset of the transition by name, from describe_effect.' },
					values: ctx.valuesSchema("Control values over the transition's defaults (and the preset's)")
				},
				required: ['shot', 'effect'],
				additionalProperties: false
			},
			annotations: { title: "Set a shot's transition", ...ctx.annotations.writeIdempotent },
			handler: async ({ shot, effect, ms, preset, values }) => {
				ctx.requireProvider();
				return result(await controller.setShotTransition(shot as string, { effect: effect as string, ...(ms !== undefined ? { ms } : {}), ...(preset !== undefined ? { preset } : {}), ...(values !== undefined ? { values: values as Record<string, EffectValue> } : {}) }));
			}
		},
		{
			name: 'clear_shot_transition',
			title: "Clear a shot's transition",
			description: 'Removes the transition into a shot, so it cuts (or the camera eases) from the shot before. Works without a provider. One undo step. Returns { shot, layers, transition: null }.',
			inputSchema: { type: 'object', properties: { shot: SHOT }, required: ['shot'], additionalProperties: false },
			annotations: { title: "Clear a shot's transition", ...ctx.annotations.destructive },
			handler: async ({ shot }) => result(controller.clearShotTransition(shot as string))
		}
	];
}
