import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, memoryStyleStore } from '../src/tools';
import { AnimationEditorController, animationStyleDomain, animationStyleSurface, createAnimationStyleToolProvider, type MotionScene } from '../src/animation-editor';
import { VideoEditorController, createVideoProject, createVideoStyleToolProvider, videoStyleDomain, videoStyleSurface } from '../src/video-editor';
import { ellipseSubpath, rectSubpath, type VectorDocument } from '../src/vector';

const skill = (domain: string) => `---\nname: house\ndescription: House style.\ndomains: [${domain}]\n---\n\nKeep it plain.\n`;
const resolver = (domain: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill(domain), [`house/${domain}.json`]: JSON.stringify(profile), ...(brand ? { 'house/brand.json': JSON.stringify(brand) } : {}) }) }],
		domains: [animationStyleDomain, videoStyleDomain]
	});

const ARTWORK: VectorDocument = {
	width: 400,
	height: 200,
	background: '#ffffff',
	nodes: [
		{ id: 'box', type: 'path', name: 'Box', fill: '#ef4444', subpaths: [rectSubpath({ x: 20, y: 20, width: 60, height: 60 })] },
		{ id: 'dot', type: 'path', fill: '#0ea5e9', subpaths: [ellipseSubpath({ x: 300, y: 120, width: 40, height: 40 })] }
	]
} as VectorDocument;

const scene = (): MotionScene => ({
	version: 1,
	name: 'test',
	artwork: ARTWORK,
	fps: 24,
	shots: [
		{ id: 'intro', hold: 200, run: [{ type: 'move', targets: ['box'], by: { x: 10, y: 0 }, duration: 3000, ease: 'linear' } as any, { type: 'style', targets: ['dot'], fill: '#9933cc' } as any] },
		{ id: 'outro', hold: 800, run: [{ type: 'fade', targets: ['dot'], to: 0, duration: 400, ease: 'ease-out' } as any] }
	]
});

describe('animation house style', () => {
	it('easings, durations, holds, max-length and fps', async () => {
		const c = new AnimationEditorController({ scene: scene() });
		const styles = resolver('animation-editor', { easings: ['ease-out', 'ease-in-out'], durations: { min: 200, max: 1200 }, minHold: 600, maxLength: 2000, fps: [30, 60], checks: ['easings', 'durations', 'holds', 'max-length', 'fps'] });
		const report = await styles.check('animation-editor', c.getState());
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['easings', { shot: 'intro', command: 0, set: { ease: 'ease-out' } }],
			['durations', { shot: 'intro', command: 0, set: { duration: 1200 } }],
			['holds', { shot: 'intro', set: { hold: 600 } }],
			['max-length', { scene: true }],
			['fps', { scene: true, set: { fps: 30 } }]
		]);
	});

	it('style command colours are the surface for the brand checks', async () => {
		const c = new AnimationEditorController({ scene: scene() });
		expect(animationStyleSurface(c.getState()).colors).toEqual([{ color: '#9933cc', label: 'Shot intro, command 2 fill', target: { shot: 'intro', command: 1 }, use: 'fill' }]);
		const styles = resolver('animation-editor', { checks: ['palette-only'] }, { colors: { primary: '#0b5fff' } });
		expect((await styles.check('animation-editor', c.getState())).findings).toEqual([expect.objectContaining({ check: 'palette-only', target: { shot: 'intro', command: 1 } })]);
	});

	it('check and fix through the tools, one undo step; hidden when read-only', async () => {
		const c = new AnimationEditorController({ scene: scene() });
		const styles = resolver('animation-editor', { easings: ['ease-out'], durations: { max: 1200 }, minHold: 600, fps: [30], maxLength: 2000, checks: ['easings', 'durations', 'holds', 'fps', 'max-length'] });
		const registry = new ToolRegistry();
		registry.register(createAnimationStyleToolProvider(c, styles, { namespace: '' }));
		expect((await registry.callTool('check_animation_style', {})).structuredContent).toMatchObject({ ok: false, fixable: 4 });
		const before = JSON.stringify(c.getScene());
		const fix = await registry.callTool('fix_animation_style', {});
		expect(fix.isError).toBeFalsy();
		expect(fix.structuredContent).toMatchObject({ fixed: 4 });
		const s = c.getScene();
		expect(s.fps).toBe(30);
		expect(s.shots[0]).toMatchObject({ hold: 600, run: [{ duration: 1200, ease: 'ease-out' }, {}] });
		c.undo();
		expect(JSON.stringify(c.getScene())).toBe(before);
		const ro = new AnimationEditorController({ scene: scene(), readOnly: true } as any);
		const roRegistry = new ToolRegistry();
		roRegistry.register(createAnimationStyleToolProvider(ro, styles, { namespace: '' }));
		expect(roRegistry.listTools().tools.map((t) => t.name)).toEqual(['check_animation_style']);
	});
});

