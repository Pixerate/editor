import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ChartController, createChartSpec, describeChartSelection } from '../src/chart';
import { chartTooltipFor, createChart3dScene, describeChartSelectionIn, nextChart3dFocus, chart3dMarkSeries } from '../src/three';

const mixed = () =>
	createChartSpec({
		type: 'bar',
		categories: ['Q1', 'Q2', 'Q3', 'Q4'],
		series: [
			{ id: 'a', name: 'A', values: [10, 20, 30, 25] },
			{ id: 'b', name: 'B', values: [5, 15, 8, 12] },
			{ id: 'l', name: 'Trend', type: 'line', values: [12, null, 22, 28] }
		],
		view3d: { azimuth: 25, elevation: 20, depth: 1.5 }
	} as never);

describe('picking 3-D marks', () => {
	it('finds the bar under a known point (its top centre, projected)', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		for (const b of view.layout.boxes) {
			const at = view.anchor({ kind: 'point', seriesId: b.seriesId, index: b.index })!;
			// Just below the top edge, inside the bar's front face.
			const pick = view.pick(at.x, at.y + 4);
			expect(pick, `${b.seriesId}-${b.index}`).toEqual({ kind: 'point', seriesId: b.seriesId, index: b.index });
		}
		view.dispose();
	});

	it('finds the nearest point on a line ribbon, skipping blanks', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		const ribbon = view.layout.ribbons[0]!;
		expect(ribbon.points.map((p) => p.index)).toEqual([0, 2, 3]);
		for (const p of ribbon.points) {
			const at = view.anchor({ kind: 'point', seriesId: 'l', index: p.index })!;
			// The anchor is the ribbon's top edge; a little below it is on the band.
			const pick = view.pick(at.x, at.y + 1.5);
			if (pick) expect(pick).toEqual({ kind: 'point', seriesId: 'l', index: p.index });
		}
		// At least the ends of the ribbon pick as the line, where no bar stands in front.
		const lineOnly = createChart3dScene(createChartSpec({ type: 'line', categories: ['A', 'B', 'C'], series: [{ id: 'l', name: 'L', values: [3, 9, 6] }], view3d: { azimuth: 0, elevation: 15, depth: 1 } } as never), { width: 500, height: 300 });
		for (const index of [0, 1, 2]) {
			const at = lineOnly.anchor({ kind: 'point', seriesId: 'l', index })!;
			expect(lineOnly.pick(at.x, at.y + 1.5)).toEqual({ kind: 'point', seriesId: 'l', index });
		}
		view.dispose();
		lineOnly.dispose();
	});

	it('returns null off the marks, and for a picture with no size', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		expect(view.pick(2, 2)).toBeNull();
		expect(view.pick(638, 398)).toBeNull();
		view.resize(0, 0);
		expect(view.pick(10, 10)).toBeNull();
		view.dispose();
	});

	it('follows a resize', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		view.resize(320, 200);
		const at = view.anchor({ kind: 'point', seriesId: 'a', index: 2 })!;
		expect(at.x).toBeLessThan(320);
		expect(view.pick(at.x, at.y + 3)).toEqual({ kind: 'point', seriesId: 'a', index: 2 });
		view.dispose();
	});
});

describe('focusing 3-D marks', () => {
	const colours = (view: ReturnType<typeof createChart3dScene>) =>
		Object.fromEntries(
			view.scene
				.getObjectByName('chart')!
				.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh && Boolean(c.userData.seriesId))
				.map((m) => [m.name, (m.material as THREE.MeshStandardMaterial).color.getHexString()])
		);

	it('keeps the focused marks in their colours and fades the rest towards the background, the same every time', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		const rest = colours(view);
		view.focus({ kind: 'point', seriesId: 'a', index: 1 });
		const focused = colours(view);
		expect(focused['bar-a-1']).toBe(rest['bar-a-1']);
		for (const name of Object.keys(rest)) if (name !== 'bar-a-1') expect(focused[name], name).not.toBe(rest[name]);
		// Repeatable, and null restores every colour.
		view.focus({ kind: 'point', seriesId: 'a', index: 1 });
		expect(colours(view)).toEqual(focused);
		view.focus(null);
		expect(colours(view)).toEqual(rest);
		expect(view.getFocus()).toBeNull();
		view.dispose();
	});

	it('lights a whole series or a whole category, and dims by the amount asked, theme-aware', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400, theme: { background: '#000000' } });
		const rest = colours(view);
		view.focus({ kind: 'series', seriesId: 'b' });
		let now = colours(view);
		for (const i of [0, 1, 2, 3]) expect(now[`bar-b-${i}`]).toBe(rest[`bar-b-${i}`]);
		expect(now['bar-a-0']).not.toBe(rest['bar-a-0']);
		view.focus({ kind: 'category', index: 2 });
		now = colours(view);
		expect([now['bar-a-2'], now['bar-b-2']]).toEqual([rest['bar-a-2'], rest['bar-b-2']]);
		view.focus({ kind: 'series', seriesId: 'b' }, { dim: 1 });
		// Fully dimmed marks take the (dark) background.
		expect(colours(view)['bar-a-0']).toBe('000000');
		view.dispose();
	});

	it('marks the focused category\'s label for the overlay', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		view.focus({ kind: 'point', seriesId: 'b', index: 3 });
		const cats = view.labels().filter((l) => l.kind === 'category');
		expect(cats.map((l) => [l.text, l.index, Boolean(l.focused)])).toEqual([['Q1', 0, false], ['Q2', 1, false], ['Q3', 2, false], ['Q4', 3, true]]);
		view.dispose();
	});
});

