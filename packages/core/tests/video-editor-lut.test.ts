import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoGrade,
	applyVideoLut,
	applyVideoLutToPixels,
	createVideoEditorToolProvider,
	drawVideoFrame,
	normalizeVideoGrade,
	parseVideoCubeLut,
	parseVideoProject,
	toVideoFfmpeg,
	VideoEditorController,
	videoFrameAt,
	videoGradeSvgFilter,
	VideoLutCache,
	videoLutFromFunction,
	videoLutSvgApproximation,
	videoLutToCube,
	VideoPreviewEngine,
	videoProjectSvg,
	type VideoProject
} from '../src/video-editor';

const IDENTITY = videoLutFromFunction(5, (c) => c);
/** Green into red, a curve on blue, a lift on black: a look no grade step can make. */
const LOOK = videoLutFromFunction(17, ([r, g, b]) => [0.05 + 0.9 * g ** 0.8, (r + b) / 2, b ** 1.5], 'Look');
const close = (a: readonly number[], b: readonly number[], eps = 1e-5) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe('.cube files', () => {
	it('read a 3D table with its title, domain and comments', () => {
		const lut = parseVideoCubeLut(`# made by hand
TITLE "Warm"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1

0 0 0
1 0 0 # red
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`);
		expect(lut.title).toBe('Warm');
		expect(lut.size).toBe(2);
		expect([...lut.data.slice(3, 6)]).toEqual([1, 0, 0]);
		expect(applyVideoLut(lut, [0.25, 0.5, 0.75])).toEqual([0.25, 0.5, 0.75]);
	});

	it('round-trip through videoLutToCube', () => {
		const back = parseVideoCubeLut(videoLutToCube(LOOK));
		expect(back.title).toBe('Look');
		expect(back.size).toBe(17);
		expect(close([...back.data], [...LOOK.data])).toBe(true);
		const ranged = parseVideoCubeLut('LUT_3D_INPUT_RANGE 0 2\nLUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8));
		expect(ranged.domainMax).toEqual([2, 2, 2]);
		expect(videoLutToCube(ranged)).toContain('DOMAIN_MAX 2 2 2');
	});

	it('say what is wrong and where', () => {
		expect(() => parseVideoCubeLut('LUT_1D_SIZE 4\n0 0 0')).toThrow('Line 2 of the .cube file: this is a 1D LUT (LUT_1D_SIZE); only 3D LUTs (LUT_3D_SIZE) are supported.');
		expect(() => parseVideoCubeLut('TITLE "x"')).toThrow('The .cube file has no LUT_3D_SIZE line, so it is not a 3D LUT.');
		expect(() => parseVideoCubeLut('LUT_3D_SIZE 2\n0 0 0')).toThrow('The .cube file has 1 table rows; LUT_3D_SIZE 2 needs 8.');
		expect(() => parseVideoCubeLut('LUT_3D_SIZE 2\n0 0 0\nDOMAIN_MIN 0 0 0')).toThrow('Line 3 of the .cube file: "DOMAIN_MIN" comes after the table; keywords go before it.');
		expect(() => parseVideoCubeLut('LUT_3D_SIZE 2\n0 zero 0')).toThrow('Line 2 of the .cube file: "zero" is not a number.');
		expect(() => parseVideoCubeLut('LUT_3D_SIZE 2\n0 0')).toThrow('Line 2 of the .cube file: a table row needs 3 numbers, not 2.');
		expect(() => parseVideoCubeLut('LUT_3D_SIZE 300')).toThrow('LUT_3D_SIZE must be a whole number from 2 to 129, not "300"');
		expect(() => parseVideoCubeLut(`LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(9)}`)).toThrow('more than the 8 rows');
	});
});

describe('tetrahedral interpolation', () => {
	it('returns lattice points exactly and reproduces any straight-line (affine) look', () => {
		expect(applyVideoLut(LOOK, [1, 0.5, 0.25])).toEqual([...LOOK.data.slice((16 + 8 * 17 + 4 * 289) * 3, (16 + 8 * 17 + 4 * 289) * 3 + 3)]);
		const affine = (c: readonly number[]) => [0.1 + 0.5 * c[0] + 0.3 * c[2], 0.8 * c[1], 0.2 + 0.2 * c[0] + 0.5 * c[2]] as const;
		const lut = videoLutFromFunction(3, affine);
		for (const c of [[0.13, 0.77, 0.4], [0.9, 0.1, 0.55], [0.5, 0.5, 0.5]] as const) expect(close(applyVideoLut(lut, c), affine(c))).toBe(true);
		expect(applyVideoLut(IDENTITY, [0.3, 0.6, 0.9])).toEqual([0.3, 0.6, 0.9].map((v) => Math.fround(v)).map((v) => expect.closeTo(v, 6)) as any);
	});

	it('keeps greys on the grey axis whatever the rest of the table holds', () => {
		// Greys come from the cube's diagonal corners only: off-diagonal points never leak in.
		const wild = videoLutFromFunction(5, ([r, g, b]) => (r === g && g === b ? [r, g, b] : [1 - r, b, g]));
		for (const v of [0.1, 0.37, 0.5, 0.88]) {
			const out = applyVideoLut(wild, [v, v, v]);
			expect(close(out, [v, v, v])).toBe(true);
		}
	});

	it('clamps inputs to the domain and outputs to 0–1', () => {
		const hot = videoLutFromFunction(2, ([r, g, b]) => [r * 2, g - 1, b]);
		expect(applyVideoLut(hot, [0.8, 0.2, 2])).toEqual([1, 0, 1]);
	});

	it('runs RGBA pixels at a strength, leaving transparent ones alone', () => {
		const px = new Uint8ClampedArray([0, 255, 0, 255, 0, 255, 0, 0, 100, 100, 100, 255]);
		applyVideoLutToPixels(LOOK, px, 0.5);
		const want = applyVideoGrade({ lut: { src: 'x', strength: 0.5 } }, [0, 255, 0], LOOK);
		expect([...px.slice(0, 3)]).toEqual(want);
		expect([...px.slice(4, 8)]).toEqual([0, 255, 0, 0]);
		const none = new Uint8ClampedArray([10, 20, 30, 255]);
		applyVideoLutToPixels(LOOK, none, 0);
		expect([...none]).toEqual([10, 20, 30, 255]);
	});
});

describe('grades with a LUT', () => {
	it('keep the LUT through normalising and parsing, and apply it last at its strength', () => {
		expect(normalizeVideoGrade({ exposure: 0, lut: { src: 'a.cube', strength: 1.5 } })).toEqual({ lut: { src: 'a.cube' } });
		expect(normalizeVideoGrade({ lut: { src: 'a.cube', strength: 0 } })).toBeUndefined();
		expect(normalizeVideoGrade({ lut: { src: 'a.cube', strength: 0.25, name: 'Look' } })).toEqual({ lut: { src: 'a.cube', strength: 0.25, name: 'Look' } });
		const project = (grade: unknown) => ({ version: 1, width: 10, height: 10, fps: 25, assets: [], tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c', type: 'color', color: '#fff', start: 0, duration: 100, grade }] }] });
		expect(() => parseVideoProject(project({ lut: { src: 'a.cube', strength: 2 } }))).toThrow('tracks[0].clips[0].grade.lut.strength must be at most 1.');
		expect(() => parseVideoProject(project({ lut: { file: 'a.cube' } }))).toThrow('tracks[0].clips[0].grade.lut.file is not a LUT setting; use src, strength, name, preserveSkinTones.');
		expect(() => parseVideoProject(project({ lut: 'a.cube' }))).toThrow(/grade\.lut must be an object/);
		const g = { exposure: 1, lut: { src: 'a.cube', strength: 0.5 } };
		const graded = applyVideoGrade({ exposure: 1 }, [60, 90, 30]);
		const looked = applyVideoLut(LOOK, graded.map((v) => v / 255) as [number, number, number]).map((v) => v * 255);
		expect(applyVideoGrade(g, [60, 90, 30], LOOK)).toEqual(graded.map((v, k) => Math.round((v + looked[k]) / 2)));
		// Without the table the LUT is left out.
		expect(applyVideoGrade(g, [60, 90, 30])).toEqual(graded);
	});

	it('approximate the LUT in SVG with curves and a matrix, exact for each', () => {
		const matrixLut = videoLutFromFunction(5, ([r, g, b]) => [g, b, 0.5 * r + 0.25]);
		const m = videoLutSvgApproximation(matrixLut);
		for (const x of [[0.2, 0.7, 0.4], [0.9, 0.1, 0.6]] as [number, number, number][]) expect(close(applyM(m, x), [x[1], x[2], 0.5 * x[0] + 0.25], 1e-3)).toBe(true);
		const curveLut = videoLutFromFunction(17, ([r, g, b]) => [r * r, Math.sqrt(g), b]);
		const c = videoLutSvgApproximation(curveLut);
		expect(close(applyM(c, [0.5, 0.25, 0.8]), [0.25, 0.5, 0.8], 0.02)).toBe(true);
		const filter = videoGradeSvgFilter('f', { exposure: 0.5, lut: { src: 'x', strength: 0.4 } }, LOOK);
		expect(filter).toMatch(/<feColorMatrix[^>]*\/><feComponentTransfer result="lutIn">.*<feFuncR type="table" tableValues="[\d. ]+"\/>.*<feComposite in2="lutIn" operator="arithmetic" k1="0" k2="0.4" k3="0.6" k4="0"\/><\/filter>$/);
		expect(videoGradeSvgFilter('f', { lut: { src: 'x' } }, null)).not.toContain('feComponentTransfer');
	});
});

/** Runs the SVG approximation on a colour, as a browser would. */
function applyM(a: ReturnType<typeof videoLutSvgApproximation>, rgb: [number, number, number]) {
	const n = a.tables[0].length - 1;
	const z = rgb.map((v, k) => {
		const x = v * n;
		const i = Math.min(n - 1, Math.floor(x));
		return a.tables[k][i] + (a.tables[k][i + 1] - a.tables[k][i]) * (x - i);
	});
	return a.matrix.map((row) => row[0] * z[0] + row[1] * z[1] + row[2] * z[2] + row[3]);
}

describe('VideoLutCache', () => {
	it('loads each LUT once, reports failures, and takes LUTs the host has', async () => {
		const loader = vi.fn(async (src: string) => (src === 'bad.cube' ? 'LUT_3D_SIZE 2\n0 0 0' : videoLutToCube(LOOK)));
		const cache = new VideoLutCache(loader);
		const heard = vi.fn();
		cache.subscribe(heard);
		expect(cache.get('look.cube')).toBeUndefined();
		const [a, b] = await Promise.all([cache.load('look.cube'), cache.load('look.cube')]);
		expect(a).toBe(b);
		expect(loader).toHaveBeenCalledTimes(1);
		expect(cache.peek('look.cube')!.size).toBe(17);
		await expect(cache.load('bad.cube')).rejects.toThrow('The LUT "bad.cube" could not be read: The .cube file has 1 table rows; LUT_3D_SIZE 2 needs 8.');
		expect(cache.error('bad.cube')).toMatch(/needs 8/);
		expect(heard).toHaveBeenCalledTimes(2);
		cache.set('bad.cube', IDENTITY);
		expect(cache.error('bad.cube')).toBeUndefined();
		expect(cache.peek('bad.cube')).toBe(IDENTITY);
		const throws = new VideoLutCache(async () => {
			throw new Error('404 Not Found');
		});
		await expect(throws.load('x.cube')).rejects.toThrow('The LUT "x.cube" could not be read: 404 Not Found');
	});
});

const project = (grade: object): VideoProject => ({
	version: 1,
	width: 4,
	height: 2,
	fps: 25,
	assets: [{ id: 'song', kind: 'audio', src: 'song.mp3', duration: 5000 }],
	tracks: [
		{ id: 'v1', kind: 'video', clips: [{ id: 'k', type: 'color', color: '#00ff00', start: 0, duration: 1000, grade, opacity: 0.5 }] },
		{ id: 'v2', kind: 'video', clips: [{ id: 'k2', type: 'color', color: '#ff0000', start: 0, duration: 1000 }] },
		{ id: 'a1', kind: 'audio', clips: [{ id: 'm', type: 'media', asset: 'song', start: 0, duration: 1000 }] }
	]
});

/** A recording 2D context whose getImageData returns `fill` everywhere. */
function recorder(fill: [number, number, number, number]) {
	const calls: { op: string; args: unknown[]; alpha?: number }[] = [];
	const state: any = { globalAlpha: 1, measureText: () => ({ width: 0 }) };
	state.getImageData = (_x: number, _y: number, w: number, h: number) => {
		const data = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < data.length; i += 4) data.set(fill, i);
		return { width: w, height: h, data };
	};
	const ctx = new Proxy(state, {
		get: (t, k: string) => (k in t ? t[k] : (...args: unknown[]) => calls.push({ op: k, args, alpha: t.globalAlpha })),
		set: (t, k, v) => ((t[k] = v), true)
	});
	return { ctx, calls };
}

describe('drawing a LUT layer', () => {
	it('draws it on the scratch canvas, runs its pixels through the LUT, then lays it on at its opacity', () => {
		const frame = videoFrameAt(project({ lut: { src: 'look.cube', strength: 1 } }), 500);
		const main = recorder([0, 0, 0, 0]);
		const scratch = recorder([0, 255, 0, 255]);
		const canvas = { id: 'scratch' } as unknown as CanvasImageSource;
		drawVideoFrame(main.ctx, frame, () => null, 1, { lutFor: (src) => (src === 'look.cube' ? LOOK : null), scratch: () => ({ canvas, ctx: scratch.ctx }) });
		const put = scratch.calls.find((c) => c.op === 'putImageData')!;
		const data = (put.args[0] as ImageData).data;
		expect([...data.slice(0, 3)]).toEqual(applyVideoGrade({ lut: { src: 'x' } }, [0, 255, 0], LOOK));
		const laid = main.calls.find((c) => c.op === 'drawImage')!;
		expect(laid.args).toEqual([canvas, 0, 0, 4, 2]);
		expect(laid.alpha).toBe(0.5);
		// The unLUTted layer below is drawn straight on the frame.
		expect(main.calls.filter((c) => c.op === 'fillRect').length).toBe(2);
	});

	it('leaves the LUT out while it loads or without a scratch canvas', () => {
		const frame = videoFrameAt(project({ lut: { src: 'look.cube' } }), 500);
		const main = recorder([0, 0, 0, 0]);
		drawVideoFrame(main.ctx, frame, () => null, 1, { lutFor: () => undefined, scratch: () => null });
		expect(main.calls.some((c) => c.op === 'drawImage')).toBe(false);
		expect(main.calls.filter((c) => c.op === 'fillRect').length).toBe(3);
	});

	it('in the preview: incomplete until the LUT loads, then redrawn with it', async () => {
		let release!: (text: string) => void;
		const c = new VideoEditorController({ project: project({ lut: { src: 'look.cube' } }), clock: new ManualClock(), luts: () => new Promise<string>((r) => (release = r)) });
		const main = recorder([0, 0, 0, 0]);
		const scratch = recorder([0, 255, 0, 255]);
		const scratchCanvas = { width: 0, height: 0 } as unknown as CanvasImageSource;
		const createScratch = vi.fn(() => ({ canvas: scratchCanvas, ctx: scratch.ctx }));
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: main.ctx, resolution: 1, createMedia: () => ({ addEventListener() {}, removeEventListener() {}, pause() {}, play() {} }) as any, createScratch });
		c.seek(500);
		expect(c.previewPixels.read()!.complete).toBe(false);
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		release(videoLutToCube(LOOK));
		await c.luts.load('look.cube');
		await Promise.resolve();
		expect(c.previewPixels.read()!.complete).toBe(true);
		expect(createScratch).toHaveBeenCalledTimes(1);
		expect(scratchCanvas).toMatchObject({ width: 4, height: 2 });
		expect(scratch.calls.some((x) => x.op === 'putImageData')).toBe(true);
		engine.destroy();
	});
});

