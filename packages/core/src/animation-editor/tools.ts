import { ANIMATION_EASING_PRESETS } from '../animation/easing.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { parseVectorSvg } from '../vector/svg.js';
import type { VectorNode } from '../vector/types.js';
import { compileMotionScene, indexMotionNodes } from './compile.js';
import { fromFlairSvgMotion, fromFlairVectorEffect, type FlairImportResult } from './flair-import.js';
import type { AnimationEditorController } from './controller.js';
import { MOTION_EDIT_OPS, type MotionEdit, type MotionEditResult } from './edit.js';
import { motionIssueLine, type MotionIssue } from './issues.js';
import { MOTION_COMMAND_TYPES, MOTION_DIRECTIONS, MOTION_ENTER_STYLES, MOTION_EXIT_STYLES, MOTION_IRIS_SHAPES, MOTION_REPEAT_MODES, MOTION_BLENDS, MOTION_SPLIT_ORIENTATIONS, motionFlairPrimitive, type MotionScene } from './types.js';

export interface AnimationEditorToolProviderOptions {
	/** Provider id (unique per registry). Default `animation`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/** The animation cannot be edited: write tools are hidden and `get_animation` says why. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Turns SVG into PNG (e.g. `rasterizeSvg`), so `render_animation_frame` can return an image. */
	rasterize?: (svg: string, size: { width: number; height: number }) => Promise<{ data: string; mimeType: string }> | { data: string; mimeType: string };
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const object = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema & { type: 'object' } => ({
	type: 'object' as const,
	...(description ? { description } : {}),
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

const SHOT_ID = { type: 'string', minLength: 1, description: 'A shot id from get_animation (e.g. "intro").' } as const;
const NODE_IDS = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Node ids from get_animation\'s "elements" (a group animates as one).' } as const;
const MS = (what: string) => ({ type: 'number', minimum: 0, description: `${what} in milliseconds.` }) as const;
const FRACTION = (what: string) => ({ type: 'number', minimum: 0, maximum: 1, description: what }) as const;
const POINT = (what: string) => object({ x: { type: 'number', description: 'Document units.' }, y: { type: 'number', description: 'Document units.' } }, ['x', 'y'], what);
const EASE: JsonSchema = {
	description: `Easing: a preset (${ANIMATION_EASING_PRESETS.join(', ')}), { "type": "cubic-bezier", "x1", "y1", "x2", "y2" }, { "type": "spring", … } or { "type": "elastic", … }. The spring presets are Figma's: gentle, quick, bouncy, slow. A command with a spring and no "duration" lasts until the spring settles. Default: a cubic ease-out for entrances, cubic ease-in-out for moves.`,
	anyOf: [
		{ type: 'string', enum: [...ANIMATION_EASING_PRESETS] },
		object({ type: { const: 'cubic-bezier', description: 'Curve kind.' }, x1: { type: 'number', description: 'Out handle x (0–1).' }, y1: { type: 'number', description: 'Out handle y.' }, x2: { type: 'number', description: 'In handle x (0–1).' }, y2: { type: 'number', description: 'In handle y.' } }, ['type', 'x1', 'y1', 'x2', 'y2']),
		object(
			{
				type: { const: 'spring', description: 'A damped spring (may overshoot).' },
				stiffness: { type: 'number', exclusiveMinimum: 0, description: 'Stiffness (default 170; quick 300, bouncy 600).' },
				damping: { type: 'number', minimum: 0, description: 'Damping (default 26; lower bounces more).' },
				mass: { type: 'number', exclusiveMinimum: 0, description: 'Mass (default 1).' },
				velocity: { type: 'number', description: 'Starting speed, in changes per second (default 0).' }
			},
			['type']
		),
		object(
			{
				type: { const: 'elastic', description: 'A decaying wobble.' },
				amplitude: { type: 'number', minimum: 0, description: 'Overshoot factor (default 1).' },
				period: { type: 'number', exclusiveMinimum: 0, description: 'Wobble period as a fraction of the length (default 0.3).' },
				mode: { type: 'string', enum: ['out', 'in', 'in-out'], description: 'Where it wobbles (default out).' }
			},
			['type']
		)
	]
};

const BASE: Record<string, JsonSchema> = {
	targets: NODE_IDS,
	duration: MS('Length for each target (each type has a default; draw follows the path length)'),
	delay: MS('Wait before starting (default 0)'),
	stagger: MS('Start each further target this much later (default 0)'),
	with: { type: 'string', enum: ['after', 'previous'], description: '"after" (default) starts when the commands before it finish; "previous" starts together with the command before.' },
	ease: EASE,
	note: { type: 'string', description: 'Why this command is here, in a few words.' },
	repeat: { type: 'integer', minimum: 1, maximum: 1000, description: 'Play it this many times (default 1); "duration" is one cycle. Not for enter or exit.' },
	repeatMode: { type: 'string', enum: [...MOTION_REPEAT_MODES], description: 'loop (default) restarts each cycle, mirror plays every other one backwards, offset carries on from where the last ended (rotate by 90 with repeat 4 makes a full turn).' },
	steps: { type: 'number', exclusiveMinimum: 0, maximum: 120, description: 'Stepped time: hold on a grid of this many frames per second (12 = "on twos"). Default: the scene\'s steps, else smooth.' }
};
const BLEND = (fallback: 'replace' | 'add'): JsonSchema => ({
	type: 'string',
	enum: [...MOTION_BLENDS],
	description: `"add" makes it a layer over the pose that stacks with other changes (a shake on a slide); "replace" makes it a change the next one takes over from (default ${fallback}).`
});
const command = (type: string, description: string, extra: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema =>
	object({ type: { const: type, description }, ...BASE, ...extra }, ['type', 'targets', ...required], description);

/** JSON Schema of one command (each type its own strict branch). */
export const MOTION_COMMAND_SCHEMA: JsonSchema = {
	description: `A command (one of ${MOTION_COMMAND_TYPES.join(', ')}). Commands in a shot play one after another unless "with": "previous".`,
	oneOf: [
		command('enter', 'Brings hidden targets in; they are hidden before this shot.', {
			style: {
				type: 'string',
				enum: [...MOTION_ENTER_STYLES],
				description:
					'fade (default), pop (scales up past full size and settles), grow (from nothing), slide, draw (outline drawn on, then the fill fades in), zoom (settles from larger), rise (rises a short way, overshooting a touch), or a reveal through a clip over the target\'s box: wipe (behind a travelling edge), iris (from the centre outwards) or split (from a line through the middle). Reveals need a box with a width and a height (not a lone straight line).'
			},
			direction: { type: 'string', enum: [...MOTION_DIRECTIONS], description: 'For slide: direction of travel (default up). For wipe: the way the edge travels (default right, revealing from the left).' },
			distance: { type: 'number', description: 'For slide (default 40) and rise (default 20): document units.' },
			scale: { type: 'number', minimum: 0, description: 'For pop (default 0.5) and zoom (default 1.6): the starting scale (1 = rest size).' },
			shape: { type: 'string', enum: [...MOTION_IRIS_SHAPES], description: 'For iris: open through a circle (default; an ellipse on a box that is not square) or a box.' },
			orientation: { type: 'string', enum: [...MOTION_SPLIT_ORIENTATIONS], description: 'For split: horizontal (default) opens up and down from a horizontal line through the middle; vertical opens left and right.' }
		}),
		command('exit', 'Takes targets out.', {
			style: { type: 'string', enum: [...MOTION_EXIT_STYLES], description: 'fade (default), shrink, slide, undraw, or wipe (hides behind a travelling edge through a clip over the target\'s box: a wipe in, reversed).' },
			direction: { type: 'string', enum: [...MOTION_DIRECTIONS], description: 'For slide: direction of travel (default down). For wipe: the way the edge travels (default right, hiding from the left).' },
			distance: { type: 'number', description: 'For slide: document units (default 40).' }
		}),
		command('draw', 'Draws strokes on (or off) to a fraction of their length.', { to: FRACTION('Fraction drawn at the end (default 1).'), from: FRACTION('Fraction drawn at the start (default: what is drawn now).') }),
		command('move', 'Moves targets by an offset or so their centre lands on a point.', { blend: BLEND('replace'), by: POINT('Offset in document units.'), to: POINT('Point (document coordinates) for the centre.') }),
		command('rotate', 'Turns targets about their centre (degrees, clockwise).', { blend: BLEND('replace'), by: { type: 'number', description: 'Degrees to turn by.' }, to: { type: 'number', description: 'Angle to turn to, in degrees from rest.' } }),
		command('scale', 'Scales targets about their centre (1 = rest size).', { blend: BLEND('replace'), to: { description: 'A factor, or { x, y } factors.', anyOf: [{ type: 'number' }, POINT('Factors per axis.')] }, geometric: { type: 'boolean', description: 'Grow by a steady factor, which reads as an even zoom (default false).' } }, ['to']),
		command('fade', 'Changes opacity.', { to: FRACTION('Opacity at the end (0–1).') }, ['to']),
		command('style', 'Blends solid fill / stroke colours (in OKLab) and stroke width. On a group it changes every path in it.', {
			fill: { type: 'string', description: 'CSS colour (hex, rgb(), rgba()).' },
			stroke: { type: 'string', description: 'CSS colour (hex, rgb(), rgba()).' },
			strokeWidth: { type: 'number', minimum: 0, description: 'Document units.' }
		}),
		command('match', 'Smart Animate: tweens a group into another group (usually hidden), part by part. Parts pair by name, then by id with the group ids taken out (card-a-title ↔ card-b-title), then by kind in order; each takes its partner\'s shape, paint and place. Unpaired parts fade out; parts of "into" with no partner do not appear (check_animation lists them).', { into: { type: 'string', minLength: 1, description: 'Id of the group to become.' } }, ['into']),
		command('morph', 'Morphs each target into the shape (and paint) of another node, which usually stays hidden.', { into: { type: 'string', minLength: 1, description: 'Id of the node whose shape to take.' } }, ['into']),
		command('follow', 'Moves targets along a path node, centre on the path.', {
			path: { type: 'string', minLength: 1, description: 'Id of a path node (it can be hidden).' },
			rotate: { type: 'boolean', description: 'Turn with the path (default false); moves and shakes made meanwhile turn with it too.' },
			from: FRACTION('Where to start along the path (default 0).'),
			to: FRACTION('Where to end along the path (default 1).')
		}, ['path']),
		command('pulse', 'Scales up and back to draw the eye.', { blend: BLEND('add'), amount: { type: 'number', description: 'Extra scale at the peak (default 0.15).' }, count: { type: 'integer', minimum: 1, description: 'Pulses (default 1).' } }),
		command('shake', 'Shakes side to side (or up and down), settling.', { blend: BLEND('add'),
			amount: { type: 'number', description: 'Document units (default 8).' },
			count: { type: 'integer', minimum: 1, description: 'Shakes (default 3).' },
			axis: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Default horizontal.' }
		}),
		command('teeter', 'Rocks about the centre either way, settling.', { blend: BLEND('add'), angle: { type: 'number', description: 'Degrees either way (default 8).' }, count: { type: 'integer', minimum: 1, description: 'Rocks (default 3).' } }),
		command('wave', 'Bobs up and down without settling, like something floating (default 1000 ms).', { blend: BLEND('add'), amount: { type: 'number', description: 'Height in document units (default 6).' }, count: { type: 'integer', minimum: 1, description: 'Bobs (default 2).' } }),
		command('wiggle', 'Wanders about its place as smooth seeded noise, easing out of and back to rest (default 1500 ms). The same seed always wanders the same way.', { blend: BLEND('add'),
			amount: { type: 'number', description: 'Up to about this far, in document units (default 6).' },
			frequency: { type: 'number', exclusiveMinimum: 0, description: 'Wanders per second, in Hz (default 3).' },
			octaves: { type: 'integer', minimum: 1, maximum: 8, description: 'Layers of finer detail (default 2).' },
			rotate: { type: 'number', description: 'Also turns about the centre by up to about this many degrees (default 0).' },
			seed: { type: 'integer', minimum: 0, description: 'Default: one picked from the target id, so each target wanders its own way.' }
		}),
		command('color-pulse', 'Tints solid paint toward a colour and back (mixed in OKLab). On a group it tints every path in it.', {
			color: { type: 'string', description: 'The tint, a CSS colour (default "#f59e0b").' },
			paint: { type: 'string', enum: ['fill', 'stroke'], description: 'Which paint (default fill).' },
			count: { type: 'integer', minimum: 1, description: 'Pulses (default 1).' }
		}),
		command('effect', 'Tweens a numeric parameter of a live path effect on the targets (twist angle, wiggle time, zig zag size, trim offset…).', {
			effect: { type: 'string', minLength: 1, description: 'Effect id from get_animation\'s element "effects".' },
			param: { type: 'string', minLength: 1, description: 'A numeric parameter of that effect (listed with it).' },
			to: { type: 'number', description: 'Value at the end.' }
		}, ['effect', 'param', 'to']),
		object(
			{ type: { const: 'wait', description: 'Waits.' }, duration: MS('How long'), with: BASE.with, note: BASE.note },
			['type', 'duration'],
			'Waits before the next command.'
		)
	]
};

const GEOMETRIC_CAMERA: JsonSchema = { type: 'boolean', description: 'Zoom at a steady rate, so a big zoom does not rush at the start (default false).' };
const CAMERA: JsonSchema = {
	description: 'Where the camera looks: a rectangle { x, y, width, height } in document units, or { frame: "<node id>", padding } to frame a node (fitted to the artwork\'s shape). It eases there over "ms" (default 1000); the first shot cuts.',
	anyOf: [
		object({ x: { type: 'number', description: 'Left.' }, y: { type: 'number', description: 'Top.' }, width: { type: 'number', exclusiveMinimum: 0, description: 'Width.' }, height: { type: 'number', exclusiveMinimum: 0, description: 'Height.' }, ease: EASE, ms: MS('Camera move length'), geometric: GEOMETRIC_CAMERA }, ['x', 'y', 'width', 'height']),
		object({ frame: { type: 'string', minLength: 1, description: 'Node id to frame.' }, padding: { type: 'number', description: 'Margin around it (default 24).' }, ease: EASE, ms: MS('Camera move length'), geometric: GEOMETRIC_CAMERA }, ['frame'])
	]
};

const SHOT_FIELDS: Record<string, JsonSchema> = {
	label: { type: 'string', description: 'What happens, in a few words.' },
	camera: CAMERA,
	run: { type: 'array', items: MOTION_COMMAND_SCHEMA, description: 'Commands, in order.' },
	hold: MS('Hold after the commands (default 600)')
};
const SHOT: JsonSchema = object({ id: { type: 'string', pattern: '^[A-Za-z0-9_][\\w.-]*$', description: 'Unique shot id, e.g. "intro".' }, ...SHOT_FIELDS }, ['id', 'run'], 'A shot.');
const CONTROL: JsonSchema = object(
	{
		name: { type: 'string', pattern: '^[A-Za-z_]\\w*$', description: 'Identifier, e.g. "accent".' },
		type: { const: 'color', description: 'Controls are colours.' },
		default: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'A #rrggbb colour the scene uses; the control stands for every use of it.' },
		label: { type: 'string', description: 'Label in a controls panel.' }
	},
	['name', 'type', 'default'],
	'A colour parameter of the Flair effect made from the scene.'
);
const PRESET: JsonSchema = object({ name: { type: 'string', minLength: 1, description: 'Preset name.' }, values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Control name → colour.' } }, ['name', 'values'], 'Named control values.');

const SETTINGS: Record<string, JsonSchema> = {
	name: { type: 'string', minLength: 1, description: 'Short name, e.g. "logo-reveal".' },
	description: { type: ['string', 'null'], description: 'What it shows; null clears.' },
	loop: { type: 'string', enum: ['none', 'loop', 'ping-pong'], description: 'Playback past the end (default none).' },
	fps: { type: 'number', minimum: 1, maximum: 120, description: 'Sampling rate for exports (default 30).' },
	steps: { anyOf: [{ type: 'number', exclusiveMinimum: 0, maximum: 120 }, { type: 'null' }], description: 'Stepped time for every command without its own: changes hold on a grid of this many frames per second (12 = "on twos" at 24 fps) for a hand-drawn look; null makes it smooth again (default).' },
	target: { anyOf: [{ type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 }, { type: 'null' }], description: 'Wanted length [min, max] in seconds; null clears.' }
};

/** JSON Schema of one `edit_animation` op. */
const EDIT_OP: JsonSchema = {
	description: `One edit (${MOTION_EDIT_OPS.filter((o) => o !== 'replace_scene' && o !== 'set_artwork').join(', ')}), shaped like the tool of the same name with an "op" field.`,
	oneOf: [
		object({ op: { const: 'set_settings', description: 'Like set_animation_settings.' }, ...SETTINGS }, ['op']),
		object({ op: { const: 'insert_shots', description: 'Like insert_shots.' }, shots: { type: 'array', items: SHOT, minItems: 1, description: 'Shots to add.' }, at: { type: 'integer', minimum: 0, description: 'Position (default: the end).' } }, ['op', 'shots']),
		object({ op: { const: 'update_shot', description: 'Like update_shot.' }, shot: SHOT_ID, set: object({ id: SHOT.properties!.id, ...SHOT_FIELDS }, [], 'Fields to replace.'), remove: { type: 'array', items: { type: 'string', enum: ['label', 'camera', 'hold'] }, description: 'Fields to clear.' } }, ['op', 'shot']),
		object({ op: { const: 'delete_shots', description: 'Like delete_shots.' }, shots: { type: 'array', items: SHOT_ID, minItems: 1, description: 'Shot ids.' } }, ['op', 'shots']),
		object({ op: { const: 'move_shot', description: 'Like move_shot.' }, shot: SHOT_ID, to: { type: 'integer', minimum: 0, description: 'New position (0 = first).' } }, ['op', 'shot', 'to']),
		object({ op: { const: 'add_commands', description: 'Like add_commands.' }, shot: SHOT_ID, commands: { type: 'array', items: MOTION_COMMAND_SCHEMA, minItems: 1, description: 'Commands to add.' }, at: { type: 'integer', minimum: 0, description: 'Index in the shot\'s run (default: the end).' } }, ['op', 'shot', 'commands']),
		object({ op: { const: 'update_command', description: 'Like update_command.' }, shot: SHOT_ID, command: { type: 'integer', minimum: 0, description: 'Index in the shot\'s run.' }, set: { type: 'object', description: 'Command fields to replace.' }, remove: { type: 'array', items: { type: 'string' }, description: 'Command fields to clear.' } }, ['op', 'shot', 'command']),
		object({ op: { const: 'delete_commands', description: 'Like delete_commands.' }, shot: SHOT_ID, commands: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, description: 'Indexes in the shot\'s run.' } }, ['op', 'shot', 'commands']),
		object({ op: { const: 'set_controls', description: 'Like set_controls.' }, controls: { type: 'array', items: CONTROL, description: 'Controls (empty clears).' }, presets: { type: 'array', items: PRESET, description: 'Presets (empty clears).' } }, ['op', 'controls'])
	]
};

function describeElement(node: VectorNode, ancestors: string[]) {
	const effects = (node.effects ?? []).map((e) => ({
		id: e.id,
		type: e.type,
		numericParams: Object.fromEntries(Object.entries(e.params as unknown as Record<string, unknown>).filter(([, v]) => typeof v === 'number'))
	}));
	return {
		id: node.id,
		type: node.type,
		...(node.name ? { name: node.name } : {}),
		...(ancestors.length ? { parent: ancestors[ancestors.length - 1] } : {}),
		...(node.visible === false ? { hidden: true } : {}),
		...(node.type === 'path' && typeof node.fill === 'string' ? { fill: node.fill } : {}),
		...(node.type === 'path' && typeof node.stroke === 'string' ? { stroke: node.stroke } : {}),
		...(node.type === 'group' ? { children: node.children.map((c) => c.id) } : {}),
		...(effects.length ? { effects } : {})
	};
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The elements of a scene's artwork, as agents see them. */
export function describeMotionElements(scene: MotionScene) {
	return [...indexMotionNodes(scene.artwork.nodes).values()].map((e) => ({
		...describeElement(e.node, e.ancestors),
		...(e.bounds ? { bounds: { x: round(e.bounds.x), y: round(e.bounds.y), width: round(e.bounds.width), height: round(e.bounds.height) } } : {})
	}));
}

/** A scene's shots with their timing, as agents see them. */
export function describeMotionShots(scene: MotionScene) {
	const timeline = compileMotionScene(scene);
	return scene.shots.map((shot, i) => {
		const t = timeline.shots[i];
		return {
			id: shot.id,
			...(shot.label ? { label: shot.label } : {}),
			start: t.start,
			end: t.end,
			...(shot.camera ? { camera: shot.camera } : {}),
			...(shot.hold !== undefined ? { hold: shot.hold } : {}),
			commands: shot.run.map((c, index) => {
				const ct = timeline.commands.find((x) => x.shotIndex === i && x.command === index)!;
				const primitive = motionFlairPrimitive(c);
				return { index, ...c, start: ct.start, end: ct.end, ...(primitive ? { flairPrimitive: primitive } : {}) };
			})
		};
	});
}

const issueSummary = (issues: readonly MotionIssue[]) => ({
	errors: issues.filter((i) => i.severity === 'error').length,
	warnings: issues.filter((i) => i.severity === 'warning').length,
	notes: issues.filter((i) => i.severity === 'note').length,
	lines: issues.map((i) => `${i.severity}: ${motionIssueLine(i)}`)
});

/**
 * Agent tools for an `AnimationEditorController`: read the scene (artwork elements, shots with
 * their timing, issues), render a frame, export to Flair, and change it a step at a time. Every
 * write is checked first (unknown ids with "did you mean", malformed commands), applies as one
 * undo step, and returns the resulting timing and any new issues. Write tools are hidden while
 * the animation is read-only.
 */
export function createAnimationEditorToolProvider(controller: AnimationEditorController, options: AnimationEditorToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'This animation is read-only.';
		return controller.readOnlyReason();
	};
	const scene = () => controller.getScene();
	const outcome = (result: MotionEditResult, extra: Record<string, unknown> = {}) => {
		if (!result.ok) throw new Error(result.error);
		const timeline = compileMotionScene(result.scene);
		return {
			...extra,
			duration: timeline.duration,
			shots: timeline.shots.map((s) => ({ id: s.id, start: s.start, end: s.end })),
			issues: issueSummary(result.issues),
			...(result.hints.length ? { hints: result.hints } : {})
		};
	};
	const apply = (edits: MotionEdit | MotionEdit[], label: string, extra?: (s: MotionScene) => Record<string, unknown>) => {
		const result = controller.apply(edits, label);
		return outcome(result, result.ok && extra ? extra(result.scene) : {});
	};

	const getAnimation: AgentTool = {
		name: 'get_animation',
		title: 'Read the animation',
		description:
			'Returns the vector animation: its name, artwork size, length (ms), loop mode, the artwork\'s elements (id, type, name, parent, bounds, solid paints, live effects with their numeric parameters), every shot with its commands and their start/end times (and, where Flair has one, the Flair motion primitive a command plays as "flairPrimitive", e.g. "entrance.pop"), Flair controls, and a summary of issues. Use the ids it returns with the write tools.',
		inputSchema: object({ includeElements: { type: 'boolean', description: 'Include the artwork\'s elements (default true).' } }),
		annotations: { title: 'Read the animation', ...READ },
		handler: ({ includeElements = true }) => {
			const s = scene();
			const reason = readOnlyReason();
			return {
				name: s.name,
				...(s.description ? { description: s.description } : {}),
				artwork: { width: s.artwork.width, height: s.artwork.height },
				duration: compileMotionScene(s).duration,
				loop: s.loop ?? 'none',
				...(s.target ? { target: s.target } : {}),
				...(includeElements ? { elements: describeMotionElements(s) } : {}),
				shots: describeMotionShots(s),
				...(s.controls ? { controls: s.controls } : {}),
				...(s.presets ? { presets: s.presets } : {}),
				issues: issueSummary(controller.getState().issues),
				...(reason ? { readOnly: reason } : {})
			};
		}
	};

	const getShot: AgentTool = {
		name: 'get_shot',
		title: 'Read one shot',
		description: 'Returns one shot as stored (id, label, camera, run, hold) with its start/end and each command\'s start/end in ms.',
		inputSchema: object({ shot: SHOT_ID }, ['shot']),
		annotations: { title: 'Read one shot', ...READ },
		handler: ({ shot }) => {
			const found = describeMotionShots(scene()).find((s) => s.id === shot);
			if (!found) throw new Error(`There is no shot "${shot}"; the shots are ${scene().shots.map((s) => `"${s.id}"`).join(', ') || 'none yet'}.`);
			return found;
		}
	};

	const findElements: AgentTool = {
		name: 'find_animation_elements',
		title: 'Find artwork elements',
		description: 'Finds artwork elements whose id or name contains the text (case-insensitive). Returns their id, type, name, parent, bounds, paints and live effects.',
		inputSchema: object({ query: { type: 'string', minLength: 1, description: 'Text to look for in ids and names.' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most results (default 20).' } }, ['query']),
		annotations: { title: 'Find artwork elements', ...READ },
		handler: ({ query, limit = 20 }) => {
			const q = String(query).toLowerCase();
			const all = describeMotionElements(scene());
			const elements = all.filter((e) => e.id.toLowerCase().includes(q) || ('name' in e && String(e.name).toLowerCase().includes(q)));
			return { elements: elements.slice(0, limit), total: elements.length };
		}
	};

	const checkAnimation: AgentTool = {
		name: 'check_animation',
		title: 'Check the animation',
		description:
			'Lists the animation\'s problems: each with a stable code (unknown-target, overlap, out-of-frame, too-fast, enter-visible…), severity (error / warning / note), the shot and command index it is in, the node ids it is about, measured vs needed values, and a message saying how to fix it.',
		inputSchema: object({}),
		annotations: { title: 'Check the animation', ...READ },
		handler: () => {
			const issues = controller.getState().issues;
			return { ...issueSummary(issues), issues };
		}
	};

	const renderFrame: AgentTool = {
		name: 'render_animation_frame',
		title: 'Render a frame',
		description:
			'Draws the animation at one moment without changing it, to check it: standalone SVG by default, or a PNG image (format "png") when the host can rasterize. Give a time in ms, or a shot and where in it.',
		inputSchema: object({
			time: MS('Time from the start'),
			shot: { ...SHOT_ID, description: 'Render a moment of this shot instead of "time".' },
			at: { type: 'string', enum: ['start', 'middle', 'end'], description: 'With shot: which moment (default end: everything drawn, before the next shot).' },
			format: { type: 'string', enum: ['svg', 'png'], description: 'svg (default) or png (only when the host supports it).' }
		}),
		annotations: { title: 'Render a frame', ...READ },
		handler: async ({ time, shot, at = 'end', format = 'svg' }) => {
			const s = scene();
			let t = time ?? controller.getState().time;
			if (shot !== undefined) {
				const timing = compileMotionScene(s).shots.find((x) => x.id === shot);
				if (!timing) throw new Error(`There is no shot "${shot}"; the shots are ${s.shots.map((x) => `"${x.id}"`).join(', ') || 'none yet'}.`);
				t = at === 'start' ? timing.start : at === 'middle' ? (timing.commandsStart + timing.commandsEnd) / 2 : Math.max(timing.start, timing.end - 1);
			}
			const svg = controller.toSvg(t, { pretty: false });
			if (format === 'png') {
				if (!options.rasterize) throw new Error('This host cannot make PNG images; call render_animation_frame with format "svg".');
				const image = await options.rasterize(svg, { width: s.artwork.width, height: s.artwork.height });
				return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
			}
			return { time: t, svg };
		}
	};

	const CURVES_DESCRIPTION =
		'Write cubic-bezier easings (ease, ease-in, ease-out, ease-in-out, back eases, custom curves) as one change with ease: [x1, y1, x2, y2] (default true). Needs Flair 0.36 or later; false samples them into linear steps for older Flair.';
	const FLAIR_DESCRIPTION =
		'The Flair version to export for (default 0.39): springs and stepped time need 0.39, behaviours 0.38, cubic-bezier curves 0.36; older versions get those sampled into linear steps.';
	const BEHAVIORS_DESCRIPTION =
		'Write pulses, shakes, teeters, waves, wiggles and colour pulses as one change with a Flair behavior, so they play exactly (default true; needs Flair 0.38 or later). False samples them into linear steps for older Flair.';

	const exportFlairMotion: AgentTool = {
		name: 'export_flair_motion',
		title: 'Export as Flair vector motion',
		description:
			'Returns the animation as a Flair SvgMotion ({ svg, animate }) that Flair\'s SvgPlayer plays, plus its hold, how many changes were sampled into linear steps, and notes on anything not carried over.',
		inputSchema: object({
			fps: { type: 'number', minimum: 1, maximum: 120, description: 'Sampling rate for changes Flair cannot express exactly (default: the scene\'s fps, else 30).' },
			curves: { type: 'boolean', description: CURVES_DESCRIPTION },
			behaviors: { type: 'boolean', description: BEHAVIORS_DESCRIPTION },
			flair: { type: 'string', pattern: '^\\d+\\.\\d+(\\.\\d+)?$', description: FLAIR_DESCRIPTION }
		}),
		annotations: { title: 'Export as Flair vector motion', ...READ },
		handler: ({ fps, curves, behaviors, flair }) => controller.toFlairMotion({ ...(fps ? { fps } : {}), ...(curves === undefined ? {} : { curves }), ...(behaviors === undefined ? {} : { behaviors }), ...(flair ? { flair } : {}) })
	};

	const exportFlairEffect: AgentTool = {
		name: 'export_flair_effect',
		title: 'Export as a Flair effect',
		description:
			'Returns the animation as a Flair catalog vector effect: { kind: "vector", id, name, description, category, tags, motion, hold, presets }, with each colour control declared as a {{name: color}} placeholder. Add it to a Flair catalog or load it in Flair\'s effect editor.',
		inputSchema: object({
			id: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', description: 'Kebab-case id (default: from the scene\'s name).' },
			name: { type: 'string', minLength: 1, description: 'Display name (default: the scene\'s name).' },
			description: { type: 'string', description: 'One sentence (default: the scene\'s description).' },
			category: { type: 'string', minLength: 1, description: 'Flair catalog category, e.g. icon, loader, ui, data, text, morph (default icon).' },
			tags: { type: 'array', items: { type: 'string' }, description: 'Search tags (default none).' },
			curves: { type: 'boolean', description: CURVES_DESCRIPTION },
			behaviors: { type: 'boolean', description: BEHAVIORS_DESCRIPTION },
			flair: { type: 'string', pattern: '^\\d+\\.\\d+(\\.\\d+)?$', description: FLAIR_DESCRIPTION }
		}),
		annotations: { title: 'Export as a Flair effect', ...READ },
		handler: (args) => controller.toFlairEffect(args)
	};

	const setArtworkSvg: AgentTool = {
		name: 'set_animation_artwork_svg',
		title: 'Replace the artwork with SVG',
		description:
			'Replaces the artwork with an SVG (paths, shapes, groups, gradients; one undo step). Give every element you will animate an id: commands target ids. Shots that name ids the new artwork lacks are refused. Returns the elements.',
		inputSchema: object({ svg: { type: 'string', minLength: 1, description: 'A standalone <svg> with a viewBox.' } }, ['svg']),
		annotations: { title: 'Replace the artwork with SVG', ...DESTRUCTIVE },
		handler: ({ svg }) => {
			let artwork;
			try {
				artwork = parseVectorSvg(svg);
			} catch (error) {
				throw new Error(`The SVG could not be read: ${(error as Error).message}. Nothing was changed.`);
			}
			return apply({ op: 'set_artwork', artwork }, 'Replace artwork', (s) => ({ elements: describeMotionElements(s) }));
		}
	};

	const importFlairEffect: AgentTool = {
		name: 'import_flair_effect',
		title: 'Import a Flair effect',
		description:
			'Replaces the whole animation with a Flair vector effect or SvgMotion (one undo step): its SVG becomes the artwork, {{name: color}} placeholders become colour controls, and each Flair step becomes a shot of commands (fade, enter, style, move, rotate, scale, draw, follow, pulse, shake, teeter, wave, wiggle, color-pulse). Returns the shots, the elements, notes on anything not carried over and the issues. With dry_run it only reports what the import would give.',
		inputSchema: object(
			{
				effect: { type: 'object', description: 'A Flair catalog vector effect { kind: "vector", id, name, motion: { svg, animate }, hold?, presets? }. Give this or "motion".' },
				motion: { type: 'object', description: 'A Flair SvgMotion { svg, animate }. Give this or "effect".' },
				name: { type: 'string', minLength: 1, description: 'Name for the scene (default: the effect\'s id, else "from-flair").' },
				dry_run: { type: 'boolean', description: 'Report without replacing anything (default false).' }
			},
			[]
		),
		annotations: { title: 'Import a Flair effect', ...DESTRUCTIVE },
		handler: ({ effect, motion, name, dry_run = false }) => {
			if ((effect === undefined) === (motion === undefined)) throw new Error('Give exactly one of "effect" (a Flair vector effect) or "motion" (a Flair SvgMotion). Nothing was changed.');
			let result: FlairImportResult;
			try {
				result = effect !== undefined ? fromFlairVectorEffect(effect, name ? { name } : {}) : fromFlairSvgMotion(motion, name ? { name } : {});
			} catch (error) {
				throw new Error(`The Flair effect could not be imported: ${(error as Error).message} Nothing was changed.`);
			}
			const report = { notes: result.notes, issues: issueSummary(result.issues), shots: describeMotionShots(result.scene).map(({ id, start, end, commands }) => ({ id, start, end, commands: commands.length })) };
			if (dry_run) return { dry_run: true, ...report, hint: 'Nothing was replaced; call again without dry_run to import.' };
			const applied = controller.apply({ op: 'replace_scene', scene: result.scene }, 'Import Flair effect');
			return outcome(applied, applied.ok ? { ...report, elements: describeMotionElements(result.scene) } : {});
		}
	};

	const insertShots: AgentTool = {
		name: 'insert_shots',
		title: 'Add shots',
		description: 'Adds shots (one undo step) at a position (default: the end). Returns every shot\'s new timing and any issues.',
		inputSchema: object({ shots: { type: 'array', items: SHOT, minItems: 1, description: 'Shots to add.' }, at: { type: 'integer', minimum: 0, description: 'Position, 0 = first (default: the end).' } }, ['shots']),
		annotations: { title: 'Add shots', ...WRITE },
		handler: ({ shots, at }) => apply({ op: 'insert_shots', shots, at }, 'Add shots', () => ({ added: shots.map((s: { id: string }) => s.id) }))
	};

	const updateShot: AgentTool = {
		name: 'update_shot',
		title: 'Change a shot',
		description: 'Replaces the fields of one shot given in "set" (label, camera, run, hold, id) and clears those in "remove". Returns the new timing and issues.',
		inputSchema: object(
			{
				shot: SHOT_ID,
				set: object({ id: SHOT.properties!.id, ...SHOT_FIELDS }, [], 'Fields to replace.'),
				remove: { type: 'array', items: { type: 'string', enum: ['label', 'camera', 'hold'] }, description: 'Fields to clear.' }
			},
			['shot']
		),
		annotations: { title: 'Change a shot', ...WRITE_IDEMPOTENT },
		handler: ({ shot, set, remove }) => apply({ op: 'update_shot', shot, set, remove }, 'Change shot')
	};

	const deleteShots: AgentTool = {
		name: 'delete_shots',
		title: 'Delete shots',
		description: 'Removes shots by id (one undo step). Returns the remaining timing.',
		inputSchema: object({ shots: { type: 'array', items: SHOT_ID, minItems: 1, description: 'Shot ids.' } }, ['shots']),
		annotations: { title: 'Delete shots', ...DESTRUCTIVE },
		handler: ({ shots }) => apply({ op: 'delete_shots', shots }, 'Delete shots')
	};

	const moveShot: AgentTool = {
		name: 'move_shot',
		title: 'Reorder a shot',
		description: 'Moves a shot to a new position (0 = first). Returns the new timing.',
		inputSchema: object({ shot: SHOT_ID, to: { type: 'integer', minimum: 0, description: 'New position, 0 = first.' } }, ['shot', 'to']),
		annotations: { title: 'Reorder a shot', ...WRITE_IDEMPOTENT },
		handler: ({ shot, to }) => apply({ op: 'move_shot', shot, to }, 'Move shot')
	};

	const addCommands: AgentTool = {
		name: 'add_commands',
		title: 'Add commands to a shot',
		description: 'Adds commands to a shot\'s run (one undo step), at an index (default: the end). Returns the indexes they got, their timing and any issues.',
		inputSchema: object({ shot: SHOT_ID, commands: { type: 'array', items: MOTION_COMMAND_SCHEMA, minItems: 1, description: 'Commands to add.' }, at: { type: 'integer', minimum: 0, description: 'Index in the run (default: the end).' } }, ['shot', 'commands']),
		annotations: { title: 'Add commands to a shot', ...WRITE },
		handler: ({ shot, commands, at }) => {
			const before = scene().shots.find((s) => s.id === shot)?.run.length ?? 0;
			const first = at ?? before;
			return apply({ op: 'add_commands', shot, commands, at }, 'Add commands', (s) => {
				const shots = describeMotionShots(s);
				const added = shots.find((x) => x.id === shot)!.commands.slice(first, first + commands.length);
				return { added: added.map((c) => ({ index: c.index, type: c.type, start: c.start, end: c.end })) };
			});
		}
	};

	const updateCommand: AgentTool = {
		name: 'update_command',
		title: 'Change a command',
		description: 'Replaces fields of one command (by shot and index) given in "set" and clears those in "remove". Returns the command as it now stands with its timing.',
		inputSchema: object(
			{
				shot: SHOT_ID,
				command: { type: 'integer', minimum: 0, description: 'Index in the shot\'s run (from get_animation).' },
				set: { type: 'object', description: 'Command fields to replace (see add_commands for each type\'s fields).' },
				remove: { type: 'array', items: { type: 'string' }, description: 'Optional fields to clear (e.g. "delay").' }
			},
			['shot', 'command']
		),
		annotations: { title: 'Change a command', ...WRITE_IDEMPOTENT },
		handler: ({ shot, command, set, remove }) =>
			apply({ op: 'update_command', shot, command, set, remove }, 'Change command', (s) => ({ command: describeMotionShots(s).find((x) => x.id === shot)!.commands[command] }))
	};

	const deleteCommands: AgentTool = {
		name: 'delete_commands',
		title: 'Delete commands',
		description: 'Removes commands from a shot by index (one undo step). Later commands move up. Returns the new timing.',
		inputSchema: object({ shot: SHOT_ID, commands: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, description: 'Indexes in the shot\'s run.' } }, ['shot', 'commands']),
		annotations: { title: 'Delete commands', ...DESTRUCTIVE },
		handler: ({ shot, commands }) => apply({ op: 'delete_commands', shot, commands }, 'Delete commands')
	};

	const setSettings: AgentTool = {
		name: 'set_animation_settings',
		title: 'Change animation settings',
		description: 'Sets the name, description, loop mode, export frame rate, stepped time or target length. Returns the timing.',
		inputSchema: object(SETTINGS),
		annotations: { title: 'Change animation settings', ...WRITE_IDEMPOTENT },
		handler: (args) => apply({ op: 'set_settings', ...args }, 'Change settings')
	};

	const setControls: AgentTool = {
		name: 'set_animation_controls',
		title: 'Set Flair controls',
		description:
			'Sets the colour controls (and presets) a Flair effect made from this animation exposes: each control stands for every use of its default colour. Replaces the existing controls; an empty list clears them. Returns the issues.',
		inputSchema: object({ controls: { type: 'array', items: CONTROL, description: 'Controls (empty clears).' }, presets: { type: 'array', items: PRESET, description: 'Presets (empty clears; omit to keep).' } }, ['controls']),
		annotations: { title: 'Set Flair controls', ...WRITE_IDEMPOTENT },
		handler: ({ controls, presets }) => apply({ op: 'set_controls', controls, presets }, 'Set controls')
	};

	const editAnimation: AgentTool = {
		name: 'edit_animation',
		title: 'Make several edits at once',
		description:
			'Applies several edits in order as one undo step, all or nothing: if one fails, nothing changes and the error names the op ("op 2 (add_commands): …"). With dry_run it only reports the timing and issues the edits would give.',
		inputSchema: object({ ops: { type: 'array', items: EDIT_OP, minItems: 1, description: 'Edits, applied in order.' }, dry_run: { type: 'boolean', description: 'Check without applying (default false).' } }, ['ops']),
		annotations: { title: 'Make several edits at once', ...WRITE },
		handler: ({ ops, dry_run = false }) => {
			const result = controller.apply(ops, 'Edit animation', { dryRun: dry_run });
			return outcome(result, dry_run ? { dry_run: true, hint: 'Nothing was applied; call again without dry_run to apply.' } : {});
		}
	};

	const writeAnimation: AgentTool = {
		name: 'write_animation',
		title: 'Replace the animation\'s shots',
		description:
			'Replaces every shot (and optionally the settings and controls), keeping the artwork, as one undo step. For small changes prefer the per-operation tools. Returns the timing and issues.',
		inputSchema: object({ shots: { type: 'array', items: SHOT, description: 'All shots, in order.' }, ...SETTINGS, controls: { type: 'array', items: CONTROL, description: 'Colour controls.' }, presets: { type: 'array', items: PRESET, description: 'Presets.' } }, ['shots']),
		annotations: { title: 'Replace the animation\'s shots', ...DESTRUCTIVE },
		handler: ({ shots, controls, presets, ...settings }) => {
			const current = scene();
			const next: MotionScene = { ...current, shots };
			const edits: MotionEdit[] = [{ op: 'replace_scene', scene: next }];
			if (Object.keys(settings).length) edits.push({ op: 'set_settings', ...settings });
			if (controls) edits.push({ op: 'set_controls', controls, presets });
			return apply(edits, 'Replace animation');
		}
	};

	const seekAnimation: AgentTool = {
		name: 'seek_animation',
		title: 'Show a moment',
		description: 'Moves the playhead the person sees to a time or the start of a shot, and plays or pauses. Does not change the animation. Returns the playhead time and shot.',
		inputSchema: object({ time: MS('Time from the start'), shot: { ...SHOT_ID, description: 'Go to the start of this shot instead of "time".' }, play: { type: 'boolean', description: 'true plays from there, false pauses (default: leave as is).' } }),
		annotations: { title: 'Show a moment', ...WRITE_IDEMPOTENT },
		handler: ({ time, shot, play }) => {
			if (shot !== undefined && !controller.seekShot(shot)) throw new Error(`There is no shot "${shot}"; the shots are ${scene().shots.map((s) => `"${s.id}"`).join(', ') || 'none yet'}.`);
			if (shot === undefined && time !== undefined) controller.seek(time);
			if (play === true) controller.play();
			if (play === false) controller.pause();
			const state = controller.getState();
			return { time: state.time, shot: state.currentShot, playing: state.playing };
		}
	};

	const undo: AgentTool = {
		name: 'undo_animation',
		title: 'Undo an animation edit',
		description: 'Undoes the last edit. Returns whether something was undone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Undo an animation edit', ...WRITE },
		handler: () => {
			const label = controller.getState().undoLabel;
			const undone = controller.undo();
			return { undone, ...(undone ? { label } : {}) };
		}
	};

	const redo: AgentTool = {
		name: 'redo_animation',
		title: 'Redo an animation edit',
		description: 'Redoes the last undone edit. Returns whether something was redone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Redo an animation edit', ...WRITE },
		handler: () => {
			const label = controller.getState().redoLabel;
			const redone = controller.redo();
			return { redone, ...(redone ? { label } : {}) };
		}
	};

	const reads = [getAnimation, getShot, findElements, checkAnimation, renderFrame, exportFlairMotion, exportFlairEffect, seekAnimation];
	const writes = [setArtworkSvg, importFlairEffect, insertShots, updateShot, deleteShots, moveShot, addCommands, updateCommand, deleteCommands, setSettings, setControls, editAnimation, writeAnimation, undo, redo];

	return {
		id: options.id ?? 'animation',
		namespace: options.namespace,
		tools: () => (readOnlyReason() ? reads : [...reads, ...writes]),
		subscribe: (notify) => {
			let last = readOnlyReason();
			return controller.subscribe(() => {
				const now = readOnlyReason();
				if (now !== last) {
					last = now;
					notify();
				}
			});
		}
	};
}
