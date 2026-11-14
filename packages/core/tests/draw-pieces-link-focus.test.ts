import { describe, expect, it } from 'vitest';
import { drawPieces, drawPiecesToFlair } from '../src/animation/draw.js';
import { createLinkFocus, linkFocusLit } from '../src/interaction/linkFocus.js';

describe('drawPieces', () => {
	const pieces = [
		{ from: 0, to: 20, id: 'lead' },
		{ from: 20, to: 100, id: 'span' },
		{ from: 100, to: 130, id: 'tail' }
	];

	it('draws the pieces as one continuous stroke: no gaps or overlaps at any p', () => {
		const plan = drawPieces(pieces);
		expect(plan.total).toBe(130);
		for (let k = 0; k <= 200; k++) {
			const p = k / 200;
			const drawn = plan.drawAt(p);
			const head = plan.headAt(p);
			// Tiling pieces: the visible lengths add up to the head's position.
			expect(drawn.reduce((a, d) => a + d.visible, 0)).toBeCloseTo(head, 9);
			// Only the piece under the head is partly drawn: everything before is whole, after is empty.
			let seenPartial = false;
			for (const [i, d] of drawn.entries()) {
				if (d.fraction > 0 && d.fraction < 1) {
					expect(seenPartial).toBe(false);
					seenPartial = true;
					expect(head).toBeGreaterThan(pieces[i].from);
					expect(head).toBeLessThan(pieces[i].to);
				}
			}
		}
	});

	it('is at rest at p = 1 and empty at p = 0', () => {
		const plan = drawPieces(pieces, { ease: 'ease-in-out' });
		expect(plan.drawAt(1).map((d) => [d.visible, d.fraction, d.dasharray, d.shown])).toEqual([
			[20, 1, '20 20', true],
			[80, 1, '80 80', true],
			[30, 1, '30 30', true]
		]);
		expect(plan.drawAt(0).every((d) => d.visible === 0 && !d.shown)).toBe(true);
		expect(plan.drawAt(1.5)).toEqual(plan.drawAt(1));
	});

	it('depends on p alone', () => {
		const a = drawPieces(pieces, { ease: 'ease-out' });
		const b = drawPieces(pieces, { ease: 'ease-out' });
		for (const p of [0.13, 0.5, 0.77, 0.5, 0.13]) expect(a.drawAt(p)).toEqual(b.drawAt(p));
	});

	it('starts at `at` and takes `span` of the progress', () => {
		const plan = drawPieces(pieces, { at: 0.2, span: 0.5 });
		expect(plan.headAt(0.2)).toBe(0);
		expect(plan.headAt(0.45)).toBeCloseTo(65, 9);
		expect(plan.headAt(0.7)).toBe(130);
		expect(plan.headAt(0.9)).toBe(130);
		expect(plan.windows.map((w) => [w.start, w.end].map((v) => Math.round(v * 1e6) / 1e6))).toEqual([
			[0.2, Math.round((0.2 + (20 / 130) * 0.5) * 1e6) / 1e6],
			[Math.round((0.2 + (20 / 130) * 0.5) * 1e6) / 1e6, Math.round((0.2 + (100 / 130) * 0.5) * 1e6) / 1e6],
			[Math.round((0.2 + (100 / 130) * 0.5) * 1e6) / 1e6, 0.7]
		]);
	});

	it('takes a total, gaps and overlaps, and an easing function', () => {
		const plan = drawPieces([{ from: 0, to: 40 }, { from: 60, to: 100 }, { from: 10, to: 30 }], { total: 120, ease: (t) => t * t });
		expect(plan.headAt(0.5)).toBeCloseTo(30, 9);
		expect(plan.drawAt(0.5).map((d) => d.visible)).toEqual([30, 0, 20]);
		expect(plan.drawAt(1).map((d) => d.visible)).toEqual([40, 40, 20]);
	});

	it('keeps an overshooting spring inside the line', () => {
		const plan = drawPieces(pieces, { ease: 'spring-bouncy' });
		for (let k = 0; k <= 100; k++) {
			const head = plan.headAt(k / 100);
			expect(head).toBeGreaterThanOrEqual(0);
			expect(head).toBeLessThanOrEqual(130);
		}
	});

	it('handles an empty piece and rejects bad ones', () => {
		const plan = drawPieces([{ from: 0, to: 10 }, { from: 10, to: 10 }]);
		expect(plan.drawAt(0.5)[1]).toMatchObject({ fraction: 0, shown: false });
		expect(plan.drawAt(1)[1]).toMatchObject({ fraction: 1, shown: false });
		expect(() => drawPieces([{ from: 5, to: 2 }])).toThrow('pieces[0] must have finite from ≤ to (got from 5, to 2).');
		expect(() => drawPieces([], { total: -1 })).toThrow('total must be a length of 0 or more');
		expect(drawPieces([]).drawAt(0.5)).toEqual([]);
	});

	it('exports Flair draw-ons for pieces with ids', () => {
		const plan = drawPieces(pieces);
		expect(drawPiecesToFlair(plan, pieces, 1300)).toEqual([
			{ id: 'lead', delay: 0, ms: 200, draw: true, ease: 'linear' },
			{ id: 'span', delay: 200, ms: 800, draw: true, ease: 'linear' },
			{ id: 'tail', delay: 1000, ms: 300, draw: true, ease: 'linear' }
		]);
	});
});

