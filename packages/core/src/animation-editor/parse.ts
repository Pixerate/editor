import { isAnimationEasing } from '../animation/easing.js';
import { namedWithSuggestion } from './issues.js';
import { MOTION_COMMAND_TYPES, MOTION_DIRECTIONS, MOTION_ENTER_STYLES, MOTION_EXIT_STYLES, MOTION_REPEAT_MODES, MOTION_BLENDS, MOTION_IRIS_SHAPES, MOTION_SPLIT_ORIENTATIONS, type MotionCommand, type MotionScene, type MotionShot } from './types.js';

/**
 * Shape checking: whether a value is a well-formed scene, listing every problem at once.
 * Meaning (do the ids exist, does the timing work) is `checkMotionScene`'s job.
 */

export class MotionSceneFormatError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`The scene is not well formed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
		this.name = 'MotionSceneFormatError';
		this.problems = problems;
	}
}

const SCENE_KEYS = ['version', 'name', 'description', 'artwork', 'shots', 'loop', 'fps', 'steps', 'target', 'controls', 'presets'];
const SHOT_KEYS = ['id', 'label', 'camera', 'run', 'hold', 'speed'];
const CAMERA_KEYS = ['x', 'y', 'width', 'height', 'frame', 'padding', 'ease', 'ms', 'geometric'];
const BASE_KEYS = ['type', 'targets', 'duration', 'delay', 'stagger', 'with', 'ease', 'note', 'repeat', 'repeatMode', 'steps'];
const COMMAND_KEYS: Record<string, string[]> = {
	enter: [...BASE_KEYS, 'style', 'direction', 'distance', 'scale', 'shape', 'orientation'],
	exit: [...BASE_KEYS, 'style', 'direction', 'distance'],
	draw: [...BASE_KEYS, 'from', 'to'],
	move: [...BASE_KEYS, 'by', 'to', 'blend'],
	rotate: [...BASE_KEYS, 'by', 'to', 'blend'],
	scale: [...BASE_KEYS, 'to', 'geometric', 'blend'],
	fade: [...BASE_KEYS, 'to'],
	style: [...BASE_KEYS, 'fill', 'stroke', 'strokeWidth'],
	morph: [...BASE_KEYS, 'into'],
	match: [...BASE_KEYS, 'into'],
	follow: [...BASE_KEYS, 'path', 'rotate', 'from', 'to'],
	pulse: [...BASE_KEYS, 'amount', 'count', 'blend'],
	shake: [...BASE_KEYS, 'amount', 'count', 'axis', 'blend'],
	teeter: [...BASE_KEYS, 'angle', 'count', 'blend'],
	wave: [...BASE_KEYS, 'amount', 'count', 'blend'],
	wiggle: [...BASE_KEYS, 'amount', 'frequency', 'octaves', 'rotate', 'seed', 'blend'],
	'color-pulse': [...BASE_KEYS, 'color', 'paint', 'count'],
	effect: [...BASE_KEYS, 'effect', 'param', 'to'],
	wait: ['type', 'duration', 'with', 'note']
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown) => isObject(v) && isNum(v.x) && isNum(v.y);

function unknownKeys(value: Record<string, unknown>, known: readonly string[], where: string, problems: string[]) {
	for (const key of Object.keys(value)) if (!known.includes(key)) problems.push(`${where}: unknown field ${namedWithSuggestion(key, known)}.`);
}

/** Problems with one command's shape (empty when well formed). `where` prefixes each. */
export function commandShapeProblems(command: unknown, where: string): string[] {
	const problems: string[] = [];
	if (!isObject(command)) return [`${where} must be an object.`];
	const type = command.type;
	if (typeof type !== 'string' || !(MOTION_COMMAND_TYPES as readonly string[]).includes(type)) {
		return [`${where}: unknown type ${typeof type === 'string' ? namedWithSuggestion(type, MOTION_COMMAND_TYPES) : String(type)}; use one of ${MOTION_COMMAND_TYPES.join(', ')}.`];
	}
	unknownKeys(command, COMMAND_KEYS[type], `${where} (${type})`, problems);
	const p = (msg: string) => problems.push(`${where} (${type}): ${msg}`);
	const nonNegative = (key: string) => {
		if (command[key] !== undefined && !(isNum(command[key]) && (command[key] as number) >= 0)) p(`"${key}" must be a number of milliseconds ≥ 0.`);
	};
	const fraction = (key: string) => {
		if (command[key] !== undefined && !(isNum(command[key]) && (command[key] as number) >= 0 && (command[key] as number) <= 1)) p(`"${key}" must be a fraction from 0 to 1.`);
	};
	const optionalNumber = (key: string) => {
		if (command[key] !== undefined && !isNum(command[key])) p(`"${key}" must be a number.`);
	};
	if (command.with !== undefined && command.with !== 'after' && command.with !== 'previous') p(`"with" must be "after" or "previous".`);
	if (command.note !== undefined && typeof command.note !== 'string') p(`"note" must be a string.`);
	if (type === 'wait') {
		if (!isNum(command.duration) || command.duration < 0) p(`"duration" must be a number of milliseconds ≥ 0.`);
		return problems;
	}
	if (!Array.isArray(command.targets) || command.targets.length === 0 || !command.targets.every((t) => typeof t === 'string' && t.length > 0)) p(`"targets" must be a non-empty list of node ids.`);
	nonNegative('duration');
	nonNegative('delay');
	nonNegative('stagger');
	if (command.ease !== undefined && !isAnimationEasing(command.ease)) p(`"ease" is not an easing; use a preset such as "ease-in-out" or "spring-bouncy", or { "type": "cubic-bezier", … } or { "type": "spring", … }.`);
	if (command.repeat !== undefined) {
		if (type === 'enter' || type === 'exit') p(`"repeat" is not for ${type} (it brings things in or out once); repeat an emphasis or a move instead.`);
		else if (!(Number.isInteger(command.repeat) && (command.repeat as number) >= 1 && (command.repeat as number) <= 1000)) p(`"repeat" must be a whole number from 1 to 1000.`);
	}
	if (command.blend !== undefined && !(MOTION_BLENDS as readonly unknown[]).includes(command.blend)) p(`"blend" must be "replace" (the change takes over) or "add" (a layer on top).`);
	if (command.repeatMode !== undefined && !(MOTION_REPEAT_MODES as readonly unknown[]).includes(command.repeatMode)) p(`"repeatMode" must be one of ${MOTION_REPEAT_MODES.join(', ')}.`);
	if (command.steps !== undefined && !(isNum(command.steps) && command.steps > 0 && command.steps <= 120)) p(`"steps" must be frames per second from above 0 to 120 (12 holds each pose for two frames at 24 fps).`);
	switch (type) {
		case 'enter':
		case 'exit': {
			const styles = type === 'enter' ? MOTION_ENTER_STYLES : MOTION_EXIT_STYLES;
			if (command.style !== undefined && !(typeof command.style === 'string' && (styles as readonly string[]).includes(command.style)))
				p(`"style" must be one of ${styles.join(', ')}${typeof command.style === 'string' ? ` (got ${namedWithSuggestion(command.style, styles)})` : ''}.`);
			if (command.direction !== undefined && !(MOTION_DIRECTIONS as readonly unknown[]).includes(command.direction)) p(`"direction" must be one of ${MOTION_DIRECTIONS.join(', ')}.`);
			optionalNumber('distance');
			if (command.scale !== undefined && !(isNum(command.scale) && command.scale >= 0)) p(`"scale" must be a number ≥ 0 (the starting scale for pop and zoom).`);
			if (command.shape !== undefined && !(MOTION_IRIS_SHAPES as readonly unknown[]).includes(command.shape)) p(`"shape" must be one of ${MOTION_IRIS_SHAPES.join(', ')} (the opening of an iris).`);
			if (command.orientation !== undefined && !(MOTION_SPLIT_ORIENTATIONS as readonly unknown[]).includes(command.orientation)) p(`"orientation" must be one of ${MOTION_SPLIT_ORIENTATIONS.join(', ')} (the line a split opens from).`);
			break;
		}
		case 'draw':
			fraction('from');
			fraction('to');
			break;
		case 'move':
			if (command.by === undefined && command.to === undefined) p(`give "by" (an offset) or "to" (a point).`);
			if (command.by !== undefined && command.to !== undefined) p(`give "by" or "to", not both.`);
			if (command.by !== undefined && !isPoint(command.by)) p(`"by" must be { "x": number, "y": number }.`);
			if (command.to !== undefined && !isPoint(command.to)) p(`"to" must be { "x": number, "y": number }.`);
			break;
		case 'rotate':
			if (command.by === undefined && command.to === undefined) p(`give "by" or "to" (degrees).`);
			if (command.by !== undefined && command.to !== undefined) p(`give "by" or "to", not both.`);
			optionalNumber('by');
			optionalNumber('to');
			break;
		case 'scale':
			if (!(isNum(command.to) || isPoint(command.to))) p(`"to" must be a number or { "x": number, "y": number }.`);
			if (command.geometric !== undefined && typeof command.geometric !== 'boolean') p(`"geometric" must be true or false.`);
			break;
		case 'fade':
			if (!(isNum(command.to) && command.to >= 0 && command.to <= 1)) p(`"to" must be an opacity from 0 to 1.`);
			break;
		case 'style':
			if (command.fill === undefined && command.stroke === undefined && command.strokeWidth === undefined) p(`give at least one of "fill", "stroke" or "strokeWidth".`);
			if (command.fill !== undefined && typeof command.fill !== 'string') p(`"fill" must be a CSS colour.`);
			if (command.stroke !== undefined && typeof command.stroke !== 'string') p(`"stroke" must be a CSS colour.`);
			if (command.strokeWidth !== undefined && !(isNum(command.strokeWidth) && command.strokeWidth >= 0)) p(`"strokeWidth" must be a number ≥ 0.`);
			break;
		case 'morph':
		case 'match':
			if (typeof command.into !== 'string' || !command.into) p(`"into" must be the id of a ${type === 'match' ? 'group to become' : 'node whose shape to take'}.`);
			break;
		case 'follow':
			if (typeof command.path !== 'string' || !command.path) p(`"path" must be the id of a path node.`);
			if (command.rotate !== undefined && typeof command.rotate !== 'boolean') p(`"rotate" must be true or false.`);
			fraction('from');
			fraction('to');
			break;
		case 'pulse':
		case 'shake':
		case 'teeter':
		case 'wave':
		case 'color-pulse':
			optionalNumber('amount');
			optionalNumber('angle');
			if (command.count !== undefined && !(Number.isInteger(command.count) && (command.count as number) >= 1)) p(`"count" must be a whole number ≥ 1.`);
			if (command.axis !== undefined && command.axis !== 'horizontal' && command.axis !== 'vertical') p(`"axis" must be "horizontal" or "vertical".`);
			if (command.color !== undefined && typeof command.color !== 'string') p(`"color" must be a CSS colour.`);
			if (command.paint !== undefined && command.paint !== 'fill' && command.paint !== 'stroke') p(`"paint" must be "fill" or "stroke".`);
			break;
		case 'wiggle':
			optionalNumber('amount');
			optionalNumber('rotate');
			if (command.frequency !== undefined && !(isNum(command.frequency) && command.frequency > 0)) p(`"frequency" must be a number of Hz > 0.`);
			if (command.octaves !== undefined && !(Number.isInteger(command.octaves) && (command.octaves as number) >= 1 && (command.octaves as number) <= 8)) p(`"octaves" must be a whole number from 1 to 8.`);
			if (command.seed !== undefined && !(Number.isInteger(command.seed) && (command.seed as number) >= 0)) p(`"seed" must be a whole number ≥ 0.`);
			break;
		case 'effect':
			if (typeof command.effect !== 'string' || !command.effect) p(`"effect" must be the id of one of the node's effects.`);
			if (typeof command.param !== 'string' || !command.param) p(`"param" must name a numeric parameter of the effect.`);
			if (!isNum(command.to)) p(`"to" must be a number.`);
			break;
	}
	return problems;
}

