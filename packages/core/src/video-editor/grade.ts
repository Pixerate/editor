import { applyVideoLut, videoLutSvgApproximation, type VideoLut } from './lut.js';
import type { VideoGrade, VideoGradeLut } from './types.js';

/**
 * Colour correction as a fixed series of colour-matrix steps on gamma-encoded sRGB, each clamped
 * to 0–1, in the same order everywhere: exposure, contrast, saturation, hue, then white balance.
 * Every step is one the browser has (CSS `brightness`, `contrast`, `saturate`, `hue-rotate`; white
 * balance as an SVG `feColorMatrix`) and ffmpeg has (`lutrgb`, `colorchannelmixer`), with the same
 * formulas, so the preview, SVG frames and the export agree.
 */

/** One slider of a grade: its range, default and step, for schemas, inspectors and clamping. */
/** The numeric settings of a grade (everything but its LUT). */
export type VideoGradeSetting = Exclude<keyof VideoGrade, 'lut'>;

export interface VideoGradeControl {
	key: VideoGradeSetting;
	label: string;
	min: number;
	max: number;
	step: number;
	/** What the number means, for tool descriptions. */
	description: string;
}

export const VIDEO_GRADE_CONTROLS: readonly VideoGradeControl[] = [
	{ key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.1, description: 'Exposure in stops: +1 doubles every channel, -1 halves it (default 0).' },
	{ key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.05, description: 'Contrast around mid grey, -1 (flat grey) to 1 (twice as steep); default 0.' },
	{ key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.05, description: 'Saturation, -1 (black and white) to 1 (twice as saturated); default 0.' },
	{ key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, description: 'Hue rotation in degrees (default 0).' },
	{ key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.05, description: 'White balance, -1 (cool, bluer) to 1 (warm, more orange); default 0.' },
	{ key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.05, description: 'White balance, -1 (greener) to 1 (more magenta); default 0.' }
];

/** Named looks. Apply them at a strength with `videoGradePreset`. */
export const VIDEO_GRADE_PRESETS = {
	warm: { temperature: 0.4, saturation: 0.1 },
	cool: { temperature: -0.4, tint: -0.05 },
	punchy: { contrast: 0.25, saturation: 0.3 },
	faded: { exposure: 0.15, contrast: -0.3, saturation: -0.3 },
	'black-and-white': { saturation: -1, contrast: 0.15 },
	'bleach-bypass': { saturation: -0.6, contrast: 0.4 },
	'day-for-night': { exposure: -1.5, saturation: -0.4, temperature: -0.6 }
} as const satisfies Record<string, VideoGrade>;
export type VideoGradePreset = keyof typeof VIDEO_GRADE_PRESETS;
export const VIDEO_GRADE_PRESET_NAMES = Object.keys(VIDEO_GRADE_PRESETS) as VideoGradePreset[];

const clampTo = (c: VideoGradeControl, v: number) => Math.min(c.max, Math.max(c.min, v));

/** A LUT setting with its strength clamped to 0–1 (and 1 left out); `undefined` without a `src` or at strength 0. */
export function normalizeVideoGradeLut(lut: VideoGradeLut | undefined): VideoGradeLut | undefined {
	if (!lut || typeof lut.src !== 'string' || !lut.src) return undefined;
	const strength = typeof lut.strength === 'number' && Number.isFinite(lut.strength) ? Math.round(Math.min(1, Math.max(0, lut.strength)) * 1000) / 1000 : 1;
	if (!strength) return undefined;
	return { src: lut.src, ...(strength !== 1 ? { strength } : {}), ...(lut.name ? { name: lut.name } : {}) };
}

/** A grade with every value clamped to its range and zero values left out; `undefined` when nothing is left. */
export function normalizeVideoGrade(grade: VideoGrade | undefined): VideoGrade | undefined {
	if (!grade) return undefined;
	const out: VideoGrade = {};
	for (const c of VIDEO_GRADE_CONTROLS) {
		const v = grade[c.key];
		if (typeof v === 'number' && Number.isFinite(v) && v !== 0) out[c.key] = Math.round(clampTo(c, v) * 1000) / 1000;
	}
	const lut = normalizeVideoGradeLut(grade.lut);
	if (lut) out.lut = lut;
	return Object.keys(out).length ? out : undefined;
}

