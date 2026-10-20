// Connectors glued to objects. Sites, gluing and rerouting follow ArtCraft wordcraft
// `crates/doc/src/connector.rs` and deckcraft `crates/engine/src/connect.rs` (MIT OR Apache-2.0,
// © ArtCraft Team and contributors); test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	createVectorCommands,
	getVectorConnectorPanel,
	getVectorOverlayRenderData,
	isVectorConnector,
	parseVectorSvg,
	rectSubpath,
	rerouteVectorConnectors,
	routeVectorConnector,
	sanitizeVectorConnector,
	vectorConnectionSites,
	vectorConnectorTargetAt,
	vectorDocumentToSvg,
	type VectorConnector,
	type VectorDocument,
	type VectorNode,
	type VectorPathNode
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: w, height: h })],
	fill: '#ff0000',
	stroke: null,
	...extra
});
const line = (id: string, connector: VectorConnector, from = { x: 0, y: 0 }, to = { x: 0, y: 0 }): VectorPathNode => ({
	id,
	type: 'path',
	fill: null,
	stroke: '#000',
	connector,
	subpaths: [{ closed: false, anchors: [from, to] }]
});
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 800, height: 600, nodes });
const pts = (n: VectorNode | undefined) => (n as VectorPathNode).subpaths[0].anchors.map((a) => [Math.round(a.x * 1000) / 1000, Math.round(a.y * 1000) / 1000]);

describe('connection sites', () => {
	it('puts sites at the middles of the sides and the centre, through rotation', () => {
		const d = doc(rect('a', 0, 0, 100, 50));
		expect(vectorConnectionSites(d.nodes, 'a').map((s) => [s.side, s.x, s.y, s.nx, s.ny])).toEqual([
			['top', 50, 0, 0, -1],
			['right', 100, 25, 1, 0],
			['bottom', 50, 50, 0, 1],
			['left', 0, 25, -1, 0],
			['center', 50, 25, 0, 0]
		]);
		// Turned a quarter clockwise about the origin: the top faces right.
		const turned = doc(rect('a', 0, 0, 100, 50, { transform: [0, 1, -1, 0, 0, 0] }));
		const top = vectorConnectionSites(turned.nodes, 'a')[0];
		expect([Math.round(top.x), Math.round(top.y), Math.round(top.nx), Math.round(top.ny)]).toEqual([0, 50, 1, 0]);
	});

	it('has none for connectors, hidden objects and unknown ids', () => {
		const d = doc(rect('h', 0, 0, 10, 10, { visible: false }), line('c', {}));
		expect(vectorConnectionSites(d.nodes, 'h')).toEqual([]);
		expect(vectorConnectionSites(d.nodes, 'c')).toEqual([]);
		expect(vectorConnectionSites(d.nodes, 'nope')).toEqual([]);
	});

	it('finds what an end dragged to a point glues to', () => {
		const d = doc(rect('a', 0, 0, 100, 50), line('c', {}));
		expect(vectorConnectorTargetAt(d.nodes, { x: 103, y: 26 }, 5)).toMatchObject({ nodeId: 'a', side: 'right' });
		expect(vectorConnectorTargetAt(d.nodes, { x: 30, y: 30 }, 5)).toMatchObject({ nodeId: 'a', side: 'auto', site: null });
		expect(vectorConnectorTargetAt(d.nodes, { x: 300, y: 300 }, 5)).toBeNull();
		expect(vectorConnectorTargetAt(d.nodes, { x: 103, y: 26 }, 5, 'a')).toBeNull();
	});
});