/** Problems with one shot's shape. */
export function shotShapeProblems(shot: unknown, where: string): string[] {
	if (!isObject(shot)) return [`${where} must be an object.`];
	const problems: string[] = [];
	unknownKeys(shot, SHOT_KEYS, where, problems);
	if (typeof shot.id !== 'string' || !/^[A-Za-z0-9_][\w.-]*$/.test(shot.id)) problems.push(`${where}: "id" must be letters, digits, "_", "-" or "." (e.g. "intro").`);
	const name = typeof shot.id === 'string' ? `Shot "${shot.id}"` : where;
	if (shot.label !== undefined && typeof shot.label !== 'string') problems.push(`${name}: "label" must be a string.`);
	if (shot.hold !== undefined && !(isNum(shot.hold) && shot.hold >= 0)) problems.push(`${name}: "hold" must be a number of milliseconds ≥ 0.`);
	if (shot.speed !== undefined && !(isNum(shot.speed) && shot.speed >= 0.05 && shot.speed <= 20)) problems.push(`${name}: "speed" must be a number from 0.05 to 20 (2 plays it twice as fast).`);
	if (shot.camera !== undefined) {
		const c = shot.camera;
		if (!isObject(c)) problems.push(`${name}: "camera" must be an object.`);
		else {
			unknownKeys(c, CAMERA_KEYS, `${name} camera`, problems);
			const isRect = ['x', 'y', 'width', 'height'].every((k) => isNum(c[k]));
			if (typeof c.frame === 'string') {
				if (c.padding !== undefined && !isNum(c.padding)) problems.push(`${name} camera: "padding" must be a number.`);
			} else if (!isRect) problems.push(`${name} camera: give { x, y, width, height } or { frame: "<node id>" }.`);
			if (c.ease !== undefined && !isAnimationEasing(c.ease)) problems.push(`${name} camera: "ease" is not an easing.`);
			if (c.ms !== undefined && !(isNum(c.ms) && c.ms >= 0)) problems.push(`${name} camera: "ms" must be a number ≥ 0.`);
			if (c.geometric !== undefined && typeof c.geometric !== 'boolean') problems.push(`${name} camera: "geometric" must be true or false.`);
		}
	}
	if (!Array.isArray(shot.run)) problems.push(`${name}: "run" must be a list of commands (it may be empty).`);
	else shot.run.forEach((command, i) => problems.push(...commandShapeProblems(command, `${name}, command ${i + 1}`)));
	return problems;
}