/** A preset at `amount` (0–1, default 1) of its strength. */
export function videoGradePreset(name: VideoGradePreset, amount = 1): VideoGrade | undefined {
	const preset: Omit<VideoGrade, 'lut'> = VIDEO_GRADE_PRESETS[name];
	if (!preset) throw new Error(`There is no grade preset "${name}"; the presets are ${VIDEO_GRADE_PRESET_NAMES.join(', ')}.`);
	const k = Math.min(1, Math.max(0, amount));
	return normalizeVideoGrade(Object.fromEntries(Object.entries(preset).map(([key, v]) => [key, (v as number) * k])));
}

/** A preset look on a grade, keeping the grade's LUT (a look replaces only the settings). */
export function videoGradeLook(current: VideoGrade | undefined, name: VideoGradePreset, amount = 1): VideoGrade | undefined {
	return normalizeVideoGrade({ ...videoGradePreset(name, amount), ...(current?.lut ? { lut: current.lut } : {}) });
}

/** One step of a grade. */
export type VideoGradeStep =
	| { kind: 'brightness'; amount: number }
	| { kind: 'contrast'; amount: number }
	| { kind: 'saturate'; amount: number }
	| { kind: 'hue-rotate'; degrees: number }
	| { kind: 'gains'; r: number; g: number; b: number };

/** The steps a grade applies, in order, leaving out those that change nothing. */
export function videoGradeSteps(grade: VideoGrade | undefined): VideoGradeStep[] {
	const g = normalizeVideoGrade(grade);
	if (!g) return [];
	const steps: VideoGradeStep[] = [];
	if (g.exposure) steps.push({ kind: 'brightness', amount: 2 ** g.exposure });
	if (g.contrast) steps.push({ kind: 'contrast', amount: 1 + g.contrast });
	if (g.saturation) steps.push({ kind: 'saturate', amount: 1 + g.saturation });
	if (g.hue) steps.push({ kind: 'hue-rotate', degrees: g.hue });
	if (g.temperature || g.tint) {
		const t = g.temperature ?? 0;
		steps.push({ kind: 'gains', r: 1 + 0.25 * t, g: 1 - 0.25 * (g.tint ?? 0), b: 1 - 0.25 * t });
	}
	return steps;
}

/**
 * A step as a 3 × 4 matrix (rows r, g, b; columns r, g, b, offset), with the coefficients the CSS
 * Filter Effects spec gives for `saturate` and `hue-rotate`.
 */
export function videoGradeStepMatrix(step: VideoGradeStep): number[][] {
	switch (step.kind) {
		case 'brightness':
			return [
				[step.amount, 0, 0, 0],
				[0, step.amount, 0, 0],
				[0, 0, step.amount, 0]
			];
		case 'contrast': {
			const c = step.amount;
			const o = 0.5 - 0.5 * c;
			return [
				[c, 0, 0, o],
				[0, c, 0, o],
				[0, 0, c, o]
			];
		}
		case 'gains':
			return [
				[step.r, 0, 0, 0],
				[0, step.g, 0, 0],
				[0, 0, step.b, 0]
			];
		case 'saturate': {
			const s = step.amount;
			return [
				[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0],
				[0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0],
				[0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0]
			];
		}
		case 'hue-rotate': {
			const a = (step.degrees * Math.PI) / 180;
			const cos = Math.cos(a);
			const sin = Math.sin(a);
			return [
				[0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928, 0],
				[0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283, 0],
				[0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072, 0]
			];
		}
	}
}

/**
 * An RGB colour (0–255 each) through a grade, as the preview and export draw it. A grade's LUT is
 * applied when its table is passed as `lut` (else it is left out).
 */
export function applyVideoGrade(grade: VideoGrade | undefined, rgb: readonly [number, number, number], lut?: VideoLut | null): [number, number, number] {
	let v = rgb.map((x) => x / 255);
	for (const step of videoGradeSteps(grade)) {
		const m = videoGradeStepMatrix(step);
		v = m.map((row) => Math.min(1, Math.max(0, row[0] * v[0] + row[1] * v[1] + row[2] * v[2] + row[3])));
	}
	const setting = normalizeVideoGradeLut(grade?.lut);
	if (setting && lut) {
		const out = applyVideoLut(lut, v as [number, number, number]);
		const s = setting.strength ?? 1;
		v = v.map((x, k) => x + (out[k] - x) * s);
	}
	return v.map((x) => Math.round(x * 255)) as [number, number, number];
}

const fmt = (v: number) => String(Math.round(v * 1e5) / 1e5);

/** The `values` of an SVG `feColorMatrix type="matrix"` for a step. */
export function videoGradeStepSvgValues(step: VideoGradeStep): string {
	return videoGradeStepMatrix(step)
		.map((row) => [row[0], row[1], row[2], 0, row[3]].map(fmt).join(' '))
		.concat('0 0 0 1 0')
		.join(' ');
}

