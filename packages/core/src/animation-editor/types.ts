import type { AnimationEasing } from '../animation/easing.js';
import type { AnimationLoopMode } from '../animation/evaluate.js';
import type { VectorDocument } from '../vector/types.js';

/**
 * A vector animation as plain JSON: a piece of vector artwork (the editor's `VectorDocument`,
 * as the vector editor draws it) and the shots that bring it to life.
 *
 * Shots, not timelines: a shot frames the camera, plays its commands and holds. Timing comes
 * from the content (each command has a sensible default length, and drawing a line takes as
 * long as the line is long), so there are no keyframes to manage. The same scene plays the
 * same frames every time: every frame is a pure function of time.
 */
export interface MotionScene {
	/** Format version (always 1). */
	version: 1;
	/** A short name, e.g. `logo-reveal`. */
	name: string;
	description?: string;
	/** The artwork in its resting state. Commands target its node ids. */
	artwork: VectorDocument;
	shots: MotionShot[];
	/** Playback past the end: stop (`none`, default), `loop` or `ping-pong`. */
	loop?: AnimationLoopMode;
	/** Frame rate used to sample motion that a target format cannot express exactly (default 30). */
	fps?: number;
	/** Wanted length in seconds `[min, max]`; `check` warns outside it. */
	target?: [number, number];
	/** Parameters a Flair effect made from this scene exposes (see `toFlairVectorEffect`). */
	controls?: MotionControl[];
	/** Named sets of control values. */
	presets?: MotionPreset[];
}

/** A rectangle of the artwork, in document units. */
export interface MotionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Where the camera looks: a rectangle, or the id of a node to frame (with `padding` around
 * its bounds, default 24). The camera eases there over `ms` (default 1000; the first shot cuts).
 */
export type MotionCamera = (MotionRect | { frame: string; padding?: number }) & {
	ease?: AnimationEasing;
	ms?: number;
};

/** One beat of the animation. */
export interface MotionShot {
	/** Stable id (unique in the scene), e.g. `intro`. */
	id: string;
	/** What happens in this shot, in a few words (shown on the timeline). */
	label?: string;
	/** Omit to keep the current framing. */
	camera?: MotionCamera;
	/** Commands, played one after another (unless a command says `with: "previous"`). */
	run: MotionCommand[];
	/** Milliseconds to hold after the commands finish (default 600). */
	hold?: number;
}

/** Fields every command takes. */
export interface MotionCommandBase {
	/** Node ids from the artwork (groups animate as one). */
	targets: string[];
	/** Length in ms for each target (each type has a default; `draw` follows the path length). */
	duration?: number;
	/** Wait this many ms before starting (default 0). */
	delay?: number;
	/** Start each further target this many ms after the one before (default 0). */
	stagger?: number;
	/** `after` (default) starts when the commands before it finish; `previous` starts with the command before. */
	with?: 'after' | 'previous';
	ease?: AnimationEasing;
	/** Why this command is here (for people and agents reading the scene). */
	note?: string;
}

export type MotionEnterStyle = 'fade' | 'pop' | 'grow' | 'slide' | 'draw';
export type MotionExitStyle = 'fade' | 'shrink' | 'slide' | 'undraw';
export type MotionDirection = 'up' | 'down' | 'left' | 'right';

/** Brings hidden targets in. Targets entered in a shot are hidden before it. */
export interface MotionEnterCommand extends MotionCommandBase {
	type: 'enter';
	/** Default `fade`. `draw` draws the outline on, then fades the fill in. */
	style?: MotionEnterStyle;
	/** For `slide`: the direction of travel (default `up`). */
	direction?: MotionDirection;
	/** For `slide`: how far in document units (default 40). */
	distance?: number;
}

/** Takes targets out. */
export interface MotionExitCommand extends MotionCommandBase {
	type: 'exit';
	/** Default `fade`. */
	style?: MotionExitStyle;
	direction?: MotionDirection;
	distance?: number;
}

/** Draws a stroke on (or off) between two fractions of its length. */
export interface MotionDrawCommand extends MotionCommandBase {
	type: 'draw';
	/** Fraction drawn at the end (default 1). */
	to?: number;
	/** Fraction drawn at the start (default: what is drawn now). */
	from?: number;
}

/** Moves targets by an offset, or to a point (their centre lands there). */
export interface MotionMoveCommand extends MotionCommandBase {
	type: 'move';
	by?: { x: number; y: number };
	to?: { x: number; y: number };
}

/** Turns targets about their centre, by or to an angle in degrees (clockwise). */
export interface MotionRotateCommand extends MotionCommandBase {
	type: 'rotate';
	by?: number;
	to?: number;
}

