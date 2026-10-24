// Portions ported from gridcraft-main/crates/chart/src/resolve.rs (palette tint cycle) and
// crates/chart/src/render.rs (`on`: label colour from the fill), and designcraft-main/crates/color/src/cms/mod.rs
// (`simulate_cvd`, Machado–Oliveira–Fernandes 2009 matrices) (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.

import {
	rgbToOklab as coreRgbToOklab,
	deltaEOK,
	simulateColorVision as coreSimulateColorVision,
	relativeLuminance,
	contrastRatio as coreContrastRatio,
	srgbToLinear,
	linearToSrgb
} from '../color/index.js';

/** An sRGB colour with channels from 0 to 1. */
export type ChartRgb = [number, number, number];

const NAMED: Record<string, string> = {
	black: '#000000',
	white: '#ffffff',
	red: '#ff0000',
	green: '#008000',
	blue: '#0000ff',
	yellow: '#ffff00',
	orange: '#ffa500',
	purple: '#800080',
	gray: '#808080',
	grey: '#808080',
	teal: '#008080',
	navy: '#000080',
	maroon: '#800000',
	olive: '#808000',
	silver: '#c0c0c0',
	lime: '#00ff00',
	aqua: '#00ffff',
	cyan: '#00ffff',
	fuchsia: '#ff00ff',
	magenta: '#ff00ff',
	pink: '#ffc0cb',
	brown: '#a52a2a'
};

/**
 * Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` and a few colour names. Returns
 * `null` for anything else (CSS variables, `hsl()`, …), so callers can leave such colours alone.
 */
export function parseChartColor(color: string): ChartRgb | null {
	const text = color.trim().toLowerCase();
	const hex = NAMED[text] ?? text;
	let m = /^#([0-9a-f]{3})$/.exec(hex);
	if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255) as ChartRgb;
	m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(hex);
	if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255) as ChartRgb;
	m = /^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+[\d.]+%?)?\s*\)$/.exec(text);
	if (m) {
		const pct = text.includes('%');
		return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(1, Number(v) / (pct ? 100 : 255)))) as ChartRgb;
	}
	return null;
}