describe('linkFocus', () => {
	// Items a, b, c; tags x, y. a→x, a→y, b→y, c has none.
	const links = { a: ['x', 'y'], b: ['y'], c: [] };
	const marks = [['a'], ['b'], ['c'], ['x'], ['y'], ['a', 'x'], ['a', 'y'], ['b', 'y']];
	const at = (lit: readonly boolean[]) => marks.filter((_, i) => lit[i]).map((m) => m.join('-'));

	it('lights one-to-many: an item, its tags and its links', () => {
		expect(at(linkFocusLit(marks, links, 'a'))).toEqual(['a', 'x', 'y', 'a-x', 'a-y']);
		expect(at(linkFocusLit(marks, links, 'c'))).toEqual(['c']);
	});

	it('lights many-to-many: a tag, its items and only their links to it', () => {
		expect(at(linkFocusLit(marks, links, 'y'))).toEqual(['a', 'b', 'y', 'a-y', 'b-y']);
		expect(at(linkFocusLit(marks, links, 'x'))).toEqual(['a', 'x', 'a-x']);
	});

	it('lights everything with no focus, and no mark without keys', () => {
		expect(linkFocusLit(marks, links, null).every(Boolean)).toBe(true);
		expect(linkFocusLit([[]], links, 'a')).toEqual([false]);
	});

	it('keeps state, notifies, and gives opacities from dim', () => {
		const model = createLinkFocus({ marks, links, dim: 0.3 });
		const seen: (string | null)[] = [];
		const stop = model.subscribe((s) => seen.push(s.focus));
		model.focus('b');
		model.focus('b');
		expect(model.getState().inFocus).toEqual(['b', 'y']);
		expect(model.opacity()).toEqual([0.3, 1, 0.3, 0.3, 1, 0.3, 0.3, 1]);
		model.clear();
		stop();
		model.focus('a');
		expect(seen).toEqual(['b', null]);
		expect(() => model.focus('zz')).toThrow('Unknown key "zz". Known keys: a, b, c, x, y.');
	});

	it('walks the keyboard order like a chart: arrows wrap, Home / End, Escape clears', () => {
		const model = createLinkFocus({ marks, links });
		expect(model.order).toEqual(['a', 'b', 'c', 'x', 'y']);
		expect(model.handleKey({ key: 'ArrowRight' })).toBe(true);
		expect(model.getState().focus).toBe('a');
		model.handleKey({ key: 'ArrowLeft' });
		expect(model.getState().focus).toBe('y');
		model.handleKey({ key: 'ArrowDown' });
		expect(model.getState().focus).toBe('a');
		model.handleKey({ key: 'End' });
		expect(model.getState().focus).toBe('y');
		model.handleKey({ key: 'Home' });
		expect(model.getState().focus).toBe('a');
		expect(model.handleKey({ key: 'Escape' })).toBe(true);
		expect(model.getState().focus).toBeNull();
		expect(model.handleKey({ key: 'Escape' })).toBe(false);
		expect(model.handleKey({ key: 'Enter' })).toBe(false);
		const fromUp = createLinkFocus({ marks, links });
		fromUp.handleKey({ key: 'ArrowUp' });
		expect(fromUp.getState().focus).toBe('y');
	});

	it('describes a key and its links for screen readers', () => {
		const model = createLinkFocus({ marks, links, labels: { a: 'Alpha', x: 'Ex', y: 'Why' } });
		expect(model.describe()).toBe('Nothing focused.');
		expect(model.describe('a')).toBe('Alpha, 1 of 5: linked to 2 others, Ex, Why.');
		expect(model.describe('x')).toBe('Ex, 4 of 5: linked to 1 other, Alpha.');
		expect(model.describe('c')).toBe('c, 3 of 5: no links.');
		model.focus('y');
		expect(model.describe()).toBe('Why, 5 of 5: linked to 2 others, Alpha, b.');
		expect(model.related('y')).toEqual(['a', 'b']);
	});

	it('takes an order and refuses keys it does not know', () => {
		expect(createLinkFocus({ marks, links, order: ['x', 'y', 'x'] }).order).toEqual(['x', 'y']);
		expect(() => createLinkFocus({ marks, links, order: ['q'] })).toThrow('order names "q", which no mark or link has.');
	});
});
