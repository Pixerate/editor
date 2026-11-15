/**
 * Text treatments (`text-treatment` effects, #887): the look of an agent's edits to a range of
 * text. An agent checks a word or line, selects what it will replace, types over it, and the
 * change lands; its caret sits wherever it is. A treatment draws each of those stages over the
 * host's text and never changes the text: the host passes the range's line rectangles and its
 * caret, and the treatment returns a layer plan (rectangles, gradients, tags, ribbons and their
 * opacities, in the host's coordinates, y down) for a renderer to draw behind or above the text.
 *
 * Providers offer treatments through `EffectProvider.textTreatmentPlan` (Flair's catalog has
 * several). Without one, hosts draw the built-in treatment (`builtInTextTreatmentPlan`), which is
 * the editors' own look: a caret with a name tag, a tinted selection and a tint on what changed,
 * plus a soft sweep while checking. Swift's `BuiltInTextTreatment` reproduces it exactly (the
 * `agent-text` contracts hold its plans).
 *
 * Every time is in ms. Pure arithmetic only (no trigonometry), so another implementation can
 * match the plans exactly.
 */

import type { EffectProvider, EffectValues } from './types.js';
import { EffectControlError, EffectUnsupportedError } from './errors.js';

/**
 * The stages of an agent's edit, in the order they play:
 * - `caret`: the agent's insertion point, with a name tag when the target has a label (loops).
 * - `checking`: a sweep across the word or line being looked at.
 * - `selecting`: the selection appearing over what will be replaced.
 * - `typing`: the text being typed, with the caret at its end (loops while it types).
 * - `landed`: what changed, tinted, then fading.
 */
export type TextTreatmentStage = 'caret' | 'checking' | 'selecting' | 'typing' | 'landed';

export const TEXT_TREATMENT_STAGES: readonly TextTreatmentStage[] = ['caret', 'checking', 'selecting', 'typing', 'landed'];

/** A rectangle in the host's coordinates, y down: one line of the range. */
export interface TextTreatmentRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** An insertion point: its x, the top of its line and the line's height. */
export interface TextTreatmentCaret {
	x: number;
	y: number;
	height: number;
}

/**
 * What a treatment draws over, from the host: the range's line rectangles in reading order (a
 * range that wraps has several; they may change while a stage plays), the caret, and for some
 * layers the text's colours, font, what has been typed and a name tag.
 *
 * A host whose typing frames already change the text (the rich-text editor, `AgentTextDirector`)
 * leaves out `text` and `background`, so a treatment does not draw the typed word a second time.
 */
export interface TextTreatmentTarget {
	/** The range's lines, in reading order. */
	lines?: readonly TextTreatmentRect[];
	/** The insertion point (for the caret and its tag). */
	caret?: TextTreatmentCaret;
	/** `typing`: what has been typed so far, for a treatment that draws it over the old text. */
	text?: string;
	/** A name tag for the caret (the agent's name). */
	label?: string;
	/** The text's colour (`#rrggbb` or channels 0 to 1). */
	color?: string | readonly number[];
	/** The colour behind the text, for a treatment that covers the old text while typing. */
	background?: string | readonly number[];
	/** The text's font (a CSS font on the web), for text a treatment draws. */
	font?: string;
}

/** What `textTreatmentPlan` is asked for: a stage `time` ms in, over `target`. */
export interface TextTreatmentPlanRequest {
	stage: TextTreatmentStage;
	/** Ms into the stage (0 or more). */
	time: number;
	target: TextTreatmentTarget;
	/** Draws the stage without motion: held, and faded (System Settings' Reduce Motion). */
	reduceMotion?: boolean;
}

/** A colour's channels and alpha, 0 to 1. */
export type TextTreatmentRGBA = [number, number, number, number];

/** A linear gradient in the host's coordinates, padded with its end colours past its ends. */
export interface TextTreatmentGradient {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	stops: { offset: number; color: TextTreatmentRGBA }[];
}

/** A piece of a ribbon: a polygon (`[x, y]` corners) filled in one colour. */
export interface TextTreatmentSegment {
	points: [number, number][];
	color: TextTreatmentRGBA;
}

export type TextTreatmentLayerKind = 'rect' | 'text' | 'tag' | 'path';
export type TextTreatmentBlend = 'normal' | 'multiply' | 'screen' | 'plus-lighter';
export const TEXT_TREATMENT_LAYER_KINDS: readonly TextTreatmentLayerKind[] = ['rect', 'text', 'tag', 'path'];
export const TEXT_TREATMENT_BLENDS: readonly TextTreatmentBlend[] = ['normal', 'multiply', 'screen', 'plus-lighter'];

