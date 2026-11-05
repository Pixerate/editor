import { describe, it, expect, beforeAll } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ShapeNode from '../../src/canvas/ShapeNode.svelte';
import { createCanvasDraw } from '../../src/canvas/createCanvasDraw.svelte.js';
import { createCanvasBrushes } from '../../src/canvas/shapeBrushstroke.svelte.js';
import { loadCanvasBrushstrokeRenderer } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';
import { CommandRegistry, createDrawCommands } from '@pixerate/editor/commands';

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
		await expect(draw.drawStroke({ points: [[0, 0]], style: { brush: 'watercolor-round' } })).rejects.toThrow(/can't brush a canvas stroke: Canvas has no wet surface/);
		expect((await draw.listBrushes()).some((b) => b.id === 'pencil-hb')).toBe(true);
	});

	it('selectBrush takes the brush\'s default colour for the colour scheme, unless keepColour', async () => {
		let nodes: CanvasNode[] = [];
		const draw = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n), tool: 'pen' });
		await draw.selectBrush('chalk');
		expect(draw.style).toMatchObject({ brush: 'chalk', color: '#475569' });
		draw.setColorScheme('dark');
		await draw.selectBrush('chalk');
		expect(draw.style.color).toBe('#f8fafc');
		await draw.selectBrush('ballpoint', { keepColour: true });
		expect(draw.style).toMatchObject({ brush: 'ballpoint', color: '#f8fafc' });
		await expect(draw.selectBrush('watercolor-round')).rejects.toThrow(/can't brush a canvas stroke/);
	});

	it('a colour taken from a light / dark default follows setColorScheme; colorLocked keeps the colour', async () => {
		let nodes: CanvasNode[] = [];
		const draw = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n), tool: 'pen', colorScheme: 'dark' });
		expect(draw.colorScheme).toBe('dark');
		await draw.selectBrush('chalk');
		expect(draw.style.color).toBe('#f8fafc');
		draw.setColorScheme('light');
		expect(draw.colorScheme).toBe('light');
		expect(draw.style.color).toBe('#475569');
		expect(draw.brushSettings()).toMatchObject({ brush: 'chalk', colorScheme: 'light', colorFollowsScheme: true });
		expect(draw.colorLocked).toBe(false);
		draw.setColorLocked(true);
		expect(draw.colorLocked).toBe(true);
		draw.setStyle({ color: '#16a34a' });
		await draw.selectBrush('ballpoint');
		expect(draw.style).toMatchObject({ brush: 'ballpoint', color: '#16a34a' });
		draw.setColorScheme('dark');
		expect(draw.style.color).toBe('#16a34a');
		const locked = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n), tool: 'pen', colorLocked: true });
		expect(locked.colorLocked).toBe(true);
	});

	it('the picker commands run through the Svelte draw object', async () => {
		let nodes: CanvasNode[] = [];
		const draw = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n), tool: 'pen' });
		const registry = new CommandRegistry();
		registry.register(createDrawCommands(draw));
		const r = await registry.executeAsync('canvas.selectBrush', { brushId: 'chalk' });
		expect(r).toMatchObject({ ok: true, result: { brush: 'chalk', color: '#475569', colorLocked: false } });
		expect(await registry.executeAsync('canvas.setColorScheme', { scheme: 'dark' })).toMatchObject({ ok: true, result: { color: '#f8fafc', colorScheme: 'dark' } });
		expect(draw.colorScheme).toBe('dark');
		expect(await registry.executeAsync('canvas.setColorLocked', { locked: true })).toMatchObject({ ok: true, result: { colorLocked: true } });
		expect(draw.colorLocked).toBe(true);
	});

	it('exposes nodeBounds, so gesture commands can circle a node by id', async () => {
		let nodes: CanvasNode[] = [{ id: 'card', position: { x: 100, y: 80 }, width: 160, height: 40, data: {} }];
		const draw = createCanvasDraw({ getNodes: () => nodes, setNodes: (n) => (nodes = n) });
		expect(draw.nodeBounds('card')).toEqual({ x: 100, y: 80, width: 160, height: 40 });
		expect(draw.nodeBounds('nope')).toBeUndefined();
		const commands = new CommandRegistry();
		commands.register(createDrawCommands(draw));
		const result: any = await commands.executeAsync('canvas.circle', { around: [{ nodeId: 'card' }] });
		expect(result.ok).toBe(true);
		expect(nodes).toHaveLength(2);
		expect(result.result.bounds.x).toBeLessThan(100);
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

	it('createCanvasBrushes renders a swatch per brush on request', async () => {
		let brushes: ReturnType<typeof createCanvasBrushes> | undefined;
		const cleanup = $effect.root(() => {
			brushes = createCanvasBrushes({ swatches: { width: 60, height: 20 } });
		});
		await new Promise((r) => setTimeout(r, 300));
		expect(brushes!.brushes.every((b) => b.swatch?.startsWith('data:image/png;base64,'))).toBe(true);
		cleanup();
	});
});
