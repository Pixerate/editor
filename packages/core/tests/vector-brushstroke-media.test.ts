// Vector brushstrokes with gradient paint, wet media, and the Mixer Brush, smudge and blender over
// what lies beneath them (#519). Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { decodePng, parseDataUrl } from '../src/raster/png';
import { BUILTIN_BRUSHES } from '../src/paint-editor/brushes';
import { WetBrushstrokeJob, renderBackdropBrushstroke } from '../src/vector/brushstrokeMedia';
import { rasterizeVectorBackdrop } from '../src/vector/backdrop';
import {
	VectorEditorController,
	createVectorCommands,
	getVectorSceneRenderData,
	onVectorBrushstrokesSettled,
	settleVectorBrushstrokes,
	vectorBrushstrokePaintError,
	vectorBrushstrokeImages,
	vectorBrushstrokesSettling,
	vectorDocumentToSvg,
	type VectorBrushstrokeImage,
	type VectorDocument,
	type VectorPathNode,
	type VectorStrokeLayer
} from '../src/vector';

const line = (id: string, y: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [{ closed: false, anchors: [{ x: 10, y }, { x: 110, y }] }],
	fill: null,
	stroke: null,
	...extra
});
const square = (id: string, fill: string, x = 0, y = 20): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [{ closed: true, anchors: [{ x, y }, { x: x + 60, y }, { x: x + 60, y: y + 60 }, { x, y: y + 60 }] }],
	fill,
	stroke: null
});
const layer = (brush: VectorStrokeLayer['brush'], paint: VectorStrokeLayer['paint'] = '#ff0000'): VectorStrokeLayer => ({ kind: 'brushstroke', paint, brush });
const withStroke = (n: VectorPathNode, l: VectorStrokeLayer): VectorPathNode => ({ ...n, stroke: l.paint, strokes: [l] });

/** Decoded pixels of a brushstroke image and a reader of the colour at a path-space point. */
function pixels(im: VectorBrushstrokeImage) {
	const png = decodePng(parseDataUrl(im.href)!.bytes);
	return {
		png,
		at(x: number, y: number): number[] {
			const px = Math.min(png.width - 1, Math.max(0, Math.floor(((x - im.x) / im.width) * png.width)));
			const py = Math.min(png.height - 1, Math.max(0, Math.floor(((y - im.y) / im.height) * png.height)));
			const i = (py * png.width + px) * 4;
			return [...png.data.slice(i, i + 4)];
		}
	};
}

const commandTools = (c: VectorEditorController) => {
	const commands = new CommandRegistry();
	commands.register(createVectorCommands(c));
	const tools = new ToolRegistry();
	tools.register(createCommandToolProvider(commands));
	return async (id: string, params: Record<string, unknown>) => {
		const r = await tools.callTool('run_command', { id, params });
		return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: r.structuredContent as any };
	};
};

