import { describe, expect, it } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { AnimationEditorController, createAnimationEffectsToolProvider, parseMotionScene, toFlairSvgMotion, type MotionScene } from '../src/animation-editor';
import { ToolRegistry } from '../src/tools';
import { ManualClock } from '../src/animation';
import { ellipseSubpath, rectSubpath, type VectorDocument } from '../src/vector';
import { baseToolName } from '../src/tools';

const ARTWORK: VectorDocument = {
	width: 400,
	height: 200,
	background: '#ffffff',
	nodes: [
		{ id: 'box', type: 'path', name: 'Box', fill: '#ef4444', subpaths: [rectSubpath({ x: 20, y: 20, width: 60, height: 60 })] },
		{ id: 'dot', type: 'path', fill: '#0ea5e9', subpaths: [ellipseSubpath({ x: 300, y: 120, width: 40, height: 40 })] }
	]
};
const scene = (): MotionScene => ({ version: 1, name: 'test', artwork: ARTWORK, shots: [{ id: 'intro', run: [{ type: 'move', targets: ['box'], by: { x: 10, y: 0 } }] }] });
const editor = (effects = createFakeEffectProvider() as ReturnType<typeof createFakeEffectProvider> | null) => new AnimationEditorController({ scene: scene(), clock: new ManualClock(), effects });

describe('animation editor: provider motion effects', () => {
	it('applies a motion effect to nodes as tagged commands in a new shot, one undo step', async () => {
		const c = editor();
		const r = await c.applyMotionEffect('fake.fade-in', ['box', 'dot'], { values: { ms: 300, stagger: 100 } });
		expect(r).toMatchObject({ ok: true, effect: { instance: 'fx1', effect: 'fake.fade-in', kind: 'motion', targets: ['box', 'dot'], shots: ['fx1'], values: { ms: 300, stagger: 100 } } });
		const shot = c.getScene().shots[1];
		expect(shot).toMatchObject({ id: 'fx1', label: 'Fade in' });
		expect(shot.run.map((x) => [x.type, 'targets' in x ? x.targets : null, (x as { duration?: number }).duration])).toEqual([
			['enter', ['box'], 300],
			['enter', ['dot'], 300]
		]);
		expect(shot.run.every((x) => (x as { source?: { instance: string } }).source?.instance === 'fx1')).toBe(true);
		expect(c.history.getState().undoName).toBe('Apply Fade in');
		// The commands play like any others, and export to Flair.
		expect(c.getState().duration).toBeGreaterThan(400);
		expect(toFlairSvgMotion(c.getScene()).motion.animate!.some((a) => a.id === 'dot' && a.attrs?.opacity)).toBe(true);
		// Saved and loaded: the tag survives.
		expect(parseMotionScene(JSON.parse(JSON.stringify(c.getScene())))).toEqual(c.getScene());
		c.undo();
		expect(c.getScene().shots).toHaveLength(1);
	});

	it('adds into an existing shot, updates in place and removes', async () => {
		const c = editor();
		await c.applyMotionEffect('fake.fade-in', ['dot'], { shot: 'intro' });
		expect(c.getScene().shots[0].run.map((x) => x.type)).toEqual(['move', 'enter']);
		const u = await c.updateMotionEffect('fx1', { ms: 900 });
		expect(u.ok && u.effect.values).toEqual({ ms: 900, stagger: 0 });
		expect((c.getScene().shots[0].run[1] as { duration: number }).duration).toBe(900);
		const reset = await c.updateMotionEffect('fx1', { ms: null });
		expect(reset.ok && reset.effect.values.ms).toBe(600);
		const removed = c.removeMotionEffect('fx1');
		expect(removed.ok).toBe(true);
		expect(c.getScene().shots[0].run.map((x) => x.type)).toEqual(['move']);
	});

	it('adds a vector effect as an artwork group with its own shots, and removes both', async () => {
		const c = editor();
		const r = await c.addVectorEffect('fake.badge', { values: { color: '#00ff00' }, box: { x: 0, y: 0, width: 100, height: 100 } });
		expect(r).toMatchObject({ ok: true, effect: { instance: 'fx1', kind: 'vector', group: 'fx1', targets: ['fx1'] } });
		const group = c.getScene().artwork.nodes.find((n) => n.id === 'fx1');
		expect(group).toMatchObject({ type: 'group', name: 'Badge', children: [{ id: 'fx1-badge', fill: '#00ff00' }] });
		expect(c.getScene().shots.at(-1)?.run[0]).toMatchObject({ type: 'enter', targets: ['fx1-badge'] });
		const u = await c.updateMotionEffect('fx1', { color: '#0000ff' });
		expect(u.ok).toBe(true);
		expect((c.getScene().artwork.nodes.find((n) => n.id === 'fx1') as { children: { fill: string }[] }).children[0].fill).toBe('#0000ff');
		c.removeMotionEffect('fx1');
		expect(c.getScene().artwork.nodes.map((n) => n.id)).toEqual(['box', 'dot']);
		expect(c.getScene().shots.map((s) => s.id)).toEqual(['intro']);
	});

	it('refuses wrong kinds, unknown nodes and bad values, changing nothing', async () => {
		const c = editor();
		expect(await c.applyMotionEffect('fake.tint', ['box'])).toMatchObject({ ok: false, error: expect.stringMatching(/shader effect/) });
		expect(await c.applyMotionEffect('fake.badge', ['box'])).toMatchObject({ ok: false, error: expect.stringMatching(/add_vector_effect/) });
		expect(await c.addVectorEffect('fake.fade-in')).toMatchObject({ ok: false, error: expect.stringMatching(/apply_effect/) });
		expect(await c.applyMotionEffect('fake.fade-in', ['nope'])).toMatchObject({ ok: false, error: expect.stringMatching(/no node "nope"/) });
		expect(await c.applyMotionEffect('fake.fade-in', ['box'], { values: { ms: -5 } })).toMatchObject({ ok: false, error: expect.stringMatching(/ms/) });
		expect(c.history.getState().canUndo).toBe(false);
	});

	it('without a provider behaves as before and keeps effect commands', async () => {
		const c = editor();
		await c.applyMotionEffect('fake.fade-in', ['box']);
		const saved = JSON.parse(JSON.stringify(c.getScene()));
		const plain = editor(null);
		expect(plain.getState().effectsProvider).toBeNull();
		expect(await plain.applyMotionEffect('fake.fade-in', ['box'])).toMatchObject({ ok: false, error: expect.stringMatching(/No effects provider/) });
		plain.load(saved, { clearHistory: true });
		expect(plain.appliedEffects().map((e) => e.instance)).toEqual(['fx1']);
		expect(plain.removeMotionEffect('fx1').ok).toBe(true);
		const before = editor(null);
		expect(before.getState().duration).toBe(new AnimationEditorController({ scene: scene(), clock: new ManualClock() }).getState().duration);
	});
});

