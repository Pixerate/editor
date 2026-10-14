// Measure cases re-expressed from figcraft-main/crates/engine/src/measure_tests.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
	isMeasureModifierHeld,
	measureBetween,
	measureLabel,
	measureSelection,
	measureToLine,
	type CanvasNode,
	type MeasureGuide,
	type Rect
} from '../src/canvas';

/** figcraft's `Rect::new(x0, y0, x1, y1)`. */
const box = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });

/** Labelled lines as [label, [x1, y1, x2, y2]], rounded and sorted. */
function labelled(g: MeasureGuide[]): [string, number[]][] {
	return g
		.filter((l) => l.kind === 'measure')
		.map((l) => [l.label ?? '', [l.x1, l.y1, l.x2, l.y2].map(Math.round)] as [string, number[]])
		.sort((a, b) => (a[0] + a[1].join(',') < b[0] + b[1].join(',') ? -1 : 1));
}
const labels = (g: MeasureGuide[]) => labelled(g).map((l) => l[0]);

const node = (id: string, x: number, y: number, width: number, height: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	position: { x, y },
	width,
	height,
	data: {},
	...extra
});

describe('measureLabel', () => {
	it('rounds to two decimals without trailing zeros', () => {
		expect(measureLabel(50)).toBe('50');
		expect(measureLabel(12.345)).toBe('12.35');
		expect(measureLabel(-3.5)).toBe('3.5');
		expect(measureLabel(0.1 + 0.2)).toBe('0.3');
		expect(measureLabel(-0.001)).toBe('0');
	});
});

describe('measureBetween', () => {
	it('measures gaps between boxes side by side and diagonal', () => {
		const a = box(0, 0, 50, 50);
		const side = measureBetween(a, box(100, 10, 150, 70));
		expect(labelled(side)).toEqual([['50', [50, 30, 100, 30]]]);
		expect(side.every((g) => g.kind === 'measure' && g.orientation === 'horizontal')).toBe(true);

		const diag = measureBetween(a, box(100, 120, 150, 150));
		expect(labelled(diag)).toEqual([
			['50', [50, 25, 100, 25]],
			['70', [25, 50, 25, 120]]
		]);
		const dashed = diag.filter((g) => g.kind === 'extension');
		expect(dashed.map((g) => [g.x1, g.y1, g.x2, g.y2])).toEqual([
			[100, 25, 100, 120],
			[25, 120, 100, 120]
		]);
		expect(dashed.every((g) => g.label === undefined)).toBe(true);
		// Touching boxes have no gap to draw.
		expect(measureBetween(a, box(50, 0, 80, 50))).toEqual([]);
	});

	it('measures from the inner box to each edge of the outer one, both ways round', () => {
		const inner = box(10, 20, 60, 50);
		const outer = box(0, 0, 100, 100);
		const want = [
			['10', [0, 35, 10, 35]],
			['20', [35, 0, 35, 20]],
			['40', [60, 35, 100, 35]],
			['50', [35, 50, 35, 100]]
		];
		expect(labelled(measureBetween(inner, outer))).toEqual(want);
		expect(labelled(measureBetween(outer, inner))).toEqual(want);
	});

	it('measures overlapping boxes between matching edges', () => {
		expect(labels(measureBetween(box(0, 0, 100, 100), box(50, 30, 200, 80)))).toEqual(['100', '20', '30', '50']);
	});

	it('ignores non-finite boxes', () => {
		expect(measureBetween(box(0, 0, NaN, 10), box(0, 0, 1, 1))).toEqual([]);
	});
});

describe('measureToLine', () => {
	it('measures to the near side, or both sides when the line crosses', () => {
		const a = box(0, 0, 50, 40);
		expect(labelled(measureToLine(a, 'vertical', 300))).toEqual([['250', [50, 20, 300, 20]]]);
		expect(labelled(measureToLine(a, 'horizontal', -10))).toEqual([['10', [25, -10, 25, 0]]]);
		expect(labels(measureToLine(a, 'vertical', 20))).toEqual(['20', '30']);
		expect(measureToLine(a, 'vertical', NaN)).toEqual([]);
	});
});

describe('measureSelection', () => {
	it('measures the union of several selected nodes to the hovered node', () => {
		const nodes = [node('a', 0, 0, 40, 40), node('b', 0, 100, 40, 40), node('tall', 200, 0, 40, 140)];
		const result = measureSelection(nodes, ['a', 'b'], 'tall');
		expect(labelled(result.guides)).toEqual([['160', [40, 70, 200, 70]]]);
		expect(result.target).toEqual(box(200, 0, 240, 140));
		expect(result.selection).toEqual(box(0, 0, 40, 140));
	});

	it('measures to the parent over the selection itself or empty space', () => {
		const nodes = [node('f', 0, 0, 200, 100), node('r', 20, 30, 40, 20, { parentId: 'f' })];
		const want = [
			['140', [60, 40, 200, 40]],
			['20', [0, 40, 20, 40]],
			['30', [40, 0, 40, 30]],
			['50', [40, 50, 40, 100]]
		];
		expect(labelled(measureSelection(nodes, ['r'], 'r').guides)).toEqual(want);
		const empty = measureSelection(nodes, ['r'], null);
		expect(labelled(empty.guides)).toEqual(want);
		expect(empty.target).toEqual(box(0, 0, 200, 100));
		// A top-level selection has no parent to measure to.
		expect(measureSelection(nodes, ['f'], null)).toMatchObject({ guides: [], target: null });
	});

	it('uses absolute positions for nested nodes', () => {
		const nodes = [
			node('f', 0, 0, 200, 100),
			node('r', 20, 30, 40, 20, { parentId: 'f' }),
			node('other', 300, 30, 10, 10)
		];
		expect(measureSelection(nodes, ['r'], 'other').guides[0].label).toBe('240');
	});

	it('measures nothing without a selection, for hidden or unknown targets', () => {
		const nodes = [node('a', 0, 0, 10, 10), node('b', 50, 0, 10, 10, { hidden: true })];
		expect(measureSelection(nodes, [], 'a').guides).toEqual([]);
		expect(measureSelection(nodes, ['a'], 'b').guides).toEqual([]);
		expect(measureSelection(nodes, ['a'], 'missing').guides).toEqual([]);
	});
});

describe('isMeasureModifierHeld', () => {
	it('tracks Alt from keyboard and pointer events', () => {
		expect(isMeasureModifierHeld({ type: 'keydown', key: 'Alt', altKey: false })).toBe(true);
		expect(isMeasureModifierHeld({ type: 'keyup', key: 'Alt', altKey: true })).toBe(false);
		expect(isMeasureModifierHeld({ type: 'pointermove', altKey: true })).toBe(true);
		expect(isMeasureModifierHeld({ type: 'keydown', key: 'a', altKey: false })).toBe(false);
		expect(isMeasureModifierHeld(null)).toBe(false);
	});
});
