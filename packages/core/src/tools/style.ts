/**
 * House-style skills: preferences and rules a host hands agents at runtime, per editor domain.
 *
 * A style skill is a folder like a built-in agent skill: a `SKILL.md` of prose preferences
 * (frontmatter `name`, `description` and optionally `domains`) plus one optional profile per
 * domain (`chart.json`, `tokens.json`) holding structured rules. Hosts keep style skills in
 * layers (org, workspace, user, ...); a {@link StyleResolver} merges them per domain, resolves
 * `$token` references and runs the domain's checks. Dependency-free: domains bring their own
 * profile schema and checks (`chartStyleDomain`, `tokensStyleDomain`).
 */
import { validateJsonSchema, type JsonSchema } from './schema.js';
import { stripPrototypeKeys, isUnsafeJsonKey } from './safe-json.js';
import { parseSkillFrontmatter, type SkillFiles } from './skills.js';
import { parseFrontmatter, type YamlValue } from './yaml.js';
import { BRAND_PROFILE_SCHEMA, brandColors, brandFonts, brandPalette, type BrandProfile } from './brand.js';
import { SHARED_STYLE_CHECKS, type StyleCheckContext, type StyleSurface } from './style-surface.js';

type MaybePromise<T> = T | Promise<T>;

/** What a store records about one style skill, apart from its files. */
export interface StyleSkillState {
	/** `false` switches the skill off (also for a skill another layer holds). Default on. */
	enabled?: boolean;
	/** Sort key among skills of the same layer (lower first, default 0). */
	order?: number;
	/**
	 * One-of-a-kind group (`look`, `theme`): of the switched-on skills in a group, only the first
	 * applies. `choose` switches one on and its rivals off. Overrides the frontmatter `group`.
	 */
	group?: string;
	/**
	 * Where the skill applies (`report`, `slides`, a document type). A skill with a scope applies
	 * only when the resolver is asked for one of them; without one it applies everywhere.
	 */
	scope?: string[];
}

/** One entry of {@link StyleStore.list}: a skill this store holds, or state for another layer's. */
export interface StyleStoreEntry extends StyleSkillState {
	name: string;
}

/**
 * Where one layer's style skills live. Hosts implement it over their own storage (a database,
 * a bucket, the file system); {@link memoryStyleStore} holds skills in memory.
 */
export interface StyleStore {
	/** Skill names with their state. An entry whose `SKILL.md` this store lacks only carries state. */
	list(): MaybePromise<readonly StyleStoreEntry[]>;
	/** A file of a skill (`SKILL.md`, `chart.json`, `references/x.md`), or `undefined`. */
	read(name: string, file: string): MaybePromise<string | undefined>;
	/** Every file of a skill, relative to its folder. */
	files(name: string): MaybePromise<readonly string[]>;
	/** Called when the store's skills or state change; returns an unsubscribe function. */
	subscribe?(listener: () => void): () => void;
	/** Records (or with `undefined`, clears) state for a skill; a store without it is read-only. */
	setState?(name: string, state: StyleSkillState | undefined): MaybePromise<void>;
	/**
	 * Writes a skill's files. With `replace`, files not given are deleted; otherwise they are
	 * kept. A store without it cannot take new or changed skills (see `saveStyleSkill`).
	 */
	save?(name: string, files: Readonly<Record<string, string>>, options?: { replace?: boolean }): MaybePromise<void>;
	/** Deletes a skill's files and state from this store. */
	remove?(name: string): MaybePromise<void>;
}

/** A layer of style skills, from general (first) to specific (last). */
export interface StyleLayer {
	/** Layer id, shown to agents as where a rule came from: `org`, `workspace`, `user`, ... */
	id: string;
	store: StyleStore;
	/**
	 * Later layers cannot replace this layer's skills or change the profile fields it sets.
	 * Their attempts are left out and reported as issues.
	 */
	locked?: boolean;
	/** Later layers cannot switch this layer's skills off. */
	required?: boolean;
}

/** A finding: one house-style rule the current state breaks. */
export interface StyleFinding {
	/** Id of the check that found it. */
	check: string;
	severity: 'error' | 'warning' | 'info';
	/** What is wrong and how to fix it, in one sentence. */
	message: string;
	/** What it is about, in the shape the domain's write tools take (e.g. a chart selection). */
	target?: unknown;
	/** The layer whose profile asked for the check. */
	layer?: string;
}

/**
 * A rule a domain can check. A profile turns it on by id in its `checks` list, with options:
 * `"palette-only"` or `{ "id": "min-contrast", "ratio": 4.5 }`.
 */
export interface StyleCheck<State = unknown> {
	id: string;
	/** What it checks, for agents and admin screens. */
	description: string;
	/** Schema of its options (validated when a profile loads). Default: no options. */
	optionsSchema?: JsonSchema;
	/**
	 * The findings for `state` under the resolved `profile` (and the brand, in `context`).
	 * Throwing reports the check as skipped.
	 */
	run(
		state: State,
		profile: Readonly<Record<string, unknown>>,
		options: Readonly<Record<string, unknown>>,
		context?: StyleCheckContext
	): readonly Omit<StyleFinding, 'check' | 'layer'>[];
}

/** An editor domain that can have a house style: its profile file, schema and checks. */
export interface StyleDomain<State = unknown> {
	/** Domain id, the domain skill's name without `pixerate-` (`chart`, `tokens`). The profile file is `<id>.json`. */
	id: string;
	title: string;
	/** What a profile for this domain can set. */
	description: string;
	/** Schema of the profile (the `checks` property is validated separately). */
	profileSchema: JsonSchema & { type: 'object' };
	checks: readonly StyleCheck<State>[];
	/**
	 * This domain's profile derived from the brand (`brand.json`): what a brand-only skill gives
	 * it. Fields a domain profile sets win; the result is validated against `profileSchema`.
	 */
	themeFromBrand?(brand: BrandProfile): Record<string, unknown>;
	/**
	 * What `state` draws with, so the shared checks (`palette-only`, `min-contrast`,
	 * `distinguishable`, `fonts-allowed`) run in this domain. A domain check with the same id wins.
	 */
	surface?(state: State): StyleSurface;
	/** A small valid profile, for authors and scaffolding (`scaffoldStyleSkill`). */
	example?: Record<string, unknown>;
	/**
	 * What new work in this domain starts from under `profile` (a patch in the domain's own
	 * shape, e.g. a chart spec patch with the palette and defaults). See {@link styleDefaults}.
	 */
	defaults?(profile: Readonly<Record<string, unknown>>): Record<string, unknown>;
	/** A sample of this domain drawn in `profile` (SVG or HTML markup), for skill previews. */
	preview?(profile: Readonly<Record<string, unknown>>, brand?: BrandProfile): string;
}