describe('keyboard and words, as on the flat chart', () => {
	it('walks categories with ← →, series with ↑ ↓, Home / End, and clears with Escape', () => {
		const view = createChart3dScene(mixed(), { width: 640, height: 400 });
		const layout = view.layout;
		expect(chart3dMarkSeries(layout).map((s) => [s.seriesId, s.indices])).toEqual([['a', [0, 1, 2, 3]], ['b', [0, 1, 2, 3]], ['l', [0, 2, 3]]]);
		let focus = nextChart3dFocus(layout, null, 'ArrowRight');
		expect(focus).toEqual({ kind: 'point', seriesId: 'a', index: 0 });
		focus = nextChart3dFocus(layout, focus!, 'ArrowRight');
		expect(focus).toEqual({ kind: 'point', seriesId: 'a', index: 1 });
		focus = nextChart3dFocus(layout, focus!, 'ArrowDown');
		expect(focus).toEqual({ kind: 'point', seriesId: 'b', index: 1 });
		focus = nextChart3dFocus(layout, focus!, 'ArrowDown');
		// The line has no point at Q2: it lands on the nearest one.
		expect(focus).toEqual({ kind: 'point', seriesId: 'l', index: 0 });
		expect(nextChart3dFocus(layout, focus!, 'ArrowDown')).toEqual(focus); // stays at the back row
		expect(nextChart3dFocus(layout, focus!, 'ArrowRight')).toEqual({ kind: 'point', seriesId: 'l', index: 2 });
		expect(nextChart3dFocus(layout, focus!, 'End')).toEqual({ kind: 'point', seriesId: 'l', index: 3 });
		expect(nextChart3dFocus(layout, { kind: 'point', seriesId: 'l', index: 3 }, 'Home')).toEqual({ kind: 'point', seriesId: 'l', index: 0 });
		expect(nextChart3dFocus(layout, { kind: 'point', seriesId: 'a', index: 0 }, 'ArrowLeft')).toEqual({ kind: 'point', seriesId: 'a', index: 0 });
		expect(nextChart3dFocus(layout, null, 'End')).toEqual({ kind: 'point', seriesId: 'a', index: 3 });
		expect(nextChart3dFocus(layout, focus!, 'Escape')).toBeNull();
		expect(nextChart3dFocus(layout, null, 'Escape')).toBeUndefined();
		expect(nextChart3dFocus(layout, focus!, 'Enter')).toBeUndefined();
		view.dispose();
	});

	it('describes a focused point with the flat chart\'s words, and gives the same tooltip', () => {
		const spec = mixed();
		const controller = new ChartController({ spec });
		const point = { kind: 'point', seriesId: 'b', index: 2 } as const;
		expect(describeChartSelectionIn(spec, point)).toBe(describeChartSelection(controller, point));
		expect(describeChartSelectionIn(spec, point)).toBe('B · Q3: 8');
		expect(describeChartSelectionIn(spec, null)).toBe('Nothing selected');
		const view = createChart3dScene(spec, { width: 640, height: 400 });
		const at = view.anchor(point)!;
		const tip = chartTooltipFor(spec, point.index, point.seriesId, at)!;
		expect([tip.x, tip.y]).toEqual([at.x, at.y]);
		expect(tip.title).toBe('Q3');
		expect(tip.items.map((i) => [i.name, i.text])).toEqual([['B', '8']]);
		expect(view.anchor({ kind: 'category', index: 0 })).toBeNull();
		view.dispose();
	});
});
