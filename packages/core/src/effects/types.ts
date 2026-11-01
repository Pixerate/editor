/**
 * The effects contract: how an editor finds, describes and renders effects that live in another
 * package. This library ships no effects of its own here, only the shapes a provider fills in;
 * a host passes a provider to an editor (`setEffectsProvider`) and the editor degrades to its
 * old behaviour without one.
 *
 * Every time is in milliseconds. Pixels are straight-alpha RGBA rows, top to bottom.
 */

import type { JsonSchema } from '../tools/schema.js';
import type { FlairSvgAnimation } from '../animation-editor/flair.js';
import type { EffectAuthoringSession, EffectAuthoringSource } from './authoring.js';

/**
 * How an effect is drawn: a pixel shader, an animated vector picture, motion applied to someone
 * else's vector art, or a camera move, which moves a scene's camera and draws no pixels.
 */
export type EffectKind = 'shader' | 'vector' | 'motion' | 'camera';

/**
 * What an effect is for. An effect may have several uses.
 *
 * - `filter`: changes an input picture (`inputs.source`).
 * - `transition`: blends `inputs.from` into `inputs.to`; `progress` runs 0 → 1.
 * - `generator`: draws a picture from nothing (a background, a texture).
 * - `overlay`: draws something meant to sit over other content, usually with transparency.
 * - `title`: draws type or a graphic meant as a title.
 * - `motion`: animates vector art (`applyVectorEffect`).
 * - `interactive`: reacts to pointer, scroll or audio input at run time.
 * - `camera`: moves a scene's camera (`cameraView`). Only `camera` effects have it, and they have
 *   no other use, so editors that draw pixels never offer them.
 */
export type EffectUse = 'filter' | 'transition' | 'generator' | 'overlay' | 'title' | 'motion' | 'interactive' | 'camera';

export const EFFECT_KINDS: readonly EffectKind[] = ['shader', 'vector', 'motion', 'camera'];
export const EFFECT_USES: readonly EffectUse[] = ['filter', 'transition', 'generator', 'overlay', 'title', 'motion', 'interactive', 'camera'];

/**
 * What a camera move does to a shot.
 *
 * - `transition`: moves the camera from one framing (`from`) to the next (`to`): a glide, a whip
 *   pan, a punch zoom, a cut.
 * - `hold`: moves the camera within one framing while the shot holds (`from` and `to` are the
 *   same): a Ken Burns drift, a crash zoom.
 */
export type CameraMoveRole = 'transition' | 'hold';

export const CAMERA_MOVE_ROLES: readonly CameraMoveRole[] = ['transition', 'hold'];

/** How a `camera` effect moves (`EffectSummary.camera`). */
export interface EffectCameraMove {
	role: CameraMoveRole;
	/** Length of the move at its default values (ms); 0 for a cut. A hold plays across the shot's hold instead. */
	durationMs: number;
	/**
	 * Where the view jumps, 0–1 through the move (0.5 for a whip pan or punch zoom that cuts
	 * halfway). Keyframes either side of it must not be tweened across. Absent for a smooth move.
	 */
	cut?: number;
}

/** One entry of a provider's catalog. */
export interface EffectSummary {
	/** Stable id, saved in documents. Never reused for a different effect. */
	id: string;
	name: string;
	kind: EffectKind;
	/** The provider's own grouping (e.g. `gradient`, `light`, `transition`). */
	category: string;
	uses: readonly EffectUse[];
	description?: string;
	tags?: readonly string[];
	/** True when the effect's output has transparent pixels (it can sit over other content). */
	transparent: boolean;
	/** True when the effect loops; its `duration` is then one cycle. */
	loop: boolean;
	/** Length of one play (ms). Absent for effects that do not change over time. */
	duration?: number;
	/**
	 * The control (a number from 0 to 1) setting how opaque the effect's own background is: at 0
	 * only what it draws is left, so it can sit over other content. Absent when the effect has no
	 * background of its own to fade (an overlay is already transparent).
	 */
	backgroundOpacity?: string;
	/** How a `camera` effect moves. Present exactly when `kind` is `camera`. */
	camera?: EffectCameraMove;
}

