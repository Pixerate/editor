import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drawPieces, drawPiecesToFlair, type DrawPiece, type DrawPiecesOptions } from '../src/animation/draw.js';
import { createLinkFocus, linkFocusLit } from '../src/interaction/linkFocus.js';
import { conformanceValuesMatch } from '../src/tools/conformance.js';

/**
 * Vectors the Swift ports of `drawPieces` and `createLinkFocus` (#812) check themselves against
 * (`PixerateCoreTests/DrawLinkFocusTests.swift`). Recorded from the TS core; a drift fails here
 * (UPDATE_SWIFT_VECTORS=1 rewrites the file). Numbers compare within relative 1e-9.
 */
const FILE = join(__dirname, '../../swift/Tests/PixerateCoreTests/Fixtures/draw-link-vectors.json');
const PS = [0, 0.05, 0.13, 0.25, 0.4, 0.5, 0.61, 0.75, 0.9, 0.99, 1, 1.2];

function drawVectors() {
	const lead: DrawPiece[] = [{ from: 0, to: 20, id: 'lead' }, { from: 20, to: 100, id: 'span' }, { from: 100, to: 130, id: 'tail' }];
	const cases: { pieces: DrawPiece[]; options: Omit<DrawPiecesOptions, 'ease'> & { ease?: string } }[] = [
		{ pieces: lead, options: {} },
		{ pieces: lead, options: { ease: 'ease-in-out' } },
		{ pieces: lead, options: { at: 0.2, span: 0.5, ease: 'ease-out' } },
		{ pieces: [{ from: 0, to: 40 }, { from: 60, to: 100, id: 'b' }, { from: 10, to: 30 }], options: { total: 120 } },
		{ pieces: [{ from: 0, to: 10 }, { from: 10, to: 10, id: 'empty' }], options: { at: 0.5, span: 0 } },
		{ pieces: lead, options: { ease: 'spring-bouncy' } },
		{ pieces: [{ from: 5, to: 2 }], options: {} },
		{ pieces: [], options: { total: -1 } }
	];
	return cases.map((c) => {
		try {
			const plan = drawPieces(c.pieces, c.options);
			return { ...c, out: { total: plan.total, windows: plan.windows, heads: PS.map((p) => plan.headAt(p)), drawn: PS.map((p) => plan.drawAt(p)), flair: drawPiecesToFlair(plan, c.pieces, 1300) } };
		} catch (error) {
			return { ...c, throws: (error as Error).message };
		}
	});
}

function focusVectors() {
	const cases = [
		{
			marks: [['a'], ['b'], ['c'], ['x'], ['y'], ['a', 'x'], ['a', 'y'], ['b', 'y'], []],
			links: [['a', ['x', 'y']], ['b', ['y']], ['c', []]] as [string, string[]][],
			labels: { a: 'Alpha', y: 'Why' },
			dim: 0.3,
			steps: ['focus:a', 'focus:y', 'key:ArrowRight', 'key:ArrowRight', 'key:ArrowLeft', 'key:Home', 'key:End', 'key:Escape', 'key:Escape', 'key:Enter', 'key:ArrowUp', 'focus:x', 'focus:zz', 'clear']
		},
		{
			marks: [['t1'], ['t2'], ['i1', 't1'], ['i2', 't1'], ['i2', 't2'], ['i1'], ['i2']],
			links: [['i1', ['t1']], ['i2', ['t1', 't2', 'i2']]] as [string, string[]][],
			order: ['i1', 'i2', 't1', 't2', 'i1'],
			steps: ['key:ArrowDown', 'key:ArrowDown', 'key:ArrowDown', 'key:ArrowDown', 'key:ArrowDown', 'focus:t1']
		},
		{ marks: [['a']], links: [] as [string, string[]][], order: ['q'], steps: [] }
	];
	return cases.map((c) => {
		const links = Object.fromEntries(c.links);
		try {
			const model = createLinkFocus({ marks: c.marks, links, order: (c as { order?: string[] }).order, labels: (c as { labels?: Record<string, string> }).labels, dim: (c as { dim?: number }).dim });
			const states = c.steps.map((step) => {
				const [kind, arg] = step.split(':');
				let handled: boolean | null = null;
				let error: string | null = null;
				try {
					if (kind === 'focus') model.focus(arg);
					else if (kind === 'key') handled = model.handleKey({ key: arg });
					else model.clear();
				} catch (e) {
					error = (e as Error).message;
				}
				const s = model.getState();
				return { step, handled, error, focus: s.focus, lit: s.lit, inFocus: s.inFocus, opacity: model.opacity(), describe: model.describe() };
			});
			const keys = [...new Set(c.marks.flat())];
			return {
				...c,
				out: {
					order: model.order,
					dim: model.dim,
					states,
					related: keys.map((k) => model.related(k)),
					describeEach: keys.map((k) => model.describe(k)),
					litEach: [null, ...keys].map((k) => linkFocusLit(c.marks, links, k))
				}
			};
		} catch (error) {
			return { ...c, throws: (error as Error).message };
		}
	});
}

describe('Swift draw-pieces and link-focus vectors', () => {
	it('match the committed fixture (the Swift tests read it)', () => {
		const now = JSON.parse(JSON.stringify({ version: 1, ps: PS, draw: drawVectors(), focus: focusVectors() }));
		if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, JSON.stringify(now) + '\n');
		const committed = JSON.parse(readFileSync(FILE, 'utf8'));
		if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
	});
});