describe('exporting a LUT', () => {
	it('runs lut3d after the grade, splitting and blending at part strength', () => {
		const full = toVideoFfmpeg(project({ exposure: 0.5, lut: { src: '/luts/look.cube' } }));
		expect(full.filterComplex).toMatch(/lutrgb=[^;]*,format=gbrap\[qv\d+\];\[qv\d+\]lut3d=file=\/luts\/look\.cube:interp=tetrahedral\[rv\d+\];\[rv\d+\]format=yuva420p/);
		const part = toVideoFfmpeg(project({ lut: { src: '/luts/look.cube', strength: 0.3 } }), { resolveLut: (src) => src.replace('look', 'baked') });
		expect(part.filterComplex).toMatch(/split\[ov\d+\]\[pv\d+\];\[pv\d+\]lut3d=file=\/luts\/baked\.cube:interp=tetrahedral\[sv\d+\];\[sv\d+\]\[ov\d+\]blend=all_mode=normal:all_opacity=0.3\[rv\d+\]/);
		expect(part.notes.join(' ')).not.toMatch(/lut3d reads only local files/);
		const remote = toVideoFfmpeg(project({ lut: { src: 'https://example.com/look.cube' } }));
		expect(remote.notes.join(' ')).toMatch(/ffmpeg's lut3d reads only local files, and clip "k"'s LUT is "https:\/\/example.com\/look.cube"; save it and pass resolveLut/);
	});
});

