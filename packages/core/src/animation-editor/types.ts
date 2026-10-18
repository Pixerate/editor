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
	/**
	 * Plays in answer to the viewer instead of on its own (exported to Flair's player):
	 * - `click`: nothing plays until the viewer clicks; each click plays the next shot, and after the
	 *   last one a click plays the first again, so a last shot that puts things back makes a toggle.
	 * - `hover` / `press`: plays forward while the pointer is over (or down on) it, and back when it leaves.
	 * - `scroll`: scrubs through the scene as it scrolls through the viewport.
	 * The editor previews it played through; `loop` does not apply.
	 */
	trigger?: MotionTrigger;
	/** Frame rate used to sample motion that a target format cannot express exactly (default 30). */
	fps?: number;
	/**
	 * Stepped time for every command that gives none: changes hold on a grid of this many frames
	 * per second ("on twos" at 12), for a hand-drawn look. Default: smooth.
	 */
	steps?: number;
	/** A beat grid to cue shots to (`MotionShot.at.beat`): music or a voiceover's rhythm. */
	beat?: MotionBeatGrid;
	/** A voiceover's words with their times, to cue shots to (`MotionShot.at.word`). */
	narration?: MotionNarration;
	/** Wanted length in seconds `[min, max]`; `check` warns outside it. */
	target?: [number, number];
	/**
	 * Reusable motion: named command lists written against the target `"$"`, played on any
	 * node with a `play` command (a "pop and settle" or "attention" you use many times).
	 */
	clips?: Record<string, MotionClip>;
	/**
	 * Properties that follow other properties: a background moving at half the speed of the
	 * foreground (parallax), a wheel turning as it rolls. Each adds to what its target's commands do.
	 */
	drivers?: MotionDriver[];
	/** Parameters a Flair effect made from this scene exposes (see `toFlairVectorEffect`). */
	controls?: MotionControl[];
	/** Named sets of control values. */
	presets?: MotionPreset[];
}

/** What the viewer does to play a triggered scene (see `MotionScene.trigger`). */
export type MotionTrigger = 'click' | 'hover' | 'press' | 'scroll';
export const MOTION_TRIGGERS: readonly MotionTrigger[] = ['click', 'hover', 'press', 'scroll'];

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
	/** Zoom at a steady rate (the size changes by the same factor each moment) instead of linearly. */
	geometric?: boolean;
};

/** A steady beat: `bpm` beats a minute, the first at `offset` ms, `meter` beats a bar. */
export interface MotionBeatGrid {
	bpm: number;
	/** When beat 0 falls, ms (default 0). */
	offset?: number;
	/** Beats in a bar (default 4), for reading beats as bar and beat. */
	meter?: number;
}

/** A voiceover: its words in order, each with when it is said (ms), from a TTS or speech-to-text word timing. */
export interface MotionNarration {
	words: { text: string; start: number; end?: number }[];
}

/** When a shot is cued to start: on a beat, on a narration word, or at a time. */
export interface MotionCue {
	/** Beat number on the scene's beat grid, from 0 (fractions for off-beats: 2.5 is the "and" of beat 3). */
	beat?: number;
	/** Index of a word in the scene's narration, from 0. */
	word?: number;
	/** A time in ms. */
	ms?: number;
}

/** One beat of the animation. */
export interface MotionShot {
	/** Stable id (unique in the scene), e.g. `intro`. */
	id: string;
	/** What happens in this shot, in a few words (shown on the timeline). */
	label?: string;
	/** Omit to keep the current framing. */
	camera?: MotionCamera;
	/**
	 * Start on a cue: a beat, a narration word or a time. The shot before holds until then; a
	 * cue that comes before the shot before has ended is missed (`check` says by how much).
	 * Give one of `beat`, `word` or `ms`.
	 */
	at?: MotionCue;
	/** Commands, played one after another (unless a command says `with: "previous"`). */
	run: MotionCommand[];
	/** Milliseconds to hold after the commands finish (default 600). */
	hold?: number;
	/**
	 * Plays the whole shot this many times as fast (default 1): its camera move, delays,
	 * durations, staggers and hold all scale by 1 / speed. `fit_animation` sets it to fit a length.
	 */
	speed?: number;
}