describe('gradient paint on vector brushstrokes', () => {
	const red = { offset: 0, color: '#ff0000' };
	const blue = { offset: 1, color: '#0000ff' };

	it('samples brush paint dab by dab along the path instead of one colour', () => {
		const n = withStroke(line('a', 50), layer({ brushId: 'marker', size: 10, paint: { type: 'gradient', stops: [red, blue], space: 'srgb', map: { by: 'distance', length: 100, repeat: 'clamp' } } }));
		const [im] = vectorBrushstrokeImages(n, n.strokes![0]);
		const p = pixels(im);
		const start = p.at(14, 50);
		const end = p.at(106, 50);
		expect(start[0]).toBeGreaterThan(start[2] + 100);
		expect(end[2]).toBeGreaterThan(end[0] + 100);
	});

	it('lays a gradient layer paint along the path, across the tip, or within its box', () => {
		const g = (strokeMode: 'along' | 'across' | 'within') => ({ type: 'linear' as const, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], strokeMode, angle: 90 });
		const along = withStroke(line('a', 50), layer({ brushId: 'marker', size: 10 }, g('along')));
		const pa = pixels(vectorBrushstrokeImages(along, along.strokes![0])[0]);
		expect(pa.at(14, 50)[0]).toBeGreaterThan(pa.at(14, 50)[2]);
		expect(pa.at(106, 50)[2]).toBeGreaterThan(pa.at(106, 50)[0]);
		// Across: left of the direction of travel (y − 4) is one end, right (y + 4) the other.
		const across = withStroke(line('a', 50), layer({ brushId: 'marker', size: 12 }, g('across')));
		const pc = pixels(vectorBrushstrokeImages(across, across.strokes![0])[0]);
		const top = pc.at(60, 46);
		const bottom = pc.at(60, 54);
		expect(Math.sign(top[0] - top[2])).not.toBe(Math.sign(bottom[0] - bottom[2]));
		// Within: the gradient over the path's box (left red, right blue at angle 90), the stroke's alpha kept.
		const within = withStroke(line('a', 50), layer({ brushId: 'marker', size: 10 }, g('within')));
		const pw = pixels(vectorBrushstrokeImages(within, within.strokes![0])[0]);
		expect(pw.at(14, 50)[0]).toBeGreaterThan(200);
		expect(pw.at(106, 50)[2]).toBeGreaterThan(200);
	});

	it('paints a brush\'s own gradient (multi-colour brushes) with the layer colour for its paint stops', () => {
		const n = withStroke(line('a', 50), layer({ brushId: 'gradient-round', size: 12 }, '#e11d48'));
		const p = pixels(vectorBrushstrokeImages(n, n.strokes![0])[0]);
		const colours = new Set<string>();
		for (let x = 15; x <= 105; x += 15) colours.add(p.at(x, 50).slice(0, 3).map((v) => v >> 4).join(','));
		expect(colours.size).toBeGreaterThan(2);
	});

	it('refuses timed and malformed paint with a reason, through the controller and the commands', async () => {
		expect(vectorBrushstrokePaintError({ type: 'gradient', stops: [red, blue], map: { by: 'velocity' } })).toMatch(/needs timed samples/);
		expect(vectorBrushstrokePaintError({ type: 'gradient', stops: [red] })).toMatch(/2\.\.16 stops/);
		expect(vectorBrushstrokePaintError({ type: 'gradient', stops: [red, blue], map: { by: 'distance', length: 50 } })).toBeNull();
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line('a', 50, { stroke: '#000000' })] } });
		expect(c.addBrushstroke({ brushId: 'marker', paint: { type: 'gradient', stops: [red, blue], map: { by: 'time' } } as never }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('timed samples') });
		const run = commandTools(c);
		const added = await run('vector.addBrushstroke', { ids: ['a'], brushId: 'marker', paint: { type: 'gradient', stops: [red, blue], map: { by: 'distance', length: 80, repeat: 'clamp' } } });
		expect(added.error).toBeNull();
		const strokes = added.data.result.paths[0].strokes;
		const index = strokes.length - 1;
		expect(strokes[index]).toMatchObject({ kind: 'brushstroke', brush: { brushId: 'marker', paint: { type: 'gradient', map: { by: 'distance', length: 80 } } } });
		// The schema refuses an unknown mapping before the controller sees it; the controller refuses a timed one.
		expect((await run('vector.addBrushstroke', { ids: ['a'], brushId: 'marker', paint: { type: 'gradient', stops: [red, blue], map: { by: 'velocity' } } })).error).toMatch(/paint/);
		expect((await run('vector.setBrushstroke', { id: 'a', index, paint: { type: 'gradient', stops: [red, blue], extra: 1 } })).error).toMatch(/extra|additional/i);
		const cleared = await run('vector.setBrushstroke', { id: 'a', index, paint: null });
		expect(cleared.error).toBeNull();
		expect(cleared.data.result.strokes[index].brush.paint).toBeUndefined();
	});
});

