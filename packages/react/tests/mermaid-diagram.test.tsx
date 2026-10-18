import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry } from '@pixerate/editor/tools';
import { DiagramController, createDiagramToolProvider, createInstantPresenceClock } from '@pixerate/editor/diagram';
import { DiagramPresenceLayer, MermaidDiagramNode, MermaidDiagramGroup, MermaidFamilyScene, MermaidThumbnail, useDiagramDirector, useMermaidDiagram, useMermaidStream, type UseMermaidDiagramResult, type UseMermaidStreamResult } from '../src/canvas';
import { useAgentToolProvider } from '../src';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const SOURCE = 'flowchart LR\n  %% kept\n  A[Start] --> B{Ok?}\n  subgraph S [Box]\n    C\n  end\n  B --> C\n';

describe('useMermaidDiagram', () => {
	it('lays out the diagram as canvas nodes and writes edits back as Mermaid', async () => {
		let diagram!: UseMermaidDiagramResult;
		function Probe() {
			diagram = useMermaidDiagram({ source: SOURCE });
			return null;
		}
		await act(async () => root.render(<Probe />));
		expect(diagram.nodes.map((n) => [n.id, n.type])).toEqual([
			['S', 'mermaid-group'],
			['A', 'mermaid-node'],
			['B', 'mermaid-node'],
			['C', 'mermaid-node']
		]);
		expect(diagram.edges).toHaveLength(2);

		await act(async () => void diagram.connect('C', 'A', 'loop'));
		expect(diagram.source).toContain('C -->|loop| A');
		expect(diagram.source).toContain('%% kept');
		expect(diagram.edges).toHaveLength(3);

		const a = diagram.nodes.find((n) => n.id === 'A')!;
		await act(async () => void diagram.moveNodes([{ ...a, position: { x: a.position.x + 40, y: a.position.y } }], diagram.nodes));
		expect(diagram.document.meta.layout?.A?.[0]).toBeCloseTo(diagram.layout.positions.A![0]);
		expect(diagram.source).toMatch(/%% @pixerate \{"v":1,"layout":\{"A":/);

		await act(async () => void diagram.remove([diagram.edges[2]!.id, 'B']));
		expect(diagram.nodes.map((n) => n.id)).not.toContain('B');
		expect(diagram.edges).toHaveLength(0);
		await act(async () => diagram.undo());
		expect(diagram.edges).toHaveLength(3);
		await act(async () => void diagram.rename('S', 'Depot'));
		expect(diagram.source).toContain('subgraph S [Depot]');
	});

	it('registers the diagram agent tools while mounted (parity with Svelte)', async () => {
		const registry = new ToolRegistry();
		const controller = new DiagramController({ source: SOURCE });
		const provider = createDiagramToolProvider(controller);
		let diagram!: UseMermaidDiagramResult;
		function Probe() {
			diagram = useMermaidDiagram(controller);
			useAgentToolProvider(registry, provider);
			return null;
		}
		await act(async () => root.render(<Probe />));
		expect(registry.listTools().tools.map((t) => t.name)).toContain('add_diagram_node');
		await act(async () => void (await registry.callTool('add_diagram_node', { label: 'New', from: 'C' })));
		expect(diagram.nodes.map((n) => n.id)).toContain('N1');
		await act(async () => root.render(<div />));
		expect(registry.listTools().tools).toHaveLength(0);
	});
});

describe('useMermaidStream', () => {
	it('holds back unconnected nodes until the source completes', async () => {
		let stream!: UseMermaidStreamResult;
		function Probe({ source, complete }: { source: string; complete: boolean }) {
			stream = useMermaidStream(source, { complete, duration: 0 });
			return null;
		}
		await act(async () => root.render(<Probe source={'```mermaid\nflowchart TD\n  a --> b\n  c'} complete={false} />));
		expect(stream.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		expect(stream.settled).toBe(true);
		await act(async () => root.render(<Probe source={'```mermaid\nflowchart TD\n  a --> b\n  c\n```'} complete />));
		expect(stream.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});
});

describe('MermaidDiagramNode', () => {
	it('draws the shape and label, painted from Mermaid styles', async () => {
		const data = { node: { id: 'A', label: 'Two<br/>lines', shape: 'diam' }, resolvedStyles: { fill: '#fde68a' } };
		await act(async () =>
			root.render(
				<>
					<MermaidDiagramNode data={data} width={120} height={80} selected>
						<span className="handle" />
					</MermaidDiagramNode>
					<MermaidDiagramGroup data={{ group: { id: 'S', label: 'Box' } }} />
				</>
			)
		);
		const node = container.querySelector('.pixerate-diagram-node') as HTMLElement;
		expect(node.dataset.shape).toBe('diam');
		expect(node.querySelectorAll('path')).toHaveLength(1);
		expect(node.textContent).toContain('Two');
		expect(node.textContent).toContain('lines');
		expect(node.style.getPropertyValue('--pixerate-diagram-node-bg')).toBe('#fde68a');
		expect(node.querySelector('.handle')).not.toBeNull();
		expect(container.querySelector('.pixerate-diagram-group')!.textContent).toBe('Box');
	});
});

describe('MermaidThumbnail', () => {
	it('draws a fitted static preview, or the fallback for text-only families', async () => {
		await act(async () =>
			root.render(
				<>
					<MermaidThumbnail source={SOURCE} maxWidth={120} className="t1" />
					<MermaidThumbnail source={'sankey-beta\n  a,b,1'} fallback={<em>no preview</em>} />
				</>
			)
		);
		const svg = container.querySelector('.t1 svg')!;
		expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(120);
		expect(svg.querySelectorAll('[data-node]')).toHaveLength(3);
		expect(container.querySelector('em')!.textContent).toBe('no preview');
	});
});

describe('useDiagramDirector', () => {
	it('acts out agent tool calls with a cursor drawn by DiagramPresenceLayer', async () => {
		const registry = new ToolRegistry();
		const controller = new DiagramController({ source: SOURCE });
		const clock = createInstantPresenceClock();
		let diagram!: UseMermaidDiagramResult;
		let director!: ReturnType<typeof useDiagramDirector>;
		function Probe() {
			diagram = useMermaidDiagram(controller);
			director = useDiagramDirector(controller, { placement: () => diagram.layout, clock, linger: 0 });
			const provider = React.useMemo(() => createDiagramToolProvider(controller, { director: director.director }), []);
			useAgentToolProvider(registry, provider);
			return <DiagramPresenceLayer presence={director.presence} viewport={{ x: 10, y: 20, zoom: 2 }} />;
		}
		await act(async () => root.render(<Probe />));
		let shown = 0;
		director.presence.subscribe((s) => {
			if (s.actors.length) shown++;
		});
		await act(async () => void (await registry.callTool('connect_diagram_nodes', { source: 'C', target: 'A', label: 'loop' })));
		expect(shown).toBeGreaterThan(5);
		expect(diagram.source).toContain('C -->|loop| A');
		expect(clock.elapsed()).toBeGreaterThan(500);
		director.presence.set({ id: 'agent', x: 5, y: 5, message: 'Hi' });
		await act(async () => {});
		const cursor = container.querySelector('[data-actor="agent"]') as HTMLElement;
		expect(cursor.style.transform).toBe('translate(20px, 30px)');
		expect(cursor.textContent).toBe('Hi');
	});
});

const PIE = 'pie showData\n  title Share\n  "A" : 40\n  "B" : 60\n';

describe('MermaidFamilyScene', () => {
	it('draws a family as its own picture, selects marks and renames on double-click', async () => {
		let diagram!: UseMermaidDiagramResult;
		const opened: string[] = [];
		function Probe() {
			diagram = useMermaidDiagram({ source: PIE });
			return diagram.scene ? (
				<MermaidFamilyScene
					scene={diagram.scene}
					onSelect={(target) => diagram.select(target ? [target] : [])}
					onOpen={(target) => {
						opened.push(target);
						diagram.renameTarget(target, target === '::title' ? 'Market' : 'Alpha');
					}}
				/>
			) : null;
		}
		await act(async () => root.render(<Probe />));
		const svg = container.querySelector('svg.pixerate-diagram-scene')!;
		expect(svg.getAttribute('data-family')).toBe('pie');
		const wedges = svg.querySelectorAll('[data-role="slice"]');
		expect(wedges).toHaveLength(2);
		const id = wedges[0]!.getAttribute('data-target')!;
		await act(async () => wedges[0]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
		expect(diagram.state.selection).toEqual([id]);
		expect(container.querySelector(`[data-role="slice"][data-target="${id}"]`)!.hasAttribute('data-selected')).toBe(true);
		await act(async () => wedges[0]!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
		expect(diagram.source).toContain('"Alpha" : 40');
		const title = container.querySelector('[data-role="title"]')!;
		await act(async () => title.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })));
		expect(diagram.source).toContain('title Market');
		expect(opened).toEqual([id, '::title']);
		await act(async () => svg.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
		expect(diagram.state.selection).toEqual([]);
	});

	it('has no scene for families drawn as nodes and edges', async () => {
		let diagram!: UseMermaidDiagramResult;
		function Probe() {
			diagram = useMermaidDiagram({ source: SOURCE });
			return null;
		}
		await act(async () => root.render(<Probe />));
		expect(diagram.scene).toBeNull();
		let ok: boolean | undefined;
		await act(async () => {
			ok = diagram.renameTarget('A', 'Begin')?.ok;
		});
		expect(ok).toBe(true);
		expect(diagram.source).toContain('A[Begin]');
	});
});

describe('MermaidFamilyScene dragging', () => {
	it('drags a quadrant point to new coordinates as one undo step', async () => {
		let diagram!: UseMermaidDiagramResult;
		function Probe() {
			diagram = useMermaidDiagram({ source: 'quadrantChart\n  Idea A: [0.3, 0.8]\n  Idea B: [0.7, 0.6]\n' });
			return diagram.scene ? <MermaidFamilyScene scene={diagram.scene} onDragEnd={diagram.drop} onSelect={(t) => diagram.select(t ? [t] : [])} /> : null;
		}
		await act(async () => root.render(<Probe />));
		const point = container.querySelector('[data-role="point"][data-drag="move"]')!;
		expect(point).not.toBeNull();
		const before = diagram.source;
		const cx = Number(point.getAttribute('cx'));
		const cy = Number(point.getAttribute('cy'));
		await act(async () => {
			point.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
			window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: cx + 40, clientY: cy + 40 }));
		});
		// Mid-drag the point follows the pointer.
		expect(container.querySelector('[data-role="point"][data-drag="move"]')!.getAttribute('transform')).toBe('translate(40 40)');
		await act(async () => {
			window.dispatchEvent(new window.MouseEvent('pointerup', { clientX: cx + 40, clientY: cy + 40 }));
			point.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		});
		expect(diagram.source).not.toBe(before);
		expect(diagram.source).not.toContain('Idea A: [0.3, 0.8]');
		expect(diagram.state.selection).toEqual([]); // the click after a drag does not select
		await act(async () => diagram.undo());
		expect(diagram.source).toBe(before);
	});

	it('draws no drag handles while read-only', async () => {
		let diagram!: UseMermaidDiagramResult;
		function Probe() {
			diagram = useMermaidDiagram({ source: 'quadrantChart\n  Idea A: [0.3, 0.8]\n', readOnly: true });
			return diagram.scene ? <MermaidFamilyScene scene={diagram.scene} onDragEnd={diagram.drop} /> : null;
		}
		await act(async () => root.render(<Probe />));
		expect(container.querySelector('[data-drag]')).toBeNull();
	});
});
