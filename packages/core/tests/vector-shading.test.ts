// Gradient meshes and freeform gradients. Meshes after ArtCraft effectcraft
// `crates/pdf/src/shading.rs` (Coons patches tessellated into cells), freeform gradients after
// vectorcraft `crates/color/src/freeform.rs` (`Field::sample`, `Freeform::auto`, `remove_point`)
// (MIT OR Apache-2.0, © ArtCraft Team and contributors); test cases re-expressed. See
// THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	autoVectorFreeformGradient,
	createVectorCommands,
	createVectorMeshGradient,
	ellipseSubpath,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	isVectorShadedPaint,
	parseVectorSvg,
	rectSubpath,
	removeVectorFreeformPoint,
	sampleVectorFreeform,
	sanitizeVectorShadedPaint,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorFreeformField,
	vectorMeshColorAt,
	vectorMeshPointAt,
	vectorRgbaToCss,
	vectorShadedSvgDefs,
	type VectorDocument,
	type VectorFreeformGradient,
	type VectorMeshGradient,
	type VectorNode,
	type VectorPathNode,
	type VectorRenderPath
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: h })], fill: '#ff0000', stroke: null, ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
const close = (a: readonly number[], b: readonly number[], eps = 1e-3) => a.every((v, k) => Math.abs(v - b[k]) < eps);