/**
 * One thing to draw:
 * - `rect`: a rectangle with corner `radius`, filled with `color` (or `gradient`), or outlined
 *   `stroke` px wide.
 * - `text`: `text` in `font`, left-aligned at `x`, centred down the line from `y` to `y + height`.
 * - `tag`: a pill `height` tall whose bottom-left corner is `x`, `y + height`, holding `text`
 *   (`size` px, `textColor`) with `padX` px either side; the renderer measures the text, so
 *   `width` is 0.
 * - `path`: a ribbon, as `segments` (filled polygons, each overlapping the next) drawn as one
 *   group at `opacity`, so the overlaps do not show; `x`, `y`, `width`, `height` are its bounds.
 *
 * `opacity` multiplies `color`'s alpha. `glow` is a blur radius (px) of a glow in the same colour.
 */
export interface TextTreatmentLayer {
	kind: TextTreatmentLayerKind;
	/** The provider's name for what made it (`fill`, `band`, `caret`, `tag`, …). */
	source: string;
	/** `behind` layers go under the text, `above` ones over it. */
	z: 'behind' | 'above';
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
	opacity: number;
	color: TextTreatmentRGBA;
	gradient?: TextTreatmentGradient;
	stroke?: number;
	glow?: number;
	blend: TextTreatmentBlend;
	text?: string;
	font?: string;
	size?: number;
	padX?: number;
	textColor?: TextTreatmentRGBA;
	segments?: TextTreatmentSegment[];
}