describe('LUT tools', () => {
	const setup = (luts: Record<string, string> = { 'look.cube': videoLutToCube(LOOK) }) => {
		const controller = new VideoEditorController({ project: project({ exposure: 0.2 }), clock: new ManualClock(), luts: async (src) => {
			if (!(src in luts)) throw new Error('404 Not Found');
			return luts[src];
		} });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller));
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
			return r.structuredContent as any;
		};
		const fail = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			expect(r.isError, `${name} should fail`).toBe(true);
			return r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
		};
		return { controller, call, fail };
	};

	it('apply a LUT over the grade in one undo step, and take it off again', async () => {
		const { controller, call } = setup();
		const r = await call('set_video_lut', { clips: ['k', 'k2'], src: 'look.cube', strength: 0.6 });
		expect(r.lut).toEqual({ src: 'look.cube', title: 'Look', size: 17 });
		expect(r.clips).toEqual([
			{ id: 'k', grade: { exposure: 0.2, lut: { src: 'look.cube', strength: 0.6, name: 'Look' } } },
			{ id: 'k2', grade: { lut: { src: 'look.cube', strength: 0.6, name: 'Look' } } }
		]);
		expect(controller.getState().undoLabel).toBe('Apply LUT');
		// A look keeps the LUT; it replaces only the settings.
		const looked = await call('apply_video_grade_preset', { clips: ['k'], preset: 'warm' });
		expect(looked.clips[0].grade.lut).toEqual({ src: 'look.cube', strength: 0.6, name: 'Look' });
		expect(looked.clips[0].grade.temperature).toBe(0.4);
		const off = await call('remove_video_lut', { clips: ['k', 'k2'] });
		expect(off.clips).toEqual([
			{ id: 'k', grade: { temperature: 0.4, saturation: 0.1 } },
			{ id: 'k2', grade: null }
		]);
		controller.undo();
		expect(controller.getProject().tracks[1].clips[0].grade).toEqual({ lut: { src: 'look.cube', strength: 0.6, name: 'Look' } });
	});

	it('check the file and the clips before changing anything', async () => {
		const { controller, fail } = setup({ 'bad.cube': 'LUT_1D_SIZE 2\n0 0 0\n1 1 1' });
		const before = controller.getProject();
		expect(await fail('set_video_lut', { clips: ['k'], src: 'missing.cube' })).toMatch('The LUT "missing.cube" could not be read: 404 Not Found');
		expect(await fail('set_video_lut', { clips: ['k'], src: 'bad.cube' })).toMatch(/only 3D LUTs \(LUT_3D_SIZE\) are supported/);
		expect(await fail('set_video_lut', { clips: ['m'], src: 'bad.cube' })).toMatch('Clip "m" is sound only; grades change pictures.');
		expect(await fail('set_video_lut', { clips: ['nope'], src: 'bad.cube' })).toMatch('There is no clip "nope"');
		expect(await fail('set_video_lut', { clips: ['k'], src: 'bad.cube', strength: 0 })).toMatch('A strength of 0 changes nothing');
		expect(await fail('set_video_lut', { clips: ['k'], src: 'bad.cube', strength: 2 })).toMatch(/strength/);
		expect(await fail('remove_video_lut', { clips: ['k'] })).toMatch('None of "k" has a LUT');
		expect(controller.getProject()).toBe(before);
	});

	it('render the LUT in SVG frames, saying it is approximate or missing', async () => {
		const { controller, call } = setup();
		controller.apply({ op: 'update_clip', clip: 'k', set: { grade: { lut: { src: 'look.cube' } } } }, 'LUT');
		const r = await call('render_video_frame', { time: 500 });
		expect(r.svg).toContain('<feFuncR type="table"');
		expect(r.notes).toEqual(['LUTs are drawn approximately in SVG (curves and a colour matrix); the preview and export apply them exactly.']);
		expect(controller.toSvg(500)).toContain('<feFuncR type="table"');
		controller.apply({ op: 'update_clip', clip: 'k2', set: { grade: { lut: { src: 'gone.cube' } } } }, 'LUT');
		const r2 = await call('render_video_frame', { time: 500 });
		expect(r2.notes[0]).toBe('The LUT "gone.cube" could not be read: 404 Not Found; that LUT is left out of the picture.');
		expect(videoProjectSvg(controller.getProject(), 500)).not.toContain('feFuncR');
	});
});

