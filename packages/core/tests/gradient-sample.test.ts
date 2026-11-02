import { describe, expect, it } from 'vitest';
import { GradientController, createGradient, createGradientToolProvider, fitGradientStops, sampleGradientFromLine, simplifyGradientStops, type RawGradientSample } from '../src/gradient';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';
import { mixColors, parseColor, rgbToOklab } from '../src/color';

/** A seeded noise source (mulberry32). */
function rng(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** `n` samples of `color(t)` with ±`noise` bytes of grain per channel. */
function samples(n: number, color: (t: number) => string, noise = 0, seed = 1): RawGradientSample[] {
	const r = rng(seed);
	return Array.from({ length: n }, (_, i) => {
		const t = i / (n - 1);
		const c = parseColor(color(t))!;
		const g = () => (r() * 2 - 1) * noise;
		const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255 + g())));
		return { offset: t, color: [byte(c.r), byte(c.g), byte(c.b), 255] as const };
	});
}

const lab = (hex: string) => {
	const c = parseColor(hex)!;
	const o = rgbToOklab(c);
	return [o.l, o.a, o.b];
};
const deltaE = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

describe('simplifyGradientStops', () => {
	it('reduces a noisy two-colour ramp to exactly two stops at its ends', () => {
		const ramp = (t: number) => mixColors('#1d4ed8', '#f59e0b', t, { space: 'oklab' })!;
		const stops = simplifyGradientStops(samples(48, ramp, 10, 7));
		expect(stops).toHaveLength(2);
		expect(stops.map((s) => s.offset)).toEqual([0, 1]);
		expect(deltaE(stops[0].color, '#1d4ed8')).toBeLessThan(0.03);
		expect(deltaE(stops[1].color, '#f59e0b')).toBeLessThan(0.03);
		expect(stops.map((s) => s.id)).toEqual(['s1', 's2']);
	});

	it('finds the turning points of a multi-stop transition at their offsets', () => {
		// red → white at 0.3, white → blue at 1.
		const color = (t: number) => (t <= 0.3 ? mixColors('#dc2626', '#ffffff', t / 0.3, { space: 'oklab' })! : mixColors('#ffffff', '#2563eb', (t - 0.3) / 0.7, { space: 'oklab' })!);
		const { stops, maxError } = fitGradientStops(samples(64, color, 4, 3));
		expect(stops).toHaveLength(3);
		expect(Math.abs(stops[1].offset - 0.3)).toBeLessThanOrEqual(2 / 63 + 1e-9);
		expect(deltaE(stops[1].color, '#ffffff')).toBeLessThan(0.04);
		expect(maxError).toBeLessThanOrEqual(0.06);
	});

	it('adds stops until the tolerance is met, and never more than maxStops', () => {
		const rainbow = (t: number) => `hsl(${Math.round(t * 300)} 90% 50%)`;
		const loose = simplifyGradientStops(samples(64, rainbow), { tolerance: 0.1 });
		const tight = fitGradientStops(samples(64, rainbow), { tolerance: 0.02, maxStops: 12 });
		expect(tight.stops.length).toBeGreaterThan(loose.length);
		expect(tight.stops.length).toBeLessThanOrEqual(12);
		expect(simplifyGradientStops(samples(64, rainbow), { tolerance: 0.001, maxStops: 4 })).toHaveLength(4);
		// minStops keeps stops even when two would do.
		expect(simplifyGradientStops(samples(16, () => '#334155'), { minStops: 3 })).toHaveLength(3);
	});

	it('handles flat colour, unreadable samples, string colours and alpha', () => {
		const flat = simplifyGradientStops(samples(32, () => '#334155', 6));
		expect(flat).toHaveLength(2);
		expect(deltaE(flat[0].color, flat[1].color)).toBeLessThan(0.02);
		const gappy: RawGradientSample[] = [
			{ offset: 0, color: '#000000' },
			{ offset: 0.25, color: 'not a colour' },
			{ offset: 0.5, color: mixColors('#000000', '#ffffff', 0.5, { space: 'oklab' })! },
			{ offset: Number.NaN, color: '#ff0000' },
			{ offset: 1, color: 'white' },
		];
		expect(simplifyGradientStops(gappy, { smoothing: 0 }).map((s) => s.offset)).toEqual([0, 1]);
		const fade = simplifyGradientStops([{ offset: 0, color: '#ff000000' }, { offset: 1, color: '#ff0000' }]);
		expect(fade.map((s) => s.color)).toEqual(['#ff000000', '#ff0000']);
	});

	it('refuses input it cannot make a gradient from, saying why', () => {
		expect(() => simplifyGradientStops([{ offset: 0, color: '#fff' }])).toThrow(/at least two readable samples to make a gradient; got 1/);
		expect(() => simplifyGradientStops(samples(4, () => '#fff'), { tolerance: 0 })).toThrow(/tolerance 0 is out of range/);
		expect(() => simplifyGradientStops(samples(4, () => '#fff'), { minStops: 4, maxStops: 3 })).toThrow(/maxStops 3 is below minStops 4/);
	});

	it('samples and reduces 64 points in well under a millisecond', () => {
		const color = (t: number) => mixColors('#0f766e', '#fde68a', t, { space: 'oklab' })!;
		const input = samples(64, color, 8);
		for (let i = 0; i < 20; i++) simplifyGradientStops(input);
		const runs = 200;
		const t0 = performance.now();
		for (let i = 0; i < runs; i++) simplifyGradientStops(input);
		// The target is < 1 ms; leave room for slow CI machines.
		expect((performance.now() - t0) / runs).toBeLessThan(3);
	});
});

