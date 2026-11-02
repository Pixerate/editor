import { describe, expect, it } from 'vitest';
import { AnimationEditorController, compileMotionScene, createAnimationEffectsToolProvider, motionShotsFromSequence } from '../src/animation-editor';
import { createVideoEffectsToolProvider, VideoEditorController, videoEditsFromSequence, type VideoProject } from '../src/video-editor';
import { createFakeEffectProvider, effectSequenceTiming, fillEffectTemplate, type EffectProvider, type EffectSequence } from '../src/effects';
import { ToolRegistry } from '../src/tools';

const provider = createFakeEffectProvider({ templates: true });
const data = (r: { structuredContent?: unknown }) => r.structuredContent as any;
const error = (r: { isError?: boolean; content: { type: string; text?: string }[] }) => (expect(r.isError).toBe(true), r.content.map((x) => x.text).join(' '));

describe('fillEffectTemplate', () => {
	it('fills and checks, or refuses with every problem and what to call', async () => {
		const filled = await fillEffectTemplate(provider, 'fake.title-sequence', { title: 'Launch' });
		expect(filled.sequence.shots[0].title).toBe('Launch');
		await expect(fillEffectTemplate(provider, 'fake.title-sequence', { holdMs: 1, nope: 2 })).rejects.toThrow(/holdMs.*out of range.*There is no slot "nope".*describe_template lists what each slot takes\./);
		await expect(fillEffectTemplate(provider, 'nope')).rejects.toMatchObject({ code: 'unknown_template' });
		await expect(fillEffectTemplate(createFakeEffectProvider(), 'fake.title-sequence')).rejects.toThrow('has no sequence templates');
		await expect(fillEffectTemplate(null, 'x')).rejects.toThrow(/No effects provider/);
		// A provider that fills to effects it does not list is refused before anything loads.
		const lying: EffectProvider = { ...provider, instantiateTemplate: async () => ({ ok: true, sequence: { name: 's', stage: { width: 10, height: 10 }, shots: [{ hold: 10, layers: [{ effect: 'fake.ghost' }] }] }, openSlots: [], notes: [] }) };
		await expect(fillEffectTemplate(lying, 'fake.title-sequence')).rejects.toThrow('the provider has no effect "fake.ghost"');
	});

	it('times a sequence: lead-ins are the longer of transition and camera move', () => {
		const seq: EffectSequence = { name: 's', stage: { width: 100, height: 100 }, shots: [{ hold: 1000, layers: [] }, { hold: 500, layers: [], transition: { effect: 't', ms: 300 }, camera: { in: { move: 'm', ms: 600 } } }, { hold: 200, layers: [], transition: { effect: 't' } }] };
		expect(effectSequenceTiming(seq)).toEqual({ starts: [0, 1000, 2100], leadIns: [0, 600, 800], total: 3100 });
	});
});