describe('gradient meshes', () => {
	const box = { x: 0, y: 0, width: 100, height: 50 };

	it('spreads its points over the box and blends corner colours', () => {
		const m = createVectorMeshGradient(box, 1, 2, { corners: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'] });
		expect(m.points).toHaveLength(6);
		expect(m.points[2]).toEqual({ x: 100, y: 0 });
		expect(m.colors[0]).toBe('#ff0000');
		// Half way along the top: red and green mixed.
		expect(m.colors[1]).toBe('#808000');
	});

	it('is a flat lattice for even points and passes through its points', () => {
		const m = createVectorMeshGradient(box, 2, 2);
		const p = vectorMeshPointAt(m, 0, 0, 0.5, 0.5);
		expect(close([p.x, p.y], [25, 12.5])).toBe(true);
		const corner = vectorMeshPointAt(m, 1, 1, 1, 1);
		expect(close([corner.x, corner.y], [100, 50])).toBe(true);
	});

	it('bends patches smoothly with a moved point', () => {
		const m = createVectorMeshGradient(box, 2, 2);
		const moved: VectorMeshGradient = { ...m, points: m.points.map((q, k) => (k === 4 ? { x: 60, y: 30 } : q)) };
		// The middle point moved: both patches meeting there move toward it, continuously.
		const a = vectorMeshPointAt(moved, 0, 0, 1, 1);
		const b = vectorMeshPointAt(moved, 1, 1, 0, 0);
		expect(close([a.x, a.y], [60, 30])).toBe(true);
		expect(close([b.x, b.y], [60, 30])).toBe(true);
		const mid = vectorMeshPointAt(moved, 0, 0, 0.5, 0.5);
		expect(mid.x).toBeGreaterThan(25);
	});

	it('mixes colours bilinearly inside a patch, opacity included', () => {
		const m: VectorMeshGradient = { ...createVectorMeshGradient(box, 1, 1, { colors: ['#000000', '#ffffff', '#ffffff', '#000000'] }), opacities: [1, 1, 0, 0] };
		const c = vectorMeshColorAt(m, 0, 0, 0.5, 0.5);
		expect(close(c, [0.5, 0.5, 0.5, 0.5])).toBe(true);
	});

	it('draws as a pattern of overlapping flat tiles', () => {
		const m = createVectorMeshGradient(box, 1, 1, { corners: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'] });
		const [def] = vectorShadedSvgDefs(m, 'p', { bounds: box, meshCells: 4 });
		expect(def.type).toBe('pattern');
		expect(def.tiles).toHaveLength(16);
		expect(new Set(def.tiles.map((t) => t.fill)).size).toBeGreaterThan(8);
	});
});

describe('freeform gradients', () => {
	const two = (spread = 0): VectorFreeformGradient => ({
		type: 'freeform',
		points: [
			{ x: 0, y: 0, color: '#ff0000', spread },
			{ x: 100, y: 0, color: '#0000ff', opacity: 0.5 }
		]
	});

	it('is each point\'s colour at the point and an even mix half way', () => {
		const field = vectorFreeformField(two(), 50);
		expect(close(sampleVectorFreeform(field, { x: 0, y: 0 }), [1, 0, 0, 1])).toBe(true);
		expect(close(sampleVectorFreeform(field, { x: 100, y: 0 }), [0, 0, 1, 0.5])).toBe(true);
		expect(close(sampleVectorFreeform(field, { x: 50, y: 0 }), [0.5, 0, 0.5, 0.75])).toBe(true);
	});

	it('keeps a spread point\'s colour pure inside its disc, falling off beyond', () => {
		const field = vectorFreeformField(two(0.2), 100);
		const red = (x: number) => sampleVectorFreeform(field, { x, y: 0 })[0];
		expect(red(15)).toBeCloseTo(1, 6);
		expect(red(30)).toBeLessThan(1);
		expect(red(30)).toBeGreaterThan(red(50));
		expect(red(30)).toBeGreaterThan(sampleVectorFreeform(vectorFreeformField(two(), 100), { x: 30, y: 0 })[0]);
	});

	it('carries colour along a line', () => {
		const f: VectorFreeformGradient = { ...two(), points: [...two().points, { x: 50, y: 100, color: '#00ff00' }] };
		const off = sampleVectorFreeform(vectorFreeformField(f, 100), { x: 50, y: 5 });
		const on = sampleVectorFreeform(vectorFreeformField({ ...f, lines: [[0, 1]] }, 100), { x: 50, y: 5 });
		expect(on[1]).toBeLessThan(off[1]);
	});

	it('places four or more points inside the shape, coloured first to last', () => {
		const tri = (p: { x: number; y: number }) => p.y >= 0 && p.y <= 100 && Math.abs(p.x - 100) <= p.y;
		const f = autoVectorFreeformGradient({ x: 0, y: 0, width: 200, height: 100 }, ['#ffffff', '#000000'], tri);
		expect(f.points.length).toBeGreaterThanOrEqual(4);
		expect(f.points.every(tri)).toBe(true);
		expect([f.points[0].color, f.points[f.points.length - 1].color]).toEqual(['#ffffff', '#000000']);
		expect(autoVectorFreeformGradient({ x: 0, y: 0, width: 400, height: 100 }, ['#fff']).points.length).toBeGreaterThan(4);
	});

	it('closes lines up round a removed point and keeps the last point', () => {
		const f: VectorFreeformGradient = { type: 'freeform', points: [0, 1, 2, 3].map((x) => ({ x, y: 0, color: '#000' })), lines: [[0, 1, 2], [1, 3]] };
		expect(removeVectorFreeformPoint(f, 1)).toEqual({ type: 'freeform', points: [0, 2, 3].map((x) => ({ x, y: 0, color: '#000' })), lines: [[0, 1]] });
		expect(removeVectorFreeformPoint({ type: 'freeform', points: [{ x: 0, y: 0, color: '#000' }] }, 0)).toBeNull();
	});
});

describe('shaded paints on nodes', () => {
	it('sanitizes untrusted meshes and freeform gradients', () => {
		const mesh = createVectorMeshGradient({ x: 0, y: 0, width: 10, height: 10 }, 1, 1);
		expect(sanitizeVectorShadedPaint(mesh)).toEqual(mesh);
		expect(sanitizeVectorShadedPaint({ ...mesh, colors: ['#fff'] })).toBeNull();
		expect(sanitizeVectorShadedPaint({ ...mesh, rows: 40 })).toBeNull();
		expect(sanitizeVectorShadedPaint({ type: 'freeform', points: [{ x: 0, y: 0, color: 'nope' }] })).toBeNull();
		expect(sanitizeVectorShadedPaint({ type: 'freeform', points: [{ x: 0, y: 0, color: '#000', spread: 3 }, { x: 1, y: 1, color: '#fff' }], lines: [[0, 1], [0, 0], [0, 9]] })).toEqual({
			type: 'freeform',
			points: [{ x: 0, y: 0, color: '#000', spread: 1 }, { x: 1, y: 1, color: '#fff' }],
			lines: [[0, 1]]
		});
	});

	it('moves with its path when the path is transformed', () => {
		const node = rect('a', 0, 0, 100, 50, { fill: createVectorMeshGradient({ x: 0, y: 0, width: 100, height: 50 }, 1, 1) });
		const moved = transformVectorNode(node, [2, 0, 0, 1, 10, 0]);
		expect((moved.fill as VectorMeshGradient).points[3]).toEqual({ x: 210, y: 50 });
	});

	it('renders as a pattern and round-trips through SVG', () => {
		const f: VectorFreeformGradient = { type: 'freeform', points: [{ x: 10, y: 10, color: '#ff0000' }, { x: 90, y: 40, color: '#0000ff', spread: 0.2 }], lines: [[0, 1]] };
		const d = doc(rect('a', 0, 0, 100, 50, { fill: f }));
		const scene = getVectorSceneRenderData({ document: d, viewport: { x: 0, y: 0, zoom: 1 } });
		expect((scene.nodes[0] as VectorRenderPath).fill).toMatch(/^url\(#/);
		// Strips with a gradient each (smooth across, thin enough not to show steps down).
		expect(scene.defs.some((x) => x.type === 'pattern' && x.tiles.length > 40 && x.gradients.length === x.tiles.length && x.gradients[0].stops.length > 40)).toBe(true);
		const back = parseVectorSvg(vectorDocumentToSvg(d)).nodes[0] as VectorPathNode;
		expect(back.fill).toEqual(f);
	});

	it('turns a colour into a CSS string, rgba when not opaque', () => {
		expect(vectorRgbaToCss([1, 0.5, 0, 1])).toBe('#ff8000');
		expect(vectorRgbaToCss([1, 0, 0, 0.25])).toBe('rgba(255,0,0,0.25)');
	});
});

describe('meshes and freeform gradients in the editor', () => {
	it('gives a path a mesh and edits a point in document units, one undo step each', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50, { transform: [1, 0, 0, 1, 50, 50] })) });
		expect(c.setMeshGradient({ rows: 1, columns: 1, corners: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'] }, { ids: ['a'] }).ok).toBe(true);
		const mesh = c.getShading('a') as VectorMeshGradient;
		expect(mesh.points[0]).toEqual({ x: 50, y: 50 });
		expect(c.setMeshPoint('a', 3, { x: 160, y: 110, color: '#000000' }).ok).toBe(true);
		expect((c.getShading('a') as VectorMeshGradient).points[3]).toEqual({ x: 160, y: 110 });
		expect((c.getNode('a') as VectorPathNode).fill).toMatchObject({ type: 'mesh' });
		c.undo();
		expect((c.getShading('a') as VectorMeshGradient).points[3]).toEqual({ x: 150, y: 100 });
		expect(c.setMeshPoint('a', 9, { color: '#000' })).toEqual({ ok: false, message: 'Point 9 is out of range: the mesh has 4 points (0 to 3).' });
		expect(c.setMeshGradient({ rows: 0, columns: 1 }, { ids: ['a'] }).ok).toBe(false);
		expect(c.setMeshGradient({ rows: 1, columns: 1, colors: ['#fff'] }, { ids: ['a'] }).ok).toBe(false);
	});

	it('places, adds, edits and removes freeform points', () => {
		const circle: VectorPathNode = { id: 'c', type: 'path', fill: '#336699', stroke: null, subpaths: [ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 })] };
		const c = new VectorEditorController({ document: doc(circle) });
		expect(c.setFreeformGradient({}, { ids: ['c'] }).ok).toBe(true);
		const f = c.getShading('c') as VectorFreeformGradient;
		expect(f.points.length).toBeGreaterThanOrEqual(4);
		expect(f.points[0].color).toBe('#336699');
		const added = c.addFreeformPoint('c', { x: 50, y: 50 });
		expect(added.index).toBe(f.points.length);
		expect(c.setFreeformPoint('c', added.index!, { color: '#ffcc00', spread: 0.3 }).ok).toBe(true);
		expect((c.getShading('c') as VectorFreeformGradient).points[added.index!]).toMatchObject({ x: 50, y: 50, color: '#ffcc00', spread: 0.3 });
		expect(c.setFreeformLines('c', [[0, 1, 2]]).ok).toBe(true);
		expect(c.removeFreeformPoint('c', 1).ok).toBe(true);
		expect((c.getShading('c') as VectorFreeformGradient).lines).toEqual([[0, 1]]);
		expect(c.setFreeformLines('c', [[0, 99]]).ok).toBe(false);
		expect(c.addFreeformPoint('c', { x: 1, y: 1, color: 'blurple' }).ok).toBe(false);
	});

	it('drags mesh points, adds freeform points by clicking and removes them with Alt in the Gradient tool', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 100, { fill: { type: 'freeform', points: [{ x: 20, y: 20, color: '#ff0000' }, { x: 80, y: 80, color: '#0000ff' }] } })) });
		c.select(['a']);
		c.setTool('gradient');
		expect(getVectorOverlayRenderData(c.getState()).shading[0].points).toHaveLength(2);
		// Drag point 0.
		c.pointerDown({ x: 20, y: 20 });
		c.pointerMove({ x: 30, y: 40 });
		c.pointerUp({ x: 30, y: 40 });
		expect((c.getShading('a') as VectorFreeformGradient).points[0]).toMatchObject({ x: 30, y: 40 });
		expect(c.getState().shadingPoint).toEqual({ nodeId: 'a', index: 0, kind: 'freeform' });
		// Click empty space inside: a point in the colour shown there.
		c.pointerDown({ x: 60, y: 20 });
		c.pointerUp({ x: 60, y: 20 });
		const f = c.getShading('a') as VectorFreeformGradient;
		expect(f.points).toHaveLength(3);
		expect(c.getState().shadingPoint?.index).toBe(2);
		// Alt-click removes it.
		c.pointerDown({ x: 60, y: 20 }, { alt: true });
		c.pointerUp({ x: 60, y: 20 }, { alt: true });
		expect((c.getShading('a') as VectorFreeformGradient).points).toHaveLength(2);
		c.undo();
		expect((c.getShading('a') as VectorFreeformGradient).points).toHaveLength(3);
		expect(isVectorShadedPaint((c.getNode('a') as VectorPathNode).fill)).toBe(true);
	});
});

