import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ToolRegistry } from '@pixerate/editor/tools';
import { DiagramController, createDiagramToolProvider, createInstantPresenceClock } from '@pixerate/editor/diagram';
import { DiagramPresenceLayer, MermaidDiagramGroup, MermaidDiagramNode, MermaidFamilyScene, MermaidThumbnail, createDiagramDirector, createMermaidDiagram, createMermaidStream } from '../../src/canvas';
import { useAgentToolProvider } from '../../src';

let cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});

const SOURCE = 'flowchart LR\n  %% kept\n  A[Start] --> B{Ok?}\n  subgraph S [Box]\n    C\n  end\n  B --> C\n';

describe('createMermaidDiagram (Svelte)', () => {
	it('lays out the diagram as canvas nodes and writes edits back as Mermaid', () => {
		const diagram = createMermaidDiagram({ source: SOURCE });
		cleanups.push(diagram.destroy);
		expect(diagram.nodes.map((n) => [n.id, n.type])).toEqual([
			['S', 'mermaid-group'],
			['A', 'mermaid-node'],
			['B', 'mermaid-node'],
			['C', 'mermaid-node']
		]);
		diagram.connect('C', 'A', 'loop');
		expect(diagram.source).toContain('C -->|loop| A');
		expect(diagram.source).toContain('%% kept');
		expect(diagram.edges).toHaveLength(3);

		const a = diagram.nodes.find((n) => n.id === 'A')!;
		const before = diagram.layout.positions.A![0];
		diagram.moveNodes([{ ...a, position: { x: a.position.x + 40, y: a.position.y } }], diagram.nodes);
		expect(diagram.document.meta.layout?.A?.[0]).toBeCloseTo(before + 40);
		expect(diagram.source).toMatch(/%% @pixerate \{"v":1,"layout":\{"A":/);

		diagram.remove([diagram.edges[2]!.id, 'B']);
		expect(diagram.nodes.map((n) => n.id)).not.toContain('B');
		diagram.undo();
		expect(diagram.edges).toHaveLength(3);
		diagram.rename('S', 'Depot');
		expect(diagram.source).toContain('subgraph S [Depot]');
	});

	it('registers the diagram agent tools while mounted (parity with React)', async () => {
		const registry = new ToolRegistry();
		const controller = new DiagramController({ source: SOURCE });
		const diagram = createMermaidDiagram(controller);
		cleanups.push(diagram.destroy);
		const cleanup = $effect.root(() => {
			useAgentToolProvider(registry, createDiagramToolProvider(controller));
		});
		flushSync();
		expect(registry.listTools().tools.map((t) => t.name)).toContain('add_diagram_node');
		await registry.callTool('add_diagram_node', { label: 'New', from: 'C' });
		expect(diagram.nodes.map((n) => n.id)).toContain('N1');
		cleanup();
		expect(registry.listTools().tools).toHaveLength(0);
	});
});

describe('createMermaidStream (Svelte)', () => {
	it('holds back unconnected nodes until the source completes', () => {
		const stream = createMermaidStream({ duration: 0 });
		cleanups.push(stream.destroy);
		stream.update('```mermaid\nflowchart TD\n  a --> b\n  c');
		expect(stream.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		expect(stream.settled).toBe(true);
		stream.update('```mermaid\nflowchart TD\n  a --> b\n  c\n```', true);
		expect(stream.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
		stream.reset();
		expect(stream.nodes).toEqual([]);
	});
});

describe('MermaidDiagramNode (Svelte)', () => {
	it('draws the shape and label, painted from Mermaid styles', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const node = mount(MermaidDiagramNode, {
			target,
			props: { data: { node: { id: 'A', label: 'Two<br/>lines', shape: 'diam' }, resolvedStyles: { fill: '#fde68a' } }, width: 120, height: 80, selected: true }
		});
		const group = mount(MermaidDiagramGroup, { target, props: { data: { group: { id: 'S', label: 'Box' } } } });
		flushSync();
		cleanups.push(() => {
			unmount(node);
			unmount(group);
			target.remove();
		});
		const el = target.querySelector('.pixerate-diagram-node') as HTMLElement;
		expect(el.dataset.shape).toBe('diam');
		expect(el.querySelectorAll('path')).toHaveLength(1);
		expect(el.textContent).toContain('Two');
		expect(el.textContent).toContain('lines');
		expect(el.getAttribute('style')).toContain('--pixerate-diagram-node-bg: #fde68a');
		expect(target.querySelector('.pixerate-diagram-group')!.textContent!.trim()).toBe('Box');
	});
});

describe('MermaidThumbnail (Svelte)', () => {
	it('draws a fitted static preview (parity with React)', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const thumb = mount(MermaidThumbnail, { target, props: { source: SOURCE, maxWidth: 120 } });
		flushSync();
		cleanups.push(() => {
			unmount(thumb);
			target.remove();
		});
		const svg = target.querySelector('.pixerate-diagram-thumbnail svg')!;
		expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(120);
		expect(svg.querySelectorAll('[data-node]')).toHaveLength(3);
	});
});

describe('createDiagramDirector (Svelte)', () => {
	it('acts out agent tool calls with a cursor drawn by DiagramPresenceLayer', async () => {
		const registry = new ToolRegistry();
		const controller = new DiagramController({ source: SOURCE });
		const diagram = createMermaidDiagram(controller);
		const clock = createInstantPresenceClock();
		const director = createDiagramDirector(controller, { placement: () => diagram.layout, clock, linger: 0 });
		cleanups.push(diagram.destroy, director.destroy);
		registry.register(createDiagramToolProvider(controller, { director: director.director }));
		let shown = 0;
		director.presence.subscribe((s) => {
			if (s.actors.length) shown++;
		});
		await registry.callTool('connect_diagram_nodes', { source: 'C', target: 'A', label: 'loop' });
		expect(shown).toBeGreaterThan(5);
		expect(diagram.source).toContain('C -->|loop| A');

		const target = document.createElement('div');
		document.body.appendChild(target);
		const layer = mount(DiagramPresenceLayer, { target, props: { presence: director.presence, viewport: { x: 10, y: 20, zoom: 2 } } });
		director.presence.set({ id: 'agent', x: 5, y: 5, message: 'Hi' });
		flushSync();
		cleanups.push(() => {
			unmount(layer);
			target.remove();
		});
		expect(director.state.actors).toHaveLength(1);
		const cursor = target.querySelector('[data-actor="agent"]') as HTMLElement;
		expect(cursor.getAttribute('style')).toContain('translate(20px, 30px)');
		expect(cursor.textContent!.trim()).toBe('Hi');
	});
});

const PIE = 'pie showData\n  title Share\n  "A" : 40\n  "B" : 60\n';

describe('MermaidFamilyScene (Svelte)', () => {
	it('draws a family as its own picture, selects marks and renames on double-click (parity with React)', () => {
		const diagram = createMermaidDiagram({ source: PIE });
		cleanups.push(diagram.destroy);
		expect(diagram.scene?.family).toBe('pie');
		const opened: string[] = [];
		const target = document.createElement('div');
		document.body.appendChild(target);
		const props = $state({
			scene: diagram.scene!,
			onselect: (id: string | null) => diagram.select(id ? [id] : []),
			onopen: (id: string) => {
				opened.push(id);
				diagram.renameTarget(id, id === '::title' ? 'Market' : 'Alpha');
			}
		});
		const scene = mount(MermaidFamilyScene, { target, props });
		const sync = $effect.root(() => {
			$effect(() => {
				props.scene = diagram.scene!;
			});
		});
		flushSync();
		cleanups.push(() => {
			sync();
			unmount(scene);
			target.remove();
		});
		const svg = target.querySelector('svg.pixerate-diagram-scene')!;
		const wedges = svg.querySelectorAll('[data-role="slice"]');
		expect(wedges).toHaveLength(2);
		const id = wedges[0]!.getAttribute('data-target')!;
		wedges[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();
		expect(diagram.state.selection).toEqual([id]);
		expect(target.querySelector(`[data-role="slice"][data-target="${id}"]`)!.hasAttribute('data-selected')).toBe(true);
		wedges[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(diagram.source).toContain('"Alpha" : 40');
		target.querySelector('[data-role="title"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(diagram.source).toContain('title Market');
		expect(opened).toEqual([id, '::title']);
		svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();
		expect(diagram.state.selection).toEqual([]);
	});

	it('has no scene for families drawn as nodes and edges', () => {
		const diagram = createMermaidDiagram({ source: SOURCE });
		cleanups.push(diagram.destroy);
		expect(diagram.scene).toBeNull();
		expect(diagram.renameTarget('A', 'Begin')?.ok).toBe(true);
		expect(diagram.source).toContain('A[Begin]');
	});
});

describe('MermaidFamilyScene dragging (Svelte)', () => {
	it('drags a quadrant point to new coordinates as one undo step (parity with React)', () => {
		const diagram = createMermaidDiagram({ source: 'quadrantChart\n  Idea A: [0.3, 0.8]\n  Idea B: [0.7, 0.6]\n' });
		cleanups.push(diagram.destroy);
		const target = document.createElement('div');
		document.body.appendChild(target);
		const props = $state({ scene: diagram.scene!, ondragend: diagram.drop, onselect: (id: string | null) => diagram.select(id ? [id] : []) });
		const scene = mount(MermaidFamilyScene, { target, props });
		const sync = $effect.root(() => {
			$effect(() => {
				props.scene = diagram.scene!;
			});
		});
		flushSync();
		cleanups.push(() => {
			sync();
			unmount(scene);
			target.remove();
		});
		const point = target.querySelector('[data-role="point"][data-drag="move"]')!;
		expect(point).not.toBeNull();
		const before = diagram.source;
		const cx = Number(point.getAttribute('cx'));
		const cy = Number(point.getAttribute('cy'));
		point.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: cx + 40, clientY: cy + 40 }));
		flushSync();
		expect(target.querySelector('[data-role="point"][data-drag="move"]')!.getAttribute('transform')).toBe('translate(40 40)');
		window.dispatchEvent(new MouseEvent('pointerup', { clientX: cx + 40, clientY: cy + 40 }));
		point.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();
		expect(diagram.source).not.toContain('Idea A: [0.3, 0.8]');
		expect(diagram.state.selection).toEqual([]);
		diagram.undo();
		expect(diagram.source).toBe(before);
	});

	it('draws no drag handles while read-only', () => {
		const diagram = createMermaidDiagram({ source: 'quadrantChart\n  Idea A: [0.3, 0.8]\n', readOnly: true });
		cleanups.push(diagram.destroy);
		expect(diagram.scene!.marks.some((m) => m.drag)).toBe(false);
	});
});