/** The `brand` pseudo-domain: `brand.json`, read by every domain. Every resolver includes it. */
export const brandStyleDomain: StyleDomain<StyleSurface> = {
	id: 'brand',
	title: 'Brand',
	description:
		'The brand every editor shares: colours by role (primary, text, background, Office slots such as accent1 and dk1), an ordered palette, fonts and a logo, and shared checks to run wherever a domain can be checked against it. Each domain derives its own starting style from it; a domain profile refines that.',
	profileSchema: BRAND_PROFILE_SCHEMA,
	checks: SHARED_STYLE_CHECKS,
	example: {
		name: 'Acme',
		colors: { primary: '#0b5fff', secondary: '#ff6a00', accent: '#12a150', text: '#1a1a1a', mutedText: '#5c5c5c', background: '#ffffff', border: '#d9d9d9' },
		fonts: { heading: 'Inter', body: 'Inter' },
		checks: ['palette-only', 'min-contrast', 'fonts-allowed']
	}
};

/** The checks a domain can turn on: its own, then the shared checks it does not replace (with a surface). */
export function styleChecksOf<State>(domain: StyleDomain<State>): readonly StyleCheck<any>[] {
	if (domain.id === 'brand' || !domain.surface) return domain.checks;
	const own = new Set(domain.checks.map((c) => c.id));
	return [...domain.checks, ...SHARED_STYLE_CHECKS.filter((c) => !own.has(c.id))];
}

/** A `$token` reference in a profile: `{ "$token": "brand/primary", "mode": "Dark" }`. */
export interface StyleTokenRef {
	/** Variable name (`brand/primary`) or id. */
	token: string;
	/** Mode name or id (default: the collection's default mode). */
	mode?: string;
}

/** Resolves `$token` references in profiles (see `createTokenStyleSource` in `@pixerate/editor/tokens`). */
export interface StyleTokenSource {
	/** The value, or an error saying why the reference does not resolve. */
	resolve(ref: StyleTokenRef): { ok: true; value: string | number | boolean } | { ok: false; message: string };
	subscribe?(listener: () => void): () => void;
}

export interface StyleIssue {
	/** Skill the issue is about (absent for layer-wide issues). */
	skill?: string;
	layer?: string;
	message: string;
}

/** A style skill as a resolver lists it. */
export interface StyleSkillInfo {
	name: string;
	description: string;
	/** The layer whose copy is used. */
	layer: string;
	/** Domains it applies to (every registered domain when its frontmatter names none). */
	domains: string[];
	/** Domains it has a profile for. */
	profiles: string[];
	enabled: boolean;
	order: number;
	/** Its one-of-a-kind group, from state or frontmatter. */
	group?: string;
	/** Where it applies; absent means everywhere. */
	scope?: string[];
	/** For a grouped skill: whether it is the one that applies (in the scope asked for). */
	chosen?: boolean;
	/** Why it, or part of it, is left out. A skill with issues and no usable part is not applied. */
	issues: string[];
}

/** Options for reading a resolver in one place of the host. */
export interface StyleScopeOptions {
	/** Where the work is (`report`, `slides`, ...): scoped skills apply only when it is one of theirs. */
	scope?: string;
}

/** A one-of-a-kind group and its skills, as `choices` lists them. */
export interface StyleChoiceGroup {
	group: string;
	/** The skill that applies, if any is switched on. */
	chosen?: string;
	/** Every skill of the group that applies in the scope, switched on or off, in order. */
	options: StyleSkillInfo[];
}

/** What `choose` did. */
export interface StyleChoiceResult {
	group: string;
	/** The skill now chosen. */
	chosen: string;
	/** The layer whose state was written. */
	layer: string;
	/** Rivals it switched off. */
	switchedOff: string[];
	/** Set when a later layer's state still keeps another skill in front. */
	note?: string;
}

/** A skill's prose as it applies to one domain. */
export interface ResolvedStyleSkill {
	name: string;
	description: string;
	layer: string;
	/** The `SKILL.md` body (without frontmatter). */
	body: string;
}

/** Everything that applies to one domain, merged. */
export interface ResolvedStyle {
	domain: string;
	/** Applicable skills, general to specific. */
	skills: ResolvedStyleSkill[];
	/** The merged profile, with `$token` references replaced by their values. */
	profile: Record<string, unknown>;
	/**
	 * Which layer set each profile field (`palette`, `theme.fontFamily`). Fields derived from the
	 * brand say `<layer> (brand)`; `$brand.checks` names the layer of the brand's checks list.
	 */
	sources: Record<string, string>;
	issues: StyleIssue[];
	/** The merged brand (`brand.json`) that applies to this domain, if any skill has one. */
	brand?: BrandProfile;
}

/** The result of running a domain's checks. */
export interface StyleCheckReport {
	findings: StyleFinding[];
	/** Checks that ran. */
	ran: string[];
	/** Checks the profile asked for that could not run, with the reason. */
	skipped: { check: string; reason: string }[];
}

export interface StyleResolverOptions {
	/** Layers from general to specific. */
	layers: readonly StyleLayer[];
	/** Domains style skills may target. */
	domains: readonly StyleDomain<any>[];
	/** Resolves `$token` references; without it a profile with one is reported as an issue. */
	tokens?: StyleTokenSource;
	/** File limits (default {@link DEFAULT_STYLE_LIMITS}). */
	limits?: Partial<StyleLimits>;
}