describe('video house style', () => {
	const project = () => {
		const p = createVideoProject({ width: 1920, height: 1000, fps: 24 });
		return p;
	};
	const withTitles = (c: VideoEditorController) => {
		c.apply([
			{ op: 'add_track', track: { id: 'titles', kind: 'video', name: 'Titles' } },
			{ op: 'add_clip', track: 'titles', clip: { type: 'text', id: 't1', text: 'Hello world', fontSize: 30, color: '#9933cc', fontFamily: 'Comic Sans MS', duration: 2000 } as any },
			{ op: 'add_clip', track: 'titles', clip: { type: 'text', id: 't2', text: 'Second', fontSize: 72, duration: 2000 } as any },
			{ op: 'set_transition', clip: 't2', transition: { type: 'wipe', duration: 1500 } }
		]);
	};

	it('aspect-ratio, fps, max-length, title-sizes and transitions', async () => {
		const c = new VideoEditorController({ project: project() });
		withTitles(c);
		const styles = resolver('video-editor', { aspectRatios: ['16:9'], fps: [30], maxLength: 3000, titleSizes: { min: 48 }, transitions: ['crossfade'], maxTransition: 500, checks: ['aspect-ratio', 'fps', 'max-length', 'title-sizes', 'transitions'] });
		const report = await styles.check('video-editor', c.getProject());
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['aspect-ratio', { project: true }],
			['fps', { project: true, set: { fps: 30 } }],
			['max-length', { project: true }],
			['title-sizes', { clip: 't1', set: { fontSize: 48 } }],
			['transitions', { clip: 't2', transition: { type: 'crossfade', duration: 500 } }]
		]);
	});

	it('title colours and fonts are the surface for the brand checks', async () => {
		const c = new VideoEditorController({ project: project() });
		withTitles(c);
		const surface = videoStyleSurface(c.getProject());
		expect(surface.colors?.map((x) => x.color)).toEqual(['#9933cc', '#ffffff']);
		expect(surface.fonts?.map((f) => f.family)).toEqual(['Comic Sans MS']);
		const styles = resolver('video-editor', { checks: ['palette-only', 'fonts-allowed'] }, { colors: { primary: '#0b5fff' }, fonts: { body: 'Inter' } });
		expect((await styles.check('video-editor', c.getProject())).findings.map((f) => [f.check, f.target])).toEqual([
			['palette-only', { clip: 't1' }],
			['fonts-allowed', { clip: 't1' }]
		]);
	});

	it('check and fix through the tools, one undo step; hidden when read-only', async () => {
		const c = new VideoEditorController({ project: project() });
		withTitles(c);
		let readOnly: string | false = false;
		const styles = resolver('video-editor', { fps: [30], titleSizes: { min: 48 }, transitions: ['crossfade'], maxTransition: 500, aspectRatios: ['16:9'], checks: ['fps', 'title-sizes', 'transitions', 'aspect-ratio'] });
		const registry = new ToolRegistry();
		registry.register(createVideoStyleToolProvider(c, styles, { namespace: '', readOnly: () => readOnly }));
		const before = JSON.stringify(c.getProject());
		const fix = await registry.callTool('fix_video_style', {});
		expect(fix.structuredContent).toMatchObject({ fixed: 3, left: [expect.objectContaining({ check: 'aspect-ratio' })] });
		const p = c.getProject();
		expect(p.fps).toBe(30);
		const clips = p.tracks.flatMap((t) => t.clips);
		expect(clips.find((x) => x.id === 't1')).toMatchObject({ fontSize: 48 });
		expect(clips.find((x) => x.id === 't2')?.transition).toEqual({ type: 'crossfade', duration: 500 });
		c.undo();
		expect(JSON.stringify(c.getProject())).toBe(before);
		readOnly = 'Delivered.';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_video_style']);
		expect((await registry.callTool('fix_video_style', {})).isError).toBe(true);
	});
});
