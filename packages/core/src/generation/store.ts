// Type-only: the store works with any `StorageAdapter` from
// `@pixerate/editor/persistence` (memory, localStorage, IndexedDB, OPFS)
// without bundling the persistence module into this entry.
import type { StorageAdapter } from '../persistence/storage.js';
import type { ReferenceRole } from './capabilities.js';
import {
	parseGenerationRecord,
	serializeGenerationRecord,
	type GenerationRecord,
	type GenerationRecordKind
} from './record.js';

/** What the store indexes per record (kept in one index entry, so lists need no record reads). */
export interface GenerationRecordSummary {
	id: string;
	modelId: string;
	kind: GenerationRecordKind;
	parentId?: string;
	createdAt: string;
	/** Template names and ids used. */
	templates: string[];
	templateIds: string[];
	/** Asset ids and roles used. */
	assets: string[];
	roles: ReferenceRole[];
	/** First 160 characters of the resolved prompt, for lists. */
	preview: string;
}

export interface GenerationRecordFilter {
	/** Model id(s). */
	model?: string | readonly string[];
	/** Template name or id. */
	template?: string;
	/** Asset id. */
	asset?: string;
	role?: ReferenceRole;
	kind?: GenerationRecordKind;
	parentId?: string;
	/** Created at or after / before (exclusive). */
	since?: Date | number | string;
	until?: Date | number | string;
	/** Case-insensitive text in the prompt preview. */
	text?: string;
	offset?: number;
	limit?: number;
}

export interface PruneOptions {
	/** Keep at most this many records (newest first). */
	maxRecords?: number;
	/** Remove records created before this time. */
	olderThan?: Date | number | string;
	/** Records for which this returns `true` are never removed (they still count toward `maxRecords`). */
	keep?: (summary: GenerationRecordSummary) => boolean;
}

export interface GenerationRecordStoreOptions {
	storage: Pick<StorageAdapter, 'get' | 'set' | 'remove'>;
	/** Key prefix (default `pixerate.generation-records`). */
	namespace?: string;
	/** Prune to this many records after every `put`. */
	maxRecords?: number;
}

