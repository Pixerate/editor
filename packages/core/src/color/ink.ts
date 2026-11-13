/**
 * "Which text colour reads on this fill" (#797): one helper for the editors that put text on a
 * coloured background (chart labels, spreadsheet conditional formats, house-style fixes).
 */
import { contrastRatio, relativeLuminance } from './contrast.js';
import { isDualColor, resolveColor, type ColorScheme, type DualColor } from './dual.js';
import { parseColor } from './parse.js';
import type { Rgba } from './types.js';

/** A colour as the helpers take it: CSS text, an `Rgba`, or a light / dark pair. */
export type InkColor = string | Rgba | DualColor;

const isRgba = (v: unknown): v is Rgba => typeof v === 'object' && v !== null && typeof (v as Rgba).r === 'number' && typeof (v as Rgba).g === 'number' && typeof (v as Rgba).b === 'number';

/** `value` as `Rgba`, or `null` when it cannot be read. A dual colour takes `scheme` (default light). */
function read(value: InkColor, scheme: ColorScheme): Rgba | null {
	if (isRgba(value)) return { r: value.r, g: value.g, b: value.b, a: typeof value.a === 'number' ? value.a : 1 };
	if (isDualColor(value)) {
		const resolved = resolveColor(value, scheme);
		return resolved ? parseColor(resolved) : null;
	}
	return typeof value === 'string' ? parseColor(value) : null;
}

/**
 * The WCAG 2 contrast ratio between two colours, 1 to 21 (a translucent colour is judged over the
 * other, and a translucent background over white), or `null` when either cannot be read.
 */
export function contrast(a: InkColor, b: InkColor, options: { scheme?: ColorScheme } = {}): number | null {
	const scheme = options.scheme ?? 'light';
	const fg = read(a, scheme);
	const bg = read(b, scheme);
	return fg && bg ? contrastRatio(fg, bg) : null;
}

export interface InkOptions {
	/** Ink for dark fills (default `#ffffff`). */
	light?: InkColor;
	/** Ink for light fills (default `#111111`). */
	dark?: InkColor;
	/**
	 * Decide by brightness instead of contrast: `dark` when the fill's luminance is above this
	 * (0–1), else `light`.
	 */
	threshold?: number;
	/**
	 * The luminance `threshold` compares: `wcag` (relative luminance, the default) or `bt601`
	 * (perceived brightness of the sRGB values, 0.299 R + 0.587 G + 0.114 B).
	 */
	luminance?: 'wcag' | 'bt601';
	/** Scheme for dual colours (default light). */
	scheme?: ColorScheme;
}

const asText = (v: InkColor, scheme: ColorScheme): string => (typeof v === 'string' ? v : isDualColor(v) ? (resolveColor(v, scheme) ?? '') : `rgb(${Math.round(v.r * 255)} ${Math.round(v.g * 255)} ${Math.round(v.b * 255)})`);

/**
 * Which ink reads on `fill`: `dark` when it contrasts at least as much as `light` (or, with
 * `threshold`, when the fill is brighter than that), else `light`; `undefined` when a colour
 * cannot be read (a CSS variable).
 */
export function inkSide(fill: InkColor, options: InkOptions = {}): 'dark' | 'light' | undefined {
	const scheme = options.scheme ?? 'light';
	const f = read(fill, scheme);
	if (!f) return undefined;
	if (options.threshold !== undefined) {
		const y = options.luminance === 'bt601' ? 0.299 * f.r + 0.587 * f.g + 0.114 * f.b : relativeLuminance(f);
		return y > options.threshold ? 'dark' : 'light';
	}
	const darkRgba = read(options.dark ?? '#111111', scheme);
	const lightRgba = read(options.light ?? '#ffffff', scheme);
	if (!darkRgba || !lightRgba) return undefined;
	return contrastRatio(darkRgba, f) >= contrastRatio(lightRgba, f) ? 'dark' : 'light';
}

/**
 * The text colour that reads on `fill`: whichever of `dark` (default `#111111`) and `light`
 * (default `#ffffff`) contrasts more with it, dark on a tie; with `threshold`, `dark` when the
 * fill is brighter than that. `undefined` when the fill cannot be read (a CSS variable). The ink
 * comes back as given (a dual ink resolved to `scheme`; an `Rgba` as `rgb(...)`).
 */
export function ink(fill: InkColor, options: InkOptions = {}): string | undefined {
	const side = inkSide(fill, options);
	if (!side) return undefined;
	const scheme = options.scheme ?? 'light';
	return asText(side === 'dark' ? (options.dark ?? '#111111') : (options.light ?? '#ffffff'), scheme);
}