describe('routing', () => {
	const two = (c: VectorConnector) => doc(rect('a', 0, 0, 100, 50), rect('b', 300, 200, 100, 50), line('c', c));

	it('glues straight ends to the sides facing each other', () => {
		const d = two({ start: { nodeId: 'a' }, end: { nodeId: 'b' } });
		const r = routeVectorConnector(d.nodes, 'c')!;
		expect([r.startSide, r.endSide]).toEqual(['right', 'left']);
		expect(pts({ ...line('x', {}), subpaths: r.subpaths })).toEqual([
			[100, 25],
			[300, 225]
		]);
	});

	it('routes elbows out of their sides with a gap, turning at right angles', () => {
		const d = two({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b', side: 'left' }, route: 'elbow', gap: 10 });
		expect(pts(rerouteVectorConnectors(d).nodes[2])).toEqual([
			[100, 25],
			[200, 25],
			[200, 225],
			[300, 225]
		]);
		// Out of the bottom, into the top: one vertical run with a jog through the middle.
		const v = two({ start: { nodeId: 'a', side: 'bottom' }, end: { nodeId: 'b', side: 'top' }, route: 'elbow', gap: 10 });
		expect(pts(rerouteVectorConnectors(v).nodes[2])).toEqual([
			[50, 50],
			[50, 125],
			[350, 125],
			[350, 200]
		]);
		// A side and an upright side: one bend.
		const l = two({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b', side: 'top' }, route: 'elbow', gap: 0 });
		expect(pts(rerouteVectorConnectors(l).nodes[2])).toEqual([
			[100, 25],
			[350, 25],
			[350, 200]
		]);
	});

	it('rounds elbow bends with a radius and curves along the sides', () => {
		const d = two({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b', side: 'left' }, route: 'elbow', radius: 8 });
		const anchors = (rerouteVectorConnectors(d).nodes[2] as VectorPathNode).subpaths[0].anchors;
		expect(anchors.map((a) => a.corner?.radius ?? 0)).toEqual([0, 8, 8, 0]);
		const c = two({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b', side: 'left' }, route: 'curved' });
		const [s, e] = (rerouteVectorConnectors(c).nodes[2] as VectorPathNode).subpaths[0].anchors;
		expect(s.out!.y).toBe(25);
		expect(s.out!.x).toBeGreaterThan(100);
		expect(e.in!.y).toBe(225);
		expect(e.in!.x).toBeLessThan(300);
	});

	it('keeps a free end where it is and drops glue to objects that are gone', () => {
		const d = doc(rect('a', 0, 0, 100, 50), line('c', { start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'gone' } }, { x: 0, y: 0 }, { x: 500, y: 400 }));
		const out = rerouteVectorConnectors(d);
		const c = out.nodes[1] as VectorPathNode;
		expect(c.connector).toEqual({ start: { nodeId: 'a', side: 'right' } });
		expect(pts(c)).toEqual([
			[100, 25],
			[500, 400]
		]);
		// Settled: the same document comes back.
		expect(rerouteVectorConnectors(out)).toBe(out);
	});

	it('routes a connector inside a moved group in that group\'s space', () => {
		const d = doc(rect('a', 0, 0, 100, 50), { id: 'g', type: 'group', transform: [1, 0, 0, 1, 1000, 0], children: [line('c', { start: { nodeId: 'a', side: 'right' } }, { x: 0, y: 0 }, { x: -800, y: 0 })] });
		const c = (rerouteVectorConnectors(d).nodes[1] as { children: VectorNode[] }).children[0];
		expect(pts(c)[0]).toEqual([-900, 25]);
	});

	it('sanitizes connector settings from untrusted data', () => {
		expect(sanitizeVectorConnector({ start: { nodeId: 'a', side: 'top' }, end: { nodeId: 7 }, route: 'elbow', radius: -1, gap: 4 })).toEqual({ start: { nodeId: 'a', side: 'top' }, route: 'elbow', gap: 4 });
		expect(sanitizeVectorConnector({ route: 'zigzag', start: { nodeId: 'a', side: 'auto' } })).toEqual({ start: { nodeId: 'a' } });
		expect(sanitizeVectorConnector(null)).toBeNull();
	});

	it('round-trips through SVG', () => {
		const d = rerouteVectorConnectors(two({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b' }, route: 'elbow', radius: 4 }));
		const back = parseVectorSvg(vectorDocumentToSvg(d));
		const c = back.nodes.find((n) => n.id === 'c')!;
		expect(isVectorConnector(c)).toBe(true);
		expect((c as VectorPathNode).connector).toEqual({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b' }, route: 'elbow', radius: 4 });
	});
});

describe('connectors in the editor', () => {
	it('follows a glued object when it moves, in the same undo step', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50), rect('b', 300, 0, 100, 50)) });
		const r = c.addConnector({ start: { nodeId: 'a' }, end: { nodeId: 'b' } });
		expect(r.ok).toBe(true);
		const id = (r as { id: string }).id;
		expect(pts(c.getNode(id))).toEqual([
			[100, 25],
			[300, 25]
		]);
		expect(c.getNode(id)).toMatchObject({ endArrow: 'triangle', fill: null });
		c.select(['b']);
		c.translate(0, 100);
		expect(pts(c.getNode(id))).toEqual([
			[100, 25],
			[300, 125]
		]);
		c.undo();
		expect(pts(c.getNode(id))).toEqual([
			[100, 25],
			[300, 25]
		]);
	});

	it('refuses bad ends without changing anything', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50), line('l', {})) });
		const before = c.getState().document;
		expect(c.addConnector({ start: { nodeId: 'nope' }, end: { x: 0, y: 0 } })).toEqual({ ok: false, message: 'There is no node "nope".' });
		expect(c.addConnector({ start: { nodeId: 'l' }, end: { x: 0, y: 0 } }).ok).toBe(false);
		expect(c.addConnector({ start: { nodeId: 'a' }, end: { nodeId: 'a' } })).toEqual({ ok: false, message: 'Both ends are glued to the same object; connect two different objects.' });
		expect(c.addConnector({ start: { nodeId: 'a', side: 'up' as never }, end: { x: 0, y: 0 } }).ok).toBe(false);
		expect(c.getState().document).toBe(before);
	});

	it('changes, reglues and unglues connectors, and turns open paths into connectors', () => {
		const c = new VectorEditorController({
			document: doc(rect('a', 0, 0, 100, 50), rect('b', 300, 0, 100, 50), { id: 'p', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 0, y: 300 }, { x: 50, y: 300 }] }] })
		});
		expect(c.setConnector({ start: { nodeId: 'a', side: 'bottom' }, route: 'elbow' }, { ids: ['p'] }).ok).toBe(true);
		expect(pts(c.getNode('p'))[0]).toEqual([50, 50]);
		expect(c.setConnector({ start: null }, { ids: ['p'] }).ok).toBe(true);
		expect((c.getNode('p') as VectorPathNode).connector).toEqual({ start: null, route: 'elbow' });
		expect(c.setConnector({ route: 'straight' }, { ids: ['a'] }).ok).toBe(false);
		expect(c.setConnector({ end: { nodeId: 'p' } }, { ids: ['p'] })).toEqual({ ok: false, message: 'A connector cannot be glued to itself.' });
	});

	it('draws a connector between two objects with the Connector tool', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50), rect('b', 300, 0, 100, 50)) });
		c.setTool('connector');
		c.pointerDown({ x: 101, y: 25 });
		c.pointerMove({ x: 250, y: 30 });
		c.pointerMove({ x: 320, y: 30 });
		c.pointerUp({ x: 320, y: 30 });
		const node = c.getState().document.nodes[2] as VectorPathNode;
		expect(node.connector).toEqual({ start: { nodeId: 'a', side: 'right' }, end: { nodeId: 'b' }, route: 'straight' });
		expect(pts(node)).toEqual([
			[100, 25],
			[300, 25]
		]);
		expect(c.getState().selection).toEqual([node.id]);
		c.undo();
		expect(c.getState().document.nodes).toHaveLength(2);
	});

	it('shows the sites under the pointer while the Connector tool is on', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50)) });
		c.setTool('connector');
		c.pointerMove({ x: 99, y: 26 });
		const sites = getVectorOverlayRenderData(c.getState()).connectorSites;
		expect(sites.map((s) => s.side)).toEqual(['top', 'right', 'bottom', 'left', 'center']);
		expect(sites.find((s) => s.active)?.side).toBe('right');
		c.setTool('select');
		expect(getVectorOverlayRenderData(c.getState()).connectorSites).toEqual([]);
	});

	it('describes the selected connector for the panel and lists connectors', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50), rect('b', 300, 0, 100, 50)) });
		const id = (c.addConnector({ start: { nodeId: 'a' }, end: { x: 500, y: 25 }, route: 'elbow', radius: 6 }) as { id: string }).id;
		expect(getVectorConnectorPanel(c.getState())).toEqual({ id, route: 'elbow', radius: 6, gap: 16, start: { nodeId: 'a' }, end: null });
		expect(c.getConnectors()).toEqual([{ id, name: 'Connector', route: 'elbow', radius: 6, start: { nodeId: 'a', side: 'auto', resolvedSide: 'right', x: 100, y: 25 }, end: { x: 500, y: 25 } }]);
	});
});