/** A stage at a moment, ready to draw. */
export interface TextTreatmentPlan {
	stage: TextTreatmentStage;
	/** Ms into the stage, as asked. */
	time: number;
	/** Ms the stage takes for this target (a looping stage's one pass). */
	duration: number;
	/**
	 * Whether it has finished (never, for a looping stage). A host then removes a `checking` or
	 * `landed` stage, and holds a `selecting` stage's last frame until typing starts.
	 */
	done: boolean;
	/** Whether it was drawn without motion. */
	reduced: boolean;
	/** Back to front within each of `behind` and `above`. */
	layers: TextTreatmentLayer[];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A colour from the host or a value (`#rrggbb`, or channels 0 to 1), or undefined. */
export function textTreatmentColor(c: unknown): TextTreatmentRGBA | undefined {
	if (typeof c === 'string') {
		const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
		if (!m) return undefined;
		const h = m[1]!;
		return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
	}
	if (Array.isArray(c) && c.length >= 3 && c.length <= 4 && c.every((x) => finite(x) && x >= 0 && x <= 1)) return [c[0], c[1], c[2], c[3] ?? 1];
	return undefined;
}

/** A stage name, checked: a thrown sentence lists the stages. */
export function checkTextTreatmentStage(stage: unknown, id?: string): TextTreatmentStage {
	if (typeof stage === 'string' && (TEXT_TREATMENT_STAGES as readonly string[]).includes(stage)) return stage as TextTreatmentStage;
	throw new EffectUnsupportedError(`There is no stage ${JSON.stringify(stage)}; a text treatment's stages are ${TEXT_TREATMENT_STAGES.join(', ')}.`, id);
}

/**
 * Checks a plan request: its stage, time and target. Throws `EffectUnsupportedError` with a
 * sentence naming what is wrong. Providers can call it first in `textTreatmentPlan`.
 */
export function checkTextTreatmentRequest(request: TextTreatmentPlanRequest, id?: string): void {
	if (!request || typeof request !== 'object') throw new EffectUnsupportedError('A text treatment request is { stage, time, target, reduceMotion? }.', id);
	checkTextTreatmentStage(request.stage, id);
	if (!finite(request.time) || request.time < 0) throw new EffectUnsupportedError(`The time is ms into the stage, 0 or more; it was ${String(request.time)}.`, id);
	const target = request.target;
	if (!target || typeof target !== 'object') throw new EffectUnsupportedError('The target is { lines: [{ x, y, width, height }, …], caret: { x, y, height }, text?, label?, color?, background?, font? }.', id);
	if (target.lines !== undefined) {
		if (!Array.isArray(target.lines)) throw new EffectUnsupportedError("The target's lines are a list of rectangles: [{ x, y, width, height }, …], in reading order.", id);
		target.lines.forEach((l, i) => {
			if (!l || !finite(l.x) || !finite(l.y) || !finite(l.width) || !finite(l.height) || l.width < 0 || l.height < 0) {
				throw new EffectUnsupportedError(`Line ${i} of the target is { x, y, width, height } in px, with width and height 0 or more; it was ${JSON.stringify(l)}.`, id);
			}
		});
	}
	const c = target.caret;
	if (c !== undefined && (!c || !finite(c.x) || !finite(c.y) || !finite(c.height) || c.height < 0)) {
		throw new EffectUnsupportedError(`The target's caret is { x, y, height } in px (y the top of its line); it was ${JSON.stringify(c)}.`, id);
	}
	for (const k of ['text', 'label', 'font'] as const) if (target[k] !== undefined && typeof target[k] !== 'string') throw new EffectUnsupportedError(`The target's ${k} is a string.`, id);
	for (const k of ['color', 'background'] as const) {
		if (target[k] !== undefined && !textTreatmentColor(target[k])) throw new EffectUnsupportedError(`The target's ${k} is a colour: "#rrggbb", or channels 0 to 1; it was ${JSON.stringify(target[k])}.`, id);
	}
	if (request.reduceMotion !== undefined && typeof request.reduceMotion !== 'boolean') throw new EffectUnsupportedError('reduceMotion is true or false.', id);
}

/** Problems with a plan for `request`, as sentences (empty when it is well formed). */
export function textTreatmentPlanProblems(plan: TextTreatmentPlan, request: TextTreatmentPlanRequest): string[] {
	const out: string[] = [];
	if (!plan || typeof plan !== 'object') return ['the plan is not an object'];
	if (plan.stage !== request.stage) out.push(`stage is "${String(plan.stage)}", not the "${request.stage}" asked for`);
	if (plan.time !== request.time) out.push(`time is ${String(plan.time)}, not the ${request.time} asked for`);
	if (!finite(plan.duration) || plan.duration < 0) out.push('duration must be a number of ms ≥ 0');
	if (typeof plan.done !== 'boolean') out.push('done is not a boolean');
	if (plan.reduced !== !!request.reduceMotion) out.push(`reduced is ${String(plan.reduced)}, but reduceMotion was ${!!request.reduceMotion}`);
	if (!Array.isArray(plan.layers)) return [...out, 'layers is not a list'];
	plan.layers.forEach((l, i) => {
		const at = (m: string) => out.push(`layer ${i} (${String(l?.source)}): ${m}`);
		if (!l || typeof l !== 'object') return at('is not an object');
		if (!TEXT_TREATMENT_LAYER_KINDS.includes(l.kind)) at(`kind "${String(l.kind)}" is not one of ${TEXT_TREATMENT_LAYER_KINDS.join(', ')}`);
		if (typeof l.source !== 'string' || !l.source) at('has no source');
		if (l.z !== 'behind' && l.z !== 'above') at('z is "behind" or "above"');
		if (![l.x, l.y, l.width, l.height, l.radius].every(finite)) at('x, y, width, height and radius must be finite numbers');
		else if (l.width < 0 || l.height < 0 || l.radius < 0) at('width, height and radius must be 0 or more');
		if (!finite(l.opacity) || l.opacity < 0 || l.opacity > 1) at('opacity must be 0 to 1');
		if (!Array.isArray(l.color) || l.color.length !== 4 || !l.color.every((c) => finite(c) && c >= 0 && c <= 1)) at('color must be [r, g, b, a], each 0 to 1');
		if (!TEXT_TREATMENT_BLENDS.includes(l.blend)) at(`blend "${String(l.blend)}" is not one of ${TEXT_TREATMENT_BLENDS.join(', ')}`);
		if ((l.kind === 'text' || l.kind === 'tag') && typeof l.text !== 'string') at(`a ${l.kind} layer needs text`);
		if (l.kind === 'path' && (!Array.isArray(l.segments) || !l.segments.length)) at('a path layer needs segments');
	});
	return out;
}

// ---------------------------------------------------------------------------
// The built-in treatment: the editors' own look
// ---------------------------------------------------------------------------

/** Id the built-in treatment goes by where a treatment id is shown. */
export const BUILT_IN_TEXT_TREATMENT = 'built-in';
/** The agent's colour when none is given (as `DEFAULT_AGENT_CARET_COLOR`). */
export const BUILT_IN_TEXT_TREATMENT_COLOR = '#8b5cf6';
/** How long the built-in checking sweep takes, in ms (as `DEFAULT_AGENT_CHECK_MS`). */
export const BUILT_IN_TEXT_TREATMENT_CHECK_MS = 480;
/** One pass of a looping stage (`caret`, `typing`, `landed`), in ms. */
export const BUILT_IN_TEXT_TREATMENT_LOOP_MS = 1000;

/** Alphas of the built-in look: the selection, what changed, and the checking sweep at its brightest. */
const SELECT_ALPHA = 0.28;
const CHANGED_ALPHA = 0.18;
const SWEEP_ALPHA = 0.22;
/** The sweep's band is this share of the range's length. */
const SWEEP_WIDTH = 0.4;
/** The name tag: 11 px type, 1.5 line height, 5 px either side, 3 px corners. */
const TAG_SIZE = 11;
const TAG_HEIGHT = 16.5;
const TAG_PAD_X = 5;
const TAG_RADIUS = 3;
const CARET_WIDTH = 2;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Ease in and out: 3x² − 2x³. */
const smooth = (x: number) => {
	const u = clamp01(x);
	return u * u * (3 - 2 * u);
};

/** The built-in treatment's controls: only the agent's colour. */
export const BUILT_IN_TEXT_TREATMENT_CONTROLS = {
	type: 'object',
	properties: { color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: `The agent's colour, "#rrggbb" (default ${BUILT_IN_TEXT_TREATMENT_COLOR}).` } },
	additionalProperties: false,
} as const;

