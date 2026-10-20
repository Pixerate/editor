import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { createFakeEffectProvider } from '../src/effects';
import { VideoEditorController, createVideoEffectsToolProvider, parseVideoProject } from '../src/video-editor';

const project = () =>
	parseVideoProject({
		version: 1,
		width: 4,
		height: 2,
		fps: 10,
		assets: [],
		tracks: [
			{
				id: 'v1',
				kind: 'video',
				clips: [
					{ id: 'a', type: 'color', color: '#000000', start: 0, duration: 1000 },
					{ id: 'b', type: 'color', color: '#ffffff', start: 1000, duration: 1000 }
				]
			}
		]
	});

const setup = (options: { provider?: boolean; readOnly?: boolean } = {}) => {
	const controller = new VideoEditorController({ project: project(), effects: options.provider === false ? null : createFakeEffectProvider(), readOnly: options.readOnly });
	const registry = new ToolRegistry();
	registry.register(createVideoEffectsToolProvider(controller));
	const call = async (name: string, args: Record<string, unknown> = {}) => registry.callTool(name, args);
	return { controller, registry, call };
};
const ok = (r: Awaited<ReturnType<ToolRegistry['callTool']>>) => {
	if (r.isError) throw new Error((r.content[0] as { text: string }).text);
	return r.structuredContent as any;
};
const text = (r: Awaited<ReturnType<ToolRegistry['callTool']>>) => (r.content[0] as { text: string }).text;