describe('sampleGradientFromLine', () => {
	// A 200 × 100 picture: black → white left to right, transparent (unreadable) below y 80.
	const read = ({ x, y }: { x: number; y: number }) => (x < 0 || x >= 200 || y < 0 || y >= 80 ? null : ([Math.round((x / 199) * 255), Math.round((x / 199) * 255), Math.round((x / 199) * 255), 255] as const));

	it('returns a linear OKLab gradient at the line angle with simplified stops', () => {
		const g = sampleGradientFromLine(read, { x: 0, y: 40 }, { x: 199, y: 40 })!;
		expect(g).toMatchObject({ type: 'linear', angle: 90, interpolation: 'oklab' });
		expect(g.stops[0].color).toBe('#000000');
		expect(g.stops.at(-1)!.color).toBe('#ffffff');
		// sRGB-linear bytes are not linear in OKLab, so a few stops may be needed, but not many.
		expect(g.stops.length).toBeLessThanOrEqual(5);
		// Right to left reverses it.
		expect(sampleGradientFromLine(read, { x: 199, y: 40 }, { x: 0, y: 40 })!.angle).toBe(270);
	});

	it('snaps the angle and samples along the snapped direction', () => {
		const g = sampleGradientFromLine(read, { x: 10, y: 40 }, { x: 150, y: 46 }, { snapStep: 15 })!;
		expect(g.angle).toBe(90);
		// Snapped to horizontal: the line ends at x = 10 + its length, still inside the picture.
		expect(deltaE(g.stops.at(-1)!.color, '#bbbbbb')).toBeLessThan(0.03);
	});

	it('skips unreadable points, and returns null when fewer than two can be read', () => {
		const g = sampleGradientFromLine(read, { x: 50, y: 40 }, { x: 50, y: 99 })!;
		expect(g.angle).toBe(180);
		expect(g.stops).toHaveLength(2);
		expect(sampleGradientFromLine(read, { x: 50, y: 85 }, { x: 60, y: 99 })).toBeNull();
		expect(() => sampleGradientFromLine(read, { x: 5, y: 5 }, { x: 5, y: 5 })).toThrow(/same point/);
		expect(() => sampleGradientFromLine(read, { x: 0, y: 0 }, { x: 5, y: 5 }, { sampleCount: 1 })).toThrow(/sampleCount 1 is out of range/);
	});
});

