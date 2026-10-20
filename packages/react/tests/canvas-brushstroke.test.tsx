import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
	ShapeNode,
	ShapeNodeZoomProvider,
	loadCanvasBrushstrokeRenderer,
	useCanvasBrushes,
	useCanvasDraw,
	type CanvasBrushPreset,
	type CanvasDraw,
	type CanvasNode
} from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(async () => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
	await loadCanvasBrushstrokeRenderer();
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

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

describe('brushed freehand strokes (react)', () => {
	it('records pen samples and brushes the stroke node; drawStroke and listBrushes pass through', async () => {
		const ref: { draw: CanvasDraw | null; nodes: CanvasNode[] } = { draw: null, nodes: [] };
		function Test() {
			const [nodes, setNodes] = useState<CanvasNode[]>([]);
			ref.nodes = nodes;
			ref.draw = useCanvasDraw({ nodes, setNodes, initialTool: 'pen', initialStyle: { brush: 'ink-pen', width: 8 } });
			return null;
		}
		await act(async () => root.render(<Test />));
		await act(async () => {
			ref.draw!.startStroke([0, 0], { pressure: 0.2 });
			ref.draw!.continueStroke([40, 10], { pressure: 0.6 });
			ref.draw!.continueStroke([80, 0], { pressure: 1 });
			ref.draw!.endStroke();
		});
		const shape = (ref.nodes[0].data as any).shape;
		expect(shape.brush.brush).toBe('ink-pen');
		expect(shape.brush.pressure[0]).toBeCloseTo(0.2, 2);
		let drawn: any;
		await act(async () => {
			drawn = await ref.draw!.drawStroke({ points: [[0, 50], [50, 60]], style: { brush: 'pencil-hb' } });
		});
		expect(ref.nodes.map((n) => n.id)).toContain(drawn.id);
		expect((await ref.draw!.listBrushes()).some((b) => b.id === 'pencil-hb')).toBe(true);
	});

	it('ShapeNode draws a brushed shape as an image, and a plain one as a path', async () => {
		const brushed = { kind: 'path', d: 'M0 10 L100 10', viewBox: [0, 0, 100, 20], stroke: '#123456', strokeWidth: 6, brush: { brush: 'ink-pen', pressure: [0.3, 1] } };
		await act(async () =>
			root.render(
				<ShapeNodeZoomProvider zoom={2}>
					<ShapeNode id="b" data={{ shape: brushed }} width={100} height={20} />
					<ShapeNode id="p" data={{ shape: { ...brushed, brush: undefined } }} width={100} height={20} />
				</ShapeNodeZoomProvider>
			)
		);
		await settle();
		const nodes = container.querySelectorAll('.pixerate-shape-node');
		const image = nodes[0].querySelector('image.pixerate-shape-brushstroke')!;
		expect(image.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
		expect(nodes[0].querySelector('path')).toBeNull();
		expect(nodes[1].querySelector('image')).toBeNull();
		expect(nodes[1].querySelector('path')!.getAttribute('stroke')).toBe('#123456');
	});

	it('useCanvasBrushes lists the dry presets', async () => {
		const ref: { brushes: CanvasBrushPreset[] } = { brushes: [] };
		function Test() {
			ref.brushes = useCanvasBrushes().brushes;
			return null;
		}
		await act(async () => root.render(<Test />));
		await settle();
		expect(ref.brushes.map((b) => b.id)).toContain('ink-pen');
		expect(ref.brushes.some((b) => b.id === 'watercolor-round')).toBe(false);
	});
});