describe('connector commands through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, 50), rect('b', 300, 200, 100, 50)) });
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

	it('connects, lists, changes and reads sites, returning what changed', async () => {
		const { c, run } = setup();
		const made = await run('vector.connect', { start: { nodeId: 'a' }, end: { nodeId: 'b', side: 'top' }, route: 'elbow' });
		expect(made.isError).toBe(false);
		expect(made.result).toMatchObject({ route: 'elbow', start: { nodeId: 'a', resolvedSide: 'right' }, end: { nodeId: 'b', side: 'top', resolvedSide: 'top', x: 350, y: 200 } });
		const id = made.result.id;
		expect((await run('vector.listConnectors')).result.connectors).toHaveLength(1);
		expect((await run('vector.list')).result.nodes.find((n: any) => n.id === id).connector).toMatchObject({ route: 'elbow' });
		const changed = await run('vector.setConnector', { ids: [id], end: null, route: 'curved' });
		expect(changed.result.connectors[0]).toMatchObject({ route: 'curved', end: { x: 350, y: 200 } });
		expect(changed.result.connectors[0].end.nodeId).toBeUndefined();
		const sites = await run('vector.listConnectionSites', { id: 'b' });
		expect(sites.result.sites[0]).toEqual({ side: 'top', x: 350, y: 200, nx: 0, ny: -1 });
		c.undo();
		expect(c.getConnectors()[0].end.nodeId).toBe('b');
	});

	it('fails usefully on bad input', async () => {
		const { run } = setup();
		expect((await run('vector.connect', { start: { nodeId: 'nope' }, end: { x: 1, y: 2 } })).text).toContain('There is no node "nope".');
		expect((await run('vector.connect', { start: { nodeId: 'a' } })).isError).toBe(true);
		expect((await run('vector.setConnector', { ids: ['a'] })).text).toContain('Pass at least one of start, end, route, radius, gap.');
		expect((await run('vector.setConnector', { ids: ['a'], route: 'elbow' })).text).toContain('is not a connector or an open path');
		expect((await run('vector.listConnectionSites', { id: 'nope' })).text).toContain('There is no node "nope".');
	});
});