export interface GenerationRecordStore {
	/** Adds or replaces a record. */
	put(record: GenerationRecord): Promise<void>;
	get(id: string): Promise<GenerationRecord | null>;
	/** Records matching `filter`, newest first. Unreadable records are skipped. */
	list(filter?: GenerationRecordFilter): Promise<GenerationRecord[]>;
	/** Index entries matching `filter`, newest first (no record reads). */
	summaries(filter?: GenerationRecordFilter): Promise<GenerationRecordSummary[]>;
	remove(id: string): Promise<boolean>;
	/** Removes records by count and age; returns the removed ids. */
	prune(options: PruneOptions): Promise<string[]>;
	clear(): Promise<void>;
	/** Called after every change. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

const INDEX_VERSION = 1;
const time = (value: Date | number | string) => new Date(value).getTime();

/** The index entry for a record. */
export function summarizeGenerationRecord(record: GenerationRecord): GenerationRecordSummary {
	const unique = <T>(values: T[]) => [...new Set(values)];
	return {
		id: record.id,
		modelId: record.provenance.modelId,
		kind: record.kind,
		...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
		createdAt: record.createdAt,
		templates: unique(record.templates.map((t) => t.name)),
		templateIds: unique(record.templates.flatMap((t) => (t.templateId !== undefined ? [t.templateId] : []))),
		assets: unique(record.assets.map((a) => a.id)),
		roles: unique(record.assets.map((a) => a.role)),
		preview: record.provenance.resolvedPrompt.slice(0, 160)
	};
}

/** True when `summary` matches every condition of `filter` (ignores `offset` / `limit`). */
export function matchesRecordFilter(summary: GenerationRecordSummary, filter: GenerationRecordFilter = {}): boolean {
	if (filter.model !== undefined) {
		const models = typeof filter.model === 'string' ? [filter.model] : filter.model;
		if (!models.includes(summary.modelId)) return false;
	}
	if (filter.template !== undefined && !summary.templates.includes(filter.template) && !summary.templateIds.includes(filter.template)) {
		return false;
	}
	if (filter.asset !== undefined && !summary.assets.includes(filter.asset)) return false;
	if (filter.role !== undefined && !summary.roles.includes(filter.role)) return false;
	if (filter.kind !== undefined && summary.kind !== filter.kind) return false;
	if (filter.parentId !== undefined && summary.parentId !== filter.parentId) return false;
	const created = time(summary.createdAt);
	if (filter.since !== undefined && created < time(filter.since)) return false;
	if (filter.until !== undefined && created >= time(filter.until)) return false;
	if (filter.text !== undefined && !summary.preview.toLowerCase().includes(filter.text.toLowerCase())) return false;
	return true;
}

const newestFirst = (a: GenerationRecordSummary, b: GenerationRecordSummary) =>
	time(b.createdAt) - time(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Persists generation records on a key/value `StorageAdapter`
 * (`createMemoryStorage`, `createLocalStorageAdapter`, `createIndexedDbAdapter`,
 * `createOpfsAdapter`). Each record is stored under its own key and a single
 * index entry holds the summaries used for listing and filtering. Operations
 * run one at a time, so concurrent `put`s do not lose index entries. The index
 * is cached after the first read: use one store per storage namespace.
 */
export function createGenerationRecordStore(options: GenerationRecordStoreOptions): GenerationRecordStore {
	const storage = options.storage;
	const ns = options.namespace ?? 'pixerate.generation-records';
	const indexKey = `${ns}:index`;
	const recordKey = (id: string) => `${ns}:record:${id}`;
	const listeners = new Set<() => void>();
	let index: GenerationRecordSummary[] | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	const run = <T>(task: () => Promise<T>): Promise<T> => {
		const result = queue.then(task, task);
		queue = result.catch(() => undefined);
		return result;
	};
	const notify = () => listeners.forEach((listener) => listener());

	const loadIndex = async (): Promise<GenerationRecordSummary[]> => {
		if (index) return index;
		const raw = await storage.get(indexKey);
		let items: GenerationRecordSummary[] = [];
		if (raw) {
			try {
				const data = JSON.parse(raw);
				if (data && Array.isArray(data.items)) {
					items = data.items.filter((item: any) => item && typeof item.id === 'string' && typeof item.createdAt === 'string');
				}
			} catch {
				items = [];
			}
		}
		index = items;
		return index;
	};
	const saveIndex = async (items: GenerationRecordSummary[]) => {
		await storage.set(indexKey, JSON.stringify({ version: INDEX_VERSION, items }));
		index = items;
	};

	const select = (items: GenerationRecordSummary[], filter: GenerationRecordFilter = {}) => {
		const matched = items.filter((s) => matchesRecordFilter(s, filter)).sort(newestFirst);
		const offset = Math.max(0, filter.offset ?? 0);
		return matched.slice(offset, filter.limit !== undefined ? offset + Math.max(0, filter.limit) : undefined);
	};

	const pruneLocked = async (prune: PruneOptions): Promise<string[]> => {
		const items = [...(await loadIndex())].sort(newestFirst);
		const removed: GenerationRecordSummary[] = [];
		const kept: GenerationRecordSummary[] = [];
		let candidates = 0;
		const cutoff = prune.olderThan !== undefined ? time(prune.olderThan) : undefined;
		for (const item of items) {
			if (prune.keep?.(item)) {
				kept.push(item);
				candidates++;
				continue;
			}
			const tooOld = cutoff !== undefined && time(item.createdAt) < cutoff;
			const overLimit = prune.maxRecords !== undefined && candidates >= Math.max(0, prune.maxRecords);
			if (tooOld || overLimit) removed.push(item);
			else {
				kept.push(item);
				candidates++;
			}
		}
		if (removed.length === 0) return [];
		// Index first: a crash between the two steps leaves orphaned record keys, never dangling index entries.
		await saveIndex(kept);
		for (const item of removed) await storage.remove(recordKey(item.id));
		return removed.map((item) => item.id);
	};

	return {
		put: (record) =>
			run(async () => {
				const serialized = serializeGenerationRecord(record);
				await storage.set(recordKey(record.id), serialized);
				const items = (await loadIndex()).filter((item) => item.id !== record.id);
				items.push(summarizeGenerationRecord(record));
				await saveIndex(items);
				if (options.maxRecords !== undefined) await pruneLocked({ maxRecords: options.maxRecords });
				notify();
			}),
		get: (id) =>
			run(async () => {
				const raw = await storage.get(recordKey(id));
				if (!raw) return null;
				try {
					return parseGenerationRecord(raw);
				} catch {
					return null;
				}
			}),
		summaries: (filter) => run(async () => select(await loadIndex(), filter)),
		list: (filter) =>
			run(async () => {
				const records: GenerationRecord[] = [];
				for (const summary of select(await loadIndex(), filter)) {
					const raw = await storage.get(recordKey(summary.id));
					if (!raw) continue;
					try {
						records.push(parseGenerationRecord(raw));
					} catch {
						// Skip unreadable records rather than failing the whole list.
					}
				}
				return records;
			}),
		remove: (id) =>
			run(async () => {
				const items = await loadIndex();
				const next = items.filter((item) => item.id !== id);
				if (next.length === items.length) return false;
				await saveIndex(next);
				await storage.remove(recordKey(id));
				notify();
				return true;
			}),
		prune: (prune) =>
			run(async () => {
				const removed = await pruneLocked(prune);
				if (removed.length) notify();
				return removed;
			}),
		clear: () =>
			run(async () => {
				const items = await loadIndex();
				await saveIndex([]);
				for (const item of items) await storage.remove(recordKey(item.id));
				notify();
			}),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
