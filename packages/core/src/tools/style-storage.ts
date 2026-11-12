/**
 * A house-style store kept in browser storage (`localStorage` by default): the whole store as one
 * JSON value under one key. Dependency-free; any object with `getItem` / `setItem` / `removeItem`
 * works (`sessionStorage`, a test double).
 *
 * Any script on the page can change browser storage, so every read checks names, paths, file
 * types and sizes again and leaves out what fails (see `problems()`). A value that is not this
 * store's format throws instead of being overwritten, so a later write cannot wipe a user's skills.
 */
import type { SkillFiles } from './skills.js';
import {
	DEFAULT_STYLE_LIMITS,
	STYLE_SKILL_NAME,
	styleFilePathProblem,
	type StyleLimits,
	type StyleSkillState,
	type StyleStore,
	type StyleStoreEntry
} from './style.js';

/** The part of the Web Storage API the store uses. */
export interface StyleStorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface StorageStyleStoreOptions {
	/** The storage key (default `pixerate-styles`). Give each store its own. */
	key?: string;
	/** Where to keep the store (default `globalThis.localStorage`). */
	storage?: StyleStorageLike;
	/** File limits checked on every read (default {@link DEFAULT_STYLE_LIMITS}). */
	limits?: Partial<StyleLimits>;
	/** Skills the store starts with while the key is empty (they are written on the first write). */
	initial?: SkillFiles;
	/**
	 * Tell subscribers when another tab changes the key (the window `storage` event). Default true
	 * where there is a window; the event never fires for the tab that wrote.
	 */
	watchOtherTabs?: boolean;
}