export interface EffectSearchOptions {
	kind?: EffectKind;
	category?: string;
	use?: EffectUse;
	/** Only effects carrying every one of these tags (in any case, spaces as hyphens: see `normaliseEffectTag`). */
	tags?: readonly string[];
	/** Most results to return. */
	limit?: number;
}

/** One control value: a number, a `#rrggbb` colour or other string, a switch, or a vector of numbers. */
export type EffectValue = number | string | boolean | readonly number[];
export type EffectValues = Readonly<Record<string, EffectValue>>;

/**
 * The controls of an effect as a strict JSON Schema: `type: 'object'`, `additionalProperties:
 * false`, and a `description` on every property (with units and range). `checkEffectProvider`
 * checks this.
 */
export type EffectControlSchema = JsonSchema & {
	type: 'object';
	properties: { readonly [control: string]: JsonSchema };
	additionalProperties: false;
};

export interface EffectPreset {
	name: string;
	/** Values to apply over the defaults. */
	values: EffectValues;
}

/**
 * A named input the effect reads. Filters read `source`, transitions `from` and `to`; a mask is
 * passed separately (`EffectRenderRequest.mask`), not as an input.
 */
export interface EffectInputSpec {
	name: string;
	kind: 'image' | 'audio';
	description: string;
	required: boolean;
}

/** Everything an editor needs to show an effect's controls and render it. */
export interface EffectDescription extends EffectSummary {
	controls: EffectControlSchema;
	/** A value for every control. */
	defaults: EffectValues;
	presets: readonly EffectPreset[];
	inputs: readonly EffectInputSpec[];
}

/**
 * Pixels in and out of a renderer, shaped like `ImageData`.
 *
 * `data` is 8-bit sRGB with straight alpha and is always present. `float`, when present, is the
 * same picture as 32-bit floats in **linear light** (sRGB primaries), straight alpha, where colour
 * may exceed 1. Renderers created with `depth` 16 or 32 return `float` when the provider
 * `supportsFloat`; `data` is then its clamped sRGB encoding.
 */
export interface EffectPixels {
	width: number;
	height: number;
	data: Uint8ClampedArray;
	float?: Float32Array;
}

/**
 * An input picture. Always accepted as `EffectPixels`; a provider whose capabilities include
 * `supportsHostImages` also takes the host's own image objects, which saves a read back.
 */
export type EffectImageSource = EffectPixels | ImageBitmap | OffscreenCanvas | VideoFrame;

export interface EffectRendererOptions {
	/** Output size in pixels. */
	width: number;
	height: number;
	/** Bits per channel of the target (default 8). 16 and 32 ask for `float` output. */
	depth?: 8 | 16 | 32;
}

export interface EffectRenderRequest {
	/** Effect time (ms), from the start of the effect. */
	time: number;
	/** Control values; missing controls take their defaults. Invalid values reject with `EffectControlError`. */
	values?: EffectValues;
	/** Pictures for the effect's named inputs (see `EffectDescription.inputs`). */
	inputs?: Readonly<Record<string, EffectImageSource>>;
	/** Coverage (alpha channel, 0 = untouched) limiting where the effect applies. Only with `supportsMask`. */
	mask?: EffectImageSource;
	/** Transitions: how far from `from` to `to`, 0–1. Defaults to `time / duration`. */
	progress?: number;
}

/** A live renderer for one effect at one size. Not safe for concurrent `render` calls. */
export interface EffectRenderer {
	readonly effectId: string;
	readonly width: number;
	readonly height: number;
	readonly depth: 8 | 16 | 32;
	render(request: EffectRenderRequest): Promise<EffectPixels>;
	/** Frees GPU or worker resources. Rendering afterwards rejects. */
	dispose(): void;
}

/** One change of an animated SVG (the shape of Flair's `SvgAnimation`). */
export type EffectSvgAnimation = FlairSvgAnimation;

/** An animated SVG: markup plus changes to its elements (the shape of Flair's `SvgMotion`). */
export interface EffectVectorMotion {
	svg: string;
	animate?: readonly EffectSvgAnimation[];
	/** Length of one play (ms). */
	duration: number;
	loop: boolean;
	/** Ms held on the last frame before looping. */
	hold?: number;
}

