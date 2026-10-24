// Portions ported from designcraft-main/crates/color/src/cms/mod.rs
// (`simulate_cvd`, Machado–Oliveira–Fernandes 2009 matrices) (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.

/**
 * Colour vision deficiency simulation (Machado et al. 2009) and palette accessibility checks.
 */

import { srgbToLinear, linearToSrgb } from './convert.js';
import { deltaEOK } from './gamut.js';
import { parseColor } from './parse.js';
import { contrastRatio } from './contrast.js';
import type { Rgba, ColorVision } from './types.js';

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const CVD: Record<Exclude<ColorVision, 'normal'>, readonly (readonly [number, number, number])[]> = {
	protanopia: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998]
	],
	deuteranopia: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881]
	],
	tritanopia: [
		[1.255528, -0.076749, -0.178779],
		[-0.078411, 0.930809, 0.147602],
		[0.004733, 0.691367, 0.3039]
	]
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Simulates how a colour appears under protanopia, deuteranopia or tritanopia. */
export function simulateColorVision(c: Rgba, vision: ColorVision): Rgba {
	if (vision === 'normal') return c;
	const lr = srgbToLinear(c.r);
	const lg = srgbToLinear(c.g);
	const lb = srgbToLinear(c.b);
	const m = CVD[vision];
	const r = linearToSrgb(clamp01(m[0][0] * lr + m[0][1] * lg + m[0][2] * lb));
	const g = linearToSrgb(clamp01(m[1][0] * lr + m[1][1] * lg + m[1][2] * lb));
	const b = linearToSrgb(clamp01(m[2][0] * lr + m[2][1] * lg + m[2][2] * lb));
	return { r, g, b, a: c.a };
}

export interface PaletteColorPair {
	a: number;
	b: number;
	colors: [string, string];
	distance: number;
}

export interface PaletteColorCheck {
	/** No problems found. */
	ok: boolean;
	/** Per vision: the closest pair of colours and their OKLab distance. */
	closest: Partial<Record<ColorVision, PaletteColorPair>>;
	/** Contrast ratio of each colour against the surface (null when unreadable). */
	contrast: (number | null)[];
	/** Problems, as sentences. */
	issues: string[];
	/** Colours that could not be read; they are skipped. */
	skipped: string[];
}

export interface PaletteColorCheckOptions {
	/** The background surface behind the marks (default '#ffffff'). */
	surface?: string;
	/** Smallest OKLab distance two colours may have (default 0.08). */
	minDistance?: number;
	/** Smallest contrast ratio against the surface (default 1.5). */
	minContrast?: number;
	/** Visions to check (default all four). */
	visions?: readonly ColorVision[];
}

/**
 * Checks that palette colours can be distinguished under normal vision and CVD modes,
 * and stand out from the surface background.
 */
export function checkPaletteColors(
	colors: readonly string[],
	options: PaletteColorCheckOptions = {}
): PaletteColorCheck {
	const surfaceStr = options.surface ?? '#ffffff';
	const minDistance = options.minDistance ?? 0.08;
	const minContrast = options.minContrast ?? 1.5;
	const visions = options.visions ?? (['normal', 'protanopia', 'deuteranopia', 'tritanopia'] as const);

	const parsed = colors.map((c) => parseColor(c));
	const surfaceParsed = parseColor(surfaceStr);
	const skipped = colors.filter((_, i) => !parsed[i]);
	const issues: string[] = [];
	const closest: PaletteColorCheck['closest'] = {};

	for (const vision of visions) {
		const seen = parsed.map((c) => (c ? simulateColorVision(c, vision) : null));
		let best: PaletteColorPair | undefined;
		for (let a = 0; a < seen.length; a++) {
			for (let b = a + 1; b < seen.length; b++) {
				if (!seen[a] || !seen[b]) continue;
				const distance = deltaEOK(seen[a]!, seen[b]!);
				if (!best || distance < best.distance) {
					best = {
						a,
						b,
						colors: [colors[a]!, colors[b]!],
						distance: Math.round(distance * 1000) / 1000
					};
				}
			}
		}
		if (best) {
			closest[vision] = best;
			if (best.distance < minDistance) {
				const who = vision === 'normal' ? '' : ` with ${vision}`;
				issues.push(
					`Colours ${best.a + 1} (${best.colors[0]}) and ${best.b + 1} (${best.colors[1]}) are hard to tell apart${who} (distance ${best.distance}, want at least ${minDistance}).`
				);
			}
		}
	}

	const contrast = colors.map((_, i) => {
		const c = parsed[i];
		if (!c || !surfaceParsed) return null;
		const ratio = contrastRatio(c, surfaceParsed);
		return Math.round(ratio * 100) / 100;
	});

	contrast.forEach((ratio, i) => {
		if (ratio !== null && ratio < minContrast) {
			issues.push(
				`Colour ${i + 1} (${colors[i]}) barely stands out from the background ${surfaceStr} (contrast ${ratio}:1, want at least ${minContrast}:1).`
			);
		}
	});

	return { ok: issues.length === 0, closest, contrast, issues, skipped };
}
