/**
 * Modular type scales, a standard heading-to-caption hierarchy, and fluid (viewport-scaled) sizes.
 */

import type { ModularScaleRatio, TypeHierarchy, TypeScaleStep } from './types.js';

/** The named ratios and their values. */
export const MODULAR_SCALE_RATIOS: Readonly<Record<ModularScaleRatio, number>> = {
	'minor-second': 1.067,
	'major-second': 1.125,
	'minor-third': 1.2,
	'major-third': 1.25,
	'perfect-fourth': 1.333,
	'augmented-fourth': 1.414,
	'perfect-fifth': 1.5,
	'golden-ratio': 1.618
};

export const MODULAR_SCALE_RATIO_NAMES = Object.keys(MODULAR_SCALE_RATIOS) as ModularScaleRatio[];

/** Token names of the standard hierarchy, by step (caption −2 … display 5). */
export const TYPE_HIERARCHY_STEPS: Readonly<Record<string, number>> = {
	caption: -2,
	'body-sm': -1,
	body: 0,
	h4: 1,
	h3: 2,
	h2: 3,
	h1: 4,
	display: 5
};

const round = (n: number, places = 2) => {
	const f = 10 ** places;
	return Math.round(n * f) / f;
};

/** The value of a named ratio. Throws for an unknown name. */
export function getScaleRatio(name: ModularScaleRatio): number {
	const ratio = MODULAR_SCALE_RATIOS[name];
	if (ratio === undefined) throw new Error(`Unknown scale ratio "${name}"; use one of ${MODULAR_SCALE_RATIO_NAMES.join(', ')} or a number above 1.`);
	return ratio;
}

/** A ratio as a number: named ratios are looked up, numbers must be above 1 and at most 4. */
export function resolveScaleRatio(ratio: number | ModularScaleRatio): number {
	if (typeof ratio === 'string') return getScaleRatio(ratio);
	if (!Number.isFinite(ratio) || ratio <= 1 || ratio > 4) throw new Error(`Scale ratio ${ratio} is out of range; use a number above 1 and at most 4 (1.25 is a common choice).`);
	return ratio;
}

/**
 * Recommended unitless line-height for a size: 1.5 up to 16px (body text, WCAG 1.4.8), easing
 * to 1.1 at 64px and above (display type), in steps of 0.05.
 */
export function recommendedLineHeight(size: number): number {
	if (size <= 16) return 1.5;
	if (size >= 64) return 1.1;
	const t = (size - 16) / 48;
	return Math.round((1.5 - 0.4 * t) * 20) / 20;
}

/** Recommended tracking in em: looser for small text, tighter for large headings. */
export function recommendedLetterSpacing(size: number): number {
	if (size < 14) return 0.01;
	if (size < 24) return 0;
	if (size < 40) return -0.01;
	if (size < 64) return -0.02;
	return -0.03;
}

/** One step of a scale: `baseSize × ratio^step`, with recommended line-height and tracking. */
export function typeScaleStep(baseSize: number, ratio: number, step: number, name = `step-${step}`): TypeScaleStep {
	const size = round(baseSize * ratio ** step);
	return { name, step, size, lineHeight: recommendedLineHeight(size), letterSpacing: recommendedLetterSpacing(size) };
}

function requireBase(baseSize: number): number {
	if (!Number.isFinite(baseSize) || baseSize <= 0 || baseSize > 512) throw new Error(`Base size ${baseSize} is out of range; use a size in px above 0 and at most 512 (16 is the browser default).`);
	return baseSize;
}

/** A modular scale: one {@link TypeScaleStep} per requested step, in the order given. */
export function computeTypeScale(baseSize: number, ratio: number | ModularScaleRatio, steps: readonly number[] = [-2, -1, 0, 1, 2, 3, 4, 5]): TypeScaleStep[] {
	requireBase(baseSize);
	const r = resolveScaleRatio(ratio);
	return steps.map((step) => {
		if (!Number.isInteger(step) || Math.abs(step) > 12) throw new Error(`Step ${step} must be an integer from -12 to 12.`);
		return typeScaleStep(baseSize, r, step);
	});
}