describe('mesh and freeform commands through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50), { id: 'g', type: 'group', children: [] }) });
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

	it('creates and edits a mesh, returning the shading', async () => {
		const { run } = setup();
		const made = await run('vector.setMeshGradient', { ids: ['a'], rows: 2, columns: 2, corners: ['#ff0000', '#ffff00', '#0000ff', '#00ff00'] });
		expect(made.result.meshes[0].shading).toMatchObject({ type: 'mesh', rows: 2, columns: 2 });
		const edited = await run('vector.setMeshPoint', { id: 'a', index: 4, x: 60, y: 30, color: '#ffffff' });
		expect(edited.result.shading.points[4]).toEqual({ x: 60, y: 30 });
		expect(edited.result.shading.colors[4]).toBe('#ffffff');
		expect((await run('vector.getShading', { id: 'a' })).result.shading.type).toBe('mesh');
	});

	it('creates and edits a freeform gradient', async () => {
		const { run } = setup();
		const made = await run('vector.setFreeformGradient', { ids: ['a'], points: [{ x: 10, y: 10, color: '#f00' }, { x: 90, y: 40, color: '#00f' }] });
		expect(made.result.gradients[0].shading.points).toHaveLength(2);
		const added = await run('vector.addFreeformPoint', { id: 'a', x: 50, y: 25, color: '#0f0', spread: 0.2 });
		expect(added.result.index).toBe(2);
		expect((await run('vector.setFreeformPoint', { id: 'a', index: 2, opacity: 0.5 })).result.shading.points[2].opacity).toBe(0.5);
		expect((await run('vector.setFreeformLines', { id: 'a', lines: [[0, 2, 1]] })).result.shading.lines).toEqual([[0, 2, 1]]);
		expect((await run('vector.removeFreeformPoint', { id: 'a', index: 2 })).result.shading.lines).toEqual([[0, 1]]);
	});

	it('fails usefully on bad input', async () => {
		const { run } = setup();
		expect((await run('vector.setMeshGradient', { ids: ['g'], rows: 1, columns: 1 })).text).toContain('meshes and freeform gradients fill paths');
		expect((await run('vector.setMeshPoint', { id: 'a', index: 0, color: '#000' })).text).toContain('has no gradient mesh fill');
		expect((await run('vector.getShading', { id: 'a' })).text).toContain('has no mesh or freeform fill');
		expect((await run('vector.setFreeformPoint', { id: 'a', index: 0 })).text).toContain('Pass at least one of');
		expect((await run('vector.setMeshGradient', { ids: ['a'], rows: 1, columns: 1, corners: ['#000'] })).isError).toBe(true);
	});
});