/** What a vector or motion effect is applied to: SVG markup, optionally with the ids of the elements to animate (default: all). */
export type EffectVectorTarget = string | { svg: string; nodeIds?: readonly string[] };

/**
 * Where a scene's camera looks (the shape of Flair's `View`). The scene is drawn at
 * (point + scroll) × zoom, then turned by `tilt`, `turn` and `roll` round the middle of the stage
 * and seen in perspective, then blurred by `blur` while the camera moves. Positions are in the
 * scene's own units, so a framing is `stage.width / zoom` wide.
 */
export interface CameraView {
	/** Scale of the scene on the stage; > 0. */
	zoom: number;
	/** Scene offset before scaling, in scene units. */
	scrollX: number;
	scrollY: number;
	/** Tips the scene back round its horizontal axis (CSS `rotateX`), degrees, −75 to 75. Default 0. */
	tilt?: number;
	/** Swings the scene round its vertical axis (CSS `rotateY`), degrees, −75 to 75. Default 0. */
	turn?: number;
	/** Rolls the scene round the line of sight (CSS `rotateZ`), degrees clockwise, −180 to 180. Default 0. */
	roll?: number;
	/** Distance of the lens from the scene as a multiple of the stage width; smaller is more dramatic. Default the provider's own. */
	perspective?: number;
	/** Motion blur in stage pixels while the camera moves; 0 or absent when still. */
	blur?: number;
	/** Direction the blur streaks, degrees on screen (0 horizontal, 90 vertical); absent when it blurs every way (a zoom or a turn). */
	blurAngle?: number;
}

/**
 * A camera move as a document names it (the shape of Flair's `CameraMoveSpec`): the move's id, or
 * the id with a preset, values and a length. Editors save it on a shot (`in` for a `transition`
 * move, `during` for a `hold`).
 */
export type CameraMoveSpec =
	| string
	| {
			/** The camera effect's id. */
			move: string;
			/** Length of a `transition` move (ms); default its `durationMs`. A `hold` plays across the shot's hold and takes none. */
			ms?: number;
			/** The preset its values came from, by name. */
			preset?: string;
			/** Control values over the move's defaults (a preset's values are written out here too). */
			values?: Record<string, EffectValue>;
	  };

/** The stage a camera looks at, in pixels. */
export interface CameraStage {
	width: number;
	height: number;
}

/** Where a camera move is: what `cameraView` takes. */
export interface CameraMoveContext {
	/** The framing the move leaves; for a hold, the framing it moves within (the same as `to`). */
	from: CameraView;
	/** The framing the move arrives at. */
	to: CameraView;
	/** How far through the move, 0–1. */
	u: number;
	/** Length of the whole move (ms): its `durationMs`, the editor's override, or for a hold the shot's hold. */
	ms: number;
	stage: CameraStage;
}

/** What `sampleCameraMove` takes: the move's framings, length and stage, and how often to key it. */
export interface CameraMoveSampleRequest {
	from: CameraView;
	to: CameraView;
	/** Length of the move (ms). */
	ms: number;
	stage: CameraStage;
	/** Keys per second; > 0. */
	fps: number;
	/** Control values; missing controls take their defaults. */
	values?: EffectValues;
}

/** One key of a sampled camera move. */
export interface CameraKeyframe {
	/** Ms from the start of the move. */
	t: number;
	view: CameraView;
}

/**
 * A camera move as keyframes, so an editor can bake it without calling `cameraView` each frame.
 * Keys are in time order from `t` 0 to `ms`, one per frame. At a cut two keys share the cut's
 * `t`: the view just before it, then the view after; tweening between consecutive keys never
 * crosses the jump.
 */
export interface CameraMoveSample {
	keys: readonly CameraKeyframe[];
	/** Ms of the cut, when the move has one. */
	cut?: number;
}

// ---------------------------------------------------------------------------
// Sequences and templates
// ---------------------------------------------------------------------------

