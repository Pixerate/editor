import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ToolRegistry } from '@pixerate/editor/tools';
import { DiagramController, createDiagramToolProvider } from '@pixerate/editor/diagram';
import { MermaidDiagramGroup, MermaidDiagramNode, createMermaidDiagram, createMermaidStream } from '../../src/canvas';
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