describe('video effect tools', () => {
	it('lists every tool with a provider, and only read tools on a read-only project', () => {
		expect(setup().registry.listTools().tools.map((t) => t.name)).toEqual([
			'search_effects',
			'describe_effect',
			'list_applied_effects',
			'apply_effect',
			'update_effect',
			'remove_effect',
			'add_video_effect_clip',
			'set_video_effect_transition',
			'set_video_effect_keyframes'
		]);
		expect(setup({ readOnly: true }).registry.listTools().tools.map((t) => t.name)).toEqual(['search_effects', 'describe_effect', 'list_applied_effects']);
	});

	it('lists catalog ids in the effect argument once the catalog is in', async () => {
		const { registry } = setup();
		registry.listTools();
		await new Promise((r) => setTimeout(r, 0));
		const apply = registry.listTools().tools.find((t) => t.name === 'apply_effect')!;
		expect((apply.inputSchema.properties!.effect as { enum: string[] }).enum).toEqual(['fake.invert', 'fake.tint', 'fake.bar']);
	});

	it('searches and describes', async () => {
		const { call } = setup();
		const found = ok(await call('search_effects', { use: 'filter' }));
		expect(found.effects.map((e: { id: string }) => e.id)).toEqual(['fake.invert', 'fake.tint']);
		expect(found.provider.id).toBe('fake');
		const d = ok(await call('describe_effect', { effect: 'fake.tint' }));
		expect(d).toMatchObject({ id: 'fake.tint', appliesHere: true, defaults: { color: '#ff8800', amount: 0.5 } });
		expect(d.controls.additionalProperties).toBe(false);
		const bad = await call('describe_effect', { effect: 'nope' });
		expect(bad.isError).toBe(true);
		expect(text(bad)).toMatch(/Unknown effect "nope".*search_effects/);
		expect((await call('search_effects', { use: 'sideways' })).isError).toBe(true);
	});

	it('applies, updates, keyframes and removes clip effects, one undo step each, returning what changed', async () => {
		const { call, controller } = setup();
		const applied = ok(await call('apply_effect', { target: 'a', effect: 'fake.tint', values: { amount: 0.2 } }));
		expect(applied.effect).toMatchObject({ id: 'fx1', effect: 'fake.tint', role: 'clip effect', values: { amount: 0.2, color: '#ff8800' }, index: 0 });
		expect(controller.history.getState().undoName).toBe('Add effect Tint');
		const updated = ok(await call('update_effect', { target: 'a', effect: 'fx1', values: { amount: null, color: '#00ff00' }, enabled: false }));
		expect(updated.effect).toMatchObject({ enabled: false, values: { amount: 0.5, color: '#00ff00' } });
		const keyed = ok(await call('set_video_effect_keyframes', { clip: 'a', effect: 'fx1', control: 'amount', keys: [{ t: 0, v: 0 }, { t: 900, v: 1, ease: 'ease-out' }] }));
		expect(keyed.effect.values.amount.keys).toHaveLength(2);
		const listed = ok(await call('list_applied_effects', {}));
		expect(listed.targets).toEqual([{ target: 'a', effects: [expect.objectContaining({ id: 'fx1', available: true })] }]);
		const removed = ok(await call('remove_effect', { target: 'a', effect: 'fx1' }));
		expect(removed).toMatchObject({ effect: { id: 'fx1' }, effects: [] });
		expect(controller.history.getState().undoName).toBe('Remove effect Tint');
	});

	it('refuses bad arguments with what to do, changing nothing', async () => {
		const { call, controller } = setup();
		const bad = await call('apply_effect', { target: 'a', effect: 'fake.tint', values: { amount: 2, glow: 1 } });
		expect(bad.isError).toBe(true);
		expect(text(bad)).toMatch(/\/amount/);
		expect(text(bad)).toMatch(/glow/);
		expect(text(await call('apply_effect', { target: 'zz', effect: 'fake.tint' }))).toMatch(/no clip "zz".*"a", "b"/);
		// The schema lists the effects that fit once the catalog is in; the controller explains the rest.
		expect(text(await call('apply_effect', { target: 'a', effect: 'fake.crossfade' }))).toMatch(/Expected one of "fake.invert", "fake.tint", "fake.bar"/);
		expect((await controller.applyClipEffect('a', 'fake.crossfade')) as { error: string }).toMatchObject({ error: expect.stringMatching(/set_video_effect_transition/) });
		expect(text(await call('update_effect', { target: 'a', effect: 'fx1' }))).toMatch(/at least one of values/);
		expect(text(await call('remove_effect', { target: 'a', effect: 'fx1' }))).toMatch(/no effect "fx1"/);
		expect(controller.history.getState().canUndo).toBe(false);
	});

	it('adds effect clips and effect transitions and edits them through update_effect', async () => {
		const { call, controller } = setup();
		const clip = ok(await call('add_video_effect_clip', { track: 'v1', effect: 'fake.gradient', start: 2000, duration: 500, values: { angle: 0 } }));
		expect(clip).toMatchObject({ clip: 'c1', effects: [{ id: 'generator', role: 'effect clip', effect: 'fake.gradient' }] });
		ok(await call('update_effect', { target: 'c1', effect: 'generator', values: { spin: 90 } }));
		expect((controller.getProject().tracks[0].clips[2] as { values: object }).values).toMatchObject({ angle: 0, spin: 90 });
		expect(text(await call('update_effect', { target: 'c1', effect: 'generator', enabled: false }))).toMatch(/only takes values/);
		expect(text(await call('remove_effect', { target: 'c1', effect: 'generator' }))).toMatch(/delete_video_clips/);
		const t = ok(await call('set_video_effect_transition', { clip: 'b', effect: 'fake.crossfade', duration: 400 }));
		expect(t.transition).toMatchObject({ type: 'effect', duration: 400, effect: { effect: 'fake.crossfade' } });
		ok(await call('update_effect', { target: 'b', effect: 'transition', values: { curve: 'linear' } }));
		ok(await call('remove_effect', { target: 'b', effect: 'transition' }));
		expect(controller.getProject().tracks[0].clips[1].transition).toBeUndefined();
	});

	it('without a provider: read tools say so, list still works, write tools refuse with the reason', async () => {
		const { call, controller } = setup({ provider: false });
		controller.apply({ op: 'update_clip', clip: 'a', set: { effects: [{ id: 'fx1', effect: 'fake.tint', name: 'Tint' }] } });
		expect(ok(await call('search_effects', {}))).toMatchObject({ available: false, reason: expect.stringMatching(/No effects provider/) });
		expect(ok(await call('describe_effect', { effect: 'fake.tint' }))).toMatchObject({ available: false });
		expect(ok(await call('list_applied_effects', {})).targets[0].effects[0]).toMatchObject({ id: 'fx1', available: false });
		for (const [name, args] of [
			['apply_effect', { target: 'a', effect: 'fake.tint' }],
			['update_effect', { target: 'a', effect: 'fx1', enabled: false }],
			['remove_effect', { target: 'a', effect: 'fx1' }],
			['add_video_effect_clip', { track: 'v1', effect: 'fake.gradient' }],
			['set_video_effect_transition', { clip: 'b', effect: 'fake.crossfade' }],
			['set_video_effect_keyframes', { clip: 'a', effect: 'fx1', control: 'amount', keys: null }]
		] as const) {
			const r = await call(name, args);
			expect(r.isError, name).toBe(true);
			expect(text(r), name).toMatch(/No effects provider is registered/);
		}
	});
});