/** A box in a sequence's stage units (pixels of `EffectSequence.stage`). */
export interface EffectRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Something a layer shows or applies its effect to: a picture or SVG (a URL, a `data:` URL or
 * `<svg>` markup), a video by URL, words, or `{ slot }`: a subject the host fills in by name.
 */
export type EffectSubject =
	| { image: string }
	| { video: string }
	| { svg: string }
	| { text: string; font?: string; weight?: number | string }
	| { slot: string };

/** The kinds of subject, as `EffectSubject` keys. */
export const EFFECT_SUBJECT_KINDS = ['image', 'video', 'svg', 'text', 'slot'] as const;
export type EffectSubjectKind = (typeof EFFECT_SUBJECT_KINDS)[number];

/**
 * Where a layer sits in a shot's stack: `background` under the shot's own content, `subject`
 * with it, `overlay` above everything.
 */
export type EffectLayerRole = 'background' | 'subject' | 'overlay';
export const EFFECT_LAYER_ROLES: readonly EffectLayerRole[] = ['background', 'subject', 'overlay'];

/** When a layer starts or stops: ms after its shot starts, or `{ shots: n }` for when the n-th shot after its own begins. */
export type EffectLayerTime = number | { shots: number };

/**
 * One layer of a shot (the shape of Flair's `SceneLayer`): a catalog effect, optionally applied
 * to a subject, or a bare subject (no `effect`), placed on the stage for a stretch of time.
 * The subject feeds the effect's `source` input, else its first image input.
 */
export interface EffectLayer {
	/** A name unique in the sequence. */
	id?: string;
	/** The effect's id (a generator, filter, overlay or title). Absent for a bare subject. */
	effect?: string;
	/** A preset of the effect's, by name; its values are written out in `values` too. */
	preset?: string;
	/** Control values over the effect's defaults. */
	values?: Record<string, EffectValue>;
	subject?: EffectSubject;
	/** Default `subject` when placed with `rect`, else `background`. */
	role?: EffectLayerRole;
	/** Where it sits, in stage units; it moves with the camera. Absent: it fills the screen. */
	rect?: EffectRect;
	/** When it starts (default 0: as its shot starts). */
	from?: EffectLayerTime;
	/** When it stops (default `{ shots: 1 }`: as the next shot starts). */
	until?: EffectLayerTime;
	/** 0–1 (default 1). */
	opacity?: number;
	/** Ms it fades in and out over (default 0: it cuts). */
	fade?: number;
}

/**
 * A transition into a shot (the shape of Flair's `ShotTransition`): an effect with the use
 * `transition` blends the outgoing shot's last frame (`from`) into the incoming shot (`to`) as
 * `progress` runs 0 → 1 over `ms`.
 */
export interface EffectShotTransition {
	effect: string;
	/** Length (ms), default `EFFECT_TRANSITION_MS`. */
	ms?: number;
	preset?: string;
	values?: Record<string, EffectValue>;
}

/** How long a shot transition takes when it does not say (ms). */
export const EFFECT_TRANSITION_MS = 800;

/** One shot of a sequence. */
export interface EffectSequenceShot {
	/** Ms the shot holds after its lead-in (the longer of its camera move and its transition). */
	hold: number;
	/** Words shown large over the shot. */
	title?: string;
	/** Words shown small at the foot of the shot. */
	caption?: string;
	camera?: {
		/** What the camera frames, in stage units (default the whole stage). */
		framing?: EffectRect;
		/** A `transition` camera move into this framing. */
		in?: CameraMoveSpec;
		/** A `hold` camera move while the shot holds. */
		during?: CameraMoveSpec;
	};
	/** Bottom to top. */
	layers: EffectLayer[];
	/** How the shot before gives way to this one; absent on the first shot. */
	transition?: EffectShotTransition;
}

/**
 * A sequence of shots built from catalog effects: what a template fills to. Renderer-neutral;
 * editors load it into their own documents (an animation's shots, a video's clips).
 */
export interface EffectSequence {
	name: string;
	title?: string;
	/** Stage size in pixels; rects and framings are in these units. */
	stage: CameraStage;
	shots: EffectSequenceShot[];
}