describe('templates in the animation editor', () => {
	it('replaces the scene with the template, one undo step, timed as the sequence', async () => {
		const c = new AnimationEditorController({ effects: provider, layerHost: null });
		const before = c.getState().scene;
		const r = await c.fillTemplate('fake.title-sequence', { title: 'Hello world', holdMs: 1000 });
		expect(r).toMatchObject({ ok: true, mode: 'replace', shots: ['shot1', 'shot2'], openSlots: [] });
		const scene = c.getState().scene;
		expect(scene.artwork).toMatchObject({ width: 1280, height: 720 });
		expect(scene.shots[0].layers!.map((l) => [l.id, l.effect ?? 'words', l.role])).toEqual([
			['backdrop', 'fake.gradient', 'background'],
			['bar', 'fake.bar', 'overlay'],
			['shot1-title', 'words', 'overlay']
		]);
		expect(scene.shots[1].transition).toEqual({ effect: 'fake.crossfade', ms: 600, provider: 'fake' });
		expect(compileMotionScene(scene).shots.map((s) => [s.start, s.end])).toEqual([
			[0, 1000],
			[1000, 2600]
		]);
		c.undo();
		expect(c.getState().scene).toBe(before);
	});

	it('appends shots scaled to the artwork, with fresh ids, and keeps open slots', async () => {
		const c = new AnimationEditorController({ effects: provider, layerHost: null, scene: { version: 1, name: 'x', artwork: { width: 640, height: 360, nodes: [] }, shots: [{ id: 'shot1', run: [], layers: [{ id: 'logo', subject: { text: 'x' } }] }] } });
		const r = await c.fillTemplate('fake.picture-reveal', {}, { mode: 'append' });
		expect(r).toMatchObject({ ok: true, mode: 'append', shots: ['shot1-2', 'shot2'], openSlots: ['logo'] });
		const logo = c.getState().scene.shots[2].layers!.find((l) => l.subject && 'slot' in l.subject)!;
		expect(logo).toMatchObject({ id: 'logo-2', rect: { x: 520, y: 20, width: 100, height: 56 } });
	});

	it('maps titles into the shot framing and leaves video subjects out with a note', () => {
		const { shots, notes } = motionShotsFromSequence({ name: 's', stage: { width: 200, height: 100 }, shots: [{ hold: 100, title: 'T', camera: { framing: { x: 100, y: 0, width: 100, height: 50 }, during: 'fake.drift' }, layers: [{ subject: { video: 'v.mp4' } }] }] });
		expect(shots[0].camera).toEqual({ x: 100, y: 0, width: 100, height: 50, during: 'fake.drift' });
		expect(shots[0].layers).toEqual([{ id: 'shot1-title', subject: { text: 'T' }, role: 'overlay', rect: { x: 110, y: 19, width: 80, height: 12 } }]);
		expect(notes[0]).toContain('plays a video');
	});
});

