// Test cases re-expressed from figcraft/crates/layout/src/{tests.rs,behaviour_tests.rs,nested_tests.rs,content_align_tests.rs}
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
	applyNodeUpdates,
	applyConstraints,
	clampLayoutSize,
	getAutoLayoutGrid,
	getAutoLayoutInsertTarget,
	getFlowChildren,
	getLayoutParent,
	getLayoutSizing,
	layoutAll,
	layoutFrame,
	layoutUp,
	makeSizingCoherent,
	moveLayoutChild,
	resolvePadding,
	type AutoLayout,
	type AutoLayoutAlignContent,
	type AutoLayoutAlignCross,
	type AutoLayoutAlignMain,
	type AutoLayoutCellAlign,
	type AutoLayoutChild,
	type AutoLayoutGridTrack,
	type AutoLayoutHorizontalConstraint,
	type AutoLayoutMeasure,
	type AutoLayoutMode,
	type AutoLayoutSizing,
	type AutoLayoutVerticalConstraint,
	type CanvasNode
} from '../src/canvas';

type Rect4 = [number, number, number, number];

/** A fake text measurer: natural size and first baseline; wrapping at a narrower width adds lines. */
function fakeMeasure(texts: Record<string, [number, number, number]>): AutoLayoutMeasure {
	return {
		textSize: (n) => (texts[n.id] ? { width: texts[n.id][0], height: texts[n.id][1] } : undefined),
		textHeight: (n, width) => {
			const t = texts[n.id];
			return t ? t[1] * Math.max(Math.ceil(t[0] / Math.max(width, 1)), 1) : undefined;
		},
		textBaseline: (n) => texts[n.id]?.[2]
	};
}

const frameNode = (id: string, w: number, h: number, layout: AutoLayout, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	position: { x: 0, y: 0 },
	data: { layout },
	width: w,
	height: h,
	...extra
});

const childNode = (
	id: string,
	parentId: string | undefined,
	w: number,
	h: number,
	childLayout?: AutoLayoutChild,
	extra: Partial<CanvasNode> = {}
): CanvasNode => ({
	id,
	parentId,
	position: { x: 0, y: 0 },
	data: childLayout ? { childLayout } : {},
	width: w,
	height: h,
	...extra
});

const rectOf = (nodes: CanvasNode[], id: string): Rect4 => {
	const n = nodes.find((x) => x.id === id)!;
	return [n.position.x, n.position.y, n.width!, n.height!];
};
const sizeOf = (nodes: CanvasNode[], id: string) => rectOf(nodes, id).slice(2);

const closeTo = (got: number[], want: number[]) =>
	got.length === want.length && got.every((g, i) => Math.abs(g - want[i]) < 1e-6);

/** Mutable document helper: set data, lay out, read rects. */
function doc(initial: CanvasNode[], measure?: AutoLayoutMeasure) {
	let nodes = initial;
	return {
		get nodes() {
			return nodes;
		},
		set nodes(next: CanvasNode[]) {
			nodes = next;
		},
		frame(id: string) {
			nodes = applyNodeUpdates(nodes, layoutFrame(nodes, id, { measure }));
		},
		all() {
			nodes = applyNodeUpdates(nodes, layoutAll(nodes, { measure }));
		},
		rect: (id: string) => rectOf(nodes, id),
		size: (id: string) => sizeOf(nodes, id),
		layout(id: string, patch: Partial<AutoLayout>) {
			nodes = nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, layout: { ...n.data.layout, ...patch } } } : n));
		},
		child(id: string, patch: Partial<AutoLayoutChild>) {
			nodes = nodes.map((n) =>
				n.id === id ? { ...n, data: { ...n.data, childLayout: { ...n.data.childLayout, ...patch } } } : n
			);
		},
		add(node: CanvasNode) {
			nodes = [...nodes, node];
		},
		resize(id: string, width: number, height: number) {
			const old = { width: sizeOf(nodes, id)[0], height: sizeOf(nodes, id)[1] };
			nodes = applyNodeUpdates(nodes, [{ id, width, height }]);
			nodes = applyNodeUpdates(nodes, applyConstraints(nodes, id, old, { measure }));
		}
	};
}

// ---------------------------------------------------------------------------------------------
// Rule tables (behaviour_tests.rs / content_align_tests.rs)

interface FrameSpec {
	mode?: AutoLayoutMode;
	wrap?: boolean;
	size?: [number, number];
	sizing?: [AutoLayoutSizing, AutoLayoutSizing];
	pad?: [number, number, number, number];
	gap?: number;
	rowGap?: number;
	main?: AutoLayoutAlignMain;
	cross?: AutoLayoutAlignCross;
	content?: AutoLayoutAlignContent;
	min?: [number?, number?];
	max?: [number?, number?];
	columns?: AutoLayoutGridTrack[];
	rows?: AutoLayoutGridTrack[];
}

interface KidSpec {
	size?: [number, number];
	sizing?: [AutoLayoutSizing, AutoLayoutSizing];
	min?: [number?, number?];
	max?: [number?, number?];
	text?: [number, number, number];
	absolute?: boolean;
	at?: [number, number];
	constraints?: [AutoLayoutHorizontalConstraint, AutoLayoutVerticalConstraint];
	cell?: [number, number];
	span?: [number, number];
	align?: [AutoLayoutCellAlign?, AutoLayoutCellAlign?];
}

interface Case {
	rule: string;
	frame: FrameSpec;
	kids: KidSpec[];
	want: [number, number];
	rects: Rect4[];
}

const kid = (w: number, h: number, extra: KidSpec = {}): KidSpec => ({ size: [w, h], ...extra });
const fr = (v: number): AutoLayoutGridTrack => ({ fr: v });

function build(c: { frame: FrameSpec; kids: KidSpec[] }) {
	const f = c.frame;
	const [w, h] = f.size ?? [100, 100];
	const layout: AutoLayout = {
		mode: f.mode ?? 'horizontal',
		wrap: f.wrap,
		gap: f.gap ?? 0,
		rowGap: f.rowGap ?? 0,
		padding: f.pad ?? 0,
		alignMain: f.main,
		alignCross: f.cross,
		alignContent: f.content,
		sizing: { width: f.sizing?.[0] ?? 'fixed', height: f.sizing?.[1] ?? 'fixed' },
		min: { width: f.min?.[0], height: f.min?.[1] },
		max: { width: f.max?.[0], height: f.max?.[1] },
		grid: { columns: f.columns?.length ? f.columns : 1, rows: f.rows?.length ? f.rows : 1 }
	};
	const nodes: CanvasNode[] = [frameNode('F', w, h, layout)];
	const texts: Record<string, [number, number, number]> = {};
	c.kids.forEach((k, i) => {
		const id = `K${i}`;
		if (k.text) texts[id] = k.text;
		const [kw, kh] = k.size ?? [20, 20];
		nodes.push({
			...childNode(id, 'F', kw, kh, {
				sizing: { width: k.sizing?.[0] ?? 'fixed', height: k.sizing?.[1] ?? 'fixed' },
				min: { width: k.min?.[0], height: k.min?.[1] },
				max: { width: k.max?.[0], height: k.max?.[1] },
				absolute: k.absolute,
				constraints: k.constraints && { horizontal: k.constraints[0], vertical: k.constraints[1] },
				gridArea: {
					column: k.cell?.[0],
					row: k.cell?.[1],
					columnSpan: k.span?.[0],
					rowSpan: k.span?.[1],
					alignX: k.align?.[0],
					alignY: k.align?.[1]
				}
			}),
			position: { x: k.at?.[0] ?? 0, y: k.at?.[1] ?? 0 }
		});
	});
	return { nodes, measure: fakeMeasure(texts), ids: c.kids.map((_, i) => `K${i}`) };
}

