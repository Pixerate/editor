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

/** How an effect is drawn: a pixel shader, an animated vector picture, or motion applied to someone else's vector art. */
export type EffectKind = 'shader' | 'vector' | 'motion';

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
 */
export type EffectUse = 'filter' | 'transition' | 'generator' | 'overlay' | 'title' | 'motion' | 'interactive';

export const EFFECT_KINDS: readonly EffectKind[] = ['shader', 'vector', 'motion'];
export const EFFECT_USES: readonly EffectUse[] = ['filter', 'transition', 'generator', 'overlay', 'title', 'motion', 'interactive'];

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
}

export interface EffectSearchOptions {
	kind?: EffectKind;
	category?: string;
	use?: EffectUse;
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
}

type MaybePromise<T> = T | Promise<T>;

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
	/** A pixel renderer. A `vector` effect may refuse with `EffectUnsupportedError` where it cannot lay out SVG (a Worker). */
	createRenderer(id: string, options: EffectRendererOptions): MaybePromise<EffectRenderer>;
	/**
	 * Vector and motion effects as an animated SVG. Present when `capabilities.supportsVector`. A
	 * `motion` effect animates the target's elements (`nodeIds`, else each top-level element with an
	 * id); a `vector` effect brings its own picture and ignores the target. Refuse a target the
	 * effect cannot use with `EffectUnsupportedError`.
	 */
	applyVectorEffect?(id: string, target: EffectVectorTarget, values?: EffectValues): MaybePromise<EffectVectorMotion>;
}
