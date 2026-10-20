// Distortion brushes (CorelDRAW's Smudge, Twirl, Attract, Repel and Roughen, concept only). Test
// cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { bezierPathBounds, pathToContours } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	distortVectorPath,
	ellipseSubpath,
	getVectorOverlayRenderData,
	rectSubpath,
	subpathsToBezier,
	vectorDistortDabMap,
	vectorDistortFalloff,
	type VectorPathNode
} from '../src/vector';

const circle = subpathsToBezier([ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 })]);
const box = (p: ReturnType<typeof subpathsToBezier>) => {
	const b = bezierPathBounds(p)!;
	return [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 10) / 10);
};
const square = (id = 'a', x = 0): VectorPathNode => ({ id, type: 'path', subpaths: [ellipseSubpath({ x, y: 0, width: 100, height: 100 })], fill: '#ff0000', stroke: null });

describe('distortion dabs', () => {
	it('fade smoothly from the centre to nothing at the rim', () => {
		expect(vectorDistortFalloff(0, 10)).toBe(1);
		expect(vectorDistortFalloff(10, 10)).toBe(0);
		expect(vectorDistortFalloff(5, 10)).toBeCloseTo(0.5625);
	});

	it('push, turn, pull in and push out under the brush only', () => {
		const dab = { x: 0, y: 0, radius: 10, strength: 1 };
		expect(vectorDistortDabMap('smudge', { ...dab, dx: 4, dy: 0 })({ x: 0, y: 0 })).toEqual({ x: 4, y: 0 });
		const t = vectorDistortDabMap('twirl', { ...dab, angle: 90 })({ x: 0.001, y: 0 });
		expect(t.x).toBeCloseTo(0, 3);
		expect(t.y).toBeCloseTo(0.001, 5);
		expect(vectorDistortDabMap('attract', dab)({ x: 2, y: 0 }).x).toBeLessThan(2);
		expect(vectorDistortDabMap('repel', dab)({ x: 2, y: 0 }).x).toBeGreaterThan(2);
		expect(vectorDistortDabMap('repel', dab)({ x: 20, y: 0 })).toEqual({ x: 20, y: 0 });
	});
});

describe('distorting paths', () => {
	it('smudges a bulge out of a circle along the stroke', () => {
		// Dragging from the right edge outward pulls a lobe out to the right.
		const out = distortVectorPath(circle, 'smudge', [
			{ x: 100, y: 50, radius: 20, strength: 1, dx: 10, dy: 0 },
			{ x: 110, y: 50, radius: 20, strength: 1, dx: 10, dy: 0 }
		]);
		expect(box(out)[2]).toBeGreaterThan(115);
		expect(box(out)[0]).toBeCloseTo(0, 1);
	});

	it('pinches with attract and bloats with repel, leaving far paths alone', () => {
		expect(box(distortVectorPath(circle, 'attract', [{ x: 50, y: 50, radius: 60, strength: 1 }]))[2]).toBeLessThan(100);
		expect(box(distortVectorPath(circle, 'repel', [{ x: 50, y: 50, radius: 60, strength: 1 }]))[2]).toBeGreaterThan(100);
		expect(distortVectorPath(circle, 'twirl', [{ x: 500, y: 500, radius: 10, strength: 1 }])).toBe(circle);
	});

	it('roughens only what the brush reaches, the same way for the same seed', () => {
		const dabs = [{ x: 100, y: 50, radius: 20, strength: 1, seed: 3 }];
		const a = distortVectorPath(circle, 'roughen', dabs);
		expect(pathToContours(a)[0].segments.length).toBeGreaterThan(20);
		expect(distortVectorPath(circle, 'roughen', dabs)).toEqual(a);
		expect(box(a)[0]).toBeCloseTo(0, 1);
	});
});

describe('the Distort Brush in the editor', () => {
	it('smudges with a drag as one undo step, showing the brush circle', () => {
		const c = new VectorEditorController({ document: { width: 300, height: 200, nodes: [square()] } });
		c.setTool('distort');
		c.setEditing({ distortMode: 'smudge', distortSize: 20, distortStrength: 1 });
		c.pointerDown({ x: 100, y: 50 });
		c.pointerMove({ x: 110, y: 50 });
		expect(getVectorOverlayRenderData(c.getState()).brush).toMatchObject({ x: 110, y: 50, r: 20 });
		c.pointerMove({ x: 125, y: 50 });
		c.pointerUp({ x: 125, y: 50 });
		const b = bezierPathBounds(subpathsToBezier((c.getNode('a') as VectorPathNode).subpaths))!;
		expect(b.maxX).toBeGreaterThan(110);
		expect(c.getState().undoLabel).toBe('Smudge');
		c.undo();
		expect(bezierPathBounds(subpathsToBezier((c.getNode('a') as VectorPathNode).subpaths))!.maxX).toBeCloseTo(100, 6);
	});

	it('twirls with a click, and leaves the document alone when it reaches nothing', () => {
		const c = new VectorEditorController({ document: { width: 300, height: 200, nodes: [square()] } });
		c.setTool('distort');
		c.setEditing({ distortMode: 'twirl', distortSize: 30 });
		c.pointerDown({ x: 250, y: 150 });
		c.pointerUp({ x: 250, y: 150 });
		expect(c.getState().canUndo).toBe(false);
		c.pointerDown({ x: 100, y: 50 });
		c.pointerUp({ x: 100, y: 50 });
		expect(c.getState().undoLabel).toBe('Twirl');
	});
});

describe('distortion brush commands through the tool registry', () => {
	it('runs each brush, scoped to ids, and refuses useless strokes', async () => {
		const c = new VectorEditorController({ document: { width: 400, height: 200, nodes: [square('a'), square('b', 200), { id: 'r', type: 'path', subpaths: [rectSubpath({ x: 0, y: 150, width: 10, height: 10 })], fill: '#000', stroke: null, locked: true }] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		expect((await run('vector.smudgeBrush', { points: [[100, 50], [130, 50]], radius: 20, strength: 1 })).result).toEqual({ ids: ['a'] });
		expect((await run('vector.twirlBrush', { points: [[250, 50]], radius: 40, angle: 45 })).result).toEqual({ ids: ['b'] });
		expect((await run('vector.attractBrush', { points: [[50, 50]], radius: 60, ids: ['a'] })).result).toEqual({ ids: ['a'] });
		expect((await run('vector.repelBrush', { points: [[250, 50]], radius: 60 })).result).toEqual({ ids: ['b'] });
		expect((await run('vector.roughenBrush', { points: [[200, 50]], radius: 20, seed: 4 })).result).toEqual({ ids: ['b'] });
		expect((await run('vector.smudgeBrush', { points: [[100, 50]] })).isError).toBe(true);
		expect((await run('vector.repelBrush', { points: [[390, 190]], radius: 5 })).text).toContain('reached no outline');
		expect((await run('vector.repelBrush', { points: [[5, 155]], ids: ['r'] })).text).toContain('locked');
		expect((await run('vector.setEditing', { distortMode: 'roughen', distortSize: 12 })).result.editing).toMatchObject({ distortMode: 'roughen', distortSize: 12 });
	});
});