/** Fields every command takes. */
export interface MotionCommandBase {
	/** Node ids from the artwork (groups animate as one). */
	targets: string[];
	/** Length in ms for each target, one cycle when repeating (each type has a default; `draw` follows the path length; a spring `ease` lasts until it settles). */
	duration?: number;
	/** Wait this many ms before starting (default 0). */
	delay?: number;
	/** Start each further target this many ms after the one before (default 0). */
	stagger?: number;
	/** `after` (default) starts when the commands before it finish; `previous` starts with the command before. */
	with?: 'after' | 'previous';
	/** An easing; a spring with no `duration` lasts until it settles. */
	ease?: AnimationEasing;
	/** Why this command is here (for people and agents reading the scene). */
	note?: string;
	/**
	 * Play the change this many times (a whole number, default 1); `duration` is one cycle. Not
	 * for `enter`, `exit` or `wait`.
	 */
	repeat?: number;
	/**
	 * How repeats follow each other: `loop` (default) starts each cycle afresh, `mirror` plays
	 * every other one backwards, `offset` carries on from where the last ended (rotate by 90,
	 * repeat 4: a full turn). Colours and shapes offset like `loop`.
	 */
	repeatMode?: 'loop' | 'mirror' | 'offset';
	/** Stepped time: hold the change on a grid of this many frames per second (default: the scene's `steps`, else smooth). */
	steps?: number;
}

export type MotionEnterStyle = 'fade' | 'pop' | 'grow' | 'slide' | 'draw' | 'zoom' | 'rise' | 'wipe' | 'iris' | 'split';
export type MotionExitStyle = 'fade' | 'shrink' | 'slide' | 'undraw' | 'wipe';
export type MotionDirection = 'up' | 'down' | 'left' | 'right';
/** The opening an `iris` reveals through. */
export type MotionIrisShape = 'circle' | 'box';
/** The line a `split` opens from. */
export type MotionSplitOrientation = 'horizontal' | 'vertical';

/**
 * Brings hidden targets in. Targets entered in a shot are hidden before it. Each style is a
 * Flair motion primitive (`entrance.<style>`) with the same defaults.
 */
export interface MotionEnterCommand extends MotionCommandBase, MotionDrawOrder {
	type: 'enter';
	/**
	 * Default `fade`. `draw` draws the outline on, then fades the fill in. `pop` scales up past
	 * full size and settles; `zoom` settles from larger; `rise` rises a short way with a little
	 * overshoot. `wipe`, `iris` and `split` reveal the target through a clip over its box (see
	 * `MotionFrame.clips`), reaching past it far enough to show its whole stroke.
	 */
	style?: MotionEnterStyle;
	/**
	 * For `slide`: the direction of travel (default `up`). For `wipe`: the way the edge travels
	 * (default `right`, which reveals from the left).
	 */
	direction?: MotionDirection;
	/** For `slide` (default 40) and `rise` (default 20): how far in document units. */
	distance?: number;
	/** For `pop` (default 0.5) and `zoom` (default 1.6): the starting scale. */
	scale?: number;
	/** For `iris`: open through a `circle` (default; an ellipse on a box that is not square) or a `box`. */
	shape?: MotionIrisShape;
	/** For `split`: open up and down from a `horizontal` line through the middle (default), or left and right from a `vertical` one. */
	orientation?: MotionSplitOrientation;
}

/** Takes targets out. */
export interface MotionExitCommand extends MotionCommandBase, MotionDrawOrder {
	type: 'exit';
	/** Default `fade`. `wipe` hides the target behind an edge travelling `direction` (a wipe in, reversed). */
	style?: MotionExitStyle;
	/** For `slide`: the direction of travel (default `down`). For `wipe`: the way the edge travels (default `right`, which hides from the left). */
	direction?: MotionDirection;
	distance?: number;
}

/**
 * How the strokes of a group (or several paths) draw on or off together. Default: all at once,
 * each over the whole time.
 */
export interface MotionDrawOrder {
	/** `together` (default) or `sequence`: one stroke after another, each for a time in proportion to its length. */
	order?: 'together' | 'sequence';
	/** With `together`: `time` (default) gives every stroke the whole time; `speed` draws them all at one speed, so short ones take less. */
	pace?: 'time' | 'speed';
	/** With `pace: "speed"`: `start` (default) starts them together, `end` finishes them together. */
	align?: 'start' | 'end';
	/** With `sequence`: `document` (default, stacking order) or `distance` from `origin` (a radial reveal). */
	sortBy?: 'document' | 'distance';
	/** With `sortBy: "distance"`: the point (document units) strokes are drawn out from (default the target's centre). */
	origin?: { x: number; y: number };
}

/** Draws a stroke on (or off) between two fractions of its length. */
export interface MotionDrawCommand extends MotionCommandBase, MotionDrawOrder {
	type: 'draw';
	/**
	 * A travelling stroke this fraction of the length long (0–1): it runs along the path and off
	 * the end, instead of drawing it on and leaving it.
	 */
	comet?: number;
	/** Fraction drawn at the end (default 1). */
	to?: number;
	/** Fraction drawn at the start (default: what is drawn now). */
	from?: number;
}

