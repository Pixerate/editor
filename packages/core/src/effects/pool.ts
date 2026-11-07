/**
 * `EffectRendererPool`: keeps a few live renderers, reused per effect, size and depth.
 *
 * GPU providers hold one graphics context per renderer, and browsers allow only about sixteen
 * WebGL contexts at a time (the oldest is lost after that). So the pool keeps at most
 * `maxRenderers` renderers. It disposes the least recently used one once its renders finish, and it
 * runs one render at a time per renderer, as the contract requires.
 */

import type { EffectPixels, EffectProvider, EffectRenderer, EffectRenderRequest } from './types.js';

interface PoolEntry {
	renderer: Promise<EffectRenderer>;
	resolved?: EffectRenderer;
	busy: number;
	/** The last render queued on it. */
	queue: Promise<unknown>;
}

export interface EffectRendererPoolOptions {
	/** Most live renderers (default 4). */
	maxRenderers?: number;
}

export class EffectRendererPool {
	private readonly entries = new Map<string, PoolEntry>();
	private readonly maxRenderers: number;

	constructor(options: EffectRendererPoolOptions = {}) {
		this.maxRenderers = Math.max(1, options.maxRenderers ?? 4);
	}

	/** Live renderers now. */
	get size(): number {
		return this.entries.size;
	}

	/** Whether a warm renderer is ready for this provider, effect, size and depth. */
	hasResolved(providerId: string, id: string, size: { width: number; height: number; depth?: 8 | 16 | 32 }): boolean {
		const depth = size.depth ?? 8;
		return Boolean(this.entries.get(`${providerId}:${id}@${size.width}x${size.height}x${depth}`)?.resolved);
	}

	/** Renders `request` synchronously when a warm renderer is idle and finishes immediately (`createFakeEffectProvider`). */
	renderSync(provider: EffectProvider, id: string, size: { width: number; height: number; depth?: 8 | 16 | 32 }, request: EffectRenderRequest): EffectPixels | null {
		const depth = size.depth ?? 8;
		const key = `${provider.id}:${id}@${size.width}x${size.height}x${depth}`;
		const entry = this.entries.get(key);
		if (!entry?.resolved || entry.busy > 0) return null;
		this.entries.delete(key);
		this.entries.set(key, entry);
		const p = entry.resolved.render(request) as Promise<EffectPixels> & { value?: EffectPixels };
		if (p && typeof p === 'object' && 'value' in p && p.value) {
			entry.queue = p.catch(() => undefined);
			return p.value;
		}
		entry.busy++;
		const tracked = p.finally(() => {
			entry.busy--;
		});
		entry.queue = tracked.catch(() => undefined);
		return null;
	}

	/** Renders `request` with the provider's renderer for this effect, size and depth (made on first use). */
	render(provider: EffectProvider, id: string, size: { width: number; height: number; depth?: 8 | 16 | 32 }, request: EffectRenderRequest): Promise<EffectPixels> {
		const depth = size.depth ?? 8;
		const key = `${provider.id}:${id}@${size.width}x${size.height}x${depth}`;
		let entry = this.entries.get(key);
		if (entry) {
			this.entries.delete(key);
			this.entries.set(key, entry);
		} else {
			const renderer = Promise.resolve().then(() => provider.createRenderer(id, { width: size.width, height: size.height, depth }));
			const created: PoolEntry = { renderer, busy: 0, queue: Promise.resolve() };
			renderer.then(
				(r) => {
					created.resolved = r;
				},
				() => {
					if (this.entries.get(key)?.renderer === renderer) this.entries.delete(key);
				}
			);
			entry = created;
			this.entries.set(key, entry);
			this.evict();
		}
		const e = entry;
		e.busy++;
		const next = e.queue
			.then(() => e.renderer)
			.then((r) => r.render(request))
			.finally(() => {
				e.busy--;
			});
		e.queue = next.catch(() => undefined);
		return next;
	}

	/** Disposes the least recently used renderers over the limit, after their queued renders. */
	private evict(): void {
		while (this.entries.size > this.maxRenderers) {
			const [key, entry] = this.entries.entries().next().value!;
			this.entries.delete(key);
			dispose(entry);
		}
	}

	/** Disposes every renderer (after its queued renders). */
	clear(): void {
		for (const entry of this.entries.values()) dispose(entry);
		this.entries.clear();
	}
}

function dispose(entry: PoolEntry) {
	entry.queue
		.then(() => entry.renderer)
		.then(
			(r) => r.dispose(),
			() => {}
		);
}
