import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	applyVideoGrade,
	createVideoEditorToolProvider,
	createVideoProject,
	drawVideoFrame,
	normalizeVideoGrade,
	parseVideoProject,
	toVideoFfmpeg,
	VIDEO_GRADE_CONTROLS,
	videoFrameAt,
	videoGradeCssFilter,
	videoGradeFfmpegFilters,
	videoGradePreset,
	videoGradeSteps,
	videoGradeSvgDefs,
	videoProjectSvg,
	VideoEditorController
} from '../src/video-editor';

describe('grades', () => {
	it('apply in a fixed order, skipping settings that change nothing, clamped to their ranges', () => {
		expect(videoGradeSteps({ tint: 0.4, hue: 30, saturation: -0.5, contrast: 0.2, exposure: 1 }).map((s) => s.kind)).toEqual(['brightness', 'contrast', 'saturate', 'hue-rotate', 'gains']);
		expect(videoGradeSteps({ exposure: 0, contrast: 0 })).toEqual([]);
		expect(normalizeVideoGrade({ exposure: 9, saturation: 0, hue: -400 })).toEqual({ exposure: 3, hue: -180 });
		expect(normalizeVideoGrade({})).toBeUndefined();
		expect(VIDEO_GRADE_CONTROLS.map((c) => c.key)).toEqual(['exposure', 'contrast', 'saturation', 'hue', 'temperature', 'tint']);
	});

	it('change colours as CSS filters do', () => {
		// CSS saturate(0) on pure red: 0.213 × 255.
		expect(applyVideoGrade({ saturation: -1 }, [255, 0, 0])).toEqual([54, 54, 54]);
		// brightness(2) then clamp.
		expect(applyVideoGrade({ exposure: 1 }, [100, 200, 30])).toEqual([200, 255, 60]);
		// contrast(1.5) around 0.5: (100/255 − 0.5) × 1.5 + 0.5.
		expect(applyVideoGrade({ contrast: 0.5 }, [100, 128, 200])).toEqual([86, 128, 236]);
		// hue-rotate(180deg) on CSS's matrix.
		expect(applyVideoGrade({ hue: 180 }, [255, 0, 0])).toEqual([0, 109, 109]);
		const warm = applyVideoGrade({ temperature: 1 }, [128, 128, 128]);
		expect(warm[0]).toBeGreaterThan(128);
		expect(warm[2]).toBeLessThan(128);
		expect(applyVideoGrade(undefined, [1, 2, 3])).toEqual([1, 2, 3]);
	});

	it('come as CSS, SVG and ffmpeg filters', () => {
		const g = { exposure: 1, contrast: 0.5, saturation: -0.5, hue: 90, temperature: 0.4 };
		expect(videoGradeCssFilter(g)).toBe('brightness(2) contrast(1.5) saturate(0.5) hue-rotate(90deg) url(#pixerate-wb-1100-1000-900)');
		expect(videoGradeSvgDefs(g)).toEqual([{ id: 'pixerate-wb-1100-1000-900', markup: expect.stringContaining('values="1.1 0 0 0 0 0 1 0 0 0 0 0 0.9 0 0 0 0 0 1 0"') }]);
		const ff = videoGradeFfmpegFilters(g);
		expect(ff[0]).toBe("lutrgb=r='clip(val*2+0,0,255)':g='clip(val*2+0,0,255)':b='clip(val*2+0,0,255)'");
		expect(ff[1]).toBe("lutrgb=r='clip(val*1.5+-63.75,0,255)':g='clip(val*1.5+-63.75,0,255)':b='clip(val*1.5+-63.75,0,255)'");
		expect(ff[2]).toMatch(/^colorchannelmixer=rr=0\.6065:rg=0\.3575:rb=0\.036:/);
		expect(ff[4]).toBe('colorchannelmixer=rr=1.1:rg=0:rb=0:gr=0:gg=1:gb=0:br=0:bg=0:bb=0.9');
	});

	it('scale presets by their strength', () => {
		expect(videoGradePreset('warm')).toEqual({ temperature: 0.4, saturation: 0.1 });
		expect(videoGradePreset('punchy', 0.5)).toEqual({ contrast: 0.125, saturation: 0.15 });
		expect(videoGradePreset('punchy', 0)).toBeUndefined();
		expect(() => videoGradePreset('sepia' as any)).toThrow('There is no grade preset "sepia"');
	});
});

