// Image tracing. After ArtCraft effectcraft `crates/path/src/trace.rs` (marching squares, then
// Douglas–Peucker, then fitting) (MIT OR Apache-2.0, © ArtCraft Team and contributors); test
// cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { pngDataUrl } from '../src/raster/png';
import {
	VectorEditorController,
	createVectorCommands,
	quantizeVectorTraceColors,
	traceVectorImage,
	vectorNodeBounds,
	vectorTraceContours,
	type VectorGroupNode,
	type VectorPathNode,
	type VectorTracePixels
} from '../src/vector';

/** A `w × h` RGBA image painted by `paint(x, y)` → [r, g, b, a]. */
const image = (w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): VectorTracePixels => {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
	return { width: w, height: h, data };
};
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
/** A black square from (10, 10) to (30, 30) on white. */
const square = image(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? BLACK : WHITE));
/** A black ring (outer radius 15, inner 7) centred at (20, 20). */
const ring = image(40, 40, (x, y) => {
	const r = Math.hypot(x + 0.5 - 20, y + 0.5 - 20);
	return r <= 15 && r >= 7 ? BLACK : WHITE;
});
const box = (n: VectorPathNode) => {
	const b = vectorNodeBounds(n)!;
	return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10);
};

describe('contours', () => {
	it('closes a loop half way between inside and outside pixel centres', () => {
		const field = new Float32Array(9).fill(0);
		field[4] = 1;
		const [loop] = vectorTraceContours(field, 3, 3, 0.5);
		const xs = loop.map((p) => p[0]);
		const ys = loop.map((p) => p[1]);
		// The middle pixel's centre is (1.5, 1.5); its neighbours' are a pixel away.
		expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([1, 2, 1, 2]);
	});

	it('closes contours that touch the image edge', () => {
		const loops = vectorTraceContours(new Float32Array(4).fill(1), 2, 2, 0.5);
		expect(loops).toHaveLength(1);
	});
});

describe('tracing images', () => {
	it('traces a square as a square, sharp at roundness 0', () => {
		const [path] = traceVectorImage(square, { cornerRoundness: 0 });
		expect(path.fill).toBe('#000000');
		expect(path.subpaths).toHaveLength(1);
		expect(path.subpaths[0].anchors).toHaveLength(4);
		expect(box(path)).toEqual([10, 10, 20, 20]);
	});

	it('keeps holes as even-odd subpaths, outer first', () => {
		const [path] = traceVectorImage(ring, { tolerance: 0.5 });
		expect(path.fillRule).toBe('evenodd');
		expect(path.subpaths).toHaveLength(2);
		const outer = box({ ...path, subpaths: [path.subpaths[0]] });
		const inner = box({ ...path, subpaths: [path.subpaths[1]] });
		expect(outer[2]).toBeGreaterThan(28);
		expect(inner[2]).toBeLessThan(16);
		// Curves at roundness 0.5: anchors carry handles.
		expect(path.subpaths[0].anchors.some((a) => a.out)).toBe(true);
	});

	it('drops shapes below the minimum area and traces by alpha', () => {
		const specks = image(30, 30, (x, y) => ((x === 5 && y === 5) || (x >= 15 && y >= 15) ? BLACK : WHITE));
		expect(traceVectorImage(specks, { minArea: 4 })[0].subpaths).toHaveLength(1);
		const transparent = image(20, 20, (x) => (x < 10 ? [255, 255, 0, 255] : [0, 0, 0, 0]));
		const [byAlpha] = traceVectorImage(transparent, { channel: 'alpha', cornerRoundness: 0, color: '#ff0000' });
		expect(box(byAlpha)).toEqual([0, 0, 10, 20]);
		expect(byAlpha.fill).toBe('#ff0000');
		// By darkness the yellow half is not dark enough.
		expect(traceVectorImage(transparent)).toEqual([]);
	});

	it('quantises colours by median cut, leaving transparent pixels out', () => {
		const img = image(10, 10, (x, y) => (y < 5 ? [250, 10, 10, 255] : x < 5 ? [10, 10, 240, 255] : [0, 0, 0, 0]));
		const q = quantizeVectorTraceColors(img, 4);
		expect(q.palette).toHaveLength(2);
		expect(q.counts.sort((a, b) => b - a)).toEqual([50, 25]);
		expect(q.index[99]).toBe(-1);
	});

	it('traces colours as stacked paths, the most common at the bottom covering the rest', () => {
		const img = image(30, 30, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? [200, 20, 20, 255] : [20, 20, 200, 255]));
		const paths = traceVectorImage(img, { mode: 'color', colors: 2, cornerRoundness: 0 });
		expect(paths.map((p) => p.fill)).toEqual(['#1414c8', '#c81414']);
		// The bottom (blue) layer covers the whole image, red included: no gap between them.
		expect(box(paths[0])).toEqual([0, 0, 30, 30]);
		expect(box(paths[1])).toEqual([10, 10, 10, 10]);
	});

	it('refuses images without pixels', () => {
		expect(() => traceVectorImage({ width: 2, height: 2, data: new Uint8ClampedArray(4) })).toThrow(/no pixels/);
	});
});

describe('Image Trace in the editor', () => {
	it('adds the traced paths as one group, placed and scaled, in one undo step', () => {
		const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		const r = c.traceImage(square, { x: 100, y: 50, width: 80, cornerRoundness: 0 });
		expect(r.ok).toBe(true);
		const g = c.getNode(r.id!) as VectorGroupNode;
		expect(g.name).toBe('Image Trace');
		expect(box(g.children[0] as VectorPathNode)).toEqual([120, 70, 40, 40]);
		expect(c.getState().selection).toEqual([r.id]);
		c.undo();
		expect(c.getState().document.nodes).toEqual([]);
		expect(c.traceImage(image(4, 4, () => WHITE)).ok).toBe(false);
		expect(c.traceImage(square, { colors: 1, mode: 'color' })).toEqual({ ok: false, message: 'colors must be a whole number from 2 to 32.' });
	});
});

describe('traceImage through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
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

	it('traces a PNG data URL and returns the paths it made', async () => {
		const { run } = setup();
		const url = pngDataUrl(ring.width, ring.height, ring.data);
		const r = await run('vector.traceImage', { image: url, x: 10, y: 10, width: 120 });
		expect(r.isError).toBe(false);
		expect(r.result.paths).toEqual([{ id: expect.any(String), name: 'Trace', fill: '#000000', subpaths: 2 }]);
	});

	it('fails usefully on bad input', async () => {
		const { run } = setup();
		expect((await run('vector.traceImage', { image: 'data:image/jpeg;base64,AAAA' })).text).toContain('must be a PNG data URL');
		const blank = image(8, 8, () => WHITE);
		expect((await run('vector.traceImage', { image: pngDataUrl(8, 8, blank.data) })).text).toContain('Nothing to trace');
		expect((await run('vector.traceImage', { image: 'x', colors: 99 })).isError).toBe(true);
	});
});
