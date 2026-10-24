import { describe, it, expect } from 'vitest';
import {
	pickerStateFromColor,
	pickerStateToHex,
	pickerStateFromArea,
	pickerStateFromHue,
	pickerStateFromAlpha,
	pickerKeyStep,
	pickerAreaBackground,
	pickerAlphaBackground,
	PICKER_HUE_BACKGROUND,
	type ColorPickerState
} from '../src/color';

describe('headless color picker model', () => {
	it('converts valid color string to picker state and back to hex', () => {
		const state = pickerStateFromColor('#3b82f6')!;
		expect(state).toBeDefined();
		expect(state.alpha).toBe(1);
		expect(Math.round(state.h)).toBe(217);
		expect(Math.round(state.s * 100)).toBe(76);
		expect(Math.round(state.v * 100)).toBe(96);

		const hex = pickerStateToHex(state);
		expect(hex.toLowerCase()).toBe('#3b82f6');
	});

	it('preserves hue and saturation memory for greys and blacks', () => {
		const blueState: ColorPickerState = { h: 217, s: 0.8, v: 0.9, alpha: 1 };

		// Drag to pure black (#000000)
		const blackState = pickerStateFromColor('#000000', blueState)!;
		expect(blackState.v).toBe(0);
		// Retains hue and saturation from blueState
		expect(blackState.h).toBe(217);
		expect(blackState.s).toBe(0.8);

		// Drag to pure white (#ffffff)
		const whiteState = pickerStateFromColor('#ffffff', blueState)!;
		expect(whiteState.v).toBe(1);
		expect(whiteState.s).toBe(0);
		// Retains hue from blueState
		expect(whiteState.h).toBe(217);
	});

	it('updates state from 2D area coordinates correctly', () => {
		const initial: ColorPickerState = { h: 180, s: 0.5, v: 0.5, alpha: 1 };

		// Top-right corner (x=1, y=0) -> saturation=1, value=1
		const topRight = pickerStateFromArea(initial, 1, 0);
		expect(topRight.s).toBe(1);
		expect(topRight.v).toBe(1);
		expect(topRight.h).toBe(180);

		// Bottom-left corner (x=0, y=1) -> saturation=0, value=0
		const bottomLeft = pickerStateFromArea(initial, 0, 1);
		expect(bottomLeft.s).toBe(0);
		expect(bottomLeft.v).toBe(0);

		// Clamping outside bounds
		const clamped = pickerStateFromArea(initial, 1.5, -0.5);
		expect(clamped.s).toBe(1);
		expect(clamped.v).toBe(1);
	});

	it('updates state from hue and alpha sliders', () => {
		const initial: ColorPickerState = { h: 0, s: 1, v: 1, alpha: 1 };

		const halfHue = pickerStateFromHue(initial, 0.5);
		expect(halfHue.h).toBe(180);

		const halfAlpha = pickerStateFromAlpha(initial, 0.5);
		expect(halfAlpha.alpha).toBe(0.5);
	});

	describe('pickerKeyStep', () => {
		const state: ColorPickerState = { h: 100, s: 0.5, v: 0.5, alpha: 0.5 };

		it('steps area left/right (saturation) and down/up (value)', () => {
			const right = pickerKeyStep(state, 'area', 'ArrowRight', false)!;
			expect(right.s).toBeCloseTo(0.51);

			const rightShift = pickerKeyStep(state, 'area', 'ArrowRight', true)!;
			expect(rightShift.s).toBeCloseTo(0.6);

			const up = pickerKeyStep(state, 'area', 'ArrowUp', false)!;
			expect(up.v).toBeCloseTo(0.51);

			const home = pickerKeyStep(state, 'area', 'Home', false)!;
			expect(home.s).toBe(0);
			expect(home.v).toBe(1);

			const end = pickerKeyStep(state, 'area', 'End', false)!;
			expect(end.s).toBe(1);
			expect(end.v).toBe(0);
		});

		it('steps hue with 1° / 10° steps', () => {
			const right = pickerKeyStep(state, 'hue', 'ArrowRight', false)!;
			expect(right.h).toBe(101);

			const rightShift = pickerKeyStep(state, 'hue', 'ArrowRight', true)!;
			expect(rightShift.h).toBe(110);

			const leftWrap = pickerKeyStep({ ...state, h: 5 }, 'hue', 'ArrowLeft', true)!;
			expect(leftWrap.h).toBe(355);
		});

		it('steps alpha with 1% / 10% steps', () => {
			const up = pickerKeyStep(state, 'alpha', 'ArrowUp', false)!;
			expect(up.alpha).toBeCloseTo(0.51);

			const downShift = pickerKeyStep(state, 'alpha', 'ArrowDown', true)!;
			expect(downShift.alpha).toBeCloseTo(0.4);
		});

		it('returns null for unhandled keys', () => {
			expect(pickerKeyStep(state, 'area', 'Enter', false)).toBeNull();
			expect(pickerKeyStep(state, 'hue', 'Space', false)).toBeNull();
		});
	});

	it('generates CSS backgrounds', () => {
		const state: ColorPickerState = { h: 0, s: 1, v: 1, alpha: 1 };
		const areaBg = pickerAreaBackground(state);
		expect(areaBg).toContain('linear-gradient');
		expect(areaBg).toContain('#ff0000');

		const alphaBg = pickerAlphaBackground(state);
		expect(alphaBg).toContain('linear-gradient(to right, transparent, #ff0000)');

		expect(PICKER_HUE_BACKGROUND).toContain('linear-gradient(to right');
	});

	it('round-trips 50 seeded hex colours', () => {
		// Linear congruential generator for reproducible pseudo-random hex colors
		let seed = 42;
		const rand = () => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return seed / 4294967296;
		};

		for (let i = 0; i < 50; i++) {
			const r = Math.floor(rand() * 256).toString(16).padStart(2, '0');
			const g = Math.floor(rand() * 256).toString(16).padStart(2, '0');
			const b = Math.floor(rand() * 256).toString(16).padStart(2, '0');
			const hex = `#${r}${g}${b}`;

			const state = pickerStateFromColor(hex)!;
			expect(state, `parsed ${hex}`).toBeDefined();
			const resultHex = pickerStateToHex(state);
			expect(resultHex.toLowerCase(), `round-trip ${hex}`).toBe(hex.toLowerCase());
		}
	});
});