/** Scales targets about their centre (1 = rest size). */
export interface MotionScaleCommand extends MotionCommandBase {
	type: 'scale';
	to: number | { x: number; y: number };
}

/** Changes opacity (0–1). */
export interface MotionFadeCommand extends MotionCommandBase {
	type: 'fade';
	to: number;
}

/** Changes solid paints and stroke width. Colours mix in OKLab. */
export interface MotionStyleCommand extends MotionCommandBase {
	type: 'style';
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
}

/** Morphs each target into the shape of another node (`into`), which usually stays hidden. */
export interface MotionMorphCommand extends MotionCommandBase {
	type: 'morph';
	into: string;
}

/** Moves targets along a path node, centre on the path. */
export interface MotionFollowCommand extends MotionCommandBase {
	type: 'follow';
	/** Id of a path node in the artwork (it can be hidden). */
	path: string;
	/** Turn with the path's direction (default false). */
	rotate?: boolean;
	/** Fractions of the path's length to travel between (default 0 → 1). */
	from?: number;
	to?: number;
}

/** Scales up and back, `count` times (draws the eye). */
export interface MotionPulseCommand extends MotionCommandBase {
	type: 'pulse';
	/** Extra scale at the peak (default 0.15). */
	amount?: number;
	count?: number;
}

/** Shakes side to side, settling. */
export interface MotionShakeCommand extends MotionCommandBase {
	type: 'shake';
	/** Distance in document units (default 8). */
	amount?: number;
	count?: number;
}

/** Tweens a numeric parameter of a live path effect on the target (twist angle, wiggle time, zig zag size…). */
export interface MotionEffectCommand extends MotionCommandBase {
	type: 'effect';
	/** Id of an effect in the target node's `effects`. */
	effect: string;
	/** A numeric parameter of that effect, e.g. `angle`. */
	param: string;
	to: number;
}

/** Does nothing for `duration` ms. */
export interface MotionWaitCommand {
	type: 'wait';
	duration: number;
	with?: 'after' | 'previous';
	note?: string;
}

export type MotionCommand =
	| MotionEnterCommand
	| MotionExitCommand
	| MotionDrawCommand
	| MotionMoveCommand
	| MotionRotateCommand
	| MotionScaleCommand
	| MotionFadeCommand
	| MotionStyleCommand
	| MotionMorphCommand
	| MotionFollowCommand
	| MotionPulseCommand
	| MotionShakeCommand
	| MotionEffectCommand
	| MotionWaitCommand;

export type MotionCommandType = MotionCommand['type'];

export const MOTION_COMMAND_TYPES: readonly MotionCommandType[] = [
	'enter',
	'exit',
	'draw',
	'move',
	'rotate',
	'scale',
	'fade',
	'style',
	'morph',
	'follow',
	'pulse',
	'shake',
	'effect',
	'wait'
];
export const MOTION_ENTER_STYLES: readonly MotionEnterStyle[] = ['fade', 'pop', 'grow', 'slide', 'draw'];
export const MOTION_EXIT_STYLES: readonly MotionExitStyle[] = ['fade', 'shrink', 'slide', 'undraw'];
export const MOTION_DIRECTIONS: readonly MotionDirection[] = ['up', 'down', 'left', 'right'];

/**
 * A colour parameter of the effect made from the scene: it stands for every use of its
 * `default` colour in the artwork and the commands, so recolouring it recolours them all.
 */
export interface MotionControl {
	/** Identifier, e.g. `accent`. */
	name: string;
	type: 'color';
	/** A `#rrggbb` colour used in the scene. */
	default: string;
	label?: string;
}

export interface MotionPreset {
	name: string;
	values: Record<string, string>;
}

/** Default lengths (ms) of commands that give none. */
export const MOTION_DEFAULT_DURATIONS: Readonly<Record<Exclude<MotionCommandType, 'wait' | 'draw'>, number>> = {
	enter: 600,
	exit: 450,
	move: 700,
	rotate: 700,
	scale: 500,
	fade: 400,
	style: 500,
	morph: 900,
	follow: 1400,
	pulse: 600,
	shake: 500,
	effect: 900
};

/** Default hold after a shot's commands (ms). */
export const MOTION_DEFAULT_HOLD = 600;
/** Default camera move (ms). */
export const MOTION_CAMERA_MS = 1000;
/** `draw` lasts `length × MOTION_DRAW_MS_PER_UNIT`, clamped to `MOTION_DRAW_RANGE`. */
export const MOTION_DRAW_MS_PER_UNIT = 1.5;
export const MOTION_DRAW_RANGE: readonly [number, number] = [500, 2500];