/** The stored value. */
interface StoredStyles {
	version: 1;
	/** Files by skill name, then by path inside the folder. */
	skills: Record<string, Record<string, string>>;
	state: Record<string, StyleSkillState>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** A store over browser storage. Its `problems()` say what the last read left out. */
export function storageStyleStore(options: StorageStyleStoreOptions = {}): StyleStore &
	Required<Pick<StyleStore, 'save' | 'remove' | 'setState' | 'subscribe'>> & {
		/** What the last read left out of the stored value, and why. */
		problems(): string[];
		/** The key the store is kept under. */
		readonly key: string;
	} {
	const key = options.key ?? 'pixerate-styles';
	const limits: StyleLimits = { ...DEFAULT_STYLE_LIMITS, ...options.limits };
	const listeners = new Set<() => void>();
	let problems: string[] = [];
	let detach: (() => void) | undefined;

	const storage = (): StyleStorageLike => {
		if (options.storage) return options.storage;
		let found: StyleStorageLike | undefined;
		try {
			found = (globalThis as { localStorage?: StyleStorageLike }).localStorage;
		} catch {
			found = undefined; // storage blocked (a sandboxed frame, privacy settings)
		}
		if (!found) throw new Error('There is no browser storage here (a server, a worker, or storage is blocked); pass storage to storageStyleStore.');
		return found;
	};

	const seeded = (): StoredStyles => {
		const skills: StoredStyles['skills'] = {};
		for (const [path, text] of Object.entries(options.initial ?? {})) {
			const [dir, ...rest] = path.replace(/\\/g, '/').replace(/^\.?\//, '').split('/');
			if (!dir || !rest.length) continue;
			(skills[dir] ??= {})[rest.join('/')] = text;
		}
		return { version: 1, skills, state: {} };
	};

	/** The stored value, checked again: what fails the limits is left out and recorded in `problems`. */
	const read = (): StoredStyles => {
		const raw = storage().getItem(key);
		const found: string[] = [];
		problems = found;
		if (raw === null) return seeded();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(`Browser storage "${key}" holds no readable house styles (${(error as Error).message}); remove the key to start again.`);
		}
		if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.skills) || (parsed.state !== undefined && !isObject(parsed.state))) {
			throw new Error(`Browser storage "${key}" holds something other than house styles (expected { "version": 1, "skills": {...}, "state": {...} }); remove the key to start again.`);
		}
		const skills: StoredStyles['skills'] = {};
		for (const [name, files] of Object.entries(parsed.skills)) {
			if (!STYLE_SKILL_NAME.test(name)) {
				found.push(`"${name}" is not a valid skill name, so it is left out.`);
				continue;
			}
			if (!isObject(files)) {
				found.push(`${name}: its files are not an object, so it is left out.`);
				continue;
			}
			const kept: Record<string, string> = {};
			let total = 0;
			for (const [path, text] of Object.entries(files)) {
				const problem = typeof text !== 'string' ? 'it is not text' : path === 'SKILL.md' ? undefined : styleFilePathProblem(path, limits);
				if (problem) {
					found.push(`${name}/${path} is left out: ${problem}`);
					continue;
				}
				const size = bytes(text as string);
				if (size > limits.maxFileBytes) {
					found.push(`${name}/${path} is left out: it is over the ${Math.round(limits.maxFileBytes / 1024)} KB limit.`);
					continue;
				}
				if (Object.keys(kept).length >= limits.maxFiles || total + size > limits.maxSkillBytes) {
					found.push(`${name}/${path} is left out: the skill is over its file or size limit.`);
					continue;
				}
				kept[path] = text as string;
				total += size;
			}
			skills[name] = kept;
		}
		const state: StoredStyles['state'] = {};
		for (const [name, value] of Object.entries(isObject(parsed.state) ? parsed.state : {})) {
			if (!STYLE_SKILL_NAME.test(name) || !isObject(value)) {
				found.push(`State for "${name}" is left out: it is not a valid skill name and state object.`);
				continue;
			}
			state[name] = {
				...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
				...(typeof value.order === 'number' && Number.isFinite(value.order) ? { order: value.order } : {}),
				...(typeof value.group === 'string' && value.group ? { group: value.group } : {}),
				...(Array.isArray(value.scope) ? { scope: value.scope.filter((s): s is string => typeof s === 'string') } : {})
			};
		}
		return { version: 1, skills, state };
	};

	const write = (change: (data: StoredStyles) => void) => {
		const data = read();
		change(data);
		try {
			storage().setItem(key, JSON.stringify(data));
		} catch (error) {
			throw new Error(`Browser storage refused the write (a site gets about 5 MB): ${(error as Error).message}`);
		}
		listeners.forEach((l) => l());
	};

	const checkName = (name: string) => {
		if (!STYLE_SKILL_NAME.test(name)) throw new Error(`"${name}" is not a valid skill name: use lowercase letters, digits and hyphens, at most 64.`);
	};

	return {
		key,
		problems: () => [...problems],
		list(): StyleStoreEntry[] {
			const data = read();
			return [...new Set([...Object.keys(data.skills), ...Object.keys(data.state)])].sort().map((name) => ({ name, ...data.state[name] }));
		},
		read: (name, file) => read().skills[name]?.[file],
		files: (name) => Object.keys(read().skills[name] ?? {}).sort(),
		save(name, files, opts = {}) {
			checkName(name);
			write((data) => {
				data.skills[name] = { ...(opts.replace ? {} : data.skills[name]), ...files };
			});
		},
		remove(name) {
			write((data) => {
				delete data.skills[name];
				delete data.state[name];
			});
		},
		setState(name, next) {
			checkName(name);
			write((data) => {
				if (next) data.state[name] = { ...next };
				else delete data.state[name];
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			const target = globalThis as { addEventListener?: (type: string, fn: (e: { key: string | null }) => void) => void; removeEventListener?: (type: string, fn: (e: { key: string | null }) => void) => void };
			if (!detach && options.watchOtherTabs !== false && typeof target.addEventListener === 'function') {
				const onStorage = (e: { key: string | null }) => {
					if (e.key === key || e.key === null) listeners.forEach((l) => l());
				};
				target.addEventListener('storage', onStorage);
				detach = () => target.removeEventListener?.('storage', onStorage);
			}
			return () => {
				listeners.delete(listener);
				if (!listeners.size && detach) {
					detach();
					detach = undefined;
				}
			};
		}
	};
}