/** Merges house-style layers per domain. Build it with {@link createStyleResolver}. */
export interface StyleResolver {
	readonly layers: readonly StyleLayer[];
	readonly domains: readonly StyleDomain<any>[];
	/** The token source `$token` references resolve against, if any. */
	readonly tokens?: StyleTokenSource;
	/** The file limits in force. */
	readonly limits: Readonly<StyleLimits>;
	/** Every style skill across layers (switched-off ones too), general to specific. */
	list(options?: { domain?: string } & StyleScopeOptions): Promise<StyleSkillInfo[]>;
	/** The resolved style for a domain. Throws for an unknown domain. */
	resolve(domain: string, options?: StyleScopeOptions): Promise<ResolvedStyle>;
	/** The one-of-a-kind groups and their skills (in the scope). */
	choices(options?: StyleScopeOptions): Promise<StyleChoiceGroup[]>;
	/** The skill that applies in `group`, or `undefined` when none is switched on. */
	chosen(group: string, options?: StyleScopeOptions): Promise<StyleSkillInfo | undefined>;
	/**
	 * Switches skill `name` on and the other skills of its group off (those that apply in
	 * `scope`, when given), in one write to `layer` (default: the most specific writable layer).
	 * Throws, writing nothing, for an unknown or ungrouped skill, a read-only layer, or a rival
	 * that a required layer keeps on.
	 */
	choose(name: string, options?: { layer?: string } & StyleScopeOptions): Promise<StyleChoiceResult>;
	/** A file of the skill copy in use. */
	readFile(name: string, file: string): Promise<string | undefined>;
	/** Files of the skill copy in use (`undefined` for an unknown skill). */
	files(name: string): Promise<string[] | undefined>;
	/** Runs the domain's checks that the resolved profile turns on against `state`. */
	check<State>(domain: string, state: State, options?: StyleScopeOptions): Promise<StyleCheckReport & { style: ResolvedStyle }>;
	/** Called when a store or the token source changes; returns an unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

/** A valid style skill name (its folder): lowercase letters, digits and hyphens, at most 64. */
export const STYLE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `domains` frontmatter field: `[chart, tokens]`, `chart, tokens` or one name. */
export function parseStyleDomains(markdown: string): string[] | undefined {
	const fm = parseFrontmatter(markdown);
	if (!fm.error) return domainsOf(fm.data.domains);
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	const line = match?.[1].split(/\r?\n/).find((l) => /^domains:/.test(l));
	if (!line) return undefined;
	const raw = line.slice('domains:'.length).trim().replace(/^\[|\]$/g, '');
	return raw
		.split(',')
		.map((d) => d.trim().replace(/^(['"])(.*)\1$/, '$2'))
		.filter(Boolean);
}

/** A frontmatter `domains` value: a list, or one comma-separated string. */
function domainsOf(value: YamlValue | undefined): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const list = Array.isArray(value) ? value : String(value).split(',');
	return list.map((d) => String(d).trim()).filter(Boolean);
}

/** Size and shape limits for style skill files. Files outside them are left out with an issue. */
export interface StyleLimits {
	/** Largest file, in bytes (UTF-8). Default 256 KB. */
	maxFileBytes: number;
	/** Largest skill, all files together, in bytes. Default 4 MB (checked by `checkStyleSkill`). */
	maxSkillBytes: number;
	/** Most files a skill offers. Default 200. */
	maxFiles: number;
	/** Deepest folder nesting inside a skill. Default 4. */
	maxDepth: number;
}

export const DEFAULT_STYLE_LIMITS: Readonly<StyleLimits> = Object.freeze({ maxFileBytes: 256 * 1024, maxSkillBytes: 4 * 1024 * 1024, maxFiles: 200, maxDepth: 4 });

/** File types a style skill may hold: text an agent can read. */
export const STYLE_TEXT_FILE = /\.(md|txt|json|jsonl|ya?ml|toml|csv|tsv|xml|html|css|svg)$/i;

/** Why `path` cannot be a file of a style skill, or `undefined` when it can. */
export function styleFilePathProblem(path: string, limits: Pick<StyleLimits, 'maxDepth'> = DEFAULT_STYLE_LIMITS): string | undefined {
	if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return `"${path}" is not a path inside the skill folder.`;
	if (path.includes('\\')) return `"${path}" uses backslashes; use / between folders.`;
	const parts = path.split('/');
	if (parts.some((p) => p === '' || p === '.' || p === '..')) return `"${path}" must not contain empty, "." or ".." parts.`;
	if (parts.some((p) => p.startsWith('.'))) return `"${path}" is hidden; hidden files are left out.`;
	if (!/^[A-Za-z0-9._/-]+$/.test(path)) return `"${path}" may use only letters, digits, ".", "-", "_" and "/".`;
	if (parts.length - 1 > limits.maxDepth) return `"${path}" is nested more than ${limits.maxDepth} folders deep.`;
	if (!STYLE_TEXT_FILE.test(path)) return `"${path}" is not a text file type agents can read (md, json, yaml, svg, ...).`;
	return undefined;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** A one-line frontmatter field (`group: look`), unquoted, or `undefined`. */
function frontmatterField(markdown: string, key: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	const line = match?.[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
	const value = line?.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
	return value || undefined;
}

/**
 * A style store in memory, from skill files keyed `<skill>/<file>` (the {@link SkillFiles}
 * shape), with optional state per skill. `set`, `remove` and `setState` notify subscribers.
 */
export function memoryStyleStore(
	initial: SkillFiles = {},
	state: Readonly<Record<string, StyleSkillState>> = {}
): StyleStore & {
	set(name: string, files: Readonly<Record<string, string>>): void;
	save(name: string, files: Readonly<Record<string, string>>, options?: { replace?: boolean }): void;
	remove(name: string): void;
	setState(name: string, state: StyleSkillState | undefined): void;
	/** Everything the store holds, to save with a document (`memoryStyleStore(json.files, json.state)` restores it). */
	toJSON(): { files: Record<string, string>; state: Record<string, StyleSkillState> };
} {
	const files = new Map<string, Map<string, string>>();
	const states = new Map<string, StyleSkillState>(Object.entries(state));
	const listeners = new Set<() => void>();
	const notify = () => listeners.forEach((l) => l());
	for (const [path, text] of Object.entries(initial)) {
		const [dir, ...rest] = path.replace(/\\/g, '/').replace(/^\.?\//, '').split('/');
		if (!dir || !rest.length) continue;
		if (!files.has(dir)) files.set(dir, new Map());
		files.get(dir)!.set(rest.join('/'), text);
	}
	return {
		list: () => [...new Set([...files.keys(), ...states.keys()])].sort().map((name) => ({ name, ...states.get(name) })),
		read: (name, file) => files.get(name)?.get(file),
		files: (name) => [...(files.get(name)?.keys() ?? [])].sort(),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(name, skillFiles) {
			files.set(name, new Map(Object.entries(skillFiles)));
			notify();
		},
		save(name, skillFiles, options = {}) {
			const next = options.replace ? new Map<string, string>() : new Map(files.get(name) ?? []);
			for (const [file, text] of Object.entries(skillFiles)) next.set(file, text);
			files.set(name, next);
			notify();
		},
		toJSON() {
			const out: Record<string, string> = {};
			for (const [name, map] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) for (const [file, text] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) out[`${name}/${file}`] = text;
			return { files: out, state: Object.fromEntries([...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { ...v }])) };
		},
		remove(name) {
			files.delete(name);
			states.delete(name);
			notify();
		},
		setState(name, next) {
			if (next) states.set(name, next);
			else states.delete(name);
			notify();
		}
	};
}

interface LoadedSkill {
	info: StyleSkillInfo;
	layerIndex: number;
	body: string;
	/** Parsed, token-resolved profiles by domain. */
	profiles: Map<string, Record<string, unknown>>;
	/** Domains the skill applies to, after its issues. */
	applies: Set<string>;
}

/** Replaces `{ "$token": ... }` objects with their values. */
function resolveTokens(value: unknown, tokens: StyleTokenSource | undefined, path: string, errors: string[]): unknown {
	if (Array.isArray(value)) return value.map((v, i) => resolveTokens(v, tokens, `${path}[${i}]`, errors));
	if (!isPlainObject(value)) return value;
	if ('$token' in value) {
		const token = value.$token;
		const mode = value.mode;
		if (typeof token !== 'string' || !token || (mode !== undefined && typeof mode !== 'string') || Object.keys(value).some((k) => k !== '$token' && k !== 'mode')) {
			errors.push(`${path || 'profile'}: a token reference is { "$token": "<variable name or id>", "mode"?: "<mode>" }.`);
			return undefined;
		}
		if (!tokens) {
			errors.push(`${path || 'profile'}: "${token}" is a token reference, but this host has no design tokens to resolve it.`);
			return undefined;
		}
		const resolved = tokens.resolve({ token, ...(mode ? { mode } : {}) });
		if (!resolved.ok) errors.push(`${path || 'profile'}: ${resolved.message}`);
		return resolved.ok ? resolved.value : undefined;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = resolveTokens(v, tokens, path ? `${path}.${k}` : k, errors);
	return out;
}

/** Problems with a profile's `checks` list, against the domain's checks. */
function checkListErrors(list: unknown, domain: StyleDomain<any>): string[] {
	if (list === undefined) return [];
	if (!Array.isArray(list)) return ['checks: expected a list of check ids or { "id": ..., options } objects.'];
	const errors: string[] = [];
	list.forEach((entry, i) => {
		const id = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.id : undefined;
		if (typeof id !== 'string' || !id) {
			errors.push(`checks[${i}]: expected a check id or { "id": ..., options }.`);
			return;
		}
		const check = styleChecksOf(domain).find((c) => c.id === id);
		if (!check || typeof entry === 'string') return; // unknown ids are reported as skipped when checks run
		const { id: _id, ...options } = entry as Record<string, unknown>;
		const schema = check.optionsSchema ?? { type: 'object', properties: {}, additionalProperties: false };
		for (const e of validateJsonSchema(options, schema)) errors.push(`checks[${i}] (${id})${e.path}: ${e.message}`);
	});
	return errors;
}

/** Merges `value` into `target` at `path`, recording sources and refusing locked fields. */
function mergeProfile(
	target: Record<string, unknown>,
	value: Record<string, unknown>,
	layer: StyleLayer,
	skill: string,
	sources: Record<string, string>,
	locked: Map<string, string>,
	issues: StyleIssue[],
	prefix = ''
) {
	for (const [key, next] of Object.entries(value)) {
		if (isUnsafeJsonKey(key) || next === undefined) continue;
		const path = prefix ? `${prefix}.${key}` : key;
		const lockedBy = [...locked.entries()].find(([p]) => p === path || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));
		if (isPlainObject(next)) {
			// Objects merge field by field, so sources and locks are per field.
			if (!isPlainObject(target[key])) {
				if (lockedBy && lockedBy[1] !== layer.id && target[key] !== undefined) {
					issues.push({ skill, layer: layer.id, message: `"${path}" is locked by the ${lockedBy[1]} layer, so this skill's value is ignored.` });
					continue;
				}
				target[key] = {};
				delete sources[path];
			}
			mergeProfile(target[key] as Record<string, unknown>, next, layer, skill, sources, locked, issues, path);
			continue;
		}
		if (lockedBy && lockedBy[1] !== layer.id) {
			issues.push({ skill, layer: layer.id, message: `"${path}" is locked by the ${lockedBy[1]} layer, so this skill's value is ignored.` });
			continue;
		}
		target[key] = Array.isArray(next) ? structuredClone(next) : next;
		for (const p of Object.keys(sources)) if (p.startsWith(`${path}.`)) delete sources[p];
		sources[path] = layer.id;
		if (layer.locked) locked.set(path, layer.id);
	}
}

/** Records `source` for every leaf field of `value` (objects recurse, arrays are leaves). */
function recordSources(value: Record<string, unknown>, source: string, sources: Record<string, string>, prefix = '') {
	for (const [key, next] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (isPlainObject(next) && Object.keys(next).length) recordSources(next, source, sources, path);
		else sources[path] = source;
	}
}

/**
 * Builds a {@link StyleResolver} over layers of style skills. Reads go to the stores on every
 * call, so a host's change shows up at once; `subscribe` tells open views to refresh.
 */
export function createStyleResolver(options: StyleResolverOptions): StyleResolver {
	const layers = [...options.layers];
	const limits: StyleLimits = { ...DEFAULT_STYLE_LIMITS, ...options.limits };
	const domains = options.domains.some((d) => d.id === brandStyleDomain.id) ? [...options.domains] : [...options.domains, brandStyleDomain];
	const ids = new Set<string>();
	for (const layer of layers) {
		if (ids.has(layer.id)) throw new Error(`Two style layers are called "${layer.id}"; give each layer its own id.`);
		ids.add(layer.id);
	}
	const domainIds = domains.map((d) => d.id);
	const requireDomain = (id: string) => {
		const domain = domains.find((d) => d.id === id);
		if (!domain) throw new Error(`There is no house-style domain "${id}"; expected one of ${domainIds.map((d) => `"${d}"`).join(', ') || '(none registered)'}.`);
		return domain;
	};

	/** The copy in use for each skill name, and every skill's info. */
	async function load(): Promise<{ skills: LoadedSkill[]; issues: StyleIssue[] }> {
		const issues: StyleIssue[] = [];
		const entries = await Promise.all(layers.map(async (layer) => [...(await layer.store.list())]));
		const names = [...new Set(entries.flat().map((e) => e.name))];
		const skills: LoadedSkill[] = [];
		for (const name of names) {
			if (!STYLE_SKILL_NAME.test(name)) {
				issues.push({ skill: name, message: `"${name}" is not a valid skill name (lowercase letters, digits and hyphens, at most 64).` });
				continue;
			}
			const copies: { index: number; text: string }[] = [];
			for (let i = 0; i < layers.length; i++) {
				const text = await layers[i].store.read(name, 'SKILL.md');
				if (text !== undefined) copies.push({ index: i, text });
			}
			if (!copies.length) continue; // state only, for a skill no layer holds
			const oversized = copies.filter((c) => utf8Bytes(c.text) > limits.maxFileBytes);
			if (oversized.length) {
				for (const c of oversized) issues.push({ skill: name, layer: layers[c.index].id, message: `SKILL.md is ${kb(utf8Bytes(c.text))}, over the ${kb(limits.maxFileBytes)} limit, so this copy is left out.` });
				copies.splice(0, copies.length, ...copies.filter((c) => !oversized.includes(c)));
				if (!copies.length) continue;
			}
			const lockedCopy = copies.find((c) => layers[c.index].locked);
			const winner = lockedCopy ?? copies[copies.length - 1];
			const layer = layers[winner.index];
			const skillIssues: string[] = [];
			for (const c of copies) {
				if (c.index > winner.index) skillIssues.push(`The ${layers[c.index].id} layer's copy is ignored: the ${layer.id} layer is locked.`);
			}
			// State: general to specific; a required layer's skills keep their own state only.
			let enabled = true;
			let order = 0;
			const fm = parseFrontmatter(winner.text);
			if (fm.error) skillIssues.push(`SKILL.md ${fm.error}`);
			let group = fm.error ? frontmatterField(winner.text, 'group') : typeof fm.data.group === 'string' && fm.data.group ? fm.data.group : undefined;
			let scope: string[] | undefined;
			for (let i = 0; i < layers.length; i++) {
				const entry = entries[i].find((e) => e.name === name);
				if (!entry) continue;
				if (i === winner.index && entry.order !== undefined) order = entry.order;
				if (typeof entry.group === 'string' && entry.group) group = entry.group;
				if (Array.isArray(entry.scope)) scope = entry.scope.filter((x): x is string => typeof x === 'string');
				if (entry.enabled === undefined) continue;
				if (layer.required && i !== winner.index) {
					if (entry.enabled === false) skillIssues.push(`The ${layers[i].id} layer cannot switch it off: the ${layer.id} layer requires it.`);
					continue;
				}
				enabled = entry.enabled;
			}
			const legacy = parseSkillFrontmatter(winner.text);
			const description = fm.error ? (legacy.description ?? '') : typeof fm.data.description === 'string' ? fm.data.description : '';
			const body = legacy.body;
			const named = fm.error ? parseStyleDomains(winner.text) : domainsOf(fm.data.domains);
			const applies = new Set<string>();
			for (const d of named ?? domainIds) {
				if (domainIds.includes(d)) applies.add(d);
				else skillIssues.push(`It names an unknown domain "${d}"; the domains here are ${domainIds.join(', ')}.`);
			}
			const profiles = new Map<string, Record<string, unknown>>();
			for (const domain of domains) {
				const fileRaw = await layer.store.read(name, `${domain.id}.json`);
				// A store that keeps only SKILL.md can carry a profile under a frontmatter key (`chart:`).
				const inFrontmatter = !fm.error && isPlainObject(fm.data[domain.id]) ? (fm.data[domain.id] as Record<string, unknown>) : undefined;
				if (fileRaw === undefined && !inFrontmatter) continue;
				const file = fileRaw !== undefined ? `${domain.id}.json` : `The frontmatter "${domain.id}" profile`;
				if (fileRaw !== undefined && inFrontmatter) skillIssues.push(`The frontmatter "${domain.id}" profile is ignored: ${domain.id}.json is used.`);
				if (fileRaw !== undefined && utf8Bytes(fileRaw) > limits.maxFileBytes) {
					skillIssues.push(`${file} is ${kb(utf8Bytes(fileRaw))}, over the ${kb(limits.maxFileBytes)} limit, so it is left out.`);
					continue;
				}
				const raw = fileRaw ?? JSON.stringify(inFrontmatter);
				if (domain.id === brandStyleDomain.id) applies.add(domain.id); // a brand applies wherever the skill does
				else if (!applies.has(domain.id)) {
					skillIssues.push(`${file} is left out: the skill's domains do not include ${domain.id}.`);
					continue;
				}
				let parsed: unknown;
				try {
					parsed = stripPrototypeKeys(JSON.parse(raw));
				} catch (error) {
					skillIssues.push(`${file} is not valid JSON: ${(error as Error).message}`);
					continue;
				}
				if (!isPlainObject(parsed)) {
					skillIssues.push(`${file} must hold a JSON object.`);
					continue;
				}
				// Editors read "$schema" for completion; it is not part of the profile.
				if (typeof parsed.$schema === 'string') delete parsed.$schema;
				const errors: string[] = [];
				const resolved = resolveTokens(parsed, options.tokens, '', errors);
				// A root `{ "$token": ... }` resolves to a value or to nothing, never to a profile object.
				if (!isPlainObject(resolved)) {
					skillIssues.push(errors.length ? `${file} is left out: ${errors.join(' ')}` : `${file} must hold a JSON object; its token reference resolves to ${JSON.stringify(resolved)}.`);
					continue;
				}
				const { checks, ...rest } = resolved;
				errors.push(...validateJsonSchema(rest, domain.profileSchema).map((e) => `${e.path || '(profile)'}: ${e.message}`));
				errors.push(...checkListErrors(checks, domain));
				if (errors.length) {
					skillIssues.push(`${file} is left out: ${errors.join(' ')}`);
					continue;
				}
				profiles.set(domain.id, resolved);
			}
			skills.push({
				info: {
					name,
					description,
					layer: layer.id,
					domains: [...applies],
					profiles: [...profiles.keys()],
					enabled,
					order,
					...(group ? { group } : {}),
					...(scope ? { scope } : {}),
					issues: skillIssues
				},
				layerIndex: winner.index,
				body: body.trim(),
				profiles,
				applies
			});
		}
		skills.sort((a, b) => a.layerIndex - b.layerIndex || a.info.order - b.info.order || a.info.name.localeCompare(b.info.name));
		return { skills, issues };
	}

	const inScope = (info: StyleSkillInfo, scope?: string) => !info.scope || (scope !== undefined && info.scope.includes(scope));

	/** The skills that apply in `scope`: switched on, in scope, and the first switched on of their group. */
	function active(skills: readonly LoadedSkill[], scope?: string): Set<string> {
		const out = new Set<string>();
		const taken = new Set<string>();
		for (const s of skills) {
			if (!s.info.enabled || !inScope(s.info, scope)) continue;
			if (s.info.group) {
				if (taken.has(s.info.group)) continue;
				taken.add(s.info.group);
			}
			out.add(s.info.name);
		}
		return out;
	}

	const withChosen = (info: StyleSkillInfo, applying: Set<string>): StyleSkillInfo => (info.group ? { ...info, chosen: applying.has(info.name) } : info);

	async function choices(opts: StyleScopeOptions = {}): Promise<StyleChoiceGroup[]> {
		const { skills } = await load();
		const applying = active(skills, opts.scope);
		const groups = new Map<string, StyleChoiceGroup>();
		for (const s of skills) {
			if (!s.info.group || !inScope(s.info, opts.scope)) continue;
			const g = groups.get(s.info.group) ?? { group: s.info.group, options: [] };
			g.options.push(withChosen(s.info, applying));
			if (applying.has(s.info.name)) g.chosen = s.info.name;
			groups.set(s.info.group, g);
		}
		return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
	}

	async function choose(name: string, opts: { layer?: string } & StyleScopeOptions = {}): Promise<StyleChoiceResult> {
		const { skills } = await load();
		const skill = skills.find((s) => s.info.name === name);
		if (!skill) {
			throw new Error(`There is no house-style skill "${name}"; ${skills.length ? `the skills are ${skills.map((s) => `"${s.info.name}"`).join(', ')}` : 'none are installed'}.`);
		}
		const group = skill.info.group;
		if (!group) {
			const groups = [...new Set(skills.map((s) => s.info.group).filter(Boolean))];
			throw new Error(`"${name}" is not in a one-of-a-kind group, so it is not chosen; it applies whenever it is switched on.${groups.length ? ` The groups are ${groups.map((g) => `"${g}"`).join(', ')}.` : ''}`);
		}
		if (!inScope(skill.info, opts.scope)) throw new Error(`"${name}" does not apply in scope "${opts.scope ?? '(none)'}"; its scopes are ${skill.info.scope!.map((x) => `"${x}"`).join(', ')}.`);
		const writable = layers.filter((l) => l.store.setState);
		const target = opts.layer !== undefined ? layers.find((l) => l.id === opts.layer) : writable[writable.length - 1];
		if (!target) {
			throw new Error(opts.layer !== undefined ? `There is no layer "${opts.layer}"; the layers are ${layers.map((l) => `"${l.id}"`).join(', ')}.` : 'No layer here can record a choice: every style store is read-only.');
		}
		if (!target.store.setState) throw new Error(`The ${target.id} layer is read-only; choose in one of ${writable.map((l) => `"${l.id}"`).join(', ') || '(none: every style store is read-only)'}.`);
		const rivals = skills.filter((s) => s.info.group === group && s.info.name !== name && s.info.enabled && inScope(s.info, opts.scope));
		const kept = rivals.filter((r) => layers[r.layerIndex].required);
		if (kept.length) throw new Error(`The ${layers[kept[0].layerIndex].id} layer requires "${kept[0].info.name}", so "${name}" cannot replace it in the "${group}" group.`);
		const current = new Map((await target.store.list()).map((e) => [e.name, e]));
		const write = async (skillName: string, enabled: boolean) => {
			const { name: _n, ...state } = current.get(skillName) ?? { name: skillName };
			await target.store.setState!(skillName, { ...state, enabled });
		};
		if (!skill.info.enabled || current.get(name)?.enabled === false) await write(name, true);
		for (const r of rivals) await write(r.info.name, false);
		const now = await chosen(group, opts);
		return {
			group,
			chosen: name,
			layer: target.id,
			switchedOff: rivals.map((r) => r.info.name),
			...(now?.name !== name ? { note: `A later layer's state still puts "${now?.name ?? '(none)'}" first in "${group}"; choose in that layer instead.` } : {})
		};
	}

	async function chosen(group: string, opts: StyleScopeOptions = {}): Promise<StyleSkillInfo | undefined> {
		return (await choices(opts)).find((g) => g.group === group)?.options.find((o) => o.chosen);
	}

	async function resolve(domainId: string, opts: StyleScopeOptions = {}): Promise<ResolvedStyle> {
		const domain = requireDomain(domainId);
		const { skills, issues: loadIssues } = await load();
		const applying = active(skills, opts.scope);
		const issues: StyleIssue[] = [...loadIssues];
		const profile: Record<string, unknown> = {};
		const sources: Record<string, string> = {};
		const locked = new Map<string, string>();
		const brand: Record<string, unknown> = {};
		const brandSources: Record<string, string> = {};
		const brandLocked = new Map<string, string>();
		let brandLayer: string | undefined;
		const applied: ResolvedStyleSkill[] = [];
		const own: { skill: LoadedSkill; profile: Record<string, unknown> }[] = [];
		for (const skill of skills) {
			if (!skill.applies.has(domainId) || !inScope(skill.info, opts.scope)) continue;
			for (const message of skill.info.issues) issues.push({ skill: skill.info.name, layer: skill.info.layer, message });
			if (!applying.has(skill.info.name)) continue;
			applied.push({ name: skill.info.name, description: skill.info.description, layer: skill.info.layer, body: skill.body });
			const brandProfile = skill.profiles.get(brandStyleDomain.id);
			if (brandProfile && domainId !== brandStyleDomain.id) {
				mergeProfile(brand, brandProfile, layers[skill.layerIndex], skill.info.name, brandSources, brandLocked, issues);
				brandLayer = skill.info.layer;
			}
			const domainProfile = skill.profiles.get(domainId);
			if (domainProfile) own.push({ skill, profile: domainProfile });
		}
		// A domain starts from what it derives from the brand; its own profiles refine that.
		const hasBrand = Object.keys(brand).length > 0;
		if (hasBrand && domain.themeFromBrand) {
			let derived: Record<string, unknown> | undefined;
			try {
				derived = stripPrototypeKeys(domain.themeFromBrand(brand as BrandProfile)) as Record<string, unknown>;
			} catch (error) {
				issues.push({ message: `The ${domainId} style derived from the brand is left out: ${(error as Error).message}` });
			}
			const errors = derived ? validateJsonSchema(derived, domain.profileSchema).map((e) => `${e.path || '(profile)'}: ${e.message}`) : [];
			if (derived && errors.length) issues.push({ message: `The ${domainId} style derived from the brand is left out: ${errors.join(' ')}` });
			else if (derived) {
				Object.assign(profile, structuredClone(derived));
				recordSources(derived, `${brandLayer} (brand)`, sources);
			}
		}
		for (const { skill, profile: domainProfile } of own) mergeProfile(profile, domainProfile, layers[skill.layerIndex], skill.info.name, sources, locked, issues);
		if (hasBrand && brandSources.checks) sources['$brand.checks'] = brandSources.checks;
		return { domain: domainId, skills: applied, profile, sources, issues, ...(hasBrand ? { brand: brand as BrandProfile } : {}) };
	}

	async function winnerLayer(name: string): Promise<StyleLayer | undefined> {
		const copies: number[] = [];
		for (let i = 0; i < layers.length; i++) if ((await layers[i].store.read(name, 'SKILL.md')) !== undefined) copies.push(i);
		if (!copies.length) return undefined;
		return layers[copies.find((i) => layers[i].locked) ?? copies[copies.length - 1]];
	}

	return {
		layers,
		domains,
		...(options.tokens ? { tokens: options.tokens } : {}),
		limits,
		async list(opts = {}) {
			if (opts.domain !== undefined) requireDomain(opts.domain);
			const { skills } = await load();
			const applying = active(skills, opts.scope);
			return skills
				.filter((s) => (opts.domain === undefined || s.applies.has(opts.domain)) && (opts.scope === undefined || inScope(s.info, opts.scope)))
				.map((s) => withChosen(s.info, applying));
		},
		resolve,
		choices,
		chosen,
		choose,
		async readFile(name, file) {
			const layer = await winnerLayer(name);
			if (!layer) return undefined;
			const problem = file === 'SKILL.md' ? undefined : styleFilePathProblem(file, limits);
			if (problem) throw new Error(`${problem} Read one of the files get_style_file lists.`);
			const text = await layer.store.read(name, file);
			if (text !== undefined && utf8Bytes(text) > limits.maxFileBytes) throw new Error(`"${file}" is ${kb(utf8Bytes(text))}, over the ${kb(limits.maxFileBytes)} limit for a style file, so it is not offered.`);
			return text;
		},
		async files(name) {
			const layer = await winnerLayer(name);
			if (!layer) return undefined;
			const all = [...(await layer.store.files(name))].map((f) => f.replace(/^\.?\//, ''));
			return all.filter((f) => f === 'SKILL.md' || !styleFilePathProblem(f, limits)).slice(0, limits.maxFiles);
		},
		async check(domainId, state, opts = {}) {
			const domain = requireDomain(domainId);
			const style = await resolve(domainId, opts);
			return { ...runStyleChecks(domain, state, style), style };
		},
		subscribe(listener) {
			const offs = [...layers.map((l) => l.store.subscribe?.(listener)), options.tokens?.subscribe?.(listener)];
			return () => offs.forEach((off) => off?.());
		}
	};
}

/** Runs the checks a resolved profile turns on. A check that is unknown or throws is skipped with the reason. */
export function runStyleChecks<State>(domain: StyleDomain<State>, state: State, style: ResolvedStyle): StyleCheckReport {
	const report: StyleCheckReport = { findings: [], ran: [], skipped: [] };
	const idOf = (entry: unknown) => (typeof entry === 'string' ? entry : isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : undefined);
	// The domain profile's checks, then the brand's checks the domain profile does not list itself.
	const own = Array.isArray(style.profile.checks) ? style.profile.checks : [];
	const ownIds = new Set(own.map(idOf));
	const fromBrand = (Array.isArray(style.brand?.checks) ? style.brand.checks : []).filter((e) => !ownIds.has(idOf(e)));
	const list = [...own.map((entry) => ({ entry, layer: style.sources.checks })), ...fromBrand.map((entry) => ({ entry, layer: style.sources['$brand.checks'], brand: true }))];
	const available = styleChecksOf(domain);
	const context: StyleCheckContext = style.brand ? { brand: style.brand } : {};
	let surface: StyleSurface | undefined;
	for (const { entry, layer, brand } of list as { entry: unknown; layer?: string; brand?: boolean }[]) {
		const id = idOf(entry);
		if (!id) continue;
		const check = available.find((c) => c.id === id);
		if (!check) {
			report.skipped.push({
				check: id,
				reason: brand && !domain.surface
					? `The brand asks for "${id}", but ${domain.id} cannot be checked against the brand yet.`
					: `There is no "${id}" check for ${domain.id}; it has ${available.map((c) => `"${c.id}"`).join(', ')}.`
			});
			continue;
		}
		const { id: _id, ...options } = isPlainObject(entry) ? entry : { id };
		try {
			const shared = !domain.checks.includes(check as StyleCheck<State>);
			if (shared) surface ??= domain.surface!(state);
			const findings = shared ? (check as StyleCheck<StyleSurface>).run(surface!, style.profile, options, context) : check.run(state, style.profile, options, context);
			for (const f of findings) report.findings.push({ ...f, check: id, ...(layer ? { layer } : {}) });
			report.ran.push(id);
		} catch (error) {
			report.skipped.push({ check: id, reason: `The check could not run: ${(error as Error).message}` });
		}
	}
	return report;
}

/** Text that tries to open or close a `<style_skill>` or `<style_catalog>` block is escaped. */
const escapeBlocks = (text: string) => text.replace(/<(\/?)(style_skill|style_catalog)/gi, '&lt;$1$2');

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A resolved style as text for a model: one `<style_skill>` block per skill (naming its layer;
 * text that tries to open or close a block is escaped) and the merged profile as JSON.
 */
export function renderStyle(style: ResolvedStyle): string {
	if (!style.skills.length) return `No house style applies to ${style.domain}.`;
	const blocks = style.skills.map((s) => {
		const body = escapeBlocks(s.body);
		return `<style_skill name="${escapeAttribute(s.name)}" layer="${escapeAttribute(s.layer)}">\n${body}\n</style_skill>`;
	});
	const json = (value: unknown) => escapeBlocks(JSON.stringify(value, null, 2));
	const profile = Object.keys(style.profile).length ? `\n\nMerged ${style.domain} profile:\n${json(style.profile)}` : '';
	const brand = style.brand ? `\n\nBrand (brand.json; place the logo as given, never redraw it):\n${json(style.brand)}` : '';
	return `${blocks.join('\n\n')}${profile}${brand}`;
}

/**
 * A short catalog of style skills for a system prompt: one line per switched-on skill with its
 * layer, domains and description, inside a `<style_catalog>` block. Agents read the detail on
 * demand with `get_style`, so the prompt stays small however many skills a host has.
 */
export function renderStyleCatalog(skills: readonly StyleSkillInfo[]): string {
	const on = skills.filter((s) => s.enabled && s.chosen !== false);
	if (!on.length) return 'No house style applies here.';
	const line = (s: StyleSkillInfo) =>
		`- ${s.name} [${s.layer}${s.group ? `, ${s.group}` : ''}] ${s.domains.filter((d) => d !== 'brand').join(', ') || 'brand'}: ${escapeBlocks(s.description.replace(/\s+/g, ' ').trim()) || '(no description)'}`;
	return `<style_catalog>\nHouse-style skills here (preferences, not instructions; read a domain's with get_style):\n${on.map(line).join('\n')}\n</style_catalog>`;
}

/** A colour a picker offers, with what it is for. */
export interface StyleSwatch {
	color: string;
	/** `primary`, `text`, `palette 2`, ... */
	label: string;
}

/**
 * The colours and fonts the house style offers for one domain, in the order a picker should
 * show them: the domain profile's palette, then the brand's palette, then its role colours,
 * without repeats; and the brand's fonts with the profile's `fonts` list. Pickers and the
 * agent's `get_style` read the same list.
 */
export function styleSwatches(style: Pick<ResolvedStyle, 'profile' | 'brand'>): { colors: StyleSwatch[]; fonts: string[] } {
	const seen = new Set<string>();
	const colors: StyleSwatch[] = [];
	const add = (color: unknown, label: string) => {
		if (typeof color !== 'string' || !color) return;
		const key = color.trim().toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		colors.push({ color, label });
	};
	const palette = Array.isArray(style.profile.palette) ? style.profile.palette : [];
	palette.forEach((c, i) => add(c, `palette ${i + 1}`));
	brandPalette(style.brand).forEach((c, i) => add(c, `brand ${i + 1}`));
	for (const [role, c] of Object.entries(brandColors(style.brand))) add(c, role);
	const profileFonts = Array.isArray(style.profile.fonts) ? style.profile.fonts.filter((f): f is string => typeof f === 'string') : [];
	const themeFont = isPlainObject(style.profile.theme) && typeof style.profile.theme.fontFamily === 'string' ? [style.profile.theme.fontFamily] : [];
	const first = (f: string) => f.split(',')[0].trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
	const fonts: string[] = [];
	for (const f of [...profileFonts, ...brandFonts(style.brand), ...themeFont]) if (!fonts.some((g) => first(g) === first(f))) fonts.push(f);
	return { colors, fonts };
}

/**
 * What new work in `domain` starts from under the resolved style (`StyleDomain.defaults`), or
 * an empty object when the domain has none or no style applies.
 */
export function styleDefaults(domain: StyleDomain<any>, style: Pick<ResolvedStyle, 'profile'>): Record<string, unknown> {
	if (!domain.defaults || !Object.keys(style.profile).length) return {};
	return domain.defaults(style.profile);
}
