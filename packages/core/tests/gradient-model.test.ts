import { describe, it, expect } from 'vitest';
import {
	createGradient,
	normalizeGradient,
	gradientToCss,
	parseCssGradient,
	sampleGradient,
	insertGradientStop,
	updateGradientStop,
	removeGradientStop,
	reverseGradient,
	distributeGradientStops,
	gradientToSvgDef,
	checkGradient,
	isDualGradient,
	resolveGradient,
	GRADIENT_PRESETS
} from '../src/gradient/index.js';

describe('gradient model', () => {
	it('creates default linear gradient', () => {
		const g = createGradient();
		expect(g.type).toBe('linear');
		expect(g.angle).toBe(180);
		expect(g.stops).toHaveLength(2);
		expect(g.stops[0].offset).toBe(0);
		expect(g.stops[1].offset).toBe(1);
	});

	it('serializes to CSS and parses back', () => {
		const g = createGradient({
			type: 'linear',
			angle: 45,
			stops: [
				{ id: '1', color: '#ff0000', offset: 0 },
				{ id: '2', color: '#00ff00', offset: 0.5 },
				{ id: '3', color: '#0000ff', offset: 1 }
			]
		});
		const css = gradientToCss(g);
		expect(css).toMatch(/linear-gradient\((in oklab )?45deg/);
		expect(css).toContain('#ff0000 0%');
		expect(css).toContain('#0000ff 100%');

		const parsed = parseCssGradient(css);
		expect(parsed).not.toBeNull();
		expect(parsed!.type).toBe('linear');
		expect(parsed!.angle).toBe(45);
		expect(parsed!.stops).toHaveLength(3);
		expect(parsed!.stops[0].color).toBe('#ff0000');
		expect(parsed!.stops[2].color).toBe('#0000ff');
	});

	it('parses radial gradient with shape and center', () => {
		const css = 'radial-gradient(circle at 30% 70%, #fff 0%, #000 100%)';
		const parsed = parseCssGradient(css);
		expect(parsed).not.toBeNull();
		expect(parsed!.type).toBe('radial');
		expect(parsed!.shape).toBe('circle');
		expect(parsed!.center?.x).toBeCloseTo(0.3);
		expect(parsed!.center?.y).toBeCloseTo(0.7);
		expect(parsed!.stops).toHaveLength(2);
	});

	it('parses conic gradient with angle and center', () => {
		const css = 'conic-gradient(from 180deg at 50% 50%, #f00, #00f)';
		const parsed = parseCssGradient(css);
		expect(parsed).not.toBeNull();
		expect(parsed!.type).toBe('conic');
		expect(parsed!.angle).toBe(180);
		expect(parsed!.stops).toHaveLength(2);
	});

	it('samples color along gradient ramp', () => {
		const g = createGradient({
			type: 'linear',
			angle: 90,
			stops: [
				{ id: '1', color: '#000000', offset: 0 },
				{ id: '2', color: '#ffffff', offset: 1 }
			]
		});
		const start = sampleGradient(g, 0);
		expect(start).toBe('#000000');
		const end = sampleGradient(g, 1);
		expect(end).toBe('#ffffff');
		const mid = sampleGradient(g, 0.5);
		expect(mid).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it('inserts, updates and removes stops', () => {
		let g = createGradient({
			stops: [
				{ id: 's1', color: '#ff0000', offset: 0 },
				{ id: 's2', color: '#0000ff', offset: 1 }
			]
		});

		const { gradient: g2, stop } = insertGradientStop(g, 0.5, '#00ff00');
		expect(g2.stops).toHaveLength(3);
		expect(stop.color).toBe('#00ff00');
		expect(stop.offset).toBe(0.5);

		const g3 = updateGradientStop(g2, stop.id, { color: '#ffff00', offset: 0.6 });
		expect(g3.stops.find((s) => s.id === stop.id)?.color).toBe('#ffff00');
		expect(g3.stops.find((s) => s.id === stop.id)?.offset).toBe(0.6);

		const g4 = removeGradientStop(g3, stop.id);
		expect(g4.stops).toHaveLength(2);
		expect(() => removeGradientStop(g4, 's1')).toThrow(/at least 2 stops/);
	});

	it('reverses and distributes stops', () => {
		const g = createGradient({
			stops: [
				{ id: '1', color: '#ff0000', offset: 0.1 },
				{ id: '2', color: '#00ff00', offset: 0.2 },
				{ id: '3', color: '#0000ff', offset: 0.9 }
			]
		});
		const rev = reverseGradient(g);
		expect(rev.stops[0].color).toBe('#0000ff');
		expect(rev.stops[2].color).toBe('#ff0000');

		const dist = distributeGradientStops(g);
		expect(dist.stops[0].offset).toBe(0);
		expect(dist.stops[1].offset).toBe(0.5);
		expect(dist.stops[2].offset).toBe(1);
	});

	it('renders SVG defs', () => {
		const g = createGradient({ type: 'linear', angle: 90 });
		const svg = gradientToSvgDef(g, 'test-grad');
		expect(svg).toContain('<linearGradient id="test-grad"');
		expect(svg).toContain('<stop offset="0%"');
		expect(svg).toContain('<stop offset="100%"');

		const radial = createGradient({ type: 'radial', center: { x: 0.25, y: 0.75 } });
		const radialSvg = gradientToSvgDef(radial, 'radial-grad');
		expect(radialSvg).toContain('<radialGradient id="radial-grad"');
		expect(radialSvg).toContain('cx="25%"');
		expect(radialSvg).toContain('cy="75%"');
	});

	it('detects and resolves dual gradients', () => {
		const dual = createGradient({
			stops: [
				{ id: '1', color: 'light-dark(#ffffff, #000000)', offset: 0 },
				{ id: '2', color: 'light-dark(#eeeeee, #222222)', offset: 1 }
			]
		});
		expect(isDualGradient(dual)).toBe(true);
		const light = resolveGradient(dual, 'light');
		expect(isDualGradient(light)).toBe(false);
		expect(light.stops[0].color).toBe('#ffffff');

		const dark = resolveGradient(dual, 'dark');
		expect(dark.stops[0].color).toBe('#000000');
	});

	it('checks gradient for issues and contrast', () => {
		const crowded = createGradient({
			stops: [
				{ id: '1', color: '#ffffff', offset: 0.5 },
				{ id: '2', color: '#000000', offset: 0.501 }
			]
		});
		const res = checkGradient(crowded, { text: '#ffffff' });
		expect(res.issues.some((i) => i.includes('too close'))).toBe(true);
		expect(res.lowestTextContrast).toBeDefined();
	});

	it('provides built-in presets', () => {
		expect(Object.keys(GRADIENT_PRESETS).length).toBeGreaterThan(0);
		const sunset = GRADIENT_PRESETS.sunset;
		expect(sunset).toBeDefined();
		expect(sunset.stops.length).toBeGreaterThanOrEqual(2);
	});
});
