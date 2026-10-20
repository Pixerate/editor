// Bitmap-to-vector stylise: mosaic, halftone, low poly and engraving (concepts only). Test cases
// our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { pngDataUrl } from '../src/raster/png';
import { bezierPathBounds } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	stylizeVectorImage,
	subpathsToBezier,
	vectorHalftone,
	vectorHatch,
	vectorLowPoly,
	vectorMosaic,
	type VectorGroupNode,
	type VectorPathNode,
	type VectorTracePixels
} from '../src/vector';

/** An image `w × h` coloured by `f(x, y)` → [r, g, b, a]. */
const image = (w: number, h: number, f: (x: number, y: number) => number[]): VectorTracePixels => {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
	return { width: w, height: h, data };
};
// Left half red, right half blue.
const halves = image(40, 20, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
// Black on the left fading to white on the right.
const ramp = image(64, 16, (x) => {
	const v = Math.round((x / 63) * 255);
	return [v, v, v, 255];
});
const count = (nodes: VectorPathNode[]) => nodes.reduce((n, p) => n + p.subpaths.length, 0);

describe('stylise styles', () => {
	it('tiles a mosaic, one compound path per colour', () => {
		const out = vectorMosaic(halves, { cell: 10, colors: 2, gap: 0 });
		expect(out).toHaveLength(2);
		expect(out.map((n) => n.fill).sort()).toEqual(['#0000ff', '#ff0000']);
		expect(count(out)).toBe(8);
		const b = bezierPathBounds(subpathsToBezier(out.find((n) => n.fill === '#ff0000')!.subpaths))!;
		expect([b.minX, b.maxX]).toEqual([0, 20]);
		expect(vectorMosaic(halves, { cell: 10, shape: 'circle' })[0].subpaths[0].anchors).toHaveLength(4);
	});

	it('draws halftone dots that grow where the picture is dark', () => {
		const [dots] = vectorHalftone(ramp, { cell: 8, angle: 0 });
		expect(dots.fill).toBe('#000000');
		const sizes = dots.subpaths.map((sp) => {
			const b = bezierPathBounds(subpathsToBezier([sp]))!;
			return { x: (b.minX + b.maxX) / 2, r: (b.maxX - b.minX) / 2 };
		});
		const left = sizes.filter((s) => s.x < 20);
		const right = sizes.filter((s) => s.x > 44);
		expect(Math.min(...left.map((s) => s.r))).toBeGreaterThan(Math.max(...right.map((s) => s.r), 0));
		// Coloured dots keep the picture's colours.
		const fills = vectorHalftone(halves, { cell: 5, color: null, colors: 2 }).map((n) => String(n.fill));
		const ch = (f: string, k: number) => parseInt(f.slice(1 + 2 * k, 3 + 2 * k), 16);
		expect(fills.some((f) => ch(f, 0) > 200 && ch(f, 2) < 60)).toBe(true);
		expect(fills.some((f) => ch(f, 2) > 200 && ch(f, 0) < 60)).toBe(true);
	});

	it('splits a jittered grid into triangles the same way for the same seed', () => {
		const a = vectorLowPoly(halves, { cell: 10, seed: 3 });
		expect(count(a)).toBe(2 * 4 * 2);
		expect(a.every((n) => n.subpaths.every((sp) => sp.anchors.length === 3))).toBe(true);
		expect(vectorLowPoly(halves, { cell: 10, seed: 3 })).toEqual(a);
		expect(vectorLowPoly(halves, { cell: 10, seed: 4 })).not.toEqual(a);
		// The image's corners stay put.
		const all = a.flatMap((n) => n.subpaths.flatMap((sp) => sp.anchors));
		expect(all.some((p) => p.x === 0 && p.y === 0)).toBe(true);
		expect(all.some((p) => p.x === 40 && p.y === 20)).toBe(true);
	});

	it('engraves lines that break where the picture is light', () => {
		const [lines] = vectorHatch(ramp, { cell: 4, angle: 0 });
		expect(lines.subpaths.length).toBeGreaterThan(2);
		// No ribbon reaches into the white right end.
		const maxX = Math.max(...lines.subpaths.map((sp) => bezierPathBounds(subpathsToBezier([sp]))!.maxX));
		expect(maxX).toBeLessThan(63);
	});

	it('refuses empty images and too many shapes', () => {
		expect(() => stylizeVectorImage({ width: 0, height: 0, data: [] }, 'mosaic')).toThrow('no pixels');
		expect(() => stylizeVectorImage(image(400, 400, () => [0, 0, 0, 255]), 'mosaic', { cell: 1 })).toThrow('larger cell');
		expect(stylizeVectorImage(image(8, 8, () => [0, 0, 0, 0]), 'mosaic')).toEqual([]);
	});
});

describe('stylise in the editor and through the tool registry', () => {
	it('adds each style as one group in one undo step, placed and scaled', async () => {
		const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		const url = pngDataUrl(halves.width, halves.height, halves.data);
		const mosaic = await run('vector.mosaicImage', { image: url, cell: 10, colors: 2, x: 100, y: 50, width: 80 });
		expect(mosaic.result.paths).toHaveLength(2);
		const g = c.getNode(mosaic.result.id) as VectorGroupNode;
		const b = bezierPathBounds(subpathsToBezier((g.children[0] as VectorPathNode).subpaths))!;
		expect(b.minY).toBeGreaterThanOrEqual(50);
		expect(c.getState().undoLabel).toBe('Mosaic');
		expect((await run('vector.halftoneImage', { image: url, cell: 5, color: '#123456' })).result.paths[0].fill).toBe('#123456');
		expect((await run('vector.lowPolyImage', { image: url, cell: 10, seed: 2 })).result.paths.length).toBeGreaterThan(0);
		const ink = pngDataUrl(ramp.width, ramp.height, ramp.data);
		expect((await run('vector.hatchImage', { image: ink, cell: 4 })).result.paths).toHaveLength(1);
		expect(c.getState().document.nodes).toHaveLength(4);
		expect((await run('vector.mosaicImage', { image: 'data:text/plain,hi' })).text).toContain('PNG data URL');
		expect((await run('vector.halftoneImage', { image: pngDataUrl(4, 4, new Uint8ClampedArray(64).fill(255)) })).text).toContain('Nothing to draw');
		expect((await run('vector.mosaicImage', { image: url, colors: 99 })).isError).toBe(true);
		expect(c.stylizeImage(halves, 'spiral' as never).ok).toBe(false);
	});
});
