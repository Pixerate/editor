import { describe, expect, it } from 'vitest';
import { elbow, fanElbows, roundedPolyline, type Connector } from '../src/geom/connectors';
import { helix, splitByDepth } from '../src/geom/helix';
import type { Vec2 } from '../src/geom/types';
import { bezierPathLength } from '../src/canvas/pathops/index.js';

/** Points along a connector, arcs sampled finely. */
function flatten(c: Connector, perArc = 16): Vec2[] {
	const out: Vec2[] = [];
	for (const s of c.segments) {
		if (out.length === 0) out.push(s.from);
		if (s.kind === 'line') {
			out.push(s.to);
			continue;
		}
		const a0 = Math.atan2(s.from.y - s.center.y, s.from.x - s.center.x);
		let a1 = Math.atan2(s.to.y - s.center.y, s.to.x - s.center.x);
		let delta = a1 - a0;
		if (s.sweep === 1 && delta < 0) delta += 2 * Math.PI;
		if (s.sweep === 0 && delta > 0) delta -= 2 * Math.PI;
		a1 = a0 + delta;
		for (let i = 1; i <= perArc; i++) {
			const a = a0 + (delta * i) / perArc;
			out.push({ x: s.center.x + s.radius * Math.cos(a), y: s.center.y + s.radius * Math.sin(a) });
		}
	}
	return out;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Two segments cross at a point inside both (not touching at ends, not collinear). */
function properCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
	const eps = 1e-9;
	const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
	return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}

function crosses(p: Vec2[], q: Vec2[]): boolean {
	for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) if (properCross(p[i - 1], p[i], q[j - 1], q[j])) return true;
	return false;
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