/**
 * SVG filter primitives approximating a LUT (see `videoLutSvgApproximation`) on the result of the
 * primitives before them, mixed with it by `strength`.
 */
export function videoLutSvgPrimitives(lut: VideoLut, strength = 1): string {
	const { tables, matrix } = videoLutSvgApproximation(lut);
	const table = (k: number) => tables[k].map(fmt).join(' ');
	const values = matrix.map((row) => [row[0], row[1], row[2], 0, row[3]].map(fmt).join(' ')).concat('0 0 0 1 0').join(' ');
	const s = Math.min(1, Math.max(0, strength));
	return (
		'<feComponentTransfer result="lutIn"><feFuncA type="identity"/></feComponentTransfer>' +
		`<feComponentTransfer><feFuncR type="table" tableValues="${table(0)}"/><feFuncG type="table" tableValues="${table(1)}"/><feFuncB type="table" tableValues="${table(2)}"/></feComponentTransfer>` +
		`<feColorMatrix type="matrix" values="${values}"/>` +
		(s < 1 ? `<feComposite in2="lutIn" operator="arithmetic" k1="0" k2="${fmt(s)}" k3="${fmt(1 - s)}" k4="0"/>` : '')
	);
}

/**
 * An SVG `<filter>` applying a grade, steps in order (each clamps, as CSS filters do). With the
 * grade's LUT table (`lut`), an approximation of it follows (SVG has no 3D tables).
 */
export function videoGradeSvgFilter(id: string, grade: VideoGrade | undefined, lut?: VideoLut | null): string {
	const steps = videoGradeSteps(grade);
	const setting = normalizeVideoGradeLut(grade?.lut);
	return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${steps.map((s) => `<feColorMatrix type="matrix" values="${videoGradeStepSvgValues(s)}"/>`).join('')}${setting && lut ? videoLutSvgPrimitives(lut, setting.strength) : ''}</filter>`;
}

/** Id of the SVG filter for a white-balance step: the same gains always get the same id. */
export const videoGradeGainsFilterId = (step: Extract<VideoGradeStep, { kind: 'gains' }>): string => `pixerate-wb-${[step.r, step.g, step.b].map((v) => Math.round(v * 1000)).join('-')}`;

/**
 * A grade as a CSS / canvas `filter`: CSS functions for every step, and `url(#id)` for white balance,
 * which CSS has no function for (see `videoGradeGainsFilterId`; the host puts that filter in the page).
 * `''` when the grade changes nothing.
 */
export function videoGradeCssFilter(grade: VideoGrade | undefined): string {
	return videoGradeSteps(grade)
		.map((s) => (s.kind === 'brightness' ? `brightness(${fmt(s.amount)})` : s.kind === 'contrast' ? `contrast(${fmt(s.amount)})` : s.kind === 'saturate' ? `saturate(${fmt(s.amount)})` : s.kind === 'hue-rotate' ? `hue-rotate(${fmt(s.degrees)}deg)` : `url(#${videoGradeGainsFilterId(s)})`))
		.join(' ');
}

/** The white-balance SVG filters a grade's CSS filter refers to, as `{ id, markup }`. */
export function videoGradeSvgDefs(grade: VideoGrade | undefined): { id: string; markup: string }[] {
	return videoGradeSteps(grade)
		.filter((s): s is Extract<VideoGradeStep, { kind: 'gains' }> => s.kind === 'gains')
		.map((s) => {
			const id = videoGradeGainsFilterId(s);
			return { id, markup: `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${videoGradeStepSvgValues(s)}"/></filter>` };
		});
}

/** A grade as ffmpeg filters on RGB, in order: `lutrgb` for exposure and contrast, `colorchannelmixer` for the rest. */
export function videoGradeFfmpegFilters(grade: VideoGrade | undefined): string[] {
	return videoGradeSteps(grade).map((step) => {
		const m = videoGradeStepMatrix(step);
		if (step.kind === 'brightness' || step.kind === 'contrast') {
			const lut = (i: number) => `clip(val*${fmt(m[i][i])}+${fmt(m[i][3] * 255)},0,255)`;
			return `lutrgb=r='${lut(0)}':g='${lut(1)}':b='${lut(2)}'`;
		}
		const k = ['r', 'g', 'b'];
		return `colorchannelmixer=${m.flatMap((row, i) => row.slice(0, 3).map((v, j) => `${k[i]}${k[j]}=${fmt(v)}`)).join(':')}`;
	});
}