describe('animation editor: provider effect tools', () => {
	const tools = (c = editor()) => {
		const registry = new ToolRegistry();
		registry.register(createAnimationEffectsToolProvider(c));
		return { c, registry };
	};
	const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

	it('lists its tools; read-only hides the writes', () => {
		expect(tools().registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['search_effects', 'describe_effect', 'list_applied_effects', 'apply_effect', 'update_effect', 'remove_effect', 'add_vector_effect']);
		const r = new ToolRegistry();
		r.register(createAnimationEffectsToolProvider(editor(), { readOnly: true }));
		expect(r.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['search_effects', 'describe_effect', 'list_applied_effects']);
	});

	it('applies, updates, lists and removes through the registry', async () => {
		const { c, registry } = tools();
		const d = await registry.callTool('describe_effect', { effect: 'fake.fade-in' });
		expect((d.structuredContent as any).appliesHere).toBe(true);
		const a = await registry.callTool('apply_effect', { target: 'dot', effect: 'fake.fade-in', values: { ms: 200 } });
		expect(a.isError).toBeFalsy();
		expect((a.structuredContent as any).effect).toMatchObject({ id: 'fx1', role: 'motion', values: { ms: 200 } });
		const u = await registry.callTool('update_effect', { target: 'dot', effect: 'fx1', values: { ms: 400 } });
		expect((u.structuredContent as any).effect.values.ms).toBe(400);
		expect(text(await registry.callTool('update_effect', { target: 'dot', effect: 'fx1', opacity: 0.5 }))).toMatch(/only takes values/);
		const v = await registry.callTool('add_vector_effect', { effect: 'fake.badge', box: { x: 0, y: 0, width: 50, height: 50 } });
		expect(v.structuredContent).toMatchObject({ instance: 'fx2', group: 'fx2' });
		const listed = (await registry.callTool('list_applied_effects', {})).structuredContent as any;
		expect(listed.targets.map((t: { target: string }) => t.target)).toEqual(['dot', 'fx2']);
		expect((await registry.callTool('remove_effect', { target: 'dot', effect: 'fx1' })).isError).toBeFalsy();
		expect(c.appliedEffects().map((e) => e.instance)).toEqual(['fx2']);
		expect(text(await registry.callTool('apply_effect', { target: 'dot', effect: 'fake.badge' }))).toMatch(/Expected one of|add_vector_effect/);
	});

	it('without a provider: reads say so, writes refuse', async () => {
		const { registry } = tools(editor(null));
		expect((await registry.callTool('search_effects', {})).structuredContent).toMatchObject({ available: false });
		const r = await registry.callTool('add_vector_effect', { effect: 'fake.badge' });
		expect(r.isError).toBe(true);
		expect(text(r)).toMatch(/No effects provider/);
	});
});