export function chartRgbToHex(rgb: ChartRgb): string {
	return `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A lighter (`amount` > 0, towards white) or darker (`amount` < 0, towards black) shade of
 * `color`. Colours it cannot read (CSS variables) come back unchanged.
 */
export function shadeChartColor(color: string, amount: number): string {
	const rgb = parseChartColor(color);
	if (!rgb || !amount) return color;
	const t = Math.max(-1, Math.min(1, amount));
	return chartRgbToHex(rgb.map((c) => (t > 0 ? c + (1 - c) * t : c * (1 + t))) as ChartRgb);
}

/** Shades used once a palette is used up: the same hues, lighter then darker (GridCraft's cycle). */
export const CHART_PALETTE_SHADES: readonly number[] = [0, 0.4, -0.25, 0.6, -0.5, 0.2];

/** The palette colour for the `index`-th item: the palette in order, then lighter and darker rounds of it. */
export function cyclePaletteColor(palette: readonly string[], index: number): string {
	const base = palette[index % palette.length];
	const round = Math.floor(index / palette.length) % CHART_PALETTE_SHADES.length;
	return shadeChartColor(base, CHART_PALETTE_SHADES[round]);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** WCAG relative luminance (0 black – 1 white). */
export function chartLuminance(rgb: ChartRgb): number {
	const [r, g, b] = rgb.map(toLinear);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1–21) between two colours, or `null` when either cannot be read. */
export function chartContrastRatio(a: string, b: string): number | null {
	const ra = parseChartColor(a);
	const rb = parseChartColor(b);
	if (!ra || !rb) return null;
	const la = chartLuminance(ra);
	const lb = chartLuminance(rb);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Dark or white text, whichever reads better on `fill`; `fallback` when the fill cannot be
 * read (a CSS variable).
 */
export function chartTextOn(fill: string, fallback: string, dark = '#0f172a', light = '#ffffff'): string {
	const rgb = parseChartColor(fill);
	if (!rgb) return fallback;
	const darkRatio = chartContrastRatio(fill, dark)!;
	const lightRatio = chartContrastRatio(fill, light)!;
	return darkRatio >= lightRatio ? dark : light;
}

/** OKLab (Ottosson) from sRGB. */
export function chartRgbToOklab(rgb: ChartRgb): [number, number, number] {
	const lab = coreRgbToOklab({ r: rgb[0], g: rgb[1], b: rgb[2], a: 1 });
	return [lab.l, lab.a, lab.b];
}

/** Perceptual distance between two colours (Euclidean in OKLab; ≈0.02 is just noticeable). */
export function chartColorDistance(a: ChartRgb, b: ChartRgb): number {
	return deltaEOK(
		{ r: a[0], g: a[1], b: a[2], a: 1 },
		{ r: b[0], g: b[1], b: b[2], a: 1 }
	);
}

export type ChartVision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia';

/** How a colour looks with a colour-vision deficiency (Machado et al. 2009, full severity). */
export function simulateChartVision(rgb: ChartRgb, vision: ChartVision): ChartRgb {
	if (vision === 'normal') return rgb;
	const c = coreSimulateColorVision({ r: rgb[0], g: rgb[1], b: rgb[2], a: 1 }, vision);
	return [c.r, c.g, c.b];
}

export interface ChartColorPair {
	a: number;
	b: number;
	colors: [string, string];
	distance: number;
}

export interface ChartColorCheck {
	/** No problems found. */
	ok: boolean;
	/** Per vision: the closest pair of colours and their OKLab distance. */
	closest: Partial<Record<ChartVision, ChartColorPair>>;
	/** Contrast ratio of each colour against the surface (null when unreadable). */
	contrast: (number | null)[];
	/** Problems, as sentences. */
	issues: string[];
	/** Colours that could not be read (CSS variables, `hsl()`); they are skipped. */
	skipped: string[];
}

export interface ChartColorCheckOptions {
	/** The page colour behind the marks (default white). */
	surface?: string;
	/** Smallest OKLab distance two series may have (default 0.08). */
	minDistance?: number;
	/** Smallest contrast ratio against the surface (default 1.5; WCAG asks 3 for graphics). */
	minContrast?: number;
	/** Visions to check (default all four). */
	visions?: readonly ChartVision[];
}

/**
 * Checks that series colours can be told apart, with normal vision and the three
 * colour-vision deficiencies, and stand out from the surface. Returns the closest pair per
 * vision and problems as sentences.
 */
export function checkChartColors(colors: readonly string[], options: ChartColorCheckOptions = {}): ChartColorCheck {
	const surface = options.surface ?? '#ffffff';
	const minDistance = options.minDistance ?? 0.08;
	const minContrast = options.minContrast ?? 1.5;
	const visions = options.visions ?? (['normal', 'protanopia', 'deuteranopia', 'tritanopia'] as const);
	const parsed = colors.map(parseChartColor);
	const skipped = colors.filter((_, i) => !parsed[i]);
	const issues: string[] = [];
	const closest: ChartColorCheck['closest'] = {};
	for (const vision of visions) {
		const seen = parsed.map((c) => (c ? simulateChartVision(c, vision) : null));
		let best: ChartColorPair | undefined;
		for (let a = 0; a < seen.length; a++) {
			for (let b = a + 1; b < seen.length; b++) {
				if (!seen[a] || !seen[b]) continue;
				const distance = chartColorDistance(seen[a]!, seen[b]!);
				if (!best || distance < best.distance) best = { a, b, colors: [colors[a], colors[b]], distance: Math.round(distance * 1000) / 1000 };
			}
		}
		if (best) {
			closest[vision] = best;
			if (best.distance < minDistance) {
				const who = vision === 'normal' ? '' : ` with ${vision}`;
				issues.push(`Colours ${best.a + 1} (${best.colors[0]}) and ${best.b + 1} (${best.colors[1]}) are hard to tell apart${who} (distance ${best.distance}, want at least ${minDistance}).`);
			}
		}
	}
	const contrast = colors.map((c) => {
		const ratio = chartContrastRatio(c, surface);
		return ratio === null ? null : Math.round(ratio * 100) / 100;
	});
	contrast.forEach((ratio, i) => {
		if (ratio !== null && ratio < minContrast) issues.push(`Colour ${i + 1} (${colors[i]}) barely stands out from the background ${surface} (contrast ${ratio}:1, want at least ${minContrast}:1).`);
	});
	return { ok: issues.length === 0, closest, contrast, issues, skipped };
}
