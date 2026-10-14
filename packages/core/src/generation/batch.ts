export interface BatchResolverOptions<K, V> {
	/** Loads many keys at once. Keys missing from the map resolve to `undefined`. */
	fetch: (keys: K[]) => Promise<Map<K, V>>;
	/** Largest batch passed to `fetch` (default 50). */
	maxBatch?: number;
	/** How long to collect keys before fetching, in ms (default 0: the same tick). */
	delayMs?: number;
	/** Called once per failed batch. The batch's keys are recorded as resolved-empty. */
	onError?: (error: unknown, keys: K[]) => void;
}

export interface BatchResolver<K, V> {
	/** Resolves one key, batched with other loads in the same window. Never rejects. */
	load(key: K): Promise<V | undefined>;
	loadMany(keys: readonly K[]): Promise<(V | undefined)[]>;
	/** The settled value for a key, if it has been resolved. */
	peek(key: K): V | undefined;
	/** Whether a key has settled (found, missing or failed). */
	has(key: K): boolean;
	/** Whether a key's last fetch failed. */
	failed(key: K): boolean;
	/** Seeds a value without fetching. */
	prime(key: K, value: V): void;
	/** Forgets one key (or all) so the next `load` fetches again. */
	clear(key?: K): void;
	/** Fetches anything still waiting now, without waiting for `delayMs`. */
	flush(): void;
}

interface Pending<V> {
	promise: Promise<V | undefined>;
	resolve: (value: V | undefined) => void;
}

/**
 * Coalesces lookups (e.g. asset ids → thumbnails, template ids → bodies) into
 * batched `fetch` calls: keys requested within `delayMs` share a batch of at
 * most `maxBatch`, duplicate keys are fetched once, and results are cached.
 * A failed batch resolves its keys to `undefined` and records them as
 * resolved-empty (`failed(key)` is `true`) so one bad response does not cause
 * a retry storm; `clear(key)` allows a retry.
 */
export function createBatchResolver<K, V>(options: BatchResolverOptions<K, V>): BatchResolver<K, V> {
	const maxBatch = Math.max(1, Math.floor(options.maxBatch ?? 50));
	const delayMs = Math.max(0, options.delayMs ?? 0);
	const settled = new Map<K, V | undefined>();
	const failures = new Set<K>();
	const inFlight = new Map<K, Pending<V>>();
	let queue: K[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;

	const run = (keys: K[]) => {
		const pendings = keys.map((key) => inFlight.get(key));
		const finish = (values: Map<K, V> | null, error?: unknown) => {
			if (values === null) options.onError?.(error, keys);
			keys.forEach((key, index) => {
				const pending = pendings[index];
				const value = values?.get(key);
				// Only cache if nobody cleared the key while the batch was in flight.
				if (pending && inFlight.get(key) === pending) {
					inFlight.delete(key);
					settled.set(key, value);
					if (values === null) failures.add(key);
				}
				pending?.resolve(value);
			});
		};
		let promise: Promise<Map<K, V>>;
		try {
			promise = Promise.resolve(options.fetch(keys));
		} catch (error) {
			promise = Promise.reject(error);
		}
		promise.then(
			(values) => finish(values instanceof Map ? values : new Map()),
			(error) => finish(null, error ?? new Error('Batch fetch failed.'))
		);
	};

	const flush = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		const keys = queue;
		queue = [];
		for (let i = 0; i < keys.length; i += maxBatch) run(keys.slice(i, i + maxBatch));
	};

	const load = (key: K): Promise<V | undefined> => {
		if (settled.has(key)) return Promise.resolve(settled.get(key));
		const existing = inFlight.get(key);
		if (existing) return existing.promise;
		let resolve!: (value: V | undefined) => void;
		const promise = new Promise<V | undefined>((r) => (resolve = r));
		inFlight.set(key, { promise, resolve });
		queue.push(key);
		if (queue.length >= maxBatch) flush();
		else if (timer === null) timer = setTimeout(flush, delayMs);
		return promise;
	};

	return {
		load,
		loadMany: (keys) => Promise.all(keys.map(load)),
		peek: (key) => settled.get(key),
		has: (key) => settled.has(key),
		failed: (key) => failures.has(key),
		prime(key, value) {
			settled.set(key, value);
			failures.delete(key);
		},
		clear(key) {
			if (key === undefined) {
				settled.clear();
				failures.clear();
				// Loads already fetching still resolve, but their results are not cached.
				for (const k of [...inFlight.keys()]) if (!queue.includes(k)) inFlight.delete(k);
				return;
			}
			settled.delete(key);
			failures.delete(key);
			if (!queue.includes(key)) inFlight.delete(key);
		},
		flush
	};
}