describe('templates in the video editor', () => {
	const project = (): VideoProject => ({ version: 1, width: 640, height: 360, fps: 30, assets: [], tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c1', type: 'color', color: '#ff0000', start: 0, duration: 1000 }] }] }) as unknown as VideoProject;

	it('puts the sequence on new tracks at the end, base clips carrying the transitions', async () => {
		const c = new VideoEditorController({ project: project(), effects: provider });
		const r = await c.fillTemplate('fake.title-sequence', { holdMs: 1000 });
		if (!r.ok) throw new Error(r.error);
		expect(r).toMatchObject({ start: 1000, end: 3600, openSlots: [] });
		const p = c.getState().project;
		expect(p.tracks.map((t) => t.id)).toEqual([...r.tracks, 'v1']);
		const clips = p.tracks.flatMap((t) => t.clips.map((cl) => ({ track: t.id, ...cl })));
		const base = clips.filter((cl) => cl.track === r.tracks[r.tracks.length - 1]);
		expect(base.map((cl) => [cl.type, cl.start, cl.duration])).toEqual([
			['effect', 1000, 1000],
			['effect', 2000, 1600]
		]);
		expect(base[1].transition).toMatchObject({ type: 'effect', duration: 600, effect: { effect: 'fake.crossfade', provider: 'fake' } });
		expect(clips.find((cl) => cl.type === 'text' && (cl as { text: string }).text === 'Hello')).toBeTruthy();
		c.undo();
		expect(c.getState().project.tracks.map((t) => t.id)).toEqual(['v1']);
	});

	it('turns pictures into assets with clip effects and open slots into placeholders', () => {
		const seq: EffectSequence = {
			name: 's',
			stage: { width: 1280, height: 720 },
			shots: [{ hold: 1000, layers: [{ effect: 'fake.tint', subject: { image: 'https://x/a.png' }, values: { amount: 0.5 } }, { subject: { slot: 'logo' }, rect: { x: 640, y: 0, width: 640, height: 360 }, role: 'overlay' }] }]
		};
		const made = videoEditsFromSequence(project(), seq, { at: 0, provider: 'fake' });
		expect(made.edits.find((e) => e.op === 'add_asset')).toMatchObject({ asset: { kind: 'image', src: 'https://x/a.png' } });
		const clips = made.edits.filter((e) => e.op === 'add_clip').map((e) => (e as { clip: Record<string, unknown> }).clip);
		expect(clips[0]).toMatchObject({ type: 'media', effects: [{ id: 'fx1', effect: 'fake.tint', provider: 'fake', values: { amount: 0.5 } }] });
		expect(clips[1]).toMatchObject({ type: 'color', name: 'Slot "logo"', transform: { x: 160, y: -90, scale: 0.5 } });
		expect(made.placeholders).toEqual({ logo: [clips[1].id] });
	});
});

describe('template tools', () => {
	const animation = (p: EffectProvider | null = provider, readOnly = false) => {
		const c = new AnimationEditorController({ effects: p, layerHost: null });
		const registry = new ToolRegistry();
		registry.register(createAnimationEffectsToolProvider(c, { namespace: '', readOnly }));
		return { c, registry };
	};

	it('lists, describes and fills, as a model would', async () => {
		const { registry, c } = animation();
		expect(data(await registry.callTool('list_templates', { query: 'title' })).templates.map((t: any) => t.id)).toEqual(['fake.title-sequence']);
		const d = data(await registry.callTool('describe_template', { template: 'fake.title-sequence' }));
		expect(d.exampleValues).toEqual({ title: 'Hello', subtitle: 'See you soon', accent: '#0ea5e9', holdMs: 2000 });
		expect(d.valuesSchema.additionalProperties).toBe(false);
		expect(d.slotSummaries[3]).toContain('holdMs (number)');
		const filled = data(await registry.callTool('fill_template', { template: 'fake.title-sequence', values: { ...d.exampleValues, title: 'Yo' }, name: 'my-intro' }));
		expect(filled).toMatchObject({ template: 'fake.title-sequence', mode: 'replace', shots: ['shot1', 'shot2'] });
		expect(c.getState().scene.name).toBe('my-intro');
	});

	it('refuses bad arguments with every problem and what to call next', async () => {
		const { registry, c } = animation();
		const before = c.getState().scene;
		expect(error(await registry.callTool('fill_template', { template: 'fake.title-sequence', values: { titel: 'x', holdMs: 'long' } }))).toMatch(/There is no slot "titel".*Slot "holdMs" takes a whole number from 500 to 10000.*describe_template/);
		expect(error(await registry.callTool('fill_template', { template: 'nope' }))).toContain('list_templates');
		expect(error(await registry.callTool('fill_template', { template: 'fake.title-sequence', mode: 'merge' }))).toMatch(/mode/);
		expect(error(await registry.callTool('fill_template', { template: 'fake.title-sequence', name: 'Bad Name' }))).toMatch(/name/);
		expect(error(await registry.callTool('describe_template', {}))).toMatch(/template/);
		expect(c.getState().scene).toBe(before);
		expect(data(await animation(createFakeEffectProvider()).registry.callTool('list_templates', {}))).toMatchObject({ available: false, reason: expect.stringContaining('has no sequence templates') });
		expect(error(await animation(null).registry.callTool('fill_template', { template: 'x' }))).toMatch(/No effects provider/);
	});

	it('hides fill_template on a read-only surface; the video editor has the same tools', async () => {
		const names = animation(provider, true).registry.listTools().tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(['list_templates', 'describe_template']));
		expect(names).not.toContain('fill_template');
		const registry = new ToolRegistry();
		const v = new VideoEditorController({ effects: provider });
		registry.register(createVideoEffectsToolProvider(v, { namespace: '' }));
		const r = data(await registry.callTool('fill_template', { template: 'fake.picture-reveal', at: 500 }));
		expect(r).toMatchObject({ start: 500, openSlots: ['logo'], placeholders: { logo: [expect.any(String)] } });
		expect(error(await registry.callTool('fill_template', { template: 'fake.picture-reveal', at: -1 }))).toMatch(/at/);
	});
});