/** One template of a provider's catalog. */
export interface EffectTemplateSummary {
	/** Stable id. */
	id: string;
	name: string;
	description: string;
	tags?: readonly string[];
	/** How many shots it fills to. */
	shots: number;
	/** Length with its defaults (ms), when the provider knows it. */
	durationMs?: number;
}

/** The kinds of template slot: a subject (`image`, `video`, `svg`), `text`, `color` or `number`. */
export const EFFECT_TEMPLATE_SLOT_TYPES = ['image', 'video', 'svg', 'text', 'color', 'number'] as const;
export type EffectTemplateSlotType = (typeof EFFECT_TEMPLATE_SLOT_TYPES)[number];

interface EffectTemplateSlotBase {
	/** Letters, digits, `-` and `_`, starting with a letter. */
	name: string;
	/** What a form shows for it. */
	label: string;
	/** A sentence on what it is for. */
	description?: string;
}

/**
 * A slot for a picture, SVG or video. Its default (which may be large) is not described, only
 * whether there is one; with none, an unfilled slot is left for the host (`openSlots`).
 */
export interface EffectTemplateSubjectSlot extends EffectTemplateSlotBase {
	type: 'image' | 'video' | 'svg';
	hasDefault: boolean;
}

export interface EffectTemplateTextSlot extends EffectTemplateSlotBase {
	type: 'text';
	default: string;
	/** The most characters it takes. */
	maxLength?: number;
}

/** A colour, `#RRGGBB`. */
export interface EffectTemplateColorSlot extends EffectTemplateSlotBase {
	type: 'color';
	default: string;
}

export interface EffectTemplateNumberSlot extends EffectTemplateSlotBase {
	type: 'number';
	default: number;
	min?: number;
	max?: number;
	/** Whole numbers only. */
	integer?: boolean;
}

/** A slot of a template, shaped for a form (Flair's `describeTemplateSlots`). */
export type EffectTemplateSlot = EffectTemplateSubjectSlot | EffectTemplateTextSlot | EffectTemplateColorSlot | EffectTemplateNumberSlot;

/** A template with its slots, in the order a form shows them. */
export interface EffectTemplateDescription extends EffectTemplateSummary {
	slots: readonly EffectTemplateSlot[];
}

/**
 * What fills a slot: words, a colour or a number; for a subject slot a URL or markup, a subject
 * object, or `{ slot: name }` to leave it for the host.
 */
export type EffectTemplateValue = string | number | EffectSubject;
export type EffectTemplateValues = Readonly<Record<string, EffectTemplateValue>>;

export interface EffectTemplateSearchOptions {
	/** Only templates matching every word (in name, id, tags or description). */
	query?: string;
	/** Only templates carrying every one of these tags. */
	tags?: readonly string[];
	/** Most results to return. */
	limit?: number;
}

export interface EffectTemplateOptions {
	/** The sequence's name: lowercase words and dashes (default the template's id). */
	name?: string;
}

/** What `instantiateTemplate` gives. Values that do not fit are refused all at once, never in part. */
export type EffectTemplateResult =
	| {
			ok: true;
			sequence: EffectSequence;
			/** Subject slots left for the host to fill (no value and no default, or `{ slot }`). */
			openSlots: readonly string[];
			/** What the provider left out or changed, in sentences (empty when nothing was). */
			notes: readonly string[];
	  }
	| {
			ok: false;
			/** Each a sentence naming the slot and what it takes. */
			errors: readonly string[];
	  };

