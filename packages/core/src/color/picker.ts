/**
 * Pure, headless colour picker state and interaction model.
 * DOM-free: shared across React and Svelte bindings.
 */

import { parseColor } from './parse.js';
import { rgbToHsv, hsvToRgb } from './convert.js';
import { formatHex } from './format.js';
import { toSrgbGamut } from './gamut.js';
import { normalizeDualColor, type ColorValue, type ColorScheme } from './dual.js';

export interface ColorPickerState {
	/** Hue angle: 0 <= h < 360 */
	h: number;
	/** Saturation: 0 <= s <= 1 */
	s: number;
	/** Value / brightness: 0 <= v <= 1 */
	v: number;
	/** Alpha: 0 <= alpha <= 1 */
	alpha: number;
}

const clamp = (val: number, min: number, max: number): number => Math.max(min, Math.min(max, val));

/**
 * Derives picker state from any CSS colour string or existing state.
 * Preserves hue and saturation from `previous` when the new colour is achromatic
 * (grey or black), preventing sudden hue jumps when dragging near 0.
 */
export function pickerStateFromColor(input: unknown, previous?: ColorPickerState): ColorPickerState | null {
	if (input === null || input === undefined) return null;

	let rgba;
	if (typeof input === 'object' && 'r' in (input as any) && 'g' in (input as any) && 'b' in (input as any)) {
		rgba = input as any;
	} else if (typeof input === 'string') {
		rgba = parseColor(input);
	} else {
		return null;
	}

	if (!rgba) return null;

	const clampedRgba = toSrgbGamut(rgba);
	const hsva = rgbToHsv(clampedRgba);

	let h = hsva.h;
	let s = hsva.s;
	const v = hsva.v;
	const alpha = rgba.a ?? 1;

	if (previous) {
		// When brightness is zero (black), preserve previous h and s
		if (v <= 0.0001) {
			h = previous.h;
			s = previous.s;
		}
		// When saturation is zero (grey/white), preserve previous h
		else if (s <= 0.0001) {
			h = previous.h;
		}
	}

	return {
		h: clamp(h, 0, 360) % 360,
		s: clamp(s, 0, 1),
		v: clamp(v, 0, 1),
		alpha: clamp(alpha, 0, 1)
	};
}

/** Formats current picker state as a hex string (#rrggbb or #rrggbbaa). */
export function pickerStateToHex(state: ColorPickerState, forceAlpha = false): string {
	const rgba = hsvToRgb({
		h: state.h,
		s: state.s,
		v: state.v,
		alpha: state.alpha
	});
	const hex = formatHex(rgba);
	if (forceAlpha && hex.length === 7) {
		return hex + 'ff';
	}
	return hex;
}

/** Updates saturation (x) and value (y) from normalized coordinates (0..1). */
export function pickerStateFromArea(state: ColorPickerState, x: number, y: number): ColorPickerState {
	return {
		...state,
		s: clamp(x, 0, 1),
		v: clamp(1 - y, 0, 1)
	};
}

/** Updates hue from a normalized position t (0..1 -> 0..360°). */
export function pickerStateFromHue(state: ColorPickerState, t: number): ColorPickerState {
	const clampedT = clamp(t, 0, 1);
	const h = clampedT >= 1 ? 0 : clampedT * 360;
	return {
		...state,
		h
	};
}

/** Updates alpha from a normalized position t (0..1). */
export function pickerStateFromAlpha(state: ColorPickerState, t: number): ColorPickerState {
	return {
		...state,
		alpha: clamp(t, 0, 1)
	};
}

/**
 * Handles keyboard interaction for the 2D area, hue slider, and alpha slider.
 * Arrow keys step by 1% (or 1° for hue), with Shift multiplying by 10.
 * Home/End jump to min/max.
 * Returns null if the key is not handled.
 */
export function pickerKeyStep(
	state: ColorPickerState,
	target: 'area' | 'hue' | 'alpha',
	key: string,
	shift: boolean
): ColorPickerState | null {
	const step = shift ? 0.1 : 0.01;
	const hueStep = shift ? 10 : 1;

	switch (target) {
		case 'area': {
			if (key === 'ArrowLeft') {
				return { ...state, s: clamp(state.s - step, 0, 1) };
			}
			if (key === 'ArrowRight') {
				return { ...state, s: clamp(state.s + step, 0, 1) };
			}
			if (key === 'ArrowDown') {
				return { ...state, v: clamp(state.v - step, 0, 1) };
			}
			if (key === 'ArrowUp') {
				return { ...state, v: clamp(state.v + step, 0, 1) };
			}
			if (key === 'Home') {
				return { ...state, s: 0, v: 1 };
			}
			if (key === 'End') {
				return { ...state, s: 1, v: 0 };
			}
			return null;
		}
		case 'hue': {
			if (key === 'ArrowLeft' || key === 'ArrowDown') {
				const nextH = (state.h - hueStep + 360) % 360;
				return { ...state, h: nextH };
			}
			if (key === 'ArrowRight' || key === 'ArrowUp') {
				const nextH = (state.h + hueStep) % 360;
				return { ...state, h: nextH };
			}
			if (key === 'Home') {
				return { ...state, h: 0 };
			}
			if (key === 'End') {
				return { ...state, h: 359 };
			}
			return null;
		}
		case 'alpha': {
			if (key === 'ArrowLeft' || key === 'ArrowDown') {
				return { ...state, alpha: clamp(state.alpha - step, 0, 1) };
			}
			if (key === 'ArrowRight' || key === 'ArrowUp') {
				return { ...state, alpha: clamp(state.alpha + step, 0, 1) };
			}
			if (key === 'Home') {
				return { ...state, alpha: 0 };
			}
			if (key === 'End') {
				return { ...state, alpha: 1 };
			}
			return null;
		}
		default:
			return null;
	}
}

/** CSS background for the 2D area (white-to-transparent horizontal and transparent-to-black vertical over pure hue). */
export function pickerAreaBackground(state: ColorPickerState): string {
	const pureHueRgb = hsvToRgb({ h: state.h, s: 1, v: 1, alpha: 1 });
	const hueHex = formatHex(pureHueRgb);
	return `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})`;
}

/** CSS background for the alpha strip gradient (transparent to opaque colour). */
export function pickerAlphaBackground(state: ColorPickerState): string {
	const opaqueRgb = hsvToRgb({ h: state.h, s: state.s, v: state.v, alpha: 1 });
	const hex = formatHex(opaqueRgb);
	return `linear-gradient(to right, transparent, ${hex})`;
}

/** CSS background gradient through all hues across the 360° spectrum. */
export const PICKER_HUE_BACKGROUND: string =
	'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)';

/**
 * Computes the view information for editing a dual colour in a picker for the given scheme.
 * Returns the colour for the active scheme, whether both halves are identical ('linked'),
 * and the other scheme's colour.
 */
export function dualPickerView(
	value: ColorValue,
	scheme: ColorScheme
): { color: string; linked: boolean; other: string } {
	const norm = normalizeDualColor(value) ?? { light: '#000000', dark: '#000000' };
	const otherScheme: ColorScheme = scheme === 'light' ? 'dark' : 'light';
	return {
		color: norm[scheme],
		linked: norm.light === norm.dark,
		other: norm[otherScheme]
	};
}