/** Moves targets by an offset, or to a point (their centre lands there). */
export interface MotionMoveCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'move';
	by?: { x: number; y: number };
	to?: { x: number; y: number };
	/**
	 * Points (document units) the centre passes through on the way, in order. The path is
	 * smooth (velocity carries through each point) and never overshoots a point.
	 */
	via?: { x: number; y: number }[];
	/** With `via`: `even` (default) keeps the speed steady along the path, `equal` gives each leg the same time. */
	pacing?: 'even' | 'equal';
}

/** Turns targets about their centre, by or to an angle in degrees (clockwise). */
export interface MotionRotateCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'rotate';
	by?: number;
	to?: number;
}

/** Scales targets about their centre (1 = rest size). */
export interface MotionScaleCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'scale';
	to: number | { x: number; y: number };
	/** Grow at a steady rate (the same factor each moment), which reads as an even zoom. */
	geometric?: boolean;
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

/**
 * Smart Animate: tweens a group into another group (`into`, usually hidden), part by part. Each
 * part of the target takes the shape, paint and place of its partner in `into`, paired by name,
 * then by id (`card-a-title` ↔ `card-b-title`), then by kind in order. Parts with no partner fade
 * out; parts of `into` with no partner do not appear (`check` lists them).
 */
export interface MotionMatchCommand extends MotionCommandBase {
	type: 'match';
	/** Id of the group (or node) to become. */
	into: string;
}

/** A reusable piece of motion: commands that target `"$"` (whatever `play` names), timed as in a shot. */
export interface MotionClip {
	description?: string;
	/** Commands, timed as in a shot; `"$"` in `targets` stands for the node played on. Clips cannot play clips. */
	run: MotionCommand[];
}

/** Properties a driver reads and drives: offsets (document units), turn (degrees), scales and opacity. */
export type MotionDrivenProperty = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity';
export const MOTION_DRIVEN_PROPERTIES: readonly MotionDrivenProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'];

/**
 * One property following another. Both are read as a change from rest (offsets and turns from
 * 0, scales and opacity from 1): the target's property changes by `source change · factor + offset`,
 * clamped to `clamp`, on top of its own commands (added to offsets and turns, multiplied into
 * scales and opacity as 1 + change).
 */
export interface MotionDriver {
	/** The node that follows. */
	target: string;
	property: MotionDrivenProperty;
	/** The node and property it follows. */
	source: { node: string; property: MotionDrivenProperty };
	/** Default 1 (0.5 moves at half the speed; 360 / (2π·radius) turns a wheel by how far it rolls). */
	factor?: number;
	/** Added to the change (default 0). */
	offset?: number;
	/** Limits the change to `[min, max]`. */
	clamp?: [number, number];
}

/** The placeholder target in a clip's commands. */
export const MOTION_CLIP_TARGET = '$';

/** Plays a clip (`scene.clips`) on the targets: its commands, with `"$"` standing for each target. */
export interface MotionPlayCommand extends MotionCommandBase {
	type: 'play';
	/** The clip's name. */
	clip: string;
	/** Play it this many times as fast (default 1). */
	speed?: number;
}

/** Moves targets along a path node, centre on the path. */
export interface MotionFollowCommand extends MotionCommandBase {
	type: 'follow';
	/** Id of a path node in the artwork (it can be hidden). */
	path: string;
	/**
	 * Turn with the path's direction (default false). Moves, shakes and wiggles made during the
	 * follow then turn with it too: they are offsets from the target's place on the path.
	 */
	rotate?: boolean;
	/** Fractions of the path's length to travel between (default 0 → 1). */
	from?: number;
	to?: number;
}

/** Scales up and back, `count` times (draws the eye). */
export interface MotionPulseCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'pulse';
	/** Extra scale at the peak (default 0.15). */
	amount?: number;
	count?: number;
}

/** Shakes side to side (or up and down), settling. */
export interface MotionShakeCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'shake';
	/** Distance in document units (default 8). */
	amount?: number;
	count?: number;
	/** Default `horizontal`. */
	axis?: 'horizontal' | 'vertical';
}

/** Rocks about the centre by `angle` either way, settling (Flair's `emphasis.teeter`). */
export interface MotionTeeterCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'teeter';
	/** Degrees either way (default 8). */
	angle?: number;
	/** Rocks (default 3). */
	count?: number;
}