describe('elbow', () => {
	it('runs along the axis, across at the level, then along the axis, with quarter-circle corners', () => {
		const e = elbow({ x: 0, y: 0 }, { x: 100, y: 80 }, { level: 30, radius: 10 });
		expect(e.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line', 'arc', 'line']);
		expect(e.d).toBe('M0 0L0 20A10 10 0 0 0 10 30L90 30A10 10 0 0 1 100 40L100 80');
		for (const s of e.segments) if (s.kind === 'line') expect(s.from.x === s.to.x || s.from.y === s.to.y).toBe(true);
		expect(e.length).toBeCloseTo(20 + 80 + 40 + Math.PI * 10, 12);
		expect(e.level).toBe(30);
	});

	it('has the same length as pathops measures from its path data', () => {
		const e = elbow({ x: 5, y: 10 }, { x: -60, y: 90 }, { radius: 12 });
		expect(bezierPathLength(e.d)).toBeCloseTo(e.length, 1);
	});

	it('shrinks corners to fit the runs beside them', () => {
		const e = elbow({ x: 0, y: 0 }, { x: 6, y: 100 }, { level: 50, radius: 20 });
		const arcs = e.segments.filter((s) => s.kind === 'arc');
		expect(arcs.map((s) => (s.kind === 'arc' ? s.radius : 0))).toEqual([3, 3]);
		const short = elbow({ x: 0, y: 0 }, { x: 100, y: 100 }, { level: 4, radius: 20 });
		expect(short.segments[0]).toMatchObject({ kind: 'arc', radius: 4 });
	});

	it('is a straight run when the ends are in line', () => {
		const e = elbow({ x: 10, y: 0 }, { x: 10, y: 50 }, { radius: 8 });
		expect(e.d).toBe('M10 0L10 50');
		expect(e.length).toBe(50);
	});

	it('turns across first with the horizontal axis', () => {
		const e = elbow({ x: 0, y: 0 }, { x: 80, y: -40 }, { axis: 'horizontal', radius: 5 });
		expect(e.level).toBe(40);
		expect(e.d).toBe('M0 0L35 0A5 5 0 0 0 40 -5L40 -35A5 5 0 0 1 45 -40L80 -40');
	});

	it('keeps a corner that doubles back sharp', () => {
		const c = roundedPolyline([{ x: 0, y: 0 }, { x: 0, y: -10 }, { x: 0, y: 20 }], 5);
		expect(c.d).toBe('M0 0L0 -10L0 20');
		expect(c.length).toBe(40);
	});
});

describe('fanElbows', () => {
	it('turns the outermost target nearest the root on each side', () => {
		const targets = [{ x: -90, y: 100 }, { x: -30, y: 100 }, { x: 0, y: 100 }, { x: 40, y: 100 }, { x: 120, y: 100 }];
		const fan = fanElbows({ x: 0, y: 0 }, targets, { lead: 10, step: 10, radius: 4 });
		expect(fan.levels).toEqual([10, 20, 10, 20, 10]);
		expect(fan.elbows[2].d).toBe('M0 0L0 100');
		expect(fan.starts.every((s) => s.x === 0 && s.y === 0)).toBe(true);
	});

	it('spreads starts by the gap in the targets’ order, keeping the targets’ order in its output', () => {
		const targets = [{ x: 50, y: -80 }, { x: -50, y: -80 }];
		const fan = fanElbows({ x: 0, y: 0 }, targets, { gap: 6 });
		expect(fan.starts).toEqual([{ x: 3, y: 0 }, { x: -3, y: 0 }]);
		expect(fan.levels).toEqual([-16, -16]);
	});

	it('shrinks the step and radius to fit before the nearest target', () => {
		const targets = Array.from({ length: 9 }, (_, i) => ({ x: -200 + i * 10, y: 60 }));
		const fan = fanElbows({ x: 0, y: 0 }, targets, { lead: 16, step: 12, radius: 8 });
		expect(fan.step).toBeCloseTo(44 / 9, 12);
		expect(fan.radius).toBeCloseTo(22 / 9, 12);
		expect(Math.max(...fan.levels)).toBeLessThan(60);
	});

	it('never crosses for 1–40 targets at random spacing', () => {
		const random = rng(811);
		for (let trial = 0; trial < 60; trial++) {
			const n = 1 + Math.floor(random() * 40);
			const gap = trial % 3 === 0 ? 0 : 2 + random() * 6;
			const xs: number[] = [];
			let x = -random() * 300;
			for (let i = 0; i < n; i++) {
				xs.push(x);
				x += gap + random() * 30;
			}
			const below = trial % 2 === 0 ? 1 : -1;
			const targets = xs.map((tx) => ({ x: tx, y: below * (120 + random() * 40) }));
			const axis = trial % 4 === 1 ? 'horizontal' : 'vertical';
			const placed = axis === 'horizontal' ? targets.map((t) => ({ x: t.y, y: t.x })) : targets;
			const fan = fanElbows({ x: random() * 50, y: 0 }, placed, { gap, step: 4 + random() * 12, radius: 2 + random() * 10, axis });
			const lines = fan.elbows.map((e) => flatten(e));
			for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(crosses(lines[i], lines[j]), `trial ${trial}: ${i} × ${j}`).toBe(false);
			for (const e of fan.elbows) for (const s of e.segments) if (s.kind === 'line') expect(s.from.x === s.to.x || s.from.y === s.to.y).toBe(true);
		}
	});

	it('handles no targets', () => {
		expect(fanElbows({ x: 0, y: 0 }, [])).toMatchObject({ elbows: [], levels: [], starts: [] });
	});
});

describe('helix', () => {
	it('winds around the axis with the given amplitude and turns', () => {
		const h = helix([{ x: 0, y: 0 }, { x: 0, y: 100 }], { amplitude: 10, turns: 1, samples: 4 });
		expect(h.points.map((p) => [Math.round(p.x * 1e9) / 1e9 + 0, p.y])).toEqual([[0, 0], [10, 25], [0, 50], [-10, 75], [0, 100]]);
		expect(h.depth.map((d) => Math.round(d * 1e9) / 1e9 + 0)).toEqual([1, 0, -1, 0, 1]);
		expect(h.length).toBeCloseTo(4 * Math.hypot(10, 25), 9);
	});

	it('closes with the pinch, start and end envelopes', () => {
		const axis: [Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
		const pinch = helix(axis, { envelope: 'pinch', phase: Math.PI / 2 });
		expect(pinch.points[0].y).toBe(0);
		expect(Math.abs(pinch.points[pinch.points.length - 1].y)).toBeLessThan(1e-9);
		const start = helix(axis, { envelope: 'start', phase: Math.PI / 2, turns: 1 });
		expect(start.points[0].y).toBe(0);
		expect(Math.abs(start.points[start.points.length - 1].y)).toBeCloseTo(12, 9);
		const end = helix(axis, { envelope: 'end', phase: Math.PI / 2 });
		expect(Math.abs(end.points[0].y)).toBeCloseTo(12, 9);
		expect(Math.abs(end.points[end.points.length - 1].y)).toBeLessThan(1e-9);
		const custom = helix(axis, { envelope: () => 0.5, phase: Math.PI / 2 });
		expect(Math.abs(custom.points[0].y)).toBeCloseTo(6, 9);
	});
});

describe('splitByDepth', () => {
	it('alternates front and back runs that meet exactly on the curve', () => {
		for (const turns of [0.5, 1, 2.3, 4]) {
			for (const phase of [0, 0.7, Math.PI]) {
				const h = helix([{ x: 10, y: 20 }, { x: 310, y: 140 }], { amplitude: 18, turns, phase, samples: 37 });
				const runs = splitByDepth(h.points, h.depth);
				for (let i = 1; i < runs.length; i++) {
					expect(runs[i].front).toBe(!runs[i - 1].front);
					expect(runs[i].from).toBe(runs[i - 1].to);
					expect(runs[i].points[0]).toEqual(runs[i - 1].points[runs[i - 1].points.length - 1]);
				}
				expect(runs[0].from).toBe(0);
				expect(runs[runs.length - 1].to).toBeCloseTo(h.length, 9);
				const total = runs.reduce((a, r) => a + r.length, 0);
				expect(total).toBeCloseTo(h.length, 9);
				// Each cut lies on the polyline: between the two samples it falls between.
				for (let i = 1; i < runs.length; i++) {
					const cut = runs[i].points[0];
					let onCurve = false;
					for (let k = 1; k < h.points.length && !onCurve; k++) {
						const a = h.points[k - 1], b = h.points[k];
						const cross = Math.abs(orient(a, b, cut));
						const within = Math.min(a.x, b.x) - 1e-9 <= cut.x && cut.x <= Math.max(a.x, b.x) + 1e-9 && Math.min(a.y, b.y) - 1e-9 <= cut.y && cut.y <= Math.max(a.y, b.y) + 1e-9;
						onCurve = within && cross < 1e-6;
					}
					expect(onCurve).toBe(true);
				}
				// Front runs have depth ≥ 0 at their samples.
				expect(runs.length).toBeGreaterThan(Math.floor(turns * 2) - 1);
			}
		}
	});

	it('cuts where the depth is zero, linear between points', () => {
		const runs = splitByDepth(
			[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
			[1, -3, 1]
		);
		expect(runs.map((r) => [r.front, r.from, r.to])).toEqual([[true, 0, 2.5], [false, 2.5, 17.5], [true, 17.5, 20]]);
		expect(runs[1].d).toBe('M2.5 0L10 0L17.5 0');
	});

	it('gives a zero-depth point to the side before it', () => {
		const runs = splitByDepth([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], [0, 1, 0, -1]);
		expect(runs.map((r) => [r.front, r.from, r.to])).toEqual([[true, 0, 2], [false, 2, 3]]);
		expect(splitByDepth([], [])).toEqual([]);
	});
});