/** Tokens `caption`, `body-sm`, `body`, `h4`, `h3`, `h2`, `h1` and `display` on one modular scale. */
export function generateTypeHierarchy(options: { baseSize?: number; ratio?: ModularScaleRatio | number } = {}): TypeHierarchy {
	const baseSize = requireBase(options.baseSize ?? 16);
	const ratioOption = options.ratio ?? 'major-third';
	const ratio = resolveScaleRatio(ratioOption);
	const steps: Record<string, TypeScaleStep> = {};
	for (const [name, step] of Object.entries(TYPE_HIERARCHY_STEPS)) steps[name] = typeScaleStep(baseSize, ratio, step, name);
	return { ratio, ...(typeof ratioOption === 'string' ? { ratioName: ratioOption } : {}), baseSize, steps };
}

/**
 * CSS custom properties for a hierarchy: `--<prefix>-<name>-size` (rem), `-line-height` and
 * `-letter-spacing` (em) per token, inside `selector` (default `:root`).
 */
export function typeHierarchyToCss(hierarchy: TypeHierarchy, options: { prefix?: string; selector?: string; rootFontSize?: number } = {}): string {
	const prefix = options.prefix ?? 'font';
	const root = options.rootFontSize ?? 16;
	const lines = Object.values(hierarchy.steps).flatMap((s) => [
		`  --${prefix}-${s.name}-size: ${round(s.size / root, 4)}rem;`,
		`  --${prefix}-${s.name}-line-height: ${s.lineHeight};`,
		`  --${prefix}-${s.name}-letter-spacing: ${s.letterSpacing}em;`
	]);
	return `${options.selector ?? ':root'} {\n${lines.join('\n')}\n}`;
}

export interface FluidSizeOptions {
	/** Size in px at `minViewport` and below. */
	minSize: number;
	/** Size in px at `maxViewport` and above. */
	maxSize: number;
	/** Viewport width in px where scaling starts. */
	minViewport: number;
	/** Viewport width in px where scaling stops. */
	maxViewport: number;
	/** Root font size in px used to express rem values (default 16). */
	rootFontSize?: number;
}

export interface FluidSize {
	/** `clamp(min, intercept + slope·vw, max)` with rem bounds, so user zoom and font settings still apply. */
	clampCss: string;
	/** Growth per viewport px (px of font per px of viewport). */
	slope: number;
	/** Intercept in px (the size the linear part gives at a zero-width viewport). */
	intercept: number;
	/** The size in px at a viewport width. */
	evaluateAt: (viewport: number) => number;
}

/** A size that scales linearly with the viewport between two widths, as a CSS `clamp()`. */
export function computeFluidSize(options: FluidSizeOptions): FluidSize {
	const { minSize, maxSize, minViewport, maxViewport } = options;
	const root = options.rootFontSize ?? 16;
	for (const [k, v] of Object.entries({ minSize, maxSize, minViewport, maxViewport, rootFontSize: root })) {
		if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} must be a positive number of px (got ${v}).`);
	}
	if (maxViewport <= minViewport) throw new Error(`maxViewport (${maxViewport}) must be larger than minViewport (${minViewport}).`);
	const slope = (maxSize - minSize) / (maxViewport - minViewport);
	const intercept = minSize - slope * minViewport;
	const lo = Math.min(minSize, maxSize);
	const hi = Math.max(minSize, maxSize);
	const rem = (px: number) => `${round(px / root, 4)}rem`;
	const sign = intercept < 0 ? '-' : '+';
	const clampCss = `clamp(${rem(lo)}, ${round(slope * 100, 4)}vw ${sign} ${rem(Math.abs(intercept))}, ${rem(hi)})`;
	return {
		clampCss,
		slope: round(slope, 6),
		intercept: round(intercept, 4),
		evaluateAt: (viewport: number) => round(Math.min(hi, Math.max(lo, intercept + slope * viewport)), 4)
	};
}