/** Bobs up and down without settling, like something floating (Flair's `emphasis.wave`). */
export interface MotionWaveCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'wave';
	/** Height in document units (default 6). */
	amount?: number;
	/** Bobs (default 2). */
	count?: number;
}

/**
 * Wanders about its place as smooth seeded noise, easing out of and back to rest (Flair's
 * `emphasis.wiggle`). The same seed always wanders the same way.
 */
export interface MotionWiggleCommand extends MotionCommandBase {
	/**
	 * `add` makes the change a layer over the pose instead of a change to it: it stacks on
	 * whatever else moves the target (a shake on a slide), and what it adds stays once it ends.
	 * Default `replace` for move, rotate and scale (the later change takes over), `add` for
	 * pulse, shake, teeter, wave and wiggle.
	 */
	blend?: 'replace' | 'add';
	type: 'wiggle';
	/** Up to about this far, in document units (default 6). */
	amount?: number;
	/** Wanders per second, in Hz (default 3). */
	frequency?: number;
	/** Layers of finer detail (default 2). */
	octaves?: number;
	/** Also turns about the centre by up to about this many degrees (default 0). */
	rotate?: number;
	/** A whole number; default: one picked from the target's id, so each target wanders its own way. */
	seed?: number;
}

/** Tints solid paint toward a colour and back, `count` times (Flair's `emphasis.color-pulse`). */
export interface MotionColorPulseCommand extends MotionCommandBase {
	type: 'color-pulse';
	/** The tint (default `#f59e0b`). Mixes in OKLab. */
	color?: string;
	/** Which paint (default `fill`). On a group it tints every path in it. */
	paint?: 'fill' | 'stroke';
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
	| MotionMatchCommand
	| MotionPlayCommand
	| MotionFollowCommand
	| MotionPulseCommand
	| MotionShakeCommand
	| MotionTeeterCommand
	| MotionWaveCommand
	| MotionWiggleCommand
	| MotionColorPulseCommand
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
	'match',
	'play',
	'follow',
	'pulse',
	'shake',
	'teeter',
	'wave',
	'wiggle',
	'color-pulse',
	'effect',
	'wait'
];
export const MOTION_ENTER_STYLES: readonly MotionEnterStyle[] = ['fade', 'pop', 'grow', 'slide', 'draw', 'zoom', 'rise', 'wipe', 'iris', 'split'];
export const MOTION_BLENDS = ['replace', 'add'] as const;
export const MOTION_REPEAT_MODES = ['loop', 'mirror', 'offset'] as const;
export const MOTION_EXIT_STYLES: readonly MotionExitStyle[] = ['fade', 'shrink', 'slide', 'undraw', 'wipe'];
export const MOTION_IRIS_SHAPES: readonly MotionIrisShape[] = ['circle', 'box'];
export const MOTION_SPLIT_ORIENTATIONS: readonly MotionSplitOrientation[] = ['horizontal', 'vertical'];
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
	match: 900,
	/** A clip's length comes from its commands (this is only a fallback). */
	play: 600,
	follow: 1400,
	pulse: 600,
	shake: 500,
	teeter: 600,
	wave: 1000,
	wiggle: 1500,
	'color-pulse': 600,
	effect: 900
};

/** Default hold after a shot's commands (ms). */
export const MOTION_DEFAULT_HOLD = 600;
/** Default camera move (ms). */
export const MOTION_CAMERA_MS = 1000;
/** `draw` lasts `length × MOTION_DRAW_MS_PER_UNIT`, clamped to `MOTION_DRAW_RANGE`. */
export const MOTION_DRAW_MS_PER_UNIT = 1.5;
export const MOTION_DRAW_RANGE: readonly [number, number] = [500, 2500];

/**
 * The Flair motion primitive (`@pixerate/flair/motion`) a command plays, or undefined when
 * Flair has none (`move`, `scale`, `fade`, `style`, `morph`, `effect`, `wait` are the editor's
 * own). Commands and primitives of the same name take the same parameters and defaults.
 */
export function motionFlairPrimitive(command: MotionCommand): string | undefined {
	switch (command.type) {
		case 'enter':
			return `entrance.${command.style ?? 'fade'}`;
		case 'exit':
			return `exit.${command.style ?? 'fade'}`;
		case 'pulse':
		case 'shake':
		case 'teeter':
		case 'wave':
		case 'wiggle':
		case 'color-pulse':
			return `emphasis.${command.type}`;
		case 'rotate':
			return command.by !== undefined ? 'emphasis.spin' : undefined;
		case 'follow':
			return 'path.follow';
		default:
			return undefined;
	}
}
