/**
 * Agent tools for provider camera moves on video clips (see `VideoClipCamera`): list the moves
 * by role, set one on a clip (baked into its transform keys) and clear it. They ride on the video
 * effects tool provider (`createVideoEffectsToolProvider`).
 */

import type { EffectToolContext } from '../effects/tools.js';
import { CAMERA_MOVE_MAX_MS } from '../effects/helpers.js';
import type { CameraMoveRole, CameraMoveSpec, EffectSummary, EffectValue } from '../effects/types.js';
import type { AgentTool } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { VideoCameraMoveResult, VideoEditorController } from './controller.js';
import type { VideoCameraFraming } from './types.js';

const ROLE = {
	type: 'string',
	enum: ['transition', 'hold'],
	description: 'transition: the move the camera makes into the clip from its start (a glide, whip pan, punch zoom, cut), from "from" to "framing". hold: the move it makes across the rest of the clip (a Ken Burns drift, a crash zoom), at "framing".'
} as const;

const FRAMING = (what: string): JsonSchema => ({
	anyOf: [
		{
			type: 'object',
			properties: {
				zoom: { type: 'number', exclusiveMinimum: 0, description: 'Zoom on the picture as placed (1 = the whole picture, 2 = half of it fills the frame). Default 1.' },
				x: { type: 'number', description: 'Point the camera centres on, pixels right of the frame\'s centre. Default 0.' },
				y: { type: 'number', description: 'Point the camera centres on, pixels below the frame\'s centre. Default 0.' }
			},
			additionalProperties: false
		},
		{ type: 'null' }
	],
	description: `${what} null removes it (the whole picture). Left out, the clip keeps the one it has.`
});

const summary = (e: EffectSummary) => ({ id: e.id, name: e.name, role: e.camera!.role, durationMs: e.camera!.durationMs, ...(e.camera!.cut !== undefined ? { cut: e.camera!.cut } : {}), ...(e.description ? { description: e.description } : {}) });

const done = (r: VideoCameraMoveResult) => {
	if (!r.ok) throw new Error(r.error);
	const { ok: _ok, ...rest } = r;
	return { ...rest, ...(rest.notes.length ? {} : { notes: undefined }) };
};

/** The video camera move tools (see the module comment). */
export function videoCameraMoveTools(controller: VideoEditorController, ctx: EffectToolContext): AgentTool[] {
	return [
		{
			name: 'list_video_camera_moves',
			title: 'List camera moves for clips',
			description:
				'Lists the effects provider\'s camera moves, for a role or both: { available, moves: [{ id, name, role, durationMs, cut (0–1 of the way through where the view jumps), description }] }. Give an id to set_clip_camera_move; describe_effect gives a move\'s controls and presets. Without a provider that has camera moves it returns available: false and the reason.',
			inputSchema: { type: 'object', properties: { role: ROLE }, additionalProperties: false },
			annotations: { title: 'List camera moves for clips', ...ctx.annotations.read },
			handler: async (args) => {
				const provider = controller.effectsProvider;
				if (!provider?.capabilities.supportsCamera || !provider.cameraView)
					return { available: false, reason: provider ? `${provider.name} has no camera moves (capabilities.supportsCamera is not set).` : 'No effects provider is registered, so there are no camera moves.', moves: [] };
				return { available: true, provider: provider.name, moves: (await controller.cameraMoves(args.role as CameraMoveRole | undefined)).map(summary) };
			}
		},
		{
			name: 'set_clip_camera_move',
			title: 'Set a clip\'s camera move',
			description:
				'Plays a camera move from list_video_camera_moves on a clip\'s picture, the clip being the shot: role transition moves from "from" to "framing" over "ms" from the clip\'s start; role hold plays across the rest of the clip at "framing". The clip\'s moves are baked into its x, y, scale and rotation keys, one per frame at the project\'s fps, and a move that cuts keeps two keys at the cut so nothing tweens across it. A clip whose transform is keyed by hand is refused (clear those keys first). The move is checked first: a wrong-role id, an unknown preset or values outside its controls are refused with the moves or presets that fit. One undo step. Returns { clip, camera, keys (per property), cuts (clip ms), windows ({ in, during }: when each move plays), notes (what a clip transform cannot show: tilt, turn, blur) }. After trimming the clip, set the move again to re-bake it.',
			inputSchema: {
				type: 'object',
				properties: {
					clip: { type: 'string', minLength: 1, description: 'A clip id with a picture, from get_video_project.' },
					role: ROLE,
					move: { type: 'string', minLength: 1, description: 'A camera move id of that role from list_video_camera_moves.' },
					ms: { type: 'number', minimum: 0, maximum: CAMERA_MOVE_MAX_MS, description: `How long a transition takes, ms (default the move's durationMs; at most the clip's length). Not for a hold, which plays across the rest of the clip.` },
					preset: { type: 'string', minLength: 1, description: 'A preset of the move by name, from describe_effect.' },
					values: ctx.valuesSchema("Control values over the move's defaults (and the preset's), from describe_effect"),
					from: FRAMING('Where a transition starts.'),
					framing: FRAMING('Where a transition arrives and a hold plays.')
				},
				required: ['clip', 'role', 'move'],
				additionalProperties: false
			},
			annotations: { title: 'Set a clip\'s camera move', ...ctx.annotations.writeIdempotent },
			handler: async (args) => {
				ctx.requireProvider();
				const spec: CameraMoveSpec = { move: args.move as string, ...(args.ms !== undefined ? { ms: args.ms } : {}), ...(args.preset !== undefined ? { preset: args.preset } : {}), ...(args.values !== undefined ? { values: args.values as Record<string, EffectValue> } : {}) };
				return done(await controller.setClipCameraMove(args.clip, args.role as CameraMoveRole, spec, { from: args.from as VideoCameraFraming | null | undefined, framing: args.framing as VideoCameraFraming | null | undefined }));
			}
		},
		{
			name: 'clear_clip_camera_move',
			title: 'Clear a clip\'s camera move',
			description:
				'Removes a clip\'s camera move for a role and re-bakes the other one (which needs the provider); with no move left the clip\'s transform goes back to what it was before the moves. One undo step. Returns { clip, camera (null when none is left), keys, cuts, windows }.',
			inputSchema: {
				type: 'object',
				properties: { clip: { type: 'string', minLength: 1, description: 'A clip id from get_video_project.' }, role: ROLE },
				required: ['clip', 'role'],
				additionalProperties: false
			},
			annotations: { title: 'Clear a clip\'s camera move', ...ctx.annotations.destructive },
			handler: async (args) => done(await controller.clearClipCameraMove(args.clip, args.role as CameraMoveRole))
		}
	];
}
