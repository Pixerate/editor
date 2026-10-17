import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry } from '@pixerate/editor/tools';
import { DiagramController, createDiagramToolProvider } from '@pixerate/editor/diagram';
import { MermaidDiagramNode, MermaidDiagramGroup, useMermaidDiagram, useMermaidStream, type UseMermaidDiagramResult, type UseMermaidStreamResult } from '../src/canvas';
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
