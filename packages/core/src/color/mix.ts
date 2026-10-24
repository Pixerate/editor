/**
 * Colour mixing in OKLab (default), OKLCH, sRGB or linear sRGB with premultiplied alpha.
 */

import { parseColor } from './parse.js';
import { formatHex } from './format.js';
import {
	rgbToOklab,
	oklabToRgb,
	oklabToOklch,
	oklchToOklab,
	srgbToLinear,
	linearToSrgb
} from './convert.js';

export interface MixColorsOptions {
	space?: 'oklab' | 'oklch' | 'srgb' | 'srgb-linear';
}

/**
 * Mixes two colours at position t (0 = from, 1 = to) with premultiplied alpha.
 * Returns null if either colour cannot be parsed.
 */
export function mixColors(
	from: unknown,
	to: unknown,
	t: number,
	options: MixColorsOptions = {}
): string | null {
	const c1 = parseColor(from);
	const c2 = parseColor(to);
	if (!c1 || !c2) return null;

	const space = options.space ?? 'oklab';
	const alpha = c1.a + (c2.a - c1.a) * t;

	if (space === 'oklab') {
		const lab1 = rgbToOklab(c1);
		const lab2 = rgbToOklab(c2);
		if (alpha <= 1e-9) {
			const lab = { l: lab1.l + (lab2.l - lab1.l) * t, a: 0, b: 0, alpha: 0 };
			return formatHex(oklabToRgb(lab));
		}
		const premul = (k: 'l' | 'a' | 'b') =>
			lab1[k] * lab1.alpha + (lab2[k] * lab2.alpha - lab1[k] * lab1.alpha) * t;
		const lab = {
			l: premul('l') / alpha,
			a: premul('a') / alpha,
			b: premul('b') / alpha,
			alpha
		};
		return formatHex(oklabToRgb(lab));
	}

	if (space === 'oklch') {
		const lch1 = oklabToOklch(rgbToOklab(c1));
		const lch2 = oklabToOklch(rgbToOklab(c2));

		let h1 = lch1.h;
		let h2 = lch2.h;
		const diff = h2 - h1;
		if (diff > 180) h2 -= 360;
		else if (diff < -180) h2 += 360;
		const h = (((h1 + (h2 - h1) * t) % 360) + 360) % 360;

		if (alpha <= 1e-9) {
			const l = lch1.l + (lch2.l - lch1.l) * t;
			return formatHex(oklabToRgb(oklchToOklab({ l, c: 0, h: 0, alpha: 0 })));
		}

		const lPremul = lch1.l * lch1.alpha + (lch2.l * lch2.alpha - lch1.l * lch1.alpha) * t;
		const cPremul = lch1.c * lch1.alpha + (lch2.c * lch2.alpha - lch1.c * lch1.alpha) * t;
		const l = lPremul / alpha;
		const c = cPremul / alpha;

		return formatHex(oklabToRgb(oklchToOklab({ l, c, h, alpha })));
	}

	if (space === 'srgb-linear') {
		const lr1 = srgbToLinear(c1.r);
		const lg1 = srgbToLinear(c1.g);
		const lb1 = srgbToLinear(c1.b);
		const lr2 = srgbToLinear(c2.r);
		const lg2 = srgbToLinear(c2.g);
		const lb2 = srgbToLinear(c2.b);

		if (alpha <= 1e-9) {
			return formatHex({
				r: linearToSrgb(lr1 + (lr2 - lr1) * t),
				g: linearToSrgb(lg1 + (lg2 - lg1) * t),
				b: linearToSrgb(lb1 + (lb2 - lb1) * t),
				a: 0
			});
		}

		const premulR = lr1 * c1.a + (lr2 * c2.a - lr1 * c1.a) * t;
		const premulG = lg1 * c1.a + (lg2 * c2.a - lg1 * c1.a) * t;
		const premulB = lb1 * c1.a + (lb2 * c2.a - lb1 * c1.a) * t;

		return formatHex({
			r: linearToSrgb(premulR / alpha),
			g: linearToSrgb(premulG / alpha),
			b: linearToSrgb(premulB / alpha),
			a: alpha
		});
	}

	// 'srgb'
	if (alpha <= 1e-9) {
		return formatHex({
			r: c1.r + (c2.r - c1.r) * t,
			g: c1.g + (c2.g - c1.g) * t,
			b: c1.b + (c2.b - c1.b) * t,
			a: 0
		});
	}
	const premulR = c1.r * c1.a + (c2.r * c2.a - c1.r * c1.a) * t;
	const premulG = c1.g * c1.a + (c2.g * c2.a - c1.g * c1.a) * t;
	const premulB = c1.b * c1.a + (c2.b * c2.a - c1.b * c1.a) * t;

	return formatHex({
		r: premulR / alpha,
		g: premulG / alpha,
		b: premulB / alpha,
		a: alpha
	});
}