/** Problems with a scene's shape (empty when well formed). */
export function motionSceneShapeProblems(input: unknown): string[] {
	if (!isObject(input)) return ['The scene must be an object.'];
	const problems: string[] = [];
	unknownKeys(input, SCENE_KEYS, 'Scene', problems);
	if (input.version !== 1) problems.push('Scene: "version" must be 1.');
	if (typeof input.name !== 'string' || !input.name) problems.push('Scene: "name" must be a non-empty string.');
	if (input.description !== undefined && typeof input.description !== 'string') problems.push('Scene: "description" must be a string.');
	const art = input.artwork;
	if (!isObject(art) || !isNum(art.width) || !isNum(art.height) || !(art.width > 0) || !(art.height > 0) || !Array.isArray(art.nodes))
		problems.push('Scene: "artwork" must be a vector document { width, height, nodes }.');
	if (input.loop !== undefined && !['none', 'loop', 'ping-pong'].includes(input.loop as string)) problems.push('Scene: "loop" must be "none", "loop" or "ping-pong".');
	if (input.fps !== undefined && !(isNum(input.fps) && input.fps > 0 && input.fps <= 120)) problems.push('Scene: "fps" must be a number from 1 to 120.');
	if (input.steps !== undefined && !(isNum(input.steps) && input.steps > 0 && input.steps <= 120)) problems.push('Scene: "steps" must be frames per second from above 0 to 120.');
	if (input.target !== undefined && !(Array.isArray(input.target) && input.target.length === 2 && input.target.every(isNum) && input.target[0] <= input.target[1]))
		problems.push('Scene: "target" must be [min, max] seconds.');
	if (input.controls !== undefined) {
		if (!Array.isArray(input.controls)) problems.push('Scene: "controls" must be a list.');
		else
			input.controls.forEach((c, i) => {
				if (!isObject(c) || typeof c.name !== 'string' || !/^[A-Za-z_]\w*$/.test(c.name) || c.type !== 'color' || typeof c.default !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.default))
					problems.push(`Scene: control ${i + 1} must be { name (an identifier), type: "color", default: "#rrggbb", label? }.`);
			});
	}
	if (input.presets !== undefined && !(Array.isArray(input.presets) && input.presets.every((p) => isObject(p) && typeof p.name === 'string' && isObject(p.values))))
		problems.push('Scene: "presets" must be a list of { name, values }.');
	if (!Array.isArray(input.shots)) problems.push('Scene: "shots" must be a list.');
	else input.shots.forEach((shot, i) => problems.push(...shotShapeProblems(shot, `Shot ${i + 1}`)));
	return problems;
}

/** Reads a scene from JSON (a string or a parsed value). Throws `MotionSceneFormatError` listing every problem. */
export function parseMotionScene(input: unknown): MotionScene {
	let value = input;
	if (typeof input === 'string') {
		try {
			value = JSON.parse(input);
		} catch (error) {
			throw new MotionSceneFormatError([`The scene is not valid JSON: ${(error as Error).message}`]);
		}
	}
	const problems = motionSceneShapeProblems(value);
	if (problems.length) throw new MotionSceneFormatError(problems);
	return value as MotionScene;
}

/** Writes a scene as JSON. */
export function motionSceneToJson(scene: MotionScene, space: number | string = 2): string {
	return JSON.stringify(scene, null, space);
}

/** Whether `shot` is a well-formed shot. */
export const isMotionShot = (shot: unknown): shot is MotionShot => shotShapeProblems(shot, 'Shot').length === 0;
/** Whether `command` is a well-formed command. */
export const isMotionCommand = (command: unknown): command is MotionCommand => commandShapeProblems(command, 'Command').length === 0;
