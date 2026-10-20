// Object snap tracking, polar angles and typed dimensions. After ArtCraft cadcraft
// `crates/engine/src/snap/tracking.rs` (`polar_angles`, `Tracker`, `Tracker::paths`,
// `Tracker::find`) (MIT OR Apache-2.0, © ArtCraft Team and contributors); test cases
// re-expressed. See THIRD_PARTY_NOTICES.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	VectorSnapTargets,
	VECTOR_MAX_TRACKING_POINTS,
	createVectorCommands,
	getVectorOverlayRenderData,
	rectSubpath,
	vectorAngleDirection,
	vectorPolarAngles,
	vectorTrackingPaths,
	type VectorDocument,
	type VectorNode,
	type VectorPathNode
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h = w): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: h })], fill: '#f00', stroke: null });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 800, height: 600, nodes });
const round = (p: { x: number; y: number }) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000];

describe('polar angles and tracking paths', () => {
	it('lists every multiple of the increment plus extra angles, without repeats', () => {
		expect(vectorPolarAngles(90)).toEqual([0, 90, 180, 270]);
		expect(vectorPolarAngles(30)).toHaveLength(12);
		expect(vectorPolarAngles(90, [45, 90, 405, -45])).toEqual([0, 90, 180, 270, 45, 315]);
		// A hostile increment is capped; none at all is just 0°.
		expect(vectorPolarAngles(0.0001)).toHaveLength(360);
		expect(vectorPolarAngles(0)).toEqual([0]);
	});

	it('turns angles counter-clockwise on the y-down page, exactly on the axes', () => {
		expect(vectorAngleDirection(0)).toEqual({ x: 1, y: 0 });
		expect(vectorAngleDirection(90)).toEqual({ x: 0, y: -1 });
		expect(vectorAngleDirection(180)).toEqual({ x: -1, y: 0 });
	});

	it('sends horizontal and vertical rays from acquired points, and an end\'s extension', () => {
		const paths = vectorTrackingPaths([{ x: 10, y: 20, extension: { x: 3, y: 4 } }]);
		expect(paths.filter((p) => p.kind === 'alignment')).toHaveLength(4);
		expect(paths.find((p) => p.kind === 'extension')!.dir).toEqual({ x: 0.6, y: 0.8 });
	});
});

describe('snapping to tracking paths', () => {
	// Nothing to snap to but the tracking paths (anchors far away).
	const targets = VectorSnapTargets.forDrawing(doc(rect('far', 1000, 1000, 10)), []);

	it('snaps where the paths of two acquired points cross', () => {
		const paths = vectorTrackingPaths([
			{ x: 0, y: 0 },
			{ x: 100, y: 50 }
		]);
		// Right of the first point and below the second: their paths cross at (100, 0).
		const r = targets.snapFrom({ x: 98, y: 2 }, null, 5, paths);
		expect(r.kind).toBe('tracking');
		expect(round(r.point)).toEqual([100, 0]);
		expect(r.lines).toHaveLength(2);
	});

	it('slides onto the nearest path, but not right at the point it comes from', () => {
		const paths = vectorTrackingPaths([{ x: 250, y: 250 }]);
		const r = targets.snapFrom({ x: 310, y: 253 }, null, 5, paths);
		expect([r.kind, ...round(r.point)]).toEqual(['tracking', 310, 250]);
		expect(targets.snapFrom({ x: 252, y: 252 }, null, 5, paths).kind).toBeNull();
	});

	it('snaps where a tracking path crosses a path of the drawing', () => {
		const withRect = VectorSnapTargets.forDrawing(doc(rect('r', 200, -50, 100, 100)), []);
		const r = withRect.snapFrom({ x: 201, y: 3 }, null, 5, vectorTrackingPaths([{ x: 0, y: 0 }]));
		expect([r.kind, ...round(r.point)]).toEqual(['intersect', 200, 0]);
	});

	it('crosses polar paths from where a point leaves with an acquired point\'s path', () => {
		// 45° up-right from (0, 0) meets the vertical through (50, 200) at (50, -50).
		const r = targets.snapFrom({ x: 52, y: -48 }, { at: { x: 0, y: 0 }, angles: [45] }, 5, vectorTrackingPaths([{ x: 50, y: 200 }]));
		expect([r.kind, ...round(r.point)]).toEqual(['tracking', 50, -50]);
	});
});