describe('agent tools', () => {
	it('set_gradient_from_samples fits stops as one undo step, keeps the geometry, and refuses bad samples', async () => {
		const ctrl = new GradientController({ value: createGradient(['#000000', '#ffffff'], { type: 'linear', angle: 45, interpolation: 'srgb' }) });
		const registry = new ToolRegistry();
		registry.register(createGradientToolProvider(ctrl, { namespace: '' }));
		const ramp = (t: number) => mixColors('#7c3aed', '#22d3ee', t, { space: 'oklab' })!;
		const input = samples(40, ramp, 6).map((s) => ({ offset: s.offset, color: `rgb(${(s.color as number[]).slice(0, 3).join(' ')})` }));
		let r = (await registry.callTool('set_gradient_from_samples', { samples: input })) as any;
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent ?? JSON.parse(r.content[0].text);
		expect(out.stopCount).toBe(2);
		expect(out.maxError).toBeLessThanOrEqual(0.06);
		expect(out.gradient).toMatchObject({ type: 'linear', angle: 45, interpolation: 'oklab' });
		expect(out.css).toContain('linear-gradient');
		expect(ctrl.state.undoLabel).toBe('Gradient From Samples');
		const before = ctrl.getGradient();
		r = (await registry.callTool('set_gradient_from_samples', { samples: [{ offset: 0, color: '#fff' }, { offset: 1, color: 'nope' }] })) as any;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/samples\[1\]\.color "nope" is not a CSS colour/);
		r = (await registry.callTool('set_gradient_from_samples', { samples: input, minStops: 6, maxStops: 3 })) as any;
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/maxStops 3 is below minStops 6/);
		r = (await registry.callTool('set_gradient_from_samples', { samples: input, tolerance: 0 })) as any;
		expect(r.isError).toBe(true);
		expect(ctrl.getGradient()).toEqual(before);
	});

	it('the image editor samples a gradient along a line of the composite', async () => {
		const W = 120;
		const H = 40;
		const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
		const c = new ImageEditorController({ image: fake });
		const data = new Uint8ClampedArray(W * H * 4);
		// Navy → orange left to right, with grain.
		const r = rng(5);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const p = parseColor(mixColors('#1e3a8a', '#f97316', x / (W - 1), { space: 'oklab' })!)!;
				const i = (y * W + x) * 4;
				data.set([p.r * 255 + (r() - 0.5) * 16, p.g * 255 + (r() - 0.5) * 16, p.b * 255 + (r() - 0.5) * 16, 255], i);
			}
		c.setSamplePixels({ width: W, height: H, data });
		const registry = new ToolRegistry();
		registry.register(createImageEditorToolProvider(c));
		let res = (await registry.callTool('sample_gradient', { start: { x: 0, y: 20 }, end: { x: W - 1, y: 20 } })) as any;
		expect(res.isError).toBeFalsy();
		const out = res.structuredContent ?? JSON.parse(res.content[0].text);
		expect(out.gradient).toMatchObject({ type: 'linear', angle: 90, interpolation: 'oklab' });
		expect(out.gradient.stops).toHaveLength(2);
		expect(deltaE(out.gradient.stops[0].color, '#1e3a8a')).toBeLessThan(0.04);
		expect(deltaE(out.gradient.stops[1].color, '#f97316')).toBeLessThan(0.04);
		expect(out.pointsRead).toBe(32);
		expect(c.getState().paint.foreground).toBe('#000000');
		res = (await registry.callTool('sample_gradient', { start: { x: -50, y: -50 }, end: { x: -10, y: -10 } })) as any;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/Fewer than two points along the line could be read/);
		res = (await registry.callTool('sample_gradient', { start: { x: 5, y: 5 } })) as any;
		expect(res.isError).toBe(true);
	});
});