/** The built-in treatment's colour from `values`, or `EffectControlError`. */
function builtInColor(values: EffectValues | undefined): TextTreatmentRGBA {
	for (const name of Object.keys(values ?? {})) {
		if (name !== 'color') throw new EffectControlError(BUILT_IN_TEXT_TREATMENT, [{ path: `/${name}`, message: `is not a control; the built-in treatment has only "color" ("#rrggbb").` }]);
	}
	const v = values?.color ?? BUILT_IN_TEXT_TREATMENT_COLOR;
	const c = typeof v === 'string' ? textTreatmentColor(v) : undefined;
	if (!c) throw new EffectControlError(BUILT_IN_TEXT_TREATMENT, [{ path: '/color', message: `must be a colour "#rrggbb"; it was ${JSON.stringify(v)}.` }]);
	return c;
}

/**
 * The built-in treatment for `request`: the look the editors draw without a provider. `values`
 * takes `color` (`#rrggbb`, the agent's colour). Pure: the same request gives the same plan, here
 * and in Swift. Throws `EffectUnsupportedError` for a bad request, `EffectControlError` for bad
 * values.
 *
 * - `caret`: a 2 px caret, and the name tag above its line when the target has a label.
 * - `checking`: a soft band sweeping across the lines in reading order, then gone. With Reduce
 *   Motion, the lines are tinted instead, fading in and out.
 * - `selecting`: the lines tinted at once (28%), with the caret and tag.
 * - `typing`: the caret and tag at the end of the typed text.
 * - `landed`: the lines tinted (18%) until the host clears them.
 */