describe('tracking in the editor', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('acquires an anchor the pointer rests on, and releases it on a second rest', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 100, 100, 50)) });
		c.setTool('pen');
		c.pointerMove({ x: 150, y: 150 });
		vi.advanceTimersByTime(VectorEditorController.TRACKING_DWELL_MS + 10);
		expect(c.getState().trackingPoints).toEqual([{ x: 150, y: 150 }]);
		expect(getVectorOverlayRenderData(c.getState()).trackingPoints).toEqual([{ x: 150, y: 150 }]);
		// Staying put does not toggle it again; leaving and coming back does.
		vi.advanceTimersByTime(1000);
		expect(c.getState().trackingPoints).toHaveLength(1);
		c.pointerMove({ x: 400, y: 400 });
		c.pointerMove({ x: 150, y: 150 });
		vi.advanceTimersByTime(VectorEditorController.TRACKING_DWELL_MS + 10);
		expect(c.getState().trackingPoints).toEqual([]);
	});

	it('snaps the pen along an acquired point\'s path and clears on Escape or a tool change', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 100, 100, 50)) });
		c.setTool('pen');
		c.acquireTrackingPoint({ x: 150, y: 150 });
		// Straight right of the corner, a little off.
		c.pointerDown({ x: 400, y: 152 });
		c.pointerUp({ x: 400, y: 152 });
		const node = c.getState().document.nodes[1] as VectorPathNode;
		expect(node.subpaths[0].anchors[0]).toMatchObject({ x: 400, y: 150 });
		// Escape releases the acquired points first, then ends the path.
		expect(c.keyDown({ key: 'Escape' })).toBe(true);
		expect(c.getState().trackingPoints).toEqual([]);
		expect(c.getState().pen).not.toBeNull();
		c.keyDown({ key: 'Escape' });
		expect(c.getState().pen).toBeNull();
		c.acquireTrackingPoint({ x: 1, y: 1 });
		c.setTool('select');
		expect(c.getState().trackingPoints).toEqual([]);
	});

	it('keeps at most seven points, the oldest dropped, and gives an open end its extension', () => {
		const line: VectorPathNode = { id: 'l', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 30, y: 40 }] }] };
		const c = new VectorEditorController({ document: doc(line) });
		expect(c.acquireTrackingPoint({ x: 30, y: 40 })[0].extension).toEqual({ x: 30, y: 40 });
		for (let i = 0; i < 8; i++) c.acquireTrackingPoint({ x: 500 + i, y: 0 });
		expect(c.getState().trackingPoints).toHaveLength(VECTOR_MAX_TRACKING_POINTS);
		expect(c.getState().trackingPoints[0]).toEqual({ x: 501, y: 0 });
	});
});