// The wet simulation costs about 25 ms per step on the TypeScript kernel, so these take seconds.
describe('wet brushstrokes', () => {
	const wet = BUILTIN_BRUSHES.find((b) => b.id === 'watercolor-detail')!;
	const input = { points: [{ x: 0, y: 0 }, { x: 30, y: 4 }] };

	it('settle to the same bytes every time, and spread past the paint as laid', () => {
		const opts = { scale: 1, color: [30, 80, 200, 255] as const, seed: 3 };
		const a = new WetBrushstrokeJob(input, wet, opts, 40);
		const laid = a.image();
		const settled = a.settled();
		const b = new WetBrushstrokeJob(input, wet, opts, 40).settled();
		expect(settled.image.data).toEqual(b.image.data);
		expect(settled.bounds).toEqual(b.bounds);
		expect(laid.image.data).not.toEqual(settled.image.data);
		expect(settled.dabs).toBeGreaterThan(0);
	}, 30000);

	it('runs in slices within a budget', () => {
		const job = new WetBrushstrokeJob(input, wet, { scale: 1, color: [0, 0, 0, 255] }, 30);
		expect(job.run(0)).toBe(false);
		expect(job.progress).toBe(1);
		expect(job.run()).toBe(true);
		expect(job.progress).toBe(30);
	}, 30000);

	it('shows the paint as laid in the scene, then the settled image after it settles; exports settle first', () => {
		const n = withStroke(line('w', 50), layer({ brushId: 'watercolor-detail', size: 6 }, '#1d4ed8'));
		const doc: VectorDocument = { width: 200, height: 100, nodes: [n] };
		const c = new VectorEditorController({ document: doc });
		let notified = 0;
		c.subscribe(() => notified++);
		let settledEvents = 0;
		const off = onVectorBrushstrokesSettled(() => settledEvents++);
		const live = vectorBrushstrokeImages(n, n.strokes![0]);
		expect(live).toHaveLength(1);
		expect(vectorBrushstrokesSettling()).toBeGreaterThan(0);
		expect(settleVectorBrushstrokes()).toBeGreaterThan(0);
		expect(settledEvents).toBe(1);
		expect(notified).toBeGreaterThan(0);
		const done = vectorBrushstrokeImages(n, n.strokes![0]);
		expect(done[0].href).not.toBe(live[0].href);
		// A fresh path with the same stroke reuses the settled image; an export never shows the paint as laid.
		const svg = vectorDocumentToSvg({ ...doc, nodes: [{ ...n }] });
		expect(svg).toContain(done[0].href);
		off();
	}, 30000);
});

