import { describe, it, expect, beforeAll } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ShapeNode from '../../src/canvas/ShapeNode.svelte';
import { createCanvasDraw } from '../../src/canvas/createCanvasDraw.svelte.js';
import { createCanvasBrushes } from '../../src/canvas/shapeBrushstroke.svelte.js';
import { loadCanvasBrushstrokeRenderer } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';

beforeAll(async () => {
	await loadCanvasBrushstrokeRenderer();
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('brushed freehand strokes (Svelte)', () => {
	it('records pen samples and brushes the stroke node; drawStroke and listBrushes pass through', async () => {
		let nodes: CanvasNode[] = [];
		const draw = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n), tool: 'pen', style: { brush: 'ink-pen', width: 8 } });
		draw.startStroke([0, 0], { pressure: 0.2 });
		draw.continueStroke([40, 10], { pressure: 0.6 });
		draw.continueStroke([80, 0], { pressure: 1 });
		draw.endStroke();
		const shape = (nodes[0].data as any).shape;
		expect(shape.brush.brush).toBe('ink-pen');
		expect(shape.brush.pressure[0]).toBeCloseTo(0.2, 2);
		const drawn = await draw.drawStroke({ points: [[0, 50], [50, 60]], style: { brush: 'pencil-hb' } });
		expect(nodes.map((n) => n.id)).toContain(drawn.id);
		await expect(draw.drawStroke({ points: [[0, 0]], style: { brush: 'watercolor-round' } })).rejects.toThrow(/not a dry brush/);
		expect((await draw.listBrushes()).some((b) => b.id === 'pencil-hb')).toBe(true);
	});

	it('carries gradient paint from the style to the brushed stroke, interactively and through drawStroke', async () => {
		const paint = { type: 'gradient', stops: [{ offset: 0, color: '#1d4ed8' }, { offset: 1, color: '#facc15' }], map: { by: 'distance', length: 80 } } as const;
		let nodes: CanvasNode[] = [];
		const draw = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n), tool: 'pen', style: { brush: 'ink-pen', width: 8, paint } });
		draw.startStroke([0, 0]);
		draw.continueStroke([80, 0]);
		draw.endStroke();
		expect((nodes[0].data as any).shape.brush.paint).toEqual(paint);
		const drawn = await draw.drawStroke({ points: [[0, 50], [50, 60]], style: { brush: 'pencil-hb', paint } });
		expect(drawn.brush).toMatchObject({ paint: { type: 'gradient', space: 'pigment', map: { by: 'distance', length: 80, repeat: 'mirror' } } });
		await expect(draw.drawStroke({ points: [[0, 0]], style: { paint } })).rejects.toThrow(/pass a brush too/);
	});

	it('ShapeNode draws a brushed shape as an image, and a plain one as a path', async () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const brushed = { kind: 'path', d: 'M0 10 L100 10', viewBox: [0, 0, 100, 20], stroke: '#123456', strokeWidth: 6, brush: { brush: 'ink-pen', pressure: [0.3, 1] } };
		const a = mount(ShapeNode, { target, props: { data: { shape: brushed }, width: 100, height: 20 } });
		const b = mount(ShapeNode, { target, props: { data: { shape: { ...brushed, brush: undefined } }, width: 100, height: 20 } });
		flushSync();
		await settle();
		flushSync();
		try {
			const nodes = target.querySelectorAll('.pixerate-shape-node');
			expect(nodes[0].querySelector('image.pixerate-shape-brushstroke')!.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
			expect(nodes[0].querySelector('path')).toBeNull();
			expect(nodes[1].querySelector('image')).toBeNull();
			expect(nodes[1].querySelector('path')!.getAttribute('stroke')).toBe('#123456');
		} finally {
			unmount(a);
			unmount(b);
			target.remove();
		}
	});

	it('createCanvasBrushes lists the dry presets', async () => {
		let brushes: ReturnType<typeof createCanvasBrushes> | undefined;
		const cleanup = $effect.root(() => {
			brushes = createCanvasBrushes();
		});
		await settle();
		expect(brushes!.brushes.map((b) => b.id)).toContain('ink-pen');
		expect(brushes!.loading).toBe(false);
		cleanup();
	});
});