describe('typed entry', () => {
	const drawing = () => {
		const c = new VectorEditorController({ document: doc() });
		c.setTool('pen');
		c.pointerDown({ x: 100, y: 100 });
		c.pointerUp({ x: 100, y: 100 });
		return c;
	};
	const last = (c: VectorEditorController) => {
		const sp = (c.getState().document.nodes[0] as VectorPathNode).subpaths[0];
		return round(sp.anchors[sp.anchors.length - 1]);
	};

	it('places the next point by distance toward the pointer, typed and entered', () => {
		const c = drawing();
		c.pointerMove({ x: 300, y: 100 });
		for (const key of ['5', '0']) expect(c.keyDown({ key })).toBe(true);
		expect(c.getState().typedEntry).toBe('50');
		expect(getVectorOverlayRenderData(c.getState()).typedEntry).toMatchObject({ text: '50' });
		c.keyDown({ key: 'Enter' });
		expect(last(c)).toEqual([150, 100]);
		expect(c.getState().typedEntry).toBeNull();
		c.undo();
		expect((c.getState().document.nodes[0] as VectorPathNode).subpaths[0].anchors).toHaveLength(1);
	});

	it('reads length<angle, offsets and positions, and refuses what it cannot read', () => {
		const c = drawing();
		expect(c.placePenPoint('100<90').ok).toBe(true);
		expect(last(c)).toEqual([100, 0]);
		expect(c.placePenPoint('@10,-5').ok).toBe(true);
		expect(last(c)).toEqual([110, -5]);
		expect(c.placePenPoint('20, 30').ok).toBe(true);
		expect(last(c)).toEqual([20, 30]);
		expect(c.placePenPoint('far').ok).toBe(false);
		expect(new VectorEditorController({ document: doc() }).placePenPoint('10')).toEqual({ ok: false, message: 'Start a path with the pen first: typed entry places its next point.' });
	});

	it('measures typed angles from the last segment with polarRelative', () => {
		const c = drawing();
		c.placePenPoint('100<0');
		c.setSnap({ polarRelative: true });
		c.placePenPoint('50<90');
		expect(last(c)).toEqual([200, 50]);
	});

	it('leaves keys alone outside the pen, and Backspace and Escape edit the entry', () => {
		const c = drawing();
		c.keyDown({ key: '1' });
		c.keyDown({ key: '2' });
		c.keyDown({ key: 'Backspace' });
		expect(c.getState().typedEntry).toBe('1');
		c.keyDown({ key: 'Escape' });
		expect(c.getState().typedEntry).toBeNull();
		const idle = new VectorEditorController({ document: doc() });
		expect(idle.keyDown({ key: '5' })).toBe(false);
	});
});

describe('tracking and dimension commands through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: doc() });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		return { c, run };
	};

	it('reads and sets snap options, polar increments included', async () => {
		const { run } = setup();
		expect((await run('vector.getSnapOptions')).result).toMatchObject({ angles: [0, 45, 90, 135], tracking: true, trackPolar: false, polarRelative: false });
		const set = await run('vector.setSnapOptions', { polarIncrement: 30, trackPolar: true });
		expect(set.result.angles).toHaveLength(12);
		expect(set.result.trackPolar).toBe(true);
		expect((await run('vector.setSnapOptions', {})).text).toContain('Pass at least one option.');
		expect((await run('vector.setSnapOptions', { additionalAngles: [10] })).text).toContain('additionalAngles go with polarIncrement.');
	});

	it('draws a path by dimensions as one undo step', async () => {
		const { c, run } = setup();
		const r = await run('vector.addPathByDimensions', { start: { x: 0, y: 0 }, steps: [{ length: 100, angle: 0 }, { dx: 0, dy: 50 }, { x: 0, y: 50 }], closed: true });
		expect(r.result.anchors.map(round)).toEqual([
			[0, 0],
			[100, 0],
			[100, 50],
			[0, 50]
		]);
		expect((c.getNode(r.result.id) as VectorPathNode).subpaths[0].closed).toBe(true);
		c.undo();
		expect(c.getState().document.nodes).toHaveLength(0);
		expect((await run('vector.addPathByDimensions', { start: { x: 0, y: 0 }, steps: [{ length: 1 }] })).isError).toBe(true);
	});
});

describe('polar increment of a set of angles', () => {
	it('reads the increment the angles are multiples of, as lines', async () => {
		const { vectorPolarIncrementOf } = await import('../src/vector');
		expect(vectorPolarIncrementOf([0, 45, 90, 135])).toBe(45);
		expect(vectorPolarIncrementOf(vectorPolarAngles(15))).toBe(15);
		expect(vectorPolarIncrementOf([0, 90])).toBe(90);
		expect(vectorPolarIncrementOf([0, 45, 90])).toBeNull();
		expect(vectorPolarIncrementOf([10, 100])).toBeNull();
	});
});