export function builtInTextTreatmentPlan(request: TextTreatmentPlanRequest, values?: EffectValues): TextTreatmentPlan {
	checkTextTreatmentRequest(request, BUILT_IN_TEXT_TREATMENT);
	const color = builtInColor(values);
	const { stage, time, target } = request;
	const reduced = request.reduceMotion === true;
	const lines = (target.lines ?? []).filter((l) => l.width > 0 && l.height > 0);
	const layers: TextTreatmentLayer[] = [];
	const rgba = (alpha: number): TextTreatmentRGBA => [color[0], color[1], color[2], alpha];
	const fills = (source: string, alpha: number, opacity = 1) => {
		if (opacity <= 0) return;
		for (const l of lines) layers.push({ kind: 'rect', source, z: 'behind', x: l.x, y: l.y, width: l.width, height: l.height, radius: 0, opacity, color: rgba(alpha), blend: 'normal' });
	};
	const caret = () => {
		const c = target.caret;
		if (!c || !(c.height > 0)) return;
		layers.push({ kind: 'rect', source: 'caret', z: 'above', x: c.x - CARET_WIDTH / 2, y: c.y, width: CARET_WIDTH, height: c.height, radius: 0, opacity: 1, color: rgba(1), blend: 'normal' });
		if (target.label) {
			layers.push({
				kind: 'tag',
				source: 'tag',
				z: 'above',
				x: c.x - CARET_WIDTH / 2,
				y: c.y - TAG_HEIGHT,
				width: 0,
				height: TAG_HEIGHT,
				radius: TAG_RADIUS,
				opacity: 1,
				color: rgba(1),
				blend: 'normal',
				text: target.label,
				size: TAG_SIZE,
				padX: TAG_PAD_X,
				textColor: [1, 1, 1, 1],
			});
		}
	};
	const plan = (duration: number, loop: boolean): TextTreatmentPlan => ({ stage, time, duration, done: !loop && time >= duration, reduced, layers });

	switch (stage) {
		case 'caret':
			caret();
			return plan(BUILT_IN_TEXT_TREATMENT_LOOP_MS, true);
		case 'typing':
			caret();
			return plan(BUILT_IN_TEXT_TREATMENT_LOOP_MS, true);
		case 'selecting':
			fills('selection', SELECT_ALPHA);
			caret();
			return plan(0, false);
		case 'landed':
			fills('changed', CHANGED_ALPHA);
			return plan(BUILT_IN_TEXT_TREATMENT_LOOP_MS, true);
		case 'checking': {
			const duration = BUILT_IN_TEXT_TREATMENT_CHECK_MS;
			const u = clamp01(time / duration);
			if (reduced) {
				// Held, fading in over the first 30% and out over the last.
				fills('sweep', SWEEP_ALPHA, clamp01(Math.min(u / 0.3, (1 - u) / 0.3)));
				return plan(duration, false);
			}
			if (time >= duration) return plan(duration, false);
			let length = 0;
			for (const l of lines) length += l.width;
			const band = SWEEP_WIDTH * length;
			if (band <= 0) return plan(duration, false);
			const start = smooth(u) * (length + band) - band;
			let offset = 0;
			for (const l of lines) {
				const from = Math.max(start, offset);
				const to = Math.min(start + band, offset + l.width);
				if (to - from > 0.01) {
					const x0 = l.x + start - offset;
					const midY = l.y + l.height / 2;
					layers.push({
						kind: 'rect',
						source: 'sweep',
						z: 'behind',
						x: l.x + from - offset,
						y: l.y,
						width: to - from,
						height: l.height,
						radius: 0,
						opacity: 1,
						color: rgba(SWEEP_ALPHA),
						blend: 'normal',
						gradient: {
							x0,
							y0: midY,
							x1: x0 + band,
							y1: midY,
							stops: [
								{ offset: 0, color: rgba(0) },
								{ offset: 0.5, color: rgba(SWEEP_ALPHA) },
								{ offset: 1, color: rgba(0) },
							],
						},
					});
				}
				offset += l.width;
			}
			return plan(duration, false);
		}
	}
}

// ---------------------------------------------------------------------------
// Choosing a treatment
// ---------------------------------------------------------------------------

/** Which treatment to draw an agent's edits with, and its values (`color` is the agent's colour). */
export interface TextTreatmentChoice {
	/** A `text-treatment` effect of the provider; default its `capabilities.defaultTextTreatment`. */
	id?: string;
	values?: EffectValues;
}

/** Whether `provider` can plan text treatments. */
export function supportsTextTreatments(provider: EffectProvider | null | undefined): provider is EffectProvider & Required<Pick<EffectProvider, 'textTreatmentPlan'>> {
	return !!provider?.capabilities?.supportsTextTreatments && typeof provider.textTreatmentPlan === 'function';
}

/**
 * The treatment id a host draws with: `choice.id`, else the provider's default; undefined means
 * the built-in treatment (no provider, one without text treatments, or no default).
 */
export function textTreatmentIdFor(provider: EffectProvider | null | undefined, choice: TextTreatmentChoice = {}): string | undefined {
	if (!supportsTextTreatments(provider)) return undefined;
	return choice.id ?? provider.capabilities.defaultTextTreatment;
}

/**
 * Plans `request` with the provider's treatment (`choice.id`, else its default), or the built-in
 * one when there is none (which reads only `color` from `choice.values`). Errors from the provider are thrown, so a host can say what went wrong
 * (and draw the built-in treatment instead).
 */
export function planTextTreatment(provider: EffectProvider | null | undefined, request: TextTreatmentPlanRequest, choice: TextTreatmentChoice = {}): TextTreatmentPlan {
	const id = textTreatmentIdFor(provider, choice);
	if (id === undefined) return builtInTextTreatmentPlan(request, choice.values?.color === undefined ? undefined : { color: choice.values.color });
	return provider!.textTreatmentPlan!(id, request, choice.values);
}