function check(cases: Case[]) {
	for (const c of cases) {
		const { nodes, measure, ids } = build(c);
		const once = applyNodeUpdates(nodes, layoutFrame(nodes, 'F', { measure }));
		expect(closeTo(sizeOf(once, 'F'), c.want), `${c.rule}: frame ${sizeOf(once, 'F')}`).toBe(true);
		expect(ids.length).toBe(c.rects.length);
		ids.forEach((id, i) => {
			expect(closeTo(rectOf(once, id), c.rects[i]), `${c.rule}: ${id} is ${rectOf(once, id)}, want ${c.rects[i]}`).toBe(true);
		});
		// A second pass changes nothing (one pass settles).
		expect(layoutFrame(once, 'F', { measure }), `${c.rule}: second pass`).toEqual([]);
	}
}

describe('auto layout rules', () => {
	it('sizing: hug, fixed, fill, min / max and text', () => {
		check([
			{
				rule: 'hug: a 40 px text plus 10 px left and right padding makes a 60 px frame',
				frame: { sizing: ['hug', 'hug'], pad: [0, 10, 0, 10] },
				kids: [{ text: [40, 20, 15], sizing: ['hug', 'hug'] }],
				want: [60, 20],
				rects: [[10, 0, 40, 20]]
			},
			{
				rule: 'fixed: the frame keeps its size whatever its children need',
				frame: { size: [100, 50] },
				kids: [kid(50, 20), kid(50, 20), kid(50, 20)],
				want: [100, 50],
				rects: [[0, 0, 50, 20], [50, 0, 50, 20], [100, 0, 50, 20]]
			},
			{
				rule: 'fill: children share the space left after padding, gaps and fixed siblings',
				frame: { size: [300, 40], pad: [0, 10, 0, 10], gap: 20 },
				kids: [kid(60, 20), { sizing: ['fill', 'fixed'] }, { sizing: ['fill', 'fixed'] }],
				want: [300, 40],
				rects: [[10, 0, 60, 20], [90, 0, 90, 20], [200, 0, 90, 20]]
			},
			{
				rule: "fill across the flow stretches to the frame's inner height",
				frame: { pad: [10, 10, 10, 10] },
				kids: [{ sizing: ['fixed', 'fill'] }],
				want: [100, 100],
				rects: [[10, 10, 20, 80]]
			},
			{
				rule: 'fill on an axis the frame hugs has nothing to fill: the child keeps its size',
				frame: { sizing: ['hug', 'hug'] },
				kids: [kid(50, 20), kid(30, 40, { sizing: ['fill', 'fill'] })],
				want: [80, 40],
				rects: [[0, 0, 50, 20], [50, 0, 30, 40]]
			},
			{
				rule: 'min width: a fixed child is never narrower than its minimum',
				frame: { sizing: ['hug', 'hug'] },
				kids: [kid(50, 20, { min: [80] })],
				want: [80, 20],
				rects: [[0, 0, 80, 20]]
			},
			{
				rule: 'max width on a fill child: it stops at its max and the other fill child takes the rest',
				frame: { size: [200, 20] },
				kids: [{ sizing: ['fill', 'fixed'], max: [50] }, { sizing: ['fill', 'fixed'] }],
				want: [200, 20],
				rects: [[0, 0, 50, 20], [50, 0, 150, 20]]
			},
			{
				rule: 'max width on a hugging frame: it hugs up to its max',
				frame: { sizing: ['hug', 'hug'], max: [200] },
				kids: [kid(300, 20)],
				want: [200, 20],
				rects: [[0, 0, 300, 20]]
			},
			{
				rule: 'min height on a hugging frame: it hugs, but never below its min',
				frame: { sizing: ['hug', 'hug'], min: [undefined, 60] },
				kids: [kid(30, 20)],
				want: [30, 60],
				rects: [[0, 0, 30, 20]]
			},
			{
				rule: 'a hugging text wider than its max width wraps at the max',
				frame: { sizing: ['hug', 'hug'] },
				kids: [{ text: [150, 20, 15], sizing: ['hug', 'hug'], max: [100] }],
				want: [100, 40],
				rects: [[0, 0, 100, 40]]
			},
			{
				rule: 'a text filling the width wraps and its hugging frame grows to its new height',
				frame: { size: [100, 10], sizing: ['fixed', 'hug'], pad: [10, 10, 10, 10] },
				kids: [{ text: [150, 20, 15], sizing: ['fill', 'hug'] }],
				want: [100, 60],
				rects: [[10, 10, 80, 40]]
			}
		]);
	});

	it('padding', () => {
		check([
			{
				rule: "padding: space between the frame's edge and its children, per side",
				frame: { sizing: ['hug', 'hug'], pad: [1, 2, 3, 4] },
				kids: [kid(50, 20)],
				want: [56, 24],
				rects: [[4, 1, 50, 20]]
			},
			{
				rule: 'a fixed frame is never smaller than its padding',
				frame: { size: [10, 10], pad: [20, 20, 20, 20] },
				kids: [],
				want: [40, 40],
				rects: []
			},
			{
				rule: 'the padding floor wins over a max size',
				frame: { size: [100, 50], pad: [0, 20, 0, 20], max: [10] },
				kids: [],
				want: [40, 50],
				rects: []
			},
			{
				rule: 'an empty hugging frame is its padding',
				frame: { sizing: ['hug', 'hug'], pad: [8, 8, 8, 8] },
				kids: [],
				want: [16, 16],
				rects: []
			},
			{
				rule: 'fill children share the space inside padding',
				frame: { size: [100, 50], pad: [15, 15, 15, 15] },
				kids: [{ sizing: ['fill', 'fill'] }],
				want: [100, 50],
				rects: [[15, 15, 70, 20]]
			}
		]);
	});

	it('gaps and auto gaps', () => {
		const three = [kid(20, 20), kid(20, 20), kid(20, 20)];
		check([
			{
				rule: 'gap: a fixed distance between children; a hugging frame includes it',
				frame: { sizing: ['hug', 'hug'], gap: 10 },
				kids: three,
				want: [80, 20],
				rects: [[0, 0, 20, 20], [30, 0, 20, 20], [60, 0, 20, 20]]
			},
			{
				rule: 'negative gap: children overlap by the gap',
				frame: { sizing: ['hug', 'hug'], gap: -10 },
				kids: [kid(50, 20), kid(50, 20)],
				want: [90, 20],
				rects: [[0, 0, 50, 20], [40, 0, 50, 20]]
			},
			{
				rule: 'vertical gap: the same along y',
				frame: { mode: 'vertical', sizing: ['hug', 'hug'], gap: 5 },
				kids: [kid(20, 30), kid(40, 10)],
				want: [40, 45],
				rects: [[0, 0, 20, 30], [0, 35, 40, 10]]
			},
			{
				rule: 'space-between: as far apart as possible, no space at the edges',
				frame: { size: [200, 20], main: 'space-between', gap: 10 },
				kids: three,
				want: [200, 20],
				rects: [[0, 0, 20, 20], [90, 0, 20, 20], [180, 0, 20, 20]]
			},
			{
				rule: 'space-evenly: equal space in every gap and at both edges',
				frame: { size: [200, 20], main: 'space-evenly' },
				kids: three,
				want: [200, 20],
				rects: [[35, 0, 20, 20], [90, 0, 20, 20], [145, 0, 20, 20]]
			},
			{
				rule: 'space-around: gaps twice the edge space',
				frame: { size: [200, 20], main: 'space-around' },
				kids: three,
				want: [200, 20],
				rects: [[70 / 3, 0, 20, 20], [90, 0, 20, 20], [470 / 3, 0, 20, 20]]
			},
			{
				rule: "auto gap stops at 0 when the children don't fit",
				frame: { size: [50, 20], main: 'space-between' },
				kids: [kid(30, 20), kid(30, 20)],
				want: [50, 20],
				rects: [[0, 0, 30, 20], [30, 0, 30, 20]]
			},
			{
				rule: 'space-evenly stops at 0 too',
				frame: { size: [50, 20], main: 'space-evenly' },
				kids: [kid(30, 20), kid(30, 20)],
				want: [50, 20],
				rects: [[0, 0, 30, 20], [30, 0, 30, 20]]
			},
			{
				rule: 'a single child of space-between aligns to the start',
				frame: { size: [200, 20], main: 'space-between' },
				kids: [kid(20, 20)],
				want: [200, 20],
				rects: [[0, 0, 20, 20]]
			},
			{
				rule: 'a single child of space-evenly has equal space on both sides',
				frame: { size: [200, 20], main: 'space-evenly' },
				kids: [kid(20, 20)],
				want: [200, 20],
				rects: [[90, 0, 20, 20]]
			},
			{
				rule: 'auto gap with fill children: they take the free space, leaving no gap',
				frame: { size: [200, 20], main: 'space-between', gap: 10 },
				kids: [kid(20, 20), { sizing: ['fill', 'fixed'] }, kid(20, 20)],
				want: [200, 20],
				rects: [[0, 0, 20, 20], [20, 0, 160, 20], [180, 0, 20, 20]]
			}
		]);
	});

	it('alignment, including baseline', () => {
		const one = [kid(50, 20)];
		check([
			{ rule: 'top left (default)', frame: { size: [200, 100] }, kids: one, want: [200, 100], rects: [[0, 0, 50, 20]] },
			{
				rule: 'center on both axes',
				frame: { size: [200, 100], main: 'center', cross: 'center' },
				kids: one,
				want: [200, 100],
				rects: [[75, 40, 50, 20]]
			},
			{
				rule: 'bottom right',
				frame: { size: [200, 100], main: 'end', cross: 'end' },
				kids: one,
				want: [200, 100],
				rects: [[150, 80, 50, 20]]
			},
			{
				rule: 'vertical flow: main is vertical, cross horizontal',
				frame: { mode: 'vertical', size: [200, 100], main: 'end', cross: 'center' },
				kids: one,
				want: [200, 100],
				rects: [[75, 80, 50, 20]]
			},
			{
				rule: 'alignment works inside the padding',
				frame: { size: [200, 100], pad: [10, 10, 10, 10], main: 'center', cross: 'center' },
				kids: one,
				want: [200, 100],
				rects: [[75, 40, 50, 20]]
			},
			{
				rule: 'a hugging frame has no extra space',
				frame: { sizing: ['hug', 'hug'], main: 'end', cross: 'end' },
				kids: one,
				want: [50, 20],
				rects: [[0, 0, 50, 20]]
			},
			{
				rule: 'auto gap keeps the cross alignment',
				frame: { size: [200, 100], main: 'space-between', cross: 'center' },
				kids: [kid(20, 20), kid(20, 40)],
				want: [200, 100],
				rects: [[0, 40, 20, 20], [180, 30, 20, 40]]
			},
			{
				rule: 'text baselines: texts of different sizes sit on one baseline',
				frame: { sizing: ['hug', 'hug'], cross: 'baseline', gap: 5 },
				kids: [
					{ text: [30, 14, 10], sizing: ['hug', 'hug'] },
					{ text: [60, 28, 20], sizing: ['hug', 'hug'] }
				],
				want: [95, 28],
				rects: [[0, 10, 30, 14], [35, 0, 60, 28]]
			},
			{
				rule: 'baseline alignment: a layer without text sits at the top',
				frame: { sizing: ['hug', 'hug'], cross: 'baseline' },
				kids: [kid(10, 10), { text: [60, 28, 20], sizing: ['hug', 'hug'] }],
				want: [70, 28],
				rects: [[0, 0, 10, 10], [10, 0, 60, 28]]
			},
			{
				rule: 'stretch: fixed-size children fill across the flow',
				frame: { size: [200, 100], pad: [10, 10, 10, 10], cross: 'stretch' },
				kids: [kid(50, 20), kid(30, 20, { max: [undefined, 50] })],
				want: [200, 100],
				rects: [[10, 10, 50, 80], [60, 10, 30, 50]]
			}
		]);
	});

	it('wrap', () => {
		const three = [kid(40, 20), kid(40, 20), kid(40, 20)];
		check([
			{
				rule: 'horizontal wrap: a new row when the width runs out',
				frame: { wrap: true, size: [100, 10], sizing: ['fixed', 'hug'], gap: 10, rowGap: 5 },
				kids: three,
				want: [100, 45],
				rects: [[0, 0, 40, 20], [50, 0, 40, 20], [0, 25, 40, 20]]
			},
			{
				rule: 'vertical wrap: a new column when the height runs out',
				frame: { mode: 'vertical', wrap: true, size: [10, 100], sizing: ['hug', 'fixed'], gap: 10, rowGap: 5 },
				kids: [kid(20, 40), kid(20, 40), kid(20, 40)],
				want: [45, 100],
				rects: [[0, 0, 20, 40], [0, 50, 20, 40], [25, 0, 20, 40]]
			},
			{
				rule: 'vertical wrap is not masonry',
				frame: { mode: 'vertical', wrap: true },
				kids: [kid(20, 30), kid(20, 30), kid(20, 30), kid(20, 30)],
				want: [100, 100],
				rects: [[0, 0, 20, 30], [0, 30, 20, 30], [0, 60, 20, 30], [20, 0, 20, 30]]
			},
			{
				rule: 'wrap: auto gap spreads each row on its own',
				frame: { wrap: true, main: 'space-between', gap: 10, rowGap: 5 },
				kids: three,
				want: [100, 100],
				rects: [[0, 0, 40, 20], [60, 0, 40, 20], [0, 25, 40, 20]]
			},
			{
				rule: 'wrap: cross alignment within each row',
				frame: { wrap: true, size: [100, 10], sizing: ['fixed', 'hug'], gap: 10, cross: 'center' },
				kids: [kid(40, 20), kid(40, 40), kid(40, 20)],
				want: [100, 60],
				rects: [[0, 10, 40, 20], [50, 0, 40, 40], [0, 40, 40, 20]]
			}
		]);
	});

	it('absolute children and constraints', () => {
		check([
			{
				rule: 'absolute: keeps its place; the frame hugs only the flow',
				frame: { sizing: ['hug', 'hug'] },
				kids: [kid(50, 20), kid(200, 200, { absolute: true, at: [5, 5] })],
				want: [50, 20],
				rects: [[0, 0, 50, 20], [5, 5, 200, 200]]
			},
			{
				rule: 'absolute children follow their constraints when the frame resizes (right / bottom)',
				frame: { sizing: ['hug', 'hug'] },
				kids: [kid(50, 20), kid(10, 10, { absolute: true, at: [80, 80], constraints: ['right', 'bottom'] })],
				want: [50, 20],
				rects: [[0, 0, 50, 20], [30, 0, 10, 10]]
			},
			{
				rule: 'absolute children follow their constraints (left and right / center)',
				frame: { size: [200, 100], sizing: ['hug', 'fixed'] },
				kids: [
					kid(100, 20),
					kid(180, 10, { absolute: true, at: [10, 50], constraints: ['leftRight', 'top'] }),
					kid(20, 10, { absolute: true, at: [90, 0], constraints: ['center', 'top'] })
				],
				want: [100, 100],
				rects: [[0, 0, 100, 20], [10, 50, 80, 10], [40, 0, 20, 10]]
			}
		]);
	});

	it('grid tracks, placement, spans and cell alignment', () => {
		check([
			{
				rule: 'fill tracks share the space by fr',
				frame: { mode: 'grid', size: [300, 50], columns: [fr(1), fr(2)] },
				kids: [{ sizing: ['fill', 'fill'] }, { sizing: ['fill', 'fill'] }],
				want: [300, 50],
				rects: [[0, 0, 100, 50], [100, 0, 200, 50]]
			},
			{
				rule: 'fixed tracks keep their size; fill tracks share the rest',
				frame: { mode: 'grid', size: [300, 50], pad: [0, 10, 0, 10], gap: 10, columns: [100, '1fr'] },
				kids: [{ sizing: ['fill', 'fixed'] }, { sizing: ['fill', 'fixed'] }],
				want: [300, 50],
				rects: [[10, 0, 100, 20], [120, 0, 170, 20]]
			},
			{
				rule: 'hug tracks keep the smallest size around their children',
				frame: { mode: 'grid', size: [300, 50], columns: ['hug', fr(1)] },
				kids: [kid(60, 20), { sizing: ['fill', 'fixed'] }],
				want: [300, 50],
				rects: [[0, 0, 60, 20], [60, 0, 240, 20]]
			},
			{
				rule: 'fr like CSS: a fixed child taller than its share keeps its row',
				frame: { mode: 'grid', columns: [fr(1)], rows: [fr(1), fr(1)] },
				kids: [kid(20, 80), { sizing: ['fixed', 'fill'] }],
				want: [100, 100],
				rects: [[0, 0, 20, 80], [0, 80, 20, 20]]
			},
			{
				rule: 'fr: children bigger than every share keep their sizes (the grid overflows)',
				frame: { mode: 'grid', columns: [fr(1)], rows: [fr(1), fr(1)] },
				kids: [kid(20, 80), kid(20, 70)],
				want: [100, 100],
				rects: [[0, 0, 20, 80], [0, 80, 20, 70]]
			},
			{
				rule: 'fr columns: a fixed child wider than its share keeps its column',
				frame: { mode: 'grid', size: [300, 20], columns: [fr(1), fr(2)] },
				kids: [kid(150, 20), { sizing: ['fill', 'fixed'] }],
				want: [300, 20],
				rects: [[0, 0, 150, 20], [150, 0, 150, 20]]
			},
			{
				rule: 'placement: reading order; rows grow to fit the children',
				frame: { mode: 'grid', columns: [fr(1), fr(1)], rows: [fr(1)] },
				kids: [kid(10, 10), kid(10, 10), kid(10, 10)],
				want: [100, 100],
				rects: [[0, 0, 10, 10], [50, 0, 10, 10], [0, 50, 10, 10]]
			},
			{
				rule: 'gap between columns and between rows',
				frame: { mode: 'grid', size: [110, 105], gap: 10, rowGap: 5, columns: [fr(1), fr(1)], rows: [fr(1), fr(1)] },
				kids: [kid(10, 10), kid(10, 10), kid(10, 10)],
				want: [110, 105],
				rects: [[0, 0, 10, 10], [60, 0, 10, 10], [0, 55, 10, 10]]
			},
			{
				rule: 'a child spanning two columns fills both and the gap',
				frame: { mode: 'grid', size: [110, 20], gap: 10, columns: [fr(1), fr(1)] },
				kids: [{ sizing: ['fill', 'fill'], span: [2, 1] }],
				want: [110, 20],
				rects: [[0, 0, 110, 20]]
			},
			{
				rule: 'an anchored child sits in its cell; the rest flow around it',
				frame: { mode: 'grid', columns: [fr(1), fr(1)], rows: [fr(1), fr(1)] },
				kids: [kid(10, 10), { cell: [0, 0] }],
				want: [100, 100],
				rects: [[50, 0, 10, 10], [0, 0, 20, 20]]
			},
			{
				rule: "children align in their cells (the frame's alignment)",
				frame: { mode: 'grid', size: [100, 50], main: 'center', cross: 'center', columns: [fr(1), fr(1)] },
				kids: [kid(20, 20), kid(20, 20)],
				want: [100, 50],
				rects: [[15, 15, 20, 20], [65, 15, 20, 20]]
			},
			{
				rule: 'a child aligns independently in its cell',
				frame: { mode: 'grid', size: [100, 50], main: 'center', cross: 'center', columns: [fr(1), fr(1)] },
				kids: [kid(20, 20), { align: ['end', 'end'] }],
				want: [100, 50],
				rects: [[15, 15, 20, 20], [80, 30, 20, 20]]
			},
			{
				rule: 'a hugging grid keeps the smallest size around its tracks',
				frame: { mode: 'grid', sizing: ['hug', 'hug'], gap: 10, columns: [fr(1), fr(1)] },
				kids: [kid(30, 20), kid(40, 10)],
				want: [80, 20],
				rects: [[0, 0, 30, 20], [40, 0, 40, 10]]
			},
			{
				rule: 'padding around the cells',
				frame: { mode: 'grid', sizing: ['hug', 'hug'], pad: [1, 2, 3, 4], columns: ['hug'] },
				kids: [kid(30, 20)],
				want: [36, 24],
				rects: [[4, 1, 30, 20]]
			}
		]);
	});
});

