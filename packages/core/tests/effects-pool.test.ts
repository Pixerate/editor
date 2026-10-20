import { describe, expect, it, vi } from 'vitest';
import { EffectRendererPool, createEffectPixels, createFakeEffectProvider, renderEffectThumbnail, type EffectRenderer } from '../src/effects';

describe('EffectRendererPool', () => {
	it('reuses renderers, keeps at most maxRenderers, and disposes evicted ones after their renders', async () => {
		const provider = createFakeEffectProvider();
		const made: EffectRenderer[] = [];
		const create = provider.createRenderer.bind(provider);
		provider.createRenderer = (id, o) => {
			const r = create(id, o) as EffectRenderer;
			const dispose = vi.fn(r.dispose);
			const wrapped = { ...r, render: r.render, dispose };
			made.push(wrapped);
			return wrapped;
		};
		const pool = new EffectRendererPool({ maxRenderers: 2 });
		const size = { width: 1, height: 1 };
		await pool.render(provider, 'fake.gradient', size, { time: 0 });
		await pool.render(provider, 'fake.gradient', size, { time: 10 });
		expect(made).toHaveLength(1);
		await pool.render(provider, 'fake.bar', size, { time: 0 });
		const third = pool.render(provider, 'fake.gradient', { width: 2, height: 1 }, { time: 0 });
		expect(pool.size).toBe(2);
		await third;
		await new Promise((r) => setTimeout(r, 0));
		expect(made[0].dispose).toHaveBeenCalled();
		expect(made[1].dispose).not.toHaveBeenCalled();
		pool.clear();
		await new Promise((r) => setTimeout(r, 0));
		expect(made.every((r) => (r.dispose as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
	});

	it('renders thumbnails one at a time and caches them per provider', async () => {
		const provider = createFakeEffectProvider();
		let live = 0;
		let most = 0;
		const create = provider.createRenderer.bind(provider);
		provider.createRenderer = async (id, o) => {
			const r = (await create(id, o)) as EffectRenderer;
			live++;
			most = Math.max(most, live);
			return { ...r, render: async (q) => (await new Promise((x) => setTimeout(x, 1)), r.render(q)), dispose: () => (live--, r.dispose()) };
		};
		const list = await provider.list();
		const pictures = await Promise.all(list.filter((e) => e.kind === 'shader').map((e) => renderEffectThumbnail(provider, e, { width: 4, height: 2 })));
		expect(pictures.every((p) => p.width === 4)).toBe(true);
		expect(most).toBe(1);
		const again = await renderEffectThumbnail(provider, list[0], { width: 4, height: 2 });
		expect(again).toBe(pictures[0]);
		expect(createEffectPixels(1, 1).data.length).toBe(4);
	});
});