/** What a provider can do, so editors can degrade cleanly. */
export interface EffectProviderCapabilities {
	/** Renders off the main thread. */
	supportsWorker: boolean;
	/** Returns `float` pixels for depth 16 and 32 renderers. */
	supportsFloat: boolean;
	/** Honours `EffectRenderRequest.mask`; otherwise the editor masks the result itself. */
	supportsMask: boolean;
	/** Takes `ImageBitmap`, `OffscreenCanvas` or `VideoFrame` inputs, not only `EffectPixels`. */
	supportsHostImages: boolean;
	/** Implements `applyVectorEffect`. */
	supportsVector: boolean;
	/** Largest width or height a renderer accepts (px). */
	maxSize?: number;
	/** Implements `openAuthoring`: effects can be edited, not only used. */
	supportsAuthoring?: boolean;
	/** Lists `camera` effects and implements `cameraView` (and maybe `sampleCameraMove`). */
	supportsCamera?: boolean;
	/** Implements `listTemplates`, `describeTemplate` and `instantiateTemplate`. */
	supportsTemplates?: boolean;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * A source of effects. Implementations live outside this library (for example Flair's
 * `flairEffects()`); `createFakeEffectProvider` is a small reference implementation.
 *
 * Unknown ids reject or throw `UnknownEffectError`, invalid values `EffectControlError`, and an
 * operation the provider cannot do `EffectUnsupportedError`.
 */
export interface EffectProvider {
	/** Stable id of the provider, saved next to effect ids (e.g. `flair`). */
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly capabilities: EffectProviderCapabilities;
	list(options?: EffectSearchOptions): MaybePromise<readonly EffectSummary[]>;
	/** Effects matching every word of `query` (in name, id, category, tags or description), best first. */
	search(query: string, options?: EffectSearchOptions): MaybePromise<readonly EffectSummary[]>;
	describe(id: string): MaybePromise<EffectDescription>;
	/**
	 * A pixel renderer. A `vector` effect may refuse with `EffectUnsupportedError` where it cannot
	 * lay out SVG (a Worker); a `camera` effect draws no pixels and may refuse with one saying so.
	 */
	createRenderer(id: string, options: EffectRendererOptions): MaybePromise<EffectRenderer>;
	/**
	 * Vector and motion effects as an animated SVG. Present when `capabilities.supportsVector`. A
	 * `motion` effect animates the target's elements (`nodeIds`, else each top-level element with an
	 * id); a `vector` effect brings its own picture and ignores the target. Refuse a target the
	 * effect cannot use with `EffectUnsupportedError`.
	 */
	applyVectorEffect?(id: string, target: EffectVectorTarget, values?: EffectValues): MaybePromise<EffectVectorMotion>;
	/**
	 * Opens an effect for editing. Present when `capabilities.supportsAuthoring`. Unknown ids throw
	 * `UnknownEffectError`; an effect the provider cannot edit throws `EffectUnsupportedError`.
	 */
	openAuthoring?(from: EffectAuthoringSource): MaybePromise<EffectAuthoringSession>;
	/**
	 * Where a camera move puts the camera `ctx.u` of the way through it, with its motion blur.
	 * Present when `capabilities.supportsCamera`. Synchronous and pure: the same id, context and
	 * values always give the same view, so editors may call it per frame or cache it. Unknown ids
	 * throw `UnknownEffectError`, invalid values `EffectControlError`, and an effect that is not a
	 * camera move (or a `u` outside 0–1) `EffectUnsupportedError`.
	 */
	cameraView?(id: string, ctx: CameraMoveContext, values?: EffectValues): CameraView;
	/**
	 * A camera move as keyframes (see `CameraMoveSample`). Optional even with `supportsCamera`;
	 * `sampleEffectCameraMove` falls back to `cameraView` per frame. Errors as for `cameraView`.
	 */
	sampleCameraMove?(id: string, request: CameraMoveSampleRequest): MaybePromise<CameraMoveSample>;
	/** Sequence templates, best match first. Present when `capabilities.supportsTemplates`. */
	listTemplates?(options?: EffectTemplateSearchOptions): MaybePromise<readonly EffectTemplateSummary[]>;
	/** A template with its slots. Unknown ids throw `UnknownTemplateError`. */
	describeTemplate?(id: string): MaybePromise<EffectTemplateDescription>;
	/**
	 * Fills a template's slots and returns the sequence. Slots left out take their defaults.
	 * Values that do not fit (an unknown slot, a wrong type, out of range) give `{ ok: false,
	 * errors }`, each error a sentence. Unknown ids throw `UnknownTemplateError`. Every effect
	 * the sequence names is in the provider's `list()`.
	 */
	instantiateTemplate?(id: string, values?: EffectTemplateValues, options?: EffectTemplateOptions): MaybePromise<EffectTemplateResult>;
}