describe('wrapped lines across the flow (alignContent)', () => {
	interface CaseC {
		rule: string;
		vertical?: boolean;
		size?: [number, number];
		hugCross?: boolean;
		pad?: [number, number, number, number];
		rowGap?: number;
		cross?: AutoLayoutAlignCross;
		content?: AutoLayoutAlignContent;
		kids?: [number, number][];
		fill?: boolean;
		want: Rect4[];
	}
	function run(c: CaseC) {
		const vertical = !!c.vertical;
		const [w, h] = c.size ?? [100, 100];
		const nodes: CanvasNode[] = [
			frameNode('F', w, h, {
				mode: vertical ? 'vertical' : 'horizontal',
				wrap: true,
				gap: 10,
				rowGap: c.rowGap ?? 5,
				padding: c.pad ?? 0,
				alignCross: c.cross,
				alignContent: c.content ?? 'auto',
				sizing: c.hugCross ? (vertical ? { width: 'hug' } : { height: 'hug' }) : undefined
			})
		];
		(c.kids ?? [[40, 20], [40, 20], [40, 20]]).forEach(([kw, kh], i) =>
			nodes.push(childNode(`K${i}`, 'F', kw, kh, c.fill ? { sizing: vertical ? { width: 'fill' } : { height: 'fill' } } : undefined))
		);
		const out = applyNodeUpdates(nodes, layoutFrame(nodes, 'F'));
		return nodes.slice(1).map((n) => rectOf(out, n.id));
	}
	it('packs, centres, spreads and stretches lines', () => {
		const cases: CaseC[] = [
			{ rule: 'packed at the start', want: [[0, 0, 40, 20], [50, 0, 40, 20], [0, 25, 40, 20]] },
			{ rule: 'packed in the centre', cross: 'center', want: [[0, 27.5, 40, 20], [50, 27.5, 40, 20], [0, 52.5, 40, 20]] },
			{ rule: 'packed at the end', cross: 'end', want: [[0, 55, 40, 20], [50, 55, 40, 20], [0, 80, 40, 20]] },
			{ rule: 'space between', content: 'space-between', want: [[0, 0, 40, 20], [50, 0, 40, 20], [0, 80, 40, 20]] },
			{
				rule: 'space between three rows',
				size: [50, 100],
				content: 'space-between',
				want: [[0, 0, 40, 20], [0, 40, 40, 20], [0, 80, 40, 20]]
			},
			{
				rule: 'space between, items still align in their row',
				content: 'space-between',
				cross: 'center',
				kids: [[40, 20], [40, 40], [40, 20]],
				want: [[0, 10, 40, 20], [50, 0, 40, 40], [0, 80, 40, 20]]
			},
			{
				rule: 'space between inside padding',
				pad: [10, 0, 10, 0],
				content: 'space-between',
				want: [[0, 10, 40, 20], [50, 10, 40, 20], [0, 70, 40, 20]]
			},
			{
				rule: 'space between with no free space: rows touch and align',
				size: [100, 30],
				content: 'space-between',
				cross: 'center',
				want: [[0, -5, 40, 20], [50, -5, 40, 20], [0, 15, 40, 20]]
			},
			{
				rule: 'space between with one row: like packed',
				size: [200, 100],
				content: 'space-between',
				cross: 'end',
				want: [[0, 80, 40, 20], [50, 80, 40, 20], [100, 80, 40, 20]]
			},
			{
				rule: 'space between in a frame hugging its height',
				hugCross: true,
				content: 'space-between',
				want: [[0, 0, 40, 20], [50, 0, 40, 20], [0, 25, 40, 20]]
			},
			{
				rule: 'rows of nothing but fill children stretch',
				fill: true,
				want: [[0, 0, 40, 47.5], [50, 0, 40, 47.5], [0, 52.5, 40, 47.5]]
			},
			{
				rule: 'vertical wrap, columns packed in the centre',
				vertical: true,
				cross: 'center',
				kids: [[20, 40], [20, 40], [20, 40]],
				want: [[27.5, 0, 20, 40], [27.5, 50, 20, 40], [52.5, 0, 20, 40]]
			},
			{
				rule: 'vertical wrap, space between columns',
				vertical: true,
				content: 'space-between',
				kids: [[20, 40], [20, 40], [20, 40]],
				want: [[0, 0, 20, 40], [0, 50, 20, 40], [80, 0, 20, 40]]
			}
		];
		for (const c of cases) {
			const got = run(c);
			got.forEach((g, i) => expect(closeTo(g, c.want[i]), `${c.rule}: ${i} is ${g}, want ${c.want[i]}`).toBe(true));
		}
	});

	it('handles empty, tiny and non-finite frames', () => {
		expect(run({ rule: 'empty', kids: [], content: 'space-between', want: [] })).toEqual([]);
		for (const [w, h, gap] of [
			[0, 0, 5],
			[100, 1e-9, NaN],
			[1e12, 1e12, Infinity],
			[50, 100, -1e9]
		]) {
			const got = run({ rule: 'hostile', size: [w, h], rowGap: gap, content: 'space-between', cross: 'center', want: [] });
			expect(got.every((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]))).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// Individual behaviours (tests.rs / nested_tests.rs)

function setup(mode: AutoLayoutMode) {
	return doc([
		frameNode('F', 300, 100, { mode, gap: 10, padding: 5 }),
		childNode('A', 'F', 50, 20),
		childNode('B', 'F', 30, 40)
	]);
}

describe('layoutFrame', () => {
	it('stacks horizontally', () => {
		const d = setup('horizontal');
		d.frame('F');
		expect(d.rect('A')).toEqual([5, 5, 50, 20]);
		expect(d.rect('B')).toEqual([65, 5, 30, 40]);
	});

	it('hugs its content', () => {
		const d = setup('horizontal');
		d.layout('F', { sizing: { width: 'hug', height: 'hug' } });
		d.frame('F');
		expect(d.size('F')).toEqual([5 + 50 + 10 + 30 + 5, 50]);
	});

	it('centres across a vertical stack', () => {
		const d = setup('vertical');
		d.layout('F', { alignCross: 'center' });
		d.frame('F');
		expect(d.rect('A')[0]).toBe(125);
		expect(d.rect('B')[1]).toBe(5 + 20 + 10);
	});

	it('shares space among fill children, honouring max', () => {
		const d = setup('horizontal');
		d.child('A', { sizing: { width: 'fill' } });
		d.child('B', { sizing: { width: 'fill', height: 'fill' } });
		d.frame('F');
		expect(d.rect('A')[2]).toBe(140);
		expect(d.rect('B')[0]).toBe(5 + 140 + 10);
		expect(d.rect('B')[3]).toBe(90);
		d.child('A', { max: { width: 100 } });
		d.frame('F');
		expect(d.rect('A')[2]).toBe(100);
		expect(d.rect('B')[2]).toBe(180);
	});

	it('spreads space-between and leaves absolute children in place', () => {
		const d = setup('horizontal');
		d.layout('F', { alignMain: 'space-between' });
		d.add({ ...childNode('Abs', 'F', 10, 10, { absolute: true }), position: { x: 7, y: 7 } });
		d.frame('F');
		expect(d.rect('B')[0]).toBe(300 - 5 - 30);
		expect(d.rect('Abs')[0]).toBe(7);
		expect(getFlowChildren(d.nodes, 'F')).toEqual(['A', 'B']);
	});

	it('wraps into rows and hugs them', () => {
		const nodes = [frameNode('F', 100, 100, { mode: 'horizontal', wrap: true, gap: 10, rowGap: 5, sizing: { height: 'hug' } })];
		for (let i = 0; i < 5; i++) nodes.push(childNode(`R${i}`, 'F', 40, 20));
		const d = doc(nodes);
		d.frame('F');
		expect(d.rect('R2')).toEqual([0, 25, 40, 20]);
		expect(d.size('F')[1]).toBe(20 * 3 + 5 * 2);
	});

	it('places grid cells', () => {
		const nodes = [frameNode('F', 210, 110, { mode: 'grid', gap: 10, grid: { columns: 2, rows: 2 } })];
		for (let i = 0; i < 4; i++) nodes.push(childNode(`R${i}`, 'F', 10, 10));
		const d = doc(nodes);
		d.frame('F');
		expect(d.rect('R3').slice(0, 2)).toEqual([110, 60]);
	});

	it('clamps fixed children and the frame to their limits', () => {
		const d = setup('horizontal');
		d.child('A', { min: { width: 80 } });
		d.child('B', { max: { height: 25 } });
		d.layout('F', { max: { width: 200 } });
		d.frame('F');
		expect(d.rect('A')[2]).toBe(80);
		expect(d.rect('B')).toEqual([95, 5, 30, 25]);
		expect(d.size('F')[0]).toBe(200);
	});

	it('applies min / max to hugging frames and fill children', () => {
		const d = setup('horizontal');
		d.layout('F', { sizing: { width: 'hug' }, min: { width: 200 } });
		d.frame('F');
		expect(d.size('F')[0]).toBe(200);
		d.layout('F', { min: undefined, max: { width: 60 } });
		d.frame('F');
		expect(d.size('F')[0]).toBe(60);
		const e = setup('horizontal');
		e.child('A', { sizing: { width: 'fill' }, min: { width: 200 } });
		e.child('B', { sizing: { width: 'fill' } });
		e.frame('F');
		expect(e.rect('A')[2]).toBe(200);
		expect(e.rect('B')[2]).toBe(80);
	});

	it('lets min win over a smaller max and ignores junk limits', () => {
		const d = setup('vertical');
		d.child('A', { min: { width: 90, height: NaN }, max: { width: 40, height: -Infinity } });
		d.frame('F');
		expect(d.rect('A')[2]).toBe(90);
		expect(d.rect('A')[3]).toBe(20);
		expect(clampLayoutSize(-5)).toBe(0);
		expect(clampLayoutSize(NaN, 3)).toBe(3);
	});

	it('wraps hugging text at its max width', () => {
		const measure = fakeMeasure({ T: [200, 20, 15] });
		const d = doc([frameNode('F', 10, 10, { mode: 'horizontal' }), childNode('T', 'F', 10, 10, { sizing: { width: 'hug', height: 'hug' } })], measure);
		d.frame('F');
		expect(d.rect('T')[2]).toBe(200);
		d.child('T', { max: { width: 80 } });
		d.frame('F');
		expect(d.size('T')).toEqual([80, 60]);
		d.child('T', { max: undefined });
		d.frame('F');
		expect(d.size('T')).toEqual([200, 20]);
	});

	it('moves absolute children by their constraints when hugging resizes the frame', () => {
		const d = setup('horizontal');
		d.add({ ...childNode('Badge', 'F', 10, 10, { absolute: true, constraints: { horizontal: 'right', vertical: 'top' } }), position: { x: 280, y: 4 } });
		d.layout('F', { sizing: { width: 'hug' } });
		d.frame('F');
		expect(d.size('F')[0]).toBe(100);
		expect(d.rect('Badge')).toEqual([80, 4, 10, 10]);
		// A plain resize moves only absolute children.
		const first = d.rect('A');
		d.resize('F', 150, 100);
		expect(d.rect('Badge')[0]).toBe(130);
		expect(d.rect('A')).toEqual(first);
	});

	it('aligns baselines, including nested frames', () => {
		const measure = fakeMeasure({ small: [30, 14, 10], big: [60, 40, 30], t2: [20, 60, 50] });
		const hugText = { sizing: { width: 'hug', height: 'hug' } } as const;
		const d = doc(
			[
				frameNode('F', 10, 10, { mode: 'horizontal', padding: 5, alignCross: 'baseline', sizing: { height: 'hug' } }),
				childNode('small', 'F', 10, 10, hugText),
				childNode('big', 'F', 10, 10, hugText),
				childNode('R', 'F', 10, 20)
			],
			measure
		);
		d.frame('F');
		expect(d.rect('small')[1]).toBe(25);
		expect(d.rect('big')[1]).toBe(5);
		expect(d.rect('R')[1]).toBe(5);
		expect(d.size('F')[1]).toBe(50);
		// Nest it in a baseline-aligned row next to a taller text.
		d.nodes = [
			frameNode('O', 400, 100, { mode: 'horizontal', alignCross: 'baseline' }),
			...d.nodes.map((n) => (n.id === 'F' ? { ...n, parentId: 'O' } : n)),
			childNode('t2', 'O', 10, 10, hugText)
		];
		d.all();
		expect(d.rect('F')[1]).toBe(15);
		expect(d.rect('t2')[1]).toBe(0);
		d.layout('O', { mode: 'vertical' });
		d.frame('O');
		expect(d.rect('F')[0]).toBe(0);
		expect(d.rect('t2')[0]).toBe(0);
	});

	it('resolves fixed, hug and fr grid tracks', () => {
		const nodes = [frameNode('G', 400, 100, { mode: 'grid', gap: 10, grid: { columns: [50, 'hug', '1fr', { fr: 2 }], rows: 1 } })];
		for (let i = 0; i < 4; i++) nodes.push(childNode(`R${i}`, 'G', 30 + i, 20, { sizing: { width: i === 1 ? 'fixed' : 'fill' } }));
		const d = doc(nodes);
		d.frame('G');
		const g = getAutoLayoutGrid(d.nodes, 'G')!;
		expect(g.columns[0]).toEqual([0, 50]);
		expect(g.columns[1]).toEqual([60, 91]);
		expect(g.columns[2][1] - g.columns[2][0]).toBeCloseTo(289 / 3, 9);
		expect(g.columns[3][1]).toBeCloseTo(400, 9);
		expect(d.rect('R0')[2]).toBe(50);
		expect(d.rect('R3')[2]).toBeCloseTo((289 * 2) / 3, 9);
		expect(g.rows).toEqual([[0, 100]]);
	});

	it('places spanning and anchored grid children', () => {
		const d = doc([
			frameNode('G', 320, 200, { mode: 'grid', gap: 10, grid: { columns: 3, rows: 1 } }),
			childNode('R0', 'G', 10, 10, { gridArea: { columnSpan: 2 }, sizing: { width: 'fill' } }),
			childNode('R1', 'G', 10, 10),
			childNode('R2', 'G', 10, 10),
			childNode('R3', 'G', 10, 10, { gridArea: { column: 0, row: 2 } })
		]);
		d.frame('G');
		const g = getAutoLayoutGrid(d.nodes, 'G')!;
		const cell = (id: string) => g.cells.find((c) => c.id === id)!;
		expect([cell('R0').column, cell('R0').row, cell('R0').columnSpan]).toEqual([0, 0, 2]);
		expect([cell('R1').column, cell('R1').row]).toEqual([2, 0]);
		expect([cell('R2').column, cell('R2').row]).toEqual([0, 1]);
		expect([cell('R3').column, cell('R3').row]).toEqual([0, 2]);
		expect(g.rows.length).toBe(3);
		expect(d.rect('R0')[2]).toBe(210);
		expect(d.rect('R1')[0]).toBe(220);
		expect(d.rect('R3')[1]).toBe(140);
	});

	it('grows hug columns for a spanning child in a hugging grid', () => {
		const d = doc([
			frameNode('G', 10, 10, { mode: 'grid', gap: 10, sizing: { width: 'hug', height: 'hug' }, grid: { columns: ['hug', 20], rows: 1 } }),
			childNode('A', 'G', 40, 10),
			childNode('W', 'G', 100, 30, { gridArea: { columnSpan: 2 } })
		]);
		d.frame('G');
		expect(d.size('G')).toEqual([100, 10 + 10 + 30]);
		expect(d.rect('W')[1]).toBe(20);
	});

	it('survives hostile values', () => {
		const d = doc([
			frameNode('F', 300, 100, { mode: 'horizontal', gap: NaN, padding: [Infinity, -1, NaN, 1e300], grid: { columns: 0 } }),
			childNode('A', 'F', 50, 20),
			childNode('B', 'F', 30, 40)
		]);
		d.frame('F');
		d.layout('F', { mode: 'grid' });
		d.frame('F');
		const g = doc([
			frameNode('G', NaN, -5, { mode: 'grid', gap: 10, grid: { columns: [NaN, { fr: Infinity }, { fr: -3 }], rows: [1e300] } }),
			childNode('R', 'G', 10, 10, {
				sizing: { width: 'fill' },
				gridArea: { column: 2 ** 32, row: 2 ** 32, columnSpan: 2 ** 32, rowSpan: 2 ** 32 }
			}),
			...Array.from({ length: 20 }, (_, i) => childNode(`K${i}`, 'G', 10, 10, { gridArea: { columnSpan: 3 } }))
		]);
		g.frame('G');
		const geo = getAutoLayoutGrid(g.nodes, 'G')!;
		expect(geo.columns.length).toBe(3);
		expect(geo.rows.length).toBeLessThanOrEqual(1000);
		expect(Number.isFinite(geo.width) && Number.isFinite(geo.height)).toBe(true);
		for (const n of g.nodes.filter((x) => x.parentId === 'G')) {
			const r = rectOf(g.nodes, n.id);
			expect(r.every((v) => Number.isFinite(v))).toBe(true);
		}
	});

	it('reads padding shorthands', () => {
		expect(resolvePadding(4)).toEqual([4, 4, 4, 4]);
		expect(resolvePadding([1, 2])).toEqual([1, 2, 1, 2]);
		expect(resolvePadding({ left: 3 })).toEqual([0, 0, 0, 3]);
		expect(resolvePadding(undefined)).toEqual([0, 0, 0, 0]);
	});
});

describe('nested frames', () => {
	const al = (id: string, parentId: string | undefined, mode: AutoLayoutMode, w: number, h: number, sw: AutoLayoutSizing, sh: AutoLayoutSizing, extra: Partial<AutoLayout> = {}): CanvasNode => ({
		...frameNode(id, w, h, { mode, gap: 10, ...extra }),
		parentId,
		data: { layout: { mode, gap: 10, ...extra }, childLayout: { sizing: { width: sw, height: sh } } }
	});

	it('propagates hug from children to parents with layoutAll', () => {
		const d = doc([
			al('Outer', undefined, 'horizontal', 10, 10, 'hug', 'fixed', { gap: 0 }),
			al('Inner', 'Outer', 'horizontal', 10, 10, 'hug', 'fixed', { gap: 0 }),
			childNode('R', 'Inner', 77, 10)
		]);
		d.all();
		expect(d.size('Inner')[0]).toBe(77);
		expect(d.size('Outer')[0]).toBe(77);
	});

	it('treats fill children of a hugging parent as fixed', () => {
		const d = doc([
			al('F', undefined, 'horizontal', 10, 10, 'hug', 'hug'),
			childNode('A', 'F', 50, 20),
			childNode('B', 'F', 30, 40, { sizing: { width: 'fill', height: 'fill' } }),
			al('G', undefined, 'vertical', 10, 10, 'hug', 'hug'),
			childNode('C', 'G', 60, 20, { sizing: { width: 'fill' } }),
			childNode('D', 'G', 40, 30)
		]);
		d.all();
		expect(d.size('F')).toEqual([90, 40]);
		expect(d.rect('B')).toEqual([60, 0, 30, 40]);
		expect(d.size('G')).toEqual([60, 60]);
		expect(d.size('C')).toEqual([60, 20]);
	});

	it('redistributes fill space when children hit min or max', () => {
		const nodes = [al('F', undefined, 'horizontal', 320, 50, 'fixed', 'fixed')];
		for (const id of ['a', 'b', 'c']) nodes.push(childNode(id, 'F', 10, 10, { sizing: { width: 'fill' } }));
		const d = doc(nodes);
		const widths = () => {
			d.frame('F');
			return ['a', 'b', 'c'].map((id) => d.size(id)[0]);
		};
		expect(widths()).toEqual([100, 100, 100]);
		d.child('a', { max: { width: 50 } });
		expect(widths()).toEqual([50, 125, 125]);
		d.child('b', { max: { width: 100 } });
		expect(widths()).toEqual([50, 100, 150]);
		d.child('b', { max: undefined, min: { width: 120 } });
		expect(widths()).toEqual([50, 125, 125]);
		d.child('a', { max: undefined, min: { width: 200 } });
		d.child('b', { min: { width: 200 } });
		expect(widths()).toEqual([200, 200, 0]);
		expect(d.rect('c')[0]).toBe(420);
	});

	it('wraps fill text and hugs its new height, through nested cards', () => {
		const fillText = { sizing: { width: 'fill', height: 'hug' } } as const;
		const d = doc(
			[
				al('F', undefined, 'vertical', 200, 10, 'fixed', 'hug', { padding: 10 }),
				childNode('t', 'F', 10, 10, fillText),
				al('G', undefined, 'horizontal', 200, 10, 'fixed', 'hug'),
				childNode('r', 'G', 50, 30),
				childNode('t2', 'G', 10, 10, fillText),
				al('col', undefined, 'vertical', 300, 10, 'fixed', 'hug'),
				al('card', 'col', 'vertical', 1, 1, 'fill', 'hug', { padding: 10 }),
				childNode('t3', 'card', 10, 10, fillText)
			],
			fakeMeasure({ t: [300, 20, 15], t2: [450, 20, 15], t3: [560, 20, 15] })
		);
		d.frame('F');
		expect(d.size('t')).toEqual([180, 40]);
		expect(d.size('F')).toEqual([200, 60]);
		d.frame('G');
		expect(d.size('t2')).toEqual([140, 80]);
		expect(d.size('G')).toEqual([200, 80]);
		d.all();
		expect(d.size('t3')).toEqual([280, 40]);
		expect(d.size('card')).toEqual([300, 60]);
		expect(d.size('col')).toEqual([300, 60]);
	});

	it('settles three levels of mixed sizing in one pass', () => {
		const d = doc([
			al('outer', undefined, 'vertical', 400, 1, 'fixed', 'hug', { padding: 10 }),
			childNode('header', 'outer', 1, 20, { sizing: { width: 'fill' } }),
			al('middle', 'outer', 'horizontal', 1, 1, 'fill', 'hug'),
			childNode('icon', 'middle', 50, 20),
			al('inner', 'middle', 'vertical', 1, 1, 'fill', 'hug'),
			childNode('bar', 'inner', 1, 30, { sizing: { width: 'fill' } }),
			childNode('tag', 'inner', 20, 40),
			al('side', 'middle', 'horizontal', 1, 1, 'hug', 'hug', { padding: 5 }),
			childNode('dot', 'side', 10, 10)
		]);
		d.all();
		expect(d.size('header')).toEqual([380, 20]);
		expect(d.size('side')).toEqual([20, 20]);
		expect(d.rect('inner')).toEqual([60, 0, 290, 80]);
		expect(d.size('bar')).toEqual([290, 30]);
		expect(d.rect('tag')).toEqual([0, 40, 20, 40]);
		expect(d.rect('middle')).toEqual([10, 40, 380, 80]);
		expect(d.rect('side')[0]).toBe(360);
		expect(d.rect('icon')).toEqual([0, 0, 50, 20]);
		expect(d.size('outer')).toEqual([400, 130]);
		// The outer column shrinks: everything follows in one pass.
		d.nodes = applyNodeUpdates(d.nodes, [{ id: 'outer', width: 300 }]);
		d.all();
		expect(d.size('inner')).toEqual([190, 80]);
		expect(d.size('bar')).toEqual([190, 30]);
		expect(d.rect('side')[0]).toBe(260);
		// layoutUp from a deep change re-runs only the chain, with the same result.
		expect(layoutUp(d.nodes, 'bar')).toEqual([]);
	});

	it('hugs only visible flow children', () => {
		const d = doc([
			al('outer', undefined, 'vertical', 1, 1, 'hug', 'hug'),
			al('F', 'outer', 'horizontal', 1, 1, 'hug', 'hug'),
			childNode('a', 'F', 50, 20),
			childNode('hidden', 'F', 100, 100, undefined, { hidden: true }),
			childNode('b', 'F', 30, 10),
			{ ...childNode('abs', 'F', 40, 40, { absolute: true }), position: { x: 300, y: 300 } }
		]);
		d.all();
		expect(d.size('F')).toEqual([90, 20]);
		expect(d.rect('b')[0]).toBe(60);
		expect(d.size('outer')).toEqual([90, 20]);
		expect(d.rect('abs')).toEqual([300, 300, 40, 40]);
	});

	it('starts a single space-between child at the start', () => {
		for (const mode of ['horizontal', 'vertical'] as const) {
			const d = doc([al('F', undefined, mode, 300, 300, 'fixed', 'fixed', { padding: 5, alignMain: 'space-between' }), childNode('a', 'F', 50, 50)]);
			d.frame('F');
			expect(d.rect('a')).toEqual([5, 5, 50, 50]);
			d.add(childNode('b', 'F', 50, 50));
			d.frame('F');
			expect(mode === 'horizontal' ? d.rect('b')[0] : d.rect('b')[1]).toBe(245);
		}
	});

	it('wraps with fill children', () => {
		const d = doc([
			al('F', undefined, 'horizontal', 200, 100, 'fixed', 'fixed', { wrap: true }),
			childNode('a', 'F', 10, 20, { sizing: { width: 'fill' }, min: { width: 80 } }),
			childNode('b', 'F', 10, 20, { sizing: { width: 'fill' }, min: { width: 80 } }),
			childNode('c', 'F', 50, 30),
			childNode('e', 'F', 40, 10, { sizing: { height: 'fill' } })
		]);
		d.frame('F');
		expect(d.rect('a')).toEqual([0, 0, 95, 20]);
		expect(d.rect('b')).toEqual([105, 0, 95, 20]);
		expect(d.rect('c')).toEqual([0, 30, 50, 30]);
		expect(d.rect('e')).toEqual([60, 30, 40, 30]);
		expect(d.size('F')).toEqual([200, 100]);
		const g = doc([
			al('G', undefined, 'horizontal', 100, 200, 'fixed', 'fixed', { wrap: true }),
			childNode('tall', 'G', 60, 50),
			childNode('lone', 'G', 60, 25, { sizing: { height: 'fill' } })
		]);
		g.frame('G');
		expect(g.rect('tall')).toEqual([0, 0, 60, 50]);
		expect(g.rect('lone')).toEqual([0, 60, 60, 25]);
		g.child('G', { sizing: { width: 'fixed', height: 'hug' } });
		g.frame('G');
		expect(g.size('G')).toEqual([100, 85]);
	});

	it('sizes hug grid tracks around wrapping text rows', () => {
		const d = doc(
			[
				al('F', undefined, 'grid', 300, 1, 'fixed', 'hug', { grid: { columns: ['hug', '1fr'], rows: 1 } }),
				childNode('a', 'F', 60, 20),
				childNode('t', 'F', 10, 10, { sizing: { width: 'fill', height: 'hug' } })
			],
			fakeMeasure({ t: [480, 20, 15] })
		);
		d.frame('F');
		expect(d.rect('a')).toEqual([0, 0, 60, 20]);
		expect(d.rect('t')).toEqual([70, 0, 230, 60]);
		expect(d.size('F')).toEqual([300, 60]);
		d.child('a', { sizing: { width: 'fill' }, min: { width: 40 } });
		d.frame('F');
		expect(d.rect('a')[2]).toBe(40);
		expect(d.rect('t')[0]).toBe(50);
	});

	it('treats fill in a plain parent as fixed, follows constraints, and makes sizing coherent', () => {
		const d = doc([
			{ id: 'P', position: { x: 0, y: 0 }, data: {}, width: 200, height: 100 },
			{ ...childNode('r', 'P', 50, 20, { sizing: { width: 'fill', height: 'fill' } }), position: { x: 10, y: 10 } }
		]);
		d.all();
		expect(d.rect('r')).toEqual([10, 10, 50, 20]);
		d.resize('P', 400, 300);
		expect(d.rect('r')).toEqual([10, 10, 50, 20]);
		const next = makeSizingCoherent(d.nodes, 'r');
		expect(next).not.toBe(d.nodes);
		const r = next.find((n) => n.id === 'r')!;
		expect([getLayoutSizing(r, 'width'), getLayoutSizing(r, 'height')]).toEqual(['fixed', 'fixed']);
	});

	it('follows right / topBottom and center / scale constraints', () => {
		const d = doc([
			{ id: 'P', position: { x: 0, y: 0 }, data: {}, width: 100, height: 100 },
			{ ...childNode('r', 'P', 10, 10, { constraints: { horizontal: 'right', vertical: 'topBottom' } }), position: { x: 80, y: 10 } },
			{ ...childNode('c', 'P', 10, 10, { constraints: { horizontal: 'center', vertical: 'scale' } }), position: { x: 45, y: 45 } }
		]);
		d.resize('P', 200, 200);
		expect(d.rect('r')).toEqual([180, 10, 10, 110]);
		expect(d.rect('c')).toEqual([95, 90, 10, 20]);
	});

	it('downgrades incoherent sizing', () => {
		let nodes: CanvasNode[] = [
			al('F', undefined, 'horizontal', 200, 50, 'hug', 'fixed'),
			childNode('a', 'F', 10, 10, { sizing: { width: 'fill', height: 'fill' } }),
			childNode('abs', 'F', 10, 10, { sizing: { width: 'fill' }, absolute: true }),
			childNode('r', undefined, 10, 10, { sizing: { width: 'hug' } }),
			childNode('t', undefined, 10, 10, { sizing: { width: 'hug', height: 'hug' } })
		];
		const measure = fakeMeasure({ t: [10, 10, 8] });
		const sizing = (id: string) => {
			const n = nodes.find((x) => x.id === id)!;
			return [getLayoutSizing(n, 'width'), getLayoutSizing(n, 'height')];
		};
		nodes = makeSizingCoherent(nodes, 'F');
		expect(sizing('a')).toEqual(['fixed', 'fill']);
		expect(sizing('abs')).toEqual(['fixed', 'fixed']);
		expect(sizing('F')).toEqual(['hug', 'fixed']);
		expect(makeSizingCoherent(nodes, 'F')).toBe(nodes);
		nodes = makeSizingCoherent(nodes, 'r');
		expect(sizing('r')).toEqual(['fixed', 'fixed']);
		// Text-like nodes (measured by `textSize`) can hug; a missing node is a no-op.
		expect(makeSizingCoherent(nodes, 't', { measure })).toBe(nodes);
		expect(makeSizingCoherent(nodes, 'missing')).toBe(nodes);
	});

	it('tolerates parentId cycles', () => {
		const nodes: CanvasNode[] = [
			{ ...frameNode('A', 10, 10, { mode: 'horizontal', sizing: { width: 'hug' } }), parentId: 'B' },
			{ ...frameNode('B', 10, 10, { mode: 'horizontal', sizing: { width: 'hug' } }), parentId: 'A' }
		];
		expect(() => layoutAll(nodes)).not.toThrow();
		expect(() => layoutUp(nodes, 'A')).not.toThrow();
	});
});

describe('reordering', () => {
	const stack = () => [
		frameNode('F', 300, 100, { mode: 'horizontal', gap: 10, padding: 5 }),
		{ ...childNode('a', 'F', 50, 20), position: { x: 5, y: 5 } },
		{ ...childNode('b', 'F', 50, 20), position: { x: 65, y: 5 } },
		childNode('b1', 'b', 5, 5),
		{ ...childNode('c', 'F', 50, 20), position: { x: 125, y: 5 } }
	];

	it('finds the insert index and marker under a point', () => {
		const nodes = stack();
		expect(getAutoLayoutInsertTarget(nodes, 'F', { x: 0, y: 10 })!.index).toBe(0);
		const mid = getAutoLayoutInsertTarget(nodes, 'F', { x: 100, y: 10 })!;
		expect(mid.index).toBe(2);
		expect(mid.guide.orientation).toBe('vertical');
		expect(mid.guide.x1).toBe(120);
		expect(getAutoLayoutInsertTarget(nodes, 'F', { x: 999, y: 10 }, { excludeId: 'a' })!.index).toBe(2);
		expect(getAutoLayoutInsertTarget(nodes, 'b', { x: 0, y: 0 })).toBeUndefined();
	});

	it('reads wrapped and grid frames in rows', () => {
		const nodes = [
			frameNode('F', 100, 100, { mode: 'horizontal', wrap: true, gap: 10 }),
			{ ...childNode('a', 'F', 40, 20), position: { x: 0, y: 0 } },
			{ ...childNode('b', 'F', 40, 20), position: { x: 50, y: 0 } },
			{ ...childNode('c', 'F', 40, 20), position: { x: 0, y: 30 } }
		];
		expect(getAutoLayoutInsertTarget(nodes, 'F', { x: 80, y: 10 })!.index).toBe(2);
		expect(getAutoLayoutInsertTarget(nodes, 'F', { x: 90, y: 40 })!.index).toBe(3);
		expect(getAutoLayoutInsertTarget(nodes, 'F', { x: 5, y: 40 })!.index).toBe(2);
	});

	it('moves a child in the array, keeping parents before children', () => {
		const nodes = stack();
		const moved = moveLayoutChild(nodes, 'b', 2);
		expect(getFlowChildren(moved, 'F')).toEqual(['a', 'c', 'b']);
		expect(moved.findIndex((n) => n.id === 'b')).toBeLessThan(moved.findIndex((n) => n.id === 'b1'));
		expect(moveLayoutChild(nodes, 'b', 1)).toBe(nodes);
		expect(getFlowChildren(moveLayoutChild(nodes, 'c', 0), 'F')).toEqual(['c', 'a', 'b']);
		expect(getLayoutParent(nodes, 'a')!.id).toBe('F');
		expect(getLayoutParent(nodes, 'b1')).toBeUndefined();
	});
});