describe('mixer, smudge and blender brushstrokes', () => {
	const orange = '#ff8000';

	it('pick up the shapes beneath them in the document', () => {
		const smudge = withStroke(line('s', 50, { subpaths: [{ closed: false, anchors: [{ x: 20, y: 50 }, { x: 110, y: 50 }] }] }), layer({ brushId: 'smudge', size: 16 }));
		const doc: VectorDocument = { width: 200, height: 100, nodes: [square('sq', orange), smudge] };
		const [im] = vectorBrushstrokeImages(smudge, smudge.strokes![0], { document: doc });
		// Orange dragged out past the square's right edge (x = 60) onto bare paper.
		const p = pixels(im).at(68, 50);
		expect(p[3]).toBeGreaterThan(40);
		expect(p[0]).toBeGreaterThan(p[2] + 80);
		// Nothing beneath: nothing to smudge.
		expect(vectorBrushstrokeImages({ ...smudge }, smudge.strokes![0], { document: { width: 200, height: 100, nodes: [smudge] } })).toEqual([]);
	});

	it('mix the Mixer Brush\'s paint with what it crosses, and paint from its reservoir on bare paper', () => {
		const mixer = withStroke(line('m', 50), layer({ brushId: 'mixer-brush', size: 16 }, '#ffffff'));
		const doc: VectorDocument = { width: 200, height: 100, nodes: [square('sq', '#0000ff', 0, 20), mixer] };
		const [im] = vectorBrushstrokeImages(mixer, mixer.strokes![0], { document: doc });
		const over = pixels(im).at(55, 50);
		expect(over[2]).toBeGreaterThan(over[0] + 20);
		const bare = vectorBrushstrokeImages({ ...mixer }, mixer.strokes![0]);
		expect(bare).toHaveLength(1);
		const white = pixels(bare[0]).at(100, 50);
		expect(white[0]).toBeGreaterThan(220);
	});

	it('re-render when what lies beneath changes, and reuse the image when only what is above changes', () => {
		const blender = withStroke(line('b', 50, { subpaths: [{ closed: false, anchors: [{ x: 40, y: 50 }, { x: 80, y: 50 }] }] }), layer({ brushId: 'blender', size: 20 }));
		const doc: VectorDocument = { width: 200, height: 100, nodes: [square('l', '#ff0000', 0), square('r', '#0000ff', 60), blender] };
		const first = vectorBrushstrokeImages(blender, blender.strokes![0], { document: doc });
		expect(first).toHaveLength(1);
		const above = { ...doc, nodes: [...doc.nodes, square('top', '#00ff00', 150)] };
		expect(vectorBrushstrokeImages(blender, blender.strokes![0], { document: above })).toBe(first);
		const recoloured = { ...doc, nodes: [square('l', '#00ff00', 0), doc.nodes[1], blender] };
		const next = vectorBrushstrokeImages(blender, blender.strokes![0], { document: recoloured });
		expect(next).not.toBe(first);
		expect(next[0].href).not.toBe(first[0].href);
	});

	it('act on the path\'s own fill and lower strokes in the scene and in SVG export', () => {
		const smudge: VectorPathNode = { ...square('own', orange), strokes: [layer({ brushId: 'smudge', size: 14 })] };
		const doc: VectorDocument = { width: 200, height: 100, nodes: [smudge] };
		const scene = getVectorSceneRenderData({ document: doc, viewport: { x: 0, y: 0, zoom: 1 } });
		const path = scene.nodes[0] as { layers?: Array<{ kind: string; images?: VectorBrushstrokeImage[] }> };
		const images = path.layers!.find((l) => l.kind === 'brushstroke')!.images!;
		expect(images.length).toBeGreaterThan(0);
		expect(vectorDocumentToSvg(doc)).toContain(images[0].href);
	});

	it('render deterministically, keeping only the pixels they changed', () => {
		const smudge = BUILTIN_BRUSHES.find((b) => b.id === 'smudge')!;
		const input = { points: [{ x: 0, y: 10 }, { x: 40, y: 10 }] };
		const backdrop = (rect: { width: number; height: number }) => {
			const d = new Uint8ClampedArray(rect.width * rect.height * 4);
			for (let i = 0; i < d.length; i += 4) if ((i / 4) % rect.width < rect.width / 2) d.set([255, 0, 0, 255], i);
			return d;
		};
		const a = renderBackdropBrushstroke(input, smudge, { scale: 1, color: [0, 0, 0, 255], backdrop });
		const b = renderBackdropBrushstroke(input, smudge, { scale: 1, color: [0, 0, 0, 255], backdrop });
		expect(a.image.data).toEqual(b.image.data);
		expect(a.bounds!.width).toBeLessThan(60);
		expect(() => renderBackdropBrushstroke(input, BUILTIN_BRUSHES.find((x) => x.id === 'marker')!, { scale: 1, color: [0, 0, 0, 255] })).toThrow(/not a Mixer Brush, smudge or blender/);
	});
});

describe('the backdrop renderer', () => {
	it('draws solid and gradient fills, strokes and opacity in paint order', () => {
		const doc: VectorDocument = {
			width: 40,
			height: 20,
			nodes: [
				{ ...square('a', '#ff0000', 0, 0), subpaths: [{ closed: true, anchors: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] }] },
				{ ...square('b', '#0000ff', 0, 0), opacity: 0.5, subpaths: [{ closed: true, anchors: [{ x: 10, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 10, y: 20 }] }] },
				{ id: 'l', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 0, y: 18 }, { x: 40, y: 18 }] }], fill: null, stroke: '#00ff00', strokeWidth: 2 }
			]
		};
		const scene = getVectorSceneRenderData({ document: doc, viewport: { x: 0, y: 0, zoom: 1 } });
		const px = rasterizeVectorBackdrop(scene.nodes, scene.defs, [1, 0, 0, 1, 0, 0], { x: 0, y: 0, width: 40, height: 20 });
		const at = (x: number, y: number) => [...px.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
		expect(at(5, 5)).toEqual([255, 0, 0, 255]);
		const mixed = at(15, 5);
		expect(mixed[0]).toBeGreaterThan(100);
		expect(mixed[2]).toBeGreaterThan(100);
		expect(at(30, 5)).toEqual([0, 0, 255, 128]);
		expect(at(30, 18)[1]).toBe(255);
	});
});
