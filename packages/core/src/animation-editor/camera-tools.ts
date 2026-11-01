/**
 * Agent tools for provider camera moves in the animation editor (`MotionCamera.in` / `during`):
 * list the moves by role, set one on a shot and clear it. They ride on the animation effects
 * tool provider (`createAnimationEffectsToolProvider`), next to the other provider effects.
 */

import type { EffectToolContext } from '../effects/tools.js';
import { CAMERA_MOVE_MAX_MS } from '../effects/helpers.js';
import type { CameraMoveRole, CameraMoveSpec, EffectSummary, EffectValue } from '../effects/types.js';
import type { AgentTool } from '../tools/registry.js';
import { effectsPlayCamera } from './camera.js';
import type { AnimationEditorController, MotionCameraMoveResult } from './controller.js';

const ROLE = {
	type: 'string',
	enum: ['transition', 'hold'],
	description: 'transition: the move the camera gets into the shot with (its camera "in": a glide, whip pan, punch zoom, cut). hold: the move it makes while the shot holds (its camera "during": a Ken Burns drift, a crash zoom), played across the shot\'s hold.'
} as const;

const summary = (e: EffectSummary) => ({ id: e.id, name: e.name, role: e.camera!.role, durationMs: e.camera!.durationMs, ...(e.camera!.cut !== undefined ? { cut: e.camera!.cut } : {}), ...(e.description ? { description: e.description } : {}), ...(e.tags?.length ? { tags: e.tags } : {}) });

const done = (r: MotionCameraMoveResult) => {
	if (!r.ok) throw new Error(r.error);
	return { shot: r.shot, camera: r.camera, ...(r.window ? { window: r.window } : {}), ...(r.notes.length ? { notes: r.notes } : {}) };
};

/** The camera move tools (see the module comment). */
export function animationCameraMoveTools(controller: AnimationEditorController, ctx: EffectToolContext): AgentTool[] {
	return [
		{
			name: 'list_camera_moves',
			title: 'List camera moves',
			description:
				'Lists the effects provider\'s camera moves, for a role or both: { available, moves: [{ id, name, role, durationMs, cut (0–1 of the way through where the view jumps, for moves that cut), description, tags }] }. Use the ids with set_shot_camera_move (role transition for how the camera gets into a shot, hold for how it moves while the shot holds) and describe_effect for a move\'s controls and presets. Without a provider that has camera moves it returns available: false and the reason; the camera then eases between framings.',
			inputSchema: { type: 'object', properties: { role: ROLE }, additionalProperties: false },
			annotations: { title: 'List camera moves', ...ctx.annotations.read },
			handler: async (args) => {
				const provider = controller.effectsProvider;
				if (!effectsPlayCamera(provider)) return { available: false, reason: provider ? `${provider.name} has no camera moves (capabilities.supportsCamera is not set), so shots ease between framings.` : 'No effects provider is registered, so there are no camera moves; shots ease between framings.', moves: [] };
				return { available: true, provider: provider.name, moves: (await controller.cameraMoves(args.role as CameraMoveRole | undefined)).map(summary) };
			}
		},
		{
			name: 'set_shot_camera_move',
			title: 'Set a shot\'s camera move',
			description:
				'Sets the camera move a shot gets in with (role transition, its camera "in") or makes while it holds (role hold, its camera "during"), from list_camera_moves. The move is checked first: an id of the wrong role, an unknown preset or values outside its controls are refused with the moves or presets that fit. A shot with no camera gets one that keeps the framing; set the framing itself with update_shot. One undo step. Returns { shot, camera (the shot\'s camera now), window: { start, end } (ms when the move plays), notes }. The first shot cuts to its framing, so its transition does not play. A hold move plays across the shot\'s hold: lengthen it with update_shot (hold) for a slower move.',
			inputSchema: {
				type: 'object',
				properties: {
					shot: { type: 'string', minLength: 1, description: 'A shot id from get_animation.' },
					role: ROLE,
					move: { type: 'string', minLength: 1, description: 'A camera move id of that role from list_camera_moves.' },
					ms: { type: 'number', minimum: 0, maximum: CAMERA_MOVE_MAX_MS, description: `How long a transition takes, ms (0–${CAMERA_MOVE_MAX_MS}; default the move's durationMs). Not for a hold, which plays across the shot's hold.` },
					preset: { type: 'string', minLength: 1, description: 'A preset of the move by name, from describe_effect; its values are written out on the shot.' },
					values: ctx.valuesSchema("Control values over the move's defaults (and the preset's), from describe_effect")
				},
				required: ['shot', 'role', 'move'],
				additionalProperties: false
			},
			annotations: { title: 'Set a shot\'s camera move', ...ctx.annotations.writeIdempotent },
			handler: async (args) => {
				ctx.requireProvider();
				const spec: CameraMoveSpec = { move: args.move as string, ...(args.ms !== undefined ? { ms: args.ms } : {}), ...(args.preset !== undefined ? { preset: args.preset } : {}), ...(args.values !== undefined ? { values: args.values as Record<string, EffectValue> } : {}) };
				return done(await controller.setShotCameraMove(args.shot, args.role as CameraMoveRole, spec));
			}
		},
		{
			name: 'clear_shot_camera_move',
			title: 'Clear a shot\'s camera move',
			description:
				'Removes a shot\'s camera move for a role (transition: its camera "in"; hold: its camera "during"), keeping its framing; the camera then eases into the shot, or stays still while it holds. Works without a provider. One undo step. Returns { shot, camera (null when the shot has none left), notes }.',
			inputSchema: {
				type: 'object',
				properties: { shot: { type: 'string', minLength: 1, description: 'A shot id from get_animation.' }, role: ROLE },
				required: ['shot', 'role'],
				additionalProperties: false
			},
			annotations: { title: 'Clear a shot\'s camera move', ...ctx.annotations.destructive },
			handler: async (args) => done(controller.clearShotCameraMove(args.shot, args.role as CameraMoveRole))
		}
	];
}