describe('graded clips', () => {
	const graded = () => {
		const r = applyVideoEdits(createVideoProject({ width: 640, height: 360, fps: 25 }), [
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'k', color: '#808080', duration: 1000, grade: { temperature: 0.5, saturation: -1 } } }
		]);
		if (!r.ok) throw new Error(r.error);
		return r.project;
	};

	it('carry the grade to layers, SVG and canvas (white balance through an SVG filter the host defines)', () => {
		const p = graded();
		expect(videoFrameAt(p, 0).layers[0].grade).toEqual({ saturation: -1, temperature: 0.5 });
		const svg = videoProjectSvg(p, 0);
		expect(svg).toContain('<filter id="g0" color-interpolation-filters="sRGB"');
		expect(svg).toContain('filter="url(#g0)"');
		const filters: string[] = [];
		const ctx: any = new Proxy({ globalAlpha: 1, measureText: () => ({ width: 1 }) }, {
			get: (t, k) => (k in t ? t[k] : () => {}),
			set: (t, k, v) => {
				t[k] = v;
				if (k === 'filter') filters.push(v);
				return true;
			}
		});
		const define = vi.fn();
		drawVideoFrame(ctx, videoFrameAt(p, 0), () => null, 1, { defineSvgFilter: define });
		expect(filters).toEqual(['saturate(0) url(#pixerate-wb-1125-1000-875)']);
		expect(define).toHaveBeenCalledWith('pixerate-wb-1125-1000-875', expect.stringContaining('<filter'));
		// Without a way to define it, the canvas leaves white balance out rather than drawing nothing.
		filters.length = 0;
		drawVideoFrame(ctx, videoFrameAt(p, 0), () => null);
		expect(filters).toEqual(['saturate(0)']);
	});

	it('export through RGB filters, and say titles drawn with drawtext lose it', () => {
		const p = graded();
		expect(toVideoFfmpeg(p).filterComplex).toMatch(/format=rgba,colorchannelmixer=[^,]*,colorchannelmixer=rr=1\.125/);
		const r = applyVideoEdits(p, [{ op: 'add_clip', track: 'v1', clip: { type: 'text', id: 't', text: 'Hi', grade: { exposure: 1 } } }]);
		expect(r.ok && toVideoFfmpeg(r.project).notes.join(' ')).toMatch(/Title "t" is drawn without its grade/);
	});

	it('are checked when read', () => {
		const bad = (grade: unknown) => () => parseVideoProject({ width: 640, height: 360, tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'x', type: 'color', color: '#fff', start: 0, duration: 1000, grade }] }] });
		expect(bad({ exposure: 5 })).toThrow('tracks[0].clips[0].grade.exposure must be at most 3.');
		expect(bad({ warmth: 1 })).toThrow(/grade\.warmth is not a grade setting; use exposure, contrast/);
		expect(bad('warm')).toThrow(/grade must be an object/);
	});
});

describe('grade tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({ clock: new ManualClock() });
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

	it('grade, look and match shots in one undo step each', async () => {
		const { controller, call, fail } = setup();
		await call('add_video_asset', { id: 'a', kind: 'video', src: 'a.mp4', duration: 9000 });
		await call('add_video_asset', { id: 'm', kind: 'audio', src: 'm.wav', duration: 9000 });
		for (const id of ['s1', 's2', 's3']) await call('add_video_clip', { track: 'v1', clip: { type: 'media', id, asset: 'a', duration: 2000 } });
		await call('add_video_clip', { track: 'a1', clip: { type: 'media', id: 'mus', asset: 'm', duration: 2000 } });

		const set = await call('update_video_clip', { clip: 's1', set: { grade: { exposure: 0.5, temperature: 0.2 } } });
		expect(set.clip.grade).toEqual({ exposure: 0.5, temperature: 0.2 });
		const copied = await call('copy_video_grade', { from: 's1', to: ['s2', 's3'] });
		expect(copied).toMatchObject({ grade: { exposure: 0.5, temperature: 0.2 }, clips: ['s2', 's3'] });
		const look = await call('apply_video_grade_preset', { clips: ['s2', 's3'], preset: 'black-and-white', amount: 0.5 });
		expect(look.clips).toEqual([
			{ id: 's2', grade: { saturation: -0.5, contrast: 0.075 } },
			{ id: 's3', grade: { saturation: -0.5, contrast: 0.075 } }
		]);
		expect(controller.getState().undoLabel).toBe('Apply black-and-white look');
		controller.undo();
		expect((await call('get_video_frame', { time: 2500 })).layers[0].grade).toEqual({ exposure: 0.5, temperature: 0.2 });

		expect(await fail('update_video_clip', { clip: 's1', set: { grade: { exposure: 4 } } })).toContain('exposure');
		expect(await fail('apply_video_grade_preset', { clips: ['mus'], preset: 'warm' })).toContain('Clip "mus" is sound only');
		expect(await fail('apply_video_grade_preset', { clips: ['s1'], preset: 'sepia' })).toContain('preset');
		expect(await fail('copy_video_grade', { from: 'nope', to: ['s1'] })).toContain('There is no clip "nope"');
	});
});
